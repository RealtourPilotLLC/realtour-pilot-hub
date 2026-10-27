// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Jordan's Oct 27 2026 Loom, the Photo Delivery part (30:49 to 36:30).
//
//   DRILL_PORT=5626 node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-photo.ts
//
//   1 · a request after delivery is read first: plain words (photo fix,
//       office work, the video), then the AI (stubbed here), unsure or down =
//       Kyle's task, never a reopen
//   2 · 913 Lakeview: Mike Flatley's "Upload all 913 Lakeview deliverables to
//       Showcase before tomorrow" leaves the photos delivered; Kyle's open
//       Showcase task is used (never a second one, never the reply task); the
//       message's request is closed with why
//   3 · an office request with no task yet: one on Kyle's list, his desk's
//       Handle request opens Open the listing and Mark handled
//   4 · a real photo fix still reopens: the client's words, who and how on
//       the job and the board card; Approve and upload beside Approve and
//       deliver (again)
//   5 · a request about the video goes to the video, the photos stay delivered
//   6 · the board: Waiting for upload first, Editing next; empty columns fold
//   7 · Undo "Check again": before it ran, after it ran (the earlier check's
//       results back), refused once a person decided a new issue
//   8 · the free check judges only the house being shot (its address, its
//       number; a neighbor's car, porch and decor never), and asks for a
//       photo taken looking up
//   9 · a strong measured lean is a real issue (major), a slight one advisory
//  10 · the 913 Lakeview live repair is a dry run by default and makes no task
//
// ISOLATION: PGlite; AutoHDR (the free check's describe) and Slack are fakes;
// the AI is a stub; anything else is refused and counted. Nothing is sent,
// nothing paid runs.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();
const load = createRequire(__filename);
for (const nav of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
  nav.usePathname = () => "/ops/photo-delivery";
  nav.useSearchParams = () => new URLSearchParams();
}
const REPO = path.resolve(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fake = createFakeAutohdr({ transforms: [{ name: "reedit", credit_cost: 1 }], balance: 500, clientId: "cid", clientSecret: "drill-secret-1234567890" });
const fence = fenceFetch(async (url, init) => (await fake.handle(url, init)) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
const DASH = /[–—]/;

// The free check's answers, by AutoHDR photo name.
type Issue = { id: string; where: string; confidence: number; property?: string };
type Answer = { room: string; view?: string; prep?: string; issues?: Issue[] };
const answers = new Map<string, Answer>();
const prompts: { name: string; prompt: string }[] = [];
fake.state.describe = (name, prompt) => {
  if (/\nIds:\n/.test(prompt)) {
    prompts.push({ name, prompt });
    const a = answers.get(name);
    return a ? JSON.stringify({ light: "day", furnished: "furnished", prep: "tidy", features: [], issues: [], ...a }) : '{"room":"other","issues":[]}';
  }
  return "A room.";
};

const SHOWCASE = "Upload all 913 Lakeview deliverables to Showcase before tomorrow";

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5626) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings, photoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const A = await import("@/lib/photoDelivery/afterDeliveryAsk");
    const asked = await import("@/lib/photoDelivery/clientAsked");
    const CA = await import("@/lib/clientAsks");
    const H = await import("@/lib/photoDelivery/holding");
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const undo = await import("@/lib/photoDelivery/recheckUndo");
    const geometry = await import("@/lib/photoDelivery/geometry");
    const data = await import("@/app/ops/photo-delivery/data");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await savePhotoDeliverySettings({ enabled: true, freeCheck: true, qcShadow: false, aryeoPush: "on", autoFix: false, fixRunnerEnabled: false, warpCompareOriginal: false }, "drill");
    const kyleView = { role: "ADMIN", name: "Kyle Smith", isOwner: false, canSeeMoney: false };
    const DAY = 86_400_000;
    const HOUR = 3_600_000;

    // The AI: a stub that says what each case needs, and counts its calls (never a real model).
    let aiAnswer: (() => Promise<{ kind?: unknown; sure?: unknown }>) | null = null;
    let aiCalls = 0;
    A.__setAfterDeliveryJudgeForTests(async () => {
      aiCalls++;
      if (!aiAnswer) throw new Error("the AI is down (drill)");
      return aiAnswer();
    });

    // People: Jordan (owner), Kyle (the delivery owner).
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan@loom.invalid" } });
    await prisma.appUser.create({ data: { email: "jordan@loom.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE", teamMemberId: jordanTm.id } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@loom.invalid" } });
    const kyleUser = await prisma.appUser.create({ data: { email: "kyle@loom.invalid", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: kyleUser.id, teamMemberId: kyleTm.id, label: "Kyle Smith", setBy: "drill" } });

    /** A job whose photos went out two days ago. */
    const deliveredJob = async (street: string, clientName: string) => {
      const client = await prisma.client.create({ data: { name: clientName } });
      const project = await prisma.project.create({ data: { title: `${street}, Malvern, PA`, addressLine: street, clientId: client.id, status: "DELIVERED", shootDate: new Date(Date.now() - 3 * DAY) } as never });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "DELIVERED", deliveredAt: new Date(Date.now() - 2 * DAY), stageChangedAt: new Date(Date.now() - 2 * DAY) } });
      return { client, project, job };
    };
    const stageOf = async (jobId: string) => (await prisma.photoJob.findUniqueOrThrow({ where: { id: jobId } })).stage;

    // ======================================================================
    c.head("1 · plain words first, then the AI; unsure or down is Kyle's task");
    // ======================================================================
    const W = A.afterDeliveryByWords;
    c.ok("Mike Flatley's Showcase text: office work", W(SHOWCASE) === "office");
    c.ok("upload to Zillow, the link, a 3D tour, the floor plan: office work", ["Can you upload these to Zillow?", "Please send me the link again", "Where is the 3D tour?", "Can I get the floor plan?"].every((w) => W(w) === "office"));
    c.ok("a photo number, crop, brighten, remove the car in the photos: a photo fix", ["Can you remove the car in photo 4?", "Please brighten the kitchen", "Crop the second one a bit", "Can you remove the trash cans from the photos?"].every((w) => W(w) === "photo"));
    c.ok("the music on the reel: the video's", W("Can you change the music on the reel?") === "video");
    c.ok("both, or neither: the AI is asked", W("Please remove the car in photo 4 and upload them to Zillow") === null && W("Can you fix the kitchen one?") === null && W("Thanks so much!") === null);
    const before = aiCalls;
    const j0 = await A.judgeAfterDeliveryAsk(SHOWCASE);
    c.ok("plain words decide without the AI", j0.kind === "office" && j0.by === "words" && aiCalls === before, JSON.stringify(j0));
    aiAnswer = async () => ({ kind: "photo_edit", sure: true });
    const j1 = await A.judgeAfterDeliveryAsk("Can you fix the kitchen one?");
    aiAnswer = async () => ({ kind: "photo_edit", sure: false });
    const j2 = await A.judgeAfterDeliveryAsk("Can you fix the kitchen one?");
    aiAnswer = async () => ({ kind: "video_edit", sure: true });
    const j3 = await A.judgeAfterDeliveryAsk("Can you fix the kitchen one?");
    aiAnswer = async () => ({ kind: "office", sure: false });
    const j4 = await A.judgeAfterDeliveryAsk("Can you fix the kitchen one?");
    aiAnswer = async () => ({ kind: "nonsense" });
    const j5 = await A.judgeAfterDeliveryAsk("Can you fix the kitchen one?");
    aiAnswer = null;
    const j6 = await A.judgeAfterDeliveryAsk("Can you fix the kitchen one?");
    c.ok("the AI sure it is a photo edit: a photo fix", j1.kind === "photo" && j1.by === "ai", JSON.stringify(j1));
    c.ok("the AI says photo edit but not sure: Kyle's task (fail safe)", j2.kind === "office" && j2.by === "fail-safe", JSON.stringify(j2));
    c.ok("the AI sure it is the video's: the video", j3.kind === "video" && j3.by === "ai");
    c.ok("the AI says office: Kyle's task", j4.kind === "office" && j4.by === "ai");
    c.ok("an answer it cannot read, or the AI down: Kyle's task (fail safe)", j5.kind === "office" && j5.by === "fail-safe" && j6.kind === "office" && j6.by === "fail-safe", JSON.stringify([j5, j6]));
    c.ok("the same request in other words is matched (Kyle's task and the client's text)", A.sameRequestWords("Upload 913 Lakeview assets to Showcase before tomorrow", SHOWCASE) && !A.sameRequestWords("Upload 913 Lakeview assets to Showcase before tomorrow", "Please brighten photo 3"));

    // ======================================================================
    c.head("2 · 913 Lakeview: the Showcase text does not reopen the photos; Kyle's task is used, not made again");
    // ======================================================================
    const L = await deliveredJob("913 Lakeview Dr", "Mike Flatley");
    // The brain's task for the message, as on the live job: a client_reply titled with the work, on Kyle's list.
    const kyleTask = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Upload 913 Lakeview assets to Showcase before tomorrow", description: `"${SHOWCASE}"`, status: "OPEN", projectId: L.project.id, clientId: L.client.id, ownerId: kyleTm.id, assignedKey: "kyle", source: "openphone", dedupeKey: "drill-brain-913-showcase" } as never });
    // A revision to-do quoting the same words (made later, so it would be found first): never taken as the work.
    const replyTask = await prisma.smartTask.create({ data: { taskType: "revision", title: "Video revision: 913 Lakeview Dr", summary: `The client asked: ${SHOWCASE}`, status: "OPEN", projectId: L.project.id, clientId: L.client.id, source: "system", dedupeKey: "drill-video-rev-913" } as never });
    const tasksBefore = await prisma.smartTask.count({ where: { projectId: L.project.id } });
    const ask913 = (await CA.createAsk({ clientId: L.client.id, projectId: L.project.id, kind: "SPECIAL_REQUEST", medium: "both", text: SHOWCASE, summary: "Upload all deliverables to Showcase", source: "text", askedBy: "Mike Flatley", dedupeKey: "drill-ask-913", by: "drill" }))!;
    const callsBefore = aiCalls;
    const r913 = await asked.photoAskAfterDelivery({ projectId: L.project.id, words: SHOWCASE, by: "Mike Flatley", askedBy: "Mike Flatley", clientId: L.client.id, askKey: "drill-ask-913" });
    c.ok("not reopened: the photos stay Delivered", !r913.reopened && r913.routed === "office" && (await stageOf(L.job.id)) === "DELIVERED", JSON.stringify(r913));
    c.ok("…read from the words alone (no AI call)", aiCalls === callsBefore);
    c.ok("…Kyle's open Showcase task (the brain's, from the same message) is the task, never a revision to-do", r913.taskId === kyleTask.id && r913.taskId !== replyTask.id, String(r913.taskId));
    c.ok("…no second task, and no photo revision to-do", (await prisma.smartTask.count({ where: { projectId: L.project.id } })) === tasksBefore && !(await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(L.project.id) } })));
    const a913 = await prisma.clientAsk.findUniqueOrThrow({ where: { id: ask913.id } });
    c.ok("the message's request is closed with why (it no longer holds anything)", a913.state === "DONE" && /^Not a change to the photos: on Kyle's list as a task/.test(a913.confirmNote ?? ""), `${a913.state} ${a913.confirmNote}`);
    c.ok("…said on the photo job and the job's activity", (await prisma.photoJobEvent.count({ where: { jobId: L.job.id, action: A.OFFICE_ASK_ACTION } })) === 1 && (await prisma.activity.count({ where: { projectId: L.project.id, body: { contains: "Already on Kyle's list as a task" } } })) === 1);
    const again913 = await asked.photoAskAfterDelivery({ projectId: L.project.id, words: SHOWCASE, by: "Mike Flatley", askedBy: "Mike Flatley", clientId: L.client.id });
    c.ok("the same text again (a second email): still delivered, still one task", !again913.reopened && again913.taskId === kyleTask.id && (await stageOf(L.job.id)) === "DELIVERED" && (await prisma.smartTask.count({ where: { projectId: L.project.id } })) === tasksBefore);
    c.ok("a person who picks the photos by hand (Add a request) is trusted: that reopens", src("src/lib/clientAsks.ts").includes("clientId: p.clientId, trusted: true })"));
    const comms = src("src/lib/comms.ts");
    c.ok("a text or email after delivery is read BEFORE it is filed on the photos (comms)", /const judged = await judgeAfterDeliveryAsk\(w\.words\);\s*if \(judged\.kind !== "photo"\) \{\s*await photoAskAfterDelivery\(\{[^}]*judged, askKey \}\);\s*continue;/.test(comms));

    // ======================================================================
    c.head("3 · an office request with no task yet: one on Kyle's list, Handle request on his desk");
    // ======================================================================
    const B = await deliveredJob("22 Birch Ln", "Dana Drill");
    const LINK = "Can you send me the link to the 3D tour?";
    const r3 = await asked.photoAskAfterDelivery({ projectId: B.project.id, words: LINK, by: "Dana Drill", askedBy: "Dana Drill", clientId: B.client.id });
    const t3 = r3.taskId ? await prisma.smartTask.findUnique({ where: { id: r3.taskId } }) : null;
    c.ok("not reopened; a task is made", !r3.reopened && (await stageOf(B.job.id)) === "DELIVERED" && !!t3, JSON.stringify(r3));
    c.ok("…on Kyle's list, high, due within two hours, keyed as a request after delivery", !!t3 && t3.ownerId === kyleTm.id && !!t3.assignedKey && t3.priority === "HIGH" && t3.taskType === "todo" && (t3.dedupeKey ?? "").startsWith(A.OFFICE_TASK_KEY_PREFIX) && !!t3.dueAt && t3.dueAt.getTime() <= Date.now() + 2 * HOUR + 60_000, JSON.stringify({ o: t3?.ownerId, k: t3?.assignedKey, p: t3?.priority, d: t3?.dedupeKey }));
    c.ok("…its words: the street and the request; why the photos stay delivered; it opens the listing", !!t3 && t3.title === `22 Birch Ln: ${LINK}` && /It is not a change to the photos, so the photo job stays delivered\. Open the listing, do it, then mark it handled\./.test(t3.summary ?? "") && t3.sourceDetail === `/listings/${B.project.id}` && !DASH.test(`${t3.title} ${t3.summary}`), `${t3?.title} | ${t3?.summary}`);
    const r3b = await asked.photoAskAfterDelivery({ projectId: B.project.id, words: LINK, by: "Dana Drill", askedBy: "Dana Drill", clientId: B.client.id });
    c.ok("…the same request again: the same task", r3b.taskId === r3.taskId && (await prisma.smartTask.count({ where: { projectId: B.project.id } })) === 1);
    // Kyle's desk: the row's button, then the panel's two actions.
    const deskLib = await import("@/lib/officeDesk");
    const desk = await deskLib.officeDeskFor({ name: "Kyle Smith", email: "kyle@loom.invalid", teamMemberId: kyleTm.id }, { now: new Date((t3?.dueAt ?? new Date()).getTime() + 60_000), includeTest: true }).catch((e: Error) => { console.log("  (desk)", e.message); return null; });
    const row = desk?.sections.flatMap((s) => [...s.now, ...s.waiting, ...s.ok]).find((i) => i.id === `task:${t3?.id}`);
    const acts = (row?.actions ?? []) as { kind: string; label?: string; href?: string; doneLabel?: string }[];
    c.ok("Kyle's desk: the row's button is Handle request", row?.primary?.label === "Handle request", JSON.stringify(row?.primary ?? desk?.sections.map((s) => s.now.map((i) => i.id))));
    c.ok("…its panel: Open the listing (the listing page), then Mark handled", acts[0]?.kind === "link" && acts[0].label === "Open the listing" && acts[0].href === `/listings/${B.project.id}` && acts[1]?.kind === "task" && acts[1].doneLabel === "Mark handled", JSON.stringify(acts));
    c.ok("…the panel's done button reads Mark handled (TaskResolve doneLabel)", /doneLabel = "Mark done"/.test(src("src/components/desk/DeskControls.tsx")) && /doneLabel=\{a\.doneLabel\}/.test(src("src/components/desk/OfficeDesk.tsx")));
    const { TaskResolve } = await import("@/components/desk/DeskControls");
    c.ok("…rendered: Mark handled", /Mark handled/.test(text(html(createElement(TaskResolve, { taskId: "t1", nextDay: "2026-10-28", doneLabel: "Mark handled" })))) && /Mark done/.test(text(html(createElement(TaskResolve, { taskId: "t1", nextDay: "2026-10-28" })))));

    // ======================================================================
    c.head("4 · a real photo fix still reopens: what the client asked, on the job and the card; Approve and upload");
    // ======================================================================
    const P = await deliveredJob("5 Oak St", "Joe Drill");
    const FIX = "Please remove the car in photo 4 and brighten photo 2 for us";
    await CA.createAsk({ clientId: P.client.id, projectId: P.project.id, kind: "SPECIAL_REQUEST", medium: "photo", text: FIX, summary: "Remove the car, brighten photo 2", source: "text", askedBy: "Joe Drill", by: "drill" });
    const r4 = await asked.photoAskAfterDelivery({ projectId: P.project.id, words: FIX, by: "Joe Drill", askedBy: "Joe Drill", clientId: P.client.id });
    c.ok("reopened as Revision, on the photo revision to-do", r4.reopened && !r4.routed && (await stageOf(P.job.id)) === "REVISION_REQUESTED" && !!(await prisma.smartTask.findUnique({ where: { dedupeKey: asked.photoRevisionTaskKey(P.project.id) } })), JSON.stringify(r4));
    const pd = (await data.loadJobDetail(P.job.id, { viewer: kyleView as never }))!;
    const reqs = pd.holdingBase.revisionRequests ?? [];
    c.ok("the job knows the request: the client's words, who, how and when", reqs.length === 1 && reqs[0].text === FIX && /^Joe Drill, by text, /.test(reqs[0].from), JSON.stringify(reqs));
    const push = { mode: "on", connected: true, sameDayAuto: false, progress: null };
    const listingUrl = "https://realtourpilot.aryeo.com/admin/listings/L5/edit";
    const pv = H.holdingFor({ ...pd.holdingBase, listingUrl, stage: pd.header.stage, gate: pd.gate, gateError: pd.gateError, push: push as never });
    const rev = pv.items.find((i) => i.kind === "revision");
    const askItem = pv.items.find((i) => i.kind === "ask");
    c.ok("What's holding this: the request first, as its own item (Done), in the client's words", !!askItem && pv.items.indexOf(askItem) < pv.items.indexOf(rev!) && /Remove the car, brighten photo 2/.test(askItem.text) && askItem.action?.kind === "ask", JSON.stringify(pv.items.map((i) => [i.kind, i.text, i.said])));
    c.ok("…then the revision, which does not quote it twice", rev?.text === "The client asked for changes after delivery (listed above)." && rev.quotes.length === 0 && /^Fix the photos, then send them again\./.test(rev.detail ?? ""), JSON.stringify(rev));
    c.ok("…the button: Approve and deliver again, with Approve and upload beside it; Settled with the client stays", rev?.action?.kind === "approve" && rev.action.label === "Approve and deliver again" && (rev.action as { upload?: boolean }).upload === true && rev.alt?.kind === "settle", JSON.stringify([rev?.action, rev?.alt]));
    // A reopen with no request on file to list (the reopen's own words): quoted under the revision, with who and when.
    const P2 = await deliveredJob("6 Oak St", "Joe Drill");
    const FIX2 = "Can you brighten photo 3 for the listing please?";
    await asked.photoAskAfterDelivery({ projectId: P2.project.id, words: FIX2, by: "Joe Drill", askedBy: "Joe Drill", clientId: P2.client.id });
    const pd2 = (await data.loadJobDetail(P2.job.id, { viewer: kyleView as never }))!;
    const rev2 = H.holdingFor({ ...pd2.holdingBase, listingUrl, stage: pd2.header.stage, gate: pd2.gate, gateError: pd2.gateError, push: push as never }).items.find((i) => i.kind === "revision");
    c.ok("a request not listed on its own: quoted under the revision, who and when", rev2?.text === "The client asked for a change after delivery." && rev2.quotes.length === 1 && rev2.quotes[0].text === FIX2 && /^Joe Drill, /.test(rev2.quotes[0].from), JSON.stringify(rev2));
    c.ok("…its short line names it (the board card's line)", (rev2?.short ?? "").startsWith('Client asked: "Can you brighten photo 3'), rev2?.short);
    const ready = H.holdingFor({ jobId: "j", projectId: "p", stage: "READY", holdReason: null, holdNote: null, lastError: null, waitingForVisit: null, photographer: null, decisions: { critical: 0, major: 0, minor: 0 }, listingUrl, orderUrl: null, deliveryCheckNote: null, listingUpdates: { photoIds: [], names: [] }, gate: { checks: [], canDeliver: true, advisory: true, blockedForOverride: null }, push: push as never } as never);
    c.ok("Ready to send: Approve and deliver, with Approve and upload beside it", ready.ready?.action?.kind === "approve" && ready.ready.action.label === "Approve and deliver" && (ready.ready.action as { upload?: boolean }).upload === true, JSON.stringify(ready.ready));
    const { JobWorkspace } = await import("@/components/photoDelivery/JobWorkspace");
    const ph = html(createElement(JobWorkspace, { data: { ...pd, holdingBase: { ...pd.holdingBase, listingUrl }, aryeoPush: { ...(pd.aryeoPush as object), ...push } } as never, viewer: kyleView as never, history: null }));
    const panel = ph.split('aria-labelledby="pd-holding-h"')[1]?.split("</section>")[0] ?? "";
    c.ok("the job page: the request, Approve and deliver again and Approve and upload", /Remove the car, brighten photo 2/.test(text(panel)) && /Approve and deliver again/.test(text(panel)) && /data-approve-upload/.test(panel) && /Approve and upload/.test(text(panel)), text(panel).slice(0, 400));
    c.ok("…the Deliver panel takes the approval in a revision too (Approve and upload to Aryeo)", /approvable = [^;]*stage === "REVISION_REQUESTED"/.test(src("src/components/photoDelivery/DeliverPanel.tsx")));
    const q4 = await data.loadQueue({ holding: true, viewer: { readOnly: false } } as never);
    const card4 = q4.columns.flatMap((col) => col.cards).find((x) => x.id === P.job.id);
    const card4b = q4.columns.flatMap((col) => col.cards).find((x) => x.id === P2.job.id);
    c.ok("the board cards say why they are in Needs decision: what the client asked", q4.columns.find((col) => col.cards.some((x) => x.id === P.job.id))?.key === "decision" && (card4?.holding?.line ?? "").startsWith("Client asked: Remove the car") && (card4b?.holding?.line ?? "").startsWith('Client asked: "Can you brighten photo 3'), `${card4?.holding?.line} | ${card4b?.holding?.line}`);
    c.ok("plain words, no em dashes", !DASH.test(`${rev?.text} ${rev?.short} ${rev?.detail} ${rev2?.text} ${rev2?.short} ${pv.line}`));

    // ======================================================================
    c.head("5 · a request about the video: on the video, the photos stay delivered");
    // ======================================================================
    const V = await deliveredJob("7 Reel Rd", "Vic Drill");
    const MUSIC = "Can you change the music on the video?";
    const vAsk = (await CA.createAsk({ clientId: V.client.id, projectId: V.project.id, kind: "SPECIAL_REQUEST", medium: "both", text: MUSIC, source: "email", askedBy: "Vic Drill", by: "drill" }))!;
    const r5 = await asked.photoAskAfterDelivery({ projectId: V.project.id, words: MUSIC, by: "Vic Drill", askedBy: "Vic Drill", clientId: V.client.id });
    const va = await prisma.clientAsk.findUniqueOrThrow({ where: { id: vAsk.id } });
    c.ok("not reopened, no office task; the request is put on the video (still open there)", !r5.reopened && r5.routed === "video" && !r5.taskId && (await stageOf(V.job.id)) === "DELIVERED" && va.medium === "video" && va.state === "OPEN" && (await prisma.smartTask.count({ where: { projectId: V.project.id } })) === 0, JSON.stringify({ r5, m: va.medium, s: va.state }));

    // ======================================================================
    c.head("6 · the board: Waiting for upload first, then Editing; empty columns fold");
    // ======================================================================
    const UC = await prisma.client.create({ data: { name: "Upload Drill" } });
    const UP = await prisma.project.create({ data: { title: "120 Upload Way, Malvern, PA", addressLine: "120 Upload Way", clientId: UC.id, shootDate: new Date(Date.now() - DAY) } as never });
    const UJ = await prisma.photoJob.create({ data: { projectId: UP.id, stage: "EDITING" } });
    const q6 = await data.loadQueue({ holding: true, viewer: { readOnly: false } } as never);
    c.ok("the first column is Waiting for upload, then Editing", q6.columns[0].key === "upload" && q6.columns[0].label === "Waiting for upload" && q6.columns[1].key === "editing" && q6.columns[1].label === "Editing", q6.columns.map((x) => `${x.key}:${x.label}`).join());
    c.ok("…the job with no raws yet sits in Waiting for upload (its stage is still Editing)", q6.columns[0].cards.some((x) => x.id === UJ.id) && !q6.columns[1].cards.some((x) => x.id === UJ.id) && (await stageOf(UJ.id)) === "EDITING");
    const { QueueBoard } = await import("@/components/photoDelivery/QueueBoard");
    const bh = html(createElement(QueueBoard, { data: q6 }));
    const sections = [...bh.matchAll(/<section\b[^>]*data-column="([a-z]+)"[^>]*>/g)].map((m) => ({ key: m[1], tag: m[0] }));
    const emptyKeys: string[] = q6.columns.filter((col) => col.cards.length === 0).map((col) => col.key);
    c.ok("every column is drawn, in order", sections.map((s) => s.key).join() === q6.columns.map((x) => x.key).join(), sections.map((s) => s.key).join());
    c.ok("an empty column folds to a narrow strip on a computer (its name runs down the strip)", emptyKeys.length > 0 && sections.filter((s) => emptyKeys.includes(s.key)).every((s) => /data-empty=""/.test(s.tag) && /lg:w-11/.test(s.tag)) && /lg:\[writing-mode:vertical-rl\]/.test(bh), emptyKeys.join());
    c.ok("…a column with jobs keeps its full width", sections.filter((s) => !emptyKeys.includes(s.key)).every((s) => !/data-empty/.test(s.tag) && /lg:min-w-\[15rem\]/.test(s.tag)));

    // ======================================================================
    c.head("7 · Undo Check again");
    // ======================================================================
    let seq = 0;
    const mkJob = async (street: string, rooms: string[]) => {
      const client = await prisma.client.create({ data: { name: `Client ${street}` } });
      const project = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id, shootDate: new Date(Date.now() - 2 * DAY) } as never });
      const key = street.split(" ")[0];
      const shoot = fake.seedShoot({ address: street, photos: rooms.map((_, i) => ({ name: `${key}-${i + 1}.jpg` })) });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "EDITED", autohdrPhotoshootId: shoot.photoshoot_id, autohdrCreatedAt: new Date(), expectedJson: JSON.stringify({ requestedFeatures: [], source: {} }) } });
      const photos = [];
      for (let i = 0; i < rooms.length; i++) {
        const ph2 = shoot.photos[i];
        photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name: ph2.name, sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${ph2.image_uuid}`, autohdrImageUuid: ph2.image_uuid, autohdrVersionUuid: ph2.head, contentHash: `h${seq++}`, sequence: i, status: "ACTIVE", width: 6000, height: 4000, format: "jpeg" } }));
      }
      return { job, photos, project, client };
    };
    const runCheck = async (jobId: string) => {
      for (let i = 0; i < 6; i++) {
        const r = await check.driveAutohdrChecks({ budgetMs: 60_000, maxJobs: 5 });
        if (r.jobs.some((j) => j.jobId === jobId && j.finished)) return true;
      }
      return false;
    };
    const runsOf = (jobId: string) => prisma.photoQcRun.findMany({ where: { jobId, trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "asc" } });
    const openIds = async (jobId: string) => (await prisma.photoQcFinding.findMany({ where: { jobId, status: "OPEN" }, select: { id: true } })).map((f) => f.id).sort().join();

    const U = await mkJob("40 Undo Ln", ["kitchen", "living"]);
    answers.set("40-1.jpg", { room: "kitchen", issues: [{ id: "KIT_EXCESSIVE_COUNTERTOP_ITEMS", where: "counter by the sink", confidence: 0.9 }] });
    answers.set("40-2.jpg", { room: "living room" });
    c.ok("the first check ran", await runCheck(U.job.id));
    const [r1] = await runsOf(U.job.id);
    const open1 = await openIds(U.job.id);
    c.ok("…it found the counter clutter", r1?.status === "DONE" && open1.length > 0, `${r1?.status} ${open1}`);
    c.ok("no Check again yet: nothing to undo", (await undo.recheckUndoOf(U.job.id)) === null);

    // a) Undo before the check ran.
    const req1 = await check.requestFreeRecheck(U.job.id, "Kyle Smith");
    c.ok("Check again says it can be undone", req1.ok && /You can undo it\./.test(req1.message), req1.message);
    const offer1 = await undo.recheckUndoOf(U.job.id);
    c.ok("…the job page offers Undo: who pressed it, not run yet", offer1?.by === "Kyle Smith" && offer1.ran === false && /^Kyle Smith pressed Check again /.test(offer1.words), JSON.stringify(offer1));
    c.ok("…the photos read not inspected", (await prisma.photoAsset.count({ where: { jobId: U.job.id, inspectedHash: null } })) === 2);
    const u1 = await undo.undoFreeRecheck(U.job.id, "Kyle Smith");
    c.ok("Undo before it ran: the check will not run", u1.ok && u1.message === "Undone. The check will not run again.", u1.message);
    c.ok("…the photos are inspected again at their version", (await prisma.photoAsset.findMany({ where: { jobId: U.job.id } })).every((p) => p.inspectedHash === p.contentHash));
    await check.driveAutohdrChecks({ budgetMs: 60_000, maxJobs: 5 });
    c.ok("…the next pass does not run it", (await runsOf(U.job.id)).length === 1 && (await openIds(U.job.id)) === open1);
    c.ok("…and Undo is not offered again", (await undo.recheckUndoOf(U.job.id)) === null && !(await undo.undoFreeRecheck(U.job.id, "Kyle Smith")).ok);

    // b) Undo after it ran: the earlier check's results come back.
    answers.set("40-1.jpg", { room: "kitchen", issues: [{ id: "KIT_DISHES_ON_COUNTERS", where: "dishes in the sink", confidence: 0.9 }] });
    await new Promise((r) => setTimeout(r, 20));
    await check.requestFreeRecheck(U.job.id, "Kyle Smith");
    c.ok("Check again ran", await runCheck(U.job.id));
    const runs2 = await runsOf(U.job.id);
    const r2 = runs2[runs2.length - 1];
    const open2 = await openIds(U.job.id);
    c.ok("…a second check with different results", runs2.length === 2 && r2.status === "DONE" && open2 !== open1, `${runs2.length} ${open2} vs ${open1}`);
    c.ok("…Undo is still offered, and says it ran", (await undo.recheckUndoOf(U.job.id))?.ran === true);
    const u2 = await undo.undoFreeRecheck(U.job.id, "Kyle Smith");
    const j2b = await prisma.photoJob.findUniqueOrThrow({ where: { id: U.job.id } });
    const r2b = await prisma.photoQcRun.findUniqueOrThrow({ where: { id: r2.id } });
    c.ok("Undo after it ran: the earlier check's results are back", u2.ok && u2.message === "Undone. The earlier check's results are back." && (await openIds(U.job.id)) === open1, `${u2.message} ${await openIds(U.job.id)} vs ${open1}`);
    c.ok("…the new check is set aside (its run says so; its findings superseded)", r2b.status === "FAILED" && /^Undone by Kyle Smith: the earlier check stands\./.test(r2b.error ?? "") && (await prisma.photoQcFinding.count({ where: { qcRunId: r2.id, status: { not: "SUPERSEDED" } } })) === 0);
    c.ok("…the job reads the earlier check again", j2b.lastQcRunId === r1.id);
    c.ok("…the photos are inspected at their version (no 'not inspected')", (await prisma.photoAsset.findMany({ where: { jobId: U.job.id } })).every((p) => p.inspectedHash === p.contentHash));
    await check.driveAutohdrChecks({ budgetMs: 60_000, maxJobs: 5 });
    c.ok("…and the next pass leaves it", (await runsOf(U.job.id)).length === 2);

    // c) Refused once a person decided an issue the new check found.
    await new Promise((r) => setTimeout(r, 20));
    await check.requestFreeRecheck(U.job.id, "Kyle Smith");
    c.ok("Check again ran once more", await runCheck(U.job.id));
    const runs3 = await runsOf(U.job.id);
    const r3run = runs3[runs3.length - 1];
    const f3 = await prisma.photoQcFinding.findFirst({ where: { qcRunId: r3run.id, status: "OPEN" } });
    c.ok("…it found something to decide", !!f3);
    if (f3) await prisma.photoQcFinding.update({ where: { id: f3.id }, data: { status: "IGNORED", decidedBy: "Kyle Smith", decidedAt: new Date(), statusReason: "Not worth fixing" } });
    const u3 = await undo.undoFreeRecheck(U.job.id, "Kyle Smith");
    c.ok("Undo is refused once Kyle decided an issue the new check found (nothing changed)", !u3.ok && /Someone already decided an issue the new check found/.test(u3.message) && (await prisma.photoQcRun.findUniqueOrThrow({ where: { id: r3run.id } })).status === "DONE", u3.message);
    const jd = (await data.loadJobDetail(U.job.id, { viewer: kyleView as never }))!;
    c.ok("the job page carries the offer (Undo bar data), view only never", !!jd.recheckUndo && (await data.loadJobDetail(U.job.id, { viewer: { role: "ADMIN", name: "James", isOwner: false, canSeeMoney: false, readOnly: true } as never }))?.recheckUndo == null);
    const hp = src("src/components/photoDelivery/HoldingPanel.tsx");
    c.ok("…the Undo bar: the words, what Undo does, the button (undoRecheckAction)", /data-recheck-undo/.test(hp) && /Undo brings back the earlier check's results\./.test(hp) && /undoRecheckAction\(jobId\)/.test(hp));

    // ======================================================================
    c.head("8 · the free check judges only the house being shot");
    // ======================================================================
    c.ok("the house number from the listing's title", check.houseNumberOf("913 Lakeview Dr, Malvern, PA") === "913" && check.houseNumberOf("12B Elm St") === "12" && check.houseNumberOf("Lakeview Dr") === null);
    c.ok("another house's number in the place: a neighbor's", check.namesOtherHouse("bottom left porch of 914", "913") && check.namesOtherHouse("914's driveway", "913") && check.namesOtherHouse("in front of house 911", "913"));
    c.ok("…its own number, or a number that is not a house: not", !check.namesOtherHouse("porch of 913", "913") && !check.namesOtherHouse("leaning about 4 degrees", "913") && !check.namesOtherHouse("bottom left porch", "913") && !check.namesOtherHouse("porch of 914", null));
    const screen = check.screenIssues({ room: "front exterior", issues: [
      { ruleId: "EXT_PARKED_CARS_DRIVEWAY", where: "silver car in the driveway", confidence: 0.9, property: "neighbor" },
      { ruleId: "PREP_DOOR_MAT_CROOKED", where: "bottom left porch of 914", confidence: 0.8 },
      { ruleId: "PREP_CROOKED_RUGS_FURNITURE_DECOR", where: "decor on the house on the left", confidence: 0.8 },
      { ruleId: "EXT_TRASH_CANS_PRIMARY", where: "bins by this home's garage", confidence: 0.9, property: "this_home" },
      { ruleId: "PERSP_EXTERIOR_WALLS_LEANING", where: "the house next door leans too", confidence: 0.9, property: "neighbor" },
    ] }, { houseNumber: "913" });
    c.ok("the screen drops the neighbor's car (said neighbor), the porch of 914, the house on the left", ["EXT_PARKED_CARS_DRIVEWAY", "PREP_DOOR_MAT_CROOKED", "PREP_CROOKED_RUGS_FURNITURE_DECOR"].every((id) => screen.dropped.some((d) => d.ruleId === id && d.why === "on a neighbor's property")), JSON.stringify(screen.dropped));
    c.ok("…keeps this home's bins, and a lean is never a neighbor's (lines are about the photo)", screen.kept.some((k) => k.ruleId === "EXT_TRASH_CANS_PRIMARY") && screen.kept.some((k) => k.ruleId === "PERSP_EXTERIOR_WALLS_LEANING"), JSON.stringify(screen.kept));
    c.ok("'the left side of the house' is still this home", !check.NEIGHBOR_RE.test("trash can on the left side of the house") && check.NEIGHBOR_RE.test("car in front of the house on the right"));
    const parsed = check.parseCheckAnswer('{"room":"front exterior","issues":[{"id":"EXT_PARKED_CARS_DRIVEWAY","where":"car","property":"Neighbour","confidence":0.9},{"id":"EXT_TRASH_CANS_PRIMARY","where":"bins","property":"this home","confidence":0.9}]}');
    c.ok("the answer's property is read (neighbour, this home)", parsed?.issues[0].property === "neighbor" && parsed.issues[1].property === "this_home", JSON.stringify(parsed?.issues));
    const prompt = check.checkPrompt(new Set(), [], { address: "913 Lakeview Dr, Malvern, PA" });
    c.ok("the question names the house: its address, the middle of the frame, its number", /The home being photographed is 913 Lakeview Dr: the house at that address, usually the one in the middle of the frame\./.test(prompt) && /A house number you can read that is not 913 is a neighbor's house\./.test(prompt) && /"property":"this_home\|neighbor"/.test(prompt));
    c.ok("…and asks for a photo taken looking up (walls leaning in, the house tipping back)", /taken looking up/.test(prompt) && /PERSP_EXTERIOR_WALLS_LEANING: [^\n]*looking up/.test(prompt) && /PERSP_CROOKED_VERTICALS: [^\n]*tilted up or down/.test(prompt) && check.CHECK_PROMPT_VERSION >= 6);
    c.ok("…no em dashes in it", !DASH.test(prompt));

    // End to end through the check.
    const K = await mkJob("913 Lakeview Dr", ["front", "front2"]);
    answers.set("913-1.jpg", { room: "front exterior", view: "wide", issues: [
      { id: "EXT_PARKED_CARS_DRIVEWAY", where: "car in the driveway", confidence: 0.9, property: "neighbor" },
      { id: "PREP_DOOR_MAT_CROOKED", where: "bottom left porch of 914", confidence: 0.8 },
      { id: "PERSP_EXTERIOR_WALLS_LEANING", where: "the house's walls lean in", confidence: 0.85, property: "this_home" },
    ] });
    answers.set("913-2.jpg", { room: "front exterior", view: "wide", issues: [{ id: "EXT_PARKED_CARS_DRIVEWAY", where: "car in this home's driveway", confidence: 0.9, property: "this_home" }] });
    c.ok("913 Lakeview checked", await runCheck(K.job.id));
    const kPrompt = prompts.filter((p) => p.name === "913-1.jpg").pop()?.prompt ?? "";
    c.ok("…the question named 913 Lakeview Dr", /The home being photographed is 913 Lakeview Dr:/.test(kPrompt));
    const kf = await prisma.photoQcFinding.findMany({ where: { jobId: K.job.id, status: { not: "SUPERSEDED" } } });
    c.ok("…the neighbor's car and the porch of 914 are not issues", !kf.some((f) => f.photoId === K.photos[0].id && ["EXT_PARKED_CARS_DRIVEWAY", "PREP_DOOR_MAT_CROOKED"].includes(f.ruleId)), kf.map((f) => `${f.ruleId}@${f.photoId === K.photos[0].id ? 1 : 2}`).join());
    c.ok("…the lean is, and a car in this home's own driveway still is", kf.some((f) => f.photoId === K.photos[0].id && f.ruleId === "PERSP_EXTERIOR_WALLS_LEANING") && kf.some((f) => f.photoId === K.photos[1].id && f.ruleId === "EXT_PARKED_CARS_DRIVEWAY"), kf.map((f) => f.ruleId).join());
    const kRun = (await runsOf(K.job.id)).pop()!;
    const kScreened = check.readProgress(kRun.checksJson).screened?.[K.photos[0].id] ?? [];
    c.ok("…the run says what it dropped and why", kScreened.filter((s) => s.why === "on a neighbor's property").length === 2, JSON.stringify(kScreened));

    // ======================================================================
    c.head("9 · a strong measured lean is a real issue; a slight one is advisory");
    // ======================================================================
    const GC = await prisma.client.create({ data: { name: "Geo Drill" } });
    const GP = await prisma.project.create({ data: { title: "9 Tilt Ter, Malvern, PA", addressLine: "9 Tilt Ter", clientId: GC.id } as never });
    const GJ = await prisma.photoJob.create({ data: { projectId: GP.id, stage: "QC_REVIEW" } });
    const g1 = await prisma.photoAsset.create({ data: { jobId: GJ.id, name: "01-Front.jpg", sourceKind: "ARYEO", sourceRef: "g1", contentHash: "g-h1", sequence: 0, status: "ACTIVE" } });
    const g2 = await prisma.photoAsset.create({ data: { jobId: GJ.id, name: "02-Living.jpg", sourceKind: "ARYEO", sourceRef: "g2", contentHash: "g-h2", sequence: 1, status: "ACTIVE" } });
    const m = (tilt: number) => ({ m: { lines: 10, tilt, bent: 0, bow: 0, crooked: true, warped: false, words: `measured, leaning ${tilt.toFixed(1)}°, no bent lines` } });
    const gRun = await prisma.photoQcRun.create({ data: { jobId: GJ.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "drill", checksJson: JSON.stringify({ done: {}, errors: {}, skipped: [], rooms: {}, geometry: { [g1.id]: m(4.2), [g2.id]: m(1.6) } }) } as never });
    const gr = await geometry.geometryJob(GJ.id, gRun.id, Date.now() + 60_000);
    const floor = (await photoDeliverySettings()).displayConfidenceFloor;
    const cv1 = await prisma.photoQcFinding.findFirst({ where: { jobId: GJ.id, photoId: g1.id, source: "CV" } });
    const cv2 = await prisma.photoQcFinding.findFirst({ where: { jobId: GJ.id, photoId: g2.id, source: "CV" } });
    c.ok("measured", gr.done, JSON.stringify(gr));
    c.ok("leaning 4.2° (3° or more) that the check did not name: a major issue, shown, with what to do", cv1?.ruleId === "PERSP_CROOKED_VERTICALS" && cv1.severity === "MAJOR" && cv1.confidence >= Math.max(0.8, floor) && /strong lean/.test(cv1.explanation) && /Crop & Tilt/.test(cv1.explanation) && JSON.parse(cv1.coercedJson ?? "{}").measured === "only-strong", `${cv1?.severity} ${cv1?.confidence} ${cv1?.explanation}`);
    c.ok("leaning 1.6°: advisory as before (minor, below the floor)", cv2?.severity === "MINOR" && cv2.confidence < floor && /Only the measured line check saw this/.test(cv2.explanation), `${cv2?.severity} ${cv2?.confidence}`);
    c.ok("…the threshold is 3°", geometry.STRONG_LEAN_DEG === 3);

    // ======================================================================
    c.head("10 · the 913 Lakeview live repair: a dry run by default, never a new task");
    // ======================================================================
    const live = src("scripts/_live/oct27-loom-913-lakeview.ts");
    c.ok("it starts with the dry-run guard", live.startsWith('import { APPLY, db } from "./_oct22-guard";'));
    c.ok("…writes only after the dry-run line, and never makes a task or sends anything", live.indexOf('if (!APPLY) { console.log("dry run: nothing written') > 0 && live.indexOf('if (!APPLY) { console.log("dry run: nothing written') < live.indexOf("await setStage(") && !/smartTask\.create|sendSms|sendEmail|openphone|postSlack/i.test(live));
    c.ok("…refuses when a request since delivery is not plainly office work, or Kyle's Showcase task is not there", /REFUSED: \$\{notOffice\.length\}/.test(live) && /REFUSED: no open Showcase task/.test(live));

    c.head("isolation");
    c.ok("nothing left the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
