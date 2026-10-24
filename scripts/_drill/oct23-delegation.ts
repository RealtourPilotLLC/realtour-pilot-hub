// Oct 23 2026: DELEGATION, the shared assignment workflow (lib/delegation,
// app/delegation/actions; Jordan's dashboards spec §5 and §7). Held against
// the spec's checks that belong to it:
//   1  Jordan and the assignee see the same task, the same state, the same update
//   2  delegation reaches the right person with its context (the bell row)
//   3  unaccepted and overdue assignments resurface to the assigner
//   14 role permissions and the read-only preview are enforced
// plus: one canonical task (re-assigning a record re-uses its task, a double
// press makes one), reassignment keeps the history, verification only when
// asked for, blockers and escalations come back, createTaskForKyle is a thin
// wrapper. Every action is called as the signed-in person (the session),
// never with a claimed identity. Disposable PGlite; Slack is faked; nothing
// leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const slack: { channel: string; text: string }[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  if (method === "chat.postMessage") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.open") return json({ ok: true, channel: { id: "D-DRILL" } });
  return json({ ok: true });
});

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5941), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-delegation" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const A = await import("@/app/delegation/actions");
    const lib = await import("@/lib/delegation");
    const { delegatedByMe } = await import("@/lib/ownerWork");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

    // ---- the team ----
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@deleg.invalid`, slackId: `U${name.split(" ")[0].toUpperCase()}`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER");
    const user = (name: string, email: string, role: string, teamMemberId: string | null, extra: Record<string, unknown> = {}) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE", ...extra } });
    const owner = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@deleg.invalid", "ADMIN", kyleTm.id);
    const james = await user("James Livingston", "james@deleg.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const harrison = await user("Harrison Wells", "harrison@deleg.invalid", "PHOTOGRAPHER", harrisonTm.id);
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const client = await prisma.client.create({ data: { name: "Real Agent", phone: "2155550101" } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "12 Oak St, Town", status: "EDITING" } });
    const tasks = () => prisma.smartTask.count();
    const bells = (teamMemberId: string) => prisma.notification.findMany({ where: { userKey: `tm:${teamMemberId}` }, orderBy: { createdAt: "asc" } });
    const T = new Date();
    const dueKey = new Date(T.getTime() + 3 * D).toISOString().slice(0, 10);

    // =====================================================================
    c.head("§1 · Jordan assigns: one task, the right person, the context (#2)");
    // =====================================================================
    await signIn(owner);
    const before = await tasks();
    const r1 = await A.assignTaskAction({ title: "Prepare the strategy brief for Real Agent", outcome: "A one-page brief Jordan can read before the call", assigneeKey: "james", dueAt: dueKey, needsVerification: true, sourceHref: `/projects/${project.id}#brief`, projectId: project.id, clientId: client.id, note: "Use last month's call notes" });
    const t1 = await prisma.smartTask.findFirst({ where: { dedupeKey: `deleg:/projects/${project.id}#brief` } });
    c.ok("assigned: one new SmartTask, on James's key, with who assigned it and when", r1.ok && (await tasks()) === before + 1 && t1?.assignedKey === "james" && t1.ownerId === jamesTm.id && t1.delegatedBy === "info@realtourpilot.com" && !!t1.delegatedAt && t1.assignedManually === true, r1.message);
    const rec1 = lib.parseDelegation(t1?.delegation);
    c.ok("…its record carries the outcome, the verification flag, the source, an acceptance deadline and the 'assigned' event", rec1?.outcome?.startsWith("A one-page brief") === true && rec1.needsVerification && rec1.sourceHref === `/projects/${project.id}#brief` && !!rec1.acceptBy && rec1.events.length === 1 && rec1.events[0].kind === "assigned" && rec1.events[0].by === "Jordan");
    const jb = await bells(jamesTm.id);
    c.ok("#2 James is told through the bell (task_assigned, addressed to him, with the outcome and the link)", jb.length === 1 && jb[0].kind === "task_assigned" && /Jordan assigned you: Prepare the strategy brief/.test(jb[0].title) && jb[0].href === `/projects/${project.id}#brief`, jb.map((b) => b.title).join(" | "));

    // ---- one canonical task ----
    const again = await A.assignTaskAction({ title: "Prepare the strategy brief for Real Agent", assigneeKey: "james", sourceHref: `/projects/${project.id}#brief` });
    c.ok("assigning the same record to the same person again: no second task, nothing re-sent", again.ok && /Already with James/.test(again.message) && (await tasks()) === before + 1 && (await bells(jamesTm.id)).length === 1, again.message);
    const replyTask = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Reply to Real Agent", source: "gmail", clientId: client.id, assignedKey: "kyle", status: "OPEN" } });
    const n2 = await tasks();
    const r2 = await A.assignTaskAction({ title: "Answer Real Agent's pricing question", assigneeKey: "kyle", sourceTaskId: replyTask.id });
    const t2 = await prisma.smartTask.findUnique({ where: { id: replyTask.id } });
    c.ok("assigning FROM an existing record's task puts the delegation on that task: no copy", r2.ok && (await tasks()) === n2 && !!t2?.delegatedAt && t2.assignedKey === "kyle" && t2.title === "Reply to Real Agent", r2.message);
    const free1 = await A.assignTaskAction({ title: "Order more SD cards", assigneeKey: "kyle" });
    const n3 = await tasks();
    const free2 = await A.assignTaskAction({ title: "Order more SD cards", assigneeKey: "kyle" });
    c.ok("a free-form task pressed twice is one task", free1.ok && free2.ok && (await tasks()) === n3 && /Already/.test(free2.message), free2.message);

    // =====================================================================
    c.head("§2 · the same task in Jordan's oversight and in James's queue (#1)");
    // =====================================================================
    const sameState = async (want: string) => {
      const mine = (await lib.tasksDelegatedBy("info@realtourpilot.com")).find((d) => d.taskId === t1!.id);
      const theirs = (await lib.tasksAssignedTo("james")).find((d) => d.taskId === t1!.id);
      const dash = (await delegatedByMe({ email: "info@realtourpilot.com" })).rows.find((d) => d.taskId === t1!.id);
      return { ok: !!mine && !!theirs && !!dash && mine.state === want && theirs.state === want && dash.state === want && mine.latestUpdate === theirs.latestUpdate && mine.latestUpdate === dash.latestUpdate, mine, theirs };
    };
    let s = await sameState("ASSIGNED");
    c.ok("#1 both read Awaiting acceptance (assigned is not accepted)", s.ok, `${s.mine?.state}/${s.theirs?.state}`);
    await signIn(james);
    const acc = await A.acceptTaskAction(t1!.id);
    s = await sameState("ACCEPTED");
    c.ok("#1 James accepts on his side: Jordan's view says Accepted too", acc.ok && s.ok, `${acc.message} ${s.mine?.state}/${s.theirs?.state}`);
    const upd = await A.updateTaskAction(t1!.id, "Pulled last month's notes, drafting now");
    s = await sameState("IN_PROGRESS");
    c.ok("#1 his update starts it and is the latest update on both screens, word for word", upd.ok && s.ok && s.mine?.latestUpdate === "James: Pulled last month's notes, drafting now", `${s.mine?.state} · ${s.mine?.latestUpdate} | ${s.theirs?.latestUpdate}`);
    const jordanBells = await bells(jordanTm.id);
    c.ok("…and Jordan hears about it (his bell: accepted, then the update)", jordanBells.some((b) => /James accepted/.test(b.title)) && jordanBells.some((b) => /James: Pulled/.test(b.title)), jordanBells.map((b) => b.title).join(" | "));

    // ---- verification only when asked ----
    const early = await A.completeTaskAction(t1!.id, "done");
    c.ok("a task that needs verification can't be completed by the assignee: he submits it", !early.ok && /Submit for verification/.test(early.message), early.message);
    const sub = await A.submitForVerificationAction(t1!.id, "Brief in the client folder");
    s = await sameState("READY_FOR_VERIFICATION");
    c.ok("submitted: Ready for verification on both sides (not complete)", sub.ok && s.ok, sub.message);
    await signIn(owner);
    const back = await A.returnForChangesAction(t1!.id, "Add the topic shortlist");
    s = await sameState("IN_PROGRESS");
    c.ok("Jordan sends it back: in progress again, with his reason as the latest update", back.ok && s.ok && /Sent back: Add the topic shortlist/.test(s.mine?.latestUpdate ?? ""), s.mine?.latestUpdate ?? "");
    await signIn(james);
    await A.submitForVerificationAction(t1!.id, "Shortlist added");
    await signIn(owner);
    const ver = await A.completeTaskAction(t1!.id, "Read it, good");
    const done1 = (await lib.tasksDelegatedBy("info@realtourpilot.com")).find((d) => d.taskId === t1!.id);
    c.ok("Jordan verifies: Completed, evidence kept, and it leaves James's open list", ver.ok && /Verified/.test(ver.message) && done1?.state === "COMPLETED" && done1.evidence === "Read it, good" && !(await lib.tasksAssignedTo("james")).some((d) => d.taskId === t1!.id), ver.message);
    const kinds = done1?.events.map((e) => e.kind).join(",");
    c.ok("every state change is on its history, with who and when", kinds === "assigned,accepted,started,update,submitted,returned,submitted,completed" && done1!.events.every((e) => !!e.at && !!e.by), kinds);
    const noVerify = await prisma.smartTask.findFirst({ where: { title: "Order more SD cards" } });
    await signIn(kyle);
    const subNo = await A.submitForVerificationAction(noVerify!.id);
    const doneNo = await A.completeTaskAction(noVerify!.id, "Ordered 4");
    c.ok("verification happens only when the task asks for it: Kyle completes his own directly", !subNo.ok && doneNo.ok && (await prisma.smartTask.findUnique({ where: { id: noVerify!.id } }))?.status === "COMPLETED", `${subNo.message} / ${doneNo.message}`);

    // =====================================================================
    c.head("§3 · missed acceptance and overdue work come back to Jordan (#3)");
    // =====================================================================
    await signIn(owner);
    const late = await A.assignTaskAction({ title: "Call the stager about 5 Birch Ln", assigneeKey: "kyle", dueAt: new Date(T.getTime() + 6 * H).toISOString() });
    const lateTask = await prisma.smartTask.findFirst({ where: { title: "Call the stager about 5 Birch Ln" } });
    const later = new Date(T.getTime() + 2 * D);
    const flagged = (await delegatedByMe({ email: "info@realtourpilot.com", now: later })).rows.find((r) => r.taskId === lateTask!.id);
    c.ok("#3 past its due time and never accepted: flagged at the top of Delegated by me", late.ok && flagged?.resurface?.kind === "overdue" && (await delegatedByMe({ email: "info@realtourpilot.com", now: later })).rows[0].taskId === lateTask!.id, `${flagged?.resurface?.kind}`);
    const notAcc = await A.assignTaskAction({ title: "Book the drone permit", assigneeKey: "kyle" });
    const notAccTask = await prisma.smartTask.findFirst({ where: { title: "Book the drone permit" } });
    const rec = lib.parseDelegation(notAccTask!.delegation)!;
    const pastAccept = new Date(Date.parse(rec.acceptBy!) + H);
    const view = (await lib.delegationFor([notAccTask!.id])).get(notAccTask!.id)!;
    c.ok("#3 not accepted by the end of the next business day: 'Not accepted yet'", notAcc.ok && lib.resurfaceOf(view, pastAccept)?.kind === "not_accepted" && lib.resurfaceOf(view, T) === null, lib.resurfaceOf(view, pastAccept)?.words ?? "none");
    const bellsBefore = (await bells(jordanTm.id)).length;
    const sweep1 = await lib.resurfaceDelegations(pastAccept);
    const sweep2 = await lib.resurfaceDelegations(pastAccept);
    const after = await bells(jordanTm.id);
    c.ok("#3 the hourly sweep rings Jordan once per task per reason per day (a second run adds nothing)", sweep1.rang >= 2 && after.length === bellsBefore + sweep1.rang && after.filter((b) => b.kind === "delegation_followup").length === sweep1.rang && sweep2.rang === sweep1.rang, `${sweep1.rang}/${sweep2.rang} rows ${after.length - bellsBefore}`);
    c.ok("…the bells name the task and the person", after.some((b) => b.title === "Not accepted: Book the drone permit" && /Kyle/.test(b.body ?? "")) && after.some((b) => b.title === "Overdue: Call the stager about 5 Birch Ln"), after.slice(bellsBefore).map((b) => `${b.title} (${b.body})`).join(" | "));
    await signIn(kyle);
    const blk = await A.flagBlockerAction(notAccTask!.id, "The FAA portal is down");
    const blocked = (await lib.tasksAssignedTo("kyle")).find((d) => d.taskId === notAccTask!.id);
    const blockedMine = (await lib.tasksDelegatedBy("info@realtourpilot.com")).find((d) => d.taskId === notAccTask!.id);
    c.ok("a blocker: Blocked with the reason on both sides; the next step is Jordan's", blk.ok && blocked?.state === "BLOCKED" && blocked.blocker === "The FAA portal is down" && blockedMine?.blocker === "The FAA portal is down" && /Jordan to clear/.test(blockedMine.nextStep ?? ""), blockedMine?.nextStep ?? "");
    const pastFollow = new Date(Date.parse(lib.parseDelegation((await prisma.smartTask.findUnique({ where: { id: notAccTask!.id } }))!.delegation)!.followUpAt!) + H);
    c.ok("#3 …and still blocked past its follow-up, it comes back to Jordan", lib.resurfaceOf(blockedMine!, pastFollow)?.kind === "blocked");

    // =====================================================================
    c.head("§4 · reassignment keeps the history and changes the owner");
    // =====================================================================
    await signIn(owner);
    const re = await A.reassignTaskAction(lateTask!.id, "james");
    const moved = (await lib.delegationFor([lateTask!.id])).get(lateTask!.id)!;
    c.ok("moved to James: his now, awaiting HIS acceptance, gone from Kyle's list", re.ok && moved.assigneeKey === "james" && moved.state === "ASSIGNED" && (await lib.tasksAssignedTo("james")).some((d) => d.taskId === lateTask!.id) && !(await lib.tasksAssignedTo("kyle")).some((d) => d.taskId === lateTask!.id), re.message);
    c.ok("…the history keeps both: assigned to Kyle, then moved from Kyle to James", moved.events.map((e) => `${e.kind}:${e.to ?? ""}`).join(",") === "assigned:Kyle,reassigned:James" && moved.events[1].from === "Kyle");
    const kb = await bells(kyleTm.id);
    c.ok("…James is told it's his; Kyle is told it moved", (await bells(jamesTm.id)).some((b) => /Call the stager/.test(b.title) && b.kind === "task_assigned") && kb.some((b) => /Moved to James: Call the stager/.test(b.title)));

    // =====================================================================
    c.head("§5 · the role rules (#14)");
    // =====================================================================
    await signIn(james);
    const nRec = await tasks();
    const recm = await A.assignTaskAction({ title: "Reshoot the twilight exteriors at 9 Elm", assigneeKey: "harrison" });
    const recTask = await prisma.smartTask.findFirst({ where: { title: "Reshoot the twilight exteriors at 9 Elm" } });
    const recView = (await lib.delegationFor([recTask!.id])).get(recTask!.id)!;
    c.ok("#14 the creative manager naming Harrison is a RECOMMENDATION: the task goes to Jordan, never to Harrison", recm.ok && /recommendation/i.test(recm.message) && (await tasks()) === nRec + 1 && recTask!.assignedKey === "jordan" && recView.recommendedTo === "Harrison" && !(await lib.tasksAssignedTo("harrison")).length, recm.message);
    c.ok("…and Jordan sees it as a decision (Recommended for Harrison: your decision)", lib.resurfaceOf(recView, T)?.kind === "recommended" && (await bells(jordanTm.id)).some((b) => /James recommends Harrison/.test(b.title)));
    const self = await A.assignTaskAction({ title: "Update the twilight shot list", assigneeKey: "james" });
    c.ok("#14 …he can put work on himself", self.ok && !!(await prisma.smartTask.findFirst({ where: { title: "Update the twilight shot list", assignedKey: "james" } })), self.message);
    const notHis = await A.acceptTaskAction(replyTask.id);
    c.ok("#14 …and can't accept a task that is Kyle's", !notHis.ok, notHis.message);
    const esc = await A.escalateTaskAction(lateTask!.id, "The stager wants a deposit decision");
    const escView = (await lib.delegationFor([lateTask!.id])).get(lateTask!.id)!;
    c.ok("an escalation goes to Jordan and stays with its assignee until he decides", esc.ok && escView.assigneeKey === "james" && lib.resurfaceOf(escView, T)?.kind === "escalated" && (await bells(jordanTm.id)).some((b) => /Escalated by James/.test(b.title)), esc.message);
    // AUDIT, Oct 23 2026. A decision James sends UP to Jordan (readiness,
    // practice for an editor, a process approval, a cut decision) is Jordan's
    // to decide, never "a recommendation for Jordan" (his dashboard read
    // "Recommended for Jordan Spackman" and "Assign to Jordan" did nothing).
    const up = await A.assignTaskAction({ title: "Decide on a second shooter for Saturday", assigneeKey: "jordan", note: "Two premium jobs overlap" });
    const upTask = await prisma.smartTask.findFirst({ where: { title: "Decide on a second shooter for Saturday" } });
    const upView = (await lib.delegationFor([upTask!.id])).get(upTask!.id)!;
    c.ok("#14 the creative manager naming Jordan sends him the decision: on his plate, an escalation with James's reason, no recommendation of Jordan", up.ok && /to decide/.test(up.message) && upTask!.assignedKey === "jordan" && upView.recommendedTo === null && upView.escalatedWhy === "Two premium jobs overlap" && lib.resurfaceOf(upView, T)?.kind === "escalated" && (await bells(jordanTm.id)).some((b) => b.title === "James needs your decision: Decide on a second shooter for Saturday"), `${up.message} rec=${upView.recommendedTo} esc=${upView.escalatedWhy}`);
    // He acts on his own tasks only (requireTaskAccess): someone else's work is not his to take.
    await signIn(owner);
    await A.assignTaskAction({ title: "Confirm the Saturday lockbox", assigneeKey: "kyle" });
    const kyleTask = await prisma.smartTask.findFirst({ where: { title: "Confirm the Saturday lockbox" } });
    const kylePlain = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Reply to the stager", source: "gmail", assignedKey: "kyle", status: "OPEN" } });
    await signIn(james);
    const take = await A.reassignTaskAction(kyleTask!.id, "james");
    const takeView = (await lib.delegationFor([kyleTask!.id])).get(kyleTask!.id)!;
    c.ok("#14 …moving a task Jordan gave Kyle onto himself is a recommendation Jordan decides: it stays Kyle's", take.ok && /Recommendation/.test(take.message) && takeView.assigneeKey === "kyle" && takeView.recommendedTo === "James", `${take.message} ${takeView.assigneeKey}`);
    const grab = await A.assignTaskAction({ title: "Reply to the stager", assigneeKey: "james", sourceTaskId: kylePlain.id });
    c.ok("#14 …and putting a delegation on a task Kyle holds is refused: nothing moves", !grab.ok && /Kyle/.test(grab.message) && (await prisma.smartTask.findUnique({ where: { id: kylePlain.id } }))?.assignedKey === "kyle" && !(await prisma.smartTask.findUnique({ where: { id: kylePlain.id } }))?.delegatedAt, grab.message);
    // Practice for a field creative (the coaching action passes the trainee; the assign action never does).
    const { getCurrentUser } = await import("@/lib/auth/user");
    const jamesActor = await lib.actorFor((await getCurrentUser())!);
    const practice = await lib.assignTask(jamesActor, { title: "Practice: level the drone before every orbit", assigneeKey: "harrison" }, { traineeKey: "harrison" });
    const practiceRow = await prisma.smartTask.findFirst({ where: { title: "Practice: level the drone before every orbit" } });
    c.ok("#14 …practice for the field creative he coaches goes to that creative directly (the coaching action names him)", practice.ok && practiceRow?.assignedKey === "harrison" && practiceRow.delegatedBy === james.email && (await lib.tasksAssignedTo("harrison")).some((d) => d.taskId === practiceRow.id), practice.message);
    // A delegated task that NEEDS verification, closed from a generic list
    // (My Shoots' Done is a photographer's only control: setSmartTaskStatus).
    // For its assignee that is a submission, never Completed; the owner's
    // Done is the verification.
    await signIn(owner);
    await A.assignTaskAction({ title: "Re-shoot the twilight drone orbit", assigneeKey: "harrison", needsVerification: true });
    const verifyRow = await prisma.smartTask.findFirst({ where: { title: "Re-shoot the twilight drone orbit" } });
    const { setSmartTaskStatus } = await import("@/app/actions");
    const { listPhotographerTasks } = await import("@/lib/shoot");
    await signIn(harrison);
    const hDone = await setSmartTaskStatus(verifyRow!.id, "COMPLETED");
    const afterH = await prisma.smartTask.findUnique({ where: { id: verifyRow!.id } });
    c.ok("verification holds on every list: Harrison's Done on My Shoots submits it (Ready for verification), and it leaves his list", !!hDone?.ok && /Submitted/.test(hDone.message) && afterH?.status === "WAITING_VERIFICATION" && !afterH.completedAt && !(await listPhotographerTasks(harrisonTm.id)).some((t) => t.id === verifyRow!.id), `${hDone?.message} ${afterH?.status}`);
    await signIn(owner);
    const oDone = await setSmartTaskStatus(verifyRow!.id, "COMPLETED");
    const afterO = (await lib.delegationFor([verifyRow!.id])).get(verifyRow!.id)!;
    c.ok("…the owner's Done on the same task is the verification: Completed, on its history", !!oDone?.ok && afterO.state === "COMPLETED" && afterO.events.some((e) => e.kind === "completed" && /Verified/.test(e.text ?? "")), `${oDone?.message} ${afterO.state}`);
    await signIn(james);
    await signIn(harrison);
    const ph = await A.assignTaskAction({ title: "Have Kyle call the client", assigneeKey: "kyle" });
    c.ok("#14 a photographer can't assign work", !ph.ok && /can't assign/.test(ph.message), ph.message);
    await signIn(owner);
    await A.assignTaskAction({ title: "Re-upload the 9 Elm raws", assigneeKey: "harrison" });
    const hTask = await prisma.smartTask.findFirst({ where: { title: "Re-upload the 9 Elm raws" } });
    await signIn(harrison);
    const handOn = await A.reassignTaskAction(hTask!.id, "kyle");
    const handBack = await A.reassignTaskAction(hTask!.id, "jordan");
    c.ok("#14 a photographer holding a task may hand it back to whoever assigned it, not on to someone else", !handOn.ok && handBack.ok && (await prisma.smartTask.findUnique({ where: { id: hTask!.id } }))?.assignedKey === "jordan", `${handOn.message} / ${handBack.message}`);
    await signIn(kyle);
    const kyleMoves = await A.reassignTaskAction(replyTask.id, "james");
    c.ok("#14 the office (admin) may move work to anyone", kyleMoves.ok && (await prisma.smartTask.findUnique({ where: { id: replyTask.id } }))?.assignedKey === "james", kyleMoves.message);
    // The owner's read-only preview.
    await signIn(owner, james.id);
    const n4 = await tasks();
    const p1 = await A.assignTaskAction({ title: "Preview write", assigneeKey: "kyle" });
    const p2 = await A.acceptTaskAction(lateTask!.id);
    const p3 = await A.completeTaskAction(notAccTask!.id, "x");
    c.ok("#14 'view as James' is read-only: every action refuses and nothing is written", !p1.ok && !p2.ok && !p3.ok && /previewing/i.test(p1.message) && (await tasks()) === n4 && (await lib.delegationFor([lateTask!.id])).get(lateTask!.id)!.state === "ASSIGNED", p1.message);

    // =====================================================================
    c.head("§6 · My Day's 'Create task for Kyle' is a thin wrapper");
    // =====================================================================
    await signIn(owner);
    const day = await import("@/app/day/actions");
    const n5 = await tasks();
    const k1 = await day.createTaskForKyle({ title: "Confirm Tuesday's reshoot", detail: "The client said 10 AM", dueDate: dueKey });
    const k2 = await day.createTaskForKyle({ title: "Confirm Tuesday's reshoot", detail: "The client said 10 AM", dueDate: dueKey });
    const kt = k1.id ? (await lib.delegationFor([k1.id])).get(k1.id) : undefined;
    c.ok("one delegated task on Kyle's key (a second press is the same task), outcome and due carried", k1.ok && k2.ok && k1.id === k2.id && (await tasks()) === n5 + 1 && kt?.assigneeKey === "kyle" && kt.assignedBy === "Jordan" && kt.outcome === "The client said 10 AM" && !!kt.dueAt, JSON.stringify(k1));
    c.ok("…it is Kyle's open assignment and Jordan's delegated one", (await lib.tasksAssignedTo("kyle")).some((d) => d.taskId === k1.id) && (await lib.tasksDelegatedBy("info@realtourpilot.com")).some((d) => d.taskId === k1.id));
    c.ok("…Kyle is told through his bell", (await bells(kyleTm.id)).some((b) => /Jordan assigned you: Confirm Tuesday's reshoot/.test(b.title)));

    // ---- the owner's second login is still him ----
    const ownerAlt = await user("Jordan Spackman", "jordan.personal@deleg.invalid", "OWNER", jordanTm.id);
    await signIn(ownerAlt);
    const alt = await A.assignTaskAction({ title: "Send the stager the floor plan", assigneeKey: "kyle" });
    const both = await delegatedByMe({ email: "info@realtourpilot.com", emails: ["info@realtourpilot.com", "jordan.personal@deleg.invalid"] });
    c.ok("Delegated by me reads every login the owner signs in with (info@ and his personal address)", alt.ok && both.rows.some((r) => r.title === "Send the stager the floor plan") && both.rows.some((r) => r.title === "Confirm Tuesday's reshoot"), alt.message);

    // ---- house rules ----
    const allWords = JSON.stringify(await prisma.notification.findMany({ select: { title: true, body: true } }));
    c.ok("no em dashes in anything delegation wrote", !/—/.test(allWords) && !/—/.test(JSON.stringify((await prisma.smartTask.findMany({ where: { delegatedAt: { not: null } }, select: { delegation: true } })).map((t) => t.delegation))));
    c.ok("nothing left the box but faked Slack calls", fence.blocked.length === 0 && fence.faked.every((u) => u.startsWith("https://slack.com/api/")), fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
