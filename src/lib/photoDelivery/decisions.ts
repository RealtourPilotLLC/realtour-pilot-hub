import "server-only";

import { prisma } from "@/lib/prisma";
import { logJobEvent, releaseHold, setStage, JOB_STAGES, type JobStage } from "./jobState";
import { PAID_QC_OFF, PAID_QC_OFF_MESSAGE, photoDeliverySettings } from "./settings";
import { isExteriorFinding, ruleById, SEVERITIES, type RuleOverride, type Severity } from "./registry";
import { MIN_OWN_WORDS, needsOwnWords, ownWordsOk } from "./careRules";
import { houseOverrides, mergeOverrides } from "./houseRules";
import { jobVerdict, type JobVerdict } from "./qc/verdict";

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
// The stage rule (plan 3.3, reviewStage below): a job in QC_REVIEW moves to
// READY the moment no open MAJOR or CRITICAL finding at or above the display
// floor is left; reopening one sends a READY job back to QC_REVIEW. Findings
// below the floor sit in the "Low confidence" drawer and never block (plan 7.5).
// ---------------------------------------------------------------------------

export type DecisionStatus = "IGNORED" | "FALSE_POSITIVE" | "OVERRIDDEN" | "SENT_TO_EDITOR" | "RESHOOT_REQUESTED" | "OPEN";
export const DECISION_STATUSES: readonly DecisionStatus[] = ["IGNORED", "FALSE_POSITIVE", "OVERRIDDEN", "SENT_TO_EDITOR", "RESHOOT_REQUESTED", "OPEN"];

export type WriteResult = { ok: true; message: string; changed: number; stage: string | null } | { ok: false; message: string };

/** Statuses a person sets (and may change or undo). */
const HUMAN_DECIDED: readonly string[] = ["IGNORED", "FALSE_POSITIVE", "OVERRIDDEN", "SENT_TO_EDITOR", "RESHOOT_REQUESTED"];
/** Plan 8.3: ignoring (or overriding, or calling a false positive) a MAJOR or CRITICAL finding needs a reason. */
const REASON_REQUIRED: readonly string[] = ["IGNORED", "OVERRIDDEN", "FALSE_POSITIVE"];
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

/** The findings among these that need a person's own words to be set aside (careRules.needsOwnWords): major outside ones, and anything always fixed. */
export async function needingOwnWords<T extends { severity: string; ruleId: string; photoId: string | null }>(list: T[]): Promise<T[]> {
  if (!list.length) return [];
  const { ALWAYS_FIX } = await import("./fixPolicy");
  const photoIds = [...new Set(list.map((f) => f.photoId).filter((x): x is string => !!x))];
  const rooms = photoIds.length ? await prisma.photoAsset.findMany({ where: { id: { in: photoIds } }, select: { id: true, roomType: true } }) : [];
  const roomOf = new Map(rooms.map((p) => [p.id, p.roomType]));
  return list.filter((f) => needsOwnWords({ severity: f.severity, alwaysFixed: ALWAYS_FIX.has(f.ruleId), exterior: isExteriorFinding(f.ruleId, f.photoId ? roomOf.get(f.photoId) : null) }));
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The house's switched-off checks, then the client's own overrides: what the job page and the paid QC group findings by. */
export async function overridesFor(jobId: string): Promise<RuleOverride[]> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  const project = job ? await prisma.project.findUnique({ where: { id: job.projectId }, select: { clientId: true } }) : null;
  const [house, profile] = await Promise.all([
    houseOverrides(),
    project?.clientId ? prisma.clientQcProfile.findUnique({ where: { clientId: project.clientId }, select: { ruleOverridesJson: true } }) : null,
  ]);
  let own: RuleOverride[] = [];
  try {
    own = JSON.parse(profile?.ruleOverridesJson ?? "[]") as RuleOverride[];
  } catch {
    own = [];
  }
  return mergeOverrides(house, Array.isArray(own) ? own.filter((o) => o && typeof o.ruleId === "string") : []);
}

export type ReviewStage = { stage: "QC_REVIEW" | "READY" | "stay"; verdict: JobVerdict; open: number };

/**
 * THE rule for QC_REVIEW versus READY (backend audit #15: there were three).
 * Used after every decision, when a fix batch finishes, and whenever a
 * verdict is refreshed. "stay" while a fix on the job is still waiting or
 * running; otherwise QC_REVIEW while an OPEN major or critical issue at or
 * above the display floor is left (grouped the way the job page groups them,
 * house and client overrides applied), else READY.
 */
export async function reviewStage(jobId: string): Promise<ReviewStage> {
  const [running, settings, overrides, open] = await Promise.all([
    prisma.photoFixOperation.count({ where: { jobId, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } }),
    photoDeliverySettings(),
    overridesFor(jobId),
    prisma.photoQcFinding.findMany({
      where: { jobId, status: "OPEN" },
      select: { id: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true, specificIssue: true, source: true },
    }),
  ]);
  const v = jobVerdict(open, { floor: settings.displayConfidenceFloor, overrides });
  const n = v.counts.critical + v.counts.major;
  return { stage: running ? "stay" : n ? "QC_REVIEW" : "READY", verdict: v.verdict, open: n };
}

/**
 * After any decision the job follows the review rule: QC_REVIEW ⇄ READY, and
 * out of FIXING once no fix is left to run. Returns the stage it is in after.
 */
async function reconcileReviewStage(jobId: string, by: string): Promise<string | null> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, holdReason: true } });
  if (!job) return null;
  // Oct 22 2026 (photo audit H4): deciding the last critical issue on a job
  // the check held lifts that hold (fixPolicy.refreshVerdict), into QC review.
  if (job.stage === "ON_HOLD" && job.holdReason === "CRITICAL") {
    const { refreshVerdict } = await import("./fixPolicy");
    await refreshVerdict(jobId, by).catch(() => {});
    return (await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } }))?.stage ?? job.stage;
  }
  if (!["QC_REVIEW", "READY", "FIXING"].includes(job.stage)) return job.stage;
  const r = await reviewStage(jobId);
  if (r.stage === "stay" || r.stage === job.stage) return job.stage;
  const why = r.stage === "READY" ? "every major and critical issue is decided" : job.stage === "FIXING" ? "no fixes left to run" : "a major issue is open again";
  if (await setStage(jobId, [job.stage as JobStage], r.stage, by, { why, extra: { qcVerdict: r.verdict } })) return r.stage;
  const fresh = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  return fresh?.stage ?? job.stage;
}

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
    select: { id: true, jobId: true, severity: true, status: true, ruleId: true, photoId: true, specificIssue: true, locationText: true },
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
  // IGNORING WITH CARE (Oct 21 2026, 859 N Lawrence St; careRules.ts): a major
  // issue outside the house, or one the hub always fixes, is set aside (or
  // overridden) only with the person's own words, never a stock reason alone.
  // A listing-specific ignore is still allowed and is never a rule rejection.
  if ((status === "IGNORED" || status === "OVERRIDDEN") && !ownWordsOk(reason) && (await needingOwnWords(decidable)).length) {
    return { ok: false, message: `Write why in your own words (at least ${MIN_OWN_WORDS} characters, not a stock reason): this is a major issue outside the house, or one the hub always fixes (trash cans, cars, camera mistakes). Say what the client was told, or why it can stay.` };
  }
  // WHAT THE CLIENT ASKED COMES FIRST (Oct 21 2026, clientAsked.findingAskLinks):
  // a finding the client asked to have removed is set aside only once that
  // request is answered (Done, or answered with a note, on the Deliver panel).
  if (status === "IGNORED" || status === "OVERRIDDEN") {
    const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
    const { findingAskLinks } = await import("./clientAsked");
    const links = job ? await findingAskLinks(job.projectId, decidable) : new Map();
    const first = decidable.map((f) => links.get(f.id)).find(Boolean);
    if (first) return { ok: false, message: `${first.label}: "${first.what}". Answer that request first (the Deliver panel, Before the photos go out: Done, or Answer with a note), then decide this.` };
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

  await logJobEvent(jobId, by, `${plural(res.count, "issue")} ${VERB[status]}${reason ? `: ${reason}` : ""}`, {
    findingIds: decidable.map((f) => f.id),
    status,
    reason: reason || null,
  });
  // Oct 23 2026 (huddle item 5): a reason given (or a call undone) may teach
  // the check a house lesson, or stop teaching one (houseRules.refreshLessons).
  if ((status === "IGNORED" || status === "FALSE_POSITIVE" || status === "OPEN") && (reason || status === "OPEN")) {
    await import("./houseRules").then((m) => m.refreshLessons(new Date(), by)).catch((e) => console.warn("photo delivery: lessons not refreshed", (e as Error).message));
  }
  const stage = await reconcileReviewStage(jobId, by);
  const skipped = ids.length - res.count;
  return {
    ok: true,
    changed: res.count,
    stage,
    message: `${plural(res.count, "issue")} ${VERB[status]}.${skipped > 0 ? ` ${plural(skipped, "other")} left as ${skipped === 1 ? "it was" : "they were"} (already in a fix or decided).` : ""}${stage === "READY" ? " Nothing major is left: the job is Ready." : ""}`,
  };
}

/**
 * SKIP EVERY FINDING ON A SHOOT (Oct 14 2026, Jordan: "I want a button that
 * can skip all QC findings for a shoot"). One press:
 *   · fixes approved but not yet sent to AutoHDR are called off (CANCELLED,
 *     nothing was charged); one already at AutoHDR finishes, it is paid for;
 *   · every open finding (and every finding of a called-off fix) is set aside
 *     as IGNORED with the reason "Skipped all findings on this shoot", undoable
 *     one by one like any decision;
 *   · ordered add-ons (virtual twilight, staging, declutter) are not QC
 *     findings and stay where they are, and so does a twilight look already
 *     queued for a real twilight.
 */
const fixes = (n: number) => `${n} fix${n === 1 ? "" : "es"}`;
export async function skipAllFindings(jobId: string, by: string): Promise<WriteResult & { cancelled?: number }> {
  const who = clean(by, 120) || "staff";
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) return { ok: false, message: "That job no longer exists. Reload the page." };
  const now = new Date();
  // 1. Fixes still waiting their turn: called off, their findings back in hand.
  const queued = await prisma.photoFixOperation.findMany({ where: { jobId, status: "QUEUED", batch: { approvedBy: { not: "auto-twilight" } } }, select: { id: true, batchId: true, findingIdsJson: true } });
  const addOnIds = new Set((await prisma.photoQcFinding.findMany({ where: { jobId, source: "ADDON" }, select: { id: true } })).map((f) => f.id));
  const callOff = queued.filter((o) => {
    let ids: string[] = [];
    try { ids = JSON.parse(o.findingIdsJson) as string[]; } catch { ids = []; }
    return !ids.some((id) => addOnIds.has(id));
  });
  let cancelled = 0;
  const freed: string[] = [];
  if (callOff.length) {
    const r = await prisma.photoFixOperation.updateMany({ where: { id: { in: callOff.map((o) => o.id) }, status: "QUEUED" }, data: { status: "CANCELLED", error: `Called off: ${who} skipped all findings on this shoot` } });
    cancelled = r.count;
    for (const o of callOff) { try { freed.push(...(JSON.parse(o.findingIdsJson) as string[])); } catch { /* none */ } }
    // A batch with nothing left to run is closed quietly (no "fixes done" alert).
    for (const batchId of new Set(callOff.map((o) => o.batchId))) {
      const left = await prisma.photoFixOperation.count({ where: { batchId, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
      if (left) continue;
      const okOps = await prisma.photoFixOperation.count({ where: { batchId, status: { in: ["SUCCEEDED", "VERIFIED"] } } });
      await prisma.photoFixBatch.updateMany({ where: { id: batchId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: okOps ? "PARTIAL" : "FAILED" } });
    }
  }
  // 2. Every open finding (and the called-off ones) set aside. Never one
  // saying an earlier AI fix changed the house (huddle finding 8: "skipping
  // findings must not approve damage from earlier edits"): that stays open
  // until a person restores the photo.
  const reason = "Skipped all findings on this shoot";
  // Oct 21 2026: nor one the client asked to have removed (clientAsked.findingAskLinks):
  // that waits for the request to be answered.
  const jobRow = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  const candidates = await prisma.photoQcFinding.findMany({
    where: { jobId, source: { not: "ADDON" }, ruleId: { not: "FIX_DAMAGE_AI_EDIT" }, OR: [{ status: "OPEN" }, { id: { in: freed }, status: { in: ["APPROVED_FIX", "FIXING"] } }] },
    select: { id: true, ruleId: true, specificIssue: true, locationText: true },
  });
  const asked = jobRow ? await import("./clientAsked").then((m) => m.findingAskLinks(jobRow.projectId, candidates)) : new Map<string, unknown>();
  // One of those whose fix was just called off goes back to open, not into limbo.
  if (asked.size) await prisma.photoQcFinding.updateMany({ where: { id: { in: [...asked.keys()] }, status: { in: ["APPROVED_FIX", "FIXING"] } }, data: { status: "OPEN", decidedBy: null, decidedAt: null } });
  const res = await prisma.photoQcFinding.updateMany({
    where: { id: { in: candidates.filter((f) => !asked.has(f.id)).map((f) => f.id) }, OR: [{ status: "OPEN" }, { status: { in: ["APPROVED_FIX", "FIXING"] } }] },
    data: { status: "IGNORED", statusReason: reason, decidedBy: who, decidedAt: now },
  });
  const damage = await prisma.photoQcFinding.count({ where: { jobId, ruleId: "FIX_DAMAGE_AI_EDIT", status: "OPEN" } });
  if (!res.count && !cancelled) return { ok: false, message: asked.size ? "Nothing skipped: the open findings are what the client asked to have removed. Answer the request first." : "Nothing to skip: there are no open findings on this shoot." };
  await logJobEvent(jobId, who, `Skipped all findings: ${plural(res.count, "issue")} set aside${cancelled ? `, ${fixes(cancelled)} not yet sent to AutoHDR called off (nothing charged)` : ""}`, { skippedAll: true, findings: res.count, cancelled });
  // 3. The stage follows: out of FIXING when nothing is running, then Ready.
  const running = await prisma.photoFixOperation.count({ where: { jobId, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  const stage = await reconcileReviewStage(jobId, who);
  return {
    ok: true,
    changed: res.count,
    cancelled,
    stage,
    message: `${plural(res.count, "finding")} skipped${cancelled ? ` and ${fixes(cancelled)} that had not started called off (nothing charged)` : ""}.${running ? ` ${fixes(running)} already at AutoHDR will finish.` : ""}${damage ? ` ${damage === 1 ? "One photo an AI fix changed stays" : `${damage} photos AI fixes changed stay`} open: restore ${damage === 1 ? "it" : "them"} in the lightbox.` : ""}${asked.size ? ` ${plural(asked.size, "finding")} the client asked to have removed stay${asked.size === 1 ? "s" : ""} open: answer the request first.` : ""}${stage === "READY" ? " The job is Ready." : ""}`,
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
  // Oct 22 2026: a photo already delivered on the listing (a split job) is not part of this delivery to leave out or put back.
  if (photo.status === "ON_LISTING") return { ok: false, message: "That photo is already delivered on the Aryeo listing." };
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
    const stage = await reconcileReviewStage(photo.jobId, who);
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
    select: { id: true },
  });
  if (toReopen.length) {
    await prisma.photoQcFinding.updateMany({ where: { id: { in: toReopen.map((f) => f.id) }, status: "OVERRIDDEN" }, data: { status: "OPEN", statusReason: null, decidedBy: null, decidedAt: null } });
  }
  await logJobEvent(photo.jobId, who, `photo included again: ${photo.name}`, { photoId: photo.id, reopenedFindings: toReopen.length });
  const stage = await reconcileReviewStage(photo.jobId, who);
  return { ok: true, changed: 1, stage, message: `Back in the delivery.${toReopen.length ? ` ${plural(toReopen.length, "issue")} on it reopened.` : ""}` };
}

/** The hero leads the gallery (plan 7.6); only an included photo of this job can be it. */
export async function setHero(jobId: string, photoId: string, by: string): Promise<WriteResult> {
  const who = clean(by, 120) || "staff";
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { id: true, jobId: true, name: true, status: true } });
  if (!photo || photo.jobId !== jobId) return { ok: false, message: "That photo is not part of this job." };
  if (photo.status === "ON_LISTING") return { ok: false, message: "That photo is already delivered on the Aryeo listing: the listing's own cover stays first." };
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
  // Oct 22 2026 (photo audit H4): a job back in QC review is placed by the one review rule (READY when nothing is left to decide).
  await reconcileReviewStage(jobId, who).catch(() => null);
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
  // Oct 23 2026 (Jordan): the paid QC is off; "Check again" is the free check (autohdrCheck.requestFreeRecheck).
  if (PAID_QC_OFF) return { ok: false, message: PAID_QC_OFF_MESSAGE };
  const who = clean(by, 120) || "staff";
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, qcRequestedAt: true } });
  if (!job) return { ok: false, message: "Photo job not found." };
  if (job.stage === "EDITING" || job.stage === "EDIT_FAILED") return { ok: false, message: "The edited gallery has not landed yet, so there is nothing to check." };
  if (job.stage === "QC_RUNNING") return { ok: false, message: "QC is already running on this job." };
  if (job.stage === "DELIVERED") return { ok: false, message: "This job is delivered. Open a revision to check it again." };
  // The free check marks the photos it looked at as inspected (the delivery
  // checklist needs it); the paid QC still looks at every photo it has not
  // inspected itself (its own inspections also carry classifiedHash).
  const freeOnly = (await prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE", inspectedHash: { not: null } }, select: { id: true, inspectedHash: true, classifiedHash: true } })).filter((p) => p.classifiedHash !== p.inspectedHash);
  if (freeOnly.length) await prisma.photoAsset.updateMany({ where: { id: { in: freeOnly.map((p) => p.id) } }, data: { inspectedHash: null } });
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
