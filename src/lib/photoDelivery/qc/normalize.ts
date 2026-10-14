import type { Prisma } from "@prisma/client";
import { RULES_REGISTRY_VERSION, ruleById, type FixStrategy, type QcRule, type Responsibility, type Severity } from "../registry";
import type { CvIssue } from "./cv";
import { MARKETING, P0OutputLoose, P0OutputStrict, type P0Output } from "./prompts/p0-classify.v1";
import { P1_CHECKS, P1OutputLoose, makeP1Schema, type P1Output } from "./prompts/p1-photo.v1";
import { ArbiterLoose, makeArbiterSchema, type ArbiterOutput } from "./prompts/p1-arbiter.v1";
import { P1bLoose, makeP1bSchema, type P1bOutput } from "./prompts/p1b-dust.v1";
import { GALLERY_CHECKS, P2Loose, makeP2Schema, type P2Output } from "./prompts/p2-gallery.v1";
import { COVERAGE_SOURCES, P4Loose, makeP4Schema, type CoverageStatusT, type P4Output } from "./prompts/p4-order.v1";
import { SummaryLoose, makeSummarySchema, QC_LINK_TOKEN, type SummaryOutput } from "./prompts/delivery-summary.v1";
import {
  LOCAL_EDITS,
  REEDIT_SUFFIX,
  VERIFY_PHRASE,
  allowedSeveritiesOf,
  kebab,
  wordCount,
  zodMessage,
  type InjectedRule,
  type Validation,
} from "./prompts/shared";
import { stripLongDashes } from "./prompts/render";

// ---------------------------------------------------------------------------
// FROM A PASS'S ANSWER TO FINDING ROWS (prompt pack 0.4, 0.7, 0.9).
//
// Every pass answer goes through the same three steps:
//   1. a LOOSE zod parse (types and enums only), so repair has a typed value;
//   2. the deterministic REPAIRS of 0.7, each one logged in coerced[] so the
//      stored record says exactly what code changed and why: confidence
//      clamped; boxes clamped, inverted or empty boxes nulled; a severity
//      outside the rule's allowed set becomes the rule's default (privacy
//      becomes CRITICAL); a strategy the rule does not allow becomes
//      HUMAN_REVIEW; a removal strategy on a permanent feature becomes
//      HUMAN_REVIEW; the reedit suffix is appended; derived fields (verdicts)
//      are recomputed; em and en dashes in staff-facing text become commas;
//   3. the pack's own STRICT zod. Whatever still fails goes back to the model
//      once (claude.ts) and is then handled like a refusal.
// Then the answer becomes FindingDrafts with boxes rescaled to FULL resolution
// (0.4), a groupKey (the model's kebab key for P1, so the same physical thing
// seen from another angle is one ticket), and the provenance every finding
// carries (prompt id and version, model, rules version, coerced, raw).
//
// Pure: no database, no network. The drills call these directly.
// ---------------------------------------------------------------------------

export type Box = [number, number, number, number];

export type FindingDraft = {
  photoId: string | null;
  photoIds: string[] | null;
  ruleId: string;
  groupKey: string;
  pass: "P1_PHOTO" | "P2_GALLERY" | "P3_COMPARE" | "P4_ORDER";
  source: "CV" | "P1" | "P1B" | "P2" | "P3" | "P4" | "FILE";
  specificIssue: string;
  explanation: string;
  locationText: string | null;
  bbox: Box | null;
  severity: Severity;
  confidence: number;
  responsibility: Responsibility;
  postFixable: boolean;
  reshootMayBeNeeded: boolean;
  isPermanentFeature: boolean;
  privacySensitive: boolean;
  recommendedAction: string | null;
  fixStrategy: FixStrategy;
  reeditPrompt: string | null;
  arbitration: "NOT_REQUIRED" | "PENDING" | "CONFIRMED" | "OVERTURNED";
  contentHash: string | null;
  promptId: string | null;
  promptVersion: number | null;
  model: string | null;
  coerced: string[];
  raw: unknown;
};

export function draftToRow(d: FindingDraft, qcRunId: string, jobId: string): Prisma.PhotoQcFindingCreateManyInput {
  const raw = d.raw === undefined ? null : JSON.stringify(d.raw);
  return {
    qcRunId,
    jobId,
    photoId: d.photoId,
    photoIdsJson: d.photoIds && d.photoIds.length ? JSON.stringify(d.photoIds) : null,
    ruleId: d.ruleId,
    groupKey: d.groupKey.slice(0, 120),
    pass: d.pass,
    source: d.source,
    specificIssue: d.specificIssue.slice(0, 200),
    explanation: d.explanation.slice(0, 2000),
    locationText: d.locationText ? d.locationText.slice(0, 300) : null,
    bboxJson: d.bbox ? JSON.stringify(d.bbox) : null,
    severity: d.severity,
    confidence: d.confidence,
    responsibility: d.responsibility,
    postFixable: d.postFixable,
    reshootMayBeNeeded: d.reshootMayBeNeeded,
    isPermanentFeature: d.isPermanentFeature,
    privacySensitive: d.privacySensitive,
    recommendedAction: d.recommendedAction ? d.recommendedAction.slice(0, 1000) : null,
    fixStrategy: d.fixStrategy,
    reeditPrompt: d.reeditPrompt,
    arbitration: d.arbitration,
    status: "OPEN",
    contentHash: d.contentHash,
    promptId: d.promptId,
    promptVersion: d.promptVersion,
    model: d.model,
    rulesVersion: RULES_REGISTRY_VERSION,
    coercedJson: d.coerced.length ? JSON.stringify(d.coerced) : null,
    rawJson: raw ? raw.slice(0, 20_000) : null,
  };
}

// ---- boxes (0.4) -------------------------------------------------------------------------------

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Clamp a box to [0, w] x [0, h]; null when it is inverted or empty. */
export function clampBox(b: number[] | null | undefined, w: number, h: number): Box | null {
  if (!b || b.length !== 4 || b.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const x1 = clampInt(b[0], 0, w), y1 = clampInt(b[1], 0, h), x2 = clampInt(b[2], 0, w), y2 = clampInt(b[3], 0, h);
  return x1 < x2 && y1 < y2 ? [x1, y1, x2, y2] : null;
}

/** Image as sent → full resolution: X = round(x * fullW / sentW), clamped. */
export function rescaleBox(b: Box | null, sent: { w: number; h: number }, full: { w: number; h: number }): Box | null {
  if (!b) return null;
  const sx = full.w / sent.w, sy = full.h / sent.h;
  return clampBox([b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy], full.w, full.h);
}

/** Full resolution → image as sent (the arbiter is shown P1's box). */
export function toSentBox(b: Box | null, full: { w: number; h: number }, sent: { w: number; h: number }): Box | null {
  if (!b) return null;
  return rescaleBox(b, full, sent);
}

/** P1b crops are cut at full resolution: X = cropX0 + x. */
export function cropBoxToFull(b: Box | null, crop: { x0: number; y0: number }, full: { w: number; h: number }): Box | null {
  if (!b) return null;
  return clampBox([crop.x0 + b[0], crop.y0 + b[1], crop.x0 + b[2], crop.y0 + b[3]], full.w, full.h);
}

/** Post-fix region crops are scaled: X = cropX0 + x * cropFullW / cropSentW. */
export function regionBoxToFull(b: Box | null, region: { x0: number; y0: number; cropW: number; cropH: number; sentW: number; sentH: number }, full: { w: number; h: number }): Box | null {
  if (!b) return null;
  const sx = region.cropW / region.sentW, sy = region.cropH / region.sentH;
  return clampBox([region.x0 + b[0] * sx, region.y0 + b[1] * sy, region.x0 + b[2] * sx, region.y0 + b[3] * sy], full.w, full.h);
}

export function iou(a: Box | null, b: Box | null): number {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

// ---- shared text repairs -----------------------------------------------------------------------

function cleanText(s: string | null | undefined, max: number, field: string, coerced: string[]): string {
  let out = String(s ?? "").trim();
  if (/[\u2013\u2014]/.test(out)) {
    out = stripLongDashes(out);
    coerced.push(`${field}: long dash replaced`);
  }
  if (out.length > max) {
    out = out.slice(0, max).replace(/\s+\S*$/, "").trim() || out.slice(0, max);
    coerced.push(`${field}: truncated to ${max} characters`);
  }
  return out;
}

function clampConfidence(c: number, field: string, coerced: string[]): number {
  if (!Number.isFinite(c)) {
    coerced.push(`${field}: not a number, set to 0.5`);
    return 0.5;
  }
  if (c < 0 || c > 1) {
    coerced.push(`${field}: clamped to [0, 1]`);
    return Math.max(0, Math.min(1, c));
  }
  return c;
}

function sortedChecks<T extends string>(all: readonly T[], performed: string[], skipped: { check: string; reason: string }[], coerced: string[]) {
  const valid = new Set<string>(all);
  const perf = [...new Set(performed.filter((c) => valid.has(c)))] as T[];
  const skip: { check: T; reason: string }[] = [];
  for (const s of skipped) {
    if (!valid.has(s.check) || perf.includes(s.check as T) || skip.some((x) => x.check === s.check)) continue;
    let reason = stripLongDashes(String(s.reason ?? "").trim());
    if (reason.length < 3) reason = "no reason given";
    skip.push({ check: s.check as T, reason: reason.slice(0, 200) });
  }
  if (perf.length + skip.length < performed.length + skipped.length) coerced.push("checks: unknown or repeated check ids dropped");
  for (const c of all) {
    if (!perf.includes(c) && !skip.some((s) => s.check === c)) {
      skip.push({ check: c, reason: "not reported by model" });
      coerced.push(`checks: ${c} added as skipped (not reported by model)`);
    }
  }
  return { performed: perf, skipped: skip };
}

// ---- P0 ---------------------------------------------------------------------------------------

export function validateP0(raw: unknown): Validation<P0Output> {
  const loose = P0OutputLoose.safeParse(raw);
  if (!loose.success) return { ok: false, error: zodMessage(loose.error) };
  const o = { ...loose.data };
  const coerced: string[] = [];
  o.roomConfidence = clampConfidence(o.roomConfidence, "roomConfidence", coerced);
  if (o.alternateRoomType && (o.roomConfidence >= 0.85 || o.alternateRoomType === o.roomType)) {
    o.alternateRoomType = null;
    coerced.push("alternateRoomType: null at confidence 0.85 or higher");
  }
  if (o.roomType === "AERIAL" && !o.isAerial) {
    o.isAerial = true;
    coerced.push("isAerial: implied by AERIAL");
  }
  if (o.roomType === "TWILIGHT_EXTERIOR" && !o.isTwilight) {
    o.isTwilight = true;
    coerced.push("isTwilight: implied by TWILIGHT_EXTERIOR");
  }
  let d = cleanText(o.description, 600, "description", coerced);
  if (new RegExp(MARKETING.source, "i").test(d)) {
    d = d.replace(MARKETING, "").replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
    coerced.push("description: marketing words removed");
  }
  if (wordCount(d) > 45) {
    d = d.split(/\s+/).slice(0, 45).join(" ").replace(/[,;:]$/, "") + ".";
    coerced.push("description: cut to 45 words");
  }
  o.description = d;
  const feats = [...new Set(o.features.map((f) => stripLongDashes(f).trim().toLowerCase()).filter((f) => f.length >= 2 && f.length <= 48))].slice(0, 8);
  if (feats.length !== o.features.length) coerced.push("features: trimmed to 8 valid phrases");
  o.features = feats;
  const hs = Math.max(0, Math.min(100, Math.round(o.heroScore)));
  if (hs !== o.heroScore) coerced.push("heroScore: rounded and clamped to 0..100");
  o.heroScore = hs;
  const strict = P0OutputStrict.safeParse(o);
  if (!strict.success) return { ok: false, error: zodMessage(strict.error) };
  return { ok: true, value: strict.data, coerced };
}

// ---- P1 ---------------------------------------------------------------------------------------

export type P1Ctx = {
  /** Sent size of the inspected image. */
  w: number;
  h: number;
  rules: Map<string, InjectedRule>;
};

export function validateP1(raw: unknown, c: P1Ctx): Validation<P1Output> {
  const loose = P1OutputLoose.safeParse(raw);
  if (!loose.success) return { ok: false, error: zodMessage(loose.error) };
  const o = loose.data;
  const coerced: string[] = [];
  let findings = o.findings;
  if (findings.length > 25) {
    coerced.push(`findings: kept 25 of ${findings.length}`);
    findings = findings.slice(0, 25);
  }
  const fixed = findings.map((f, k) => {
    const tag = `findings[${k}]`;
    let ruleId = f.ruleId;
    if (ruleId !== "OTHER_DEFECT" && !c.rules.has(ruleId)) {
      coerced.push(`${tag}.ruleId: ${ruleId.slice(0, 60)} is not an injected rule, set to OTHER_DEFECT`);
      ruleId = "OTHER_DEFECT";
    }
    const rule = c.rules.get(ruleId);
    let severity = f.severity;
    if (f.privacySensitive && severity !== "CRITICAL") {
      severity = "CRITICAL";
      coerced.push(`${tag}.severity: privacy finding set to CRITICAL`);
    } else if (rule && !allowedSeveritiesOf(rule).has(severity)) {
      coerced.push(`${tag}.severity: ${severity} outside the rule's range, set to ${rule.defaultSeverity}`);
      severity = rule.defaultSeverity;
    }
    let strategy = f.fixStrategy;
    if (strategy === "REVERT_VERSION") {
      strategy = "HUMAN_REVIEW";
      coerced.push(`${tag}.fixStrategy: REVERT_VERSION is not used in P1, set to HUMAN_REVIEW`);
    } else if (rule && ![...rule.fixStrategies, "HUMAN_REVIEW", "NONE"].includes(strategy)) {
      coerced.push(`${tag}.fixStrategy: ${strategy} not allowed for the rule, set to HUMAN_REVIEW`);
      strategy = "HUMAN_REVIEW";
    }
    if (f.isPermanentFeature && LOCAL_EDITS.has(strategy)) {
      coerced.push(`${tag}.fixStrategy: permanent feature routed to ${strategy}, set to HUMAN_REVIEW`);
      strategy = "HUMAN_REVIEW";
    }
    let reedit: string | null = f.reeditPrompt === null ? null : f.reeditPrompt.trim() || null;
    if (strategy !== "REEDIT_PROMPT" && reedit !== null) {
      reedit = null;
      coerced.push(`${tag}.reeditPrompt: dropped (strategy is not REEDIT_PROMPT)`);
    }
    if (strategy === "REEDIT_PROMPT") {
      if (!reedit) {
        const template = rule ? ruleById(rule.id)?.reeditPromptTemplate : undefined;
        if (template) {
          reedit = template;
          coerced.push(`${tag}.reeditPrompt: missing, the registry template was used`);
        } else {
          strategy = "HUMAN_REVIEW";
          coerced.push(`${tag}.fixStrategy: REEDIT_PROMPT without a prompt, set to HUMAN_REVIEW`);
        }
      }
      if (reedit) {
        if (/[\u2013\u2014]/.test(reedit)) {
          reedit = stripLongDashes(reedit);
          coerced.push(`${tag}.reeditPrompt: long dash replaced`);
        }
        if (!reedit.endsWith(REEDIT_SUFFIX)) {
          reedit = `${reedit.replace(/\s+$/, "")}${/[.!?]$/.test(reedit.trim()) ? "" : "."} ${REEDIT_SUFFIX}`;
          coerced.push(`${tag}.reeditPrompt: suffix appended`);
        }
        if (reedit.length < 20 || reedit.length > 600 || wordCount(reedit) > 90) {
          coerced.push(`${tag}.reeditPrompt: unusable length, strategy set to HUMAN_REVIEW`);
          reedit = null;
          strategy = "HUMAN_REVIEW";
        }
      }
    }
    let groupKey = kebab(f.groupKey);
    if (groupKey !== f.groupKey) {
      groupKey = groupKey ?? kebab(rule?.groupKey) ?? "other-defect";
      coerced.push(`${tag}.groupKey: normalized to ${groupKey}`);
    }
    const box = f.bbox ? clampBox(f.bbox, c.w, c.h) : null;
    if (f.bbox && (!box || box.some((v, i) => v !== f.bbox?.[i]))) coerced.push(`${tag}.bbox: ${box ? "clamped to the image" : "inverted or empty, set to null"}`);
    let specific = cleanText(f.specificIssue, 100, `${tag}.specificIssue`, coerced);
    if (specific.length < 3) {
      specific = rule?.shortLabel ?? "Visible defect";
      coerced.push(`${tag}.specificIssue: too short, the rule label was used`);
    }
    return {
      ruleId,
      groupKey: groupKey as string,
      specificIssue: specific,
      locationText: cleanText(f.locationText, 120, `${tag}.locationText`, coerced),
      bbox: box,
      explanation: cleanText(f.explanation, 600, `${tag}.explanation`, coerced),
      severity,
      confidence: clampConfidence(f.confidence, `${tag}.confidence`, coerced),
      isPermanentFeature: f.isPermanentFeature,
      privacySensitive: f.privacySensitive,
      responsibility: f.responsibility,
      fixStrategy: strategy,
      reeditPrompt: reedit,
      recommendedAction: cleanText(f.recommendedAction, 300, `${tag}.recommendedAction`, coerced),
      postFixable: f.postFixable,
      reshootMayBeNeeded: f.reshootMayBeNeeded,
    };
  });
  const checks = sortedChecks(P1_CHECKS, o.checksPerformed, o.checksSkipped, coerced);
  const sev = new Set(fixed.map((f) => f.severity));
  const verdict = sev.has("CRITICAL") ? "HOLD" : sev.has("MAJOR") ? "NEEDS_FIX" : sev.size ? "PASS_WITH_MINOR" : "PASS";
  if (verdict !== o.overallPhotoVerdict) coerced.push(`overallPhotoVerdict: recomputed as ${verdict}`);
  const value = { findings: fixed, checksPerformed: checks.performed, checksSkipped: checks.skipped, overallPhotoVerdict: verdict };
  const strict = makeP1Schema(c).safeParse(value);
  if (!strict.success) return { ok: false, error: zodMessage(strict.error) };
  return { ok: true, value: strict.data, coerced };
}

/** P1 findings as rows: boxes at full resolution, CRITICAL ones PENDING the arbiter. */
export function p1Drafts(value: P1Output, ctx: { photoId: string; contentHash: string; sent: { w: number; h: number }; full: { w: number; h: number }; model: string; coerced: string[]; callIds: string[] }): FindingDraft[] {
  return value.findings.map((f, k) => {
    const mine = ctx.coerced.filter((s) => s.startsWith(`findings[${k}]`)).map((s) => s.replace(/^findings\[\d+\]\./, ""));
    return {
      photoId: ctx.photoId,
      photoIds: null,
      ruleId: f.ruleId,
      groupKey: f.groupKey,
      pass: "P1_PHOTO",
      source: "P1",
      specificIssue: f.specificIssue,
      explanation: f.explanation,
      locationText: f.locationText || null,
      bbox: rescaleBox(f.bbox as Box | null, ctx.sent, ctx.full),
      severity: f.severity,
      confidence: f.confidence,
      responsibility: f.responsibility,
      postFixable: f.postFixable,
      reshootMayBeNeeded: f.reshootMayBeNeeded,
      isPermanentFeature: f.isPermanentFeature,
      privacySensitive: f.privacySensitive,
      recommendedAction: f.recommendedAction || null,
      fixStrategy: f.fixStrategy,
      reeditPrompt: f.reeditPrompt,
      arbitration: f.severity === "CRITICAL" ? "PENDING" : "NOT_REQUIRED",
      contentHash: ctx.contentHash,
      promptId: "P1_PHOTO",
      promptVersion: 1,
      model: ctx.model,
      coerced: mine,
      raw: { finding: f, sent: ctx.sent, callIds: ctx.callIds },
    };
  });
}

// ---- P1 arbiter ---------------------------------------------------------------------------------

export function validateArbiter(raw: unknown, c: { w: number; h: number }): Validation<ArbiterOutput> {
  const loose = ArbiterLoose.safeParse(raw);
  if (!loose.success) return { ok: false, error: zodMessage(loose.error) };
  const o = { ...loose.data };
  const coerced: string[] = [];
  o.confidence = clampConfidence(o.confidence, "confidence", coerced);
  const box = o.bbox ? clampBox(o.bbox, c.w, c.h) : null;
  if (o.bbox && !box) coerced.push("bbox: inverted or empty, set to null");
  o.bbox = box;
  o.evidence = cleanText(o.evidence, 600, "evidence", coerced);
  // Both inconsistent answers resolve toward CRITICAL: an arbiter that says
  // "confirmed" or "CRITICAL" has not cleared the finding.
  if (o.confirmed && o.severity !== "CRITICAL") {
    o.severity = "CRITICAL";
    coerced.push("severity: confirmed implies CRITICAL");
  } else if (!o.confirmed && o.severity === "CRITICAL") {
    o.confirmed = true;
    coerced.push("confirmed: a CRITICAL severity means the arbiter agreed");
  }
  const strict = makeArbiterSchema(c.w, c.h).safeParse(o);
  if (!strict.success) return { ok: false, error: zodMessage(strict.error) };
  return { ok: true, value: strict.data, coerced };
}

/** What the arbiter's answer does to the finding (2.6): CONFIRMED keeps it;
 *  otherwise OVERTURNED with the arbiter's severity. A privacy finding never
 *  drops below MAJOR and goes to a person (HUMAN_REVIEW). */
export function applyArbiter(f: { severity: Severity; privacySensitive: boolean; fixStrategy: FixStrategy }, a: { confirmed: boolean; severity: Severity }): { arbitration: "CONFIRMED" | "OVERTURNED"; severity: Severity; fixStrategy: FixStrategy; note: string | null } {
  if (a.confirmed) return { arbitration: "CONFIRMED", severity: "CRITICAL", fixStrategy: f.fixStrategy, note: null };
  if (f.privacySensitive) {
    return { arbitration: "OVERTURNED", severity: a.severity === "MINOR" ? "MAJOR" : a.severity, fixStrategy: "HUMAN_REVIEW", note: "privacy finding overturned by the arbiter: kept at MAJOR or above for a person to decide" };
  }
  return { arbitration: "OVERTURNED", severity: a.severity, fixStrategy: f.fixStrategy, note: `overturned by the arbiter to ${a.severity}` };
}

// ---- P1b ----------------------------------------------------------------------------------------

export type P1bCrop = {
  cropId: string;
  photoId: string;
  candidateIndex: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  fullW: number;
  fullH: number;
  depth: number;
  group: string | null;
  groupCount: number;
  contentHash: string;
  /** The candidate's own full-resolution box (used when the model gives none). */
  candidateBox: Box;
};

export function validateP1b(raw: unknown, crops: { cropId: string; w: number; h: number }[]): Validation<P1bOutput> {
  const loose = P1bLoose.safeParse(raw);
  if (!loose.success) return { ok: false, error: zodMessage(loose.error) };
  const coerced: string[] = [];
  const byId = new Map(loose.data.results.map((r) => [r.cropId, r]));
  if (byId.size !== loose.data.results.length) coerced.push("results: repeated crop ids, first kept");
  const results = crops.map((k) => {
    const r = byId.get(k.cropId);
    if (!r) {
      coerced.push(`${k.cropId}: no result, set to uncertain with confidence 0`);
      return { cropId: k.cropId, note: "No result returned for this crop.", verdict: "uncertain" as const, confidence: 0, refinedBbox: null, isPropertyCondition: false };
    }
    let box = r.refinedBbox ? clampBox(r.refinedBbox, k.w, k.h) : null;
    if (r.refinedBbox && !box) coerced.push(`${k.cropId}: box inverted or empty, set to null`);
    if (r.verdict === "isTextureOrPattern" && box) box = null;
    let prop = r.isPropertyCondition;
    if (prop && r.verdict !== "isRealObject") {
      prop = false;
      coerced.push(`${k.cropId}: isPropertyCondition only applies to isRealObject`);
    }
    return { cropId: k.cropId, note: cleanText(r.note, 300, `${k.cropId}.note`, coerced), verdict: r.verdict, confidence: clampConfidence(r.confidence, `${k.cropId}.confidence`, coerced), refinedBbox: box, isPropertyCondition: prop };
  });
  if (loose.data.results.some((r) => !crops.some((k) => k.cropId === r.cropId))) coerced.push("results: unknown crop ids dropped");
  const strict = makeP1bSchema(crops).safeParse({ results });
  if (!strict.success) return { ok: false, error: zodMessage(strict.error) };
  return { ok: true, value: strict.data, coerced };
}

/** Contrast (luma levels) above which an "uncertain" spot still goes to a person. */
export const UNCERTAIN_DUST_MIN_DEPTH = 8;

/**
 * P1b results as rows (3.4): every confirmed dust spot becomes a MAJOR
 * AUTOREMOVE_MASK finding with its full-resolution box (the fix flow merges a
 * photo's spots into one multi-region mask, plan §8.2). They start under the
 * groupKey "sensor-dust" (one ticket); once every batch is in, the run moves
 * the spots of a recurrence group confirmed in 3+ photos to a spot-specific
 * key ("sensor-dust-repeated-rg1"), where the registry's escalation for
 * REFL_SENSOR_DUST applies (regroupRecurringDust). A real object that is a
 * property condition is never queued for removal (logged only); "uncertain"
 * with real CV contrast goes to a person as MINOR.
 */
export function p1bDrafts(value: P1bOutput, crops: P1bCrop[], ctx: { model: string; coerced: string[]; callIds: string[] }): { drafts: FindingDraft[]; logged: { cropId: string; photoId: string; verdict: string; note: string }[] } {
  const byId = new Map(crops.map((k) => [k.cropId, k]));
  const drafts: FindingDraft[] = [];
  const logged: { cropId: string; photoId: string; verdict: string; note: string }[] = [];
  for (const r of value.results) {
    const k = byId.get(r.cropId);
    if (!k) continue;
    const full = { w: k.fullW, h: k.fullH };
    const box = cropBoxToFull(r.refinedBbox as Box | null, k, full) ?? k.candidateBox;
    const mine = ctx.coerced.filter((s) => s.startsWith(`${k.cropId}`));
    const base = {
      photoId: k.photoId,
      photoIds: null,
      pass: "P1_PHOTO" as const,
      source: "P1B" as const,
      locationText: `around (${Math.round((box[0] + box[2]) / 2)}, ${Math.round((box[1] + box[3]) / 2)}) at full resolution`,
      bbox: box,
      isPermanentFeature: false,
      privacySensitive: false,
      reeditPrompt: null,
      arbitration: "NOT_REQUIRED" as const,
      contentHash: k.contentHash,
      promptId: "P1B_DUST",
      promptVersion: 1,
      model: ctx.model,
      coerced: mine,
      raw: { result: r, crop: { cropId: k.cropId, candidateIndex: k.candidateIndex, x0: k.x0, y0: k.y0, w: k.w, h: k.h, group: k.group, groupCount: k.groupCount }, callIds: ctx.callIds },
    };
    if (r.verdict === "isDust") {
      drafts.push({
        ...base,
        ruleId: "REFL_SENSOR_DUST",
        groupKey: "sensor-dust",
        specificIssue: "Sensor dust spot",
        explanation: stripLongDashes(r.note),
        severity: "MAJOR",
        confidence: r.confidence,
        responsibility: "PHOTOGRAPHER",
        postFixable: true,
        reshootMayBeNeeded: false,
        recommendedAction: "Remove the dust spot with a masked autoremove; clean the sensor before the next shoot.",
        fixStrategy: "AUTOREMOVE_MASK",
      });
    } else if (r.verdict === "uncertain" && k.depth >= UNCERTAIN_DUST_MIN_DEPTH) {
      drafts.push({
        ...base,
        ruleId: "REFL_DARK_SPOTS_FLAT_SURFACES",
        groupKey: "dark-spot-check",
        specificIssue: "Dark spot needs a look",
        explanation: stripLongDashes(r.note),
        severity: "MINOR",
        confidence: Math.min(r.confidence, 0.6),
        responsibility: "HUMAN_REVIEW",
        postFixable: true,
        reshootMayBeNeeded: false,
        recommendedAction: "Check whether this is dust or a mark on the property before fixing anything.",
        fixStrategy: "HUMAN_REVIEW",
      });
    } else {
      logged.push({ cropId: k.cropId, photoId: k.photoId, verdict: r.isPropertyCondition ? "property condition" : r.verdict, note: r.note });
    }
  }
  return { drafts, logged };
}

/** Dust spots P1 reported on a photo, merged with P1b's confirmed spots when
 *  their boxes overlap (IoU >= 0.3, 0.9): one finding per spot, P1b's refined
 *  box and the higher confidence. Returns the P1b drafts that remain new and
 *  the existing P1 findings to update. */
export const DUST_RULES = new Set(["REFL_SENSOR_DUST", "REFL_LENS_DUST", "REFL_DARK_SPOTS_FLAT_SURFACES", "REFL_SMALL_DUST_OVERLOOKED"]);
export function mergeDust<T extends { id: string; photoId: string | null; ruleId: string; bbox: Box | null; confidence: number }>(
  p1: T[],
  p1b: FindingDraft[],
  threshold = 0.3,
): { create: FindingDraft[]; update: { id: string; bbox: Box | null; confidence: number; note: string }[] } {
  const create: FindingDraft[] = [];
  const update: { id: string; bbox: Box | null; confidence: number; note: string }[] = [];
  const used = new Set<string>();
  for (const d of p1b) {
    if (d.ruleId !== "REFL_SENSOR_DUST") {
      create.push(d);
      continue;
    }
    let best: T | null = null;
    let bestIou = 0;
    for (const f of p1) {
      if (used.has(f.id) || f.photoId !== d.photoId || !DUST_RULES.has(f.ruleId)) continue;
      const v = iou(f.bbox, d.bbox);
      if (v >= threshold && v > bestIou) {
        best = f;
        bestIou = v;
      }
    }
    if (best) {
      used.add(best.id);
      update.push({ id: best.id, bbox: d.bbox, confidence: Math.max(best.confidence, d.confidence), note: `merged with a P1b dust confirmation (IoU ${bestIou.toFixed(2)})` });
    } else {
      create.push(d);
    }
  }
  return { create, update };
}

// ---- P2 -----------------------------------------------------------------------------------------

export type P2Ctx = {
  photoIds: Set<string>;
  dupPairs: Set<string>;
  rules: Map<string, InjectedRule>;
};

export function validateP2(raw: unknown, c: P2Ctx): Validation<P2Output> {
  const loose = P2Loose.safeParse(raw);
  if (!loose.success) return { ok: false, error: zodMessage(loose.error) };
  const coerced: string[] = [];
  const findings: P2Output["findings"] = [];
  loose.data.findings.forEach((f, k) => {
    const tag = `findings[${k}]`;
    let ruleId = f.ruleId;
    if (ruleId !== "OTHER_DEFECT" && !c.rules.has(ruleId)) {
      coerced.push(`${tag}.ruleId: ${ruleId.slice(0, 60)} is not an injected rule, set to OTHER_DEFECT`);
      ruleId = "OTHER_DEFECT";
    }
    const affected = [...new Set(f.affectedPhotoIds.filter((id) => c.photoIds.has(id)))];
    if (affected.length !== f.affectedPhotoIds.length) coerced.push(`${tag}.affectedPhotoIds: unknown or repeated ids dropped`);
    let ref = f.referencePhotoId && c.photoIds.has(f.referencePhotoId) ? f.referencePhotoId : null;
    if (f.referencePhotoId && !ref) coerced.push(`${tag}.referencePhotoId: unknown id, set to null`);
    const aff = ref ? affected.filter((id) => id !== ref) : affected;
    if (aff.length !== affected.length) coerced.push(`${tag}.affectedPhotoIds: the reference photo removed`);
    if (!aff.length) {
      coerced.push(`${tag}: dropped (no valid affected photo)`);
      return;
    }
    const rule = c.rules.get(ruleId);
    let severity = f.severity;
    if (rule && !allowedSeveritiesOf(rule).has(severity)) {
      coerced.push(`${tag}.severity: ${severity} outside the rule's range, set to ${rule.defaultSeverity}`);
      severity = rule.defaultSeverity;
    }
    let action = cleanText(f.recommendedAction, 400, `${tag}.recommendedAction`, coerced);
    if (!f.referenceCertain && !action.toLowerCase().includes(VERIFY_PHRASE)) {
      action = `${action.replace(/[.\s]+$/, "")}${action ? "; " : ""}${VERIFY_PHRASE}.`.slice(0, 400);
      coerced.push(`${tag}.recommendedAction: verify phrase appended`);
    }
    let groupKey = kebab(f.groupKey);
    if (groupKey !== f.groupKey) {
      groupKey = groupKey ?? kebab(rule?.groupKey) ?? "gallery-issue";
      coerced.push(`${tag}.groupKey: normalized to ${groupKey}`);
    }
    if (!ref && f.referencePhotoId) ref = null;
    findings.push({
      ruleId,
      issueType: f.issueType,
      groupKey: groupKey as string,
      affectedPhotoIds: aff,
      referencePhotoId: ref,
      referenceCertain: f.referenceCertain,
      explanation: cleanText(f.explanation, 800, `${tag}.explanation`, coerced),
      severity,
      confidence: clampConfidence(f.confidence, `${tag}.confidence`, coerced),
      fixStrategy: f.fixStrategy,
      responsibility: f.responsibility,
      recommendedAction: action,
    });
  });
  const duplicateReviews: P2Output["duplicateReviews"] = [];
  loose.data.duplicateReviews.forEach((d, k) => {
    const tag = `duplicateReviews[${k}]`;
    const ids = [...new Set(d.photoIds)];
    if (ids.length !== 2 || !c.dupPairs.has([...ids].sort().join("|"))) {
      coerced.push(`${tag}: dropped (not a candidate pair)`);
      return;
    }
    let keep = d.keepPhotoId;
    if (d.isDuplicate && (!keep || !ids.includes(keep))) {
      keep = ids[0];
      coerced.push(`${tag}.keepPhotoId: set to the first photo of the pair`);
    }
    if (!d.isDuplicate && keep) {
      keep = null;
      coerced.push(`${tag}.keepPhotoId: null for a non-duplicate`);
    }
    duplicateReviews.push({ photoIds: ids, reason: cleanText(d.reason, 300, `${tag}.reason`, coerced), isDuplicate: d.isDuplicate, keepPhotoId: keep });
  });
  const checks = sortedChecks(GALLERY_CHECKS, loose.data.checksPerformed, loose.data.checksSkipped, coerced);
  const value = { findings, duplicateReviews, checksPerformed: checks.performed as string[], checksSkipped: checks.skipped as { check: string; reason: string }[] };
  const strict = makeP2Schema(c).safeParse(value);
  if (!strict.success) return { ok: false, error: zodMessage(strict.error) };
  return { ok: true, value: strict.data, coerced };
}

export function p2Drafts(value: P2Output, ctx: { idOf: Map<string, string>; unit: string; model: string; coerced: string[]; callIds: string[]; exactPairs: Set<string>; dHashOf: Map<string, number> }): FindingDraft[] {
  const out: FindingDraft[] = [];
  value.findings.forEach((f, k) => {
    const ids = f.affectedPhotoIds.map((s) => ctx.idOf.get(s)).filter((x): x is string => !!x);
    if (!ids.length) return;
    const rule = ruleById(f.ruleId);
    out.push({
      photoId: ids.length === 1 ? ids[0] : null,
      photoIds: ids,
      ruleId: f.ruleId,
      groupKey: f.groupKey,
      pass: "P2_GALLERY",
      source: "P2",
      specificIssue: (rule?.shortLabel ?? f.issueType.replace(/_/g, " ").toLowerCase()).slice(0, 100),
      explanation: f.explanation,
      locationText: null,
      bbox: null,
      severity: f.severity,
      confidence: f.confidence,
      responsibility: f.responsibility,
      postFixable: !["RESHOOT", "HUMAN_REVIEW", "NONE"].includes(f.fixStrategy),
      reshootMayBeNeeded: f.fixStrategy === "RESHOOT",
      isPermanentFeature: false,
      privacySensitive: false,
      recommendedAction: f.recommendedAction,
      fixStrategy: f.fixStrategy,
      reeditPrompt: null,
      arbitration: "NOT_REQUIRED",
      contentHash: null,
      promptId: "P2_GALLERY",
      promptVersion: 1,
      model: ctx.model,
      coerced: ctx.coerced.filter((s) => s.startsWith(`findings[${k}]`)),
      raw: { finding: f, referencePhotoId: f.referencePhotoId ? ctx.idOf.get(f.referencePhotoId) ?? null : null, unit: ctx.unit, callIds: ctx.callIds },
    });
  });
  for (const d of value.duplicateReviews) {
    if (!d.isDuplicate || !d.keepPhotoId) continue;
    const ids = d.photoIds.map((s) => ctx.idOf.get(s)).filter((x): x is string => !!x);
    if (ids.length !== 2) continue;
    const pairKey = [...ids].sort().join("|");
    if (ctx.exactPairs.has(pairKey)) continue; // CV already filed the exact duplicate
    const keep = ctx.idOf.get(d.keepPhotoId) ?? ids[0];
    const drop = ids.find((x) => x !== keep) ?? ids[1];
    const keepLabel = d.keepPhotoId;
    const dropLabel = d.photoIds.find((s) => s !== d.keepPhotoId) ?? "";
    out.push({
      photoId: drop,
      photoIds: ids,
      ruleId: "GAL_NO_DUPLICATES",
      groupKey: `duplicate-${pairKey.replace(/[^a-z0-9|]/gi, "").replace("|", "-")}`.toLowerCase().slice(0, 60),
      pass: "P2_GALLERY",
      source: "P2",
      specificIssue: "Near-duplicate photo with no useful distinction",
      explanation: stripLongDashes(d.reason),
      locationText: null,
      bbox: null,
      severity: "MINOR",
      confidence: 0.8,
      responsibility: "ADMIN",
      postFixable: true,
      reshootMayBeNeeded: false,
      isPermanentFeature: false,
      privacySensitive: false,
      recommendedAction: `Exclude ${dropLabel} and keep ${keepLabel}.`,
      fixStrategy: "ADMIN_ACTION",
      reeditPrompt: null,
      arbitration: "NOT_REQUIRED",
      contentHash: null,
      promptId: "P2_GALLERY",
      promptVersion: 1,
      model: ctx.model,
      coerced: [],
      raw: { duplicateReview: d, keepPhotoId: keep, unit: ctx.unit },
    });
  }
  return out;
}

// ---- P4 -----------------------------------------------------------------------------------------

export type P4Ctx = {
  photoIds: Set<string>;
  /** Code-computed count items: authoritative status (6.4). */
  counts: Map<string, CoverageStatusT>;
  /** The rows inserted when the model leaves a count item out. */
  countItems: Map<string, { label: string; evidence: string; severityIfNotMet: Severity; responsibility: Responsibility }>;
};

const ITEM_KEY = /^(count|deliverable|standard|request|revision):[a-z0-9-]+$/;

export function validateP4(raw: unknown, c: P4Ctx): Validation<P4Output> {
  const loose = P4Loose.safeParse(raw);
  if (!loose.success) return { ok: false, error: zodMessage(loose.error) };
  const coerced: string[] = [];
  const seen = new Set<string>();
  const coverage: P4Output["coverage"] = [];
  loose.data.coverage.forEach((i, k) => {
    const tag = `coverage[${k}]`;
    let key = i.itemKey.trim().toLowerCase();
    if (!ITEM_KEY.test(key)) {
      const [prefix, ...rest] = key.split(":");
      const p = ["count", "deliverable", "standard", "request", "revision"].includes(prefix) ? prefix : "request";
      key = `${p}:${kebab(rest.join("-") || i.label) ?? "item"}`;
      coerced.push(`${tag}.itemKey: normalized to ${key}`);
    }
    if (seen.has(key)) {
      coerced.push(`${tag}: repeated itemKey ${key} dropped`);
      return;
    }
    seen.add(key);
    let status = i.status;
    const truth = c.counts.get(key);
    if (truth && truth !== status) {
      coerced.push(`${tag}.status: count item set to the computed ${truth}`);
      status = truth;
    }
    let severity = i.severity;
    if (status === "MET" && severity !== null) {
      severity = null;
      coerced.push(`${tag}.severity: null for MET`);
    } else if (status !== "MET" && severity === null) {
      severity = status === "UNKNOWN" ? "MAJOR" : ["ORDER_ITEM", "PRODUCT_EXPECTATION", "CLIENT_REQUEST"].includes(i.source) ? "CRITICAL" : "MAJOR";
      coerced.push(`${tag}.severity: missing, set to ${severity}`);
    }
    // Missing data is UNKNOWN and never a guess (6.2): an unknown can ask
    // for a decision, it cannot hold delivery.
    if (status === "UNKNOWN" && severity === "CRITICAL") {
      severity = "MAJOR";
      coerced.push(`${tag}.severity: UNKNOWN capped at MAJOR`);
    }
    const matched = [...new Set(i.matchedPhotoIds.filter((id) => c.photoIds.has(id)))];
    if (matched.length !== i.matchedPhotoIds.length) coerced.push(`${tag}.matchedPhotoIds: unknown ids dropped`);
    let evidence = cleanText(i.evidence, 400, `${tag}.evidence`, coerced);
    if (evidence.length < 5) {
      evidence = "No evidence given.";
      coerced.push(`${tag}.evidence: missing`);
    }
    coverage.push({
      itemKey: key,
      label: cleanText(i.label, 120, `${tag}.label`, coerced),
      source: (COVERAGE_SOURCES as readonly string[]).includes(i.source) ? i.source : "STANDARD_COVERAGE",
      evidence,
      matchedPhotoIds: matched,
      status,
      confidence: clampConfidence(i.confidence, `${tag}.confidence`, coerced),
      severity,
      responsibility: i.responsibility,
      recommendedAction: cleanText(i.recommendedAction, 300, `${tag}.recommendedAction`, coerced),
    });
  });
  for (const [key, status] of c.counts) {
    if (seen.has(key)) continue;
    const item = c.countItems.get(key);
    coverage.push({
      itemKey: key,
      label: item?.label ?? key,
      source: "PRODUCT_EXPECTATION",
      evidence: item?.evidence ?? "Computed by the hub.",
      matchedPhotoIds: [],
      status,
      confidence: 1,
      severity: status === "MET" ? null : status === "UNKNOWN" ? "MAJOR" : (item?.severityIfNotMet ?? "CRITICAL"),
      responsibility: item?.responsibility ?? "ADMIN",
      recommendedAction: status === "MET" ? "None." : "Check the order against the gallery.",
    });
    coerced.push(`coverage: count item ${key} inserted from code`);
  }
  const keys = new Set(coverage.map((i) => i.itemKey));
  const missing = loose.data.missingDeliverables
    .map((m) => ({ itemKey: m.itemKey.trim().toLowerCase(), label: cleanText(m.label, 120, "missingDeliverables.label", coerced), severity: m.severity, responsibility: m.responsibility }))
    .filter((m) => keys.has(m.itemKey));
  if (missing.length !== loose.data.missingDeliverables.length) coerced.push("missingDeliverables: items not in coverage dropped");
  const dataGaps = loose.data.dataGaps.map((g) => cleanText(g, 200, "dataGaps", coerced)).filter(Boolean);
  const value = { coverage, missingDeliverables: missing, dataGaps };
  const strict = makeP4Schema(c).safeParse(value);
  if (!strict.success) return { ok: false, error: zodMessage(strict.error) };
  return { ok: true, value: strict.data, coerced };
}

/** P4 has no rule ids in its answer; each coverage item maps to the registry
 *  rule that owns it, by its stable key. */
export function p4RuleFor(itemKey: string, source: string): string {
  const [kind, name = ""] = itemKey.split(":");
  const n = name.toLowerCase();
  if (kind === "count" || kind === "deliverable") {
    if (/photo/.test(n) && !/drone|aerial/.test(n)) return "ORD_PHOTO_COUNT";
    if (/drone|aerial/.test(n)) return "ORD_DRONE_INCLUDED";
    if (/twilight|dusk/.test(n)) return "ORD_TWILIGHT_INCLUDED";
    if (/stag/.test(n)) return "ORD_VIRTUAL_STAGING";
    if (/floor/.test(n)) return "ORD_FLOOR_PLAN";
    if (/communit|amenit/.test(n)) return "ORD_COMMUNITY_AMENITIES";
    return "ORD_ALL_SERVICES_COMPLETED";
  }
  if (kind === "standard") {
    if (/front|primary-exterior|curb/.test(n)) return "ORD_PRIMARY_EXTERIOR";
    if (/rear|back/.test(n)) return "ORD_REAR_EXTERIOR";
    if (/kitchen/.test(n)) return "ORD_KITCHEN";
    if (/living|family|great/.test(n)) return "ORD_MAIN_LIVING";
    if (/bed/.test(n)) return "ORD_BEDROOMS";
    if (/bath|powder/.test(n)) return "ORD_BATHROOMS";
    if (/dining/.test(n)) return "ORD_DINING";
    if (/laundry/.test(n)) return "ORD_LAUNDRY";
    if (/basement|lower/.test(n)) return "ORD_FINISHED_BASEMENT";
    if (/outdoor|patio|deck|yard|pool/.test(n)) return "ORD_OUTDOOR_LIVING";
    return "ORD_REQUIRED_ROOMS";
  }
  if (kind === "revision") return "ORD_RESHOOT_SCOPE";
  return source === "SPECIAL_INSTRUCTION" ? "ORD_SPECIALTY_ANGLES" : "ORD_CLIENT_REQUESTED_FEATURES";
}

/** Every NOT_MET or UNKNOWN coverage item becomes a P4_ORDER finding (6.4). */
export function p4Drafts(value: P4Output, ctx: { idOf: Map<string, string>; model: string; coerced: string[]; callIds: string[] }): FindingDraft[] {
  return value.coverage
    .filter((i) => i.status !== "MET")
    .map((i): FindingDraft => {
      const ruleId = p4RuleFor(i.itemKey, i.source);
      const ids = i.matchedPhotoIds.map((s) => ctx.idOf.get(s)).filter((x): x is string => !!x);
      return {
        photoId: null,
        photoIds: ids.length ? ids : null,
        ruleId,
        groupKey: `order-${i.itemKey.replace(":", "-")}`.slice(0, 60),
        pass: "P4_ORDER",
        source: "P4",
        specificIssue: `${i.status === "UNKNOWN" ? "Unconfirmed" : "Missing"}: ${i.label}`.slice(0, 100),
        explanation: i.evidence,
        locationText: null,
        bbox: null,
        severity: (i.severity ?? "MAJOR") as Severity,
        confidence: i.confidence,
        responsibility: i.responsibility,
        postFixable: false,
        reshootMayBeNeeded: i.status === "NOT_MET" && i.responsibility === "PHOTOGRAPHER",
        isPermanentFeature: false,
        privacySensitive: false,
        recommendedAction: i.recommendedAction,
        fixStrategy: i.status === "UNKNOWN" ? "HUMAN_REVIEW" : "ADMIN_ACTION",
        reeditPrompt: null,
        arbitration: "NOT_REQUIRED",
        contentHash: null,
        promptId: "P4_ORDER",
        promptVersion: 1,
        model: ctx.model,
        coerced: ctx.coerced.filter((s) => s.includes(i.itemKey)),
        raw: { item: i, callIds: ctx.callIds },
      };
    });
}

// ---- Delivery Summary ------------------------------------------------------------------------------

export function validateSummary(raw: unknown, stats: { status: string; photoCount: number }): Validation<SummaryOutput> {
  const loose = SummaryLoose.safeParse(raw);
  if (!loose.success) return { ok: false, error: zodMessage(loose.error) };
  const coerced: string[] = [];
  let lines = loose.data.lines.map((l, k) => cleanText(l.replace(/^[*#>-]\s+/, ""), 160, `lines[${k}]`, coerced)).filter(Boolean);
  const link = `Report: ${QC_LINK_TOKEN}`;
  if (lines[lines.length - 1] !== link) {
    lines = [...lines.filter((l) => !l.startsWith("Report:")), link];
    coerced.push("lines: report line placed last");
  }
  if (lines.length > 6) {
    lines = [...lines.slice(0, 5), link];
    coerced.push("lines: cut to 6");
  }
  const strict = makeSummarySchema(stats).safeParse({ lines });
  if (!strict.success) return { ok: false, error: zodMessage(strict.error) };
  return { ok: true, value: strict.data, coerced };
}

// ---- CV and failure rows ------------------------------------------------------------------------------

export function cvIssueDraft(i: CvIssue, ctx: { photoId: string; contentHash: string }): FindingDraft {
  const rule = ruleById(i.ruleId) as QcRule | undefined;
  return {
    photoId: ctx.photoId,
    photoIds: null,
    ruleId: i.ruleId,
    groupKey: kebab(rule?.groupKey) ?? kebab(i.ruleId) ?? "file-check",
    pass: "P1_PHOTO",
    source: i.ruleId === "COMP_BLURRY" ? "CV" : "FILE",
    specificIssue: i.specificIssue,
    explanation: i.explanation,
    locationText: null,
    bbox: null,
    severity: i.severity,
    confidence: i.confidence,
    responsibility: rule?.responsibility ?? "ADMIN",
    postFixable: rule ? rule.postFixable !== "NO" : true,
    reshootMayBeNeeded: !!rule?.reshootPossible,
    isPermanentFeature: false,
    privacySensitive: false,
    recommendedAction: i.recommendedAction,
    fixStrategy: (rule?.fixStrategies[0] ?? "ADMIN_ACTION") as FixStrategy,
    reeditPrompt: null,
    arbitration: "NOT_REQUIRED",
    contentHash: ctx.contentHash,
    promptId: null,
    promptVersion: null,
    model: null,
    coerced: [],
    raw: { cv: i },
  };
}

/** 0.7.1: a refused (or twice-invalid) pass becomes one finding a person
 *  must look at, and every check of that pass is recorded as skipped. */
export function unavailableDraft(ctx: { photoId: string | null; photoIds?: string[] | null; contentHash: string | null; pass: FindingDraft["pass"]; source: FindingDraft["source"]; promptId: string | null; model: string | null; reason: string; what: string }): FindingDraft {
  return {
    photoId: ctx.photoId,
    photoIds: ctx.photoIds ?? null,
    ruleId: "OTHER_DEFECT",
    groupKey: `inspection-unavailable-${ctx.source.toLowerCase()}`,
    pass: ctx.pass,
    source: ctx.source,
    specificIssue: "Automated inspection unavailable",
    explanation: stripLongDashes(`${ctx.what}: ${ctx.reason}`).slice(0, 600),
    locationText: null,
    bbox: null,
    severity: "MAJOR",
    confidence: 1,
    responsibility: "HUMAN_REVIEW",
    postFixable: false,
    reshootMayBeNeeded: false,
    isPermanentFeature: false,
    privacySensitive: false,
    recommendedAction: "Check this by hand; the automated pass could not.",
    fixStrategy: "HUMAN_REVIEW",
    reeditPrompt: null,
    arbitration: "NOT_REQUIRED",
    contentHash: ctx.contentHash,
    promptId: ctx.promptId,
    promptVersion: ctx.promptId ? 1 : null,
    model: ctx.model,
    coerced: [],
    raw: { reason: ctx.reason },
  };
}
