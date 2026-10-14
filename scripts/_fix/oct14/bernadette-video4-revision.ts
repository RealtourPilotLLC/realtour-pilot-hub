// ---------------------------------------------------------------------------
// Oct 14 2026, Jordan: "bernadette signed up for the content program platform.
// She left a message on one of the videos. Can you please make sure that its
// marked as a revision and Kim gets that revision request?"
//
// Her note (Oct 13, 8:31 PM ET) on "Bernadette Rabel - Video 4.mov": "I don't
// like the sound of my voice on this. It's really loud". She never pressed
// Request changes, so the note sat OPEN and nothing reached the editor.
// This files it through the SAME code path the portal's Request changes
// button uses (clientDecisions.requestChangesOnCut) with a STAFF viewer: the
// request is recorded on her behalf (attributed to Jordan), carries her own
// note, opens the revision round, and routes to the editor who cut it (Kim).
// Dry run by default; `--apply` to write. Idempotent (requestKey).
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";

const SUBMISSION = "cmv6tlfk80002l8062zsk61nv";
const ENROLLMENT = "cmt7h6b0u00069kcjdq8xi0le";
const APPLY = process.argv.includes("--apply");

async function main() {
  const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: ENROLLMENT }, select: { id: true, clientId: true, status: true, videosPerMonth: true, sessionsPerMonth: true } });
  const client = await prisma.client.findUniqueOrThrow({ where: { id: e.clientId }, select: { name: true } });
  const owner = await prisma.appUser.findFirstOrThrow({ where: { role: "OWNER", status: "ACTIVE", email: "info@realtourpilot.com" }, select: { id: true, name: true } });
  const notes = await prisma.portalComment.findMany({ where: { submissionId: SUBMISSION, enrollmentId: ENROLLMENT, status: "OPEN", parentId: null }, select: { id: true, body: true } });
  const window = await prisma.contentReviewWindow.findFirst({ where: { submissionId: SUBMISSION }, orderBy: { createdAt: "desc" } as never }).catch(() => null);
  const { revisionPolicyFor } = await import("@/lib/reviewWindows");
  const policy = await revisionPolicyFor(e.clientId);
  const rounds = await prisma.contentRevisionRound.count({ where: { submissionId: SUBMISSION } });
  console.log({ client: client.name, enrollment: e.status, openNotes: notes, window: window ? { id: window.id, state: window.state, deadlineAt: window.deadlineAt } : null, policy: { on: policy.on, includedRounds: policy.includedRounds }, roundsOnThisCut: rounds });
  if (!APPLY) {
    console.log("DRY RUN. Re-run with --apply to file the request.");
    return;
  }
  const { requestChangesOnCut } = await import("@/lib/clientDecisions");
  const viewer = {
    enrollment: { id: e.id, clientId: e.clientId, clientName: client.name, status: e.status, videosPerMonth: e.videosPerMonth, sessionsPerMonth: e.sessionsPerMonth },
    actor: { kind: "STAFF" as const, staffUserId: owner.id, staffName: owner.name ?? "Jordan Spackman", staffRole: "OWNER" },
    access: "FULL" as const,
    via: "STAFF" as const,
  };
  const r = await requestChangesOnCut(viewer as never, SUBMISSION, "", { requestKey: "oct14-bernadette-video4-audio" });
  console.log("RESULT", JSON.stringify(r));
  const d = "decisionId" in r && r.decisionId ? await prisma.clientDecision.findUnique({ where: { id: r.decisionId }, select: { decision: true, receiptState: true, revisionTaskId: true, revisionBriefId: true, commentIdsJson: true } }) : null;
  console.log("DECISION", JSON.stringify(d));
  if (d?.revisionTaskId) {
    const t = await prisma.smartTask.findUnique({ where: { id: d.revisionTaskId }, select: { title: true, assignedKey: true, status: true, taskType: true } });
    console.log("TASK", JSON.stringify(t));
  }
  if (d?.revisionBriefId) {
    const b = await prisma.revisionBrief.findUnique({ where: { id: d.revisionBriefId }, select: { status: true, editorKey: true, source: true } as never }).catch(() => null);
    console.log("BRIEF", JSON.stringify(b));
  }
  const kimBell = await prisma.notification.findMany({ where: { createdAt: { gte: new Date(Date.now() - 5 * 60_000) }, OR: [{ userKey: "editor:kim" }, { userKey: { startsWith: "tm:" } }] }, select: { kind: true, title: true, userKey: true } });
  console.log("RECENT BELLS", JSON.stringify(kimBell));
}
main().catch((err) => { console.error(err); process.exit(1); }).finally(() => prisma.$disconnect());
