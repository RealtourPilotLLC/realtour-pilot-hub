// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, audit M1): creative-review tasks that never
// closed. Nine sat open on delivered jobs whose revisions were complete;
// nothing closed one except a person pressing its buttons. The hub now closes
// one on its own when its revision completes or a newer version of its video
// is approved (lib/creativeReview.closeSettledCreativeReviews, on every
// approval and hourly). This closes the ones already stale.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct22-close-stale-creative-reviews.ts           # dry run
//     NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct22-close-stale-creative-reviews.ts --apply   # writes
//
// In scope: an OPEN creative review on a DELIVERED job with no open video
// revision card. Left out on purpose (the comms builder's, Oct 22 2026): the
// three photo questions on 22 White Birch Dr, 212 N Wanamaker St and 47 Venuti
// Dr, and both reviews on 859 N Lawrence St (the Cafe La Maude duplicates).
// Each one in scope closes with the rule's own reason when the rule reaches it
// (its revision completed, or a newer version approved after the ask), else
// with "the job is delivered and its video revisions are complete". Closing =
// the brief's creative review RESOLVED / NOT_NEEDED with that reason (the
// client's words archived, never deleted), the task COMPLETED, a timeline
// line. Nothing is sent to anyone.
//
// Dry run (the default): a READ-ONLY database connection; prints what would
// close and why, and what stays open and why.
// ---------------------------------------------------------------------------
import { installNextStubs } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set: run with node --env-file=.env.");
  if (!/default_transaction_read_only/.test(url)) {
    process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
  }
}
installNextStubs();

/** The comms builder's five (by street; both 859 reviews). */
const LEFT_OUT = [/^22 White Birch Dr\b/i, /^212 N Wanamaker St\b/i, /^47 Venuti Dr\b/i, /^859 N Lawrence St\b/i];

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { videoLaneRevisionWhere } = await import("../../src/lib/reviewCuts");
  const { closeSettledCreativeReviews } = await import("../../src/lib/creativeReview");

  const open = await prisma.smartTask.findMany({
    where: { taskType: "creative_review", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, assignedKey: true, createdAt: true, projectId: true, project: { select: { title: true, status: true } } },
  });
  console.log(`=== Open creative reviews: ${open.length} · ${APPLY ? "APPLY" : "DRY RUN (read-only connection)"} ===`);
  const inScope: string[] = [];
  const reasons: Record<string, string> = {};
  for (const t of open) {
    const street = (t.project?.title ?? "").split(",")[0].trim();
    const tag = `${t.id} ${t.assignedKey ?? "-"} ${street}`;
    if (LEFT_OUT.some((re) => re.test(street))) { console.log(`  left out (comms builder): ${tag}`); continue; }
    if (!t.projectId || t.project?.status !== "DELIVERED") { console.log(`  left open (job is ${t.project?.status ?? "missing"}): ${tag}`); continue; }
    const openRevisions = await prisma.smartTask.count({ where: videoLaneRevisionWhere(t.projectId) });
    if (openRevisions) { console.log(`  left open (${openRevisions} video revision card(s) still open): ${tag}`); continue; }
    inScope.push(t.id);
    reasons[t.id] = "the job is delivered and its video revisions are complete";
  }
  const r = await closeSettledCreativeReviews({ taskIds: inScope, alsoClose: reasons, dryRun: !APPLY });
  console.log(`\n${APPLY ? "Closed" : "Would close"} ${r.closed.length} of ${inScope.length} in scope:`);
  for (const c of r.closed) console.log(`  ${c.taskId} · ${c.street} · ${c.why}`);
  const notClosed = inScope.filter((id) => !r.closed.some((c) => c.taskId === id));
  for (const id of notClosed) console.log(`  NOT closed: ${id} (a person resolved it meanwhile, or it changed under this run)`);
  if (!APPLY) console.log("\ndry run: nothing written (add --apply)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
