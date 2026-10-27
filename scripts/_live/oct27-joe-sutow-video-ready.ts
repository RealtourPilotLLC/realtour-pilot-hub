// ---------------------------------------------------------------------------
// JOE SUTOW'S VIDEO 2, TOLD NOW (Oct 27 2026). Jordan: "Email Joe and tell
// every client as soon as the video hits their portal. They should get a text
// too." His "02 Shark Tank Listing Pitch" reached his portal Oct 26 7:59 PM and
// nobody told him. 8aa1bfb sends the review email + text at release; this runs
// that same review lane for Joe alone, now, instead of at the next hourly run.
// Same evaluator, gates and ledger as the cron: re-running sends nothing twice.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-joe-sutow-video-ready.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const ENROLLMENT = "cmt7h6ayl00039kcjtsyltfqn";
const MONTH = "cmup0bq4q00qjjg04tb2fqhri";

async function main() {
  const prisma = await db();
  const { previewReminders, evaluateReminders } = await import("../../src/lib/programReminders");
  const p = await previewReminders(MONTH);
  const lane = p.lanes.find((l) => l.lane === "REVIEW")!;
  console.log(`${p.clientName} ${p.monthKey}: ${lane.candidate.decision} — ${lane.candidate.reason}`);
  if (lane.body) console.log(`\n${lane.body}\n`);
  if (lane.candidate.decision !== "send") throw new Error("the review lane is not due; nothing to send");
  if (!APPLY) { console.log("dry run: nothing sent. Re-run with --apply."); return; }
  const r = await evaluateReminders({ dryRun: false, enrollmentIds: [ENROLLMENT], reviewOnly: true, requestedBy: "Claude (for Jordan)" });
  console.log("sent:", JSON.stringify(r.sent));
  const rows = await prisma.programReminder.findMany({ where: { enrollmentId: ENROLLMENT, action: { in: ["REVIEW_WORK", "REVIEW_TEXT"] } }, orderBy: { createdAt: "asc" }, select: { action: true, channel: true, state: true, outcome: true, suppressionReason: true, lastError: true, outboxMessageId: true } });
  for (const r of rows) console.log("row", JSON.stringify(r));
  const out = await prisma.outboxMessage.findMany({ where: { id: { in: rows.map((r) => r.outboxMessageId).filter((x): x is string => !!x) } }, select: { channel: true, state: true, body: true } });
  for (const o of out) console.log(`\n${o.channel} ${o.state}:\n${o.body}`);
  const w = await prisma.contentReviewWindow.findMany({ where: { enrollmentId: ENROLLMENT, state: "OPEN" }, select: { openedAt: true, clientNotifiedAt: true } });
  console.log("\nwindows:", JSON.stringify(w));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
