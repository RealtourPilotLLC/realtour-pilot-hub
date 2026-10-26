// ---------------------------------------------------------------------------
// DRILL oct26-session-confirmation-notes (Oct 26 2026, Jordan: "Can we make
// sure clients get email confirmations and it tells them on screen a
// confirmation when they booked their monthly content shoot? Mike Ciunci
// booked one and said he didn't get any confirmation" and "Mike sent a
// revision so it should open up in the ops hub as revision status and the
// editor should see the notes").
//   §1 the confirmation email's words, subject and calendar link (pure)
//   §2 one email per seat per session time; a move earns its own; held while
//      a conflict is open; never for a session confirmed before it shipped
//   §3 a client's unsent notes: waited on for 15 minutes, then sent as their
//      change request; staff notes, replies and resolved notes never
//   §4 the wiring: outbox kind, both crons, the portal's booked panel and copy
// Disposable PGlite; Gmail is faked at the fence; nothing leaves the machine.
// @drill-run: conditions=react-server
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { plainTextOfMime } from "@/lib/emailHtml";

installNextStubs();

type Mail = { to: string; subject: string; body: string };
const mails: Mail[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const [head] = text.split("\r\n\r\n");
    const subj = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
    mails.push({ to: /^To: (.+)$/m.exec(head)?.[1] ?? "", subject: Buffer.from(subj, "base64").toString("utf8"), body: plainTextOfMime(text) });
    return json({ id: `gm-${mails.length}` });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, ts: "1.0001" });
  return null;
});

const REPO = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5974), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct26-session-confirmation" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const now = new Date();
    const at = (h: number) => new Date(now.getTime() + h * 3_600_000);

    c.head("§1 · the email (pure)");
    const k = await import("@/lib/sessionConfirmationKey");
    const sc = await import("@/lib/sessionConfirmation");
    const start = new Date("2026-11-12T15:00:00Z");
    const key = k.sessionConfirmationKey("req1", start, "cu1");
    c.ok("the key carries the session's start, colon-free", key === "session_confirmation:req1:20261112T1500Z:cu1", key);
    c.ok("the subject names the day in ET", k.sessionConfirmationSubject(key) === "Your filming session is booked for Thursday, November 12", k.sessionConfirmationSubject(key));
    c.ok("a move says so", k.sessionConfirmationSubject(k.sessionConfirmationKey("req1", start, "cu1", true)) === "Your filming session has moved to Thursday, November 12");
    const body = sc.composeSessionConfirmation({ name: "Mike Ciunci", start, end: new Date("2026-11-12T17:00:00Z"), tz: "America/New_York", location: "1033 Preserve Ln., West Chester, PA 19382", creativeName: "James Livingston", moved: false });
    c.ok("when, in the client's zone with the session's own abbreviation", body.includes("When: Thursday, November 12, 10:00 AM to 12:00 PM EST"), body);
    c.ok("where and who", body.includes("Where: 1033 Preserve Ln., West Chester, PA 19382") && body.includes("Videographer: James Livingston"));
    c.ok("a Google Calendar link for the exact two hours", /calendar\.google\.com\/calendar\/render\?action=TEMPLATE.*dates=20261112T150000Z%2F20261112T170000Z/.test(body));
    c.ok("the portal to change it and Kyle's line inside 24 hours", body.includes("/portal/login") && body.includes("Call or text Kyle at (215) 645-4889"));
    c.ok("no em or en dashes anywhere a client reads", !/[—–]/.test(body));
    const { buttonLabelFor } = await import("@/lib/emailHtml");
    c.ok("the calendar link is a button that says what it does", buttonLabelFor("https://calendar.google.com/calendar/render?action=TEMPLATE") === "Add to Google Calendar");

    c.head("§2 · one email per seat per session time");
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    const client = await prisma.client.create({ data: { name: "Dana Brooks", email: "dana.office@example.com" } });
    const e = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE" } });
    const owner = await prisma.clientUser.create({ data: { email: "dana@example.com", name: "Dana Brooks", status: "ACTIVE" } });
    await prisma.clientMembership.create({ data: { clientUserId: owner.id, enrollmentId: e.id, clientId: client.id, role: "OWNER", acceptedAt: now } });
    const helper = await prisma.clientUser.create({ data: { email: "assistant@example.com", name: "Sam Helper", status: "ACTIVE" } });
    await prisma.clientMembership.create({ data: { clientUserId: helper.id, enrollmentId: e.id, clientId: client.id, role: "COLLABORATOR", acceptedAt: now } });
    const viewerSeat = await prisma.clientUser.create({ data: { email: "viewer@example.com", name: "Vic Viewer", status: "ACTIVE" } });
    await prisma.clientMembership.create({ data: { clientUserId: viewerSeat.id, enrollmentId: e.id, clientId: client.id, role: "VIEWER", acceptedAt: now } });
    const req = (over: Record<string, unknown> = {}) => prisma.programSessionRequest.create({
      data: { enrollmentId: e.id, clientId: client.id, monthId: "month-nov", status: "CONFIRMED", slotStart: at(72), slotEnd: at(74), locationText: "12 Elm St, Media, PA 19063", creativeName: "James Livingston", confirmedAt: now, providerConfirmedAt: now, confirmedBy: "hub-booking", bookingState: "SUCCEEDED", ...over },
    });
    const r1 = await req();
    const first = await sc.sendSessionConfirmation(r1.id, { now });
    c.ok("the owner and the collaborator each get it; a viewer seat does not", first.emailedTo.sort().join(",") === "assistant@example.com,dana@example.com" && mails.length === 2, JSON.stringify(first));
    c.ok("…under the booked subject, greeting each by name", mails.every((m) => /^Your filming session is booked for /.test(m.subject)) && mails.some((m) => /Hi Sam,/.test(m.body)) && mails.some((m) => /Hi Dana,/.test(m.body)), mails.map((m) => m.subject).join(" | "));
    const again = await sc.sendSessionConfirmation(r1.id, { now });
    const swept = await sc.sweepSessionConfirmations({ now });
    c.ok("sent once: a second call and the cron's sweep send nothing more, and say it went", mails.length === 2 && again.emailedTo.length === 2 && swept.sent === 2, `${mails.length} ${JSON.stringify(swept)}`);
    await prisma.programSessionRequest.update({ where: { id: r1.id }, data: { slotStart: at(96), slotEnd: at(98), providerConfirmedAt: new Date(now.getTime() + 60 * 60_000) } });
    await sc.sweepSessionConfirmations({ now: new Date(now.getTime() + 61 * 60_000) });
    c.ok("moved by the hub: the new time earns its own email, which says it moved", mails.length === 4 && mails.slice(2).every((m) => /^Your filming session has moved to /.test(m.subject) && /has moved\. Here is the new time/.test(m.body)), mails.slice(2).map((m) => m.subject).join(" | "));
    const stale = await prisma.outboxMessage.findFirst({ where: { dedupeKey: { startsWith: `session_confirmation:${r1.id}:` }, NOT: { dedupeKey: { endsWith: ":moved" } } }, select: { dedupeKey: true } });
    c.ok("a queued email for the old time is no longer true for the drain", !(await sc.sessionConfirmationStillTrue({ dedupeKey: stale?.dedupeKey ?? null })).ok);

    const r2 = await req({ slotStart: at(120), slotEnd: at(122) });
    await prisma.smartTask.create({ data: { title: "Double-booked? James Livingston — Dana Brooks", status: "OPEN", taskType: "content_session", source: "content_program", dedupeKey: `content-session-doublebooked-${r2.id}`, clientId: client.id } as never });
    const heldRun = await sc.sendSessionConfirmation(r2.id, { now });
    c.ok("held while a double-booking is open: no email says the time is set", !!heldRun.skipped && /Double-booked/.test(heldRun.skipped) && mails.length === 4, heldRun.skipped ?? "");
    await prisma.smartTask.updateMany({ where: { dedupeKey: `content-session-doublebooked-${r2.id}` }, data: { status: "COMPLETED" } });
    await sc.sweepSessionConfirmations({ now });
    c.ok("…and sent on the next tick once Kyle closes it", mails.length === 6, String(mails.length));

    const r3 = await req({ slotStart: at(140), slotEnd: at(142), confirmedAt: new Date("2026-10-24T12:20:00Z"), providerConfirmedAt: new Date("2026-10-24T12:20:00Z") });
    const old = await sc.sendSessionConfirmation(r3.id, { now });
    c.ok("a session confirmed before the email existed is never mailed by the hub on its own", !!old.skipped && mails.length === 6, old.skipped ?? "");
    const r4 = await req({ slotStart: at(150), slotEnd: at(152), pendingChangeJson: "{}" });
    c.ok("a move still in flight waits", /move is still being made/.test((await sc.sendSessionConfirmation(r4.id, { now })).skipped ?? ""));
    const r5 = await req({ status: "REQUESTED", slotStart: at(160), slotEnd: at(162), confirmedAt: null });
    c.ok("a request Kyle has not confirmed gets nothing yet", /requested, not confirmed/.test((await sc.sendSessionConfirmation(r5.id, { now })).skipped ?? ""));
    const testClient = await prisma.client.create({ data: { name: "TEST Booking Client", email: "someone@realestate.com" } });
    const te = await prisma.contentEnrollment.create({ data: { clientId: testClient.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE" } });
    const tr = await prisma.programSessionRequest.create({ data: { enrollmentId: te.id, clientId: testClient.id, monthId: "m", status: "CONFIRMED", slotStart: at(80), slotEnd: at(82), confirmedAt: now } });
    const tRun = await sc.sendSessionConfirmation(tr.id, { now });
    c.ok("a TEST client at a real address is skipped, loudly", tRun.emailedTo.length === 0 && tRun.notes.some((n) => /TEST client/.test(n)) && mails.length === 6, JSON.stringify(tRun));

    c.head("§3 · a client's unsent notes go to the editor");
    const un = await import("@/lib/unsentNotes");
    const note = (over: Record<string, unknown>) => prisma.portalComment.create({ data: { submissionId: "sub-1", projectId: "proj-1", enrollmentId: e.id, body: "Start the music where my sample does.", timeSec: 19.7, clientUserId: owner.id, ...over } as never });
    await note({ createdAt: new Date(now.getTime() - 20 * 60_000) });
    await note({ createdAt: new Date(now.getTime() - 5 * 60_000), body: "And a softer cut at the end." });
    const writing = await un.sweepUnsentClientNotes({ now, dryRun: true });
    c.ok("still writing: nothing is sent until 15 minutes after the LAST note on that video", writing.waiting === 1 && writing.sent === 0, JSON.stringify(writing));
    const later = await un.sweepUnsentClientNotes({ now: new Date(now.getTime() + 11 * 60_000), dryRun: true });
    c.ok("…then both go together, as the client's own request", later.sent === 1 && later.notes.some((n) => /would send 2 notes/.test(n)), JSON.stringify(later));
    await prisma.portalComment.create({ data: { submissionId: "sub-2", projectId: "proj-1", enrollmentId: e.id, body: "Staff note in the owner view", staffUserId: "staff-1", createdAt: new Date(now.getTime() - 60 * 60_000) } as never });
    await prisma.portalComment.create({ data: { submissionId: "sub-3", projectId: "proj-1", enrollmentId: e.id, body: "Resolved already", clientUserId: owner.id, status: "RESOLVED", createdAt: new Date(now.getTime() - 60 * 60_000) } as never });
    await prisma.portalComment.create({ data: { submissionId: "sub-4", projectId: "proj-1", enrollmentId: e.id, body: "A reply", clientUserId: owner.id, parentId: "p1", createdAt: new Date(now.getTime() - 60 * 60_000) } as never });
    await prisma.portalComment.create({ data: { submissionId: "sub-5", projectId: "proj-1", enrollmentId: e.id, body: "Bundled with an approval", clientUserId: owner.id, decisionId: "d1", createdAt: new Date(now.getTime() - 60 * 60_000) } as never });
    const mixed = await un.sweepUnsentClientNotes({ now: new Date(now.getTime() + 11 * 60_000), dryRun: true });
    c.ok("a staff note, a resolved note, a reply and a note already sent are never sent for anyone", mixed.considered === 1, JSON.stringify(mixed));
    await prisma.portalComment.create({ data: { submissionId: "sub-6", projectId: "proj-1", enrollmentId: e.id, body: "From a viewer seat", clientUserId: viewerSeat.id, createdAt: new Date(now.getTime() - 60 * 60_000) } as never });
    const viewerRun = await un.sweepUnsentClientNotes({ now: new Date(now.getTime() + 11 * 60_000), dryRun: true });
    c.ok("a seat that can't request changes goes to Kyle, never sent as someone else", viewerRun.notes.some((n) => /can't send change requests/.test(n)), JSON.stringify(viewerRun.notes));
    await prisma.portalComment.create({ data: { submissionId: "sub-7", projectId: "proj-1", enrollmentId: e.id, body: "Before the rule", clientUserId: owner.id, createdAt: new Date("2026-10-20T12:00:00Z") } as never });
    c.ok("notes from before Oct 23 are left alone", (await un.sweepUnsentClientNotes({ now: new Date(now.getTime() + 11 * 60_000), dryRun: true })).considered === 2);

    c.head("§4 · the wiring");
    const outbox = read("src/lib/outbox.ts");
    c.ok("the outbox knows the kind, sends it at any hour, and names its subject", /"session_confirmation"\];/.test(outbox) && /case "session_confirmation": return sessionConfirmationSubject\(dedupeKey\)/.test(outbox) && !/const CLIENT_KINDS: readonly OutboxKind\[\] = \[[^\]]*session_confirmation/.test(outbox));
    c.ok("the aryeo cron sweeps confirmations after the bookings step", /step\("sessionBookings"[\s\S]+step\("sessionConfirmations"[\s\S]+sweepSessionConfirmations\(\)/.test(read("src/app/api/cron/aryeo/route.ts")));
    const gmail = read("src/app/api/cron/gmail/route.ts");
    c.ok("the gmail cron sends unsent notes and re-checks a recovered confirmation", /step\("unsentPortalNotes"[\s\S]+sweepUnsentClientNotes\(\)/.test(gmail) && /kind === "session_confirmation"[\s\S]{0,300}sessionConfirmationStillTrue/.test(gmail));
    const actions = read("src/app/portal/actions.ts");
    c.ok("booking and moving on the portal send the email and return the booked details", (actions.match(/confirmBooked\(/g) ?? []).length >= 3 && /withEmailNote\(r\.message\)/.test(actions));
    const sched = read("src/components/portal/PortalScheduler.tsx");
    c.ok("the portal shows the booked panel: when, where, who, where the email went, Add to Google Calendar", /function BookedPanel/.test(sched) && /You're booked/.test(sched) && /We emailed your confirmation to/.test(sched) && /Add to Google Calendar/.test(sched) && /<BookedPanel b=\{done\.booked\}/.test(sched));
    c.ok("the review page tells the client their notes go on their own", /on their own \$\{UNSENT_NOTE_QUIET_MINUTES\} minutes after your last note/.test(read("src/components/portal/CutReview.tsx")));
    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
