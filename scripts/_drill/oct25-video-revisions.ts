// ---------------------------------------------------------------------------
// DRILL oct25-video-revisions: the Oct 25 2026 audit's video revision fixes
// (area C), found on 615 Cliff Ln (Alex Stackhouse, a Luma Visuals reel
// already on the Aryeo listing, with her "swap out the retaining wall shots"
// email open):
//
//   1. the Editing Room reads "Revisions" when the video's revision card was
//      handed to the office to relay (an outside-agency job: raiseRevision
//      and revisionLane give it to Kyle, titled "Video revision — …"); it read
//      "Ready for review" off the video on Aryeo, and no revision reminder saw
//      it. A photo card on Kyle stays off the video row.
//   2. the creative review card keeps the client's words and the analyser's
//      open questions apart (it read "Alex Stackhouse said: V1: No footage
//      has been uploaded yet…", a sentence she never wrote).
//   3. the work order's analyser is told a video made outside the Review
//      Room is already with the client, never "nothing uploaded yet".
//
//   DRILL_PORT=6100 node scripts/_drill/run-all.cjs scripts/_drill/oct25-video-revisions.ts
//
// Isolated PGlite; nothing leaves the process.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6100);
installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { buildEditorQueue } = await import("@/lib/editorQueue");
    const cr = await import("@/lib/creativeReview");
    const rb = await import("@/lib/revisionBrief");
    const client = await prisma.client.create({ data: { name: "Alex Drill" } });
    const evidence = JSON.stringify({ expected: ["Photos", "Video"], present: ["Photos", "Video"], dropbox: { rawVideo: 4, finalVideo: 0, stale: false } });
    const agencyJob = async (street: string) =>
      prisma.project.create({
        data: {
          title: `${street}, Malvern, PA 19355`, clientId: client.id, status: "REVISION", shootDate: new Date(Date.now() - 4 * 86_400_000),
          deliveryDue: new Date(Date.now() + 2 * 86_400_000), revisionRequestedAt: new Date(),
          editorManual: true, editorVendorKey: "external_agency", statusEvidence: evidence, aryeoListingId: `listing-${street.replace(/\W/g, "")}`,
          deliverables: { create: [{ type: "SOCIAL_REEL", label: "Premium Social Media Reel", quantity: 1 }] },
        },
        select: { id: true, title: true, deliverables: { select: { id: true } } },
      });

    // =====================================================================
    c.head("1 · An outside-agency job's video revision, on the office to relay");
    // =====================================================================
    const cliff = await agencyJob("615 Cliff Ln");
    await prisma.smartTask.create({ data: { taskType: "revision", status: "OPEN", assignedKey: "kyle", projectId: cliff.id, title: `Video revision — ${cliff.title}`, source: "gmail", priority: "HIGH", contactName: "Alex Drill", summary: "Client asked for changes after delivery: swap out the retaining wall shots" } });
    const photo = await agencyJob("616 Photo Ln");
    await prisma.smartTask.create({ data: { taskType: "revision", status: "OPEN", assignedKey: "kyle", projectId: photo.id, title: `Photo revision — ${photo.title}`, source: "gmail", priority: "NORMAL", summary: "Keep the lamp in the photo" } });
    const q = await buildEditorQueue();
    const row = q.notDone.find((r) => r.id === cliff.id);
    c.ok("the row reads Revisions (it read Ready for review off the video on Aryeo)", row?.status === "Revisions", row?.status ?? "no row");
    c.ok("…it counts the open revision, and carries the ask the reminders date", (row?.openRevisions ?? 0) === 1 && (row?.revisionAsks?.length ?? 0) === 1, JSON.stringify({ open: row?.openRevisions, asks: row?.revisionAsks }));
    c.ok("…still the agency's row (Luma Visuals), never an in-house editor's", row?.editorKey === "external_agency", String(row?.editorKey));
    const prow = q.notDone.find((r) => r.id === photo.id);
    c.ok("a PHOTO revision on Kyle leaves the video row alone (Ready for review off the video on Aryeo, as before)", prow?.status === "Ready for review" && (prow?.openRevisions ?? 0) === 0, `${prow?.status} ${prow?.openRevisions}`);
    const { openRevisions } = await import("@/lib/revisionReminders");
    const open = await openRevisions();
    const mine = open.filter((r) => r.projectId === cliff.id);
    c.ok("the revision reminders see it, in the agency lane (\"relay it to them\"), never an editor's", mine.length === 1 && mine[0].lane === "agency", JSON.stringify(mine.map((r) => ({ lane: r.lane, key: r.editorKey }))));

    // =====================================================================
    c.head("2 · The creative review card: the client's words, then the open questions");
    // =====================================================================
    const words = "Good morning! Is there any chance we could swap out the shots of close up of the retaining wall? Side yard is fine!";
    const rev = await prisma.smartTask.findFirstOrThrow({ where: { projectId: cliff.id, taskType: "revision" } });
    const items = {
      items: [{ id: "i1", area: "Cuts & content", ask: "Remove close-up shots of the retaining wall", quote: "swap out the shots of close up of the retaining wall", scope: "all", kind: "REFINEMENT", medium: "video" }],
      keep: ["Side yard shots"], references: [],
      questions: ["V1: Which back-yard clips are there to replace the retaining wall shots?"],
    };
    const brief = await prisma.revisionBrief.create({ data: { projectId: cliff.id, source: "gmail", requestedBy: "Alex Drill", requestedByKind: "EMAIL", originalText: words, taskId: rev.id, itemsJson: JSON.stringify(items), analyzedAt: new Date() } });
    const state = await cr.routeCreativeReview(brief.id);
    const card = await prisma.smartTask.findFirst({ where: { projectId: cliff.id, taskType: "creative_review" } });
    c.ok("an open question routes a creative review (unchanged)", state?.state === "OPEN" && !!card, JSON.stringify(state));
    c.ok("the summary names it an open question, never \"Alex Drill said: V1: …\"", /^Open question on Alex Drill's ask: V1: Which back-yard clips/.test(card?.summary ?? "") && !/said: V1/.test(card?.summary ?? ""), card?.summary ?? "");
    c.ok("the card carries her real words under \"The client's words\"", (card?.description ?? "").includes(`The client's words:\n${words}`), card?.description ?? "");
    c.ok("…and the question under its own heading", /\n\nOpen questions:\n• V1: Which back-yard clips/.test(card?.description ?? ""), card?.description ?? "");

    // =====================================================================
    c.head("3 · The analyser is told a video made outside the Review Room is already delivered");
    // =====================================================================
    const before = await rb.briefCutsFor(cliff.id);
    c.ok("no round, no video on the listing: \"nothing uploaded yet\" (as before)", before.length === 1 && !before[0].delivered && rb.briefCutLine(before[0], "V1").endsWith("(nothing uploaded yet)"), JSON.stringify(before));
    await prisma.listingMediaItem.create({ data: { projectId: cliff.id, aryeoListingId: "listing-615CliffLn", aryeoMediaId: "media-1", kind: "VIDEO", title: "Premium Social Media Reel", downloadUrl: "https://videos.aryeo.com/drill/1.mp4" } });
    const after = await rb.briefCutsFor(cliff.id);
    c.ok("the reel on the Aryeo listing: the slot reads already delivered", after.length === 1 && after[0].delivered === true && /already delivered to the client, made outside the hub's review room/.test(rb.briefCutLine(after[0], "V1")), rb.briefCutLine(after[0], "V1"));
    const out = await prisma.deliverableOutput.create({ data: { projectId: photo.id, deliverableId: photo.deliverables[0].id, slot: 1, category: "VIDEO", deliveredAt: new Date() } }).catch((e) => { c.ok("(setup) a delivered video row", false, String(e).slice(0, 200)); return null; });
    if (out) {
      const viaRow = await rb.briefCutsFor(photo.id);
      c.ok("a video row stamped delivered says the same, with nothing on the listing index", viaRow.length === 1 && viaRow[0].delivered === true, JSON.stringify(viaRow));
    }
    await prisma.reviewSubmission.create({ data: { projectId: cliff.id, deliverableId: cliff.deliverables[0].id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "Cliff v2.mp4" } });
    const withRound = await rb.briefCutsFor(cliff.id);
    c.ok("a version in the Review Room still names its file", withRound[0].fileName === "Cliff v2.mp4" && !withRound[0].delivered && /current file: Cliff v2\.mp4/.test(rb.briefCutLine(withRound[0], "V1")), rb.briefCutLine(withRound[0], "V1"));

    c.head("Z · isolation");
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
