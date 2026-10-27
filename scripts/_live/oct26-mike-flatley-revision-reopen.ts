// ---------------------------------------------------------------------------
// MIKE FLATLEY'S REVISION, OPEN AGAIN (Oct 26 2026). Jordan: "Did these
// revision notes get sent to the editor as a revision for Mike Flatley? I need
// to make sure they are seeing this and they are treated as normal revision
// requests, and they also show that it was a client requested revision."
//
// They were sent (9:55 AM, as Mike, to Kim). Then Kim's 5:11 PM upload,
// version 2 of the THIRD video ("mike 2.1.1"), was read as the fix for Mike's
// asks on video 2 and video 4: the task went "Corrected cut submitted —
// waiting on review" and the job back to Review. And video 2's work order kept
// only the first line of his note. Both fixed in code (reviewCuts.
// namedCorrectionState, revisionBrief.pinnedItems); this puts the job right:
//   · the revision task back to OPEN, the client's ask as its summary;
//   · the job back to REVISION, stamped at Mike's request;
//   · video 2's items rebuilt from his whole note (no ticks to lose);
//   · a line on the job's timeline saying so.
// The video 3 cut stays in review as it is.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-mike-flatley-revision-reopen.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const PROJECT = "cmtrbh05d0009lb04gv7c0cdi";
const TASK = "cmvpbkn9w0005l2083of4cm3z";
const V2_BRIEF = "cmvpbko3j000ml208we33ll5t";
const V2_CUT_KEY = "cmtrbh05d000alb042r7mbmpb:2";

async function main() {
  const prisma = await db();
  const { WAITING_ON_REVIEW_SUMMARY, revisionAskOnly } = await import("../../src/lib/reviewCuts");
  const { pinnedItems } = await import("../../src/lib/revisionBrief");

  const [project, task, brief, asks] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: PROJECT }, select: { status: true, deliveredAt: true, revisionRequestedAt: true, title: true } }),
    prisma.smartTask.findUniqueOrThrow({ where: { id: TASK }, select: { status: true, summary: true, assignedKey: true, projectId: true } }),
    prisma.revisionBrief.findUniqueOrThrow({ where: { id: V2_BRIEF }, select: { itemsJson: true, doneJson: true, originalText: true, projectId: true } }),
    prisma.clientDecision.findMany({ where: { projectId: PROJECT, revisionTaskId: TASK, decision: "REQUEST_CHANGES" }, select: { decidedAt: true, actorLabel: true }, orderBy: { decidedAt: "desc" } }),
  ]);
  if (task.projectId !== PROJECT || brief.projectId !== PROJECT) throw new Error("task or brief is not on Mike's job");
  if (!asks.length) throw new Error("no request from Mike on this task");
  const askedAt = asks[0].decidedAt;

  const reopenTask = task.status === "IN_PROGRESS" && (task.summary ?? "").startsWith(WAITING_ON_REVIEW_SUMMARY);
  const ask = revisionAskOnly(task.summary);
  const reopenJob = !project.deliveredAt && project.status === "REVIEW";
  const saved = JSON.parse(brief.itemsJson ?? "{}") as Record<string, unknown>;
  const items = pinnedItems(brief.originalText, V2_CUT_KEY);
  const rebuild = !brief.doneJson && items.length === 1 && /3\. Are you in the kids/.test(items[0].ask) && !/3\. Are you in the kids/.test(JSON.stringify(saved.items ?? []));

  console.log(`job "${project.title}": ${project.status}${reopenJob ? " -> REVISION (stamped " + askedAt.toISOString() + ")" : " (left)"}`);
  console.log(`task (${task.assignedKey}): ${task.status}${reopenTask ? " -> OPEN" : " (left)"}; summary -> ${ask.slice(0, 120)}...`);
  console.log(`video 2 items: ${rebuild ? "rebuilt ->\n" + items[0].ask : "(left)"}`);
  if (!APPLY) { console.log("dry run: nothing written. Re-run with --apply."); return; }

  if (reopenTask) await prisma.smartTask.update({ where: { id: TASK }, data: { status: "OPEN", summary: ask } });
  if (reopenJob) await prisma.project.update({ where: { id: PROJECT }, data: { status: "REVISION", revisionRequestedAt: askedAt } });
  if (rebuild) await prisma.revisionBrief.update({ where: { id: V2_BRIEF }, data: { itemsJson: JSON.stringify({ ...saved, items }) } });
  await prisma.activity.create({
    data: {
      projectId: PROJECT, type: "SYSTEM",
      body: "Office correction: \"mike 2.1.1\" is version 2 of the third video, not the fix for Mike's requests on Video 2 and Video 4, so his revision is open again. Video 2's work order now lists his whole note (points 1 to 3).",
    },
  });
  console.log("written.");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
