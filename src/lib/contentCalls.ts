import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
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
        canceled++;
      }
      continue;
    }

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
  const matchClient = (titlePrefix: string): { clientId: string; enrollmentId: string } | null => {
    const t = norm(titlePrefix);
    for (const c of clients) {
      if (t === norm(c.name) || t.startsWith(norm(c.name))) return { clientId: c.id, enrollmentId: enrollmentOf.get(c.id)! };
    }
    const first = t.split(" ")[0];
    if (first.length > 2 && firstCounts.get(first) === 1) {
      const c = clients.find((x) => norm(x.name).split(" ")[0] === first);
      if (c) return { clientId: c.id, enrollmentId: enrollmentOf.get(c.id)! };
    }
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
      ingested++;
    } catch { /* one bad doc must not stop the rest */ }
  }
  return { ingested };
}

// ---------------------------------------------------------------------------
// First-of-month booking invites. For every ACTIVE enrollment whose current
// month requires a call that isn't scheduled yet, draft ONE task carrying the
// booking link + a ready-to-send message. Draft-then-send: nothing texts the
// client automatically — the task is the reviewed draft.
// ---------------------------------------------------------------------------
export async function mintStrategyCallInvites(): Promise<{ minted: number }> {
  const key = etMonthKey();
  const months = await prisma.contentMonth.findMany({
    where: { monthKey: key, strategyCallStatus: "NOT_SCHEDULED", historical: false },
    select: { id: true, clientId: true, enrollmentId: true },
  });
  if (months.length === 0) return { minted: 0 };
  const active = new Set(
    (await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map((e) => e.id),
  );
  const clients = await prisma.client.findMany({
    where: { id: { in: months.map((m) => m.clientId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const monthName = new Date().toLocaleDateString("en-US", { month: "long", timeZone: "America/New_York" });

  let minted = 0;
  for (const m of months) {
    if (!active.has(m.enrollmentId)) continue;
    const dedupeKey = `content-call-invite-${m.id}`;
    const exists = await prisma.smartTask.findFirst({ where: { dedupeKey }, select: { id: true } });
    if (exists) continue;
    const name = nameOf.get(m.clientId) ?? "the client";
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
      },
    });
    minted++;
  }
  return { minted };
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
      ingested++;
    } catch { /* one bad recap must not stop the rest */ }
  }
  return { ingested };
}
