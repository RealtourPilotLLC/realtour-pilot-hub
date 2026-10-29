import "server-only";

import { getSetting, putSetting } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Photo Delivery switches and thresholds (docs/photo-delivery/01 §14), stored
// in AppSetting so Jordan can change them on the settings page without a
// deploy. Every switch that can spend money or reach a client defaults OFF.
//
//   enabled        the job sync + queue (reads Dropbox, writes hub rows only)
//   qcEnabled      run the QC engine on new finals (Claude + sharp; costs
//                  Anthropic API money, never AutoHDR credits)
//   qcShadow       QC results are advisory: nothing is held or blocked by them
//                  (first two weeks, plan §7.7). Kyle keeps his manual QC.
//                  The hub's own Aryeo delivery ignores it (aryeoPush.ts).
//   maxBuildPhase  which rules run (1 = the checklist's priority detections)
//   adminCreditCap Kyle may approve fix batches up to this many credits.
//   fixRunnerEnabled  AutoHDR fixes actually run. While off a batch cannot be
//                  approved and no fix is sent to AutoHDR. The settings page
//                  shows it with autoFix as one choice: off / approved / auto.
//   autoSubmit     (Oct 14 2026) the hub sends each finished upload, and files
//                  added later, to AutoHDR with the account's default look.
//                  Free until download (house models). Only shoots on or after
//                  autoSubmitFrom, so nothing already edited is sent again.
//   freeCheck      (Oct 14 2026) AutoHDR's free "describe" call checks every
//                  edited photo against a checklist: no credits, no Claude.
//   paidQcAuto     the Claude QC starts by itself on a landed gallery (and the
//                  after-delivery audits). OFF = it runs only when asked
//                  ("Run QC" on the job page). Jordan, Oct 14: QC should be free.
//   autoFix        (Oct 14 2026) after the free check and its free second look,
//                  the hub picks the fixes itself (fixPolicy.ts) within
//                  fixTargetUsd (most shoots) and fixMaxUsd (never above), one
//                  AI re-edit per photo, checked again (free) after the edit.
//                  Needs fixRunnerEnabled too. asIsClientIds: clients whose
//                  homes are shot as they are (only camera, car and trash fixes).
//   aryeoPush      (Oct 14 2026, Jordan: "There has to be" a way to automate
//                  the upload and delivery on Aryeo) the hub puts the
//                  06-Ready-for-Aryeo photos on the listing itself, signed in
//                  as its own Aryeo team login (aryeoPush.ts).
//                    off  nothing; Kyle uploads and delivers by hand
//                    on   (Oct 15, Jordan: "it just goes to a ready to review
//                         section", Kyle reorders, double-checks the fixes and
//                         findings, then "approve and deliver or approve and
//                         upload to Aryeo") nothing reaches Aryeo before Kyle
//                         approves the job. The old stages upload / approve /
//                         auto read as on.
//   sameDayAutoDeliver (Oct 15, Jordan: "Jobs with same day delivery can just
//                  approve and deliver automatically after multiple checks and
//                  auto reorganize") with aryeoPush on, a job whose order has
//                  the same-day photos add-on approves and delivers itself in
//                  the hub's suggested order, only when every check passes
//                  (aryeoPush.ts sameDayReady), checked again before delivery.
//   Oct 15 2026 (Jordan: "the biggest thing I need is making sure images are
//   not warped or cluttered"), all free, so ON by default:
//   warpCv         measure the lines of each photo (qc/cv.ts lineGeometry) on
//                  bytes the hub can read for free (the Aryeo listing, a kept
//                  version copy, a photo already bought); never a download
//                  that costs a credit. Oct 29 2026: lines that should run
//                  level are measured too (a camera roll, inside a room).
//   warpCompareOriginal  for a cut-off roof or warped walls, the camera's own
//                  frame of the shot from the raw folder (cameraFrame.ts; Oct
//                  29 2026, no longer AutoHDR's Original): the edit did it
//                  (EDITOR, Perspective Off) or the framing did (PHOTOGRAPHER,
//                  coaching); kept and shown beside the edit.
//   freeCoverage   the rooms a listing needs (its bedrooms and bathrooms)
//                  against the delivered photos and AutoHDR's photos of the
//                  shoot: shot but not delivered, never shot, lost in editing.
//   afterDeliveryCheck  a delivered job whose listing photos change (within
//                  7 days) gets the free check on the new photos, and Kyle
//                  and Jordan hear about it; the stage never moves.
//
// Oct 23 2026 (Jordan): "Paid Photo QC should be off. Only using the free
// version. I don't need a paid QC, only paid fixes through AutoHDR." PAID_QC_OFF:
// qcEnabled and paidQcAuto always read false, whatever is stored, and a save
// stores them false. The paid engine itself (qc/run.ts, qc/claude.ts, its
// prompts and the coaching drafts) was deleted on Oct 25 2026 (audit D7), so
// nothing is left that could run it; this switch still keeps the stored
// value and the settings save honest. The free check and the AutoHDR fixes
// are untouched. The paid
// QC's other settings (monthlyQcBudgetUsd, maxBuildPhase) are kept in the
// stored value but no screen shows them.
// ---------------------------------------------------------------------------

/** Paid (Claude) photo QC is off for good (Jordan, Oct 23 2026). Only the free check runs. */
export const PAID_QC_OFF: boolean = true;
/** What a person reads when something asks for the paid QC. */
export const PAID_QC_OFF_MESSAGE = "Paid photo QC is off. Only the free photo check runs, by itself; Check again asks for it.";

export type PhotoDeliverySettings = {
  enabled: boolean;
  qcEnabled: boolean;
  qcShadow: boolean;
  maxBuildPhase: 1 | 2 | 3;
  fixRunnerEnabled: boolean;
  adminCreditCap: number;
  displayConfidenceFloor: number;
  maskPaddingPct: number;
  maskPaddingMinPx: number;
  minLongEdgePx: number;
  /** Only QC galleries whose finals landed on or after this date (ISO). */
  qcFrom: string | null;
  /** Anthropic spend guardrail: QC pauses (and alerts) above this many USD in a calendar month. */
  monthlyQcBudgetUsd: number;
  autoSubmit: boolean;
  /** Shoots before this (ISO) are never sent by the hub. */
  autoSubmitFrom: string;
  freeCheck: boolean;
  paidQcAuto: boolean;
  autoFix: boolean;
  fixTargetUsd: number;
  fixMaxUsd: number;
  /** All automatic fixes in one ET day, in credits (a runaway guard). */
  autoFixDailyMaxCredits: number;
  asIsClientIds: string[];
  /** Show the hub's own AutoHDR photos (display.ts buys each once: the delivery credit). */
  showAutohdrPhotos: boolean;
  /** AutoHDR model for REAL twilight photos (a predefined twilight model; read from GET /v1/models, Oct 14: 6 = Twilight Golden). */
  realTwilightModelId: number;
  /** The hub uploads and delivers in Aryeo once Kyle approves the job (aryeoPush.ts). */
  aryeoPush: AryeoPushMode;
  /** Same-day jobs approve and deliver themselves when every check passes. */
  sameDayAutoDeliver: boolean;
  /** Measured line check (free bytes only). */
  warpCv: boolean;
  /** Ask about AutoHDR's Original for a cut-off roof or warped walls (free). */
  warpCompareOriginal: boolean;
  /** Free room coverage check. */
  freeCoverage: boolean;
  /** Free check on listing photos that change after delivery (7 days). */
  afterDeliveryCheck: boolean;
};

export type AryeoPushMode = "off" | "on";
export const ARYEO_PUSH_MODES: readonly AryeoPushMode[] = ["off", "on"];

export const DEFAULT_PHOTO_DELIVERY_SETTINGS: PhotoDeliverySettings = {
  enabled: true,
  qcEnabled: false,
  qcShadow: true,
  maxBuildPhase: 1,
  fixRunnerEnabled: false,
  adminCreditCap: 25,
  displayConfidenceFloor: 0.5,
  maskPaddingPct: 10,
  maskPaddingMinPx: 16,
  minLongEdgePx: 2000,
  qcFrom: null,
  monthlyQcBudgetUsd: 300,
  autoSubmit: false,
  autoSubmitFrom: "2026-10-13T04:00:00.000Z",
  freeCheck: false,
  paidQcAuto: false,
  autoFix: false,
  fixTargetUsd: 5,
  fixMaxUsd: 10,
  autoFixDailyMaxCredits: 100,
  asIsClientIds: [],
  realTwilightModelId: 6,
  showAutohdrPhotos: false,
  aryeoPush: "off",
  sameDayAutoDeliver: true,
  warpCv: true,
  warpCompareOriginal: true,
  freeCoverage: true,
  afterDeliveryCheck: true,
};

const KEY = "photo_delivery:settings";

export async function photoDeliverySettings(): Promise<PhotoDeliverySettings> {
  const raw = await getSetting<Partial<PhotoDeliverySettings>>(KEY, {});
  const d = DEFAULT_PHOTO_DELIVERY_SETTINGS;
  const bool = (v: unknown, f: boolean) => (typeof v === "boolean" ? v : f);
  const num = (v: unknown, f: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : f);
  const phase = raw.maxBuildPhase === 1 || raw.maxBuildPhase === 2 || raw.maxBuildPhase === 3 ? raw.maxBuildPhase : d.maxBuildPhase;
  return {
    enabled: bool(raw.enabled, d.enabled),
    // PAID_QC_OFF (Oct 23 2026): never on, whatever is stored.
    qcEnabled: PAID_QC_OFF ? false : bool(raw.qcEnabled, d.qcEnabled),
    qcShadow: bool(raw.qcShadow, d.qcShadow),
    maxBuildPhase: phase,
    fixRunnerEnabled: bool(raw.fixRunnerEnabled, d.fixRunnerEnabled),
    adminCreditCap: num(raw.adminCreditCap, d.adminCreditCap, 0, 10_000),
    displayConfidenceFloor: num(raw.displayConfidenceFloor, d.displayConfidenceFloor, 0, 1),
    maskPaddingPct: num(raw.maskPaddingPct, d.maskPaddingPct, 0, 100),
    maskPaddingMinPx: num(raw.maskPaddingMinPx, d.maskPaddingMinPx, 0, 500),
    minLongEdgePx: num(raw.minLongEdgePx, d.minLongEdgePx, 300, 20_000),
    qcFrom: typeof raw.qcFrom === "string" && !Number.isNaN(Date.parse(raw.qcFrom)) ? raw.qcFrom : d.qcFrom,
    monthlyQcBudgetUsd: num(raw.monthlyQcBudgetUsd, d.monthlyQcBudgetUsd, 0, 100_000),
    autoSubmit: bool(raw.autoSubmit, d.autoSubmit),
    autoSubmitFrom: typeof raw.autoSubmitFrom === "string" && !Number.isNaN(Date.parse(raw.autoSubmitFrom)) ? raw.autoSubmitFrom : d.autoSubmitFrom,
    freeCheck: bool(raw.freeCheck, d.freeCheck),
    paidQcAuto: PAID_QC_OFF ? false : bool(raw.paidQcAuto, d.paidQcAuto),
    autoFix: bool(raw.autoFix, d.autoFix),
    fixTargetUsd: num(raw.fixTargetUsd, d.fixTargetUsd, 0, 1_000),
    fixMaxUsd: num(raw.fixMaxUsd, d.fixMaxUsd, 0, 1_000),
    autoFixDailyMaxCredits: num(raw.autoFixDailyMaxCredits, d.autoFixDailyMaxCredits, 0, 10_000),
    realTwilightModelId: num(raw.realTwilightModelId, d.realTwilightModelId, 1, 100_000),
    showAutohdrPhotos: bool(raw.showAutohdrPhotos, d.showAutohdrPhotos),
    asIsClientIds: Array.isArray(raw.asIsClientIds) ? raw.asIsClientIds.filter((x): x is string => typeof x === "string").slice(0, 500) : d.asIsClientIds,
    // The old stages (upload, approve, auto) all mean "on" now: Kyle approves each job.
    aryeoPush: raw.aryeoPush === "off" ? "off" : ["on", "upload", "approve", "auto"].includes(raw.aryeoPush as string) ? "on" : d.aryeoPush,
    sameDayAutoDeliver: bool(raw.sameDayAutoDeliver, d.sameDayAutoDeliver),
    warpCv: bool(raw.warpCv, d.warpCv),
    warpCompareOriginal: bool(raw.warpCompareOriginal, d.warpCompareOriginal),
    freeCoverage: bool(raw.freeCoverage, d.freeCoverage),
    afterDeliveryCheck: bool(raw.afterDeliveryCheck, d.afterDeliveryCheck),
  };
}

export async function savePhotoDeliverySettings(next: Partial<PhotoDeliverySettings>, by: string | null): Promise<PhotoDeliverySettings> {
  const cur = await photoDeliverySettings();
  // PAID_QC_OFF (Oct 23 2026): the paid QC's two switches are stored off, whatever was asked.
  await putSetting(KEY, { ...cur, ...next, ...(PAID_QC_OFF ? { qcEnabled: false, paidQcAuto: false } : {}) }, by);
  return photoDeliverySettings();
}

/** Model per pass: env override, else the prompt pack's default (0.1). */
export const QC_MODEL_DEFAULTS = {
  P0: "claude-haiku-5-5",
  P1: "claude-sonnet-5-5",
  ARBITER: "claude-opus-5-5",
  P1B: "claude-sonnet-5-5",
  P2: "claude-opus-5-5",
  P3: "claude-opus-5-5",
  P4: "claude-sonnet-5-5",
  FIX_PLANNER: "claude-opus-5-5",
  POST_FIX: "claude-sonnet-5-5",
  REVISION: "claude-sonnet-5-5",
  COACHING: "claude-sonnet-5-5",
  SUMMARY: "claude-haiku-5-5",
} as const;
export type QcModelSlot = keyof typeof QC_MODEL_DEFAULTS;

export function qcModel(slot: QcModelSlot): string {
  const env = process.env[`QC_MODEL_${slot}`]?.trim();
  return env || QC_MODEL_DEFAULTS[slot];
}
