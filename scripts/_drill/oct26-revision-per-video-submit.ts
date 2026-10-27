// ---------------------------------------------------------------------------
// DRILL: A CLIENT'S ASK IS ANSWERED BY ITS OWN VIDEOS (Oct 26 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct26-revision-per-video-submit.ts --logs <dir>
//
// Mike Flatley's portal notes (Oct 24) went to Kim as one client revision:
// video 2 (three numbered points over several lines) and video 4. Two faults:
//   · the work order kept only the FIRST line of the video 2 note ("I think
//     its great. Couple things:"), the three points only behind "Read their
//     full message" (revisionBrief.pinnedItems);
//   · Kim's version 2 of VIDEO 3 counted as the correction: the task went
//     "Corrected cut submitted — waiting on review" and the job back to
//     Review with both asks untouched (reviewCuts.correctedCutSubmitted).
//
//   1. a multi-line note: every line is on the editor's item, the request is
//      the client's (requestedByKind CLIENT, "Client requested changes")
//   2. a new version of another video: the ask stays OPEN, the job stays in
//      Revisions
//   3. video 2's fix alone: still OPEN (video 4 is owed)
//   4. video 4's fix too: "waiting on review", the job to Review
//   5. an ask that names no video, and the editor's own "this is the fix":
//      the rule as before
//
// ISOLATION: PGlite via the shared harness; every outbound call fenced.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5623);
installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const cd = await import("@/lib/clientDecisions");
  const rr = await import("@/app/review/actions");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { streamUrlFor, videoLaneRevisionWhere, correctedCutSubmitted, WAITING_ON_REVIEW_SUMMARY, slotKeyOf } = await import("@/lib/reviewCuts");
  const { pinnedItems } = await import("@/lib/revisionBrief");
  type PortalViewer = import("@/lib/portal").PortalViewer;

  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ standardVideo: "kim", premiumVideo: "kim", personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  let seq = 0;

  type World = { f: ContentMonthFixture; viewer: PortalViewer; videos: string[] };
  const world = async (name: string): Promise<World> => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: `${name} TEST`, package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10", owner: { email: `${slug}@example.com`, name } });
    await ensureOutputsForProject(f.projectId!);
    const videos: string[] = [];
    for (let slot = 1; slot <= 4; slot++) {
      const v = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot, status: "EDITING", title: `Video ${slot}` }, select: { id: true } });
      videos.push(v.id);
    }
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    return { f, videos, viewer: { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: `${slug}@example.com`, name, membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as PortalViewer };
  };
  const mkCut = async (w: World, slot: number, round: number) => {
    const row = await prisma.reviewSubmission.create({
      data: { projectId: w.f.projectId!, deliverableId: w.f.deliverableId, slot, round, status: "PENDING", fileName: `video${slot}-v${round}.mp4`, source: "upload", submittedByKey: "kim", videoId: w.videos[slot - 1], createdAt: new Date(Date.now() + seq++) },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
    return row.id;
  };
  const release = async (id: string) => {
    const r = await rr.approveCut(id);
    if (!r.ok) throw new Error(`release ${id}: ${r.message}`);
    await prisma.reviewSubmission.update({ where: { id }, data: { clientReleasedAt: new Date(), clientReleasedBy: "Portal publication" } });
    const { openReviewWindow } = await import("@/lib/reviewWindows");
    await openReviewWindow(id, { by: "Portal publication" });
  };
  const note = (w: World, sub: string, body: string, t = 7) =>
    prisma.portalComment.create({ data: { submissionId: sub, projectId: w.f.projectId!, enrollmentId: w.f.enrollmentId, timeSec: t, body, status: "OPEN", clientUserId: w.f.clientUserId }, select: { id: true } });
  const lane = async (projectId: string) => (await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId) }));
  // The job as the hourly status sweep leaves it once an ask is open (Mike's job read REVIEW → REVISION at 14:01).
  const inRevisions = (projectId: string) => prisma.project.update({ where: { id: projectId }, data: { status: "REVISION", revisionRequestedAt: new Date(), deliveredAt: null } });
  const statusOf = async (projectId: string) => (await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true } })).status;

  const MIKE_V2 = "I think its great. Couple things:\n\n1. What is the 2nd video going to entail? What direction are you thinking?\n\n2. I think starting with the guy that says F Real estate agents is a better attention grabbing start then the guy who just said he was in a rush. Thoughts?\n\n3. Are you in the kids in part two or not at all?\n\nLet me know what you think!";
  const MIKE_V4 = "Video looks great. One small change: a reel I made pops up on each hand for 2 seconds.";

  try {
    // ======================================================================
    c.head("1 · Mike's two notes: the whole note on the editor's list, filed as the client's");
    const M = await world("Mike Multi");
    const cuts: string[] = [];
    for (let s = 1; s <= 4; s++) { cuts.push(await mkCut(M, s, 1)); await release(cuts[s - 1]); }
    await note(M, cuts[3], MIKE_V4, 31);
    const r4 = await cd.requestChangesOnCut(M.viewer, cuts[3], "");
    await note(M, cuts[1], MIKE_V2, 101);
    const r2 = await cd.requestChangesOnCut(M.viewer, cuts[1], "");
    c.ok("both requests go", r4.ok && r2.ok, `${r4.message} | ${r2.message}`);
    const briefs = await prisma.revisionBrief.findMany({ where: { projectId: M.f.projectId! }, orderBy: { createdAt: "asc" } });
    const v2brief = briefs.find((b) => b.submissionId === cuts[1]);
    const v2items = JSON.parse(v2brief?.itemsJson ?? "{}").items as { ask: string; cuts: string[] }[];
    c.ok("video 2's item carries every line: the lead-in and points 1, 2 and 3", v2items?.length === 1 && /Couple things:/.test(v2items[0].ask) && /1\. What is the 2nd video/.test(v2items[0].ask) && /2\. I think starting with the guy/.test(v2items[0].ask) && /3\. Are you in the kids/.test(v2items[0].ask) && /Let me know what you think!/.test(v2items[0].ask), JSON.stringify(v2items));
    c.ok("…pinned to video 2 only", v2items?.[0]?.cuts?.join() === slotKeyOf(M.f.deliverableId!, 2));
    c.ok("both briefs are the client's (requestedBy Mike, kind CLIENT, from the portal)", briefs.length === 2 && briefs.every((b) => b.requestedByKind === "CLIENT" && b.requestedBy === "Mike Multi" && b.source === "portal"), JSON.stringify(briefs.map((b) => [b.requestedBy, b.requestedByKind, b.source])));
    const [task] = await lane(M.f.projectId!);
    c.ok("one revision task for the editor, OPEN, reason 'Client requested changes via portal'", !!task && task.status === "OPEN" && task.assignedKey === "kim" && /Client requested changes/.test(task.reasonCreated ?? ""), JSON.stringify({ s: task?.status, a: task?.assignedKey, r: task?.reasonCreated }));
    c.ok("pinnedItems on its own: continuation lines join their bullet; a header line before the first bullet is not an item", (() => { const it = pinnedItems("Header line:\n• [0:05] first\nmore of first\n\n• [0:09] second", "d:1"); return it.length === 2 && it[0].ask === "[0:05] first\nmore of first" && it[1].ask === "[0:09] second"; })());

    // ======================================================================
    c.head("2 · a new version of ANOTHER video (Kim's video 3, version 2)");
    await inRevisions(M.f.projectId!);
    const before = (await lane(M.f.projectId!))[0];
    const v3b = await mkCut(M, 3, 2);
    await correctedCutSubmitted(M.f.projectId!, { round: 2, submissionId: v3b });
    const after3 = (await lane(M.f.projectId!))[0];
    c.ok("the client's ask stays OPEN, its words untouched", after3.status === "OPEN" && after3.summary === before.summary && !after3.summary?.startsWith(WAITING_ON_REVIEW_SUMMARY));
    c.ok("…and the job stays in Revisions", (await statusOf(M.f.projectId!)) === "REVISION");

    // ======================================================================
    c.head("3 · video 2's fix alone: video 4 is still owed");
    const v2b = await mkCut(M, 2, 2);
    await correctedCutSubmitted(M.f.projectId!, { round: 2, submissionId: v2b });
    c.ok("still OPEN, still in Revisions", (await lane(M.f.projectId!))[0].status === "OPEN" && (await statusOf(M.f.projectId!)) === "REVISION");

    // ======================================================================
    c.head("4 · video 4's fix too: now it waits on review");
    const v4c = await mkCut(M, 4, 3);
    await correctedCutSubmitted(M.f.projectId!, { round: 3, submissionId: v4c });
    const done4 = (await lane(M.f.projectId!))[0];
    c.ok("the task: IN_PROGRESS 'Corrected cut submitted — waiting on review', the client's ask kept after it", done4.status === "IN_PROGRESS" && done4.summary?.startsWith(WAITING_ON_REVIEW_SUMMARY) === true && /Client asked for changes|Video revision requested/.test(done4.summary ?? ""), done4.summary ?? "");
    c.ok("…the job back to Review (never delivered)", (await statusOf(M.f.projectId!)) === "REVIEW");

    // ======================================================================
    c.head("5 · as before: an ask naming no video, and the editor's own word");
    const N = await world("Nora Noname");
    const nc: string[] = [];
    for (let s = 1; s <= 4; s++) { nc.push(await mkCut(N, s, 1)); await release(nc[s - 1]); }
    await note(N, nc[0], "Swap the music please");
    await cd.requestChangesOnCut(N.viewer, nc[0], "");
    await prisma.revisionBrief.updateMany({ where: { projectId: N.f.projectId! }, data: { itemsJson: JSON.stringify({ items: [{ id: "i1", area: "Music", ask: "Swap the music please", scope: "unknown", cuts: null }], keep: [], references: [], questions: [] }) } });
    await inRevisions(N.f.projectId!);
    const n3 = await mkCut(N, 3, 2);
    await correctedCutSubmitted(N.f.projectId!, { round: 2, submissionId: n3 });
    c.ok("an ask that names no video: a version 2 answers it, as before", (await lane(N.f.projectId!))[0]?.status === "IN_PROGRESS");
    const E = await world("Eddie Editor");
    const ec: string[] = [];
    for (let s = 1; s <= 4; s++) { ec.push(await mkCut(E, s, 1)); await release(ec[s - 1]); }
    await note(E, ec[1], "Shorter intro");
    await cd.requestChangesOnCut(E.viewer, ec[1], "");
    await inRevisions(E.f.projectId!);
    await mkCut(E, 3, 2);
    await correctedCutSubmitted(E.f.projectId!, { round: 2, isRedo: true });
    c.ok("the editor's own 'this pending cut is the fix' click (no cut handed in): taken at its word", (await lane(E.f.projectId!))[0]?.status === "IN_PROGRESS");
    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    fence.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
