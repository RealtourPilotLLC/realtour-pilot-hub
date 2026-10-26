// ---------------------------------------------------------------------------
// Oct 26 2026, Jordan: "Mike sent a revision so it should open up in the ops
// hub as revision status and the editor should see the notes etc".
//
// Mike Ciunci's note (Oct 26, 8:52 AM ET, at 0:19 on "1033 Preserve Ln Video 2"
// round 3): "The timing of the music is taking away from the feel of the
// video. Jordan i sent the video w/ the music via instagram. Can you start the
// music for my video at the same place where the sample video i sent to you?"
// He never pressed Request changes, so the note sat OPEN and nothing reached
// an editor (the same miss as Bernadette on Oct 13, scripts/_fix/oct14/
// bernadette-video4-revision.ts). This files it through the portal's own
// Request changes path (clientDecisions.requestChangesOnCut) with a STAFF
// viewer: recorded on his behalf, carrying his own note, opening the revision
// round and routing to the cut's editor. Dry run by default (read-only, proven);
// `--apply` writes. Idempotent (requestKey).
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const SUBMISSION = "cmvia78li0001jp08jmlf5iah";
const ENROLLMENT = "cmt7h6b2d00089kcjv6hr8ha6";

async function main() {
  const prisma = await db();
  const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: ENROLLMENT }, select: { id: true, clientId: true, status: true, videosPerMonth: true, sessionsPerMonth: true } });
  const client = await prisma.client.findUniqueOrThrow({ where: { id: e.clientId }, select: { name: true } });
  const owner = await prisma.appUser.findFirstOrThrow({ where: { role: "OWNER", status: "ACTIVE", email: "info@realtourpilot.com" }, select: { id: true, name: true } });
  const notes = await prisma.portalComment.findMany({ where: { submissionId: SUBMISSION, enrollmentId: ENROLLMENT, status: "OPEN", parentId: null }, select: { id: true, body: true, timeSec: true } });
  const window = await prisma.contentReviewWindow.findFirst({ where: { submissionId: SUBMISSION }, orderBy: { createdAt: "desc" } as never }).catch(() => null);
  const { revisionPolicyFor, roundsUsed, videoKeyOf } = await import("@/lib/reviewWindows");
  const policy = await revisionPolicyFor(e.clientId, new Date());
  const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: SUBMISSION }, select: { id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, fileName: true } });
  const key = videoKeyOf ? videoKeyOf(sub as never) : null;
  const used = key ? await roundsUsed(key as never).catch(() => null) : null;
  console.log(JSON.stringify({ client: client.name, enrollment: e.status, openNotes: notes, window: window ? { id: window.id, state: window.state, deadlineAt: window.deadlineAt } : null, policy: { on: policy.on, includedRounds: policy.includedRounds, feeCents: policy.extraRoundFeeCents }, roundsUsed: used, nextIncluded: used == null ? null : used + 1 <= policy.includedRounds }, null, 2));
  if (!APPLY) return;
  const { requestChangesOnCut } = await import("@/lib/clientDecisions");
  const viewer = {
    enrollment: { id: e.id, clientId: e.clientId, clientName: client.name, status: e.status, videosPerMonth: e.videosPerMonth, sessionsPerMonth: e.sessionsPerMonth },
    actor: { kind: "STAFF" as const, staffUserId: owner.id, staffName: owner.name ?? "Jordan Spackman", staffRole: "OWNER" },
    access: "FULL" as const,
    via: "STAFF" as const,
  };
  const r = await requestChangesOnCut(viewer as never, SUBMISSION, "", { requestKey: "oct26-mike-ciunci-video2-music" });
  console.log("RESULT", JSON.stringify(r));
  const d = "decisionId" in r && r.decisionId ? await prisma.clientDecision.findUnique({ where: { id: r.decisionId }, select: { decision: true, receiptState: true, revisionTaskId: true, revisionBriefId: true, commentIdsJson: true } }) : null;
  console.log("DECISION", JSON.stringify(d));
  if (d?.revisionTaskId) console.log("TASK", JSON.stringify(await prisma.smartTask.findUnique({ where: { id: d.revisionTaskId }, select: { title: true, assignedKey: true, status: true, taskType: true } })));
  if (d?.revisionBriefId) console.log("BRIEF", JSON.stringify(await prisma.revisionBrief.findUnique({ where: { id: d.revisionBriefId } }).catch(() => null)).slice(0, 1500));
  console.log("PROJECT", JSON.stringify(await prisma.project.findUnique({ where: { id: sub.projectId }, select: { status: true } as never })));
}
main().catch((err) => { console.error(err); process.exit(1); }).finally(async () => (await db()).$disconnect().catch(() => {}));
