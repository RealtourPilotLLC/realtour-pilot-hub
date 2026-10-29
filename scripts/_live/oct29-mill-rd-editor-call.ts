// ---------------------------------------------------------------------------
// LIVE, Oct 29 2026: 265 Mill Rd (Tim Bonner) straight to the editor.
//
// Jordan, on the creative review card that asked him for the room order and
// a replacement track: "I would rather this just goes straight to the editor
// I shouldn't have to choose the music or dictate the flow". John Mark's
// revision card was already open with both changes (recut in a logical flow,
// a more upbeat track); only the two open questions sat with Jordan. This
// moves them onto the work order as John's calls ("Your call."), closes the
// review as sent as is, and completes Jordan's creative review task. Nothing
// is sent: John's card did not change state.
//
//   dry run:  npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct29-mill-rd-editor-call.ts
//   apply:    … --apply
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { splitEditorCalls, type CreativeReviewState } from "@/lib/creativeReviewCore";

const BRIEF_ID = "cmvu2vwe5001fjq085c3t2ewa";
const BY = "claude: for Jordan";
const NOTE = "Straight to the editor (Jordan, Oct 29 2026): the room order and the music are the editor's call.";

async function main() {
  const apply = process.argv.includes("--apply");
  const now = new Date();
  const brief = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: BRIEF_ID }, select: { id: true, projectId: true, itemsJson: true } });
  const doc = JSON.parse(brief.itemsJson ?? "{}") as { questions?: string[]; editorCalls?: string[]; creativeReview?: CreativeReviewState; [k: string]: unknown };
  const cr = doc.creativeReview;
  if (!cr || cr.state !== "OPEN") { console.log("Not open any more; nothing to do."); return; }
  const { editorCalls, needAnswer } = splitEditorCalls(doc.questions ?? []);
  console.log("editor's calls:", editorCalls);
  console.log("still need an answer:", needAnswer);
  if (needAnswer.length) { console.log("A question still needs an answer: left alone."); return; }
  const next = {
    ...doc,
    questions: [],
    editorCalls: [...new Set([...(doc.editorCalls ?? []), ...editorCalls])],
    answeredQuestions: cr.questions,
    creativeReview: { ...cr, state: "RESOLVED", resolvedAt: now.toISOString(), resolvedBy: BY, mode: "AS_IS", note: NOTE, archived: [], heldItemIds: [] } satisfies CreativeReviewState,
  };
  console.log("undo (the brief's itemsJson before):", brief.itemsJson);
  if (!apply) { console.log("\nDry run. Pass --apply to write."); return; }
  await prisma.revisionBrief.update({ where: { id: brief.id }, data: { itemsJson: JSON.stringify(next) } });
  if (cr.taskId) await prisma.smartTask.updateMany({ where: { id: cr.taskId, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_JORDAN", "BLOCKED"] } }, data: { status: "COMPLETED", completedAt: now } });
  await prisma.activity.create({ data: { projectId: brief.projectId, type: "SYSTEM", body: `Creative review done by ${BY}: sent to the editor as is. ${NOTE}` } });
  console.log("Applied.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
