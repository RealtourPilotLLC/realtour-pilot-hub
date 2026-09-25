import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/aiRuns";
import { createPillar, listPillars } from "@/lib/contentPillars";
import { CONFIDENTIAL_RE } from "@/lib/clientFacts";
import {
  parseStrategyDocument, normalizeStrategyLines, validateStrategyStructure, detectStructureVersion,
  type ParsedStrategy, type StrategyDocument, type StrategyStructureVersion,
} from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Strategy VERSIONS (spec §3/§21). ContentStrategy stays the stable identity
// (one per enrollment); every import, edit, AI draft or accepted proposal is
// a new ContentStrategyVersion row and nothing ever overwrites one. Approve
// and release are separate, attributable acts. The source document's own
// section headings and order are stored verbatim (sectionsJson.sections) next
// to the policy's structured read (sectionsJson.document) — never forced into
// the eight generic keys the old importer used.
// ---------------------------------------------------------------------------

export type StoredSection = { id: string; number: number | null; heading: string; order: number; text: string };
export type StoredSections = {
  structureVersion: StrategyStructureVersion | "LEGACY";
  /** The source's sections, verbatim, in the source's order. */
  sections: StoredSection[];
  /** The policy's structured read (pillars, goals, framework…). Null when only legacy keys exist. */
  document: StrategyDocument | null;
  title?: string | null;
  warnings?: string[];
};

export function parseStoredSections(json: string | null | undefined): StoredSections | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === "object" && Array.isArray((v as StoredSections).sections)) return v as StoredSections;
    // A legacy ContentStrategy.sectionsJson: {"Heading": "text", …} → sections in key order.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sections = Object.entries(v as Record<string, string>).map(([heading, text], i) => ({ id: `legacy-${i + 1}`, number: null, heading, order: i + 1, text: String(text ?? "") }));
      return { structureVersion: "LEGACY", sections, document: null };
    }
  } catch { /* unreadable */ }
  return null;
}

/** Slice the normalized source lines into one verbatim text block per parsed section. */
function sectionsFromParse(text: string, parsed: ParsedStrategy): StoredSection[] {
  const lines = normalizeStrategyLines(text);
  const secs = [...parsed.sections].sort((a, b) => a.line - b.line);
  return secs.map((s, i) => {
    const end = secs[i + 1]?.line ?? lines.length;
    const body = lines.slice(s.line + 1, end).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { id: s.id, number: s.number, heading: s.heading, order: s.order, text: body };
  });
}

export function structuredFromText(text: string): { stored: StoredSections; parsed: ParsedStrategy } {
  const parsed = parseStrategyDocument(text);
  const sections = parsed.sections.length
    ? sectionsFromParse(text, parsed)
    : [{ id: "document", number: null, heading: "Document", order: 1, text: text.trim() }];
  return { stored: { structureVersion: parsed.structureVersion, sections, document: parsed, title: parsed.title || null, warnings: parsed.warnings }, parsed };
}

/**
 * The legacy shape of ContentStrategy.sectionsJson — {"Heading": "text", …} —
 * is what every pre-versioning reader (the portal's strategy page, the profile
 * builder, the Client-file card) still parses. A version's sections are
 * flattened to it on approval; nothing else writes those columns.
 */
function legacyMapOf(stored: StoredSections | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of stored?.sections ?? []) {
    const key = s.heading.trim() || `Section ${s.order}`;
    out[key in out ? `${key} (${s.order})` : key] = s.text;
  }
  return out;
}

async function strategyIdentity(enrollmentId: string, clientId: string, seed: { source: string; sourceFile?: string | null }): Promise<string> {
  const existing = await prisma.contentStrategy.findFirst({ where: { enrollmentId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
  // Prefer the ACTIVE row as the identity; else the newest row; else mint one.
  const active = await prisma.contentStrategy.findFirst({ where: { enrollmentId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  if (active) return active.id;
  if (existing) return existing.id;
  // A fresh identity is a DRAFT with an empty legacy map: the legacy readers
  // treat an ACTIVE row as the strategy in force, and an unapproved import must
  // not reach the portal or the model (review finding — it also broke the
  // workspace page, which rendered the new-shape JSON as React children).
  // approveStrategyVersion flips it to ACTIVE and writes the legacy mirror.
  const row = await prisma.contentStrategy.create({
    data: { enrollmentId, clientId, sectionsJson: "{}", rawText: null, status: "DRAFT", source: seed.source, sourceFile: seed.sourceFile ?? null },
    select: { id: true },
  });
  return row.id;
}

async function nextVersionNo(strategyId: string): Promise<number> {
  const last = await prisma.contentStrategyVersion.findFirst({ where: { strategyId }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
  return (last?.versionNo ?? 0) + 1;
}

export type NewVersionInput = {
  enrollmentId: string;
  stored: StoredSections;
  rawText?: string | null;
  sourceKind: "import" | "discovery_call" | "monthly_call" | "manual" | "ai";
  sourceRef?: string | null;
  callRecordId?: string | null;
  importItemId?: string | null;
  aiRunId?: string | null;
  policyVersionId?: string | null;
  basedOnVersionId?: string | null;
  changeSummary?: string | null;
  createdBy: string;
  /** DRAFT (default) or INTERNAL_REVIEW. Never APPROVED — approval is its own act. */
  status?: "DRAFT" | "INTERNAL_REVIEW";
  summaryJson?: string | null;
};

/** Create the next version. Idempotent per content: an identical document (same contentHash) returns the existing version instead of a duplicate. */
export async function createStrategyVersion(input: NewVersionInput): Promise<{ versionId: string; versionNo: number; strategyId: string; existed: boolean }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const sectionsJson = JSON.stringify(input.stored);
  const contentHash = sha256(JSON.stringify(input.stored.sections));
  const strategyId = await strategyIdentity(input.enrollmentId, e.clientId, { source: input.sourceKind === "import" ? "import" : input.sourceKind === "manual" ? "manual" : "ai", sourceFile: input.sourceRef });
  const dup = await prisma.contentStrategyVersion.findFirst({ where: { strategyId, contentHash }, select: { id: true, versionNo: true } });
  if (dup) return { versionId: dup.id, versionNo: dup.versionNo, strategyId, existed: true };
  const versionNo = await nextVersionNo(strategyId);
  const summaryJson = input.summaryJson ?? (input.stored.document ? JSON.stringify(summaryOf(input.stored.document)) : null);
  const v = await prisma.contentStrategyVersion.create({
    data: {
      strategyId, enrollmentId: input.enrollmentId, clientId: e.clientId, versionNo,
      structureTemplate: input.stored.structureVersion === "unknown" ? "LEGACY" : input.stored.structureVersion,
      sectionsJson, summaryJson, rawText: input.rawText ?? null, contentHash,
      sourceKind: input.sourceKind, sourceRef: input.sourceRef ?? null, callRecordId: input.callRecordId ?? null, importItemId: input.importItemId ?? null,
      aiRunId: input.aiRunId ?? null, policyVersionId: input.policyVersionId ?? null, basedOnVersionId: input.basedOnVersionId ?? null,
      changeSummary: input.changeSummary ?? null, status: input.status ?? "DRAFT", createdBy: input.createdBy,
    },
    select: { id: true },
  });
  await prisma.contentStrategy.update({ where: { id: strategyId }, data: { currentVersionId: v.id, structureTemplate: input.stored.structureVersion === "unknown" ? "LEGACY" : input.stored.structureVersion } });
  return { versionId: v.id, versionNo, strategyId, existed: false };
}

/** The accessible summary the portal shows (audience, goals, brand message, pillars…) — derived, never typed twice. */
export function summaryOf(doc: StrategyDocument) {
  return {
    brandMessage: doc.brandOverview.brandMessage,
    brandVoice: doc.brandOverview.brandVoice,
    coreValues: doc.brandOverview.coreValues,
    audience: {
      serviceAreas: doc.targetAudience.primaryServiceAreas, clientTypes: doc.targetAudience.primaryClientTypes,
      positioningGoal: doc.targetAudience.longTermPositioningGoal, pricePositioning: doc.targetAudience.pricePositioning,
    },
    goals: doc.contentGoals.items,
    pillars: doc.contentPillars.pillars.map((p) => ({ name: p.name, purpose: p.purpose, focusAreas: p.focusAreas })),
    captionCtaExamples: doc.captionCtaExamples?.items ?? [],
    strategicDirection: doc.strategicDirection?.paragraphs.join("\n") ?? null,
  };
}

/** Import a strategy document (text already extracted) as the next version. Preserves the source's own structure. */
export async function importStrategyVersion(opts: { enrollmentId: string; text: string; fileName: string; createdBy: string; importItemId?: string | null }) {
  const { stored, parsed } = structuredFromText(opts.text);
  const validation = validateStrategyStructure(parsed);
  const r = await createStrategyVersion({
    enrollmentId: opts.enrollmentId, stored, rawText: opts.text.slice(0, 200_000), sourceKind: "import", sourceRef: opts.fileName, createdBy: opts.createdBy,
    importItemId: opts.importItemId ?? null, status: "INTERNAL_REVIEW",
    changeSummary: `Imported from ${opts.fileName} (${parsed.structureVersion} structure; ${validation.pillarCount} pillars; framework: ${validation.frameworkSource})`,
  });
  return { ...r, validation, structureVersion: parsed.structureVersion, pillarCount: validation.pillarCount };
}

/**
 * Approve a version: attributable, and it never rewrites anything that
 * recorded an older strategyVersionId. Pillars named in the document that
 * this client does not have yet are created (stable ids from here on);
 * existing pillars are left alone — merges and renames are Jordan's calls.
 */
export async function approveStrategyVersion(versionId: string, by: string): Promise<{ pillarsCreated: number; alreadyApproved: boolean }> {
  const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("Strategy version not found.");
  const alreadyApproved = v.status === "APPROVED";
  if (!alreadyApproved) {
    const now = new Date();
    await prisma.contentStrategyVersion.updateMany({ where: { strategyId: v.strategyId, status: "APPROVED", id: { not: versionId } }, data: { status: "SUPERSEDED" } });
    await prisma.contentStrategyVersion.update({ where: { id: versionId }, data: { status: "APPROVED", approvedBy: by, approvedAt: now } });
    // The identity row becomes ACTIVE and its legacy columns mirror THIS version
    // (the readers that still parse {"Heading": "text"} then show the strategy
    // in force, never a draft). The four pre-versioning rows are only ever
    // rewritten by a later approval of a different version.
    const stored = parseStoredSections(v.sectionsJson);
    await prisma.contentStrategy.update({
      where: { id: v.strategyId },
      data: { approvedVersionId: versionId, approvedBy: by, approvedAt: now, currentVersionId: versionId, status: "ACTIVE", sectionsJson: JSON.stringify(legacyMapOf(stored)), rawText: v.rawText, structureTemplate: v.structureTemplate },
    });
  }
  // Pillars from the approved document — also for a version approved before
  // this code existed (the four lifted v1s had none: review finding).
  const pillarsCreated = await syncPillarsFromVersion(versionId, by);
  return { pillarsCreated, alreadyApproved };
}

/**
 * Create the pillars an APPROVED version names that this client does not have
 * yet (stable ids from here on). Existing pillars are left alone — merges and
 * renames are Jordan's calls. Idempotent; refuses an unapproved version.
 */
export async function syncPillarsFromVersion(versionId: string, by: string): Promise<number> {
  const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { status: true, enrollmentId: true, clientId: true, sectionsJson: true } });
  if (!v) throw new Error("Strategy version not found.");
  if (v.status !== "APPROVED") throw new Error("Pillars are created from the APPROVED strategy only — approve this version first.");
  const stored = parseStoredSections(v.sectionsJson);
  const names = stored?.document?.contentPillars.pillars ?? [];
  const before = new Set((await listPillars(v.enrollmentId, { includeRetired: true })).map((p) => p.id));
  let pillarsCreated = 0;
  for (const [i, p] of names.entries()) {
    const id = await createPillar({ enrollmentId: v.enrollmentId, clientId: v.clientId, name: p.name, purpose: p.purpose, focusAreas: p.focusAreas, contentApproach: p.contentApproach, strategyVersionId: versionId, sortOrder: i, createdBy: by });
    if (!before.has(id)) pillarsCreated++;
  }
  return pillarsCreated;
}

/**
 * One-time repair (idempotent): an identity row minted before Sep 17 carried
 * the UNAPPROVED version's new-shape JSON as ACTIVE. Such a row gets the legacy
 * mirror of its approved version, or goes DRAFT with an empty map when nothing
 * is approved. Rows already in the legacy shape are untouched.
 */
export async function repairStrategyIdentities(): Promise<{ repaired: number }> {
  const rows = await prisma.contentStrategy.findMany({ select: { id: true, sectionsJson: true, approvedVersionId: true, status: true } });
  let repaired = 0;
  for (const r of rows) {
    let newShape = false;
    try { const v = JSON.parse(r.sectionsJson) as unknown; newShape = !!v && typeof v === "object" && Array.isArray((v as StoredSections).sections); } catch { newShape = false; }
    if (!newShape) continue;
    const approved = r.approvedVersionId ? await prisma.contentStrategyVersion.findUnique({ where: { id: r.approvedVersionId }, select: { status: true, sectionsJson: true, rawText: true, structureTemplate: true } }) : null;
    if (approved && approved.status === "APPROVED") {
      await prisma.contentStrategy.update({ where: { id: r.id }, data: { sectionsJson: JSON.stringify(legacyMapOf(parseStoredSections(approved.sectionsJson))), rawText: approved.rawText, structureTemplate: approved.structureTemplate, status: "ACTIVE" } });
    } else {
      await prisma.contentStrategy.update({ where: { id: r.id }, data: { sectionsJson: "{}", rawText: null, status: "DRAFT" } });
    }
    repaired++;
  }
  return { repaired };
}

/** Release to the portal — a separate act from approval; only an approved version can be released. */
export async function releaseStrategyVersion(versionId: string, by: string): Promise<void> {
  const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { id: true, status: true, strategyId: true, sectionsJson: true } });
  if (!v) throw new Error("Strategy version not found.");
  if (v.status !== "APPROVED") throw new Error("Approve the version before releasing it to the portal.");
  // CP-11: the portal renders every released section verbatim, so a marker of
  // confidential knowledge anywhere in the text stops the release outright.
  const leaking = (parseStoredSections(v.sectionsJson)?.sections ?? []).find((s) => CONFIDENTIAL_RE.test(s.text) || CONFIDENTIAL_RE.test(s.heading));
  if (leaking) throw new Error(`The "${leaking.heading}" section carries a [CONFIDENTIAL] marker — take it out (as a new version) before releasing this to the client.`);
  const now = new Date();
  await prisma.contentStrategyVersion.update({ where: { id: versionId }, data: { releasedAt: now, releasedBy: by } });
  await prisma.contentStrategy.update({ where: { id: v.strategyId }, data: { releasedAt: now, releasedBy: by } });
}

export async function rejectStrategyVersion(versionId: string, by: string, note?: string): Promise<void> {
  await prisma.contentStrategyVersion.update({ where: { id: versionId }, data: { status: "REJECTED", changeSummary: note ? `Rejected by ${by}: ${note}` : undefined } });
}

/** The version in force for generation: the approved one (never a draft). */
export async function approvedStrategy(enrollmentId: string): Promise<{ versionId: string; versionNo: number; label: string; document: StrategyDocument | null; stored: StoredSections; releasedAt: Date | null } | null> {
  const v = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" } });
  if (!v) return null;
  const stored = parseStoredSections(v.sectionsJson);
  if (!stored) return null;
  return { versionId: v.id, versionNo: v.versionNo, label: `v${v.versionNo}`, document: stored.document, stored, releasedAt: v.releasedAt };
}

export async function strategyVersions(enrollmentId: string) {
  return prisma.contentStrategyVersion.findMany({ where: { enrollmentId }, orderBy: { versionNo: "desc" } });
}

// ---------------------------------------------------------------------------
// One-time lift of the 4 legacy ContentStrategy rows into version 1 each.
// Additive: the old row's text is untouched; the version is APPROVED with
// approvedBy = "legacy-import" (the row WAS the active strategy under the old
// model — recorded as that, not as a click of Jordan's). Rerun = no-op.
// ---------------------------------------------------------------------------
export async function migrateLegacyStrategies(): Promise<{ migrated: number; skipped: number }> {
  const rows = await prisma.contentStrategy.findMany({ where: { currentVersionId: null } });
  let migrated = 0, skipped = 0;
  for (const s of rows) {
    const legacy = parseStoredSections(s.sectionsJson);
    if (!legacy) { skipped++; continue; }
    // The structured read comes from the raw text when we have it (the policy
    // parser), but the sections stored are the legacy keys — verbatim.
    let document: StrategyDocument | null = null;
    let structureVersion: StoredSections["structureVersion"] = "LEGACY";
    if (s.rawText) {
      const parsed = parseStrategyDocument(s.rawText);
      if (parsed.sections.length) { document = parsed; structureVersion = detectStructureVersion(parsed); }
    }
    const stored: StoredSections = { structureVersion, sections: legacy.sections, document };
    const existingVersions = await prisma.contentStrategyVersion.count({ where: { strategyId: s.id } });
    if (existingVersions > 0) { skipped++; continue; }
    const v = await prisma.contentStrategyVersion.create({
      data: {
        strategyId: s.id, enrollmentId: s.enrollmentId, clientId: s.clientId, versionNo: 1,
        structureTemplate: structureVersion, sectionsJson: JSON.stringify(stored), summaryJson: document ? JSON.stringify(summaryOf(document)) : null,
        rawText: s.rawText, contentHash: sha256(JSON.stringify(stored.sections)),
        sourceKind: s.source === "import" ? "import" : s.source === "ai" ? "ai" : "manual", sourceRef: s.sourceFile,
        changeSummary: "Version 1 lifted from the pre-versioning strategy row (its text untouched).",
        status: s.status === "ACTIVE" ? "APPROVED" : "SUPERSEDED", createdBy: "migration",
        approvedBy: s.status === "ACTIVE" ? "legacy-import" : null, approvedAt: s.status === "ACTIVE" ? s.createdAt : null,
      },
    });
    await prisma.contentStrategy.update({
      where: { id: s.id },
      data: { currentVersionId: v.id, structureTemplate: structureVersion, ...(s.status === "ACTIVE" ? { approvedVersionId: v.id, approvedBy: "legacy-import", approvedAt: s.createdAt } : {}) },
    });
    migrated++;
  }
  return { migrated, skipped };
}

// ---------------------------------------------------------------------------
// Proposals (spec §3/§23): a call, a client or a review PROPOSES a change to
// the approved strategy; staff accept or reject it with the source and impact
// in front of them. Accepting creates a NEW DRAFT version (based on the
// approved one, with the change recorded) for Jordan to approve — never a
// silent rewrite.
// ---------------------------------------------------------------------------
export async function createStrategyProposal(opts: {
  enrollmentId: string; kind: "STRATEGY" | "PROFILE" | "PILLAR" | "AUDIENCE" | "POSITIONING" | "PREFERENCE"; summary: string;
  diff?: { path: string; from: string | null; to: string }[]; impact?: string | null; sourceKind: "call" | "client" | "staff" | "ai" | "import";
  sourceRef?: string | null; callRecordId?: string | null; factId?: string | null; clientUserId?: string | null;
  /** CP-11: `profile.<slot>` or `strategy.section:<sectionId>` — what exactly this would change. */
  targetKey?: string | null;
}): Promise<string> {
  // Confidential knowledge never becomes a proposal: an accepted proposal
  // becomes a version, and a version can be released to the portal.
  if (CONFIDENTIAL_RE.test(opts.summary) || (opts.diff ?? []).some((d) => CONFIDENTIAL_RE.test(d.to ?? ""))) {
    throw new Error("That carries a [CONFIDENTIAL] marker — record it as a confidential fact instead of a strategy proposal.");
  }
  const e = await prisma.contentEnrollment.findUnique({ where: { id: opts.enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const approved = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: opts.enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { id: true, strategyId: true } });
  const row = await prisma.contentStrategyProposal.create({
    data: {
      enrollmentId: opts.enrollmentId, clientId: e.clientId, strategyId: approved?.strategyId ?? null, baseVersionId: approved?.id ?? null, kind: opts.kind,
      summary: opts.summary.slice(0, 500), diffJson: opts.diff ? JSON.stringify(opts.diff) : null, impact: opts.impact ?? null,
      sourceKind: opts.sourceKind, sourceRef: opts.sourceRef ?? null, callRecordId: opts.callRecordId ?? null, factId: opts.factId ?? null, clientUserId: opts.clientUserId ?? null,
      targetKey: opts.targetKey ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Accept a proposal into a new INTERNAL_REVIEW draft. Jordan still approves
 * and releases it; the version in force is untouched until he does.
 *
 * CP-11 (Sep 24 2026) — SECTION-SPECIFIC. A proposal that names its section
 * (`strategy.section:<id>`) replaces the text of THAT section only, in a copy
 * of the version in force NOW: every other section keeps its id, order,
 * heading and text byte for byte, and nothing is appended. If the section has
 * changed since the proposal was made (a newer approved version edited it),
 * the proposal is refused rather than written over the newer words. `text`
 * lets the person edit the replacement before it goes in. A PROFILE proposal
 * is not a strategy change at all and is refused here (it is applied from
 * the Facts tab), as is anything confidential. A legacy proposal with no
 * target keeps the old behaviour — the change appended as its own section for
 * Jordan to fold in.
 */
export async function acceptStrategyProposal(proposalId: string, by: string, note?: string, opts: { text?: string | null; sectionId?: string | null } = {}): Promise<{ versionId: string | null; sectionHeading?: string | null }> {
  let p = await prisma.contentStrategyProposal.findUnique({ where: { id: proposalId } });
  if (!p || p.status !== "PROPOSED") throw new Error("That proposal was already handled.");
  if (p.targetKey?.startsWith("profile.")) throw new Error("That's a change to the client's profile, not the strategy — apply it (or ignore it) on the Facts tab.");
  const fact = p.factId ? await prisma.clientFact.findUnique({ where: { id: p.factId }, select: { confidential: true } }) : null;
  const edited = (opts.text ?? "").trim();
  // What THIS proposal would put into the strategy: its summary, its proposed
  // text and the person's edit — never its `from`, which is the version in
  // force quoting itself (a marker there is the release guard's business).
  let proposedTo = "";
  try { proposedTo = (JSON.parse(p.diffJson ?? "[]") as { to?: string }[]).map((d) => d.to ?? "").join("\n"); } catch { proposedTo = p.diffJson ?? ""; }
  if (fact?.confidential || CONFIDENTIAL_RE.test(p.summary) || CONFIDENTIAL_RE.test(proposedTo) || CONFIDENTIAL_RE.test(edited)) {
    throw new Error("This carries confidential knowledge, so it can't go into the strategy. Reject it.");
  }
  // An UNPLACED proposal (a legacy row, or a heading the model got wrong) that
  // the person places on a section now: it becomes a section proposal against
  // the version in force, and is accepted as one.
  if (!p.targetKey && opts.sectionId && edited) {
    const inForce = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: p.enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" } });
    const sec = inForce ? parseStoredSections(inForce.sectionsJson)?.sections.find((s) => s.id === opts.sectionId) : null;
    if (!inForce || !sec) throw new Error("That section isn't in the strategy in force — pick another.");
    const targetKey = `strategy.section:${sec.id}`;
    // Placed only while it is still open and unplaced: a second tab placing it
    // at the same moment must not rewrite what the first one accepts.
    const placed = await prisma.contentStrategyProposal.updateMany({ where: { id: p.id, status: "PROPOSED", targetKey: null }, data: { targetKey, baseVersionId: inForce.id, diffJson: JSON.stringify([{ path: targetKey, from: sec.text, to: edited }]) } });
    if (!placed.count) throw new Error("That proposal was already handled.");
    p = await prisma.contentStrategyProposal.findUniqueOrThrow({ where: { id: p.id } });
  }
  if (p.targetKey?.startsWith("strategy.section:")) return acceptSectionProposal(p, by, note, edited);
  await claimProposal(p.id, by, note);
  const base = p.baseVersionId ? await prisma.contentStrategyVersion.findUnique({ where: { id: p.baseVersionId } }) : null;
  let versionId: string | null = null;
  try {
    if (base) {
      // A new draft = the approved sections plus one appended "Proposed change"
      // section carrying the accepted wording — Jordan approves the draft (or
      // edits it) before it is the strategy.
      const stored = parseStoredSections(base.sectionsJson);
      if (stored) {
        const sections = [...stored.sections, { id: `proposal-${p.id}`, number: null, heading: `Accepted proposal (${p.kind.toLowerCase()})`, order: stored.sections.length + 1, text: p.summary + (p.diffJson ? `\n\n${(JSON.parse(p.diffJson) as { path: string; from: string | null; to: string }[]).map((d) => `${d.path}: ${d.from ?? "—"} → ${d.to}`).join("\n")}` : "") }];
        const r = await createStrategyVersion({
          enrollmentId: p.enrollmentId, stored: { ...stored, sections }, rawText: base.rawText, sourceKind: p.sourceKind === "call" ? "monthly_call" : "manual", sourceRef: p.sourceRef,
          callRecordId: p.callRecordId, basedOnVersionId: base.id, createdBy: by, status: "INTERNAL_REVIEW", changeSummary: `Accepted proposal: ${p.summary}`,
        });
        versionId = r.versionId;
      }
    }
  } catch (e) {
    await releaseProposal(p.id, by);
    throw e;
  }
  await prisma.contentStrategyProposal.update({ where: { id: proposalId }, data: { resultVersionId: versionId } });
  return { versionId };
}

type ProposalRow = NonNullable<Awaited<ReturnType<typeof prisma.contentStrategyProposal.findUnique>>>;

/**
 * ACCEPT IS COMPARE-AND-SET (review, Sep 24 2026). The accept read the status,
 * built a version, then wrote ACCEPTED unconditionally — so two tabs accepting
 * the same proposal with different edited text both passed the read and made
 * TWO drafts, the second orphaning the first. The claim is now the first write
 * and only one caller can make it (profileFields.applyFieldProposal's pattern);
 * a version is built only by the caller that won, and a failure hands the
 * proposal back.
 */
async function claimProposal(id: string, by: string, note: string | undefined): Promise<void> {
  const won = await prisma.contentStrategyProposal.updateMany({ where: { id, status: "PROPOSED" }, data: { status: "ACCEPTED", resolvedBy: by, resolvedAt: new Date(), resolutionNote: note ?? null } });
  if (won.count !== 1) throw new Error("That proposal was already handled.");
}

/** The build after a claim failed: the proposal is open again, exactly as it was. */
async function releaseProposal(id: string, by: string): Promise<void> {
  await prisma.contentStrategyProposal.updateMany({ where: { id, status: "ACCEPTED", resolvedBy: by, resultVersionId: null }, data: { status: "PROPOSED", resolvedBy: null, resolvedAt: null, resolutionNote: null } }).catch(() => {});
}

async function acceptSectionProposal(p: ProposalRow, by: string, note: string | undefined, edited: string): Promise<{ versionId: string | null; sectionHeading: string | null }> {
  const sectionId = (p.targetKey ?? "").slice("strategy.section:".length);
  let diff: { path: string; from: string | null; to: string } | null = null;
  try { diff = (JSON.parse(p.diffJson ?? "[]") as { path: string; from: string | null; to: string }[])[0] ?? null; } catch { diff = null; }
  const replacement = edited || (diff?.to ?? "").trim();
  if (!replacement) throw new Error("Write the new text for this section before accepting it.");
  // The version in force NOW — not necessarily the one the proposal was made
  // against. If they differ, the section itself must be unchanged since.
  const base = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: p.enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" } });
  const stored = base ? parseStoredSections(base.sectionsJson) : null;
  if (!base || !stored) throw new Error("There's no approved strategy to change yet — approve one first.");
  const at = stored.sections.findIndex((s) => s.id === sectionId);
  if (at === -1) throw new Error("That section isn't in the strategy in force any more — reject this, or place it by hand.");
  const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();
  if (base.id !== p.baseVersionId && diff && !sameText(stored.sections[at].text, diff.from)) {
    throw new Error(`The "${stored.sections[at].heading}" section changed in v${base.versionNo} after this was proposed — reject this one and look again.`);
  }
  const sections = stored.sections.map((s, i) => (i === at ? { ...s, text: replacement } : s));
  const next: StoredSections = { ...stored, sections, document: refreshedDocument(stored, sections) };
  const heading = stored.sections[at].heading;
  // Claim, THEN build: the loser of a double accept writes nothing.
  await claimProposal(p.id, by, note);
  let r: Awaited<ReturnType<typeof createStrategyVersion>>;
  try {
    r = await createStrategyVersion({
      enrollmentId: p.enrollmentId, stored: next, rawText: base.rawText, sourceKind: p.sourceKind === "call" ? "monthly_call" : "manual", sourceRef: p.sourceRef,
      callRecordId: p.callRecordId, basedOnVersionId: base.id, createdBy: by, status: "INTERNAL_REVIEW",
      changeSummary: `Section "${heading}": ${p.summary}`.slice(0, 1000),
    });
  } catch (e) {
    await releaseProposal(p.id, by);
    throw e;
  }
  const changed = !sameText(replacement, diff?.to);
  await prisma.contentStrategyProposal.update({
    where: { id: p.id },
    data: {
      resultVersionId: r.versionId,
      ...(changed && diff ? { diffJson: JSON.stringify([{ ...diff, appliedTo: replacement }]) } : {}),
    },
  });
  return { versionId: r.versionId, sectionHeading: heading };
}

/**
 * The structured read (pillars, goals, audience…) that generation and the
 * portal summary use, refreshed after ONE section's text changed. The
 * sections are re-parsed from their own headings and text; the new read is
 * used only when it finds exactly the same headings in the same order (so the
 * parse is known to be reading the same document). Otherwise the old read is
 * kept — the verbatim sections are the truth, and Jordan approves the draft.
 */
function refreshedDocument(before: StoredSections, sections: StoredSection[]): StrategyDocument | null {
  if (!before.document) return null;
  try {
    // Headings are stored verbatim, numbering included ("2. Content Goals").
    const text = sections.map((s) => `${s.heading}\n${s.text}`).join("\n");
    const parsed = parseStrategyDocument(text);
    const same = parsed.sections.length === sections.length && parsed.sections.every((s, i) => s.heading === sections[i].heading);
    return same ? parsed : before.document;
  } catch {
    return before.document;
  }
}

export async function rejectStrategyProposal(proposalId: string, by: string, note?: string): Promise<void> {
  await prisma.contentStrategyProposal.updateMany({ where: { id: proposalId, status: "PROPOSED" }, data: { status: "REJECTED", resolvedBy: by, resolvedAt: new Date(), resolutionNote: note ?? null } });
}

export async function openStrategyProposals(enrollmentId: string) {
  // CP-11: profile-field proposals are applied from the Facts tab, never
  // accepted as a strategy draft — they are not listed here. (OR on null: a
  // NOT/LIKE alone would drop every legacy row whose targetKey is NULL.)
  return prisma.contentStrategyProposal.findMany({
    where: { enrollmentId, status: "PROPOSED", OR: [{ targetKey: null }, { NOT: { targetKey: { startsWith: "profile." } } }] },
    orderBy: { createdAt: "desc" },
  });
}

// Monthly priorities live on the MONTH (spec §3), apart from the brand foundation.
export async function setMonthPriorities(monthId: string, priorities: string[], sourceRef: string): Promise<void> {
  const clean = priorities.map((p) => p.trim().slice(0, 500)).filter(Boolean).slice(0, 12);
  await prisma.contentMonth.update({ where: { id: monthId }, data: { prioritiesJson: JSON.stringify(clean), prioritiesSourceRef: sourceRef.slice(0, 200) } });
}

export function monthPriorities(json: string | null | undefined): string[] {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
