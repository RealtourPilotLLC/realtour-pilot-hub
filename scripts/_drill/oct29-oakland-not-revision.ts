// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: NEW WORK IS NOT A REVISION (Oct 29 2026, 4008 Oakland Rd).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct29-oakland-not-revision.ts
//
// Jordan, on two Creative review cards for Nehemiah Lindo: "Why is this coming
// up? I don't think it's needed". His texts ("I need photos and reel", "we
// need better photos") and his call ordering a new shoot matched the July
// photos-only job and each became a revision there, with a creative review
// for a reel that job never had.
//   1. the rule (lib/revisionTarget): a video ask on a job with no video, and a
//      photo ask (or an unclear one on a job with no video) more than 30 days
//      after delivery, are new work; a video job still reopens;
//   2. a message: the old job is not reopened, its photos are not reopened,
//      the words go on the new job at that street, the office has a to-do;
//      a recent photo job and an old video job still get their revision;
//   3. a work order that is only new work (every item SCOPE, none of it
//      photos) goes to Kyle as a new request, the job back to Delivered, no
//      creative review; new photo work keeps the photo job's office question;
//   4. creative review: never on a job with no video; "round two" needs an
//      earlier version; Marcee's "can't say what's wrong" still held;
//   5. a review on a revision a person dismissed closes on its own; one the
//      lane merged away does not.
// ISOLATION: PGlite; the brain stubbed at its one function; the analyser
// answered in-process; no text, email or call leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7343);
const DAY = 86_400_000;

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

type Item = { area: string; ask: string; kind: string; detail: string; quote: string; scope: string; videos: string[]; medium?: string };
let nextItems: Item[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    if (String(body.messages?.[0]?.content ?? "").includes("--- WHAT THE CLIENT SAID ---")) {
      return json({ content: [{ type: "tool_use", name: "emit", input: { headline: "Client asked for changes", items: nextItems, keep: [], references: [], questions: [] } }] });
    }
    return json({ content: [{ type: "text", text: "{}" }] });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});
const item = (p: Partial<Item> & { ask: string }): Item => ({ area: "Other", kind: "CORRECTION", detail: "", quote: "", scope: "all", videos: [], ...p });

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("ai", "drill-ai-key-not-real");
    const now = new Date();
    const ago = (d: number) => new Date(now.getTime() - d * DAY);

    // =====================================================================
    c.head("1 · The rule");
    // =====================================================================
    const T = await import("@/lib/revisionTarget");
    const v = (medium: "video" | "photo" | "unclear", hasVideo: boolean, days: number | null) =>
      T.revisionTargetVerdict({ medium, hasVideo, deliveredAt: days == null ? null : ago(days), now });
    const noVid = v("video", false, 3);
    c.ok("a video ask on a job with no video: new work, saying why", !noVid.revise && /had no video to change/.test(noVid.why), JSON.stringify(noVid));
    const oldPhotos = v("photo", false, 105);
    c.ok("a photo ask 105 days after delivery: new work, with the days", !oldPhotos.revise && /delivered 105 days ago/.test(oldPhotos.why), JSON.stringify(oldPhotos));
    c.ok("an unclear ask on an old photos-only job: new work", !v("unclear", false, 40).revise);
    c.ok("a photo ask on an old photos-and-video job: new work too", !v("photo", true, 40).revise);
    c.ok("a video ask on an old video job: still a revision (the video can change)", v("video", true, 70).revise);
    c.ok("an unclear ask on an old video job: still a revision (the video is the likely subject)", v("unclear", true, 35).revise);
    c.ok("a photo ask within 30 days, or on a job not delivered: a revision", v("photo", false, 30).revise && v("photo", false, 3).revise && v("photo", false, null).revise);
    c.ok("one street, two spellings", T.streetOf("4008 Oakland  Rd, Coopersburg, PA") === T.streetOf("4008 Oakland Rd, Coopersburg, PA 18036") && T.streetOf(null) === "");
    const core = await import("@/lib/creativeReviewCore");
    c.ok("every item new work: allNewWork", core.allNewWork([{ kind: "SCOPE", ask: "Book photos and floor plans" }, { kind: "SCOPE", ask: "Add a reel with agent intro" }]));
    c.ok("one real change among them, or nothing at all: not all new work", !core.allNewWork([{ kind: "SCOPE", ask: "Add a reel" }, { kind: "CORRECTION", ask: "Fix the name" }]) && !core.allNewWork([]));
    c.ok("a feeling labelled SCOPE is still unclear direction, so not new work", !core.allNewWork([{ kind: "SCOPE", ask: "I don't know how to explain it, it feels flat" }]));

    // =====================================================================
    c.head("2 · A message about a job with nothing to revise");
    // =====================================================================
    const { recordClientCommunication, askMedium } = await import("@/lib/comms");
    const neh = await prisma.client.create({ data: { name: "Nehemiah Drill", phone: "(610) 555-0177" }, select: { id: true, name: true } });
    const july = await prisma.project.create({
      data: { title: "4008 Oakland Rd, Coopersburg, PA", clientId: neh.id, status: "DELIVERED", deliveredAt: ago(105), shootDate: ago(108), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25, status: "DONE" }] } },
      select: { id: true },
    });
    await prisma.photoJob.create({ data: { projectId: july.id, stage: "DELIVERED", deliveredAt: ago(105) } });
    const nov = await prisma.project.create({
      data: { title: "4008 Oakland Rd, Coopersburg, PA 18036", clientId: neh.id, status: "BOOKED", shootDate: new Date(now.getTime() + 5 * DAY), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25 }, { type: "SOCIAL_REEL", label: "Standard Reel" }] } },
      select: { id: true },
    });
    const decide = (projectId: string, asks: Ask[] = [], actionable = true): Decision => ({
      actionable, projectId, title: "Client wants new photos", detail: "", priority: "HIGH", mergeIntoTaskId: null,
      isRevisionRequest: true, flags: [], reason: "revision", taskType: "client_reply", asks,
    });
    const say = async (client: { id: string; name: string }, projectId: string, text: string, d: Decision) => {
      nextDecision = d;
      await recordClientCommunication({ clientId: client.id, clientName: client.name, projectId, projectStatus: "DELIVERED", text, kind: "text", source: "openphone", contactName: client.name });
    };
    const better = "We did these already but we need better photos";
    c.ok("(the words read as a photo ask)", askMedium(better) === "photo");
    await say(neh, july.id, better, decide(july.id, [{ kind: "SPECIAL_REQUEST", text: better, summary: "Better photos", medium: "photo", projectHint: null }]));
    const jul = await prisma.project.findUniqueOrThrow({ where: { id: july.id }, select: { status: true } });
    const revs = await prisma.smartTask.count({ where: { projectId: july.id, taskType: "revision" } });
    c.ok("the July job is not reopened: still Delivered, no revision, no work order", jul.status === "DELIVERED" && revs === 0 && (await prisma.revisionBrief.count({ where: { projectId: july.id } })) === 0, JSON.stringify({ jul, revs }));
    const line = await prisma.activity.findFirst({ where: { projectId: july.id, body: { startsWith: "Not filed as a revision" } }, select: { body: true } });
    c.ok("its timeline says why, and where the words went", /^Not filed as a revision on 4008 Oakland Rd: this job was delivered 105 days ago/.test(line?.body ?? "") && /went on 4008 Oakland Rd, the job that is not delivered yet/.test(line?.body ?? ""), line?.body ?? "(none)");
    const pj = await prisma.photoJob.findUniqueOrThrow({ where: { projectId: july.id }, select: { stage: true } });
    c.ok("its photos are not reopened and no photo ask is filed on it", pj.stage === "DELIVERED" && (await prisma.clientAsk.count({ where: { projectId: july.id } })) === 0, pj.stage);
    c.ok("the words are on the new job's requests", !!(await prisma.activity.findFirst({ where: { projectId: nov.id, type: "SPECIAL_REQUEST", body: { contains: better } } })));
    c.ok("the office has it as a to-do", (await prisma.smartTask.count({ where: { clientId: neh.id, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } } })) >= 1);
    // (Naming the street here would match both jobs at it: the hub asks the
    // office which one, before any of this.)
    const reel = "Can you make a reel too";
    await say(neh, july.id, reel, decide(july.id));
    const reelLine = await prisma.activity.findFirst({ where: { projectId: july.id, body: { contains: "had no video to change" } }, select: { body: true } });
    c.ok("a reel ask on the photos-only job: new work, saying the job had no video", !!reelLine && (await prisma.smartTask.count({ where: { projectId: july.id, taskType: "revision" } })) === 0, reelLine?.body ?? "(none)");

    const ana = await prisma.client.create({ data: { name: "Ana Drill", phone: "(610) 555-0178" }, select: { id: true, name: true } });
    const elm = await prisma.project.create({
      data: { title: "9 Elm St, Media, PA", clientId: ana.id, status: "DELIVERED", deliveredAt: ago(60), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25, status: "DONE" }] } },
      select: { id: true },
    });
    await say(ana, elm.id, "Can you redo the kitchen photos", decide(elm.id, [], false));
    const own = await prisma.smartTask.findFirst({ where: { clientId: ana.id, taskType: "client_reply" }, select: { title: true, summary: true, projectId: true } });
    c.ok("no newer job and no to-do from the brain: one made, \"New request\", on no job", /^New request — 9 Elm St/.test(own?.title ?? "") && own?.projectId === null && /Not a change to what was delivered/.test(own?.summary ?? ""), JSON.stringify(own));

    nextItems = [item({ area: "Color & styling", ask: "Brighten the kitchen", kind: "CORRECTION", medium: "photo" })];
    const recent = await prisma.project.create({
      data: { title: "21 Birch Ln, Media, PA", clientId: ana.id, status: "DELIVERED", deliveredAt: ago(3), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25, status: "DONE" }] } },
      select: { id: true },
    });
    await say(ana, recent.id, "Can you brighten the kitchen photos", decide(recent.id));
    c.ok("a photo job delivered 3 days ago: the revision is raised as before", (await prisma.smartTask.count({ where: { projectId: recent.id, taskType: { in: ["revision", "client_reply"] } } })) >= 1 && (await prisma.revisionBrief.count({ where: { projectId: recent.id } })) === 1);
    nextItems = [item({ area: "Cuts & content", ask: "Change the opening line", kind: "REFINEMENT" })];
    const oldVid = await prisma.project.create({
      data: { title: "632 Greenridge Rd, Media, PA", clientId: ana.id, status: "DELIVERED", deliveredAt: ago(35), deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Reel", status: "DONE" }] } },
      select: { id: true },
    });
    const opening = "Can you change the opening line";
    c.ok("(the words name neither photos nor video)", askMedium(opening) === "unclear");
    await say(ana, oldVid.id, opening, decide(oldVid.id));
    c.ok("a video job delivered 35 days ago, an unclear ask: still its revision", (await prisma.revisionBrief.count({ where: { projectId: oldVid.id } })) === 1 && !(await prisma.activity.findFirst({ where: { projectId: oldVid.id, body: { startsWith: "Not filed as a revision" } } })));

    // =====================================================================
    c.head("3 · A work order that is only new work");
    // =====================================================================
    const rb = await import("@/lib/revisionBrief");
    const scopeJob = await prisma.project.create({
      data: { title: "512 Firethorn Rd, Media, PA", clientId: ana.id, status: "REVISION", deliveredAt: ago(10), revisionRequestedAt: now, deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25, status: "DONE" }] } },
      select: { id: true },
    });
    const scopeTask = await prisma.smartTask.create({ data: { taskType: "revision", status: "OPEN", assignedKey: "kyle", projectId: scopeJob.id, clientId: ana.id, title: "Photo revision — 512 Firethorn Rd", source: "openphone", priority: "URGENT" } });
    const scopeBrief = await prisma.revisionBrief.create({ data: { projectId: scopeJob.id, source: "openphone", originalText: "Add a Zillow 3D tour and a reel with my intro", taskId: scopeTask.id } });
    nextItems = [item({ ask: "Add a Zillow 3D tour", kind: "SCOPE", medium: "unclear" }), item({ ask: "Make a reel with the agent intro", kind: "SCOPE", medium: "video" })];
    await rb.analyzeBrief(scopeBrief.id);
    const st = await prisma.smartTask.findUniqueOrThrow({ where: { id: scopeTask.id }, select: { taskType: true, title: true, assignedKey: true, summary: true } });
    c.ok("the revision becomes a new request on Kyle's list", st.taskType === "client_reply" && /^New request — 512 Firethorn Rd/.test(st.title) && st.assignedKey === "kyle" && /new work, not a change to what was delivered/.test(st.summary ?? ""), JSON.stringify(st));
    c.ok("the job goes back to Delivered, saying why", (await prisma.project.findUniqueOrThrow({ where: { id: scopeJob.id } })).status === "DELIVERED" && !!(await prisma.activity.findFirst({ where: { projectId: scopeJob.id, body: { startsWith: "Client message asked only for new work" } } })));
    c.ok("no creative review, no photo ask from it", !core.creativeReviewOf((await prisma.revisionBrief.findUniqueOrThrow({ where: { id: scopeBrief.id } })).itemsJson) && (await prisma.smartTask.count({ where: { projectId: scopeJob.id, taskType: "creative_review" } })) === 0 && (await prisma.clientAsk.count({ where: { projectId: scopeJob.id } })) === 0);
    const mixedJob = await prisma.project.create({
      data: { title: "47 Venuti Dr, Media, PA", clientId: ana.id, status: "REVISION", deliveredAt: ago(5), revisionRequestedAt: now, deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Reel", status: "DONE" }] } },
      select: { id: true },
    });
    const mixedTask = await prisma.smartTask.create({ data: { taskType: "revision", status: "OPEN", assignedKey: "john", projectId: mixedJob.id, clientId: ana.id, title: "Video revision — 47 Venuti Dr", source: "openphone", priority: "URGENT" } });
    const mixedBrief = await prisma.revisionBrief.create({ data: { projectId: mixedJob.id, source: "openphone", originalText: "Fix my name on the end card and make a vertical version too", taskId: mixedTask.id } });
    nextItems = [item({ area: "Text", ask: "Fix the name on the end card", kind: "CORRECTION" }), item({ ask: "Make a vertical version", kind: "SCOPE" })];
    await rb.analyzeBrief(mixedBrief.id);
    const stageJob = await prisma.project.create({
      data: { title: "2865 Greenleaf Ct, Media, PA", clientId: ana.id, status: "REVISION", deliveredAt: ago(2), revisionRequestedAt: now, deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25, status: "DONE" }] } },
      select: { id: true },
    });
    const stageTask = await prisma.smartTask.create({ data: { taskType: "revision", status: "OPEN", assignedKey: "kyle", projectId: stageJob.id, clientId: ana.id, title: "Photo revision — 2865 Greenleaf Ct", source: "openphone", priority: "URGENT" } });
    const stageBrief = await prisma.revisionBrief.create({ data: { projectId: stageJob.id, source: "openphone", originalText: "Can you virtually stage photo 12", taskId: stageTask.id } });
    nextItems = [item({ area: "Graphics & effects", ask: "Virtually stage photo 12", kind: "SCOPE", medium: "photo" })];
    await rb.analyzeBrief(stageBrief.id);
    c.ok("new PHOTO work keeps its own road (the photo job's question for Jordan or Kyle), not a \"New request\"", !/^New request/.test((await prisma.smartTask.findUniqueOrThrow({ where: { id: stageTask.id } })).title));
    c.ok("a real change beside the new work: still the editor's revision", (await prisma.smartTask.findUniqueOrThrow({ where: { id: mixedTask.id } })).taskType === "revision" && (await prisma.project.findUniqueOrThrow({ where: { id: mixedJob.id } })).status === "REVISION");

    // =====================================================================
    c.head("4 · Creative review: a video to review, and a round to compare");
    // =====================================================================
    const cr = await import("@/lib/creativeReview");
    const brief = async (projectId: string, items: unknown[], questions: string[] = [], createdAt = now) =>
      prisma.revisionBrief.create({ data: { projectId, source: "openphone", originalText: "drill", createdAt, itemsJson: JSON.stringify({ items, questions }) } });
    const photoOnly = await prisma.project.create({
      data: { title: "4010 Oakland Rd, Coopersburg, PA", clientId: neh.id, status: "REVISION", deliveredAt: ago(2), deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 25, status: "DONE" }] } },
      select: { id: true },
    });
    const pb = await brief(photoOnly.id, [
      { id: "i1", area: "Overall direction", ask: "The reel just isn't it, I can't say what's wrong", kind: "DIRECTION_UNCLEAR", medium: "video" },
      { id: "i2", area: "Other", ask: "Add a reel with agent intro", kind: "SCOPE", medium: "video" },
    ], ["A reel was not part of this job. Is this a new order?"]);
    const pState = await cr.routeCreativeReview(pb.id);
    c.ok("a photos-only job: no creative review opens, whatever the items say", pState === null && (await prisma.smartTask.count({ where: { projectId: photoOnly.id, taskType: "creative_review" } })) === 0, JSON.stringify(pState));
    c.ok("…the kinds are still written, nothing held", (() => { const d = JSON.parse(pb.itemsJson!); return d.items.length === 2; })() && JSON.parse((await prisma.revisionBrief.findUniqueOrThrow({ where: { id: pb.id } })).itemsJson!).items.every((i: { held?: boolean; kind?: string }) => !i.held && !!i.kind));

    const vid = await prisma.project.create({
      data: { title: "15 Round Ct, Media, PA", clientId: ana.id, status: "REVISION", deliveredAt: ago(4), deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Reel", status: "DONE" }] } },
      select: { id: true, deliverables: { select: { id: true } } },
    });
    await brief(vid.id, [{ id: "i1", area: "Text", ask: "Fix the spelling", kind: "CORRECTION" }], [], ago(2));
    const r1 = await brief(vid.id, [{ id: "i1", area: "Overall direction", ask: "Make it more upbeat and modern", kind: "REFINEMENT" }], [], ago(1));
    const s1 = await cr.routeCreativeReview(r1.id);
    c.ok("an earlier ask but no version ever made: not a second round", !s1?.reasons.includes("ROUND_TWO_DIRECTION"), JSON.stringify(s1));
    await prisma.reviewSubmission.create({ data: { projectId: vid.id, deliverableId: vid.deliverables[0].id, slot: 1, round: 1, status: "CHANGES_REQUESTED", source: "upload", fileName: "v1.mp4", createdAt: ago(3) } });
    const r2 = await brief(vid.id, [{ id: "i1", area: "Overall direction", ask: "Make it more upbeat and modern", kind: "REFINEMENT" }]);
    const s2 = await cr.routeCreativeReview(r2.id);
    c.ok("with a version before the ask: round two wants a new direction, held for review", s2?.state === "OPEN" && s2.reasons.includes("ROUND_TWO_DIRECTION") && s2.heldItemIds.includes("i1"), JSON.stringify(s2));
    const marcee = await brief(vid.id, [{ id: "i1", area: "Pacing & movement", ask: "Change the pacing", quote: "I know I don't like something about it, but I wouldn't know how to tell someone to fix it", kind: "REFINEMENT" }]);
    const s3 = await cr.routeCreativeReview(marcee.id);
    c.ok("Marcee's \"I wouldn't know how to tell someone to fix it\" on a video: still held as unclear", s3?.state === "OPEN" && s3.reasons.includes("UNCLEAR"), JSON.stringify(s3));

    // =====================================================================
    c.head("5 · A review on a dismissed revision closes on its own");
    // =====================================================================
    const open = async (street: string, revStatus: "CANCELLED", summary: string | null) => {
      const p = await prisma.project.create({ data: { title: `${street}, Media, PA`, clientId: ana.id, status: "DELIVERED", deliveredAt: ago(1), deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Reel", status: "DONE" }] } }, select: { id: true } });
      const rev = await prisma.smartTask.create({ data: { taskType: "revision", status: revStatus, summary, assignedKey: "kyle", projectId: p.id, title: `Video revision — ${street}`, source: "openphone", priority: "HIGH" } });
      const items = { items: [{ id: "i1", area: "Overall direction", ask: "It feels flat", held: true, kind: "DIRECTION_UNCLEAR" }] };
      const b = await prisma.revisionBrief.create({ data: { projectId: p.id, source: "openphone", originalText: "It feels flat", taskId: rev.id, itemsJson: JSON.stringify(items) } });
      const task = await prisma.smartTask.create({ data: { taskType: "creative_review", status: "OPEN", assignedKey: "jordan", projectId: p.id, title: `Creative review — ${street}`, source: "creative_review", priority: "HIGH", dedupeKey: `creative-review:${b.id}` } });
      await prisma.revisionBrief.update({ where: { id: b.id }, data: { itemsJson: JSON.stringify({ ...items, creativeReview: { state: "OPEN", taskId: task.id, reviewerKey: "jordan", reviewerName: "Jordan", reasons: ["UNCLEAR"], heldItemIds: ["i1"], questions: [], taskHeld: true, openedAt: now.toISOString() } }) } });
      return { p, task };
    };
    const kyleSaid = await open("1 Dismissed Way", "CANCELLED", "Dismissed by Kyle Smith — not needed.");
    const merged = await open("2 Merged Way", "CANCELLED", null);
    const dry = await cr.closeSettledCreativeReviews({ dryRun: true });
    c.ok("a person dismissed its revision: listed, with the reason", dry.closed.some((x) => x.taskId === kyleSaid.task.id && x.why === "its revision was dismissed (not needed)"), JSON.stringify(dry.closed));
    c.ok("a revision the lane merged into another card: left open", !dry.closed.some((x) => x.taskId === merged.task.id));
    await cr.closeSettledCreativeReviews({ projectId: kyleSaid.p.id });
    c.ok("closed for real: the task completed, the timeline says why", (await prisma.smartTask.findUniqueOrThrow({ where: { id: kyleSaid.task.id } })).status === "COMPLETED" && !!(await prisma.activity.findFirst({ where: { projectId: kyleSaid.p.id, body: { startsWith: "Creative review closed on its own: its revision was dismissed (not needed)." } } })));

    // =====================================================================
    c.head("6 · Wiring and the live clean-up");
    // =====================================================================
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    const comms = read("src/lib/comms.ts");
    c.ok("the gate sits before the revision is raised", comms.indexOf("revisionTargetFor(anchorProjectId") > 0 && comms.indexOf("revisionTargetFor(anchorProjectId") < comms.indexOf("revision = await raiseRevision({"));
    c.ok("the photo step skips the job the gate turned away", /w\.projectId === newWorkOn\) continue;/.test(comms));
    const live = read("scripts/_live/oct29-oakland-not-revision.ts");
    c.ok("the live script: dry run by default, NOT_NEEDED through the hub's own path, an undo", /from "\.\/_oct22-guard"/.test(live) && /mode: "NOT_NEEDED"/.test(live) && /--undo/.test(live) && /claude: for Jordan/.test(live));

    c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
