import "server-only";

import { prisma } from "@/lib/prisma";
import { ruleById, STRATEGY_TRANSFORM, type FixStrategy, type Severity } from "./registry";
import { photoDeliverySettings } from "./settings";
import { creditThresholds, creditView } from "./credits";
import { logJobEvent, setStage } from "./jobState";

// ---------------------------------------------------------------------------
// THE FIX CART (docs/photo-delivery/01 §8). Open findings that a credit
// transform can fix become cart lines, priced from AutoHDR's LIVE catalogue
// (listCapabilities / listModels, cached an hour). Nothing here guesses a
// price: when the catalogue cannot be read the line says "price unknown" and
// the Run button stays disabled.
//
// Three ways to decide, exactly as Jordan asked: Fix all, Ignore (per item,
// per group, all Minor), Select (checkboxes, then Run selected). Kyle (ADMIN)
// may approve up to settings.adminCreditCap credits per batch; above that it
// needs Jordan. Pre-flight: the balance must cover the estimate.
//
// Never automatic: reshoots, a fix on a permanent feature, privacy findings,
// color-truth calls. Those lines are shown as "needs your call".
// ---------------------------------------------------------------------------

export type CartLine = {
  findingIds: string[];
  photoId: string | null;
  photoName: string | null;
  ruleId: string;
  label: string;
  specificIssue: string;
  severity: Severity;
  confidence: number;
  strategy: FixStrategy;
  transform: string | null;
  /** null = the live price could not be read */
  credits: number | null;
  /** Why this line cannot run automatically, when it cannot. */
  humanCall: null | "permanent-feature" | "privacy" | "color-truth" | "reshoot" | "editor" | "review" | "no-autohdr";
  selectedByDefault: boolean;
  /** Oct 14 2026: an ordered add-on (virtual twilight, staging, declutter, twilight look): its transform settings. */
  params?: Record<string, unknown> | null;
  addOn?: boolean;
};

export type FixCart = {
  jobId: string;
  lines: CartLine[];
  estimatedCredits: number | null;
  usdPerCredit: number;
  balance: number | null;
  autohdrConnected: boolean;
  /** The AutoHDR shoot this job's photos belong to (found by folder name). */
  photoshootLinked: boolean;
  adminCap: number;
  blockers: string[];
};

const HUMAN: Partial<Record<FixStrategy, CartLine["humanCall"]>> = {
  RESHOOT: "reshoot",
  EDITOR_MANUAL: "editor",
  HUMAN_REVIEW: "review",
  ADMIN_ACTION: "review",
  NONE: "review",
  REVERT_VERSION: "review",
};

/** Live price of a transform (credits), from the cached catalogue. */
export async function transformPrice(transform: string): Promise<number | null> {
  try {
    const { capabilityCatalog } = await import("./catalog");
    const cat = await capabilityCatalog();
    const hit = cat?.find((c) => c.name === transform);
    return typeof hit?.credit_cost === "number" ? hit.credit_cost : null;
  } catch {
    return null;
  }
}

/**
 * The strategy a finding can actually use: the model's pick if AutoHDR's live
 * catalogue offers its transform, else the rule's next listed strategy that it
 * does. (Oct 14 live read: the API has no camera_removal, so a reflection
 * falls back to autoremove with a mask or a reedit prompt.) Non-credit
 * strategies (editor, reshoot, review) pass through untouched.
 */
export function resolveStrategy(preferred: FixStrategy, ruleStrategies: FixStrategy[], offered: Set<string> | null, hasBox: boolean, hasPrompt: boolean): FixStrategy {
  const usable = (s: FixStrategy) => {
    const t = STRATEGY_TRANSFORM[s];
    if (!t) return true;
    if (!offered || !offered.has(t)) return false;
    if (s === "AUTOREMOVE_MASK" && !hasBox) return false; // a mask needs a box
    if (s === "REEDIT_PROMPT" && !hasPrompt) return false;
    if (s === "STYLE_RERENDER") return false; // needs a chosen model: a person's call
    return true;
  };
  if (usable(preferred)) return preferred;
  for (const s of ruleStrategies) if (s !== preferred && STRATEGY_TRANSFORM[s] && usable(s)) return s;
  return STRATEGY_TRANSFORM[preferred] ? "HUMAN_REVIEW" : preferred;
}

export async function buildFixCart(jobId: string): Promise<FixCart> {
  const [job, settings, credits, thresholds] = await Promise.all([
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, autohdrPhotoshootId: true } }),
    photoDeliverySettings(),
    creditView().catch(() => null),
    creditThresholds(),
  ]);
  if (!job) throw new Error("Photo job not found.");
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, status: "OPEN", severity: { in: ["CRITICAL", "MAJOR", "MINOR"] } },
    select: { id: true, photoId: true, ruleId: true, specificIssue: true, severity: true, confidence: true, fixStrategy: true, postFixable: true, isPermanentFeature: true, privacySensitive: true, groupKey: true, bboxJson: true, reeditPrompt: true, source: true, coercedJson: true },
  });
  const photos = await prisma.photoAsset.findMany({ where: { jobId }, select: { id: true, name: true } });
  const nameOf = new Map(photos.map((p) => [p.id, p.name]));
  const { capabilityCatalog } = await import("./catalog");
  const catalog = await capabilityCatalog().catch(() => null);
  const offered = catalog ? new Set(catalog.map((c) => c.name)) : null;
  const lines: CartLine[] = [];
  for (const f of findings) {
    if (f.confidence < settings.displayConfidenceFloor) continue; // low confidence never enters the cart
    const rule = ruleById(f.ruleId);
    if (f.source === "ADDON") {
      // An ordered add-on, suggested at QC: one click, never selected by default.
      const strategy = (rule?.fixStrategies[0] ?? "HUMAN_REVIEW") as FixStrategy;
      const transform = STRATEGY_TRANSFORM[strategy] ?? null;
      let params: Record<string, unknown> | null = null;
      try { params = (JSON.parse(f.coercedJson ?? "{}") as { params?: Record<string, unknown> }).params ?? null; } catch { params = null; }
      let credits: number | null = transform ? await transformPrice(transform) : null;
      if (transform === "style") {
        const { modelCatalog } = await import("./catalog");
        credits = (await modelCatalog().catch(() => null))?.find((m) => m.id === params?.model_id)?.style_credit_cost ?? null;
      }
      const humanCall: CartLine["humanCall"] = !transform || (offered && !offered.has(transform)) ? "review" : !job.autohdrPhotoshootId ? "no-autohdr" : null;
      lines.push({ findingIds: [f.id], photoId: f.photoId, photoName: f.photoId ? nameOf.get(f.photoId) ?? null : null, ruleId: f.ruleId, label: rule?.shortLabel ?? f.ruleId, specificIssue: f.specificIssue, severity: f.severity as Severity, confidence: f.confidence, strategy, transform, credits: humanCall ? 0 : credits, humanCall, selectedByDefault: false, params, addOn: true });
      continue;
    }
    const strategy = resolveStrategy(f.fixStrategy as FixStrategy, (rule?.fixStrategies ?? []) as FixStrategy[], offered, !!f.bboxJson, !!f.reeditPrompt);
    const transform = STRATEGY_TRANSFORM[strategy] ?? null;
    let humanCall: CartLine["humanCall"] = HUMAN[strategy] ?? null;
    if (f.isPermanentFeature || rule?.permanentFeatureRisk) humanCall = "permanent-feature";
    if (f.privacySensitive) humanCall = "privacy";
    if (/COLOR_|_COLOR|NAVY/.test(f.ruleId) && strategy === "HUMAN_REVIEW") humanCall = "color-truth";
    if (!humanCall && transform && !job.autohdrPhotoshootId) humanCall = "no-autohdr";
    const price = transform && !humanCall ? await transformPrice(transform) : null;
    lines.push({
      findingIds: [f.id],
      photoId: f.photoId,
      photoName: f.photoId ? nameOf.get(f.photoId) ?? null : null,
      ruleId: f.ruleId,
      label: rule?.shortLabel ?? f.ruleId,
      specificIssue: f.specificIssue,
      severity: f.severity as Severity,
      confidence: f.confidence,
      strategy,
      transform,
      credits: humanCall ? 0 : price,
      humanCall,
      selectedByDefault: !humanCall && f.postFixable,
    });
  }
  const runnable = lines.filter((l) => !l.humanCall);
  const unknown = runnable.some((l) => l.credits == null);
  const estimatedCredits = unknown ? null : runnable.filter((l) => l.selectedByDefault).reduce((s, l) => s + (l.credits ?? 0), 0);
  const blockers: string[] = [];
  if (!settings.fixRunnerEnabled) blockers.push("AutoHDR fixes are switched off until Jordan approves the first live test (Photo Delivery settings).");
  if (!credits?.connected) blockers.push("The AutoHDR API is not connected (Connections → AutoHDR).");
  else if (!job.autohdrPhotoshootId) blockers.push("This job's AutoHDR shoot has not been found yet, so fixes cannot run on it.");
  if (unknown && runnable.length) blockers.push("AutoHDR's price list could not be read, so the cost is unknown.");
  return {
    jobId,
    lines,
    estimatedCredits,
    usdPerCredit: thresholds.usdPerCredit,
    balance: credits?.balance ?? null,
    autohdrConnected: !!credits?.connected,
    photoshootLinked: !!job.autohdrPhotoshootId,
    adminCap: settings.adminCreditCap,
    blockers,
  };
}

export type ApproveResult = { ok: true; batchId: string; operations: number; estimatedCredits: number } | { ok: false; message: string };

/**
 * Approve a fix batch. Writes the batch and its operations (QUEUED) and moves
 * the job to FIXING; the cron runs them one per photo, in order. Nothing is
 * submitted to AutoHDR from here.
 */
export async function approveFixBatch(input: { jobId: string; findingIds: string[]; mode: "ALL" | "SELECTED" | "CRITICAL_MAJOR_ONLY"; by: string; role: string }): Promise<ApproveResult> {
  const cart = await buildFixCart(input.jobId);
  if (cart.blockers.length) return { ok: false, message: cart.blockers[0] };
  const chosen = new Set(input.findingIds);
  const lines = cart.lines.filter((l) => !l.humanCall && l.findingIds.some((id) => chosen.has(id)) && (input.mode !== "CRITICAL_MAJOR_ONLY" || l.severity !== "MINOR"));
  if (!lines.length) return { ok: false, message: "Nothing selected can be fixed automatically." };
  if (lines.some((l) => l.credits == null)) return { ok: false, message: "A price could not be read from AutoHDR, so nothing was started." };
  const estimate = lines.reduce((s, l) => s + (l.credits ?? 0), 0);
  if (input.role !== "OWNER" && estimate > cart.adminCap) return { ok: false, message: `This batch is ${estimate} credits, above the ${cart.adminCap}-credit approval limit. Jordan needs to approve it.` };
  if (cart.balance != null && cart.balance < estimate) return { ok: false, message: `The AutoHDR balance (${cart.balance}) is below this batch's estimate (${estimate}). Top up first.` };
  const batch = await prisma.$transaction(async (tx) => {
    const b = await tx.photoFixBatch.create({
      data: {
        jobId: input.jobId,
        mode: input.mode,
        estimatedCredits: estimate,
        estimatedUsdCents: Math.round(estimate * cart.usdPerCredit * 100),
        balanceBefore: cart.balance,
        approvedBy: input.by,
        status: "PENDING",
      },
    });
    // Operations per photo in a stable order: style re-renders first (they
    // start from the originals and drop earlier edits), then removals, then
    // prompt edits.
    const order: Record<string, number> = { STYLE_RERENDER: 0, CAMERA_REMOVAL: 1, AUTOREMOVE_MASK: 2, DECLUTTER: 3, GRASS: 4, REEDIT_PROMPT: 5 };
    const byPhoto = new Map<string, CartLine[]>();
    for (const l of lines) {
      const k = l.photoId ?? "_";
      byPhoto.set(k, [...(byPhoto.get(k) ?? []), l]);
    }
    let count = 0;
    for (const [photoId, ls] of byPhoto) {
      ls.sort((a, b) => (order[a.strategy] ?? 9) - (order[b.strategy] ?? 9));
      // One autoremove per photo with every removable region merged into one
      // mask (plan §8.2: the cheapest safe sequence).
      const merged: CartLine[] = [];
      for (const l of ls) {
        const prev = merged.find((m) => m.strategy === l.strategy && (l.strategy === "AUTOREMOVE_MASK" || l.strategy === "CAMERA_REMOVAL" || l.strategy === "DECLUTTER"));
        if (prev) prev.findingIds = [...prev.findingIds, ...l.findingIds];
        else merged.push({ ...l, findingIds: [...l.findingIds] });
      }
      let seq = 0;
      for (const l of merged) {
        await tx.photoFixOperation.create({
          data: {
            batchId: b.id,
            jobId: input.jobId,
            photoId,
            findingIdsJson: JSON.stringify(l.findingIds),
            seq: seq++,
            strategy: l.strategy,
            transformName: l.transform,
            estimatedCredits: l.credits ?? 0,
            paramsJson: l.params ? JSON.stringify(l.params) : null,
            status: "QUEUED",
          },
        });
        count++;
      }
    }
    await tx.photoQcFinding.updateMany({ where: { id: { in: lines.flatMap((l) => l.findingIds) } }, data: { status: "APPROVED_FIX", decidedBy: input.by, decidedAt: new Date() } });
    return { id: b.id, count };
  });
  await setStage(input.jobId, ["QC_REVIEW", "READY", "ON_HOLD", "REVISION_REQUESTED"], "FIXING", input.by, { why: `fix batch approved (${batch.count} fixes, est. ${estimate} credits)` });
  await logJobEvent(input.jobId, input.by, "fix batch approved", { batchId: batch.id, estimate, mode: input.mode });
  return { ok: true, batchId: batch.id, operations: batch.count, estimatedCredits: estimate };
}
