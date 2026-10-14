import "server-only";

import { getSetting, putSetting } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Photo Delivery switches and thresholds (docs/photo-delivery/01 §14), stored
// in AppSetting so Jordan can change them on the settings page without a
// deploy. Every switch that can spend money or reach a client defaults OFF.
//
//   enabled        the job sync + queue (reads Dropbox, writes hub rows only)
//   qcEnabled      run the QC engine on new finals (Claude + sharp; costs
//                  Anthropic API money, about $2 a gallery, never AutoHDR credits)
//   qcShadow       QC results are advisory: nothing is held or blocked by them
//                  (first two weeks, plan §7.7). Kyle keeps his manual QC.
//   maxBuildPhase  which rules run (1 = the checklist's priority detections)
//   autoFixZeroCredit  plan §8.3 optional: auto-run 0-credit fixes on
//                  non-CRITICAL findings at confidence >= 0.9. Default OFF.
//   adminCreditCap Kyle may approve fix batches up to this many credits.
//   aryeoTags      mirror pipeline status into Aryeo order tags/notes. OFF:
//                  Aryeo writes wait for Jordan's go-ahead.
//   p3AllPhotos    run the original-vs-edited pass on every photo.
// ---------------------------------------------------------------------------

export type PhotoDeliverySettings = {
  enabled: boolean;
  qcEnabled: boolean;
  qcShadow: boolean;
  maxBuildPhase: 1 | 2 | 3;
  autoFixZeroCredit: boolean;
  adminCreditCap: number;
  dailyAutoCreditCap: number;
  aryeoTags: boolean;
  p3AllPhotos: boolean;
  displayConfidenceFloor: number;
  maskPaddingPct: number;
  maskPaddingMinPx: number;
  minLongEdgePx: number;
  /** Only QC galleries whose finals landed on or after this date (ISO). */
  qcFrom: string | null;
  /** Anthropic spend guardrail: QC pauses (and alerts) above this many USD in a calendar month. */
  monthlyQcBudgetUsd: number;
};

export const DEFAULT_PHOTO_DELIVERY_SETTINGS: PhotoDeliverySettings = {
  enabled: true,
  qcEnabled: false,
  qcShadow: true,
  maxBuildPhase: 1,
  autoFixZeroCredit: false,
  adminCreditCap: 25,
  dailyAutoCreditCap: 0,
  aryeoTags: false,
  p3AllPhotos: false,
  displayConfidenceFloor: 0.5,
  maskPaddingPct: 10,
  maskPaddingMinPx: 16,
  minLongEdgePx: 2000,
  qcFrom: null,
  monthlyQcBudgetUsd: 300,
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
    qcEnabled: bool(raw.qcEnabled, d.qcEnabled),
    qcShadow: bool(raw.qcShadow, d.qcShadow),
    maxBuildPhase: phase,
    autoFixZeroCredit: bool(raw.autoFixZeroCredit, d.autoFixZeroCredit),
    adminCreditCap: num(raw.adminCreditCap, d.adminCreditCap, 0, 10_000),
    dailyAutoCreditCap: num(raw.dailyAutoCreditCap, d.dailyAutoCreditCap, 0, 10_000),
    aryeoTags: bool(raw.aryeoTags, d.aryeoTags),
    p3AllPhotos: bool(raw.p3AllPhotos, d.p3AllPhotos),
    displayConfidenceFloor: num(raw.displayConfidenceFloor, d.displayConfidenceFloor, 0, 1),
    maskPaddingPct: num(raw.maskPaddingPct, d.maskPaddingPct, 0, 100),
    maskPaddingMinPx: num(raw.maskPaddingMinPx, d.maskPaddingMinPx, 0, 500),
    minLongEdgePx: num(raw.minLongEdgePx, d.minLongEdgePx, 300, 20_000),
    qcFrom: typeof raw.qcFrom === "string" && !Number.isNaN(Date.parse(raw.qcFrom)) ? raw.qcFrom : d.qcFrom,
    monthlyQcBudgetUsd: num(raw.monthlyQcBudgetUsd, d.monthlyQcBudgetUsd, 0, 100_000),
  };
}

export async function savePhotoDeliverySettings(next: Partial<PhotoDeliverySettings>, by: string | null): Promise<PhotoDeliverySettings> {
  const cur = await photoDeliverySettings();
  await putSetting(KEY, { ...cur, ...next }, by);
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
