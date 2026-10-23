// ---------------------------------------------------------------------------
// DRILL SECTION: comms audit H4 (a holding reply is not an answer; open
// scheduling asks stay visible) and the two LOW items (the upload chaser's
// payroll words; a "client chasing" task closes on delivery). Oct 22 2026.
//
// Run by scripts/_drill/oct22-comms-audit-fixes.ts after it boots PGlite,
// installs the next/* stubs and fences the network. Every app module is
// imported dynamically here; every fixture is this section's own ("H4 Drill
// ..." names), so it reads only its own rows out of shared surfaces.
// ---------------------------------------------------------------------------
import type { Checker } from "../_harness";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export async function run(c: Checker): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const H = await import("@/lib/holdingReply");
  const { unansweredComms, openObligations } = await import("@/lib/replyQueue");
  const { unansweredCommsBoard } = await import("@/lib/commsBoard");
  const { pagerView } = await import("@/lib/commsSla");
  const { closeReplyForOutbound } = await import("@/lib/tasks");

  // =========================================================================
  c.head("H4 · a holding reply is not an answer: the detector and the due time (pure)");
  // =========================================================================
  const holds = [
    "Let me check other options to do it sooner, I'll confirm soon",
    "Let me check on this and I'll let you know!",
    "Got it lemme check",
    "Will get back to you shortly",
    "Let me find out and circle back",
    "I'm checking with him",
    "Got it, I'll let you know once it's confirmed for tomorrow",
    "Checking on that now",
  ];
  const answers = [
    "Thanks, all set",
    "You're confirmed for Thursday at 9",
    "Let me know if you have any questions",
    "Does Tuesday morning work?",
    "I'll let you know if anything changes",
    "You're all set for Thursday at 9! I'll let you know when James is on the way.",
  ];
  const missed = holds.filter((t) => !H.isHoldingReply(t));
  const wrong = answers.filter((t) => H.isHoldingReply(t));
  c.ok("holding lines read as holding ('I'll confirm soon', 'let me check', 'will get back to you', 'lemme check', ...)", missed.length === 0, missed.join(" | "));
  c.ok("answers do not ('Thanks, all set', 'You're confirmed for Thursday at 9', 'Let me know if you have any questions', 'I'll let you know if anything changes')", wrong.length === 0, wrong.join(" | "));
  const due = (iso: string) => H.holdingReplyDueAt(new Date(iso)).toISOString();
  c.ok("due two hours later inside the business day (Kyle's 10:27 AM 'I'll confirm soon' is due 12:27 PM ET)", due("2026-10-22T14:27:29.000Z") === "2026-10-22T16:27:29.000Z", due("2026-10-22T14:27:29.000Z"));
  c.ok("…no later than 6 PM ET (5:00 PM is due 6:00 PM)", due("2026-10-22T21:00:00.000Z") === "2026-10-22T22:00:00.000Z", due("2026-10-22T21:00:00.000Z"));
  c.ok("…after 5:30 PM: 11 AM ET the next business day (Thu 5:40 PM is due Fri 11 AM)", due("2026-10-22T21:40:00.000Z") === "2026-10-23T15:00:00.000Z", due("2026-10-22T21:40:00.000Z"));
  c.ok("…a weekend line: 11 AM ET Monday", due("2026-10-24T15:00:00.000Z") === "2026-10-26T15:00:00.000Z", due("2026-10-24T15:00:00.000Z"));

  // ---- fixtures ----
  const now = new Date();
  const mkClient = (name: string, phone: string) => prisma.client.create({ data: { name, phone }, select: { id: true, name: true } });
  const text = (o: { clientId: string; dir: "in" | "out"; body: string; at: Date; phone: string; name: string }) =>
    prisma.commLog.create({
      data: {
        channel: "text", direction: o.dir, clientId: o.clientId, clientName: o.dir === "in" ? o.name : null,
        contactName: o.dir === "in" ? o.name : "Us", fromPhone: o.phone, body: o.body, occurredAt: o.at, source: "openphone",
      },
    });
  const replyTask = (o: { clientId: string; at: Date; key: string; status?: string; completedAt?: Date | null; projectId?: string | null }) =>
    prisma.smartTask.create({
      data: {
        taskType: "client_reply", title: "Reply to the latest message", source: "openphone", priority: "HIGH",
        clientId: o.clientId, dedupeKey: o.key, createdAt: o.at, dueAt: new Date(o.at.getTime() + 4 * HOUR),
        status: o.status ?? "OPEN", completedAt: o.completedAt ?? null, projectId: o.projectId ?? null,
      },
      select: { id: true },
    });
  const threadOf = async (clientId: string, opts: { owed?: boolean } = {}) =>
    (await unansweredComms({ now: new Date(), includeOwed: opts.owed ?? false, includeTeam: false, includeUnmatched: false })).filter((t) => t.clientId === clientId);

  // =========================================================================
  c.head("H4 · Nehemiah's shape: 'I'll confirm soon' keeps the thread waiting on us, with a due time");
  // =========================================================================
  const N = await mkClient("H4 Drill Nehemiah", "(484) 555-0111");
  const NP = "4845550111";
  const t0 = new Date(now.getTime() - 3 * HOUR);
  await text({ clientId: N.id, dir: "in", body: "5 Endlich Ave reading pa 19606", at: t0, phone: NP, name: N.name });
  await text({ clientId: N.id, dir: "out", body: "Does Tuesday morning work?", at: new Date(t0.getTime() + 3 * 60_000), phone: NP, name: N.name });
  await text({ clientId: N.id, dir: "in", body: "can we do sooner", at: new Date(t0.getTime() + 4 * 60_000), phone: NP, name: N.name });
  await text({ clientId: N.id, dir: "in", body: "Or if we do the 550 deal", at: new Date(t0.getTime() + 4 * 60_000 + 10_000), phone: NP, name: N.name });
  const holdAt = new Date(t0.getTime() + 5 * 60_000);
  await text({ clientId: N.id, dir: "out", body: "Let me check other options to do it sooner, I'll confirm soon", at: holdAt, phone: NP, name: N.name });
  // The live row: the OpenPhone receiver closed his reply task 47 ms after the holding line.
  await replyTask({ clientId: N.id, at: new Date(t0.getTime() - DAY), key: "h4-drill-neh-reply", status: "COMPLETED", completedAt: new Date(holdAt.getTime() + 47) });
  let nt = await threadOf(N.id);
  const nh = nt[0]?.holding ?? null;
  c.ok("on the queue (waiting on us), with both of his messages still owed", nt.length === 1 && nt[0].pending.length === 2 && nt[0].pending[0].body === "can we do sooner", JSON.stringify(nt.map((t) => ({ key: t.key, pending: t.pending.map((m) => m.body) }))));
  c.ok("…the holding line and its due time ride on the card", !!nh && /I'll confirm soon/.test(nh.text) && nh.dueAt.getTime() === H.holdingReplyDueAt(holdAt).getTime(), JSON.stringify(nh));
  c.ok("…the reply task the holding line closed 47 ms later does not cut the thread", nt.length === 1);
  const board = (await unansweredCommsBoard("phone", new Date())).find((g) => g.clientId === N.id);
  c.ok("the Messages board row carries it too (what we said, when it is due, overdue or not)", !!board?.holding && board.holding.dueISO === H.holdingReplyDueAt(holdAt).toISOString() && board.holding.overdue === H.holdingReplyDueAt(holdAt).getTime() <= Date.now(), JSON.stringify(board?.holding));
  await text({ clientId: N.id, dir: "out", body: "We can do Saturday at 10 AM, does that work?", at: new Date(holdAt.getTime() + 30 * 60_000), phone: NP, name: N.name });
  nt = await threadOf(N.id);
  c.ok("a real answer after it clears the thread", nt.length === 0, JSON.stringify(nt.map((t) => t.key)));

  // =========================================================================
  c.head("H4 · the reply task stays open on a holding line, closes on an answer");
  // =========================================================================
  const K = await mkClient("H4 Drill Kendra", "(484) 555-0122");
  const kTask = await replyTask({ clientId: K.id, at: new Date(now.getTime() - HOUR), key: "h4-drill-kendra-reply" });
  const closedOnHold = await closeReplyForOutbound(K.id, "Let me check with the photographer and I'll get back to you");
  const kAfterHold = await prisma.smartTask.findUniqueOrThrow({ where: { id: kTask.id }, select: { status: true } });
  c.ok("'Let me check ... I'll get back to you' leaves it open", !closedOnHold && kAfterHold.status === "OPEN", `${closedOnHold} ${kAfterHold.status}`);
  const closedOnAnswer = await closeReplyForOutbound(K.id, "Thursday at 9 works, you're booked");
  const kAfter = await prisma.smartTask.findUniqueOrThrow({ where: { id: kTask.id }, select: { status: true } });
  c.ok("'Thursday at 9 works, you're booked' closes it", closedOnAnswer && kAfter.status === "COMPLETED", `${closedOnAnswer} ${kAfter.status}`);

  // =========================================================================
  c.head("H4 · Jeff's shape: an open request from 10 days ago, last word 'I'll let you know'");
  // =========================================================================
  const J = await mkClient("H4 Drill Jeff", "(610) 555-0133");
  const JP = "6105550133";
  const j0 = new Date(now.getTime() - 10 * DAY);
  await text({ clientId: J.id, dir: "in", body: "When I make it a reel the sound is half a second behind. Any suggestions?", at: j0, phone: JP, name: J.name });
  const jHold = new Date(j0.getTime() + 20_000);
  await text({ clientId: J.id, dir: "out", body: "Let me check on this and I'll let you know!", at: jHold, phone: JP, name: J.name });
  await text({ clientId: J.id, dir: "in", body: "Ok thank you", at: new Date(jHold.getTime() + 10_000), phone: JP, name: J.name });
  const jTask = await replyTask({ clientId: J.id, at: new Date(j0.getTime() - 20 * DAY), key: "h4-drill-jeff-reply" });
  const ob = (await openObligations({ now: new Date() })).filter((o) => o.clientId === J.id);
  c.ok("the ledger keeps his open request owed (it read 'I'll let you know' as the answer)", ob.length === 1 && ob[0].taskId === jTask.id && !!ob[0].holding && ob[0].holding.at.getTime() === jHold.getTime(), JSON.stringify(ob.map((o) => ({ task: o.taskId, holding: o.holding }))));
  const jt = await threadOf(J.id, { owed: true });
  c.ok("…and the board shows him waiting on us, the promise overdue", jt.length === 1 && !!jt[0].holding && jt[0].holding.dueAt.getTime() < Date.now(), JSON.stringify(jt.map((t) => ({ key: t.key, holding: t.holding, ledger: t.fromLedger }))));
  // The pager: before due → held back; after → counted from the due time; past its week → listed, not paged.
  const base = { clientId: "x", clientName: "x", clientAvatarUrl: null, snippet: "x", isVip: false, unhappy: false, family: "phone" as const, channel: "text" as const, threadKey: "c:x", groupKey: "x", inboxes: [] };
  const t = new Date("2026-10-22T18:00:00Z");
  const view = pagerView([
    { ...base, threadKey: "c:early", occurredAt: new Date(t.getTime() - 5 * HOUR), ageMin: 300, holdingDueAt: new Date(t.getTime() + HOUR) },
    { ...base, threadKey: "c:due", occurredAt: new Date(t.getTime() - 5 * HOUR), ageMin: 300, holdingDueAt: new Date(t.getTime() - 40 * 60_000) },
    { ...base, threadKey: "c:old", occurredAt: new Date(t.getTime() - 11 * DAY), ageMin: 11 * 1440, holdingDueAt: new Date(t.getTime() - 10 * DAY) },
    { ...base, threadKey: "c:plain", occurredAt: new Date(t.getTime() - HOUR), ageMin: 60, holdingDueAt: null },
  ], t);
  c.ok("the pager waits for the due time, then counts from it; a promise overdue past its week is listed, not paged", view.map((v) => `${v.threadKey}:${v.ageMin}`).join(",") === "c:due:40,c:plain:60", view.map((v) => `${v.threadKey}:${v.ageMin}`).join(","));

  // =========================================================================
  c.head("H4 · an open scheduling ask stays visible after a reply");
  // =========================================================================
  const S = await mkClient("H4 Drill Sasha", "(484) 555-0144");
  const SP = "4845550144";
  const s0 = new Date(now.getTime() - 2 * HOUR);
  await text({ clientId: S.id, dir: "in", body: "Can we book a premium shoot at 9 Drill Ln this week?", at: s0, phone: SP, name: S.name });
  const ask = await prisma.clientAsk.create({
    data: { clientId: S.id, kind: "SCHEDULING", text: "Can we book a premium shoot at 9 Drill Ln this week?", summary: "Book a premium shoot at 9 Drill Ln this week", source: "text", askedAt: s0, state: "OPEN" },
    select: { id: true },
  });
  await text({ clientId: S.id, dir: "out", body: "Sure, what day works best for you?", at: new Date(s0.getTime() + 60_000), phone: SP, name: S.name });
  c.ok("the reply answered the text: not on the pager's read", (await threadOf(S.id)).length === 0);
  const st = await threadOf(S.id, { owed: true });
  c.ok("…but the work lists keep her, for the open scheduling ask", st.length === 1 && !!st[0].fromAsk && (st[0].schedulingAsks ?? []).some((a) => a.id === ask.id), JSON.stringify(st.map((x) => ({ key: x.key, fromAsk: x.fromAsk, asks: x.schedulingAsks }))));
  const W = await mkClient("H4 Drill Wren", "(484) 555-0166");
  const w0 = new Date(now.getTime() - 90 * 60_000);
  await text({ clientId: W.id, dir: "in", body: "Can you move my Friday shoot to Monday?", at: w0, phone: "4845550166", name: W.name });
  const wAsk = await prisma.clientAsk.create({
    data: { clientId: W.id, kind: "SCHEDULING", text: "Can you move my Friday shoot to Monday?", summary: "Move Friday's shoot to Monday", source: "text", askedAt: w0, state: "OPEN" },
    select: { id: true },
  });
  const wt = await threadOf(W.id, { owed: true });
  c.ok("a card already waiting carries the client's open scheduling asks (no second row)", wt.length === 1 && !wt[0].fromAsk && (wt[0].schedulingAsks ?? []).some((a) => a.id === wAsk.id && a.summary === "Move Friday's shoot to Monday"), JSON.stringify(wt.map((x) => ({ key: x.key, fromAsk: x.fromAsk, asks: x.schedulingAsks }))));
  const wBoard = (await unansweredCommsBoard("phone", new Date())).find((g) => g.clientId === W.id);
  c.ok("…and the Messages board row lists it", !!wBoard && wBoard.schedulingAsks.includes("Move Friday's shoot to Monday") && !wBoard.fromAsk, JSON.stringify(wBoard?.schedulingAsks));
  const { threadAckKey, ackValue } = await import("@/lib/replyQueue");
  await prisma.appSetting.create({ data: { key: threadAckKey("phone", `c:${S.id}`), value: ackValue(new Date(), "answered elsewhere") } });
  c.ok("a person's Handled tick after the ask takes the row off (the ask itself stays open on Scheduling)", (await threadOf(S.id, { owed: true })).length === 0 && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: ask.id }, select: { state: true } })).state === "OPEN");

  // =========================================================================
  c.head("LOW · the upload chaser no longer mentions payroll");
  // =========================================================================
  const { nagText } = await import("@/lib/uploadDigest");
  const { DEFAULT_TEXTS } = await import("@/lib/textTemplates");
  const nag = nagText("Harrison", ["123 Main St"]);
  c.ok("the 10 PM chaser has no payroll words and no em dash", !/payroll/i.test(nag) && !/—/.test(nag) && /Still waiting on today's upload page/.test(nag) && /submit the page/.test(nag), nag);
  c.ok("…nor does the default template it is built from", !/payroll/i.test(DEFAULT_TEXTS.render("upload_chaser_shoots", { pages: "page", shootList: "1. 1 Main St", uploadLink: "https://drill.invalid/upload" })));

  // =========================================================================
  c.head("LOW · a 'client chasing' task closes when its job is delivered");
  // =========================================================================
  const { closeChasesOnDeliveredJobs, CHASE_TASK_TYPE, chaseScope } = await import("@/lib/chaseCounter");
  const B = await mkClient("H4 Drill Bob", "(215) 555-0155");
  const delivered = new Date(now.getTime() - 6 * HOUR);
  const mkJob = (title: string, status: "DELIVERED" | "EDITING", deliveredAt: Date | null) => prisma.project.create({ data: { title, clientId: B.id, status, deliveredAt }, select: { id: true } });
  const chaseTask = (projectId: string, at: Date) =>
    prisma.smartTask.create({
      data: { taskType: CHASE_TASK_TYPE, title: "H4 Drill Bob has asked for an update 2 times", source: "system", priority: "HIGH", status: "OPEN", clientId: B.id, projectId, createdAt: at, dedupeKey: `chase:${B.id}:${projectId}:h4-${at.getTime()}` },
      select: { id: true },
    });
  const chased = (projectId: string, at: Date, n: string) =>
    prisma.appSetting.create({ data: { key: `${chaseScope(B.id, projectId)}${n}`, value: JSON.stringify({ at: at.toISOString(), snippet: "any update?", source: "text" }) } });
  const bridle = await mkJob("1680 H4 Drill Path, Lansdale, PA", "DELIVERED", delivered);
  await chased(bridle.id, new Date(delivered.getTime() - 9 * HOUR), "a");
  await chased(bridle.id, new Date(delivered.getTime() - 8 * HOUR), "b");
  const bTask = await chaseTask(bridle.id, new Date(delivered.getTime() - 8 * HOUR));
  const later = await mkJob("2 H4 Drill Ct, Lansdale, PA", "DELIVERED", delivered);
  await chased(later.id, new Date(delivered.getTime() - 3 * HOUR), "a");
  await chased(later.id, new Date(delivered.getTime() + HOUR), "b");
  const lTask = await chaseTask(later.id, new Date(delivered.getTime() + HOUR));
  const inFlight = await mkJob("3 H4 Drill Rd, Lansdale, PA", "EDITING", null);
  await chased(inFlight.id, new Date(now.getTime() - 2 * HOUR), "a");
  const fTask = await chaseTask(inFlight.id, new Date(now.getTime() - 2 * HOUR));
  const r = await closeChasesOnDeliveredJobs(now);
  const st2 = async (id: string) => (await prisma.smartTask.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  c.ok("Bob's shape (chased twice, then delivered): the task completes", r.ids.includes(bTask.id) && (await st2(bTask.id)) === "COMPLETED", JSON.stringify(r));
  c.ok("…with a line on the job saying the delivery answered it", !!(await prisma.activity.findFirst({ where: { projectId: bridle.id, body: { contains: "answered by the delivery" } } })));
  c.ok("a chase AFTER the delivery ('I never got it') stays open", (await st2(lTask.id)) === "OPEN");
  c.ok("a job not delivered yet keeps its chase task", (await st2(fTask.id)) === "OPEN");
  c.ok("a second sweep closes nothing new", (await closeChasesOnDeliveredJobs(now)).closed === 0);
}
