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

async function driveSearchTranscripts(token: string, sinceIso: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(
    `name contains 'Transcript' and mimeType = 'application/vnd.google-apps.document' and createdTime > '${sinceIso}' and trashed = false`,
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime,mimeType)&pageSize=50&orderBy=createdTime desc`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}

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

  let files: DriveFile[] = [];
  try {
    files = await driveSearchTranscripts(token, new Date(Date.now() - 21 * 864e5).toISOString());
  } catch (e) {
    // Most likely the Drive scope hasn't been granted yet (needs Jordan's
    // one-time reconnect) — the paste fallback stays the path until then.
    return { skipped: e instanceof Error ? e.message : "Drive unreachable" };
  }
  if (files.length === 0) return { ingested: 0 };

  // Months that still WANT a transcript: call completed or scheduled-in-past,
  // no transcript yet. Match by (a) call time ≈ doc createdTime same ET day
  // when the month has a Calendly booking, then (b) client name in the title.
  const months = await prisma.contentMonth.findMany({
    where: { transcriptText: null, strategyCallStatus: { in: ["SCHEDULED", "COMPLETED"] } },
    select: { id: true, clientId: true, strategyCallAt: true },
  });
  if (months.length === 0) return { ingested: 0 };
  const clients = await prisma.client.findMany({
    where: { id: { in: months.map((m) => m.clientId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  let ingested = 0;
  const used = new Set<string>();
  for (const m of months) {
    const clientName = (nameOf.get(m.clientId) ?? "").toLowerCase();
    const first = clientName.split(/\s+/)[0] ?? "";
    const last = clientName.split(/\s+/).slice(-1)[0] ?? "";
    const f = files.find((file) => {
      if (used.has(file.id)) return false;
      const title = file.name.toLowerCase();
      const sameDay = m.strategyCallAt && file.createdTime
        ? dayKey(new Date(file.createdTime)) === dayKey(m.strategyCallAt)
        : false;
      const nameHit = clientName.length > 3 && (title.includes(clientName) || (first.length > 2 && last.length > 2 && title.includes(first) && title.includes(last)));
      // Same ET day as the booked call is a strong signal on its own only when
      // the title ALSO looks like a strategy call; a bare name match works any day.
      return nameHit || (sameDay && /strategy|content program/i.test(title));
    });
    if (!f) continue;
    try {
      const text = (await driveExportText(token, f.id)).trim();
      if (text.length < 200) continue; // an empty/stub doc is not a call
      used.add(f.id);
      await prisma.contentMonth.update({
        where: { id: m.id },
        data: {
          transcriptText: text.slice(0, 500_000),
          transcriptSource: `drive:${f.id}`,
          strategyCallStatus: "COMPLETED",
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
