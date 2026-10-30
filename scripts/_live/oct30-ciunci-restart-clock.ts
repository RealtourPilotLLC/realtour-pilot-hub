// ---------------------------------------------------------------------------
// LIVE, Oct 30 2026: Mike Ciunci's review clock restarted from today.
//
// His revised Video 2 (version 4) reached his portal Oct 27 12:06 PM and the
// hub never told him: the video's job sits in his September month and the
// review reminders only read the current month. He found out by emailing Kyle
// (Oct 30 8:50 AM). Jordan, Oct 30 2026: "Fix the snooze and restart his
// clock." The old deadline is kept in originalDeadlineAt. Nothing is sent.
//
//   dry run:  npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct30-ciunci-restart-clock.ts
//   apply:    … --apply
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { restartReviewClock } from "@/lib/reviewWindows";

const SUBMISSION_ID = "cmvqtafl20001kw08j7wrqn83"; // Video 2, version 4
const BY = "claude: for Jordan";

async function main() {
  const apply = process.argv.includes("--apply");
  const w = await prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: SUBMISSION_ID }, select: { id: true, round: true, state: true, deadlineAt: true, originalDeadlineAt: true, restartedAt: true } });
  console.log("window:", w);
  if (!apply) { console.log("\nDry run. Pass --apply to restart."); return; }
  console.log(await restartReviewClock(w.id, BY));
  console.log("after:", await prisma.contentReviewWindow.findUnique({ where: { id: w.id }, select: { deadlineAt: true, originalDeadlineAt: true, restartedAt: true, restartedBy: true } }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
