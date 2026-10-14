import "server-only";

import { prisma } from "@/lib/prisma";
import { logJobEvent, releaseHold, setStage, JOB_STAGES, type JobStage } from "./jobState";
import { photoDeliverySettings } from "./settings";
import { ruleById, SEVERITIES, type RuleOverride, type Severity } from "./registry";

// ---------------------------------------------------------------------------
// THE SIMPLE DECISION WRITES behind the Photo Delivery page (docs/photo-
// delivery/01 sections 7.5, 8.3, 9.4, 9.5). Plain server functions with no
// auth of their own: the server actions in src/app/ops/photo-delivery/
// actions.ts guard every call (requireAdmin / requireOwner) and pass `by`.
//
// Every write here:
//   · validates that the ids it was handed belong to the job (a forged POST
//     can never move another job's findings or photos),
//   · is a compare-and-swap where two people could race (updateMany with the
//     status it expects), and
//   · logs one PhotoJobEvent: plan 0.3, "every automated decision is logged
//     (who or what, when, why, inputs) in the job activity log".
//
// The stage rule (plan 3.3): a job in QC_REVIEW moves to READY the moment no
// MAJOR or CRITICAL finding at or above the display floor is left unresolved;
// reopening one sends a READY job back to QC_REVIEW. Findings below the floor
// sit in the "Low confidence" drawer and never block (plan 7.5).
// ---------------------------------------------------------------------------

export type DecisionStatus = "IGNORED" | "FALSE_POSITIVE" | "OVERRIDDEN" | "SENT_TO_EDITOR" | "RESHOOT_REQUESTED" | "OPEN";
export const DECISION_STATUSES: readonly DecisionStatus[] = ["IGNORED", "FALSE_POSITIVE", "OVERRIDDEN", "SENT_TO_EDITOR", "RESHOOT_REQUESTED", "OPEN"];

export type WriteResult = { ok: true; message: string; changed: number; stage: string | null } | { ok: false; message: string };

/** Statuses a person sets (and may change or undo). */
const HUMAN_DECIDED: readonly string[] = ["IGNORED", "FALSE_POSITIVE", "OVERRIDDEN", "SENT_TO_EDITOR", "RESHOOT_REQUESTED"];
/** Plan 8.3: ignoring (or overriding, or calling a false positive) a MAJOR or CRITICAL finding needs a reason. */
const REASON_REQUIRED: readonly string[] = ["IGNORED", "OVERRIDDEN", "FALSE_POSITIVE"];
/** Unresolved for the stage rule and the delivery gate (delivery.ts reads the same set). */
const UNRESOLVED = ["OPEN", "APPROVED_FIX", "FIXING"];
/** Marks the findings an exclusion resolved, so re-including the photo can reopen exactly those. */
export const EXCLUDED_REASON_PREFIX = "Photo excluded from delivery";

const MIN_REASON = 3;
const MAX_IDS = 500;

const VERB: Record<DecisionStatus, string> = {
  IGNORED: "ignored",
  FALSE_POSITIVE: "marked not an issue",
  OVERRIDDEN: "overridden",
  SENT_TO_EDITOR: "sent to the editor",
  RESHOOT_REQUESTED: "flagged for a reshoot (recommendation)",
  OPEN: "reopened",
};

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** MAJOR+ findings at or above the floor that are still unresolved (the gate's own test). */
async function blockingCount(jobId: string, floor: number): Promise<number> {
  return prisma.photoQcFinding.count({
    where: {
      jobId,
      status: { in: UNRESOLVED },
      confidence: { gte: floor },
      OR: [{ severity: "MAJOR" }, { severity: "CRITICAL", arbitration: { not: "OVERTURNED" } }],
    },
  });
}

/**
 * After any decision: QC_REVIEW → READY when nothing blocking is left, and
 * READY → QC_REVIEW when a blocking finding was reopened. Returns the stage
 * the job is in afterwards.
 */
async function reconcileReviewStage(jobId: string, by: string, reopenedBlocking: boolean): Promise<string | null> {
  const [job, settings] = await Promise.all([prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } }), photoDeliverySettings()]);
  if (!job) return null;
  if (job.stage === "QC_REVIEW") {
    if ((await blockingCount(jobId, settings.displayConfidenceFloor)) === 0) {
      if (await setStage(jobId, ["QC_REVIEW"], "READY", by, { why: "every major and critical issue is decided" })) return "READY";
    }
  } else if (job.stage === "READY" && reopenedBlocking) {
    if ((await blockingCount(jobId, settings.displayConfidenceFloor)) > 0) {
      if (await setStage(jobId, ["READY"], "QC_REVIEW", by, { why: "an issue was reopened" })) return "QC_REVIEW";
    }
  }
  const fresh = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  return fresh?.stage ?? job.stage;
}

const isBlocking = (f: { severity: string; confidence: number; arbitration: string }, floor: number) =>
  f.confidence >= floor && (f.severity === "MAJOR" || (f.severity === "CRITICAL" && f.arbitration !== "OVERTURNED"));

// ---- findings -------------------------------------------------------------------------------

/**
 * Decide one finding or a whole group (plan 7.5: "a group-level decision
 * applies to all its findings"). Findings already in the fix pipeline
 * (APPROVED_FIX, FIXING, FIXED) or replaced by a newer run (SUPERSEDED) are
 * left alone: a person's click never pulls a finding out of a running fix.
 */
export async function decideFindings(input: { findingIds: string[]; status: DecisionStatus; reason?: string | null; by: string; jobId?: string | null }): Promise<WriteResult> {
  const status = input.status;
  if (!DECISION_STATUSES.includes(status)) return { ok: false, message: "That decision is not one the hub knows." };
  const ids = [...new Set((Array.isArray(input.findingIds) ? input.findingIds : []).filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (!ids.length) return { ok: false, message: "Pick at least one issue." };
  if (ids.length > MAX_IDS) return { ok: false, message: `That is more than ${MAX_IDS} issues at once. Decide them in smaller groups.` };
  const by = clean(input.by, 120) || "staff";
  const reason = clean(input.reason, 500);

  const found = await prisma.photoQcFinding.findMany({
    where: { id: { in: ids } },
    select: { id: true, jobId: true, severity: true, status: true, confidence: true, arbitration: true },
  });
  if (found.length !== ids.length) return { ok: false, message: "Some of those issues no longer exist. Reload the page." };
  const jobIds = new Set(found.map((f) => f.jobId));
  if (jobIds.size !== 1) return { ok: false, message: "Those issues belong to different jobs. Decide one job at a time." };
  const jobId = found[0].jobId;
  if (input.jobId && input.jobId !== jobId) return { ok: false, message: "Those issues belong to a different job." };

  const from: string[] = status === "OPEN" ? [...HUMAN_DECIDED] : ["OPEN", ...HUMAN_DECIDED];
  const decidable = found.filter((f) => from.includes(f.status));
  if (!decidable.length) {
    return {
      ok: false,
      message: status === "OPEN" ? "Nothing to reopen: those issues are open, being fixed, or fixed." : "Nothing to change: those issues are already being fixed, fixed, or replaced by a newer QC run.",
    };
  }
  if (REASON_REQUIRED.includes(status) && decidable.some((f) => f.severity !== "MINOR") && reason.length < MIN_REASON) {
    return { ok: false, message: "Write a reason: a major or critical issue can't be set aside without one." };
  }

  const now = new Date();
  const res = await prisma.photoQcFinding.updateMany({
    where: { id: { in: decidable.map((f) => f.id) }, jobId, status: { in: from } },
    data:
      status === "OPEN"
        ? { status: "OPEN", statusReason: null, decidedBy: null, decidedAt: null }
        : { status, statusReason: reason || null, decidedBy: by, decidedAt: now },
  });
  if (res.count === 0) return { ok: false, message: "Someone else decided these a moment ago. Reload the page." };

  const settings = await photoDeliverySettings();
  await logJobEvent(jobId, by, `${plural(res.count, "issue")} ${VERB[status]}${reason ? `: ${reason}` : ""}`, {
    findingIds: decidable.map((f) => f.id),
    status,
    reason: reason || null,
  });
  const reopenedBlocking = status === "OPEN" && decidable.some((f) => isBlocking(f, settings.displayConfidenceFloor));
  const stage = await reconcileReviewStage(jobId, by, reopenedBlocking);
  const skipped = ids.length - res.count;
  return {
    ok: true,
    changed: res.count,
    stage,
    message: `${plural(res.count, "issue")} ${VERB[status]}.${skipped > 0 ? ` ${plural(skipped, "other")} left as ${skipped === 1 ? "it was" : "they were"} (already in a fix or decided).` : ""}${stage === "READY" ? " Nothing major is left: the job is Ready." : ""}`,
  };
}

// ---- photos ---------------------------------------------------------------------------------

/**
 * Leave a photo out of the delivery (or put it back). A person's exclusion is
 * also the decision on that photo's own open findings (plan 7.5: privacy is
 * resolved by blur, removal or EXCLUSION), so they are set aside with the
 * exclusion as the reason, and reopened if the photo comes back.
 */
export async function setPhotoExcluded(photoId: string, excluded: boolean, reason: string | null, by: string, expectJobId?: string | null): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const why = clean(reason, 300);
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { id: true, jobId: true, name: true, status: true } });
  if (!photo) return { ok: false, message: "That photo no longer exists. Reload the page." };
  if (expectJobId && photo.jobId !== expectJobId) return { ok: false, message: "That photo belongs to a different job." };
  if (photo.status === "GONE") return { ok: false, message: "That photo is no longer in the gallery." };
  const settings = await photoDeliverySettings();
  const now = new Date();

  if (excluded) {
    if (why.length < MIN_REASON) return { ok: false, message: "Say why this photo is left out (for example: duplicate, out of focus, privacy)." };
    const res = await prisma.photoAsset.updateMany({ where: { id: photo.id, status: { in: ["ACTIVE", "EXCLUDED"] } }, data: { status: "EXCLUDED", excludeReason: why } });
    if (res.count !== 1) return { ok: false, message: "That photo changed in the meantime. Reload the page." };
    const resolved = await prisma.photoQcFinding.updateMany({
      where: { jobId: photo.jobId, photoId: photo.id, status: "OPEN" },
      data: { status: "OVERRIDDEN", statusReason: `${EXCLUDED_REASON_PREFIX}: ${why}`.slice(0, 500), decidedBy: who, decidedAt: now },
    });
    // An excluded photo cannot lead the gallery.
    const unhero = await prisma.photoJob.updateMany({ where: { id: photo.jobId, heroPhotoId: photo.id }, data: { heroPhotoId: null } });
    await logJobEvent(photo.jobId, who, `photo excluded: ${photo.name}: ${why}`, { photoId: photo.id, resolvedFindings: resolved.count, heroCleared: unhero.count > 0 });
    const stage = await reconcileReviewStage(photo.jobId, who, false);
    return {
      ok: true,
      changed: 1,
      stage,
      message: `Left out of the delivery.${resolved.count ? ` ${plural(resolved.count, "open issue")} on it set aside.` : ""}${unhero.count ? " It was the hero, so pick a new one." : ""}`,
    };
  }

  if (photo.status === "ACTIVE") return { ok: true, changed: 0, stage: null, message: "That photo is already in the delivery." };
  const res = await prisma.photoAsset.updateMany({ where: { id: photo.id, status: "EXCLUDED" }, data: { status: "ACTIVE", excludeReason: null } });
  if (res.count !== 1) return { ok: false, message: "That photo changed in the meantime. Reload the page." };
  const toReopen = await prisma.photoQcFinding.findMany({
    where: { jobId: photo.jobId, photoId: photo.id, status: "OVERRIDDEN", statusReason: { startsWith: EXCLUDED_REASON_PREFIX } },
    select: { id: true, severity: true, confidence: true, arbitration: true },
  });
  if (toReopen.length) {
    await prisma.photoQcFinding.updateMany({ where: { id: { in: toReopen.map((f) => f.id) }, status: "OVERRIDDEN" }, data: { status: "OPEN", statusReason: null, decidedBy: null, decidedAt: null } });
  }
  await logJobEvent(photo.jobId, who, `photo included again: ${photo.name}`, { photoId: photo.id, reopenedFindings: toReopen.length });
  const stage = await reconcileReviewStage(photo.jobId, who, toReopen.some((f) => isBlocking(f, settings.displayConfidenceFloor)));
  return { ok: true, changed: 1, stage, message: `Back in the delivery.${toReopen.length ? ` ${plural(toReopen.length, "issue")} on it reopened.` : ""}` };
}

/** The hero leads the gallery (plan 7.6); only an included photo of this job can be it. */
export async function setHero(jobId: string, photoId: string, by: string): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { id: true, jobId: true, name: true, status: true } });
  if (!photo || photo.jobId !== jobId) return { ok: false, message: "That photo is not part of this job." };
  if (photo.status !== "ACTIVE") return { ok: false, message: "Include the photo in the delivery before making it the hero." };
  const res = await prisma.photoJob.updateMany({ where: { id: jobId }, data: { heroPhotoId: photo.id } });
  if (res.count !== 1) return { ok: false, message: "Photo job not found." };
  await logJobEvent(jobId, who, `hero set: ${photo.name}`, { photoId: photo.id });
  return { ok: true, changed: 1, stage: null, message: "Hero set. It leads the delivery." };
}

/**
 * A person's delivery order (plan 9.4: drag to reorder). Stored as the photo
 * ids in order on PhotoJob.orderJson; null there means "the QC suggestion".
 */
export async function setDeliveryOrder(jobId: string, photoIds: string[], by: string): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const list = (Array.isArray(photoIds) ? photoIds : []).filter((x): x is string => typeof x === "string" && x.length > 0);
  if (!list.length) return { ok: false, message: "There is no order to save." };
  if (list.length > MAX_IDS) return { ok: false, message: "That order is longer than any gallery." };
  if (new Set(list).size !== list.length) return { ok: false, message: "A photo appears twice in that order." };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) return { ok: false, message: "Photo job not found." };
  const photos = await prisma.photoAsset.findMany({ where: { id: { in: list } }, select: { id: true, jobId: true } });
  if (photos.length !== list.length || photos.some((p) => p.jobId !== jobId)) return { ok: false, message: "That order names a photo that is not part of this job." };
  await prisma.photoJob.update({ where: { id: jobId }, data: { orderJson: JSON.stringify(list) } });
  await logJobEvent(jobId, who, `delivery order saved (${plural(list.length, "photo")})`, { first: list.slice(0, 5) });
  return { ok: true, changed: list.length, stage: null, message: "Order saved." };
}

// ---- holds ----------------------------------------------------------------------------------

const HOLDABLE: JobStage[] = JOB_STAGES.filter((s) => s !== "ON_HOLD" && s !== "DELIVERED");

export async function holdJob(jobId: string, reason: string, by: string): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const why = clean(reason, 500);
  if (why.length < MIN_REASON) return { ok: false, message: "Say why the job is on hold." };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  if (!job) return { ok: false, message: "Photo job not found." };
  if (job.stage === "ON_HOLD") return { ok: false, message: "This job is already on hold." };
  if (job.stage === "DELIVERED") return { ok: false, message: "A delivered job can't be put on hold." };
  const moved = await setStage(jobId, HOLDABLE, "ON_HOLD", who, { why: `held: ${why}`, holdReason: "MANUAL", holdNote: why });
  if (!moved) return { ok: false, message: "This job moved on in the meantime. Reload the page." };
  return { ok: true, changed: 1, stage: "ON_HOLD", message: "On hold. Delivery is blocked until the hold is released." };
}

export async function releaseJobHold(jobId: string, by: string): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  if (!job) return { ok: false, message: "Photo job not found." };
  if (job.stage !== "ON_HOLD") return { ok: false, message: "This job is not on hold." };
  const ok = await releaseHold(jobId, who, "hold released by hand");
  if (!ok) return { ok: false, message: "This job moved on in the meantime. Reload the page." };
  const fresh = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  return { ok: true, changed: 1, stage: fresh?.stage ?? null, message: "Hold released. The job is back where it left off." };
}

// ---- QC re-run ----------------------------------------------------------------------------------

/**
 * Ask for a fresh QC run. The QC engine owns the run itself (it is long and
 * runs from the cron); this only raises the same flag the gallery sync raises
 * when a photo is replaced (PhotoJob.qcRequestedAt).
 */
export async function requestQcRerun(jobId: string, by: string): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, qcRequestedAt: true } });
  if (!job) return { ok: false, message: "Photo job not found." };
  if (job.stage === "EDITING" || job.stage === "EDIT_FAILED") return { ok: false, message: "The edited gallery has not landed yet, so there is nothing to check." };
  if (job.stage === "QC_RUNNING") return { ok: false, message: "QC is already running on this job." };
  if (job.stage === "DELIVERED") return { ok: false, message: "This job is delivered. Open a revision to check it again." };
  await prisma.photoJob.update({ where: { id: jobId }, data: { qcRequestedAt: new Date() } });
  await logJobEvent(jobId, who, "QC re-run requested");
  return { ok: true, changed: 1, stage: job.stage, message: "QC re-run requested. It starts on the next pass (within about 5 minutes)." };
}

// ---- client QC profiles ---------------------------------------------------------------------------

export type ClientQcProfileFields = {
  slaHours?: number | null;
  notes?: string | null;
  deliveryMessage?: string | null;
  ruleOverrides?: RuleOverride[] | null;
};

/**
 * Save a client's QC profile (plan 4 ClientQcProfile): SLA hours, notes fed to
 * the QC prompt, the client-facing delivery message (Realtour Pilot Team
 * voice, never a long dash) and rule overrides (disable or re-grade, always
 * with a reason). The change is logged on each of the client's open jobs,
 * because those are the jobs whose QC it changes.
 */
export async function saveClientQcProfile(clientId: string, fields: ClientQcProfileFields, by: string): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!client) return { ok: false, message: "That client no longer exists." };

  const data: { slaHours?: number | null; notes?: string | null; deliveryMessage?: string | null; ruleOverridesJson?: string | null; updatedBy: string } = { updatedBy: who };
  if (fields.slaHours !== undefined) {
    if (fields.slaHours === null) data.slaHours = null;
    else if (typeof fields.slaHours !== "number" || !Number.isInteger(fields.slaHours) || fields.slaHours < 1 || fields.slaHours > 336) {
      return { ok: false, message: "SLA hours must be a whole number from 1 to 336 (two weeks), or blank for the default." };
    } else data.slaHours = fields.slaHours;
  }
  if (fields.notes !== undefined) {
    const notes = typeof fields.notes === "string" ? fields.notes.trim() : "";
    if (notes.length > 4000) return { ok: false, message: "Notes are limited to 4,000 characters." };
    data.notes = notes || null;
  }
  if (fields.deliveryMessage !== undefined) {
    // Client-facing: no long dashes, ever (plan 0.3).
    const msg = (typeof fields.deliveryMessage === "string" ? fields.deliveryMessage : "").replace(/\s*[\u2013\u2014]\s*/g, ", ").trim();
    if (msg.length > 2000) return { ok: false, message: "The delivery message is limited to 2,000 characters." };
    data.deliveryMessage = msg || null;
  }
  if (fields.ruleOverrides !== undefined) {
    const list = Array.isArray(fields.ruleOverrides) ? fields.ruleOverrides : [];
    if (list.length > 200) return { ok: false, message: "That is more than 200 rule overrides." };
    const byRule = new Map<string, RuleOverride>();
    for (const o of list) {
      const ruleId = clean(o?.ruleId, 80);
      const rule = ruleById(ruleId);
      if (!rule) return { ok: false, message: `There is no QC rule called ${ruleId || "(blank)"}.` };
      const reason = clean(o?.reason, 300);
      if (reason.length < MIN_REASON) return { ok: false, message: `Write the reason for the ${rule.shortLabel} override.` };
      const disabled = o?.disabled === true;
      const severity = typeof o?.severity === "string" && (SEVERITIES as readonly string[]).includes(o.severity) ? (o.severity as Severity) : undefined;
      if (!disabled && !severity) return { ok: false, message: `${rule.shortLabel}: either turn the rule off or pick a severity.` };
      byRule.set(ruleId, disabled ? { ruleId, disabled: true, reason } : { ruleId, severity, reason });
    }
    data.ruleOverridesJson = byRule.size ? JSON.stringify([...byRule.values()]) : null;
  }

  await prisma.clientQcProfile.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });

  // Log on the client's open photo jobs (bounded): their QC is what changed.
  const projects = await prisma.project.findMany({ where: { clientId }, select: { id: true }, take: 2000 });
  const jobs = projects.length
    ? await prisma.photoJob.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, stage: { not: "DELIVERED" } }, select: { id: true }, take: 50 })
    : [];
  const changed = Object.keys(data).filter((k) => k !== "updatedBy");
  for (const j of jobs) await logJobEvent(j.id, who, `client QC profile updated (${changed.join(", ") || "no fields"})`, { clientId });
  return { ok: true, changed: 1, stage: null, message: `Saved the QC profile for ${client.name}.` };
}
