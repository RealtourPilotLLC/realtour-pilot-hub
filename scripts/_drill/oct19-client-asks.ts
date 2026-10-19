// ---------------------------------------------------------------------------
// DRILL: open client asks (Oct 19 2026, lib/clientAsks).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct19-client-asks.ts
//
// Jordan: "Heather needs lot lines that are correct ... if we go and approve
// it, I don't want it to deliver before Kyle was able to confirm that the lot
// lines look correct." And Kyle's screen: special requests to make sure of,
// and scheduling requests to follow up.
//
//   1. The router's new field: parsed from the model's answer in the SAME
//      call (mocked), malformed asks dropped, an invented order id refused,
//      an answer with no asks still a full decision.
//   2. Filed from a client's text (the brain stubbed at its one function):
//      Heather's "all 4 lots overlayed" on Barry Rd holds the job; the same
//      message read twice files once; a gate code is never an ask; an ask on
//      a delivered job is left to the revision machinery; a scheduling ask is
//      filed and never holds; the brain down still files a plain "cancel".
//   3. Our reply never closes an ask: the reply task closes, the ask stays.
//   4. Holds by medium: a photo ask holds the photos only; both / unclear
//      hold both; an order note never holds.
//   5. Done is refused on a holding ask; Confirmed (who + note) releases it;
//      Reopen puts it back; Not needed releases it.
//   6. The client's "never mind" in the conversation sets an ask aside.
//   7. Counts for Kyle's tiles: open, due today, behind (job promise passed,
//      48 h open; scheduling 24 h), test clients left out; the boards group by
//      job, oldest first. Oct 19 evening (Jordan's audit, "keep it simple"):
//      an order note and an Aryeo move filed before are no longer asks, so the
//      boards and tiles leave them out.
//   8. The order, the portal and Aryeo (CHANGED Oct 19 evening): an order's
//      note and add-ons are no longer filed as asks; they show on the job's
//      "Before you send" box as notes (access and logistics lines dropped). A
//      portal session request and an Aryeo move are no longer filed either
//      (the desk task and the appointment bell cover them).
//   9. Same-day photos wait for a holding photo ask; confirmed, they don't.
//  10. A text is a text: "openphone" is no longer read as a call.
//
// ISOLATION: PGlite via the shared harness; the model answered in-process.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7191);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- the brain, stubbed at its one function (section 2 on) -------------------
type Ask = { kind: "SPECIAL_REQUEST" | "SCHEDULING"; text: string; summary: string; medium: "video" | "photo" | "both" | "unclear"; projectHint: string | null };
type Decision = { actionable: boolean; projectId: string | null; title: string; detail: string; priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; mergeIntoTaskId: string | null; isRevisionRequest: boolean; flags: string[]; reason: string; taskType: "client_reply" | "todo"; asks?: Ask[] };
let nextDecision: Decision | null = null;
interceptModule(
  (r) => r === "@/lib/brain" || /[\\/]src[\\/]lib[\\/]brain(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "routeCommTask" ? async () => nextDecision : t[k]; } }),
);
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => null : t[k]; } }),
);
installNextStubs();

// ---- the model, answered in-process (section 1) ------------------------------
let routerAnswer = "";
const prompts: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? "");
    prompts.push(prompt);
    if (prompt.includes("Decide how we should handle this message")) return json({ content: [{ type: "text", text: routerAnswer }] });
    return json({ content: [{ type: "text", text: "{}" }] });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("ai", "drill-ai-key-not-real");
  const op = await import("@/lib/integrations/openphone");
  const texts: string[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_f: string, to: string, body: string) => { texts.push(`${to}: ${body}`); return { data: { id: `op-${texts.length}` } }; };
  const ca = await import("@/lib/clientAsks");

  // =========================================================================
  c.head("1 · The router's asks field (same call, model mocked)");
  // =========================================================================
  const { decideCommTask, parseBrainAsks } = await import("@/lib/integrations/ai");
  const ctx = {
    channel: "text", message: "Just like the pennfield output. It needs to have all 4 lots overlayed", senderName: "Heather Barritt", senderIsClient: true, clientName: "Heather Barritt",
    orders: [{ id: "ord-barry", address: "Barry Rd, New Britain Township, PA", status: "REVIEW", due: null, delivered: null, inRevision: false }],
    openTasks: [], thread: [],
  };
  routerAnswer = JSON.stringify({
    actionable: true, projectId: "ord-barry", title: "Add all 4 lot overlays to Barry Rd images", detail: "Match the Pennfield output.", priority: "HIGH", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "client instruction",
    asks: [
      { kind: "SPECIAL_REQUEST", text: "It needs to have all 4 lots overlayed", summary: "Overlay all 4 lots like the Pennfield output", medium: "photo", projectHint: "ord-barry" },
      { kind: "special request", text: "lot numbers too", summary: "Add the lot numbers", medium: "PHOTO", projectHint: "ord-invented" },
      { kind: "COMPLIMENT", text: "thanks", summary: "x", medium: "photo", projectHint: null },
      { kind: "SCHEDULING", text: "", summary: "", medium: "video", projectHint: null },
      "garbage",
    ],
  });
  const d1 = await decideCommTask(ctx as never, "drill-key");
  c.ok("the router prompt asks for the asks field and keeps its own", prompts.some((p) => /"asks": \[\{"kind": "<SPECIAL_REQUEST\|SCHEDULING>"/.test(p) && /isRevisionRequest/.test(p) && /Our team's replies never answer an ask away/.test(p)));
  c.ok("every existing field is read as before", !!d1 && d1.actionable && d1.projectId === "ord-barry" && d1.priority === "HIGH" && d1.isRevisionRequest === false && d1.title.startsWith("Add all 4"));
  c.ok("two well-formed asks kept, three malformed dropped", d1?.asks.length === 2, JSON.stringify(d1?.asks));
  c.ok("…'special request' and 'PHOTO' are read; an invented order id becomes null", d1?.asks[1]?.kind === "SPECIAL_REQUEST" && d1.asks[1].medium === "photo" && d1.asks[1].projectHint === null && d1.asks[0].projectHint === "ord-barry");
  routerAnswer = JSON.stringify({ actionable: false, projectId: null, title: "No action needed", detail: "", priority: "LOW", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "thanks" });
  const d2 = await decideCommTask(ctx as never, "drill-key");
  c.ok("an answer with no asks field is still a full decision, asks = []", !!d2 && d2.actionable === false && Array.isArray(d2.asks) && d2.asks.length === 0);
  c.ok("parseBrainAsks: not an array is []", parseBrainAsks({ kind: "SCHEDULING" }, new Set()).length === 0 && parseBrainAsks(null, new Set()).length === 0);
  c.ok("…an em dash in a summary becomes a comma", !DASH.test(parseBrainAsks([{ kind: "SCHEDULING", text: "x", summary: "Move it — Thursday" }], new Set())[0]?.summary ?? "—"));

  // =========================================================================
  c.head("2 · Filed from a client's text");
  // =========================================================================
  const { recordClientCommunication } = await import("@/lib/comms");
  const heather = await prisma.client.create({ data: { name: "Heather Barritt", phone: "(724) 555-0193" }, select: { id: true, name: true } });
  const barry = await prisma.project.create({ data: { title: "Barry Rd, New Britain Township, PA 18914", clientId: heather.id, status: "REVIEW", shootDate: new Date(Date.now() - 5 * DAY), promisedDueAt: new Date(Date.now() + 2 * DAY), deliverables: { create: [{ type: "VIDEO", label: "Drone video", quantity: 1 }, { type: "DRONE", label: "Drone Photos", quantity: 1 }] } }, select: { id: true } });
  const northbrook = await prisma.project.create({ data: { title: "671 Northbrook Rd, Kennett Square, PA 19348", clientId: heather.id, status: "DELIVERED", deliveredAt: new Date(Date.now() - 6 * DAY) }, select: { id: true } });
  const decide = (asks: Ask[], over: Partial<Decision> = {}): Decision => ({ actionable: true, projectId: barry.id, title: "Reply to Heather about Barry Rd", detail: "Client instruction.", priority: "HIGH", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "instruction", taskType: "client_reply", asks, ...over });
  const say = async (text: string, d: Decision | null, kind: "text" | "email" = "text") => {
    nextDecision = d;
    await recordClientCommunication({ clientId: heather.id, clientName: heather.name, projectId: barry.id, projectStatus: "REVIEW", text, kind, source: kind === "email" ? "gmail" : "openphone", contactName: heather.name });
  };
  const lots = "Just like the pennfield output. It needs to have all 4 lots overlayed";
  await say(lots, decide([{ kind: "SPECIAL_REQUEST", text: "It needs to have all 4 lots overlayed", summary: "Overlay all 4 lots like the Pennfield output", medium: "photo", projectHint: barry.id }]));
  const asks1 = await prisma.clientAsk.findMany({ where: { clientId: heather.id } });
  const a1 = asks1[0];
  c.ok("Heather's ask is a ClientAsk on Barry Rd", asks1.length === 1 && a1.projectId === barry.id && a1.kind === "SPECIAL_REQUEST" && a1.state === "OPEN", JSON.stringify(asks1.map((a) => [a.projectId, a.kind, a.state])));
  c.ok("…it holds delivery, about the photos, from a text, who asked, in her words", a1.holdsDelivery && a1.medium === "photo" && a1.source === "text" && a1.askedBy === "Heather Barritt" && /all 4 lots overlayed/.test(a1.text) && /Pennfield/.test(a1.summary ?? ""));
  c.ok("…and the reply task was still filed as before", (await prisma.smartTask.count({ where: { clientId: heather.id, taskType: "client_reply", status: "OPEN" } })) === 1);
  await say(lots, decide([{ kind: "SPECIAL_REQUEST", text: "It needs to have all 4 lots overlayed!", summary: "Overlay all 4 lots", medium: "photo", projectHint: barry.id }]));
  c.ok("the same message read twice (two inboxes) files once", (await prisma.clientAsk.count({ where: { clientId: heather.id } })) === 1);
  await say("The gate code is 4417, and please get the pond", decide([
    { kind: "SPECIAL_REQUEST", text: "The gate code is 4417", summary: "Gate code 4417", medium: "unclear", projectHint: barry.id },
    { kind: "SPECIAL_REQUEST", text: "please get the pond", summary: "Get a shot of the pond", medium: "both", projectHint: barry.id },
  ]));
  const pond = await prisma.clientAsk.findMany({ where: { clientId: heather.id, text: { contains: "pond" } } });
  c.ok("a gate code is never an ask; the pond in the same message is", pond.length === 1 && !/4417/.test(pond[0].text) && pond[0].medium === "both" && (await prisma.clientAsk.count({ where: { text: { contains: "4417" } } })) === 0);
  await say("The drone video on Northbrook is missing the lot lines", decide([{ kind: "SPECIAL_REQUEST", text: "missing the lot lines", summary: "Add lot lines to the Northbrook video", medium: "video", projectHint: northbrook.id }], { projectId: northbrook.id, isRevisionRequest: true }));
  c.ok("an ask on the delivered job is the revision's, not a ClientAsk", (await prisma.clientAsk.count({ where: { projectId: northbrook.id } })) === 0);
  await say("We have to cancel tomorrow's appointment", decide([{ kind: "SCHEDULING", text: "We have to cancel tomorrow's appointment", summary: "Cancel tomorrow's shoot and confirm", medium: "unclear", projectHint: null }], { title: "Cancel the shoot" }));
  const sched = await prisma.clientAsk.findFirst({ where: { clientId: heather.id, kind: "SCHEDULING" } });
  c.ok("a scheduling ask is filed, on the job the message landed on, and never holds", !!sched && sched.projectId === barry.id && !sched.holdsDelivery && sched.medium === null);
  await say("Please make sure the lots sit inside the community property lines", decide([{ kind: "SPECIAL_REQUEST", text: "make sure the lots sit inside the community property lines", summary: "Lots inside the community property lines", medium: "both", projectHint: null }], { projectId: null }));
  const lines = await prisma.clientAsk.findFirst({ where: { clientId: heather.id, text: { contains: "community property lines" } } });
  c.ok("no clear job, one job in flight: the ask goes on that job", lines?.projectId === barry.id);
  if (lines) await ca.markNotNeeded(lines.id, "drill", "kept out of the medium checks below");
  await say("Can we reschedule the shoot to Thursday instead?", null);
  c.ok("the brain down: a plain reschedule still reaches Kyle's Scheduling screen", (await prisma.clientAsk.count({ where: { clientId: heather.id, kind: "SCHEDULING", text: { contains: "Thursday" } } })) === 1);
  await say("Thanks so much!", null);
  c.ok("…and a thank-you does not", (await prisma.clientAsk.count({ where: { clientId: heather.id, kind: "SCHEDULING" } })) === 2);

  // =========================================================================
  c.head("3 · Our reply never closes an ask");
  // =========================================================================
  const { closeReplyForOutbound } = await import("@/lib/tasks");
  const openReplies = () => prisma.smartTask.count({ where: { clientId: heather.id, projectId: barry.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
  const repliesBefore = await openReplies();
  await closeReplyForOutbound(heather.id, "Got it, we'll start working on the Barry Rd lots now.");
  c.ok("the reply task closed, as it always did", repliesBefore >= 1 && (await openReplies()) === 0, `${repliesBefore} -> ${await openReplies()}`);
  c.ok("…and every ask is still open", (await prisma.clientAsk.count({ where: { clientId: heather.id, state: { not: "OPEN" }, id: { not: lines?.id ?? "" } } })) === 0 && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: a1.id } })).state === "OPEN");

  // =========================================================================
  c.head("4 · Holds by medium");
  // =========================================================================
  const photoHold = await ca.openAsksHolding(barry.id, "photo");
  const videoHold = await ca.openAsksHolding(barry.id, "video");
  c.ok("the photos are held by the lots ask and the pond (both)", photoHold.length === 2 && photoHold.some((h) => h.id === a1.id), JSON.stringify(photoHold.map((h) => h.summary)));
  c.ok("the video is held by the pond only (the lots ask is about the photos)", videoHold.length === 1 && videoHold[0].id === pond[0].id);
  c.ok("…oldest first, with the summary, who and when", photoHold[0].id === a1.id && photoHold[0].summary.length > 0 && photoHold[0].askedBy === "Heather Barritt" && !!Date.parse(photoHold[0].askedAtISO));
  const unclear = await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SPECIAL_REQUEST", medium: "unclear", text: "Make the lines thicker", source: "email" });
  c.ok("an 'unclear' email ask holds both", (await ca.openAsksHolding(barry.id, "video")).some((h) => h.id === unclear!.id) && (await ca.openAsksHolding(barry.id, "photo")).some((h) => h.id === unclear!.id));
  const note = await ca.createAsk({ clientId: heather.id, projectId: barry.id, kind: "SPECIAL_REQUEST", medium: "both", text: "Ordered: Lot Lines", source: "order_note" });
  c.ok("an order note never holds", !(await prisma.clientAsk.findUniqueOrThrow({ where: { id: note!.id } })).holdsDelivery && !(await ca.openAsksHolding(barry.id, "photo")).some((h) => h.id === note!.id));
  c.ok("no job, nothing held", (await ca.openAsksHolding("", "photo")).length === 0);

  // =========================================================================
  c.head("5 · Done, Confirmed, Reopen, Not needed");
  // =========================================================================
  const done = await ca.markDone(a1.id, "Kyle Smith");
  c.ok("Done is refused on an ask that holds delivery, in plain words", !done.ok && /holds delivery\. Press Confirmed/.test(done.message) && !DASH.test(done.message));
  const conf = await ca.markConfirmed(a1.id, "Kyle Smith", "all 4 lots and their numbers match the plat");
  const a1c = await prisma.clientAsk.findUniqueOrThrow({ where: { id: a1.id } });
  c.ok("Confirmed records who, when and the note", conf.ok && a1c.state === "CONFIRMED" && a1c.confirmedBy === "Kyle Smith" && !!a1c.confirmedAt && a1c.confirmNote === "all 4 lots and their numbers match the plat");
  c.ok("…and releases the photo hold", !(await ca.openAsksHolding(barry.id, "photo")).some((h) => h.id === a1.id));
  c.ok("…with a line on the job's timeline", (await prisma.activity.count({ where: { projectId: barry.id, body: { startsWith: "Client ask confirmed by Kyle Smith" } } })) === 1);
  c.ok("Confirmed twice: nothing changes", (await ca.markConfirmed(a1.id, "Jordan")).message.startsWith("Already") && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: a1.id } })).confirmedBy === "Kyle Smith");
  await ca.reopenAsk(a1.id, "Kyle Smith");
  c.ok("Reopen puts it back, holding again", (await prisma.clientAsk.findUniqueOrThrow({ where: { id: a1.id } })).state === "OPEN" && (await ca.openAsksHolding(barry.id, "photo")).some((h) => h.id === a1.id));
  const nn = await ca.markNotNeeded(unclear!.id, "Kyle Smith", "she said the lines are fine");
  c.ok("Not needed releases its hold and keeps why", nn.ok && !(await ca.openAsksHolding(barry.id, "video")).some((h) => h.id === unclear!.id) && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: unclear!.id } })).confirmNote === "she said the lines are fine");
  const doneNote = await ca.markDone(note!.id, "Kyle Smith");
  c.ok("Done works on an order note (it holds nothing)", doneNote.ok && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: note!.id } })).state === "DONE");

  // =========================================================================
  c.head("6 · The client's 'never mind' sets an ask aside");
  // =========================================================================
  const { __setNotNeededJudgeForTests, reviewAsksAgainstConversation } = await import("@/lib/revisionNotNeeded");
  let judgePrompt = "";
  __setNotNeededJudgeForTests(async (prompt) => {
    judgePrompt = prompt;
    const ids = [...prompt.matchAll(/- id (\S+) ·/g)].map((m) => m[1]);
    return { asks: ids.map((id) => (id === `ask:${pond[0].id}` ? { id, needed: "no" as const, saidBy: "Heather", quote: "never mind the pond, it's dried up" } : { id, needed: "yes" as const })) };
  });
  // The asks were asked half an hour ago; the conversation since is what is re-read.
  await prisma.clientAsk.updateMany({ where: { clientId: heather.id }, data: { askedAt: new Date(Date.now() - 30 * 60_000) } });
  const log = (direction: "in" | "out", body: string, minsAgo: number) => prisma.commLog.create({ data: { clientId: heather.id, channel: "text", direction, body, occurredAt: new Date(Date.now() - minsAgo * 60_000), source: "openphone", contactName: direction === "in" ? "Heather Barritt" : "Us" } });
  await log("out", "Got it, we'll get the pond!", 5);
  await log("in", "Actually never mind the pond, it's dried up", 1);
  const rv = await reviewAsksAgainstConversation(heather.id);
  c.ok("the open asks were read against the conversation, scheduling ones marked as such", judgePrompt.includes(`ask:${pond[0].id}`) && judgePrompt.includes(`ask:${a1.id}`) && /\(a scheduling request\)/.test(judgePrompt), judgePrompt.slice(0, 300));
  const pondAfter = await prisma.clientAsk.findUniqueOrThrow({ where: { id: pond[0].id } });
  c.ok("the pond is Not needed, saying who said so in her words", pondAfter.state === "NOT_NEEDED" && /Heather said “never mind the pond, it's dried up”/.test(pondAfter.confirmNote ?? "") && (rv.asksWithdrawn ?? []).includes(pond[0].id), JSON.stringify(rv));
  c.ok("…the lots ask she did not withdraw stays open", (await prisma.clientAsk.findUniqueOrThrow({ where: { id: a1.id } })).state === "OPEN");
  __setNotNeededJudgeForTests(null);

  // =========================================================================
  c.head("7 · Counts for Kyle's tiles, and the boards");
  // =========================================================================
  // A fresh world for exact numbers: clear the asks above.
  await prisma.clientAsk.deleteMany({});
  const now = new Date(Date.now());
  const late = await prisma.project.create({ data: { title: "12 Late Ln, Malvern, PA", clientId: heather.id, status: "EDITING", promisedDueAt: new Date(now.getTime() - 2 * HOUR) }, select: { id: true } });
  const ok = await prisma.project.create({ data: { title: "34 Fine St, Malvern, PA", clientId: heather.id, status: "EDITING", promisedDueAt: new Date(now.getTime() + 5 * DAY) }, select: { id: true } });
  const test = await prisma.client.create({ data: { name: "Bobby TEST" }, select: { id: true } });
  const testJob = await prisma.project.create({ data: { title: "1 Test Way", clientId: test.id, status: "EDITING" }, select: { id: true } });
  const mk = (p: Partial<Parameters<typeof ca.createAsk>[0]> & { askedAt: Date; text: string }) => ca.createAsk({ clientId: heather.id, kind: "SPECIAL_REQUEST", source: "text", medium: "photo", ...p });
  await mk({ projectId: late.id, text: "lot numbers please", askedAt: new Date(now.getTime() - 3 * HOUR) }); // behind: the promise passed
  await mk({ projectId: ok.id, text: "warmer colors", askedAt: new Date(now.getTime() - 50 * HOUR) }); // behind: 48 h open
  await mk({ projectId: ok.id, text: "show the pool", askedAt: new Date(now.getTime() - 1 * HOUR) }); // due in 48 h
  await mk({ projectId: ok.id, text: "Ordered: Virtual Staging", source: "order_note", askedAt: new Date(now.getTime() - 9 * DAY) }); // order note: not behind before the promise
  await ca.createAsk({ clientId: test.id, projectId: testJob.id, kind: "SPECIAL_REQUEST", source: "text", text: "test client ask", askedAt: new Date(now.getTime() - 99 * HOUR) });
  await ca.createAsk({ clientId: heather.id, projectId: ok.id, kind: "SCHEDULING", source: "text", text: "can we move it", askedAt: new Date(now.getTime() - 2 * HOUR) });
  await ca.createAsk({ clientId: heather.id, projectId: ok.id, kind: "SCHEDULING", source: "email", text: "we need to cancel", askedAt: new Date(now.getTime() - 30 * HOUR) });
  await ca.createAsk({ clientId: heather.id, projectId: ok.id, kind: "SCHEDULING", source: "aryeo", text: "Moved in Aryeo", askedAt: new Date(now.getTime() - 3 * HOUR), dedupeKey: "aryeo-change:x:1" });
  await ca.createAsk({ clientId: heather.id, projectId: ok.id, kind: "SCHEDULING", source: "aryeo", text: "Moved in Aryeo long ago", askedAt: new Date(now.getTime() - 60 * HOUR), dedupeKey: "aryeo-change:x:2" });
  const counts = await ca.askBoardCounts(now);
  // CHANGED Oct 19 evening: the order note (9 days old) and the Aryeo moves are not asks any more.
  c.ok("special: 3 open (the order note and the test client left out), 2 behind", counts.special.open === 3 && counts.special.behind === 2, JSON.stringify(counts.special));
  c.ok("…the oldest has waited 50 hours (the order note no longer counts)", counts.special.oldestHours === 50, String(counts.special.oldestHours));
  c.ok("scheduling: 2 open (Aryeo moves are no longer asks), 1 behind (30 h), 1 due today", counts.scheduling.open === 2 && counts.scheduling.behind === 1 && counts.scheduling.dueToday === 1, JSON.stringify(counts.scheduling));
  const board = await ca.specialRequestsBoard(now);
  c.ok("the board groups by job, the job with the oldest ask first", board.groups.length === 2 && board.groups[0].projectId === ok.id && board.groups[0].asks.length === 2 && board.groups[1].projectId === late.id, JSON.stringify(board.groups.map((g) => [g.street, g.asks.length])));
  c.ok("…behind is marked on the ask and the job", board.groups[1].behind && board.groups[1].asks[0].behind && board.groups[0].asks.find((a) => a.text === "warmer colors")?.behind === true && board.groups[0].asks.find((a) => a.text === "show the pool")?.behind === false);
  c.ok("…the delivery promise and the test client's job are right", !!board.groups[0].dueWords && !board.groups.some((g) => g.projectId === testJob.id));
  c.ok("…and the jobs a hand-added ask can go on leave the test client out", board.jobs.some((j) => j.id === ok.id) && !board.jobs.some((j) => j.id === testJob.id));
  const sb = await ca.schedulingBoard(now);
  c.ok("the scheduling board: the client's own asks, no Aryeo changes", sb.asks.length === 2 && sb.aryeo.length === 0 && sb.asks[0].text === "we need to cancel");
  const byHand = await ca.addAskByHand({ projectId: ok.id, text: "Agent wants the sign in every exterior", medium: "photo", holdsDelivery: true, by: "Kyle Smith" });
  const hand = await prisma.clientAsk.findFirst({ where: { source: "staff" } });
  c.ok("an ask added by hand is staff-sourced and holds when asked to", byHand.ok && !!hand && hand.holdsDelivery && hand.projectId === ok.id && hand.clientId === heather.id);
  const loose = await ca.createAsk({ clientId: heather.id, projectId: null, kind: "SPECIAL_REQUEST", source: "email", text: "be sure the lots are defined within the community property lines" });
  const assigned = await ca.assignAskProject(loose!.id, ok.id, "Kyle Smith");
  c.ok("a job-less ask is put on one of the client's jobs", assigned.ok && (await prisma.clientAsk.findUniqueOrThrow({ where: { id: loose!.id } })).projectId === ok.id);
  c.ok("…never on another client's job", !(await ca.assignAskProject(loose!.id, testJob.id, "Kyle Smith")).ok);

  // =========================================================================
  c.head("8 · From the order, the portal and Aryeo");
  // =========================================================================
  const orderJob = await prisma.project.create({
    data: {
      title: "1680 Bridle Path Dr, Malvern, PA", clientId: heather.id, status: "SCHEDULED",
      orderItems: { create: [{ title: "Lot Lines", amount: 5000 }, { title: "Standard Package", amount: 30000 }] },
      appointments: { create: [{ aryeoId: "appt-bridle", description: "Customer:\nName: Heather\n\nOrder Notes:\nn/a\n\nOrder Questions:\n - Lock Box / Door Code: 4417\n - Special Instructions for the photographer (for this property only): Agent will be there. The lockbox is on the back door. Let's use vertical for the video. Drone to highlight the lot size.\n\nOr View Full Order Details:\nhttps://app.aryeo.com/x" }] },
    },
    select: { id: true },
  });
  const filed = await ca.fileOrderAsks(orderJob.id);
  c.ok("the note and the Lot Lines add-on are no longer filed as asks", filed === 0 && (await prisma.clientAsk.count({ where: { projectId: orderJob.id } })) === 0);
  const { jobChecks } = await import("@/lib/jobChecks");
  const box = await jobChecks(orderJob.id, "video");
  const onOrder = box.notes.find((n) => n.label === "On the order")?.text ?? "";
  c.ok("…the note shows on the job's box instead: the instructions kept, the lockbox and who will be there dropped", /vertical for the video/.test(onOrder) && /lot size/.test(onOrder) && !/lockbox|4417|Agent will be there/i.test(onOrder), onOrder);
  c.ok("…and the add-on says what to check", box.notes.some((n) => n.label === "Add-on ordered" && /^Lot Lines: check it is on the finished work and correct\.$/.test(n.text)), JSON.stringify(box.notes));
  c.ok("…a delivered job files nothing either", (await ca.fileOrderAsks(northbrook.id)) === 0);
  const sr = await ca.fileSessionRequestAsk({ requestId: "req-1", clientId: heather.id, projectId: null, mode: "RESCHEDULE", when: "Thu, Oct 22, 2:00 PM" });
  c.ok("a portal move is no longer a scheduling ask (its desk task covers it)", sr === null && (await prisma.clientAsk.count({ where: { source: "portal" } })) === 0);
  const { closeDeskTask } = await import("@/lib/sessionRequests");
  await closeDeskTask("req-1", "COMPLETED");
  c.ok("…closing the desk task still works with no ask behind it", true);
  const mv = await ca.fileAryeoChangeAsk({ aryeoAppointmentId: "appt-bridle", projectId: orderJob.id, change: "moved", startAt: new Date("2026-10-22T18:00:00Z"), previousStartAt: new Date("2026-10-21T14:00:00Z"), keyPart: "2026-10-22T18:00:00.000Z" });
  c.ok("an Aryeo move is no longer an ask (the appointment bell covers it)", mv === null && (await prisma.clientAsk.count({ where: { source: "aryeo", projectId: orderJob.id } })) === 0);

  // =========================================================================
  c.head("9 · Same-day photos wait for a holding photo ask");
  // =========================================================================
  const sd = await prisma.project.create({ data: { title: "9 Same Day Ct, Malvern, PA", clientId: heather.id, status: "EDITING", orderItems: { create: [{ title: "Same Day Photo Delivery", amount: 5000 }] } }, select: { id: true } });
  const job = await prisma.photoJob.create({ data: { projectId: sd.id, stage: "READY" } });
  const { sameDayBlocker } = await import("@/lib/photoDelivery/aryeoPush");
  const before = await sameDayBlocker(job.id);
  const hold = await ca.createAsk({ clientId: heather.id, projectId: sd.id, kind: "SPECIAL_REQUEST", source: "text", medium: "photo", text: "Please remove the trash cans" });
  const held = await sameDayBlocker(job.id);
  c.ok("with the client's photo ask open: the hub does not approve it by itself", held === "1 client ask to confirm first", String(held));
  const vid = await ca.createAsk({ clientId: heather.id, projectId: sd.id, kind: "SPECIAL_REQUEST", source: "text", medium: "video", text: "Use the upbeat song" });
  c.ok("…a video ask does not hold the photos", (await sameDayBlocker(job.id)) === "1 client ask to confirm first");
  await ca.markConfirmed(hold!.id, "Kyle Smith");
  const after = await sameDayBlocker(job.id);
  c.ok("confirmed: the same-day check goes on exactly as before", after === before && after !== "1 client ask to confirm first", `${before} / ${after}`);
  void vid;

  // =========================================================================
  c.head("10 · A text is a text");
  // =========================================================================
  const { channelOfSource } = await import("@/lib/comms");
  c.ok("openphone is a text, openphone-call a call, gmail an email", channelOfSource("openphone") === "text" && channelOfSource("openphone-call") === "call" && channelOfSource("gmail") === "email" && channelOfSource("voicemail") === "call" && channelOfSource("comms") === "text");

  c.head("Nothing left the hub");
  c.ok("no text went to a client", texts.length === 0, texts.join(" | "));
  c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
