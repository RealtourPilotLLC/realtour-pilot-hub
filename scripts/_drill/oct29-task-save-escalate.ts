// Oct 29 2026: TASKS SAVE, HANDED-ON ROWS LEAVE, ONE WAY UP, MARK HANDLED UNDOES.
//   §1  James on a job's task cards (893 S Matlack, Oct 28: "The status change was
//       not confirmed. Reload…"): his crew's tasks (editors, outside shops,
//       photographers) and what he assigned save; an office task says whose it is
//       and nothing changes; owner changes come back in words.
//   §2  Send to Jordan (lib/sendToJordan): a task someone else holds becomes one
//       decision on Jordan's plate (sent twice, still one); a delegated task is
//       escalated where it is; a task the sender holds moves up; Jordan, a
//       photographer and a closed task are refused.
//   §3  A desk row handed on leaves the desk (Kyle, Oct 29: "I delegated this task
//       to Jordan but it's still showing up"): the row's id is on the hand-off,
//       it matches only that row, a cancelled one gives the row back, and the
//       older unstamped hand-offs match by page only when they came after the row.
//   §4  Mark handled undoes (Kyle, Oct 29: "I clicked on marked as handled on this
//       task by mistake"): the tick returns an undo id, Handled today lists it,
//       Undo puts every row back, a newer change is never overwritten, a trace
//       row is cancelled.
// Disposable PGlite; Slack is faked; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  if (method === "conversations.open") return json({ ok: true, channel: { id: "D-DRILL" } });
  return json({ ok: true, ts: "1" });
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5947), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct29-task-save" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const actions = await import("@/app/actions");
    const D = await import("@/app/delegation/actions");
    const lib = await import("@/lib/delegation");
    const { creativeLeadReachesTask, crewKeys } = await import("@/lib/auth/guards");
    const { deskRowHref, deskRowOf, handOffFor } = await import("@/lib/deskHandOff");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@save.invalid`, slackId: `U${name.split(" ")[0].toUpperCase()}`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER");
    const user = (name: string, email: string, role: string, teamMemberId: string | null) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "hello@save.invalid", "ADMIN", kyleTm.id);
    const james = await user("James Livingston", "james@save.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const harrison = await user("Harrison Wells", "harrison@save.invalid", "PHOTOGRAPHER", harrisonTm.id);
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const client = await prisma.client.create({ data: { name: "Joe Sutow", phone: "2155550199" } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "893 S Matlack St, West Chester", status: "EDITING" } });
    const task = (title: string, assignedKey: string | null, extra: Record<string, unknown> = {}) => prisma.smartTask.create({ data: { taskType: "revision", title, source: "manual", status: "OPEN", projectId: project.id, clientId: client.id, assignedKey, ...extra } });

    // =====================================================================
    c.head("§1 · James completes and moves his crew's tasks; an office task says whose it is");
    // =====================================================================
    const crew = await crewKeys();
    c.ok("crew: the editors, the outside shops and the photographers, never Jordan, Kyle or James", ["kim", "john", "luma", "cliffside_cuts", "harrison"].every((k) => crew.has(k)) && !crew.has("jordan") && !crew.has("kyle") && !crew.has("james"), [...crew].join(","));
    c.ok("creativeLeadReachesTask: a crew task, a task he assigned; not Kyle's", creativeLeadReachesTask({ assignedKey: "kim", delegatedBy: null }, james.email, crew) && creativeLeadReachesTask({ assignedKey: "kyle", delegatedBy: "JAMES@save.invalid" }, james.email, crew) && !creativeLeadReachesTask({ assignedKey: "kyle", delegatedBy: null }, james.email, crew));
    const kimRev = await task("Video revision · 893 S Matlack", "kim");
    const kimMention = await task("Jordan tagged you · 893 S Matlack", "kim", { taskType: "internal_instruction" });
    const kyleQc = await task("QC & deliver · 893 S Matlack", "kyle", { taskType: "media_qa" });
    await signIn(james);
    const s1 = await actions.setSmartTaskStatus(kimRev.id, "COMPLETED");
    const kimAfter = await prisma.smartTask.findUnique({ where: { id: kimRev.id } });
    c.ok("James completes Kim's revision (refused with the Reload message on Oct 28)", (s1 == null || s1.ok) && kimAfter?.status === "COMPLETED", JSON.stringify(s1));
    const s2 = await actions.setTaskAssignee(kimMention.id, "john");
    const mAfter = await prisma.smartTask.findUnique({ where: { id: kimMention.id } });
    c.ok("James moves Kim's @mention to John, and it says so", s2?.ok === true && /Moved to John/.test(s2.message) && mAfter?.assignedKey === "john", JSON.stringify(s2));
    const s3 = await actions.setSmartTaskStatus(kyleQc.id, "COMPLETED");
    const qcAfter = await prisma.smartTask.findUnique({ where: { id: kyleQc.id } });
    c.ok("Kyle's QC: refused in words that name Kyle and the way up, nothing changed", s3?.ok === false && /Kyle's/.test(s3.message) && /Nothing was changed/.test(s3.message) && /Send to Jordan/.test(s3.message) && qcAfter?.status === "OPEN", JSON.stringify(s3));
    const s4 = await actions.setTaskAssignee(kyleQc.id, "james");
    c.ok("…and moving it is refused the same way", s4?.ok === false && /Kyle's/.test(s4.message) && (await prisma.smartTask.findUnique({ where: { id: kyleQc.id } }))?.assignedKey === "kyle");
    await signIn(owner, james.id);
    const s5 = await actions.setSmartTaskStatus(kimMention.id, "COMPLETED");
    c.ok("Jordan's read-only preview as James: refused in words, nothing written", s5?.ok === false && /preview/i.test(s5.message) && (await prisma.smartTask.findUnique({ where: { id: kimMention.id } }))?.status === "OPEN", JSON.stringify(s5));
    await signIn(kyle);
    const s6 = await actions.setTaskAssignee(kyleQc.id, "harrison");
    c.ok("Kyle (office) moves any task, and is told where it went", s6?.ok === true && /Harrison/.test(s6.message));

    // =====================================================================
    c.head("§2 · Send to Jordan: one way up from any card");
    // =====================================================================
    const jamesTask = await task("Pick the music for 893 S Matlack", "james");
    await signIn(kyle);
    const n0 = await prisma.smartTask.count();
    const u1 = await D.sendToJordanAction({ title: "893 S Matlack: Pick the music", why: "Client wants a say in the music", taskId: jamesTask.id });
    const dec = await prisma.smartTask.findFirst({ where: { title: { startsWith: "Decision: 893 S Matlack" } } });
    const decRec = lib.parseDelegation(dec?.delegation);
    c.ok("someone else's task → one decision task on Jordan's plate, linked to the task, flagged as his decision", u1.ok && (await prisma.smartTask.count()) === n0 + 1 && dec?.assignedKey === "jordan" && decRec?.sourceHref === `/projects/${project.id}#task-${jamesTask.id}` && !!decRec?.escalated && /music/.test(decRec.escalated.why), u1.message);
    c.ok("…James's task stays James's", (await prisma.smartTask.findUnique({ where: { id: jamesTask.id } }))?.assignedKey === "james");
    const u2 = await D.sendToJordanAction({ title: "893 S Matlack: Pick the music", why: "Asking again", taskId: jamesTask.id });
    c.ok("sent twice: still one decision", u2.ok && (await prisma.smartTask.count()) === n0 + 1, u2.message);
    const kyleOwn = await task("Call the listing agent about access", "kyle", { taskType: "todo" });
    const u3 = await D.sendToJordanAction({ title: "Access call", why: "The agent only talks to Jordan", taskId: kyleOwn.id });
    const kyleOwnAfter = await prisma.smartTask.findUnique({ where: { id: kyleOwn.id } });
    c.ok("a task Kyle holds moves up to Jordan as his decision", u3.ok && kyleOwnAfter?.assignedKey === "jordan" && !!lib.parseDelegation(kyleOwnAfter.delegation)?.escalated, u3.message);
    const handed = await D.assignTaskAction({ title: "Shot list for 893 S Matlack", assigneeKey: "james", sourceHref: `/projects/${project.id}#shots` });
    const handedTask = await prisma.smartTask.findFirst({ where: { dedupeKey: `deleg:/projects/${project.id}#shots` } });
    const u4 = await D.sendToJordanAction({ title: "Shot list", why: "James and I disagree on the drone shots", taskId: handedTask!.id });
    const hAfter = await prisma.smartTask.findUnique({ where: { id: handedTask!.id } });
    c.ok("a delegated task is escalated where it is (stays James's, flagged for Jordan)", handed.ok && u4.ok && hAfter?.assignedKey === "james" && !!lib.parseDelegation(hAfter.delegation)?.escalated, u4.message);
    await signIn(james);
    const u5 = await D.sendToJordanAction({ title: "Joe Sutow: Unhappy about 893 S Matlack", why: "He wants a reshoot for free", href: `/clients/${client.id}#issue-x1`, clientId: client.id });
    const comp = await prisma.smartTask.findFirst({ where: { dedupeKey: `deleg:/clients/${client.id}#issue-x1` } });
    c.ok("James from a complaint (no task): a decision for Jordan, linked to the complaint", u5.ok && comp?.assignedKey === "jordan" && !!lib.parseDelegation(comp?.delegation)?.escalated, u5.message);
    await signIn(owner);
    const u6 = await D.sendToJordanAction({ title: "x", why: "for me", taskId: jamesTask.id });
    await signIn(harrison);
    const u7 = await D.sendToJordanAction({ title: "x", why: "please", taskId: jamesTask.id });
    await signIn(kyle);
    const u8 = await D.sendToJordanAction({ title: "x", why: "too late", taskId: kimRev.id });
    const u9 = await D.sendToJordanAction({ title: "x", why: "", taskId: jamesTask.id });
    c.ok("refused: Jordan himself, a photographer, a closed task, no reason", !u6.ok && !u7.ok && !u8.ok && /closed/.test(u8.message) && !u9.ok, [u6, u7, u8, u9].map((r) => r.message).join(" | "));
    await signIn(owner, kyle.id);
    const u10 = await D.sendToJordanAction({ title: "x", why: "preview", taskId: jamesTask.id });
    c.ok("the owner's preview sends nothing", !u10.ok && /previewing/.test(u10.message));

    // =====================================================================
    c.head("§3 · A desk row handed on leaves the desk");
    // =====================================================================
    const page = `/projects/${project.id}`;
    c.ok("deskRowHref stamps the row before any #hash; deskRowOf reads it back", deskRowHref(page, "booking:abc") === `${page}?desk=booking%3Aabc` && deskRowHref("/communications?tab=email#x", "reply:email:a|b") === "/communications?tab=email&desk=reply%3Aemail%3Aa%7Cb#x" && deskRowOf(deskRowHref(page, "booking:abc")) === "booking:abc" && deskRowOf(page) === null);
    c.ok("a link that would pass 300 characters stays the plain page", deskRowHref(`/${"x".repeat(290)}`, "booking:abcdefghij") === `/${"x".repeat(290)}`);
    await signIn(kyle);
    const sinceISO = new Date(Date.now() - 3_600_000).toISOString();
    const ho = await D.assignTaskAction({ title: "Sharra Mercer: Booking request: Book follow-up call", assigneeKey: "jordan", sourceHref: deskRowHref(page, "booking:ask1") });
    const mine = await lib.tasksDelegatedByAny([kyle.email]);
    const row = { id: "booking:ask1", href: page, sinceISO };
    c.ok("Kyle's hand-off carries the row; it matches that row (waiting on Jordan)", ho.ok && handOffFor(row, mine)?.assigneeName === "Jordan", ho.message);
    c.ok("…and not another row on the same job page, nor a row with its own task", handOffFor({ id: "ask:req2", href: page, sinceISO }, mine) == null && handOffFor({ id: `task:${kimRev.id}`, href: page, sinceISO }, mine) == null);
    const ho2 = await D.assignTaskAction({ title: "Special request: check before delivery", assigneeKey: "jordan", sourceHref: deskRowHref(page, "ask:req2") });
    c.ok("two rows on one page are two hand-offs now (the link is the dedupe key)", ho2.ok && (await prisma.smartTask.count({ where: { delegatedBy: kyle.email, assignedKey: "jordan", dedupeKey: { startsWith: `deleg:${page}?desk=` } } })) === 2, ho2.message);
    const t1 = mine.find((h) => deskRowOf(h.sourceHref) === "booking:ask1")!;
    await D.cancelTaskAction(t1.taskId, "Took it back");
    c.ok("cancelled: the row is the desk's again", handOffFor(row, await lib.tasksDelegatedByAny([kyle.email])) == null);
    const legacy = [{ taskId: "L1", sourceHref: page, assignedAt: new Date().toISOString(), state: "ASSIGNED", assigneeName: "Jordan" }];
    c.ok("an unstamped hand-off (before today) matches by page only when it came after the row", handOffFor({ id: "booking:old", href: page, sinceISO }, legacy) != null && handOffFor({ id: "booking:new", href: page, sinceISO: new Date(Date.now() + 60_000).toISOString() }, legacy) == null);

    // =====================================================================
    c.head("§4 · Mark handled undoes, and Handled today reopens");
    // =====================================================================
    const javier = await prisma.client.create({ data: { name: "Gary Mercer Jr.", email: "gary@mercer.invalid" } });
    const { emailAckKey, threadAckKey } = await import("@/lib/replyQueue");
    const emailKey = emailAckKey(javier.id, "jimenez|javier");
    const threadKeyRow = threadAckKey("email", "e:jimenez|javier");
    await prisma.appSetting.create({ data: { key: emailKey, value: "2026-10-27T18:40:49.442Z" } });
    const reply = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Add 913 Lakeview listing", source: "gmail", status: "OPEN", clientId: javier.id, contactName: "Javier Jimenez", assignedKey: "kyle", sourceDetail: "gmail-thread:info@realtourpilot.com:t1" } });
    await signIn(kyle);
    const m1 = await actions.markCommsHandled(javier.id, "email", "jimenez|javier", { threadKey: "e:jimenez|javier", reason: "no reply needed" });
    const replyDone = await prisma.smartTask.findUnique({ where: { id: reply.id } });
    c.ok("the tick lands and hands back an undo id", m1.ok && !!m1.undoId && replyDone?.status === "COMPLETED" && !!(await prisma.appSetting.findUnique({ where: { key: threadKeyRow } })), JSON.stringify(m1));
    const today = await actions.handledTodayAction();
    c.ok("Handled today lists it by the client's name", today.ok && today.rows.some((r) => r.id === m1.undoId && r.label === "Gary Mercer Jr." && r.reason === "no reply needed"), JSON.stringify(today.rows));
    const un = await actions.undoCommsHandled(m1.undoId!);
    const [ek, tk, rAfter, stamp] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: emailKey } }),
      prisma.appSetting.findUnique({ where: { key: threadKeyRow } }),
      prisma.smartTask.findUnique({ where: { id: reply.id } }),
      prisma.appSetting.findUnique({ where: { key: `handled-by-hand:${reply.id}` } }),
    ]);
    c.ok("Undo: the earlier cut is back, the thread tick is gone, the to-do is open, no hand stamp", un.ok && ek?.value === "2026-10-27T18:40:49.442Z" && !tk && rAfter?.status === "OPEN" && rAfter.completedAt == null && !stamp, `${un.message} | ${ek?.value} | ${tk?.value} | ${rAfter?.status} | ${stamp?.value}`);
    c.ok("…it leaves an audit row, and leaves Handled today", (await prisma.auditLog.count({ where: { action: "comms_handled_undone", target: javier.id } })) === 1 && !(await actions.handledTodayAction()).rows.some((r) => r.id === m1.undoId));
    const again = await actions.undoCommsHandled(m1.undoId!);
    c.ok("pressing Undo twice changes nothing more", again.ok && /Already back/.test(again.message), again.message);
    const m2 = await actions.markCommsHandled(javier.id, "email", "jimenez|javier", { threadKey: "e:jimenez|javier", reason: "answered elsewhere" });
    await prisma.appSetting.update({ where: { key: emailKey }, data: { value: new Date(Date.now() + 5_000).toISOString() } });
    const un2 = await actions.undoCommsHandled(m2.undoId!);
    c.ok("a row changed after the tick is never overwritten (said so)", un2.ok && /changed since/.test(un2.message) && (await prisma.appSetting.findUnique({ where: { key: emailKey } }))?.value !== "2026-10-27T18:40:49.442Z", un2.message);
    const textClient = await prisma.client.create({ data: { name: "Text Only", phone: "2155550123" } });
    const m3 = await actions.markCommsHandled(textClient.id, "phone");
    const trace = await prisma.smartTask.findFirst({ where: { clientId: textClient.id, title: "Client reply — handled outside the hub" } });
    const un3 = await actions.undoCommsHandled(m3.undoId!);
    c.ok("a tick with nothing open files a trace; Undo cancels it", m3.ok && !!trace && un3.ok && (await prisma.smartTask.findUnique({ where: { id: trace!.id } }))?.status === "CANCELLED", `${m3.message} ${un3.message}`);
    await signIn(james);
    const m4 = await actions.undoCommsHandled(m1.undoId!);
    c.ok("Undo is the office's, like Mark handled", !m4.ok);

    c.ok("nothing left the building (Slack faked, no other host)", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    await db.stop();
  }
  c.summary();
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
