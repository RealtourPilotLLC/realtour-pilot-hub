import "server-only";
import { prisma } from "@/lib/prisma";
import { runAiJson, activePolicyVersion } from "@/lib/aiRuns";
import { timeoutBefore } from "@/lib/integrations/ai";
import { approvedStrategy } from "@/lib/contentStrategy";
import { factsForPrompt, factLines, CONFIDENTIAL_RE } from "@/lib/clientFacts";
import {
  CREATIVE_IDENTITY_KEY, CREATIVE_IDENTITY_SCHEMA, creativeIdentityFromOverrides, normalizeCreativeIdentity, videoStyleFromOverrides,
  type StoredCreativeIdentity, type StrategyDocument,
} from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// CREATIVE IDENTITY, AUTOMATIC (Oct 14 2026).
//
// Jordan: "The personality profile should be automatically created and
// approved based on their content strategy, brand voice, and brand message."
//
// deriveCreativeIdentity(enrollmentId) makes ONE model call (kind
// creative_identity; ai_runs-gated when unattended, like every other run)
// from the APPROVED strategy (brand voice, brand message, core values,
// audience, pillars, strategic direction), the account's video style and
// ACCEPTED non-confidential facts, and stores the answer on
// ContentEnrollment.overridesJson.creativeIdentity, approvedBy "auto". There
// is no review step. It is re-derived when a new strategy version is approved
// (the approve action, best effort) and by the 15-minute AI cron for any
// active client whose identity is missing or was built from an older
// strategy version. Every monthly script, topic-bank and revise prompt
// carries it (contentPolicy/creativeIdentity.ts, CREATIVE IDENTITY block).
//
// Never inferred from demographics; boundaries and interests only from what
// the strategy or the facts say. Monthly personal-brand program only.
// ---------------------------------------------------------------------------

const SYSTEM = `You build a short creative identity for ONE real estate agent's monthly personal-brand videos at Realtour Pilot: how funny they are on camera, how much acting they are comfortable with, their energy, their tone, and what they will and will not do.

RULES (mandatory):
- Use ONLY the approved strategy, the account's video style and the accepted facts below. Never infer anything from age, gender, ethnicity, religion, family status or any other demographic or protected characteristic.
- boundaries and interests come only from the strategy or the facts. Never invent one. An empty list is a correct answer.
- Tag every list item: basis "stated" when the strategy or a fact says it, "inferred" when it is your suggestion from them; source names where it comes from (a strategy section such as Brand Voice or Core Values, or "fact").
- comedyComfort "full_skits" only when the video style is SKITS or a fact says the client wants acted skits.
- humorStyle "none" when the strategy gives no sign of humour; never push a client toward jokes they did not ask for.
- toneWords: 3 to 5 plain words.
- Plain language; do not use em dashes.

OUTPUT: one JSON object matching the schema.`;

function strategyLines(doc: StrategyDocument): string[] {
  const b = doc.brandOverview, a = doc.targetAudience;
  const out: string[] = [];
  const add = (label: string, v: string | null | undefined) => { if (v && v.trim()) out.push(`${label}: ${v.trim()}`); };
  add("Brand Voice", b.brandVoice);
  add("Brand Message", b.brandMessage);
  add("Short Brand Statement", b.shortBrandStatement);
  add("Core Values", b.coreValues);
  add("Primary Client Types", a.primaryClientTypes);
  add("Primary Service Areas", a.primaryServiceAreas);
  add("Long-term Positioning Goal", a.longTermPositioningGoal);
  for (const p of doc.contentPillars.pillars) add(`Pillar: ${p.name}`, [p.purpose, p.focusAreas].filter(Boolean).join(" Focus: "));
  if (doc.strategicDirection?.paragraphs.length) add("Strategic Direction", doc.strategicDirection.paragraphs.join(" "));
  return out;
}

export type DeriveResult = { ok: true; identity: StoredCreativeIdentity; runId: string } | { ok: false; reason: string };

/** One model call; the stored, auto-approved identity. Other override keys are kept (compare-and-swap on the bag). */
export async function deriveCreativeIdentity(enrollmentId: string, opts: { requestedBy: string; unattended: boolean; /** The sweep's clock (ms epoch): the model call ends by it (audit H1). */ deadline?: number | null }): Promise<DeriveResult> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
  if (!e) return { ok: false, reason: "Enrollment not found." };
  const strategy = await approvedStrategy(enrollmentId);
  if (!strategy?.document) return { ok: false, reason: "No approved strategy yet: the creative identity is built from it." };
  const style = videoStyleFromOverrides(e.overridesJson);
  const { scrubOtherClients } = await import("@/lib/contentGeneration");
  const facts = (await scrubOtherClients(e.clientId, factLines(await factsForPrompt(e.clientId, { take: 40 })))).kept.filter((f) => !CONFIDENTIAL_RE.test(f));
  const client = await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } });
  const policy = await activePolicyVersion();
  const prompt = [
    `CLIENT: ${client?.name ?? "Client"} (id ${e.clientId})`,
    `VIDEO STYLE: ${style === "SKITS" ? "SKITS (the account is set to acted skits)" : style === "MIX" ? "MIX (mostly talking to camera, plus a few acted skits a month)" : "DIRECT (talking to camera)"}`,
    "",
    `APPROVED STRATEGY (${strategy.label}):`,
    ...strategyLines(strategy.document).map((l) => `- ${l}`),
    "",
    facts.length ? "ACCEPTED FACTS:" : "ACCEPTED FACTS: none on file.",
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
  const run = await runAiJson<Record<string, unknown>>({
    kind: "creative_identity", enrollmentId, clientId: e.clientId, scope: { strategyVersionId: strategy.versionId }, inputRefs: { strategyVersionId: strategy.versionId, facts: facts.length, videoStyle: style },
    promptKey: "creative-identity", promptVersion: "identity.v1", policyVersionId: policy.id, strategyVersionId: strategy.versionId,
    requestedBy: opts.requestedBy, unattended: opts.unattended, dedupeKey: `identity:${enrollmentId}`,
    system: SYSTEM, prompt, schema: CREATIVE_IDENTITY_SCHEMA, maxTokens: 1500, timeoutMs: timeoutBefore(opts.deadline, 1500),
  });
  // Oct 22 2026: a Mix account films some acted skits, so full skits are allowed (not forced).
  const ci = normalizeCreativeIdentity(run.output, { skitsAccount: style === "SKITS", factSaysSkits: style === "MIX" || facts.some((f) => /\bskits?\b/i.test(f)) });
  const now = new Date().toISOString();
  const stored: StoredCreativeIdentity = { ...ci, strategyVersionId: strategy.versionId, derivedAt: now, approvedAt: now, approvedBy: "auto", runId: run.runId };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
    let bag: Record<string, unknown> = {};
    try { bag = cur?.overridesJson ? (JSON.parse(cur.overridesJson) as Record<string, unknown>) : {}; } catch { bag = {}; }
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) bag = {};
    const w = await prisma.contentEnrollment.updateMany({ where: { id: enrollmentId, overridesJson: cur?.overridesJson ?? null }, data: { overridesJson: JSON.stringify({ ...bag, [CREATIVE_IDENTITY_KEY]: stored }) } });
    if (w.count) return { ok: true, identity: stored, runId: run.runId };
  }
  return { ok: false, reason: "The client file kept changing while saving; try again." };
}

/** Is this enrollment's identity missing, or built from a strategy version that is no longer the approved one? */
export async function creativeIdentityStale(enrollmentId: string): Promise<boolean> {
  const [e, s] = await Promise.all([
    prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } }),
    prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { id: true } }),
  ]);
  if (!s) return false;
  const ci = creativeIdentityFromOverrides(e?.overridesJson ?? null);
  return !ci || ci.strategyVersionId !== s.id;
}

/**
 * The cron's half: a few active enrollments (not client-planned) with an
 * approved strategy whose identity is missing or stale, each started only
 * with the time to finish it.
 */
export async function sweepCreativeIdentities(opts: { max?: number; budgetMs?: number; minStartMs?: number } = {}): Promise<{ derived: number; failed: number; waiting: number; outOfTime: boolean }> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 60_000);
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE", clientSuppliesTopics: false }, select: { id: true, overridesJson: true } });
  const approved = live.length ? await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: { in: live.map((e) => e.id) }, status: "APPROVED" }, select: { id: true, enrollmentId: true, versionNo: true } }) : [];
  const newest = new Map<string, { id: string; versionNo: number }>();
  for (const v of approved) { const cur = newest.get(v.enrollmentId); if (!cur || v.versionNo > cur.versionNo) newest.set(v.enrollmentId, v); }
  const stale = live.filter((e) => { const s = newest.get(e.id); if (!s) return false; const ci = creativeIdentityFromOverrides(e.overridesJson); return !ci || ci.strategyVersionId !== s.id; }).map((e) => e.id);
  // A client whose last attempt failed waits six hours, so one bad answer is not paid for every quarter hour.
  const recentFail = new Set(stale.length ? (await prisma.programAiRun.findMany({ where: { kind: "creative_identity", status: "FAILED", enrollmentId: { in: stale }, createdAt: { gte: new Date(started - 6 * 3600_000) } }, select: { enrollmentId: true } })).map((r) => r.enrollmentId) : []);
  const due = stale.filter((id) => !recentFail.has(id));
  let derived = 0, failed = 0, outOfTime = false;
  for (const id of due.slice(0, opts.max ?? 3)) {
    if (deadline - Date.now() < (opts.minStartMs ?? 45_000)) { outOfTime = true; break; }
    try {
      const r = await deriveCreativeIdentity(id, { requestedBy: "cron", unattended: true, deadline });
      if (r.ok) derived++; else failed++;
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "AutomationDisabledError" || name === "QuotaExceededError") break;
      failed++;
    }
  }
  return { derived, failed, waiting: Math.max(0, due.length - derived), outOfTime };
}

/** Every active enrollment with an approved strategy, now (for the live run after deploy). Attended: a person runs it. */
export async function deriveAllCreativeIdentities(opts: { requestedBy?: string; onlyStale?: boolean } = {}): Promise<{ enrollmentId: string; ok: boolean; reason?: string }[]> {
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE", clientSuppliesTopics: false }, select: { id: true } });
  const out: { enrollmentId: string; ok: boolean; reason?: string }[] = [];
  for (const e of live) {
    if (opts.onlyStale && !(await creativeIdentityStale(e.id))) continue;
    try {
      const r = await deriveCreativeIdentity(e.id, { requestedBy: opts.requestedBy ?? "creative-identity-backfill", unattended: false });
      out.push(r.ok ? { enrollmentId: e.id, ok: true } : { enrollmentId: e.id, ok: false, reason: r.reason });
    } catch (err) {
      out.push({ enrollmentId: e.id, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
