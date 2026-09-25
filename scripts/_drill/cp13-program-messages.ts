// ---------------------------------------------------------------------------
// DRILL: CP-13 — one program conversation, the guides, and a way to reach
// Kyle (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp13-program-messages.ts
//
// What it proves, the OLD behaviour first wherever it can be observed (HEAD's
// sources, read from git):
//   0. OLD — no Messages tab and a footer that says "Text us any time" with
//      nothing to text; an empty Resources page that says the same; no
//      MESSAGES duty, and a default-owner minter that returns as soon as ANY
//      default exists — so a new duty would never get its owner in production.
//   1. The MESSAGES default is minted for Kyle beside the six production rows,
//      without touching them, and a second read writes nothing.
//   2. A TEST client writes through the shared link (the real server action):
//      one CLIENT message assigned to Kyle, one unread thread for him, ONE bell
//      row addressed to him (plus Jordan's), and a second message rings nobody
//      again. A TEST client gets no desk task.
//   3. A real client: ONE SmartTask (program-message:<id>, program_message,
//      kyle, due a business day out), refreshed — not duplicated — by the next.
//   4. Kyle replies: the run is answered, the task closes, the client's thread
//      shows both in order with the reply linked; unread 1 → 0 on reading;
//      staff reading never moves the client's marker. "No reply needed" closes
//      a run with no message; the next client message reopens the task.
//   5. "Change the music at 0:12" is a MESSAGE: no RevisionBrief, no
//      PortalComment, no revision task; the confirmation says where video
//      changes go; staff see a chip, the client does not.
//   6. Permissions: a VIEWER seat is refused, a PAUSED program is refused with
//      Kyle's number, staff through the iframe are stored as STAFF.
//   7. Guards: 20 client messages a day; a reference to another account's
//      video is refused.
//   8. The reply email: nothing while `program_message_notice` is off; with it
//      on, exactly one (kind program_message, to the seat), none on a repeat,
//      none once the seat has read it, none on a Saturday, and a TEST client's
//      unverified address is refused loudly by the outbox floor.
//   9. The guides: all nine drafts validate against the app's own groups and
//      action keys, load through createResource UNPUBLISHED, stay invisible
//      until published, then render; resourcesForAction finds them;
//      "Coming soon" is code, not rows.
//  10. The contact: Kyle by default, an owner-set AppSetting honoured, a
//      malformed one ignored; the page and the tab carry it.
//  11. Staff surfaces: the Messages tab loader, the roster's waiting count, the
//      backup's model list.
//
// ISOLATION: PGlite on 127.0.0.1:5520 via the shared harness. Google's token
// endpoint and Gmail's send are FAKES inside the fence; nothing else leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5520);
const REPO = path.resolve(__dirname, "../..");
const BASE = "e26cacd"; // pinned: the commit batches B–D start from (HEAD moved on once they were committed)

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
    const [head, ...rest] = text.split("\r\n\r\n");
    const subj = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
    mails.push({ to: /^To: (.+)$/m.exec(head)?.[1] ?? "", subject: Buffer.from(subj, "base64").toString("utf8"), body: rest.join("\r\n\r\n") });
    return json({ id: `gm-${mails.length}` });
  }
  return null;
});

const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const pm = await import("@/lib/programMessages");
  const { ownersFor, OWNER_DUTIES } = await import("@/lib/contentProgram");
  const { portalPostMessage } = await import("@/app/portal/actions");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { etAt } = await import("@/lib/datetime");
  type PortalViewer = import("@/lib/portal").PortalViewer;

  // ---- the office ---------------------------------------------------------
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle@realtourpilot.com" } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
  const jordan = await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));

  const viewerOf = (f: { enrollmentId: string; clientId: string; clientName: string }, actor: PortalViewer["actor"], status = "ACTIVE"): PortalViewer =>
    ({ enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status, videosPerMonth: 4, sessionsPerMonth: 1 }, actor, access: status === "ACTIVE" ? "FULL" : "READ_ONLY", via: actor.kind === "STAFF" ? "STAFF" : actor.kind === "CLIENT" ? "LOGIN" : "TOKEN" }) as PortalViewer;

  // =========================================================================
  c.head("0 · OLD (HEAD): nowhere to write, nothing to text, no owner for it");
  // =========================================================================
  {
    const page = show("src/components/portal/PortalPage.tsx");
    c.ok("OLD: the portal had no Messages tab", !/"messages"/.test(page.match(/export type PortalTab = [^;]+;/)?.[0] ?? ""));
    c.ok("OLD: the footer said 'Text us any time' with no number or link", page.includes("Questions or topic ideas? Text us any time.") && !/tel:|sms:/.test(page));
    const res = show("src/components/portal/tabs/ResourcesTab.tsx");
    c.ok("OLD: an empty Resources page said 'Text us' and nothing was 'Coming soon'", /Text us with any question/.test(res) && !/Coming soon/.test(res));
    const cp = show("src/lib/contentProgram.ts");
    c.ok("OLD: no MESSAGES duty existed", !/"MESSAGES"/.test(cp.match(/export const OWNER_DUTIES[^;]+;/)?.[0] ?? ""));
    c.ok("OLD: no model held a program conversation before e26cacd", !/model ProgramMessage\b/.test(execFileSync("git", ["show", "e26cacd~1:prisma/schema.prisma"], { cwd: REPO, encoding: "utf8" })));
    c.ok("OLD: the default minter returned as soon as ANY default row existed", /const existing = await prisma\.programOwnerAssignment\.count\(\{ where: \{ scope: "DEFAULT" \} \}\);\s*if \(existing > 0\) return;/.test(cp));
  }

  // =========================================================================
  c.head("1 · the MESSAGES owner is minted beside production's six defaults");
  // =========================================================================
  {
    const six = [["STRATEGY", jordan], ["SCRIPTS", jordan], ["ESCALATION", jordan], ["SCHEDULING", kyle], ["DELIVERY", kyle], ["REMINDERS", kyle]] as const;
    for (const [duty, u] of six) await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty, appUserId: u.id, label: u.name, setBy: "defaults", createdAt: new Date("2026-09-17T12:00:00Z") } });
    const before = await prisma.programOwnerAssignment.findMany({ where: { scope: "DEFAULT" }, orderBy: { duty: "asc" } });
    const o = await ownersFor("no-such-enrollment");
    c.ok("ownersFor now answers MESSAGES: Kyle", o.MESSAGES.appUserId === kyle.id && o.MESSAGES.label === "Kyle Drill", o.MESSAGES.label);
    const after = await prisma.programOwnerAssignment.findMany({ where: { scope: "DEFAULT" }, orderBy: { duty: "asc" } });
    c.ok("exactly one row was added and the six were not touched", after.length === 7 && before.every((b) => after.some((a) => a.id === b.id && a.updatedAt.getTime() === b.updatedAt.getTime() && a.appUserId === b.appUserId)), `${after.length}`);
    await ownersFor("no-such-enrollment");
    c.ok("a second read writes nothing", (await prisma.programOwnerAssignment.count({ where: { scope: "DEFAULT" } })) === 7 && OWNER_DUTIES.length === 7);
  }

  // =========================================================================
  c.head("2 · a TEST client writes through the shared link");
  // =========================================================================
  const mara = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Mara TEST", owner: { email: "info+maratest@realtourpilot.com", name: "Mara Test" } });
  const maraClientName = mara.clientName;
  {
    const r1 = await portalPostMessage({ token: mara.portalToken }, { body: "Hi! Can we move my topic about pricing to next month?" });
    c.ok("the real server action accepts it from the link", r1.ok === true, r1.message);
    const msgs = await prisma.programMessage.findMany({ where: { enrollmentId: mara.enrollmentId } });
    c.ok("one CLIENT message, assigned to Kyle, labelled as the link", msgs.length === 1 && msgs[0].authorKind === "CLIENT" && msgs[0].assignedAppUserId === kyle.id && msgs[0].authorLabel === `${maraClientName} (portal)`, msgs[0]?.authorLabel);
    let threads = await pm.unreadThreadsForStaff(kyle.id);
    c.ok("Kyle has one unread thread", threads.length === 1 && threads[0].enrollmentId === mara.enrollmentId && threads[0].unanswered === 1);
    const bellFor = () => prisma.notification.count({ where: { kind: "program_message", userKey: `tm:${kyleTm.id}` } });
    c.ok("exactly one bell row addressed to Kyle (tm:)", (await bellFor()) === 1);
    c.ok("…and Jordan's OWNER row beside it", (await prisma.notification.count({ where: { kind: "program_message", userKey: null, audience: { contains: "OWNER" } } })) === 1);
    const r2 = await portalPostMessage({ token: mara.portalToken }, { body: "Also, is the session still on for Tuesday?" });
    threads = await pm.unreadThreadsForStaff(kyle.id);
    c.ok("a second message: still one thread (two waiting), still one bell", r2.ok && threads.length === 1 && threads[0].unanswered === 2 && (await bellFor()) === 1, `${threads[0]?.unanswered}`);
    c.ok("a TEST client raises no desk task", (await prisma.smartTask.count({ where: { dedupeKey: `${pm.PROGRAM_MESSAGE_TASK_PREFIX}${mara.enrollmentId}` } })) === 0);
    c.ok("the bell is bell-only: program_message has no notify switch to page a phone", (await import("@/lib/notifyPrefs")).eventForKind("program_message") === null);
  }

  // =========================================================================
  c.head("3 · a real client gets ONE desk task, refreshed");
  // =========================================================================
  const lopezClient = await prisma.client.create({ data: { name: "Mara Lopez", email: "mara.lopez@example.com", phone: "2155550101" } });
  const lopezE = await prisma.contentEnrollment.create({ data: { clientId: lopezClient.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, status: "ACTIVE" } });
  const lopezUser = await prisma.clientUser.create({ data: { email: "mara.lopez@example.com", name: "Mara Lopez", status: "ACTIVE" } });
  const lopezSeat = await prisma.clientMembership.create({ data: { clientUserId: lopezUser.id, enrollmentId: lopezE.id, clientId: lopezClient.id, role: "OWNER", acceptedAt: new Date() } });
  const lopez = { enrollmentId: lopezE.id, clientId: lopezClient.id, clientName: "Mara Lopez" };
  const lopezViewer = viewerOf(lopez, { kind: "CLIENT", clientUserId: lopezUser.id, email: lopezUser.email, name: "Mara Lopez", membershipId: lopezSeat.id, membershipRole: "OWNER" });
  const taskKey = `${pm.PROGRAM_MESSAGE_TASK_PREFIX}${lopezE.id}`;
  {
    const r = await pm.postClientMessage(lopezViewer, { body: "Quick question about my brand colours." });
    const t = await prisma.smartTask.findUnique({ where: { dedupeKey: taskKey } });
    const { endOfBusinessDaysET } = await import("@/lib/datetime");
    const expectDue = endOfBusinessDaysET(new Date(), 1);
    c.ok("one SmartTask: program_message, kyle, content_program", r.ok && t?.taskType === "program_message" && t.assignedKey === "kyle" && t.source === "content_program" && t.status === "OPEN", `${t?.taskType} ${t?.assignedKey}`);
    c.ok("due at the end of the next business day", !!t?.dueAt && Math.abs(t.dueAt.getTime() - expectDue.getTime()) < 60_000, t?.dueAt?.toISOString());
    c.ok("NOT taskType client_reply (the reply queue auto-closes those on any outgoing text)", t?.taskType !== "client_reply");
    await pm.postClientMessage(lopezViewer, { body: "And can we add a second logo?" });
    const all = await prisma.smartTask.findMany({ where: { dedupeKey: taskKey } });
    c.ok("a second message refreshes the same task", all.length === 1 && /2 messages are waiting/.test(all[0].description ?? ""), all[0]?.description?.split("\n")[0]);
    await prisma.smartTask.update({ where: { dedupeKey: taskKey }, data: { assignedKey: "jordan", assignedManually: true } });
    await pm.postClientMessage(lopezViewer, { body: "Sorry, one more: the Tuesday time works." });
    c.ok("a person's reassignment survives the next refresh (assignedManually)", (await prisma.smartTask.findUnique({ where: { dedupeKey: taskKey } }))?.assignedKey === "jordan");
  }

  // =========================================================================
  c.head("4 · Kyle replies, the client reads it");
  // =========================================================================
  {
    const lastClient = await prisma.programMessage.findFirstOrThrow({ where: { enrollmentId: lopezE.id, authorKind: "CLIENT" }, orderBy: { createdAt: "desc" } });
    const r = await pm.postStaffMessage(lopezE.id, { id: kyle.id, name: "Kyle Drill", email: kyle.email }, "Yes to all three. Send the second logo on your Brand Profile page.", lastClient.id);
    c.ok("the reply is sent and answers the run", r.ok && /3 messages answered/.test(r.message), r.message);
    c.ok("every client message is handled, by Kyle", (await prisma.programMessage.count({ where: { enrollmentId: lopezE.id, authorKind: "CLIENT", handledAt: null } })) === 0 && (await prisma.programMessage.count({ where: { enrollmentId: lopezE.id, handledBy: kyle.email } })) === 3);
    c.ok("the task is COMPLETED", (await prisma.smartTask.findUnique({ where: { dedupeKey: taskKey } }))?.status === "COMPLETED");
    c.ok("Kyle's thread list is clear of her", !(await pm.unreadThreadsForStaff(kyle.id)).some((t) => t.enrollmentId === lopezE.id));
    const key = pm.readerKeyFor(lopezViewer);
    const view = await pm.threadFor(lopezE.id, key, { audience: "client" });
    const reply = view.messages.at(-1)!;
    c.ok("the client's thread shows four messages in order, the reply last and linked", view.messages.length === 4 && reply.authorKind === "STAFF" && reply.replyToId === lastClient.id && view.messages.every((m, i, a) => i === 0 || a[i - 1].createdAtISO <= m.createdAtISO));
    c.ok("the client's copy carries no office bookkeeping", view.messages.every((m) => m.handled === false && m.looksLikeVideoChange === false));
    c.ok("unread for the client: 1", view.unread === 1 && (await pm.unreadForReader(lopezE.id, key)) === 1);
    await pm.markThreadRead(lopezE.id, `au:${jordan.id}`);
    c.ok("staff reading does not move the client's marker", (await pm.unreadForReader(lopezE.id, key)) === 1);
    await pm.markThreadRead(lopezE.id, key);
    c.ok("after the client reads it: 0", (await pm.unreadForReader(lopezE.id, key)) === 0);
    await pm.markThreadRead(lopezE.id, key, new Date(Date.now() - 86_400_000));
    c.ok("a stale read never moves the marker backwards", (await pm.unreadForReader(lopezE.id, key)) === 0);

    await pm.postClientMessage(lopezViewer, { body: "Thanks!" });
    c.ok("a new message reopens the task", (await prisma.smartTask.findUnique({ where: { dedupeKey: taskKey } }))?.status === "OPEN");
    const h = await pm.markThreadHandled(lopezE.id, { id: kyle.id, email: kyle.email });
    c.ok("'No reply needed' closes the run with no message", h.handled === 1 && (await prisma.smartTask.findUnique({ where: { dedupeKey: taskKey } }))?.status === "COMPLETED" && (await prisma.programMessage.count({ where: { enrollmentId: lopezE.id, authorKind: "STAFF" } })) === 1);
  }

  // =========================================================================
  c.head("5 · a video change written as a message stays a message");
  // =========================================================================
  {
    const before = { briefs: await prisma.revisionBrief.count(), comments: await prisma.portalComment.count(), revTasks: await prisma.smartTask.count({ where: { taskType: "revision" } }) };
    const r = await pm.postClientMessage(lopezViewer, { body: "On the second video can you change the music at 0:12 and cut the intro shorter?" });
    const after = { briefs: await prisma.revisionBrief.count(), comments: await prisma.portalComment.count(), revTasks: await prisma.smartTask.count({ where: { taskType: "revision" } }) };
    c.ok("stored as a message", r.ok && (await prisma.programMessage.count({ where: { id: r.id } })) === 1);
    c.ok("no RevisionBrief, no PortalComment, no revision task", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    c.ok("the confirmation says where video changes go", r.message.includes(pm.VIDEO_CHANGES_HINT), r.message);
    const ok = await pm.postClientMessage(lopezViewer, { body: "What day works for the strategy call?" });
    c.ok("an ordinary question's confirmation does not lecture", ok.ok && !ok.message.includes(pm.VIDEO_CHANGES_HINT), ok.message);
    const staff = await pm.threadFor(lopezE.id, `au:${kyle.id}`, { audience: "staff" });
    const client = await pm.threadFor(lopezE.id, pm.readerKeyFor(lopezViewer), { audience: "client" });
    c.ok("Kyle sees 'looks like a video change' on it; the client does not", staff.messages.find((m) => m.id === r.id)?.looksLikeVideoChange === true && client.messages.find((m) => m.id === r.id)?.looksLikeVideoChange === false);
  }

  // =========================================================================
  c.head("6 · who may write");
  // =========================================================================
  {
    const vUser = await prisma.clientUser.create({ data: { email: "viewer@example.com", name: "Vic Viewer", status: "ACTIVE" } });
    const vSeat = await prisma.clientMembership.create({ data: { clientUserId: vUser.id, enrollmentId: lopezE.id, clientId: lopezClient.id, role: "VIEWER", acceptedAt: new Date() } });
    const v = await pm.postClientMessage(viewerOf(lopez, { kind: "CLIENT", clientUserId: vUser.id, email: vUser.email, name: "Vic Viewer", membershipId: vSeat.id, membershipRole: "VIEWER" }), { body: "Can I say something?" });
    c.ok("a VIEWER seat is refused", !v.ok && /view-only/.test(v.message), v.message);
    const p = await pm.postClientMessage(viewerOf(lopez, lopezViewer.actor, "PAUSED"), { body: "Hello?" });
    c.ok("a PAUSED program is refused — with Kyle's number, not 'text us'", !p.ok && p.message.includes("(215) 645-4889") && !/text us/i.test(p.message), p.message);
    const n = await prisma.programMessage.count({ where: { enrollmentId: lopezE.id } });
    const s = await pm.postClientMessage(viewerOf(lopez, { kind: "STAFF", staffUserId: jordan.id, staffName: "Jordan Spackman", staffRole: "OWNER" }), { body: "Jordan here, answering from your page." });
    const row = await prisma.programMessage.findUnique({ where: { id: s.id ?? "" } });
    c.ok("staff through the owner iframe are stored as STAFF, never as the client", s.ok && row?.authorKind === "STAFF" && row.staffUserId === jordan.id && row.clientUserId === null && (await prisma.programMessage.count({ where: { enrollmentId: lopezE.id } })) === n + 1);
  }

  // =========================================================================
  c.head("7 · guards");
  // =========================================================================
  {
    const cap = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Cap Chatty TEST", owner: { email: "info+capchatty@realtourpilot.com", name: "Cap Chatty" } });
    const capV = viewerOf(cap, { kind: "TOKEN" });
    let refusedAt = -1;
    for (let i = 1; i <= pm.MESSAGE_DAILY_CAP + 1; i++) {
      const r = await pm.postClientMessage(capV, { body: `Message number ${i}` });
      if (!r.ok) { refusedAt = i; break; }
    }
    c.ok(`the ${pm.MESSAGE_DAILY_CAP + 1}st message in a day is refused`, refusedAt === pm.MESSAGE_DAILY_CAP + 1, String(refusedAt));
    const own = await prisma.contentVideo.create({ data: { enrollmentId: lopezE.id, clientId: lopezClient.id, monthKey: "2026-10", slot: 1, status: "DELIVERED", title: "Her video" } });
    const foreign = await prisma.contentVideo.create({ data: { enrollmentId: mara.enrollmentId, clientId: mara.clientId, monthKey: "2026-10", slot: 1, status: "DELIVERED", title: "Someone else's video" } });
    const bad = await pm.postClientMessage(lopezViewer, { body: "About this one", ref: { kind: "VIDEO", id: foreign.id } });
    const good = await pm.postClientMessage(lopezViewer, { body: "About this one", ref: { kind: "VIDEO", id: own.id } });
    c.ok("a reference to another account's video is refused; her own is kept", !bad.ok && good.ok && (await prisma.programMessage.findUnique({ where: { id: good.id ?? "" } }))?.refId === own.id, bad.message);
  }

  // =========================================================================
  c.head("8 · the 'you have a reply' email");
  // =========================================================================
  {
    // A Tuesday at 11am ET — inside the client window, whatever day this runs.
    const T = etAt("2026-09-29", 11);
    const seatEmail = "info+maratest@realtourpilot.com";
    const noticeRows = () => prisma.outboxMessage.findMany({ where: { requestedBy: "program-message-notice" } });
    await pm.postStaffMessage(mara.enrollmentId, { id: kyle.id, name: "Kyle Drill", email: kyle.email }, "Moved it to October. Tuesday is still on.", null, { now: new Date(T.getTime() - 5 * 60_000) });
    const off = await pm.sweepProgramMessageNotices({ now: T });
    c.ok("switch off (no row): skipped, nothing queued", !!off.skipped && (await noticeRows()).length === 0, off.skipped);

    await prisma.programAutomation.create({ data: { key: "program_message_notice", enabled: true, enabledBy: "drill", enabledAt: new Date() } });
    const sat = await pm.sweepProgramMessageNotices({ now: etAt("2026-10-03", 11) });
    c.ok("on, but a Saturday: skipped (client hours only)", !!sat.skipped && (await noticeRows()).length === 0, sat.skipped);
    const on = await pm.sweepProgramMessageNotices({ now: T });
    const rows = await noticeRows();
    c.ok("on, a weekday: exactly one email, kind program_message, to the seat", on.sent === 1 && rows.length === 1 && rows[0].toRef === seatEmail && rows[0].dedupeKey?.startsWith("program_message:") === true && rows[0].state === "accepted", JSON.stringify(on));
    const mail = mails.find((m) => m.to === seatEmail);
    c.ok("…under its own subject, with the reply and the sign-in page, no em dashes", !!mail && mail.subject === "New reply in your RealTour Pilot portal" && mail.body.includes("Moved it to October") && mail.body.includes("/portal/login") && !/[—–]/.test(mail.body), mail?.subject);
    const again = await pm.sweepProgramMessageNotices({ now: new Date(T.getTime() + 3_600_000) });
    c.ok("the next hourly tick sends nothing more", again.sent === 0 && (await noticeRows()).length === 1);
    await pm.markThreadRead(mara.enrollmentId, `cu:${mara.clientUserId}`, new Date(T.getTime() + 2 * 3_600_000));
    await pm.postStaffMessage(mara.enrollmentId, { id: kyle.id, name: "Kyle Drill", email: kyle.email }, "One more thing.", null, { now: new Date(T.getTime() + 3 * 3_600_000) });
    c.ok("a new reply after she read the last one gets its own email (sent inline)", (await noticeRows()).length === 2);
    await pm.markThreadRead(mara.enrollmentId, `cu:${mara.clientUserId}`, new Date(T.getTime() + 4 * 3_600_000));
    await pm.sweepProgramMessageNotices({ now: new Date(T.getTime() + 5 * 3_600_000) });
    c.ok("a reply she already read on the portal is not emailed", (await noticeRows()).length === 2);

    await prisma.clientUser.update({ where: { id: mara.clientUserId! }, data: { email: "mara.real.inbox@gmail.com" } });
    // 4:10 and 4:15pm ET: still inside the client window (it closes at 4:30).
    await pm.postStaffMessage(mara.enrollmentId, { id: kyle.id, name: "Kyle Drill", email: kyle.email }, "Checking in.", null, { now: new Date(T.getTime() + 310 * 60_000) });
    const floor = await pm.sweepProgramMessageNotices({ now: new Date(T.getTime() + 315 * 60_000) });
    c.ok("a TEST client's unverified address is refused by the outbox floor, loudly", floor.refused >= 1 && floor.notes.some((n) => /Refusing to send/.test(n)) && (await prisma.outboxMessage.count({ where: { toRef: "mara.real.inbox@gmail.com" } })) === 0, floor.notes[0]);
    await prisma.clientUser.update({ where: { id: mara.clientUserId! }, data: { email: seatEmail } });
  }

  // =========================================================================
  c.head("9 · the guides: drafted, unpublished, then publishable");
  // =========================================================================
  {
    const { RESOURCE_GROUPS, COMING_SOON, publishedResources, resourcesForAction } = await import("@/lib/portalResources");
    const { createResource, setResourcePublished, LINKABLE_ACTIONS } = await import("@/lib/portalResourcesAdmin");
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp13-guides-")), "guides.json");
    execFileSync("npx", ["tsx", "scripts/draft-portal-guides.ts", "--out", out], { cwd: REPO, env: { ...process.env, NODE_OPTIONS: "" }, stdio: "pipe" });
    const bundle = JSON.parse(fs.readFileSync(out, "utf8")) as { guides: { slug: string; title: string; groupKey: string; summary: string | null; body: string; platform: string | null; deviceContext: string | null; linkedActions: string[]; sortOrder: number; published: boolean }[] };
    const g = bundle.guides;
    c.ok("nine drafts, every one unpublished", g.length === 9 && g.every((x) => x.published === false));
    c.ok("YOUR_MONTH leads the groups", RESOURCE_GROUPS[0]?.key === "YOUR_MONTH");
    c.ok("every draft's group is a real Resources group", g.every((x) => RESOURCE_GROUPS.some((r) => r.key === x.groupKey)), g.map((x) => x.groupKey).join(","));
    c.ok("every linked action is a real action key", g.every((x) => x.linkedActions.every((a) => LINKABLE_ACTIONS.some((l) => l.key === a))));
    c.ok("the nine the audit named are all there", ["how-your-month-works", "choosing-topics-and-answering-questions", "approving-your-scripts", "preparing-for-your-filming-session", "reviewing-a-video-and-asking-for-changes", "downloading-and-saving-your-videos", "posting-at-high-quality", "writing-your-captions", "choosing-a-thumbnail-cover"].every((s) => g.some((x) => x.slug === s)));
    c.ok("no draft promises a browser saves straight into Photos", !g.some((x) => /saves? (straight|directly) (in)?to (your )?photos/i.test(x.body)) && /does not go straight into Photos/.test(g.find((x) => x.slug === "downloading-and-saving-your-videos")!.body));
    const ids: string[] = [];
    for (const x of g) {
      const r = await createResource({ title: x.title, groupKey: x.groupKey, summary: x.summary, body: x.body, platform: x.platform, deviceContext: x.deviceContext, linkedActions: x.linkedActions, sortOrder: x.sortOrder }, "drill");
      c.ok(`"${x.title}" loads with the slug the portal links to`, r.slug === x.slug, r.slug);
      ids.push(r.id);
    }
    const hidden = await publishedResources();
    c.ok("loaded but unpublished: a client sees none of them", hidden.reduce((n, grp) => n + grp.resources.length, 0) === 0);
    c.ok("resourcesForAction finds nothing unpublished", (await resourcesForAction("review_cut")).length === 0);
    const noOwner = await setResourcePublished(ids[0], true, "drill").then(() => "published").catch((e: Error) => e.message);
    c.ok("publishing without an owner is refused (a person keeps it current)", /owner/i.test(noOwner), noOwner);
    await prisma.portalResource.updateMany({ data: { ownerAppUserId: kyle.id } });
    const reviewId = ids[g.findIndex((x) => x.slug === "reviewing-a-video-and-asking-for-changes")];
    await setResourcePublished(ids[0], true, "jordan");
    await setResourcePublished(reviewId, true, "jordan");
    const shown = await publishedResources();
    const month = shown.find((grp) => grp.key === "YOUR_MONTH")!;
    c.ok("published: the YOUR_MONTH guide renders, kept current by Kyle", month.resources.length === 1 && month.resources[0].slug === "how-your-month-works" && month.resources[0].ownerName === "Kyle Drill");
    c.ok("the other seven stay invisible", shown.reduce((n, grp) => n + grp.resources.length, 0) === 2);
    c.ok("resourcesForAction('review_cut') returns the linked guide", JSON.stringify((await resourcesForAction("review_cut")).map((r) => r.slug)) === JSON.stringify(["reviewing-a-video-and-asking-for-changes"]));
    let allPublishable = true;
    for (const id of ids) await setResourcePublished(id, true, "jordan").catch(() => { allPublishable = false; });
    c.ok("all nine pass the publish gate (no placeholder text)", allPublishable && (await publishedResources()).reduce((n, grp) => n + grp.resources.length, 0) === 9);
    c.ok("Instagram publishing and the advanced guides are 'Coming soon' — code, not rows", COMING_SOON.some((x) => /Instagram/.test(x.title)) && COMING_SOON.some((x) => /Advanced/i.test(x.title)) && (await prisma.portalResource.count({ where: { title: { contains: "Instagram" } } })) === 0);
    const tab = read("src/components/portal/tabs/ResourcesTab.tsx");
    c.ok("the Resources tab prints 'Coming soon' and no longer says 'Text us'", tab.includes("Coming soon") && !/text us/i.test(tab.replace(/\/\/.*$/gm, "")));
  }

  // =========================================================================
  c.head("10 · reaching Kyle");
  // =========================================================================
  {
    const d = await pm.portalContact();
    c.ok("default: Kyle, (215) 645-4889, dialled as +12156454889", d.name === "Kyle" && d.display === "(215) 645-4889" && d.e164 === "+12156454889");
    await prisma.appSetting.create({ data: { key: "portal-contact", value: JSON.stringify({ name: "Jordan Spackman", phoneE164: "+12155348650" }) } });
    const j = await pm.portalContact();
    c.ok("an owner-set portal-contact is honoured (first name, formatted line)", j.name === "Jordan" && j.display === "(215) 534-8650" && j.e164 === "+12155348650", JSON.stringify(j));
    await prisma.appSetting.update({ where: { key: "portal-contact" }, data: { value: JSON.stringify({ name: "Nobody", phoneE164: "555" }) } });
    c.ok("a malformed one never prints a broken number — the default stands", (await pm.portalContact()).e164 === "+12156454889");
    await prisma.appSetting.delete({ where: { key: "portal-contact" } });
    const page = read("src/components/portal/PortalPage.tsx");
    c.ok("the portal footer is the contact card, not 'Text us any time'", !page.includes("Text us any time") && page.includes("<ContactTeam"));
    const card = read("src/components/portal/ContactTeam.tsx");
    const clientCopy = /DEFAULT_PORTAL_CONTACT: PortalContact = \{ name: "([^"]+)", display: "([^"]+)", e164: "([^"]+)" \}/.exec(card);
    c.ok("the client-safe copy of the default says exactly what the server's says", !!clientCopy && clientCopy[1] === pm.DEFAULT_OFFICE_CONTACT.name && clientCopy[2] === pm.DEFAULT_OFFICE_CONTACT.display && clientCopy[3] === pm.DEFAULT_OFFICE_CONTACT.e164, clientCopy?.slice(1).join(" / "));
    c.ok("the card dials: tel: and sms: links, and Message <name> to the thread", card.includes("href={`tel:${contact.e164}`}") && card.includes("href={`sms:${contact.e164}`}") && card.includes("Message {contact.name}"));
    const pageTabs = page.match(/export type PortalTab = [^;]+;/)?.[0] ?? "";
    c.ok("the portal has a Messages tab, in the account menu and the phone's More sheet", pageTabs.includes('"messages"') && page.includes("Messages{a.unread > 0"));
  }

  // =========================================================================
  c.head("11 · staff surfaces");
  // =========================================================================
  {
    const tab = await pm.staffMessagesTab(lopezE.id, { id: kyle.id });
    c.ok("the Messages tab loader: the thread, the waiting count, which channels exist", !!tab && tab.thread.messages.length >= 6 && tab.unanswered >= 1 && tab.client.hasPhone === true && tab.client.hasEmail === true && tab.noticeOn === true, `${tab?.thread.messages.length} msgs, ${tab?.unanswered} waiting`);
    c.ok("the owner is named on it", tab?.thread.owner.label === "Kyle Drill");
    const { programOverview } = await import("@/lib/programOverview");
    const ov = await programOverview({}).catch((e: Error) => { console.log("  (overview:", e.message, ")"); return null; });
    const row = ov?.rows.find((r) => r.enrollmentId === lopezE.id);
    c.ok("the roster's comms summary reads the waiting messages", !!row && row.comms.messagesWaiting === (await pm.unansweredCount(lopezE.id)) && row.comms.oldestWaitingAt !== null, `${row?.comms.messagesWaiting}`);
    const bk = read("scripts/backup-content-program.ts");
    c.ok("the content-program backup lists ProgramMessage and ProgramMessageRead", /"ProgramMessage", "ProgramMessageRead"/.test(bk));
  }

  c.head("isolation");
  c.ok("nothing left the machine except the Gmail fakes", fence.blocked.length === 0, fence.blocked.join(", "));
  console.log(`  (faked calls: ${fence.faked.length} · emails captured: ${mails.length} · prisma error lines swallowed: ${quiet.count})`);

  c.summary();
  quiet.restore();
  await stop();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
