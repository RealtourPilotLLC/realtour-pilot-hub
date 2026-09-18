// MINOR 4 — READ-ONLY regression check against production.
//
// Scoping the brief lookup to the lane can only be a fix if it does not LOSE
// briefs the old lookup found for the right reason. For every job that has ever
// carried a revision brief, this compares what the two lookups return.
import { prisma } from "@/lib/prisma";
import { videoLaneRevisionWhere, photoLaneRevisionKey } from "@/lib/reviewCuts";

async function main() {
  const briefs = await prisma.revisionBrief.findMany({ select: { projectId: true }, distinct: ["projectId"] });
  let same = 0;
  let nowCorrect = 0;
  let lost = 0;

  for (const { projectId } of briefs) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, revisionRequestedAt: true } });
    const lane = await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId), select: { id: true, createdAt: true } });
    // The window correctionStillOwed uses. With no open lane it never runs at all.
    if (lane.length === 0) continue;
    const raisedAt = project?.revisionRequestedAt ?? new Date(Math.min(...lane.map((t) => t.createdAt.getTime())));
    const from = new Date(raisedAt.getTime() - 60_000);

    const old = await prisma.revisionBrief.findFirst({
      where: { projectId, createdAt: { gte: from } },
      orderBy: { createdAt: "desc" },
      select: { id: true, taskId: true },
    });
    const laneIds = (await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId, { anyStatus: true }), select: { id: true } })).map((t) => t.id);
    const now = await prisma.revisionBrief.findFirst({
      where: { projectId, taskId: { in: laneIds }, createdAt: { gte: from } },
      orderBy: { createdAt: "desc" },
      select: { id: true, taskId: true },
    });

    const photoKey = photoLaneRevisionKey(projectId);
    const oldWasPhotoLane = old?.taskId
      ? (await prisma.smartTask.findUnique({ where: { id: old.taskId }, select: { dedupeKey: true } }))?.dedupeKey === photoKey
      : false;

    const verdict = old?.id === now?.id ? "same" : now ? "DIFFERENT brief (lane-correct)" : old ? "LOST a brief" : "same (neither)";
    if (verdict === "same" || verdict === "same (neither)") same++;
    else if (now) nowCorrect++;
    else lost++;
    console.log(`${project?.title}`);
    console.log(`  open video lane: ${lane.length} task(s); every video-lane task ever: ${laneIds.length}`);
    console.log(`  OLD picked ${old?.id ?? "(none)"} task=${old?.taskId ?? "-"}${oldWasPhotoLane ? "  ← PHOTO LANE" : ""}`);
    console.log(`  NEW picked ${now?.id ?? "(none)"} task=${now?.taskId ?? "-"}`);
    console.log(`  → ${verdict}\n`);
  }
  console.log(`unchanged: ${same}   now reading the right lane: ${nowCorrect}   briefs no longer found: ${lost}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
