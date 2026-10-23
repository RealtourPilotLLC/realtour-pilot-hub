// ---------------------------------------------------------------------------
// DRILL: CREATIVE REVIEWS CLOSE THEMSELVES ONCE THE WORK ANSWERED THEM
// (audit M1, Oct 22 2026).
//
//   DRILL_PORT=6995 node scripts/_drill/run-all.cjs scripts/_drill/oct22-creative-review-close.ts
//
// Nine "Creative review" tasks sat open on delivered jobs whose revisions were
// finished. lib/creativeReview.closeSettledCreativeReviews closes one when
// the revision card it was filed on is completed, or a newer version of its
// video was approved; on every approval and hourly.
//   1. its revision completed → closed, the brief RESOLVED / NOT_NEEDED with
//      the reason, the held words archived, the timeline line;
//   2. a newer version of the cut approved → closed;
//   3. neither → stays open; a dry run writes nothing;
//   4. a "same ask came back" review closes when its issue is verified;
//   5. wiring: the approval and the hourly sync call it; the live script's
//      scope leaves the comms builder's five out.
// Isolated PGlite; nothing leaves the process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6995);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const cr = await import("@/lib/creativeReview");
    const client = await prisma.client.create({ data: { name: "Heather Drill" } });
    let n = 0;
    const setup = async (street: string, opts: { revisionStatus?: string; submission?: "v2-changes" | null } = {}) => {
      n++;
      const p = await prisma.project.create({
        data: {
          title: `${street}, Kennett Square, PA`, clientId: client.id, status: "DELIVERED", deliveredAt: new Date(),
          deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", status: "DONE" }] },
        },
        select: { id: true, deliverables: { select: { id: true } } },
      });
      const d = p.deliverables[0].id;
      const sub = opts.submission === null ? null : await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d, slot: 1, round: 2, status: "CHANGES_REQUESTED", source: "upload", fileName: "v2.mp4" } });
      const rev = await prisma.smartTask.create({ data: { taskType: "revision", status: (opts.revisionStatus ?? "OPEN") as never, assignedKey: "john", projectId: p.id, title: `Video revision — ${street}`, source: "openphone", priority: "HIGH" } });
      const items = { items: [{ id: "i1", area: "Overall direction", ask: "It just doesn't feel like her", quote: "It just doesn't feel like her", held: true, kind: "DIRECTION_UNCLEAR" }, { id: "i2", area: "Text", ask: "Fix the typo on the end card" }] };
      const brief = await prisma.revisionBrief.create({ data: { projectId: p.id, source: "gmail", originalText: "It just doesn't feel like her. Also fix the typo on the end card.", taskId: rev.id, submissionId: sub?.id ?? null, itemsJson: JSON.stringify(items) } });
      const task = await prisma.smartTask.create({ data: { taskType: "creative_review", status: "OPEN", assignedKey: "jordan", projectId: p.id, propertyAddress: `${street}, Kennett Square, PA`, title: `Creative review — ${street} · Heather`, source: "creative_review", priority: "HIGH", dedupeKey: `creative-review:${brief.id}` } });
      const state = { state: "OPEN", taskId: task.id, reviewerKey: "jordan", reviewerName: "Jordan", reasons: ["UNCLEAR"], heldItemIds: ["i1"], questions: [], taskHeld: false, openedAt: new Date().toISOString() };
      await prisma.revisionBrief.update({ where: { id: brief.id }, data: { itemsJson: JSON.stringify({ ...items, creativeReview: state }) } });
      return { projectId: p.id, deliverableId: d, sub, rev, brief, task };
    };

    // =====================================================================
    c.head("1 · Its revision completed: closed, with the reason");
    // =====================================================================
    const A = await setup("671 Northbrook Rd", { revisionStatus: "COMPLETED" });
    const B = await setup("632 Greenridge Rd");
    const C = await setup("10 Still Open Ln");
    const dry = await cr.closeSettledCreativeReviews({ dryRun: true });
    c.ok("a dry run lists it and writes nothing", dry.closed.length === 1 && dry.closed[0].taskId === A.task.id && dry.closed[0].why === "its revision was completed" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: A.task.id } })).status === "OPEN", JSON.stringify(dry.closed));
    const r1 = await cr.closeSettledCreativeReviews({});
    const tA = await prisma.smartTask.findUniqueOrThrow({ where: { id: A.task.id } });
    const bA = JSON.parse((await prisma.revisionBrief.findUniqueOrThrow({ where: { id: A.brief.id } })).itemsJson!);
    c.ok("closed: the task COMPLETED", r1.closed.some((x) => x.taskId === A.task.id) && tA.status === "COMPLETED" && !!tA.completedAt);
    c.ok("the brief: RESOLVED / NOT_NEEDED by the hub, with the reason", bA.creativeReview.state === "RESOLVED" && bA.creativeReview.mode === "NOT_NEEDED" && bA.creativeReview.resolvedBy === "the hub" && bA.creativeReview.note === "Closed on its own: its revision was completed.", JSON.stringify(bA.creativeReview));
    c.ok("the client's held words archived, never deleted; the concrete item stays", bA.creativeReview.archived?.[0]?.quote === "It just doesn't feel like her" && bA.items.length === 1 && bA.items[0].id === "i2");
    c.ok("the timeline says it", !!(await prisma.activity.findFirst({ where: { projectId: A.projectId, body: "Creative review closed on its own: its revision was completed. The client's words stay on the request." } })));
    c.ok("the others are untouched (revision still open, nothing approved)", (await prisma.smartTask.findUniqueOrThrow({ where: { id: B.task.id } })).status === "OPEN" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: C.task.id } })).status === "OPEN");

    // =====================================================================
    c.head("2 · A newer version of the cut approved: closed");
    // =====================================================================
    await prisma.reviewSubmission.create({ data: { projectId: B.projectId, deliverableId: B.deliverableId, slot: 1, round: 4, status: "APPROVED", source: "upload", fileName: "v4.mp4", decidedAt: new Date() } });
    const r2 = await cr.closeSettledCreativeReviews({ projectId: B.projectId });
    c.ok("version 4 approved over the ask's version 2: closed, saying so", r2.closed.length === 1 && r2.closed[0].why === "a newer version of the video (version 4) was approved after the ask" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: B.task.id } })).status === "COMPLETED", JSON.stringify(r2.closed));
    // An ask filed with no cut (a text about the delivered video): the job's one video approved AFTER the ask.
    const D = await setup("12 No Cut Rd", { submission: null });
    await prisma.reviewSubmission.create({ data: { projectId: D.projectId, deliverableId: D.deliverableId, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "v1.mp4", decidedAt: new Date(Date.now() - 86_400_000) } });
    c.ok("no cut on the ask, the only approval older than it: stays open", (await cr.closeSettledCreativeReviews({ projectId: D.projectId })).closed.length === 0);
    await prisma.reviewSubmission.create({ data: { projectId: D.projectId, deliverableId: D.deliverableId, slot: 1, round: 2, status: "APPROVED", source: "upload", fileName: "v2.mp4", decidedAt: new Date(Date.now() + 60_000) } });
    c.ok("…and closes once a version is approved after the ask", (await cr.closeSettledCreativeReviews({ projectId: D.projectId })).closed.length === 1);

    // =====================================================================
    c.head("3 · Neither: it stays open; a person's resolve wins");
    // =====================================================================
    c.ok("10 Still Open Ln stays open (revision open, nothing approved)", (await cr.closeSettledCreativeReviews({})).closed.every((x) => x.taskId !== C.task.id) && (await prisma.smartTask.findUniqueOrThrow({ where: { id: C.task.id } })).status === "OPEN");
    await prisma.smartTask.update({ where: { id: C.rev.id }, data: { status: "CANCELLED" } });
    c.ok("a CANCELLED revision is not a completed one: still open", (await cr.closeSettledCreativeReviews({ projectId: C.projectId })).closed.length === 0);

    // =====================================================================
    c.head("4 · \"Same ask came back\" (keyed by issue)");
    // =====================================================================
    const E = await setup("14 Issue Way", { submission: null });
    const issue = await prisma.revisionIssue.create({ data: { projectId: E.projectId, sourceKind: "BRIEF_ITEM", sourceId: `${E.brief.id}:i1`, category: "Music", originalText: "Softer music", state: "REOPENED" } as never });
    const issueTask = await prisma.smartTask.create({ data: { taskType: "creative_review", status: "OPEN", assignedKey: "jordan", projectId: E.projectId, title: "Creative review — 14 Issue Way · same ask came back", source: "creative_review", priority: "HIGH", dedupeKey: `creative-review:issue:${issue.id}` } });
    c.ok("open while the issue is reopened", !(await cr.closeSettledCreativeReviews({ taskIds: [issueTask.id] })).closed.length);
    await prisma.revisionIssue.update({ where: { id: issue.id }, data: { state: "VERIFIED" } });
    c.ok("closes once the issue is verified fixed", (await cr.closeSettledCreativeReviews({ taskIds: [issueTask.id] })).closed[0]?.why === "the change was checked as fixed on a later version");

    // =====================================================================
    c.head("5 · Wiring and the live clean-up's scope");
    // =====================================================================
    c.ok("every approval closes its job's", /closeSettledCreativeReviews\(\{ projectId: submission\.projectId \}\)/.test(read("src/app/review/actions.ts")));
    c.ok("the hourly sync closes the rest", /step\("creativeReviews"/.test(read("src/app/api/cron/sync/route.ts")));
    const live = read("scripts/_live/oct22-close-stale-creative-reviews.ts");
    c.ok("the live script: dry run by default on a read-only connection, the comms builder's five left out", /default_transaction_read_only/.test(live) && /22 White Birch Dr/.test(live) && /212 N Wanamaker St/.test(live) && /47 Venuti Dr/.test(live) && /859 N Lawrence St/.test(live) && /dryRun: !APPLY/.test(live));
    const code = read("src/lib/creativeReview.ts").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    c.ok("no em dashes in the new words", !/Closed on its own[^`]*—/.test(code) && !/closed on its own: \$\{settled\.why\}[^`]*—/.test(code));

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
