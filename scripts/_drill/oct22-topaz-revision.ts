// ---------------------------------------------------------------------------
// DRILL: A REVISION KEEPS ITS VIDEO'S LOOK (Oct 22 2026). Jordan, on 859 N
// Lawrence St: "It should have [gone through Topaz]. It was a revision." Round 1
// went through the 1080p pass and to the client; round 2 was skipped as
// "already 1080p".
//   · a later round of the same video (job, deliverable, slot) whose earlier
//     round was processed and checked answers true, so the skip rule stands
//     aside;
//   · an earlier round that was itself skipped, another slot, another
//     deliverable or the first round answer false;
//   · the lane reads it before the already-finished rule (source check).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6881) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const T = await import("@/lib/topazJobs");
    const client = await prisma.client.create({ data: { name: "Revision Drill TEST" }, select: { id: true } });
    const p = await prisma.project.create({ data: { title: "859 Drill St, Philadelphia, PA", clientId: client.id, status: "REVIEW" }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Video", quantity: 2 }, select: { id: true } });
    const d2 = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Reel", quantity: 1 }, select: { id: true } });
    const sub = (round: number, o: { slot?: number; deliverableId?: string } = {}) => prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: o.deliverableId ?? d.id, slot: o.slot ?? 1, kind: "video", round, status: "APPROVED", source: "upload", fileName: `cut-r${round}.mov` }, select: { id: true } });

    c.head("1 · a revision of a processed video is processed too");
    const r1 = await sub(1);
    await prisma.topazJob.create({ data: { submissionId: r1.id, projectId: p.id, state: "done", outputCheck: "verified" } });
    const r2 = await sub(2);
    c.ok("round 2 sees round 1 was processed", await T.earlierRoundProcessed(r2.id));
    c.ok("round 1 itself has no earlier round", !(await T.earlierRoundProcessed(r1.id)));

    c.head("2 · only the same video counts");
    const otherSlot = await sub(2, { slot: 2 });
    c.ok("another slot of the deliverable: no", !(await T.earlierRoundProcessed(otherSlot.id)));
    const otherDeliv = await sub(2, { deliverableId: d2.id });
    c.ok("another deliverable: no", !(await T.earlierRoundProcessed(otherDeliv.id)));

    c.head("3 · a skipped earlier round does not count");
    const s1 = await sub(1, { deliverableId: d2.id, slot: 1 });
    await prisma.topazJob.create({ data: { submissionId: s1.id, projectId: p.id, state: "skipped", skipReason: "Already 1080p: the editor's file goes out as is." } });
    const s2 = await sub(3, { deliverableId: d2.id, slot: 1 });
    c.ok("an earlier round that was skipped: the rule applies as before", !(await T.earlierRoundProcessed(s2.id)));
    c.ok("a submission that does not exist answers false", !(await T.earlierRoundProcessed("nope")));

    c.head("4 · the lane asks before the already-finished rule");
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/lib/topazJobs.ts"), "utf8");
    c.ok("stepQueued checks earlierRoundProcessed in the already-finished condition", /seen\.header && !\(await earlierRoundProcessed\(job\.submissionId\)\)\) \{\s*const h = seen\.header;\s*const rule = alreadyFinishedRule/.test(src));

    c.head("isolation");
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
