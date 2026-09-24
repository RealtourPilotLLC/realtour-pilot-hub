import "server-only";
import { Prisma, type ContentReviewWindow } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { endOfBusinessDaysET, etDateTime, etDayKey } from "@/lib/datetime";
import { getAutomation, recordAutomationRun } from "@/lib/programAutomation";
import { DELIVERED_STAMP, cutSlots } from "@/lib/reviewCuts";
import { cutReleasedAt, videoCutKey } from "@/lib/contentVideos";
import { cutChainOf } from "@/lib/cutEntitlement";
import { isTestClientName } from "@/lib/testClients";
import { can } from "@/lib/portalAccess";
import type { PortalViewer } from "@/lib/portal";

// ---------------------------------------------------------------------------
// CLIENT REVIEW WINDOWS + THE PER-VIDEO REVISION LEDGER (completion audit
// CP-02/CP-03, Sep 24 2026).
//
// What the audit found, and what this file is the answer to:
//   · the "four business day review window" was an unpersisted per-MONTH clock
//     inside the reminder engine, computed from ReviewSubmission.clientReleasedAt
//     — a column nothing in the repo ever wrote. Review reminders could never
//     fire, nothing was quoted to the client and nothing was enforced;
//   · approve and "request changes" were not serialised server-side, so one cut
//     could hold both decisions (the page hid the second button, that was all);
//   · revision requests were throttled per PROJECT, so a client sending notes on
//     four videos of a batch was refused on the second one.
//
// ONE WINDOW PER RELEASED CUT (ContentReviewWindow, keyed by the submission).
// It opens when the Review Room releases the cut to the client, its deadline is
// frozen at that moment (endOfBusinessDaysET — the one ET weekday calendar, no
// holidays), and its state moves ONLY by compare-and-set (claimWindow). Approve,
// request and expiry all take that CAS, so they are mutually exclusive without
// a lock, and a lost race is a re-read, never a unique violation. The deadline
// on the row is the only one any surface reads: the portal panel, the reminder
// lane and enforcement.
//
// ONE LEDGER ROW PER REVISION ROUND (ContentRevisionRound), per logical video
// (videoKey — the same grouping cutHistory uses). Two rounds are included; a
// third needs the account owner's acknowledgement that a fee MAY apply, and the
// office then records CHARGE or WAIVE. Nothing here ever bills anyone.
//
// EVERYTHING CLIENT-VISIBLE IS BEHIND TWO SWITCHES, both OFF (a missing
// ProgramAutomation row): `revision_policy` (deadline, rounds used, the fee
// acknowledgement, late refusal, expiry → a task for Kyle) and
// `review_auto_approve` (expiry may write the automatic approval). With both
// off, windows and rounds are still RECORDED and the correctness fixes still
// hold — nothing new is shown to a client.
// ---------------------------------------------------------------------------

// ---- Jordan's defaults (Sep 24 2026) — each one constant, flip here ----------

/** Windows are recorded for releases from this instant (the deploy). The cron
 *  repair backfills a missed window only for cuts released since then, so no
 *  historical cut is ever given a deadline it was never told about. Midnight
 *  ET on the day this shipped — the same instant as CLIENT_APPROVAL_GATE_SINCE. */
export const REVIEW_WINDOW_EPOCH = new Date("2026-09-24T04:00:00Z");

/** Kyle's number, for anything that has to happen inside 24 hours. */
export const URGENT_CONTACT = "(215) 645-4889";

/** Who may acknowledge the extra-round fee. Jordan, Sep 24 2026: the account
 *  owner OR their assistant. So it follows the right to ASK for the round
 *  (portalAccess: requestChanges — OWNER and COLLABORATOR seats, and staff),
 *  with one exception: the emailed link, which carries no name, and an
 *  acknowledgement that a fee may apply has to be attributable to a person. */
export const FEE_ACK_PERMISSION = "requestChanges" as const;

/** An extra (3rd+) round goes to the editor AT ONCE and the office's
 *  CHARGE/WAIVE decision runs alongside it. false = the round is recorded and
 *  its notes are claimed, but it only reaches the editor once the office has
 *  decided (decideRevisionFee routes it). Nothing is ever charged either way. */
export const EXTRA_ROUND_ROUTES_IMMEDIATELY = true;

/** Code defaults for the `revision_policy` config. Snapshotted onto every
 *  window (businessDays) and round (includedRounds, feeCents) when written, so
 *  a later config change never rewrites what a client was told. */
export const REVISION_POLICY_DEFAULTS = {
  includedRounds: 2,
  extraRoundFeeCents: 5000,
  reviewBusinessDays: 4,
  /** Automatic approval only for TEST clients until Jordan says otherwise. */
  testClientsOnly: true,
  /** New rounds per enrollment per hour (the floor is videosPerMonth × 2). */
  maxNewRoundsPerHour: 12,
};

const LEASE_MS = 15 * 60_000;
const OPEN_STATES = ["OPEN", "CHANGES_REQUESTED"];

export type RevisionPolicy = {
  /** revision_policy is ON: the client-visible half runs. */
  on: boolean;
  enabledAt: Date | null;
  includedRounds: number;
  extraRoundFeeCents: number;
  reviewBusinessDays: number;
  maxNewRoundsPerHour: number;
  autoApprove: { on: boolean; enabledAt: Date | null; testClientsOnly: boolean };
};

const int = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

/** Both switches, read fresh every time (the owner's "stop" is the next call). */
export async function revisionPolicy(): Promise<RevisionPolicy> {
  const [pol, auto] = await Promise.all([getAutomation("revision_policy"), getAutomation("review_auto_approve")]);
  const cfg = pol.config ?? {};
  const acfg = auto.config ?? {};
  const d = REVISION_POLICY_DEFAULTS;
  const testOnly = typeof acfg.testClientsOnly === "boolean" ? acfg.testClientsOnly : typeof cfg.testClientsOnly === "boolean" ? cfg.testClientsOnly : d.testClientsOnly;
  return {
    on: pol.enabled,
    enabledAt: pol.enabled ? pol.enabledAt : null,
    includedRounds: int(cfg.includedRounds, 0, 10, d.includedRounds),
    extraRoundFeeCents: int(cfg.extraRoundFeeCents, 0, 100_000, d.extraRoundFeeCents),
    reviewBusinessDays: int(cfg.reviewBusinessDays, 1, 20, d.reviewBusinessDays),
    maxNewRoundsPerHour: int(cfg.maxNewRoundsPerHour, 1, 500, d.maxNewRoundsPerHour),
    // Auto-approval needs BOTH switches: it is enforcement of a deadline the
    // client can only have been shown with revision_policy on.
    autoApprove: { on: pol.enabled && auto.enabled, enabledAt: auto.enabled ? auto.enabledAt : null, testClientsOnly: testOnly },
  };
}

/** Is this window held to its deadline? Only windows opened while the policy
 *  was on — turning the switch on must never close reviews a client was never
 *  told had a deadline — and never a LAZY one. */
export function enforced(w: Pick<ContentReviewWindow, "source" | "openedAt">, p: RevisionPolicy): boolean {
  return p.on && w.source !== "LAZY" && !!p.enabledAt && w.openedAt.getTime() >= p.enabledAt.getTime();
}

/** "Thu, Oct 1, 5:00 PM ET" — the one way a deadline is written anywhere. */
export const deadlineLabel = (d: Date) => `${etDateTime(d)} ET`;

/** The sentence the fee checkbox shows, stored verbatim on the round it
 *  authorised (feeAckText). Pure. No em dashes: a client reads it. */
export function extraRoundAckText(p: { ordinal: number; includedRounds: number; feeCents: number }): string {
  const dollars = p.feeCents % 100 === 0 ? String(p.feeCents / 100) : (p.feeCents / 100).toFixed(2);
  return `This would be revision round ${p.ordinal} for this video. Your plan includes ${p.includedRounds} revision round${p.includedRounds === 1 ? "" : "s"} per video; an additional round may carry a $${dollars} fee. Our team confirms before anything is charged.`;
}

/** May this seat give the fee acknowledgement? (FEE_ACK_PERMISSION) */
export const mayAcknowledgeFee = (viewer: PortalViewer) => viewer.actor.kind !== "TOKEN" && can(viewer, FEE_ACK_PERMISSION);

// ---- identity -------------------------------------------------------------

type CutIdentity = { id: string; projectId: string; deliverableId?: string | null; slot?: number | null; assetPath?: string | null; fileName?: string | null };

/** One logical video: `${projectId}:${videoCutKey}` — the grouping cutHistory,
 *  the library and the release rule all use (contentVideos.videoCutKey). */
export function videoKeyOf(s: CutIdentity): string {
  return `${s.projectId}:${videoCutKey(s)}`;
}

/** What the office and the editor call this video: "Video 2 of 4" on a batch
 *  with one video row, the Style Guide name otherwise, the file for a legacy
 *  folder cut. */
export async function videoLabelOf(s: { projectId: string; deliverableId?: string | null; slot?: number | null; fileName?: string | null; round?: number | null }): Promise<string> {
  if (s.deliverableId) {
    const slots = await cutSlots(s.projectId).catch(() => []);
    const hit = slots.find((x) => x.deliverableId === s.deliverableId && x.slot === (s.slot ?? 1));
    if (hit) {
      const rows = new Set(slots.map((x) => x.deliverableId)).size;
      return rows === 1 && hit.count > 1 ? `Video ${hit.slot} of ${hit.count}` : hit.label;
    }
  }
  return s.fileName ?? (s.round ? `the cut (v${s.round})` : "the cut");
}

/** The per-video row (DeliverableOutput) a keyed cut belongs to, or null for
 *  a legacy folder cut — never guessed. */
export async function outputIdFor(s: { projectId: string; deliverableId?: string | null; slot?: number | null }): Promise<string | null> {
  if (!s.deliverableId) return null;
  const o = await prisma.deliverableOutput.findFirst({ where: { projectId: s.projectId, deliverableId: s.deliverableId, slot: s.slot ?? 1 }, select: { id: true } }).catch(() => null);
  return o?.id ?? null;
}

const SUB_SELECT = {
  id: true, projectId: true, round: true, status: true, decidedAt: true, decidedBy: true, clientReleasedAt: true, clientRequestedAt: true,
  assetUrl: true, assetPath: true, fileName: true, deliverableId: true, slot: true, videoId: true, createdAt: true,
} as const;
type SubRow = { id: string; projectId: string; round: number; status: string; decidedAt: Date | null; decidedBy: string | null; clientReleasedAt: Date | null; clientRequestedAt: Date | null; assetUrl: string | null; assetPath: string | null; fileName: string | null; deliverableId: string | null; slot: number; videoId: string | null; createdAt: Date };
type Owner = { enrollmentId: string; clientId: string };

/** The program a job belongs to — the same rule submissionForEnrollment
 *  applies: the month's enrollment must be the PROJECT's client's. */
async function programOf(contentMonthId: string | null, projectClientId: string | null): Promise<Owner | null> {
  if (!contentMonthId || !projectClientId) return null;
  const month = await prisma.contentMonth.findUnique({ where: { id: contentMonthId }, select: { enrollmentId: true } });
  if (!month) return null;
  const e = await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { id: true, clientId: true } });
  return e && e.clientId === projectClientId ? { enrollmentId: e.id, clientId: e.clientId } : null;
}

// ---- opening -----------------------------------------------------------------

/**
 * The Review Room released this cut to the client (its internal APPROVED).
 * Stamps ReviewSubmission.clientReleasedAt — nothing ever did — and opens the
 * cut's window with its deadline frozen. Idempotent: a second call returns the
 * same window. Returns null for anything that is not a client-visible content
 * cut (the delivery auto-stamp, a cut with no playable file, a job that is not
 * on a program month, or one whose month belongs to another client).
 */
export async function openReviewWindow(submissionId: string, opts: { at?: Date; by?: string | null; source?: "RELEASE" | "REPAIR" } = {}): Promise<ContentReviewWindow | null> {
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { ...SUB_SELECT, project: { select: { clientId: true, contentMonthId: true } } } });
  if (!sub || sub.status !== "APPROVED" || sub.decidedBy === DELIVERED_STAMP || !sub.assetUrl || !sub.project?.contentMonthId) return null;
  const owner = await programOf(sub.project.contentMonthId, sub.project.clientId);
  if (!owner) return null;
  // The TRUE release time is kept: a repair that runs an hour late must not
  // hand the client an hour more than they were given.
  const openedAt = sub.clientReleasedAt ?? opts.at ?? sub.decidedAt ?? new Date();
  await prisma.reviewSubmission.updateMany({ where: { id: submissionId, clientReleasedAt: null }, data: { clientReleasedAt: openedAt, clientReleasedBy: (opts.by ?? "Review Room").slice(0, 120) } });
  // A window written LATE — the repair, or ensureWindow's REPAIR branch — can
  // meet a cut the client already decided: anything released between the epoch
  // and the deploy was approvable under the old code, which wrote no window.
  // Opening it OPEN regardless let a change request win over a live approval.
  // So the state is read off the decisions, exactly as a LAZY window's is; a
  // fresh release has none and opens OPEN.
  const settled = await stateFromDecisions(submissionId, owner.enrollmentId);
  return writeWindow(sub, owner, { openedAt, source: opts.source ?? "RELEASE", ...settled });
}

/** The window state a cut's latest LIVE decision means, and that decision. */
async function stateFromDecisions(submissionId: string, enrollmentId: string): Promise<{ state: string; decisionId: string | null }> {
  const last = await prisma.clientDecision.findFirst({
    where: { submissionId, enrollmentId, receiptState: { not: "SUPERSEDED" }, supersededById: null },
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    select: { id: true, decision: true, basis: true },
  });
  const state = last?.decision === "APPROVE" ? (last.basis === "AUTO_EXPIRY" ? "AUTO_APPROVED" : "APPROVED") : last?.decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "OPEN";
  return { state, decisionId: last?.id ?? null };
}

async function writeWindow(sub: SubRow, owner: Owner, w: { openedAt: Date; source: string; state: string; decisionId: string | null }): Promise<ContentReviewWindow | null> {
  const videoKey = videoKeyOf(sub);
  const existing = await prisma.contentReviewWindow.findUnique({ where: { submissionId: sub.id } });
  if (existing) return rehome(existing, sub, owner, w);
  const policy = await revisionPolicy();
  const outputId = await outputIdFor(sub);
  // A LATER release of the same video already holds the video's window (a
  // repair running out of order): this one is history the moment it is written.
  const newer = await prisma.contentReviewWindow.count({ where: { videoKey, openedAt: { gt: w.openedAt }, state: { not: "REMOVED" } } });
  const now = new Date();
  const closed = newer > 0 ? { state: "SUPERSEDED", closedAt: now, closedReason: "a later version was already released" } : { state: w.state, closedAt: w.state === "OPEN" || w.state === "CHANGES_REQUESTED" ? null : now, closedReason: null };
  // createMany + skipDuplicates: two openers racing on one cut (the Review Room
  // and a repair, or two portal reads) land on ONE row with no unique violation.
  const made = await prisma.contentReviewWindow.createMany({
    data: [{
      submissionId: sub.id, videoKey, videoId: sub.videoId, outputId, projectId: sub.projectId, enrollmentId: owner.enrollmentId, clientId: owner.clientId,
      round: sub.round, source: w.source, openedAt: w.openedAt, businessDays: policy.reviewBusinessDays,
      deadlineAt: endOfBusinessDaysET(w.openedAt, policy.reviewBusinessDays), decisionId: w.decisionId, ...closed,
    }],
    skipDuplicates: true,
  });
  const row = await prisma.contentReviewWindow.findUnique({ where: { submissionId: sub.id } });
  if (row && made.count === 1 && newer === 0) await supersedeEarlier(row, sub, owner);
  return row;
}

/** A cut that was MOVED to another job keeps its one window row (submissionId
 *  is unique) — released on the new job, the row is re-homed there with a fresh
 *  window. The source client's rounds stay on the source video. */
async function rehome(existing: ContentReviewWindow, sub: SubRow, owner: Owner, w: { openedAt: Date; source: string; state: string; decisionId: string | null }): Promise<ContentReviewWindow> {
  if (!(existing.state === "REMOVED" && existing.closedReason === "MOVED" && existing.projectId !== sub.projectId)) return existing;
  const policy = await revisionPolicy();
  const won = await prisma.contentReviewWindow.updateMany({
    where: { id: existing.id, state: "REMOVED", projectId: existing.projectId },
    data: {
      videoKey: videoKeyOf(sub), projectId: sub.projectId, enrollmentId: owner.enrollmentId, clientId: owner.clientId, round: sub.round, videoId: sub.videoId,
      outputId: null, source: w.source, openedAt: w.openedAt, businessDays: policy.reviewBusinessDays, deadlineAt: endOfBusinessDaysET(w.openedAt, policy.reviewBusinessDays),
      originalDeadlineAt: null, restartedAt: null, restartedBy: null, state: w.state, decisionId: w.decisionId, closedAt: null, closedReason: null,
      holdReason: null, heldBy: null, heldAt: null, clientNotifiedAt: null, firstViewedAt: null, expiryClaimedAt: null, expiryOutcome: null, expiryTaskId: null,
      closeEvidenceJson: JSON.stringify({ movedFrom: { projectId: existing.projectId, videoKey: existing.videoKey, openedAt: existing.openedAt } }),
    },
  });
  const row = (await prisma.contentReviewWindow.findUnique({ where: { id: existing.id } }))!;
  if (won.count === 1) await supersedeEarlier(row, sub, owner);
  return row;
}

/** A release answers what came before it on the same video: earlier live
 *  windows are SUPERSEDED, the client's open rounds are ANSWERED by this cut,
 *  their change requests read DONE, and every other earlier live decision is
 *  superseded. Idempotent. */
async function supersedeEarlier(w: ContentReviewWindow, sub: SubRow, owner: Owner): Promise<void> {
  const now = new Date();
  await prisma.contentReviewWindow.updateMany({
    where: { videoKey: w.videoKey, id: { not: w.id }, state: { in: OPEN_STATES }, openedAt: { lte: w.openedAt } },
    data: { state: "SUPERSEDED", closedAt: now, closedReason: `replaced by v${sub.round}` },
  });
  const answering = await prisma.contentRevisionRound.findMany({ where: { videoKey: w.videoKey, state: "OPEN", createdAt: { lte: w.openedAt }, submissionId: { not: sub.id } }, select: { id: true, decisionId: true } });
  if (answering.length) {
    await prisma.contentRevisionRound.updateMany({ where: { id: { in: answering.map((r) => r.id) }, state: "OPEN" }, data: { state: "ANSWERED", answeredBySubmissionId: sub.id, answeredAt: w.openedAt } });
    await prisma.clientDecision.updateMany({ where: { id: { in: answering.map((r) => r.decisionId) }, receiptState: { in: ["RECEIVED", "ROUTED", "IN_PROGRESS"] } }, data: { receiptState: "DONE", dedupeKey: null } });
  }
  const { supersedeEarlierRounds } = await import("@/lib/clientDecisions");
  await supersedeEarlierRounds(owner.enrollmentId, { id: sub.id, round: sub.round }, null);
}

/**
 * The window of a cut the client is acting on, made if it does not exist yet.
 * A cut the Review Room released after REVIEW_WINDOW_EPOCH whose window write
 * failed gets its real window (REPAIR, deadline from the true release). Any
 * other released cut — one released before windows were recorded — gets a
 * LAZY window whose state is read off the decisions it already has. LAZY
 * windows are never enforced and never auto-approved.
 */
export async function ensureWindow(submissionId: string, owner: Owner): Promise<ContentReviewWindow | null> {
  const existing = await prisma.contentReviewWindow.findUnique({ where: { submissionId } });
  if (existing) return reviveIfCurrent(existing);
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: SUB_SELECT });
  if (!sub) return null;
  const releasedAt = cutReleasedAt(sub);
  if (!releasedAt) return null;
  if (sub.status === "APPROVED" && sub.decidedBy !== DELIVERED_STAMP && sub.assetUrl && releasedAt.getTime() >= REVIEW_WINDOW_EPOCH.getTime()) {
    const w = await openReviewWindow(submissionId, { at: releasedAt, by: sub.decidedBy, source: "REPAIR" });
    if (w) return w;
  }
  return writeWindow(sub, owner, { openedAt: releasedAt, source: "LAZY", ...(await stateFromDecisions(submissionId, owner.enrollmentId)) });
}

/** A window SUPERSEDED by a newer version that was then taken back (removeCut)
 *  is the current version's window again. It reopens with its ORIGINAL
 *  deadline and a hold, so a restored version is never auto-approved on a
 *  clock the client may not know restarted. */
async function reviveIfCurrent(w: ContentReviewWindow): Promise<ContentReviewWindow> {
  if (w.state !== "SUPERSEDED") return w;
  const chain = await cutChainOf(w.submissionId);
  const released = chain.filter((r) => cutReleasedAt(r));
  if (released[released.length - 1]?.id !== w.submissionId) return w;
  const now = new Date();
  await prisma.contentReviewWindow.updateMany({
    where: { id: w.id, state: "SUPERSEDED" },
    data: { state: "OPEN", closedAt: null, closedReason: null, decisionId: null, heldAt: now, heldBy: "system", holdReason: "restored after a newer version was taken back" },
  });
  return (await prisma.contentReviewWindow.findUnique({ where: { id: w.id } })) ?? w;
}

/** THE REFEREE. Move a window from one of `from` to `to` iff it is still there
 *  (and `extraWhere` still holds). true = this caller won. */
export async function claimWindow(id: string, from: string[], to: string, extraWhere: Record<string, unknown> = {}, data: Record<string, unknown> = {}): Promise<boolean> {
  const r = await prisma.contentReviewWindow.updateMany({ where: { id, state: { in: from }, ...extraWhere }, data: { state: to, ...data } });
  return r.count === 1;
}

/** The cut left the job (removed: the row is deleted; moved: it belongs to
 *  another job now). Its window stops, whatever state it was in. */
export async function closeReviewWindow(submissionId: string, reason: "REMOVED" | "MOVED"): Promise<void> {
  await prisma.contentReviewWindow.updateMany({ where: { submissionId, state: { not: "REMOVED" } }, data: { state: "REMOVED", closedAt: new Date(), closedReason: reason } }).catch(() => {});
}

/** Rounds this video has used: every round that was not cancelled. */
export async function roundsUsed(videoKey: string): Promise<number> {
  return prisma.contentRevisionRound.count({ where: { videoKey, state: { not: "CANCELLED" } } });
}

// ---- the portal panel ----------------------------------------------------------

export type ReviewPanel = {
  state: string;
  /** Set only when the window is held to its deadline. */
  deadlineISO: string | null;
  deadlineLabel: string | null;
  /** The deadline has passed on an undecided, enforced window. */
  closed: boolean;
  autoApproveOn: boolean;
  roundsUsed: number;
  includedRounds: number;
  nextRoundOrdinal: number;
  nextRoundNeedsAck: boolean;
  ackText: string | null;
  mayAcknowledge: boolean;
  /** Kyle's number, when the deadline is inside 24 hours or has passed. */
  urgentContact: string | null;
};

/**
 * What the portal shows under the video: the deadline and the rounds. The
 * SINGLE source for it — the same row enforcement and the reminders read.
 * null while revision_policy is off, so the page is exactly what it was.
 */
export async function reviewPanelFor(viewer: PortalViewer, submissionId: string, now = new Date()): Promise<ReviewPanel | null> {
  const policy = await revisionPolicy();
  if (!policy.on) return null;
  const w = await prisma.contentReviewWindow.findUnique({ where: { submissionId } });
  if (!w || w.enrollmentId !== viewer.enrollment.id || w.clientId !== viewer.enrollment.clientId) return null;
  const [used, sent] = await Promise.all([roundsUsed(w.videoKey), sentOutsidePortal([w.submissionId])]);
  // Kyle already sent this version to the client (Mark as sent): there is no
  // review clock to show them on a video they have.
  const held = enforced(w, policy) && !sent.has(w.submissionId);
  const next = used + 1;
  const needsAck = next > policy.includedRounds;
  const open = w.state === "OPEN";
  return {
    state: w.state,
    deadlineISO: held ? w.deadlineAt.toISOString() : null,
    deadlineLabel: held ? deadlineLabel(w.deadlineAt) : null,
    closed: held && open && now.getTime() > w.deadlineAt.getTime(),
    autoApproveOn: held && policy.autoApprove.on && !!policy.autoApprove.enabledAt && w.openedAt >= policy.autoApprove.enabledAt,
    roundsUsed: used,
    includedRounds: policy.includedRounds,
    nextRoundOrdinal: next,
    nextRoundNeedsAck: needsAck,
    ackText: needsAck ? extraRoundAckText({ ordinal: next, includedRounds: policy.includedRounds, feeCents: policy.extraRoundFeeCents }) : null,
    mayAcknowledge: mayAcknowledgeFee(viewer),
    urgentContact: held && open && w.deadlineAt.getTime() - now.getTime() < 24 * 3_600_000 ? URGENT_CONTACT : null,
  };
}

// ---- expiry ------------------------------------------------------------------

export type Hold = { code: string; why: string };

/** Everything that stops an expired window being approved automatically. Any
 *  one of them hands the window to Kyle instead. */
export async function holdsFor(w: ContentReviewWindow, p: RevisionPolicy): Promise<Hold[]> {
  const holds: Hold[] = [];
  if (w.state !== "OPEN") holds.push({ code: "STATE", why: `the window is ${w.state}` });
  if (w.source === "LAZY") holds.push({ code: "LAZY", why: "the version was released before review windows were recorded" });
  if (!p.enabledAt || w.openedAt < p.enabledAt) holds.push({ code: "PRE_POLICY", why: "the version was released before review deadlines were switched on" });
  if (!p.autoApprove.enabledAt || w.openedAt < p.autoApprove.enabledAt) holds.push({ code: "PRE_AUTO", why: "the version was released before automatic approval was switched on" });
  const [enrollment, client, openNotes, chain] = await Promise.all([
    prisma.contentEnrollment.findUnique({ where: { id: w.enrollmentId }, select: { status: true, accessRevokedAt: true } }),
    prisma.client.findUnique({ where: { id: w.clientId }, select: { name: true } }),
    prisma.portalComment.count({ where: { submissionId: w.submissionId, enrollmentId: w.enrollmentId, status: "OPEN", parentId: null, resolvedAt: null } }),
    cutChainOf(w.submissionId),
  ]);
  if (!enrollment || enrollment.status !== "ACTIVE") holds.push({ code: "ENROLLMENT", why: `the program is ${enrollment?.status ?? "missing"}` });
  if (enrollment?.accessRevokedAt) holds.push({ code: "ACCESS_REVOKED", why: "portal access is revoked" });
  if (w.heldAt) holds.push({ code: "STAFF_HOLD", why: `held${w.heldBy ? ` by ${w.heldBy}` : ""}: ${w.holdReason ?? "no reason given"}` });
  if (openNotes > 0) holds.push({ code: "OPEN_NOTES", why: `${openNotes} note${openNotes === 1 ? "" : "s"} on the cut the client has not sent` });
  const sub = chain.find((r) => r.id === w.submissionId);
  const released = chain.filter((r) => cutReleasedAt(r));
  if (!sub) holds.push({ code: "NO_CUT", why: "the cut no longer exists" });
  else {
    if (released[released.length - 1]?.id !== sub.id) holds.push({ code: "NOT_CURRENT", why: "a newer version is the client's current one" });
    if (!sub.assetUrl) holds.push({ code: "NO_FILE", why: "the cut has no playable file" });
  }
  if (!w.clientNotifiedAt && !w.firstViewedAt) holds.push({ code: "NEVER_SEEN", why: "the client was never sent a reminder and never opened it" });
  if (p.autoApprove.testClientsOnly && !isTestClientName(client?.name)) holds.push({ code: "NOT_TEST", why: "automatic approval is limited to TEST clients (testClientsOnly)" });
  return holds;
}

/**
 * The hourly pass (cron step `reviewWindows`). Gated on revision_policy: with
 * it off this reads one switch and returns. An expired OPEN window is claimed
 * under a 15-minute lease, then either handed to Kyle as a task (any hold, or
 * review_auto_approve off) or approved automatically — the identical APPROVE
 * row a client's own press writes (recordClientApproval), basis AUTO_EXPIRY,
 * with the evidence it was decided on. Each window is processed once.
 */
export async function sweepReviewWindows(opts: { now?: Date; max?: number } = {}): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const p = await revisionPolicy();
  if (!p.on) return { skipped: "revision_policy is off" };
  // Only windows HELD to their deadline expire (enforced()): never a LAZY one,
  // never one opened before the policy was switched on. Every window is
  // recorded with the switch off, so without this the day Jordan turned it on
  // every undecided window since the deploy became a HIGH task for Kyle about
  // a deadline its client was never shown.
  if (!p.enabledAt) return { skipped: "revision_policy has no enabledAt — nothing is held to a deadline" };
  const staleLease = { OR: [{ expiryClaimedAt: null }, { expiryClaimedAt: { lt: new Date(now.getTime() - LEASE_MS) } }] };
  const due = await prisma.contentReviewWindow.findMany({
    where: { state: "OPEN", deadlineAt: { lte: now }, expiryOutcome: null, source: { not: "LAZY" }, openedAt: { gte: p.enabledAt }, ...staleLease },
    orderBy: { deadlineAt: "asc" },
    take: opts.max ?? 25,
  });
  const sent = await sentOutsidePortal(due.map((w) => w.submissionId));
  const out = { due: due.length, autoApproved: 0, toOffice: 0, decidedMeanwhile: 0, sentOutside: 0, errors: [] as string[] };
  for (const w of due) {
    // Kyle sent it (Mark as sent): the client has the file, and a link-token
    // client could never have closed this window by approving. Settled once,
    // with no task — it stays OPEN, so the client can still ask for changes.
    if (sent.has(w.submissionId)) {
      const r = await prisma.contentReviewWindow.updateMany({ where: { id: w.id, state: "OPEN", expiryOutcome: null }, data: { expiryOutcome: "SENT_OUTSIDE_PORTAL" } });
      out.sentOutside += r.count;
      continue;
    }
    const lease = await prisma.contentReviewWindow.updateMany({ where: { id: w.id, state: "OPEN", expiryOutcome: null, ...staleLease }, data: { expiryClaimedAt: now } });
    if (lease.count === 0) continue;
    try {
      // Automatic approval off: every expiry is the office's, whatever else is true.
      const holds = p.autoApprove.on ? await holdsFor(w, p) : [{ code: "AUTO_OFF", why: "automatic approval is switched off" }];
      const outcome = holds.length ? await handToOffice(w, holds, now) : await autoApprove(w, now, p);
      if (outcome === "approved") out.autoApproved++;
      else if (outcome === "office") out.toOffice++;
      else out.decidedMeanwhile++;
    } catch (e) {
      // The lease stands; the next pass after it lapses tries again.
      out.errors.push(`${w.id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }
  const err = out.errors.length ? out.errors.join(" · ").slice(0, 1500) : null;
  await recordAutomationRun("revision_policy", err);
  if (p.autoApprove.on) await recordAutomationRun("review_auto_approve", err);
  return out;
}

async function handToOffice(w: ContentReviewWindow, holds: Hold[], now: Date): Promise<"office" | "lost"> {
  // The client (or staff) decided while this pass was reading: nothing to hand over.
  const still = await prisma.contentReviewWindow.findFirst({ where: { id: w.id, state: "OPEN", expiryClaimedAt: now }, select: { id: true } });
  if (!still) return "lost";
  const [client, sub] = await Promise.all([
    prisma.client.findUnique({ where: { id: w.clientId }, select: { name: true } }),
    prisma.reviewSubmission.findUnique({ where: { id: w.submissionId }, select: { projectId: true, deliverableId: true, slot: true, fileName: true, round: true, project: { select: { title: true } } } }),
  ]);
  let taskId: string | null = null;
  // TEST records make no owner work (the reminder escalation's rule): the
  // window's own expiryOutcome is the evidence, nobody's to-do list grows.
  if (!isTestClientName(client?.name)) {
    const label = sub ? await videoLabelOf(sub) : "a video";
    const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } });
    const key = `review-expired:${w.id}`;
    await prisma.smartTask.createMany({
      data: [{
        taskType: "content_review_expired", status: "OPEN", source: "content_program", priority: "HIGH",
        title: `${client?.name ?? "Client"}: review window closed on ${label}`.slice(0, 140),
        summary: `The client's review window closed ${deadlineLabel(w.deadlineAt)} with no approval and no change request. Nothing was approved automatically: ${holds.map((h) => h.why).join("; ")}.`.slice(0, 500),
        description: `Version ${w.round} of ${label}${sub?.project?.title ? ` on ${sub.project.title}` : ""} was released ${deadlineLabel(w.openedAt)} and the client has not answered.\n\nWhy it was not approved automatically:\n${holds.map((h) => `• ${h.why}`).join("\n")}\n\nCall or text the client, restart the review clock, or approve it on their behalf from their portal. Open /content/${w.enrollmentId}?tab=content.`.slice(0, 4000),
        reasonCreated: "Client review window expired (spec §8, CP-02)",
        clientId: w.clientId, projectId: w.projectId, assignedKey: "kyle", ownerId: kyle?.id ?? null, dedupeKey: key,
        dueAt: new Date(now.getTime() + 864e5),
      }],
      skipDuplicates: true,
    });
    taskId = (await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } }))?.id ?? null;
  }
  await prisma.contentReviewWindow.updateMany({
    where: { id: w.id, expiryClaimedAt: now },
    data: { expiryOutcome: holds.length === 1 && holds[0].code === "AUTO_OFF" ? "MANUAL" : `HELD:${holds.map((h) => h.code).join(",")}`, expiryTaskId: taskId },
  });
  return "office";
}

async function autoApprove(w: ContentReviewWindow, now: Date, p: RevisionPolicy): Promise<"approved" | "office" | "lost"> {
  const label = deadlineLabel(w.deadlineAt);
  // The deadline is in the predicate: a change request that landed a second
  // before it took the window first, and this loses (claimWindow is the referee).
  const won = await claimWindow(w.id, ["OPEN"], "AUTO_APPROVED", { deadlineAt: { lte: now }, expiryClaimedAt: now }, { closedAt: now, closedReason: "AUTO_EXPIRY" });
  if (!won) return "lost";
  const cut = await prisma.reviewSubmission.findUnique({ where: { id: w.submissionId }, select: { id: true, projectId: true, round: true, videoId: true, contentHash: true, sizeBytes: true, fileName: true, deliverableId: true, slot: true } }).catch(() => null);
  const { recordClientApproval } = await import("@/lib/clientDecisions");
  // A throw is a failure like any other: the window is given back below, or it
  // would sit AUTO_APPROVED with no approval behind it, where the sweep (OPEN
  // only) never looks again.
  const r: { ok: true; decisionId: string } | { ok: false; message: string } = cut
    ? await recordClientApproval({
        enrollmentId: w.enrollmentId, clientId: w.clientId, cut,
        // No person: the label says what happened, and isMine() never reads it as "you".
        actor: { clientUserId: null, staffUserId: null, actorLabel: `Automatic approval (no response by ${label})`, membershipRole: "SYSTEM", resolvedByKind: "SYSTEM" },
        basis: "AUTO_EXPIRY", windowId: w.id,
      }).catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message.slice(0, 200) : String(e) }))
    : { ok: false, message: "the cut no longer exists" };
  if (!r.ok) {
    await claimWindow(w.id, ["AUTO_APPROVED"], "OPEN", {}, { closedAt: null, closedReason: null });
    return handToOffice(w, [{ code: "APPROVAL_FAILED", why: `the automatic approval did not save (${r.message})` }], now);
  }
  const evidence = {
    decidedAt: now.toISOString(), openedAt: w.openedAt.toISOString(), deadlineAt: w.deadlineAt.toISOString(), source: w.source,
    clientNotifiedAt: w.clientNotifiedAt?.toISOString() ?? null, firstViewedAt: w.firstViewedAt?.toISOString() ?? null, holds: [],
    policy: { includedRounds: p.includedRounds, reviewBusinessDays: w.businessDays, testClientsOnly: p.autoApprove.testClientsOnly, policyEnabledAt: p.enabledAt?.toISOString() ?? null, autoEnabledAt: p.autoApprove.enabledAt?.toISOString() ?? null },
  };
  await prisma.contentReviewWindow.update({ where: { id: w.id }, data: { decisionId: r.decisionId, closeEvidenceJson: JSON.stringify(evidence), expiryOutcome: "AUTO_APPROVED" } });
  const videoLabel = cut ? await videoLabelOf(cut) : "the video";
  await prisma.activity.create({ data: { projectId: w.projectId, type: "SYSTEM", body: `Client review window closed ${label} with no answer — version ${w.round} of ${videoLabel} was approved automatically.`.slice(0, 500) } }).catch(() => {});
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const client = await prisma.client.findUnique({ where: { id: w.clientId }, select: { name: true } });
    await notifyInApp({
      kind: "review_auto_approved",
      title: `Approved automatically — ${client?.name ?? "a client"}`,
      body: `${videoLabel} (v${w.round}): no answer by ${label}.`,
      href: `/content/${w.enrollmentId}?tab=content`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `review-auto-${w.id}`,
    });
  } catch { /* the decision is the record; the bell is a courtesy */ }
  return "approved";
}

// ---- repair --------------------------------------------------------------------

/**
 * Content cuts the Review Room released since REVIEW_WINDOW_EPOCH that have no
 * window (the approve-time write is best-effort). The true release time is
 * kept, so a repair never extends a deadline. Normally opens nothing.
 *
 * "Has no window" is IN THE QUERY (NOT EXISTS), and so is programOf's rule
 * (the month's enrollment is the project's client's). It used to take the
 * oldest max×3 approved cuts and filter afterwards — approved cuts stay
 * APPROVED for good, so once 300 of them had windows every run re-read the
 * same 300, opened nothing, and reported itself healthy.
 *
 * Second pass: a window claimed APPROVED / AUTO_APPROVED whose approval row
 * was never written (the writer died between the compare-and-set and the
 * row) is given back — two minutes on, and only when NO approval of that cut
 * exists at all, so an earlier round whose approval was merely superseded is
 * never touched.
 */
export async function repairReviewWindows(opts: { max?: number; now?: Date } = {}): Promise<{ checked: number; opened: number; orphansReleased: number }> {
  const max = opts.max ?? 100;
  const now = opts.now ?? new Date();
  // Instants go in as ISO text, read as UTC: the columns are naive UTC
  // timestamps, and a bound Date is otherwise read in the session's zone.
  const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const cands = await prisma.$queryRaw<{ id: string; decidedBy: string | null }[]>`
    SELECT s."id", s."decidedBy"
      FROM "ReviewSubmission" s
      JOIN "Project" p ON p."id" = s."projectId"
      JOIN "ContentMonth" m ON m."id" = p."contentMonthId"
      JOIN "ContentEnrollment" e ON e."id" = m."enrollmentId" AND e."clientId" = p."clientId"
     WHERE s."status" = 'APPROVED'
       AND s."decidedAt" >= ${utc(REVIEW_WINDOW_EPOCH)}
       AND s."assetUrl" IS NOT NULL
       AND (s."decidedBy" IS NULL OR s."decidedBy" <> ${DELIVERED_STAMP})
       AND NOT EXISTS (SELECT 1 FROM "ContentReviewWindow" w WHERE w."submissionId" = s."id")
     ORDER BY s."decidedAt" ASC
     LIMIT ${max}::int`;
  let opened = 0;
  for (const c of cands) {
    // openReviewWindow dates it from the cut's own decidedAt (the true release).
    const w = await openReviewWindow(c.id, { by: c.decidedBy, source: "REPAIR" }).catch(() => null);
    if (w) opened++;
  }

  const cutoff = new Date(now.getTime() - 2 * 60_000);
  const orphanIds = await prisma.$queryRaw<{ id: string }[]>`
    SELECT w."id"
      FROM "ContentReviewWindow" w
     WHERE w."state" IN ('APPROVED', 'AUTO_APPROVED')
       AND w."updatedAt" < ${utc(cutoff)}
       AND NOT EXISTS (SELECT 1 FROM "ClientDecision" d WHERE d."submissionId" = w."submissionId" AND d."decision" = 'APPROVE')
     LIMIT ${max}::int`;
  const orphans = orphanIds.length
    ? await prisma.contentReviewWindow.findMany({ where: { id: { in: orphanIds.map((o) => o.id) } }, select: { id: true, state: true, updatedAt: true, videoKey: true, openedAt: true } })
    : [];
  let orphansReleased = 0;
  for (const o of orphans) {
    // A later version already holds the video's review: this one is history.
    const newer = await prisma.contentReviewWindow.count({ where: { videoKey: o.videoKey, openedAt: { gt: o.openedAt }, state: { not: "REMOVED" } } });
    const r = await prisma.contentReviewWindow.updateMany({
      where: { id: o.id, state: o.state, updatedAt: o.updatedAt },
      data: newer
        ? { state: "SUPERSEDED", closedAt: now, closedReason: "a later version was already released" }
        // An automatic approval that never saved goes back to the sweep, which
        // tries it again (expiryOutcome cleared).
        : { state: "OPEN", closedAt: null, closedReason: null, decisionId: null, ...(o.state === "AUTO_APPROVED" ? { expiryOutcome: null, expiryClaimedAt: null } : {}) },
    });
    orphansReleased += r.count;
  }
  return { checked: cands.length, opened, orphansReleased };
}

// ---- the office's controls -------------------------------------------------------

type Ok = { ok: boolean; message: string };

/**
 * CHARGE or WAIVE an extra round's fee. Records the decision and closes the
 * office's card — it makes NO billing call of any kind; a charge is invoiced
 * the usual way by a person. Compare-and-set on PENDING, so a second press
 * says who already decided.
 */
export async function decideRevisionFee(roundId: string, decision: "CHARGE" | "WAIVE", by: string, note?: string | null): Promise<Ok> {
  if (decision !== "CHARGE" && decision !== "WAIVE") return { ok: false, message: "Choose charge or waive." };
  const now = new Date();
  const won = await prisma.contentRevisionRound.updateMany({
    where: { id: roundId, feeDecision: "PENDING" },
    data: { feeDecision: decision, feeDecidedAt: now, feeDecidedBy: by.slice(0, 120), feeDecisionNote: note?.trim().slice(0, 500) || null },
  });
  const round = await prisma.contentRevisionRound.findUnique({ where: { id: roundId } });
  if (!round) return { ok: false, message: "That revision round no longer exists." };
  if (won.count === 0) {
    return round.feeDecision === "CHARGE" || round.feeDecision === "WAIVE"
      ? { ok: false, message: `Already decided: ${round.feeDecision === "CHARGE" ? "charge" : "waive"}${round.feeDecidedBy ? ` (${round.feeDecidedBy})` : ""}. Nothing changed.` }
      : { ok: false, message: "No fee decision is waiting on this round." };
  }
  if (round.feeTaskId) {
    await prisma.smartTask.updateMany({ where: { id: round.feeTaskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: now } }).catch(() => {});
  }
  // No amount on the timeline: the fee lives on the round and the office card.
  await prisma.activity.create({
    data: { projectId: round.projectId, type: "SYSTEM", body: `Extra revision round (round ${round.ordinal} on this video): the office recorded ${decision === "CHARGE" ? "CHARGE" : "WAIVE"} (${by}). The hub billed nothing.`.slice(0, 500) },
  }).catch(() => {});
  if (!EXTRA_ROUND_ROUTES_IMMEDIATELY) {
    const { routePortalRequest } = await import("@/lib/clientDecisions");
    await routePortalRequest(round.decisionId).catch(() => null);
  }
  return { ok: true, message: decision === "CHARGE" ? "Recorded: charge the extra round. Nothing was billed by the hub — invoice it the usual way." : "Recorded: the extra round is waived." };
}

/** Give the client a fresh window from now (a late request, a missed email).
 *  The first deadline is kept in originalDeadlineAt. */
export async function restartReviewClock(windowId: string, by: string, now = new Date()): Promise<Ok> {
  const w = await prisma.contentReviewWindow.findUnique({ where: { id: windowId } });
  if (!w) return { ok: false, message: "That review window no longer exists." };
  if (w.state !== "OPEN") return { ok: false, message: `This version is ${w.state.toLowerCase().replace(/_/g, " ")} — there is no clock to restart.` };
  const deadlineAt = endOfBusinessDaysET(now, w.businessDays);
  const r = await prisma.contentReviewWindow.updateMany({
    where: { id: windowId, state: "OPEN", deadlineAt: w.deadlineAt },
    data: { originalDeadlineAt: w.originalDeadlineAt ?? w.deadlineAt, deadlineAt, restartedAt: now, restartedBy: by.slice(0, 120), expiryOutcome: null, expiryClaimedAt: null },
  });
  if (r.count === 0) return { ok: false, message: "Someone changed this window a moment ago — reload and try again." };
  if (w.expiryTaskId) await prisma.smartTask.updateMany({ where: { id: w.expiryTaskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: now } }).catch(() => {});
  await prisma.activity.create({ data: { projectId: w.projectId, type: "SYSTEM", body: `${by} restarted the client's review clock on version ${w.round} — new deadline ${deadlineLabel(deadlineAt)}.` } }).catch(() => {});
  return { ok: true, message: `Restarted — the client now has until ${deadlineLabel(deadlineAt)}.` };
}

/** Hold a window: it is never approved automatically while held. */
export async function holdReviewWindow(windowId: string, by: string, reason: string): Promise<Ok> {
  const why = reason.trim().slice(0, 300);
  if (!why) return { ok: false, message: "Say why it is on hold." };
  const r = await prisma.contentReviewWindow.updateMany({ where: { id: windowId, state: "OPEN" }, data: { heldAt: new Date(), heldBy: by.slice(0, 120), holdReason: why } });
  return r.count ? { ok: true, message: "On hold — it will not be approved automatically." } : { ok: false, message: "Only an open review can be held." };
}

export async function releaseReviewHold(windowId: string): Promise<Ok> {
  const r = await prisma.contentReviewWindow.updateMany({ where: { id: windowId, heldAt: { not: null } }, data: { heldAt: null, heldBy: null, holdReason: null } });
  return r.count ? { ok: true, message: "Hold released." } : { ok: false, message: "That review was not on hold." };
}

// ---- the reminder lane's inputs ---------------------------------------------------

/** Which of these cuts Kyle already sent outside the portal (Mark as sent). */
async function sentOutsidePortal(submissionIds: string[]): Promise<Set<string>> {
  if (!submissionIds.length) return new Set();
  const rows = await prisma.reviewSubmission.findMany({ where: { id: { in: submissionIds }, sentToClientAt: { not: null } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

export type ReviewLaneWindow = { openedAt: Date; deadlineAt: Date };
export type ReviewLaneFacts = { count: number; oldestOpenedAt: Date | null; deadlineAt: Date | null; tag: string | null; windows: ReviewLaneWindow[] };

/** `r<YYYYMMDD>` of a release: the ledger's review batch tag. */
export const reviewTagOf = (openedAt: Date) => `r${etDayKey(openedAt).replace(/-/g, "")}`;

/**
 * What the REVIEW reminder lane reads for a month: the OPEN windows on its
 * jobs (never LAZY — nobody told those clients about a clock; never a cut
 * Kyle already sent, which the client has), the earliest release, and the
 * earliest PERSISTED deadline. `windows` lets the cadence count reminders PER
 * WINDOW (reviewCadenceTarget) instead of per batch tag.
 */
export async function reviewLaneFacts(projectIds: string[]): Promise<ReviewLaneFacts> {
  const none: ReviewLaneFacts = { count: 0, oldestOpenedAt: null, deadlineAt: null, tag: null, windows: [] };
  if (!projectIds.length) return none;
  const open = await prisma.contentReviewWindow.findMany({ where: { projectId: { in: projectIds }, state: "OPEN", source: { not: "LAZY" } }, select: { submissionId: true, openedAt: true, deadlineAt: true } });
  const sent = await sentOutsidePortal(open.map((r) => r.submissionId));
  const rows = open.filter((r) => !sent.has(r.submissionId));
  if (!rows.length) return none;
  const oldest = rows.reduce((m, r) => (r.openedAt < m ? r.openedAt : m), rows[0].openedAt);
  const deadline = rows.reduce((m, r) => (r.deadlineAt < m ? r.deadlineAt : m), rows[0].deadlineAt);
  return { count: rows.length, oldestOpenedAt: oldest, deadlineAt: deadline, tag: reviewTagOf(oldest), windows: rows.map((r) => ({ openedAt: r.openedAt, deadlineAt: r.deadlineAt })) };
}

/**
 * WHICH WINDOW THE REVIEW CADENCE IS CHASING, and how many reminders it has
 * had. Pure. Every review reminder counts every window open when it went
 * (markReviewWindowsNotified stamps them all), so a window's attempts are the
 * lane's sends at or after its release. The cadence chases the OLDEST open
 * window that still has attempts left, or — all spent — the oldest one.
 *
 * It used to be keyed on the earliest open window's release DAY: approving
 * Monday's videos restarted the count at 1 for a Tuesday video already
 * chased twice (and escalated it again), while an undecided Monday video kept
 * a Friday batch from ever being chased at all.
 */
export function reviewCadenceTarget(windows: ReviewLaneWindow[], sends: Date[], maxAttempts: number): { window: ReviewLaneWindow; attempts: number; tag: string } | null {
  if (!windows.length) return null;
  const sorted = [...windows].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const attemptsOf = (w: ReviewLaneWindow) => sends.filter((t) => t.getTime() >= w.openedAt.getTime()).length;
  const window = sorted.find((w) => attemptsOf(w) < maxAttempts) ?? sorted[0];
  return { window, attempts: attemptsOf(window), tag: reviewTagOf(window.openedAt) };
}

/** A review reminder actually went out: the windows it was about now carry
 *  the evidence that the client was told (an auto-approval precondition). */
export async function markReviewWindowsNotified(monthId: string, at: Date): Promise<number> {
  const projects = await prisma.project.findMany({ where: { contentMonthId: monthId }, select: { id: true } });
  if (!projects.length) return 0;
  const r = await prisma.contentReviewWindow.updateMany({
    where: { projectId: { in: projects.map((p) => p.id) }, state: "OPEN", source: { not: "LAZY" }, clientNotifiedAt: null, openedAt: { lte: at } },
    data: { clientNotifiedAt: at },
  });
  return r.count;
}
