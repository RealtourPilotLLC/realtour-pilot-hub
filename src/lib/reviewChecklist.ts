import "server-only";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";
import {
  CHECKLIST_KEY, ITEMS_FOR, approvalBlockedReason, creativeApproverRequired, prefillFromSelfCheck, validateAnswers,
  type BlockState, type CheckAnswer, type CheckBlock,
} from "@/lib/reviewChecklistCore";

// ---------------------------------------------------------------------------
// THE REVIEWER'S TWO-PART CHECK, SERVER HALF (Oct 15 2026). The list and the
// rule are in reviewChecklistCore.ts; this file records a block against the
// exact version and answers "may this version be approved?".
//
// THE SWITCH. AppSetting `review_checklist` = { enforce: boolean }, default
// FALSE: with it off, approveCut behaves exactly as before (every caller,
// script and drill keeps working) and the Review Room still shows both blocks
// and holds its own Approve button until they are saved. With it on, the
// server refuses an approval the checks don't cover. Jordan turns it on once
// the deploy is checked.
//
// WHO SIGNS WHAT. TECH: anyone who may rule on cuts (canRuleOnCuts). CREATIVE
// on a program or premium video: Jordan (owner) or whoever sits in the
// creative-approver seat (James). On other videos any reviewer may sign it.
// Nobody signs a check on their own version.
// ---------------------------------------------------------------------------

export const REVIEW_CHECKLIST_SETTING = "review_checklist";
export type ReviewChecklistSettings = { enforce: boolean };

export async function reviewChecklistSettings(): Promise<ReviewChecklistSettings> {
  const s = await getSetting<Partial<ReviewChecklistSettings>>(REVIEW_CHECKLIST_SETTING, { enforce: false }).catch(() => ({ enforce: false }));
  return { enforce: s?.enforce === true };
}

type Actor = { realRole: string; impersonating: boolean; teamMemberId: string | null; status?: string; name: string | null; editorKey: string | null; id?: string | null; email?: string | null } | null | undefined;

/**
 * Is this person a CREATIVE approver? Jordan (the owner login) or the
 * creative-approver seat (review_room.creativeApproverTeamMemberId, James).
 * Kyle's admin login is not, by design. Sessionless local dev answers yes,
 * like every guard.
 */
export async function isCreativeApprover(me: Actor, opts: { authEnforced: boolean }): Promise<boolean> {
  if (!me) return !opts.authEnforced;
  if (me.impersonating) return false;
  if (me.realRole === "OWNER") return true;
  if (!me.teamMemberId) return false;
  const { reviewRoomRules } = await import("@/lib/settings");
  const rules = await reviewRoomRules().catch(() => null);
  if (!rules?.creativeApproverTeamMemberId || rules.creativeApproverTeamMemberId !== me.teamMemberId) return false;
  const tm = await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { active: true } }).catch(() => null);
  return !!tm?.active;
}

type CutFacts = { id: string; projectId: string; contentHash: string | null; sourceRev: string | null; submittedByKey: string | null; monthly: boolean; premium: boolean; selfCheckId: string | null };

async function cutFacts(submissionId: string): Promise<CutFacts | null> {
  const s = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, contentHash: true, sourceRev: true, submittedByKey: true, selfCheckId: true, project: { select: { contentMonthId: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } } } } },
  });
  if (!s) return null;
  const { videoTier } = await import("@/lib/projectStatus");
  return {
    id: s.id, projectId: s.projectId, contentHash: s.contentHash, sourceRev: s.sourceRev, submittedByKey: s.submittedByKey, selfCheckId: s.selfCheckId,
    monthly: !!s.project?.contentMonthId,
    premium: videoTier(s.project?.deliverables ?? []) === "premium",
  };
}

/** The bytes a check was made on still being the bytes on the version. */
const sameBytes = (row: { contentHash: string | null; sourceRev: string | null }, cut: { contentHash: string | null; sourceRev: string | null }) =>
  (row.contentHash ?? null) === (cut.contentHash ?? null) && (row.sourceRev ?? null) === (cut.sourceRev ?? null);

export type ChecklistStatus = {
  submissionId: string;
  creativeRequired: boolean;
  tech: BlockState;
  creative: BlockState;
  /** the saved CREATIVE row was signed by Jordan or the creative approver */
  creativeSignedByApprover: boolean;
  /** what the Approve button must say, or null when it may be pressed */
  approveBlockedReason: string | null;
  /** the editor's own check, as the TECH block's starting answers */
  prefill: Record<string, CheckAnswer>;
  enforce: boolean;
};

/** Everything the Review Room needs to draw both blocks for one version. */
export async function checklistStatus(submissionId: string): Promise<ChecklistStatus | null> {
  const cut = await cutFacts(submissionId);
  if (!cut) return null;
  const rows = await prisma.cutReviewCheck.findMany({ where: { submissionId, voidedAt: null }, orderBy: { checkedAt: "desc" } });
  const latest = (block: CheckBlock) => rows.find((r) => r.block === block) ?? null;
  const state = (block: CheckBlock): BlockState => {
    const r = latest(block);
    if (!r) return { block, saved: null, stale: false };
    let answers: CheckAnswer[] = [];
    try { answers = JSON.parse(r.answersJson) as CheckAnswer[]; } catch { answers = []; }
    return { block, saved: { by: r.checkedBy, atISO: r.checkedAt.toISOString(), role: r.checkedByRole, answers, note: r.note }, stale: !sameBytes(r, cut) };
  };
  const tech = state("TECH");
  const creative = state("CREATIVE");
  const creativeRequired = creativeApproverRequired(cut);
  const creativeRow = latest("CREATIVE");
  const creativeSignedByApprover = !!creativeRow && (creativeRow.checkedByRole === "OWNER" || creativeRow.checkedByRole === "CREATIVE_APPROVER");
  let prefill: Record<string, CheckAnswer> = {};
  if (cut.selfCheckId) {
    const { attestationFor } = await import("@/lib/selfCheckStore");
    const a = await attestationFor(submissionId).catch(() => null);
    prefill = prefillFromSelfCheck(a?.items ?? null);
  }
  const { enforce } = await reviewChecklistSettings();
  return {
    submissionId, creativeRequired, tech, creative, creativeSignedByApprover, prefill, enforce,
    approveBlockedReason: approvalBlockedReason({ tech, creative, creativeRequired, creativeSignedByApprover }),
  };
}

/**
 * Save one block against the exact version. The caller has already checked
 * the person may rule on cuts at all (requireCutReviewer). Returns plain words.
 */
export async function recordReviewCheck(input: {
  submissionId: string; block: CheckBlock; answers: CheckAnswer[]; note?: string | null;
  actor: Actor; authorName: string; authorUserId: string | null; authEnforced: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const cut = await cutFacts(input.submissionId);
  if (!cut) return { ok: false, message: "That version no longer exists." };
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId }, select: { status: true } });
  if (!sub || !["PENDING", "APPROVED", "CHANGES_REQUESTED"].includes(sub.status)) return { ok: false, message: "This version isn't in review, so there's nothing to check." };
  const { refuseOwnWork } = await import("@/lib/reviewerAssignment");
  const own = input.actor ? refuseOwnWork({ editorKey: input.actor.editorKey, realRole: input.actor.realRole, name: input.actor.name, impersonating: input.actor.impersonating }, cut.submittedByKey, "cut") : null;
  if (own) return { ok: false, message: "This is your own version: somebody else checks it." };
  const v = validateAnswers(input.block, input.answers);
  if (!v.ok) return v;
  const approver = await isCreativeApprover(input.actor, { authEnforced: input.authEnforced });
  if (input.block === "CREATIVE" && creativeApproverRequired(cut) && !approver) {
    return { ok: false, message: "On program and premium videos the creative check is James's or Jordan's." };
  }
  const role = !input.actor ? "OWNER" : input.actor.realRole === "OWNER" ? "OWNER" : approver ? "CREATIVE_APPROVER" : input.actor.realRole === "ADMIN" ? "ADMIN" : "REVIEWER";
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.cutReviewCheck.updateMany({ where: { submissionId: cut.id, block: input.block, voidedAt: null }, data: { voidedAt: now, voidReason: `replaced by ${input.authorName}` } });
    await tx.cutReviewCheck.create({
      data: {
        submissionId: cut.id, projectId: cut.projectId, block: input.block, checklistKey: CHECKLIST_KEY[input.block],
        answersJson: JSON.stringify(v.answers), note: (input.note ?? "").trim().slice(0, 1000) || null,
        contentHash: cut.contentHash, sourceRev: cut.sourceRev,
        checkedBy: input.authorName.slice(0, 120), checkedByUserId: input.authorUserId, checkedByTeamMemberId: input.actor?.teamMemberId ?? null, checkedByRole: role,
        checkedAt: now,
      },
    });
  });
  const na = v.answers.filter((a) => a.answer === "NA").length;
  await prisma.activity.create({ data: { projectId: cut.projectId, type: "SYSTEM", body: `${input.block === "TECH" ? "Technical" : "Creative"} check saved by ${input.authorName}${na ? ` (${na} line${na === 1 ? "" : "s"} marked doesn't apply)` : ""}.` } }).catch(() => {});
  return { ok: true, message: `${input.block === "TECH" ? "Technical" : "Creative"} check saved.` };
}

/**
 * approveCut's question (only while the switch is on): do this version's
 * saved checks cover an approval? Null = go ahead.
 */
export async function checklistRefusal(submissionId: string): Promise<string | null> {
  const { enforce } = await reviewChecklistSettings();
  if (!enforce) return null;
  const s = await checklistStatus(submissionId);
  if (!s) return "That version no longer exists.";
  return s.approveBlockedReason;
}

/** The two blocks a version was approved under, for the record (drill + timeline). */
export async function checksOn(submissionId: string): Promise<{ block: string; by: string; role: string | null; atISO: string }[]> {
  const rows = await prisma.cutReviewCheck.findMany({ where: { submissionId, voidedAt: null }, orderBy: { checkedAt: "asc" }, select: { block: true, checkedBy: true, checkedByRole: true, checkedAt: true } });
  return rows.map((r) => ({ block: r.block, by: r.checkedBy, role: r.checkedByRole, atISO: r.checkedAt.toISOString() }));
}

/** Items in display order, for a server-rendered summary. */
export function itemLabel(block: CheckBlock, key: string): string {
  return ITEMS_FOR[block].find((i) => i.key === key)?.label ?? key;
}
