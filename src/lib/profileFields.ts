import "server-only";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import {
  PROFILE_SLOTS, getSlot, setProfileSlotTx, sameSlotValue, slotLockKey, alertBrandChanges, type SlotKey,
} from "@/lib/brandProfile";
import { CONFIDENTIAL_RE, acceptFact, createFact, type FactCategory } from "@/lib/clientFacts";
import { clip } from "@/lib/text";
import type { StoredSections } from "@/lib/contentStrategy";

// ---------------------------------------------------------------------------
// CALL KNOWLEDGE → A PERSON'S CHANGE (completion audit CP-11, Sep 24 2026).
//
// Two acts that used to be one, and one that did not exist:
//   · REMEMBER — accepting a ClientFact (clientFacts.acceptFact). It feeds
//     generation, and production preferences reach the editor's brief. It
//     never changes the profile.
//   · APPLY THIS CHANGE — a ContentStrategyProposal of kind PROFILE that names
//     its target (`profile.music`, …), the value it was proposed against and
//     the value proposed, the call it came from and the fact behind it.
//     Applying is always a person's act (Jordan or Kyle): a new version of the
//     slot, history intact, the proposal stamped with who/when/notes, and the
//     editor told through the CP-06 pipeline (banner, Kyle's task, the DM when
//     that switch is on). Ignoring it changes nothing.
//   · STRATEGY changes stay section-specific: a call's proposal names the
//     section it changes and the replacement text for THAT section only, and
//     accepting it drafts a new strategy version with that one section
//     replaced (contentStrategy.acceptStrategyProposal), which Jordan approves
//     and releases as ever. Nothing here regenerates a strategy.
//
// Confidential knowledge never travels this path: a confidential fact makes
// no proposal, a proposal whose fact is later marked confidential cannot be
// applied, and a strategy proposal the model marks confidential becomes a
// locked INTERNAL fact instead of a proposal anyone could release.
//
// Client-owned free text (portalVideoStyle / portalPreferences) is
// deliberately NOT a target: a call extract never overwrites the client's own
// words. The client's structured slots (music, fonts, website, social) are
// targets because they are single values a person can confirm.
// ---------------------------------------------------------------------------

export const PROFILE_TARGETS = {
  "profile.music": { slot: "music", factKeys: ["editing.music", "brand.music", "production.music"] },
  "profile.fonts": { slot: "fonts", factKeys: ["brand.fonts", "brand.font"] },
  "profile.website": { slot: "website", factKeys: ["brand.website", "contact.website"] },
  "profile.social": { slot: "social", factKeys: ["brand.social", "contact.social"] },
  "profile.editing.pace": { slot: "editing.pace", factKeys: ["editing.pace"] },
  "profile.editing.captions": { slot: "editing.captions", factKeys: ["editing.captions"] },
  "profile.production.wardrobe": { slot: "production.wardrobe", factKeys: ["production.wardrobe"] },
  "profile.production.teleprompter": { slot: "production.teleprompter", factKeys: ["production.teleprompter"] },
  "profile.production.location": { slot: "production.location", factKeys: ["production.location_preference", "production.location"] },
  "profile.production.days": { slot: "production.days", factKeys: ["production.preferred_days", "production.days"] },
} as const satisfies Record<string, { slot: SlotKey; factKeys: readonly string[] }>;
export type ProfileTargetKey = keyof typeof PROFILE_TARGETS;
export const isProfileTarget = (k: unknown): k is ProfileTargetKey => typeof k === "string" && k in PROFILE_TARGETS;
export const targetLabel = (k: ProfileTargetKey): string => PROFILE_SLOTS[PROFILE_TARGETS[k].slot].label;

/** The profile field a fact's fieldKey changes, or null (most facts change nothing). */
export function targetForFieldKey(fieldKey: string | null | undefined): ProfileTargetKey | null {
  const k = (fieldKey ?? "").trim().toLowerCase();
  if (!k) return null;
  for (const [target, def] of Object.entries(PROFILE_TARGETS)) if ((def.factKeys as readonly string[]).includes(k)) return target as ProfileTargetKey;
  return null;
}

export async function currentTargetValue(clientId: string, target: ProfileTargetKey): Promise<string | null> {
  return (await getSlot(clientId, PROFILE_TARGETS[target].slot))?.value ?? null;
}

type Diff = { path: string; from: string | null; to: string; appliedTo?: string };
function parseDiff(json: string | null): Diff | null {
  try {
    const v = JSON.parse(json ?? "") as Diff[];
    return Array.isArray(v) && v[0] && typeof v[0].path === "string" ? v[0] : null;
  } catch { return null; }
}

/**
 * Propose a profile change from a fact (normally one just extracted from a
 * call). Returns the proposal id, or null when there is nothing to propose:
 * no target for this fieldKey, no value, a confidential fact or value, the
 * value is already what the profile says, or an identical proposal is open.
 */
export async function proposeFieldChange(input: {
  clientId: string; enrollmentId: string; factId: string; fieldKey: string | null; proposedValue: string | null;
  callRecordId?: string | null; sourceRef?: string | null;
}): Promise<string | null> {
  const target = targetForFieldKey(input.fieldKey);
  const to = clip((input.proposedValue ?? "").trim(), 1000);
  if (!target || !to) return null;
  const fact = await prisma.clientFact.findUnique({ where: { id: input.factId }, select: { confidential: true, body: true } });
  if (!fact || fact.confidential || CONFIDENTIAL_RE.test(to) || CONFIDENTIAL_RE.test(fact.body)) return null;
  const from = await currentTargetValue(input.clientId, target);
  if (from != null && sameSlotValue(from, to)) return null;
  const open = await prisma.contentStrategyProposal.findMany({ where: { clientId: input.clientId, targetKey: target, status: "PROPOSED" }, select: { diffJson: true } });
  if (open.some((o) => sameSlotValue(parseDiff(o.diffJson)?.to, to))) return null;
  const { createStrategyProposal } = await import("@/lib/contentStrategy");
  const label = targetLabel(target);
  return createStrategyProposal({
    enrollmentId: input.enrollmentId, kind: "PROFILE", targetKey: target,
    summary: `${label}: ${from ? `“${clip(from, 120)}”` : "not set"} → “${clip(to, 160)}”`,
    diff: [{ path: target, from, to }],
    impact: `Changes the ${label.toLowerCase()} on the editor's brief once someone applies it.`,
    sourceKind: "call", sourceRef: input.sourceRef ?? null, callRecordId: input.callRecordId ?? null, factId: input.factId,
  });
}

class ApplyRefusal extends Error {}

/**
 * APPLY THIS PROPOSED CHANGE — the separate, human act. Refuses a proposal
 * already handled, one that is not a profile change, anything confidential,
 * and DRIFT: if the field no longer holds the value the proposal was made
 * against, someone changed it since and a person must look again. Under the
 * slot's lock, in one transaction: the proposal flips PROPOSED → ACCEPTED
 * (a second click races and loses), the slot gets a new version (source
 * "fact"), the history row is written. Jordan may edit the value (`value`)
 * and must be able to leave notes (`note` → resolutionNote). Applying also
 * remembers the fact; remembering never applied anything.
 */
export async function applyFieldProposal(
  proposalId: string,
  by: { email: string; appUserId?: string | null },
  opts: { value?: string | null; note?: string | null } = {},
): Promise<{ ok: boolean; message: string; versionId?: string | null }> {
  const p = await prisma.contentStrategyProposal.findUnique({ where: { id: proposalId } });
  if (!p) return { ok: false, message: "That proposal isn't on file." };
  if (p.status !== "PROPOSED") return { ok: false, message: "That proposal was already handled." };
  if (!isProfileTarget(p.targetKey)) return { ok: false, message: "That isn't a profile change — resolve it on the Strategy tab." };
  const diff = parseDiff(p.diffJson);
  if (!diff) return { ok: false, message: "That proposal has no value to apply — ignore it." };
  const value = clip((opts.value ?? diff.to ?? "").trim(), 1000);
  if (!value) return { ok: false, message: "Give it a value, or ignore the proposal." };
  const fact = p.factId ? await prisma.clientFact.findUnique({ where: { id: p.factId }, select: { confidential: true, body: true, status: true } }) : null;
  if (fact?.confidential || CONFIDENTIAL_RE.test(value) || (fact && CONFIDENTIAL_RE.test(fact.body))) {
    return { ok: false, message: "This came from something said in confidence, so it can't be applied to the profile. Ignore it." };
  }
  const target = p.targetKey;
  const slot = PROFILE_TARGETS[target].slot;
  const label = targetLabel(target);
  const note = opts.note?.trim() ? clip(opts.note.trim(), 1000) : null;
  let result: { versionId: string | null; versionNo: number | null; changed: boolean };
  try {
    result = await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, slotLockKey(p.clientId, slot));
      const current = await getSlot(p.clientId, slot, tx);
      if (!sameSlotValue(current?.value ?? null, diff.from)) {
        const last = await tx.clientBrandChange.findFirst({ where: { clientId: p.clientId, fieldKey: `slot:${slot}` }, orderBy: { createdAt: "desc" }, select: { actorLabel: true, createdAt: true } });
        const when = last ? last.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;
        throw new ApplyRefusal(`The ${label.toLowerCase()} changed since this was proposed — it is now ${current?.value ? `“${clip(current.value, 120)}”` : "empty"}${last ? ` (${last.actorLabel ?? "someone"}, ${when})` : ""}. Nothing was applied: ignore this one, or set it by hand on the Brand tab.`);
      }
      const flipped = await tx.contentStrategyProposal.updateMany({
        where: { id: p.id, status: "PROPOSED" },
        data: { status: "ACCEPTED", resolvedBy: by.email, resolvedAt: new Date(), resolutionNote: note },
      });
      if (flipped.count === 0) throw new ApplyRefusal("That proposal was already handled.");
      const r = await setProfileSlotTx(tx, {
        clientId: p.clientId, enrollmentId: p.enrollmentId, key: slot, value,
        actor: { staffEmail: by.email, staffUserId: by.appUserId ?? null, label: by.email },
        source: "fact", factId: p.factId, proposalId: p.id, note: note ?? `Applied from a call proposal${p.callRecordId ? ` (call ${p.callRecordId})` : ""}`,
        kind: "APPLIED_FROM_CALL",
      });
      const applied: Diff = { ...diff, ...(sameSlotValue(value, diff.to) ? {} : { appliedTo: value }) };
      await tx.contentStrategyProposal.update({
        where: { id: p.id },
        data: { appliedAt: new Date(), resultAssetVersionId: r.changed ? r.versionId : null, diffJson: JSON.stringify([applied]) },
      });
      return { versionId: r.changed ? r.versionId : null, versionNo: r.versionNo, changed: r.changed };
    });
  } catch (e) {
    if (e instanceof ApplyRefusal) return { ok: false, message: e.message };
    throw e;
  }
  // Applying implies remembering (never the reverse).
  if (p.factId && fact?.status === "PROPOSED") await acceptFact(p.factId, by.email).catch(() => {});
  if (result.changed) await alertBrandChanges(p.clientId).catch((e) => console.warn("brand alert failed (the change is applied)", e));
  return {
    ok: true, versionId: result.versionId,
    message: result.changed
      ? `Applied — the ${label.toLowerCase()} is now “${clip(value, 120)}” (version ${result.versionNo}). The editor sees it on the brief, and the old value stays in the history.`
      : `That's already the ${label.toLowerCase()} on file — marked applied, nothing changed.`,
  };
}

/** IGNORE: the proposal is closed, the profile is untouched. */
export async function ignoreFieldProposal(proposalId: string, by: string, note?: string | null): Promise<{ ok: boolean; message: string }> {
  const p = await prisma.contentStrategyProposal.findUnique({ where: { id: proposalId }, select: { status: true, targetKey: true } });
  if (!p) return { ok: false, message: "That proposal isn't on file." };
  if (!isProfileTarget(p.targetKey)) return { ok: false, message: "That isn't a profile change — resolve it on the Strategy tab." };
  const n = await prisma.contentStrategyProposal.updateMany({ where: { id: proposalId, status: "PROPOSED" }, data: { status: "REJECTED", resolvedBy: by, resolvedAt: new Date(), resolutionNote: note?.trim() || null } });
  return n.count ? { ok: true, message: "Ignored — the profile is unchanged." } : { ok: false, message: "That proposal was already handled." };
}

/** Open profile proposals for a client, for the Facts tab. */
export async function openFieldProposals(clientId: string) {
  const rows = await prisma.contentStrategyProposal.findMany({ where: { clientId, status: "PROPOSED", targetKey: { startsWith: "profile." } }, orderBy: { createdAt: "desc" }, take: 60 });
  return rows.filter((r) => isProfileTarget(r.targetKey)).map((r) => ({ ...r, target: r.targetKey as ProfileTargetKey, diff: parseDiff(r.diffJson) }));
}

// ---------------------------------------------------------------------------
// STRATEGY SECTIONS
// ---------------------------------------------------------------------------

export const SECTION_TARGET_PREFIX = "strategy.section:";
const normHeading = (h: string) => h.toLowerCase().replace(/^\s*(section\s*)?\d+[.)]?\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Which section of the approved strategy a heading (as the model or a client wrote it) means, or null. */
export function resolveSection(stored: StoredSections | null, heading: string | null | undefined): { id: string; heading: string; text: string } | null {
  const h = (heading ?? "").trim();
  if (!stored || !h) return null;
  const byId = stored.sections.find((s) => s.id === h);
  if (byId) return { id: byId.id, heading: byId.heading, text: byId.text };
  const n = normHeading(h);
  const hit = stored.sections.find((s) => normHeading(s.heading) === n);
  return hit ? { id: hit.id, heading: hit.heading, text: hit.text } : null;
}

// ---------------------------------------------------------------------------
// WHAT A CALL ANALYSIS PRODUCES FOR KNOWLEDGE (moved out of
// contentGeneration.analyzeTranscriptText so a drill can feed it a fixture
// model output without a model call; the transcript job still calls it).
// ---------------------------------------------------------------------------

type Excerpt = { speaker: string; speakerName?: string | null; time?: string | null; text: string };
export type ExtractedFact = {
  body: string; category: FactCategory; fieldKey: string | null; scope: "PERMANENT" | "MONTH" | "PROJECT"; speaker: string | null;
  confidential: boolean; confidence: number; excerpt: Excerpt | null;
  /** CP-11: the new standing value, in a few words, when the client changed a preference. */
  proposedValue?: string | null;
};
export type ExtractedProposal = {
  kind: "STRATEGY" | "PILLAR" | "AUDIENCE" | "POSITIONING" | "PREFERENCE"; summary: string; impact: string | null;
  /** CP-11: the heading, exactly as it appears in the approved strategy, of the ONE section this changes. */
  section?: string | null;
  /** CP-11: the replacement text for that section only. */
  proposedText?: string | null;
  confidential?: boolean;
};
export type CallKnowledgeContext = {
  /** null for the one-time brand-discovery call (6.2, Sep 25 2026): it plans no month, so a
   *  "this month only" fact from it has no month to belong to and is kept as permanent. */
  enrollmentId: string; clientId: string; targetMonthId: string | null; callRecordId?: string | null; transcriptSourceId?: string | null;
  callDate: Date | null; unattended: boolean; sourceRef: string; runId?: string | null;
};
export type CallKnowledgeResult = { facts: number; confidentialFacts: number; proposals: number; fieldProposals: number; sectionProposals: number; confidentialProposals: number };

export async function applyCallKnowledge(o: CallKnowledgeContext, out: { facts?: ExtractedFact[]; strategyProposals?: ExtractedProposal[] }): Promise<CallKnowledgeResult> {
  let facts = 0, confidentialFacts = 0, proposals = 0, fieldProposals = 0, sectionProposals = 0, confidentialProposals = 0;
  for (const f of Array.isArray(out.facts) ? out.facts : []) {
    if (!f?.body?.trim()) continue;
    const r = await createFact({
      clientId: o.clientId, enrollmentId: o.enrollmentId, category: f.category, fieldKey: f.fieldKey ?? null, body: f.body, source: "call", sourceRef: o.sourceRef, callRecordId: o.callRecordId ?? null, transcriptSourceId: o.transcriptSourceId ?? null,
      excerpt: f.excerpt ? [{ time: f.excerpt.time ?? null, speaker: f.excerpt.speaker, text: f.excerpt.text }] : null, speaker: f.speaker ?? f.excerpt?.speaker ?? null, factDate: o.callDate ?? new Date(),
      scope: f.scope === "MONTH" && !o.targetMonthId ? "PERMANENT" : f.scope, monthId: f.scope === "MONTH" ? o.targetMonthId : null, confidential: f.confidential === true, confidence: typeof f.confidence === "number" ? f.confidence : null, aiRunId: o.runId ?? null, unattended: o.unattended,
    });
    if (!r.existed) { facts++; if (f.confidential) confidentialFacts++; }
    // A standing preference that CHANGED also proposes the change — for a
    // person to apply. Re-running the analysis finds the open proposal and
    // makes no second one.
    if (!f.confidential && f.proposedValue?.trim()) {
      const id = await proposeFieldChange({ clientId: o.clientId, enrollmentId: o.enrollmentId, factId: r.id, fieldKey: f.fieldKey, proposedValue: f.proposedValue, callRecordId: o.callRecordId ?? null, sourceRef: o.sourceRef });
      if (id) fieldProposals++;
    }
  }
  const strategyProposals = Array.isArray(out.strategyProposals) ? out.strategyProposals : [];
  if (!strategyProposals.length) return { facts, confidentialFacts, proposals, fieldProposals, sectionProposals, confidentialProposals };
  const { approvedStrategy, createStrategyProposal } = await import("@/lib/contentStrategy");
  const approved = await approvedStrategy(o.enrollmentId);
  for (const p of strategyProposals) {
    if (!p?.summary?.trim()) continue;
    const text = (p.proposedText ?? "").trim();
    // Said in confidence → a locked internal fact, never a proposal: a proposal
    // becomes a strategy version, and a version can be released to the portal.
    if (p.confidential === true || CONFIDENTIAL_RE.test(p.summary) || CONFIDENTIAL_RE.test(text)) {
      await createFact({ clientId: o.clientId, enrollmentId: o.enrollmentId, category: "INTERNAL", body: [p.summary, text].filter(Boolean).join(" — "), source: "call", sourceRef: o.sourceRef, callRecordId: o.callRecordId ?? null, confidential: true, aiRunId: o.runId ?? null, factDate: o.callDate ?? new Date() });
      confidentialProposals++;
      continue;
    }
    const section = text ? resolveSection(approved?.stored ?? null, p.section) : null;
    const targetKey = section ? `${SECTION_TARGET_PREFIX}${section.id}` : null;
    const open = await prisma.contentStrategyProposal.findMany({ where: { enrollmentId: o.enrollmentId, status: "PROPOSED", targetKey }, select: { summary: true, diffJson: true } });
    const dup = section
      ? open.some((x) => sameSlotValue(parseDiff(x.diffJson)?.to, text))
      : open.some((x) => sameSlotValue(x.summary, p.summary.slice(0, 500)));
    if (dup) continue;
    await createStrategyProposal({
      enrollmentId: o.enrollmentId, kind: p.kind, summary: p.summary, impact: p.impact ?? null, sourceKind: "call", sourceRef: o.sourceRef, callRecordId: o.callRecordId ?? null,
      ...(section ? { targetKey, diff: [{ path: targetKey!, from: section.text, to: text }] } : {}),
    });
    proposals++;
    if (section) sectionProposals++;
  }
  return { facts, confidentialFacts, proposals, fieldProposals, sectionProposals, confidentialProposals };
}
