import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE PHOTO JOB STATE MACHINE (docs/photo-delivery/01 §3.3), adapted.
//
// Upload and editing are NOT driven by this table: photographers upload
// through the hub's /upload portal into the job's Dropbox folder under
// /AutoHDR, and AutoHDR's Dropbox watcher edits them (PhotoEditBatch tracks
// that). A PhotoJob starts at EDITING when the hub sees the job's raws, and
// the stages it owns begin when the finals land:
//
//   EDITING → EDITED → QC_RUNNING → QC_REVIEW ⇄ FIXING → READY → DELIVERING
//     → DELIVERED (→ REVISION_REQUESTED → FIXING …)
//   any active stage → ON_HOLD (holdResumeStage remembers where it left)
//   errors: EDIT_FAILED, DELIVERY_MISMATCH
//
// Every change goes through setStage: it checks the stage it expects (an
// optimistic compare-and-swap on stageVersion, so two cron ticks can never
// both move a job), and it writes the activity row in the same transaction.
// ---------------------------------------------------------------------------

export const JOB_STAGES = [
  "EDITING",
  "EDIT_FAILED",
  "EDITED",
  "QC_RUNNING",
  "QC_REVIEW",
  "FIXING",
  "ON_HOLD",
  "READY",
  "DELIVERING",
  "DELIVERY_MISMATCH",
  "DELIVERED",
  "REVISION_REQUESTED",
] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const STAGE_LABEL: Record<JobStage, string> = {
  EDITING: "Editing",
  EDIT_FAILED: "Edit failed",
  EDITED: "Edited",
  QC_RUNNING: "QC running",
  QC_REVIEW: "Needs decision",
  FIXING: "Fixing",
  ON_HOLD: "On hold",
  READY: "Ready",
  DELIVERING: "Delivering",
  DELIVERY_MISMATCH: "Delivery mismatch",
  DELIVERED: "Delivered",
  REVISION_REQUESTED: "Revision",
};

export type HoldReason = "CRITICAL" | "CREDITS" | "RESHOOT" | "MANUAL";

/** Append one line to the job's activity log. Never throws. */
export async function logJobEvent(jobId: string, actor: string, action: string, data?: Record<string, unknown> | null): Promise<void> {
  try {
    await prisma.photoJobEvent.create({ data: { jobId, actor: actor.slice(0, 120), action: action.slice(0, 300), dataJson: data ? JSON.stringify(data).slice(0, 8000) : null } });
  } catch (e) {
    console.warn("photo job event not logged", jobId, action, (e as Error).message);
  }
}

/**
 * Move a job from one of `from` to `to`. Returns false (and changes nothing)
 * when the job is not in an expected stage or another writer moved it first.
 */
export async function setStage(
  jobId: string,
  from: JobStage[] | "any",
  to: JobStage,
  actor: string,
  opts: { why?: string; data?: Record<string, unknown>; holdReason?: HoldReason; holdNote?: string; extra?: Record<string, unknown> } = {},
): Promise<boolean> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, stageVersion: true } });
  if (!job) return false;
  if (from !== "any" && !from.includes(job.stage as JobStage)) return false;
  if (job.stage === to && !opts.extra) return true;
  const now = new Date();
  const holding = to === "ON_HOLD";
  const data: Record<string, unknown> = {
    stage: to,
    stageVersion: { increment: 1 },
    stageChangedAt: now,
    ...(holding
      ? { holdReason: opts.holdReason ?? "MANUAL", holdResumeStage: job.stage === "ON_HOLD" ? undefined : job.stage, holdNote: opts.holdNote?.slice(0, 500) ?? null }
      : job.stage === "ON_HOLD"
        ? { holdReason: null, holdResumeStage: null, holdNote: null }
        : {}),
    ...(opts.extra ?? {}),
  };
  const res = await prisma.photoJob.updateMany({ where: { id: jobId, stageVersion: job.stageVersion }, data });
  if (res.count !== 1) return false;
  await logJobEvent(jobId, actor, `${job.stage} → ${to}${opts.why ? `: ${opts.why}` : ""}`, opts.data ?? null);
  return true;
}

/** Release a hold: back to the stage the job left (or `fallback`). */
export async function releaseHold(jobId: string, actor: string, why: string, fallback: JobStage = "QC_REVIEW"): Promise<boolean> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, holdResumeStage: true } });
  if (!job || job.stage !== "ON_HOLD") return false;
  const resume = (JOB_STAGES as readonly string[]).includes(job.holdResumeStage ?? "") ? (job.holdResumeStage as JobStage) : fallback;
  return setStage(jobId, ["ON_HOLD"], resume, actor, { why });
}

/** A short-lived processing lease on one job (compare-and-swap), so two cron
 *  ticks never work the same job at once. */
export async function claimJob(jobId: string, by: string, ms = 240_000): Promise<boolean> {
  const now = new Date();
  const res = await prisma.photoJob.updateMany({
    where: { id: jobId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseOwner: by }] },
    data: { leaseUntil: new Date(now.getTime() + ms), leaseOwner: by },
  });
  return res.count === 1;
}

export async function releaseJob(jobId: string, by: string): Promise<void> {
  await prisma.photoJob.updateMany({ where: { id: jobId, leaseOwner: by }, data: { leaseUntil: null, leaseOwner: null } }).catch(() => {});
}
