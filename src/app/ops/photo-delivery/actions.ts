"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import {
  decideFindings, holdJob, releaseJobHold, requestQcRerun, saveClientQcProfile, setDeliveryOrder, setHero, setPhotoExcluded,
  DECISION_STATUSES, type DecisionStatus,
} from "@/lib/photoDelivery/decisions";
import { approveFixBatch } from "@/lib/photoDelivery/fixes";
import { startDelivery, verifyDelivery } from "@/lib/photoDelivery/delivery";
import { recordCreditSnapshot, saveCreditThresholds, creditThresholds } from "@/lib/photoDelivery/credits";
import { photoDeliverySettings, savePhotoDeliverySettings, type PhotoDeliverySettings } from "@/lib/photoDelivery/settings";
import { etAt } from "@/lib/datetime";
import type { RuleOverride } from "@/lib/photoDelivery/registry";

// ---------------------------------------------------------------------------
// PHOTO DELIVERY SERVER ACTIONS (docs/photo-delivery/01 sections 8.3, 9).
//
// A server action is a public POST: middleware gates page navigation, not
// this. So EVERY export below calls its guard first (the drill checks it):
//   · requireAdmin  (owner or Kyle): decisions, fixes, delivery, holds, QC;
//   · requireOwner  (Jordan): settings, client QC profiles, credit thresholds,
//     and "Override and deliver" (plan 9.6: the owner may override the gate,
//     with a typed reason).
// The guards read the REAL role and refuse "view as" previews. The fix
// approval passes that real role on, so Kyle's credit cap applies (plan 8.3).
// Every answer is { ok, message } in plain words; nothing throws to the page.
// ---------------------------------------------------------------------------

export type ActionResult = { ok: boolean; message: string };

const BASE = "/ops/photo-delivery";
const ID = /^[A-Za-z0-9_-]{6,64}$/;

function denied(e: unknown): ActionResult {
  return { ok: false, message: (e as Error)?.message || "You don't have access to do that." };
}

/** Who is acting, for the activity log, plus the real role for approval caps. */
async function actor(): Promise<{ by: string; role: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { by: "staff", role: authEnforced() ? "NONE" : "OWNER" };
  return { by: (me.realName || me.name || me.email || "staff").slice(0, 120), role: me.realRole };
}

function refresh(jobId?: string) {
  revalidatePath(BASE);
  if (jobId) {
    revalidatePath(`${BASE}/${jobId}`);
    revalidatePath(`${BASE}/${jobId}/review`);
  }
}

const failed = (what: string, e: unknown): ActionResult => {
  console.error(`[photo-delivery] ${what} failed`, e);
  return { ok: false, message: `That didn't go through (${what}). Reload the page to see what is saved, then try again.` };
};

// ---- findings ---------------------------------------------------------------------------------

export async function decideFindingsAction(input: { jobId: string; findingIds: string[]; status: DecisionStatus; reason?: string | null }): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || typeof input.jobId !== "string" || !ID.test(input.jobId)) return { ok: false, message: "That job id is not valid." };
  if (!DECISION_STATUSES.includes(input.status)) return { ok: false, message: "That decision is not one the hub knows." };
  try {
    const { by } = await actor();
    const r = await decideFindings({ jobId: input.jobId, findingIds: Array.isArray(input.findingIds) ? input.findingIds : [], status: input.status, reason: typeof input.reason === "string" ? input.reason : null, by });
    if (r.ok) refresh(input.jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("decision", e);
  }
}

/** Oct 14 2026 (owner): stop flagging a check on every shoot; its open findings are set aside. */
export async function stopFlaggingAction(input: { jobId?: string | null; ruleId: string; reason: string }): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (!input || typeof input.ruleId !== "string" || !/^[A-Z0-9_]{3,80}$/.test(input.ruleId)) return { ok: false, message: "That check is not valid." };
  try {
    const { by } = await actor();
    const { stopRule } = await import("@/lib/photoDelivery/houseRules");
    const r = await stopRule(input.ruleId, typeof input.reason === "string" ? input.reason : "", by);
    if (r.ok) {
      refresh(typeof input.jobId === "string" && ID.test(input.jobId) ? input.jobId : undefined);
      revalidatePath(`${BASE}/settings`);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("stop flagging", e);
  }
}

/** Owner: check a switched-off rule again from the next QC on. */
export async function resumeCheckAction(ruleId: string): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (typeof ruleId !== "string" || !/^[A-Z0-9_]{3,80}$/.test(ruleId)) return { ok: false, message: "That check is not valid." };
  try {
    const { by } = await actor();
    const { resumeRule } = await import("@/lib/photoDelivery/houseRules");
    const r = await resumeRule(ruleId, by);
    if (r.ok) revalidatePath(`${BASE}/settings`);
    return r;
  } catch (e) {
    return failed("turn the check back on", e);
  }
}

// ---- photos ----------------------------------------------------------------------------------

export async function setPhotoExcludedAction(input: { jobId: string; photoId: string; excluded: boolean; reason?: string | null }): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId)) || !ID.test(String(input.photoId))) return { ok: false, message: "That photo id is not valid." };
  try {
    const { by } = await actor();
    const r = await setPhotoExcluded(input.photoId, input.excluded === true, typeof input.reason === "string" ? input.reason : null, by, input.jobId);
    if (r.ok) refresh(input.jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("include or exclude", e);
  }
}

export async function setHeroAction(jobId: string, photoId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId)) || !ID.test(String(photoId))) return { ok: false, message: "That photo id is not valid." };
  try {
    const { by } = await actor();
    const r = await setHero(jobId, photoId, by);
    if (r.ok) refresh(jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("hero", e);
  }
}

export async function saveDeliveryOrderAction(jobId: string, photoIds: string[]): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId)) || !Array.isArray(photoIds) || photoIds.some((p) => typeof p !== "string" || !ID.test(p))) return { ok: false, message: "That order is not valid." };
  try {
    const { by } = await actor();
    const r = await setDeliveryOrder(jobId, photoIds, by);
    if (r.ok) refresh(jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("order", e);
  }
}

// ---- job: holds and QC -----------------------------------------------------------------------

export async function holdJobAction(jobId: string, reason: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId))) return { ok: false, message: "That job id is not valid." };
  try {
    const { by } = await actor();
    const r = await holdJob(jobId, typeof reason === "string" ? reason : "", by);
    if (r.ok) refresh(jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("hold", e);
  }
}

export async function releaseHoldAction(jobId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId))) return { ok: false, message: "That job id is not valid." };
  try {
    const { by } = await actor();
    const r = await releaseJobHold(jobId, by);
    if (r.ok) refresh(jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("release", e);
  }
}

export async function requestQcAction(jobId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId))) return { ok: false, message: "That job id is not valid." };
  try {
    const settings = await photoDeliverySettings();
    if (!settings.qcEnabled) return { ok: false, message: "QC is switched off in Photo Delivery settings." };
    const { by } = await actor();
    const r = await requestQcRerun(jobId, by);
    if (r.ok) refresh(jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("QC request", e);
  }
}

// ---- fixes (plan 8.3, 8.4) ---------------------------------------------------------------------

export async function approveFixesAction(input: { jobId: string; findingIds: string[]; mode: "ALL" | "SELECTED" | "CRITICAL_MAJOR_ONLY" }): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.jobId))) return { ok: false, message: "That job id is not valid." };
  if (!["ALL", "SELECTED", "CRITICAL_MAJOR_ONLY"].includes(input.mode)) return { ok: false, message: "That fix mode is not valid." };
  const ids = (Array.isArray(input.findingIds) ? input.findingIds : []).filter((x) => typeof x === "string" && ID.test(x));
  try {
    const { by, role } = await actor();
    // The real role, so Kyle's per-batch credit cap applies (plan 8.3).
    const r = await approveFixBatch({ jobId: input.jobId, findingIds: ids, mode: input.mode, by, role });
    if (!r.ok) return { ok: false, message: r.message };
    refresh(input.jobId);
    return { ok: true, message: `Approved ${r.operations} fix${r.operations === 1 ? "" : "es"} (est. ${r.estimatedCredits} credit${r.estimatedCredits === 1 ? "" : "s"}). They run in AutoHDR on the next pass.` };
  } catch (e) {
    return failed("fix approval", e);
  }
}

// ---- delivery (plan 9.6) ---------------------------------------------------------------------------

export async function startDeliveryAction(jobId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId))) return { ok: false, message: "That job id is not valid." };
  try {
    const { by } = await actor();
    const r = await startDelivery(jobId, by);
    if (r.ok) refresh(jobId);
    return r;
  } catch (e) {
    return failed("delivery", e);
  }
}

/** Owner only: deliver past an open checklist, with a typed reason (logged and posted). */
export async function overrideDeliverAction(jobId: string, reason: string): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId))) return { ok: false, message: "That job id is not valid." };
  const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  if (why.length < 5) return { ok: false, message: "Write the reason for the override." };
  try {
    const { by } = await actor();
    const r = await startDelivery(jobId, by, { override: { reason: why, role: "OWNER" } });
    if (r.ok) refresh(jobId);
    return r;
  } catch (e) {
    return failed("override", e);
  }
}

export async function verifyDeliveryAction(jobId: string): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(String(jobId))) return { ok: false, message: "That job id is not valid." };
  try {
    const { by } = await actor();
    const r = await verifyDelivery(jobId, by);
    refresh(jobId);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("verification", e);
  }
}

// ---- credits (plan 10) -----------------------------------------------------------------------------

export async function checkBalanceAction(): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return denied(e);
  }
  try {
    const r = await recordCreditSnapshot({ trigger: "manual" });
    revalidatePath(`${BASE}/credits`);
    revalidatePath(BASE);
    if (!r.ok) return { ok: false, message: `Couldn't read the balance: ${r.reason}` };
    return { ok: true, message: `AutoHDR balance: ${r.balance.toLocaleString("en-US")} credits.${r.alert ? " An alert went to Jordan and Kyle." : ""}` };
  } catch (e) {
    return failed("balance check", e);
  }
}

export async function saveThresholdsAction(input: { warn: number; critical: number; resetBuffer: number; usdPerCredit: number }): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const warn = Math.round(n(input?.warn));
  const critical = Math.round(n(input?.critical));
  const resetBuffer = Math.round(n(input?.resetBuffer));
  const usdPerCredit = n(input?.usdPerCredit);
  if (!(warn > 0 && warn <= 100_000)) return { ok: false, message: "The warning level must be a whole number above 0." };
  if (!(critical > 0 && critical <= warn)) return { ok: false, message: "The critical level must be above 0 and no higher than the warning level." };
  if (!(resetBuffer > 0 && resetBuffer <= 10_000)) return { ok: false, message: "The reset buffer must be a whole number above 0." };
  if (!(usdPerCredit > 0 && usdPerCredit <= 100)) return { ok: false, message: "The dollars per credit must be above 0 (for example 0.50)." };
  try {
    const { by } = await actor();
    await saveCreditThresholds({ warn, critical, resetBuffer, usdPerCredit: Math.round(usdPerCredit * 10_000) / 10_000 }, by);
    const t = await creditThresholds();
    revalidatePath(`${BASE}/credits`);
    revalidatePath(BASE);
    return { ok: true, message: `Saved: warn below ${t.warn}, critical below ${t.critical}.` };
  } catch (e) {
    return failed("thresholds", e);
  }
}

// ---- settings (owner) ----------------------------------------------------------------------------

type SettingsInput = Partial<Omit<PhotoDeliverySettings, "qcFrom">> & { qcFrom?: string | null };

const BOOL_KEYS = ["enabled", "qcEnabled", "qcShadow", "fixRunnerEnabled", "autoFixZeroCredit", "aryeoTags", "p3AllPhotos", "autoSubmit", "freeCheck", "paidQcAuto", "autoFix"] as const;
const NUM_RULES: Record<string, { min: number; max: number; int: boolean; label: string }> = {
  adminCreditCap: { min: 0, max: 10_000, int: true, label: "Kyle's approval limit" },
  dailyAutoCreditCap: { min: 0, max: 10_000, int: true, label: "Daily automatic credit limit" },
  displayConfidenceFloor: { min: 0, max: 1, int: false, label: "Confidence floor" },
  maskPaddingPct: { min: 0, max: 100, int: false, label: "Mask padding (percent)" },
  maskPaddingMinPx: { min: 0, max: 500, int: true, label: "Mask padding (pixels)" },
  minLongEdgePx: { min: 300, max: 20_000, int: true, label: "Minimum long edge" },
  monthlyQcBudgetUsd: { min: 0, max: 100_000, int: false, label: "Monthly QC budget" },
  fixTargetUsd: { min: 0, max: 1_000, int: false, label: "Fix target per shoot" },
  fixMaxUsd: { min: 0, max: 1_000, int: false, label: "Fix maximum per shoot" },
};

export async function saveSettingsAction(input: SettingsInput): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (!input || typeof input !== "object") return { ok: false, message: "Nothing to save." };
  const next: Partial<PhotoDeliverySettings> = {};
  for (const k of BOOL_KEYS) {
    if (k in input) {
      if (typeof input[k] !== "boolean") return { ok: false, message: `${k} must be on or off.` };
      next[k] = input[k] as boolean;
    }
  }
  for (const [k, rule] of Object.entries(NUM_RULES)) {
    if (!(k in input)) continue;
    const v = (input as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < rule.min || v > rule.max || (rule.int && !Number.isInteger(v))) {
      return { ok: false, message: `${rule.label} must be ${rule.int ? "a whole number " : ""}from ${rule.min} to ${rule.max.toLocaleString("en-US")}.` };
    }
    (next as Record<string, unknown>)[k] = v;
  }
  if ("maxBuildPhase" in input) {
    if (input.maxBuildPhase !== 1 && input.maxBuildPhase !== 2 && input.maxBuildPhase !== 3) return { ok: false, message: "The build phase must be 1, 2 or 3." };
    next.maxBuildPhase = input.maxBuildPhase;
  }
  if ("qcFrom" in input) {
    if (input.qcFrom === null || input.qcFrom === "") next.qcFrom = null;
    else if (typeof input.qcFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.qcFrom) && !Number.isNaN(etAt(input.qcFrom, 0).getTime())) {
      // A calendar day in Eastern time: QC starts with galleries from midnight ET that day.
      next.qcFrom = etAt(input.qcFrom, 0).toISOString();
    } else return { ok: false, message: "The QC start date must be a date (or blank)." };
  }
  try {
    const { by } = await actor();
    await savePhotoDeliverySettings(next, by);
    revalidatePath(`${BASE}/settings`);
    revalidatePath(BASE);
    return { ok: true, message: "Photo Delivery settings saved." };
  } catch (e) {
    return failed("settings", e);
  }
}

export async function saveClientProfileAction(input: {
  clientId: string;
  slaHours: number | null;
  notes: string;
  deliveryMessage: string;
  ruleOverrides: RuleOverride[];
}): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (!input || !ID.test(String(input.clientId))) return { ok: false, message: "That client id is not valid." };
  try {
    const { by } = await actor();
    const r = await saveClientQcProfile(
      input.clientId,
      {
        slaHours: input.slaHours === null || input.slaHours === undefined ? null : Number(input.slaHours),
        notes: typeof input.notes === "string" ? input.notes : null,
        deliveryMessage: typeof input.deliveryMessage === "string" ? input.deliveryMessage : null,
        ruleOverrides: Array.isArray(input.ruleOverrides) ? input.ruleOverrides : [],
      },
      by,
    );
    if (r.ok) {
      revalidatePath(`${BASE}/settings`);
      revalidatePath(BASE);
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return failed("client profile", e);
  }
}

// ---- photographer coaching note (owner approves the first month) ---------------------------------

export async function sendCoachingAction(input: { jobId: string; note: string; reminders: string[] }): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(input.jobId)) return { ok: false, message: "Unknown job." };
  const note = String(input.note ?? "").trim().slice(0, 1500);
  const reminders = (Array.isArray(input.reminders) ? input.reminders : []).map((r) => String(r).trim().slice(0, 120)).filter(Boolean).slice(0, 3);
  if (!note) return { ok: false, message: "The note is empty." };
  try {
    const { sendCoachingNote } = await import("@/lib/photoDelivery/coaching");
    const { by } = await actor();
    const r = await sendCoachingNote(input.jobId, by, { note, preShootReminders: reminders });
    refresh(input.jobId);
    return r;
  } catch (e) {
    return failed("send coaching note", e);
  }
}

export async function discardCoachingAction(jobId: string): Promise<ActionResult> {
  try {
    await requireOwner();
  } catch (e) {
    return denied(e);
  }
  if (!ID.test(jobId)) return { ok: false, message: "Unknown job." };
  try {
    const { discardCoachingNote } = await import("@/lib/photoDelivery/coaching");
    const { by } = await actor();
    const r = await discardCoachingNote(jobId, by);
    refresh(jobId);
    return r;
  } catch (e) {
    return failed("discard coaching note", e);
  }
}
