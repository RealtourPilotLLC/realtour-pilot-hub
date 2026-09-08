import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { etAt, etDayKey } from "@/lib/datetime";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";

// ---------------------------------------------------------------------------
// Strategy calls: Calendly bookings → ContentMonth, and Google Drive Meet
// transcripts → ContentMonth.transcriptText. Both are best-effort sweeps —
// a missing key or scope degrades to the manual paths (status buttons +
// transcript paste), never breaks the page or cron.
// ---------------------------------------------------------------------------

export { STRATEGY_CALL_BOOKING_URL };

// Match a Calendly invitee to an enrolled client by email (email or backupEmail).
async function enrolledClientByEmail(): Promise<Map<string, { clientId: string; enrollmentId: string }>> {
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, clientId: true },
  });
  const clients = await prisma.client.findMany({
    where: { id: { in: enrollments.map((e) => e.clientId) } },
    select: { id: true, email: true, backupEmail: true },
  });
  const eOf = new Map(enrollments.map((e) => [e.clientId, e.id]));
  const map = new Map<string, { clientId: string; enrollmentId: string }>();
  for (const c of clients) {
    for (const em of [c.email, c.backupEmail]) {
      if (em) map.set(em.toLowerCase(), { clientId: c.id, enrollmentId: eOf.get(c.id)! });
    }
  }
  return map;
}

// Pull strategy-call bookings from Calendly and stamp the matching months.
// A canceled booking reverts a SCHEDULED month (only if WE scheduled it —
// hand-set statuses are not reverted).
export async function syncStrategyCallsFromCalendly(): Promise<{ stamped: number; completed: number; canceled: number } | { skipped: string }> {
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("calendly"))) return { skipped: "Calendly not connected" };
  const { listStrategyCalls } = await import("@/lib/integrations/calendly");

  // Window: 30 days back (completions) → 60 days forward (next month's bookings).
  const now = new Date();
  const calls = await listStrategyCalls(
    new Date(now.getTime() - 30 * 864e5).toISOString(),
    new Date(now.getTime() + 60 * 864e5).toISOString(),
  );
  const byEmail = await enrolledClientByEmail();
  let stamped = 0, completed = 0, canceled = 0;

  for (const { event, invitees } of calls) {
    const match = invitees
      .map((i) => (i.email ? byEmail.get(i.email.toLowerCase()) : undefined))
      .find(Boolean);
    if (!match || !event.start_time) continue;
    const start = new Date(event.start_time);
    const monthKey = etMonthKey(start);

    // The call belongs to the month it plans — find-or-skip (the sweep creates
    // current months; a booking for a month with no workspace yet just waits).
    const month = await prisma.contentMonth.findUnique({
      where: { enrollmentId_monthKey: { enrollmentId: match.enrollmentId, monthKey } },
      select: { id: true, strategyCallStatus: true, calendlyEventUri: true, transcriptText: true },
    });
    if (!month) continue;

    if (event.status === "canceled") {
      // Only revert a booking WE stamped (same event uri) — a hand-set status
      // or a different booking stays untouched.
      if (month.calendlyEventUri === event.uri && month.strategyCallStatus === "SCHEDULED") {
        await prisma.contentMonth.update({
          where: { id: month.id },
          data: { strategyCallStatus: "NOT_SCHEDULED", strategyCallAt: null, calendlyEventUri: null },
        });
        // The booking that retired the invite is gone — put the ask back.
        await reopenStrategyCallInvite(month.id, now);
        canceled++;
      }
      continue;
    }

    // A live booking is on file — stamped now or on an earlier pass — so the
    // month's "send them the link" draft is done, whichever way the stamp
    // below resolves. (Arielle's and Mike Flatley's invites sat OPEN a week
    // after their calls happened, Sep 8 audit.)
    await closeStrategyCallInvite(month.id);

    const past = event.end_time ? new Date(event.end_time) < now : start < now;
    const target = past ? "COMPLETED" : "SCHEDULED";
    // Never downgrade: COMPLETED (or a transcript on file) outranks SCHEDULED.
    if (month.strategyCallStatus === "COMPLETED" && target === "SCHEDULED") continue;
    if (month.strategyCallStatus === target && month.calendlyEventUri === event.uri) continue;
    await prisma.contentMonth.update({
      where: { id: month.id },
      data: { strategyCallStatus: target, strategyCallAt: start, calendlyEventUri: event.uri },
    });
    if (target === "COMPLETED") completed++; else stamped++;
  }
  return { stamped, completed, canceled };
}

// ---------------------------------------------------------------------------
// Google Drive transcript sweep. Meet auto-transcripts land in Drive as Google
// Docs named like "<Meeting title> - Transcript". We look for recent transcript
// docs, match them to a client (invitee-matched Calendly call time, then the
// client's name in the doc title), and store the text on the month.
// ---------------------------------------------------------------------------
type DriveFile = { id: string; name: string; createdTime?: string; mimeType?: string };


async function driveExportText(token: string, fileId: string): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Drive export failed (${res.status})`);
  return res.text();
}

export async function sweepDriveTranscripts(): Promise<{ ingested: number } | { skipped: string }> {
  const { ownerGoogleToken } = await import("@/lib/integrations/google");
  const token = await ownerGoogleToken();
  if (!token) return { skipped: "Google not connected" };

  // Jordan's real artifacts (verified Aug 24): Gemini meeting-notes docs named
  // "<Client> and Jordan Spackman - 2026/08/07 12:46 EDT - Notes by Gemini",
  // containing the summary AND the full speaker-attributed transcript inline.
  // No separate "- Transcript" docs exist, so the notes doc IS the source.
  let files: DriveFile[] = [];
  try {
    const q = encodeURIComponent(
      `name contains 'and Jordan Spackman' and mimeType = 'application/vnd.google-apps.document' and createdTime > '${new Date(Date.now() - 45 * 864e5).toISOString()}' and trashed = false`,
    );
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&pageSize=100&orderBy=createdTime desc`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
    if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
    files = ((await res.json()) as { files?: DriveFile[] }).files ?? [];
  } catch (e) {
    return { skipped: e instanceof Error ? e.message : "Drive unreachable" };
  }
  if (files.length === 0) return { ingested: 0 };

  // Docs already ingested anywhere must never double-ingest.
  const usedSources = new Set(
    (await prisma.contentMonth.findMany({
      where: { transcriptSource: { startsWith: "drive:" } },
      select: { transcriptSource: true },
    })).map((m) => m.transcriptSource!.slice(6)),
  );

  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, clientId: true },
  });
  const clients = await prisma.client.findMany({
    where: { id: { in: enrollments.map((e) => e.clientId) } },
    select: { id: true, name: true },
  });
  const enrollmentOf = new Map(enrollments.map((e) => [e.clientId, e.id]));
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();

  // Title prefix before " and Jordan Spackman" is the client identity. It may
  // be a FIRST NAME only ("Bernadette  and Jordan Spackman"), so match full
  // name first, then a first name that is unique across enrolled clients.
  const firstCounts = new Map<string, number>();
  for (const c of clients) {
    const f = norm(c.name).split(" ")[0];
    firstCounts.set(f, (firstCounts.get(f) ?? 0) + 1);
  }
  const unmatched: string[] = [];
  const matchClient = (titlePrefix: string): { clientId: string; enrollmentId: string } | null => {
    const t = norm(titlePrefix);
    for (const c of clients) {
      if (t === norm(c.name) || t.startsWith(norm(c.name))) return { clientId: c.id, enrollmentId: enrollmentOf.get(c.id)! };
    }
    // FIRST-NAME FALLBACK — only when the title carries nothing else to go on.
    // Gemini titles a call with whatever the invite said, so "Bernadette and
    // Jordan Spackman" is a real, matchable case. But the fallback used to run
    // on ANY prefix whose first word was unique among the enrolled: a call with
    // "Mike Flatley" — who is not in the program at all — matched Mike Ciunci,
    // and would have filed a stranger's transcript onto his month, flipped it
    // COMPLETED, and generated his topics, scripts and portal from it.
    // A prefix with a surname in it is a FULL name: if it did not match above,
    // this is not our client. Only a bare first name may fall through.
    const words = t.split(" ").filter(Boolean);
    if (words.length === 1) {
      const first = words[0];
      if (first.length > 2 && firstCounts.get(first) === 1) {
        const c = clients.find((x) => norm(x.name).split(" ")[0] === first);
        if (c) return { clientId: c.id, enrollmentId: enrollmentOf.get(c.id)! };
      }
    }
    unmatched.push(titlePrefix.trim());
    return null;
  };

  // Parse "<prefix> and Jordan Spackman - 2026/08/07 12:46 EDT - Notes by Gemini".
  const parseTitle = (name: string): { prefix: string; at: Date | null } | null => {
    const m = name.match(/^(.*?)\s+and\s+jordan\s+spackman/i);
    if (!m) return null;
    const d = name.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
    let at: Date | null = null;
    if (d) {
      // Title times are ET — build the UTC instant via the ET offset trick used
      // in datetime.ts (approximate with the date's offset; minute precision).
      const [y, mo, day, h, min] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(d[4]), Number(d[5])];
      const guess = new Date(Date.UTC(y, mo - 1, day, h, min));
      const etHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(guess));
      at = new Date(guess.getTime() + (h - etHour) * 3600_000);
    }
    return { prefix: m[1], at };
  };
  const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // Group candidate docs by enrollment+month, newest first.
  type Candidate = { file: DriveFile; at: Date | null };
  const byMonth = new Map<string, { enrollmentId: string; clientId: string; monthKey: string; docs: Candidate[] }>();
  for (const f of files) {
    if (usedSources.has(f.id)) continue;
    const parsed = parseTitle(f.name);
    if (!parsed) continue;
    const who = matchClient(parsed.prefix);
    if (!who) continue;
    const at = parsed.at ?? (f.createdTime ? new Date(f.createdTime) : null);
    if (!at) continue;
    const monthKey = etMonthKey(at);
    const k = `${who.enrollmentId}|${monthKey}`;
    let g = byMonth.get(k);
    if (!g) { g = { ...who, monthKey, docs: [] }; byMonth.set(k, g); }
    g.docs.push({ file: f, at: parsed.at });
  }

  let ingested = 0;
  for (const g of byMonth.values()) {
    const month = await prisma.contentMonth.findUnique({
      where: { enrollmentId_monthKey: { enrollmentId: g.enrollmentId, monthKey: g.monthKey } },
      select: { id: true, transcriptText: true, strategyCallAt: true },
    });
    if (!month || month.transcriptText) continue;
    // Several meetings can share a month (Erica: Aug 6 AND Aug 7) — prefer the
    // doc on the BOOKED call's ET day, else the newest in the month.
    const pick =
      (month.strategyCallAt && g.docs.find((d) => d.at && dayKey(d.at) === dayKey(month.strategyCallAt!))) ||
      g.docs.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))[0];
    if (!pick) continue;
    try {
      const text = (await driveExportText(token, pick.file.id)).trim();
      if (text.length < 200) continue;
      await prisma.contentMonth.update({
        where: { id: month.id },
        data: {
          transcriptText: text.slice(0, 500_000),
          transcriptSource: `drive:${pick.file.id}`,
          strategyCallStatus: "COMPLETED",
          ...(month.strategyCallAt ? {} : pick.at ? { strategyCallAt: pick.at } : {}),
        },
      });
      await closeStrategyCallInvite(month.id); // the call happened — no link to send
      ingested++;
    } catch { /* one bad doc must not stop the rest */ }
  }
  // Say what we could not place. A meeting-notes doc that matches nobody used to
  // vanish silently, which is how a wrong match was preferable to no match.
  if (unmatched.length > 0) {
    console.warn(`[content] Drive transcripts not matched to an enrolled client: ${[...new Set(unmatched)].join(" · ")}`);
  }
  return { ingested };
}

// ---------------------------------------------------------------------------
// Booking invites. For every ACTIVE enrollment whose current month requires a
// call that isn't scheduled yet, draft ONE task carrying the booking link + a
// ready-to-send message. Draft-then-send: nothing texts the client
// automatically — the task is the reviewed draft.
//
// The Sep 8 task audit found the nine September drafts with no due date, no
// assignee and no close path — "the one task meant to get 11 content clients
// on a September call sits invisible with no clock" — two of them for clients
// whose call had already happened, one for a TEST client. So an invite now
// carries a clock and a name, and the hourly pass retires it the moment the
// month leaves NOT_SCHEDULED, whoever moved it.
// ---------------------------------------------------------------------------
const INVITE_KEY_PREFIX = "content-call-invite-";
const DONE = ["COMPLETED", "CANCELLED"];

// Who sends the link. The strategy call is Jordan's client relationship (he
// runs the call) and opsDay.ts already routes unowned content_program work to
// the owner lane, so the row is addressed to him until he says it's Kyle's.
export const STRATEGY_CALL_INVITE_ASSIGNEE = "jordan";

// Test records reach the program through the real Aryeo webhook path ("Bobby
// TEST Michael TEST" enrolled itself on Sep 3) and must not generate owner
// work. Word-bounded so a real surname like Testa is not swept up.
export const isTestClientName = (name: string | null | undefined): boolean =>
  /\btest\b|\bjohn doe\b/i.test(name ?? "");

// 5pm ET on the Nth weekday counted from (and including) an ET calendar day.
// Weekends only — the program keeps no holiday calendar, and a link that goes
// out on Labor Day costs nothing.
const INVITE_BUSINESS_DAYS = 3;
function nthWeekdayEndFrom(startDayKey: string, n: number): Date {
  const [y, m, d] = startDayKey.split("-").map(Number);
  // Noon UTC: a calendar day with no timezone to get wrong.
  let day = new Date(Date.UTC(y, m - 1, d, 12));
  for (let seen = 0; ; day = new Date(day.getTime() + 86_400_000)) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6 && ++seen === n) break;
  }
  return etAt(day.toISOString().slice(0, 10), 17);
}

/**
 * When the link should be out: the 3rd business day of the month, 5pm ET
 * (the audit's rule). An enrollment that arrives mid-month gets the same three
 * business days counted from the day its invite was minted instead — a row
 * born overdue is a row nobody trusts.
 */
export function strategyCallInviteDueAt(monthKey: string, mintedAt: Date): Date {
  const byMonth = nthWeekdayEndFrom(`${monthKey}-01`, INVITE_BUSINESS_DAYS);
  const byMint = nthWeekdayEndFrom(etDayKey(mintedAt), INVITE_BUSINESS_DAYS);
  return byMint > byMonth ? byMint : byMonth;
}

// The month left NOT_SCHEDULED (booked, held, transcribed): the invite did its
// job, or somebody else did it. Every writer of strategyCallStatus in this
// file calls this at the stamp so the content page's "Sync now" retires the
// row too; the hourly reconcile catches the writers outside this file (the
// status buttons and transcript paste in content/actions.ts, the pipeline's
// COMPLETED stamp).
async function closeStrategyCallInvite(monthId: string): Promise<number> {
  const r = await prisma.smartTask.updateMany({
    where: { dedupeKey: `${INVITE_KEY_PREFIX}${monthId}`, status: { notIn: DONE } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return r.count;
}

// A booking we stamped was canceled and the month is NOT_SCHEDULED again: the
// client needs the link again, with a fresh clock. Only a COMPLETED row comes
// back — CANCELLED means the row was moot (test client, enrollment ended) and
// stays that way.
async function reopenStrategyCallInvite(monthId: string, now: Date): Promise<number> {
  const r = await prisma.smartTask.updateMany({
    where: { dedupeKey: `${INVITE_KEY_PREFIX}${monthId}`, status: "COMPLETED" },
    data: {
      status: "OPEN",
      completedAt: null,
      dueAt: nthWeekdayEndFrom(etDayKey(now), INVITE_BUSINESS_DAYS),
      summary: "Their Calendly booking was canceled — send the booking link again.",
    },
  });
  return r.count;
}

// Every open invite checked against its month, hourly. Closes the rows whose
// month moved on (whoever moved it), cancels the moot ones, and gives the rest
// — including the nine minted before any of this existed — their clock, their
// name, and HIGH priority from the 10th, when a link that still hasn't gone
// out is costing the month. A human's pick of assignee is never overwritten.
async function reconcileStrategyCallInvites(now: Date): Promise<{ closed: number; dated: number }> {
  const open = await prisma.smartTask.findMany({
    where: { dedupeKey: { startsWith: INVITE_KEY_PREFIX }, status: { notIn: DONE } },
    select: { id: true, dedupeKey: true, dueAt: true, assignedKey: true, assignedManually: true, priority: true, createdAt: true },
  });
  if (open.length === 0) return { closed: 0, dated: 0 };
  const monthIdOf = (t: { dedupeKey: string | null }) => t.dedupeKey!.slice(INVITE_KEY_PREFIX.length);
  const months = await prisma.contentMonth.findMany({
    where: { id: { in: open.map(monthIdOf) } },
    select: { id: true, monthKey: true, strategyCallStatus: true, enrollmentId: true, clientId: true },
  });
  const [enrollments, clients] = await Promise.all([
    prisma.contentEnrollment.findMany({ where: { id: { in: months.map((m) => m.enrollmentId) } }, select: { id: true, status: true } }),
    prisma.client.findMany({ where: { id: { in: months.map((m) => m.clientId) } }, select: { id: true, name: true } }),
  ]);
  const monthOf = new Map(months.map((m) => [m.id, m]));
  const enrollmentStatus = new Map(enrollments.map((e) => [e.id, e.status]));
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

  let closed = 0, dated = 0;
  for (const t of open) {
    const month = monthOf.get(monthIdOf(t));
    // Nobody should send this link: the month is gone, the client is a test
    // record, the enrollment ended, or the call was waived (SKIPPED /
    // NOT_REQUIRED). Moot is CANCELLED, not COMPLETED — the Done ledger must
    // not credit a link that was never sent (same rule as confirmation texts).
    const moot =
      !month ||
      isTestClientName(nameOf.get(month.clientId)) ||
      enrollmentStatus.get(month.enrollmentId) !== "ACTIVE" ||
      !["NOT_SCHEDULED", "SCHEDULED", "COMPLETED"].includes(month.strategyCallStatus);
    if (moot) {
      await prisma.smartTask.update({ where: { id: t.id }, data: { status: "CANCELLED" } });
      closed++;
      continue;
    }
    if (month.strategyCallStatus !== "NOT_SCHEDULED") {
      await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: now } });
      closed++;
      continue;
    }
    const data: { dueAt?: Date; assignedKey?: string; priority?: string } = {};
    if (!t.dueAt) data.dueAt = strategyCallInviteDueAt(month.monthKey, t.createdAt);
    if (!t.assignedKey && !t.assignedManually) data.assignedKey = STRATEGY_CALL_INVITE_ASSIGNEE;
    if ((t.priority === "MEDIUM" || t.priority === "LOW") && now >= etAt(`${month.monthKey}-10`, 0)) data.priority = "HIGH";
    if (Object.keys(data).length === 0) continue;
    await prisma.smartTask.update({ where: { id: t.id }, data });
    if (data.dueAt) dated++;
  }
  return { closed, dated };
}

// The hourly invite pass: reconcile what's open (above), then draft for every
// current month that still needs a call and has no draft yet.
export async function mintStrategyCallInvites(): Promise<{ minted: number; closed: number; dated: number }> {
  const now = new Date();
  const { closed, dated } = await reconcileStrategyCallInvites(now);
  const key = etMonthKey(now);
  const months = await prisma.contentMonth.findMany({
    where: { monthKey: key, strategyCallStatus: "NOT_SCHEDULED", historical: false },
    select: { id: true, clientId: true, enrollmentId: true },
  });
  if (months.length === 0) return { minted: 0, closed, dated };
  const active = new Set(
    (await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map((e) => e.id),
  );
  const clients = await prisma.client.findMany({
    where: { id: { in: months.map((m) => m.clientId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const monthName = now.toLocaleDateString("en-US", { month: "long", timeZone: "America/New_York" });

  let minted = 0;
  for (const m of months) {
    if (!active.has(m.enrollmentId)) continue;
    const name = nameOf.get(m.clientId) ?? "the client";
    if (isTestClientName(name)) continue;
    const dedupeKey = `${INVITE_KEY_PREFIX}${m.id}`;
    const exists = await prisma.smartTask.findFirst({ where: { dedupeKey }, select: { id: true } });
    if (exists) continue;
    const firstName = name.split(/\s+/)[0];
    await prisma.smartTask.create({
      data: {
        title: `Send ${name} their ${monthName} strategy-call booking link`,
        description:
          `Draft (review, then send from your phone or the client's thread):\n\n` +
          `"Hi ${firstName}! Time to plan your ${monthName} content — grab a time for your strategy call here: ${STRATEGY_CALL_BOOKING_URL} ` +
          `Once you book, everything else falls into place on our end."`,
        taskType: "comms_followup",
        status: "OPEN",
        source: "content_program",
        clientId: m.clientId,
        dedupeKey,
        dueAt: strategyCallInviteDueAt(key, now),
        assignedKey: STRATEGY_CALL_INVITE_ASSIGNEE,
      },
    });
    minted++;
  }
  return { minted, closed, dated };
}

// ---------------------------------------------------------------------------
// Notetaker transcript sweep — PRIMARY source (Jordan keeps Notetaker on every
// call). A month qualifies when it has a Calendly booking and no transcript;
// the recap is matched by the booked event's uuid. Drive remains the backup,
// paste the last resort — all three write the same transcriptText and feed the
// same analysis pipeline.
// ---------------------------------------------------------------------------
export async function sweepNotetakerTranscripts(): Promise<{ ingested: number } | { skipped: string }> {
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("calendly"))) return { skipped: "Calendly not connected" };

  const months = await prisma.contentMonth.findMany({
    where: { transcriptText: null, calendlyEventUri: { not: null } },
    select: { id: true, calendlyEventUri: true },
  });
  if (months.length === 0) return { ingested: 0 };

  const { listMeetingRecaps, recapEventUuid, recapTranscriptText } = await import("@/lib/integrations/calendly");
  const recaps = await listMeetingRecaps();
  if ("skipped" in recaps) return recaps;

  // event uuid → recap uri
  const byEvent = new Map<string, string>();
  for (const r of recaps) {
    const uuid = recapEventUuid(r);
    if (uuid && typeof r.uri === "string") byEvent.set(uuid, r.uri);
  }
  let ingested = 0;
  for (const m of months) {
    const eventUuid = m.calendlyEventUri!.split("/").pop();
    const recapUri = eventUuid ? byEvent.get(eventUuid) : undefined;
    if (!recapUri) continue;
    try {
      const text = await recapTranscriptText(recapUri);
      if (!text || text.length < 200) continue; // a stub recap is not a call
      await prisma.contentMonth.update({
        where: { id: m.id },
        data: {
          transcriptText: text.slice(0, 500_000),
          transcriptSource: `notetaker:${recapUri.split("/").pop()}`,
          strategyCallStatus: "COMPLETED",
        },
      });
      await closeStrategyCallInvite(m.id); // the call happened — no link to send
      ingested++;
    } catch { /* one bad recap must not stop the rest */ }
  }
  return { ingested };
}
