import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/aiRuns";
import { createPillar, listPillars } from "@/lib/contentPillars";
import { CONFIDENTIAL_RE } from "@/lib/clientFacts";
import {
  parseStrategyDocument, normalizeStrategyLines, validateStrategyStructure, detectStructureVersion, isFrameworkSection, withCanonicalFramework,
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
    changeSummary: `Imported from ${opts.fileName} (${parsed.structureVersion} structure; ${validation.pillarCount} pillars; framework: the house framework${validation.documentFramework === "own wording" ? " (the document’s own is not used)" : ""})`,
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
    // ONE DIRECTION ONLY (Jordan, Oct 13 2026: "this should never happen where
    // v2 supersedes v3"). Approving vN replaces what came BEFORE it: an older
    // version in force, and the open drafts vN was built from (their changes
    // are inside it). A NEWER version is never "superseded" by an older one:
    // putting an older version back in force (the undo) sends a newer approved
    // one back to "needs your OK", where it can be approved again; a newer
    // draft stays a draft.
    const all = await prisma.contentStrategyVersion.findMany({ where: { strategyId: v.strategyId }, select: { id: true, versionNo: true, status: true, basedOnVersionId: true } });
    const ancestors = new Set<string>();
    for (let at = v.basedOnVersionId; at && !ancestors.has(at); at = all.find((x) => x.id === at)?.basedOnVersionId ?? null) ancestors.add(at);
    const older = all.filter((x) => x.id !== versionId && x.versionNo < v.versionNo && (x.status === "APPROVED" || (ancestors.has(x.id) && (x.status === "DRAFT" || x.status === "INTERNAL_REVIEW"))));
    const newerInForce = all.filter((x) => x.versionNo > v.versionNo && x.status === "APPROVED");
    if (older.length) await prisma.contentStrategyVersion.updateMany({ where: { id: { in: older.map((x) => x.id) } }, data: { status: "SUPERSEDED" } });
    if (newerInForce.length) await prisma.contentStrategyVersion.updateMany({ where: { id: { in: newerInForce.map((x) => x.id) }, status: "APPROVED" }, data: { status: "INTERNAL_REVIEW" } });
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

/**
 * Sections that are the TEAM's working notes, never the client's document
 * (A08, Sep 25 2026): the drafter's "Gaps the draft could not fill" list and
 * a legacy accepted proposal appended as its own section with its raw
 * "path: from → to" diff. The portal hid neither (its heading filter reads
 * framework/caption/production/internal), so approving and releasing an AI
 * draft as it came would have shown the client the internal gap list. The
 * release refuses them; the portal drops them as a second guard.
 */
export function isInternalStrategySection(s: { id: string }): boolean {
  return s.id === "gaps" || s.id.startsWith("proposal-");
}

/**
 * Release to the portal — only an approved version can be released (since
 * Oct 14 2026 approving releases it too: content/actions.approveStrategy).
 *
 * NO CONFIDENTIAL-FACT CHECK (Oct 14 2026). Jordan, Oct 13: "Nothing in the
 * content strategy should be confidential. The only thing that should be
 * confidential is if they say so on the strategy call." The A09 check that
 * matched each sentence against the client's confidential facts refused
 * Bernadette Rabel's strategy because its Brand Overview says "Lehigh
 * Valley." (her market), which a migrated note marked confidential also
 * names. The strategy is written by us for the client; the two checks that
 * stay are the team's working-notes sections and a literal [CONFIDENTIAL]
 * marker in the text.
 */
export async function releaseStrategyVersion(versionId: string, by: string): Promise<void> {
  const v = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { id: true, status: true, strategyId: true, sectionsJson: true, clientId: true } });
  if (!v) throw new Error("Strategy version not found.");
  if (v.status !== "APPROVED") throw new Error("Approve the version before releasing it to the portal.");
  const sections = parseStoredSections(v.sectionsJson)?.sections ?? [];
  const internal = sections.find(isInternalStrategySection);
  if (internal) throw new Error(`The "${internal.heading}" section is the team's working notes, not the client's — fold it into the strategy or remove it (as a new version) before releasing this to the client.`);
  // CP-11: the portal renders every released section verbatim, so a marker of
  // confidential knowledge anywhere in the text stops the release outright.
  const leaking = sections.find((s) => CONFIDENTIAL_RE.test(s.text) || CONFIDENTIAL_RE.test(s.heading));
  if (leaking) throw new Error(`The "${leaking.heading}" section carries a [CONFIDENTIAL] marker — take it out (as a new version) before releasing this to the client.`);
  const now = new Date();
  await prisma.contentStrategyVersion.update({ where: { id: versionId }, data: { releasedAt: now, releasedBy: by } });
  await prisma.contentStrategy.update({ where: { id: v.strategyId }, data: { releasedAt: now, releasedBy: by } });
}

// ---------------------------------------------------------------------------
// EDITING A VERSION (A08, Sep 25 2026). There was no way to correct a draft
// short of re-uploading the whole document. A change is now made to ONE
// section (or a section is removed) and lands as a NEW version based on the
// one edited: every other section keeps its id, order, heading and text byte
// for byte, no AI runs, and the version edited is left exactly as it was.
//   · DRAFT / INTERNAL_REVIEW base → the new version replaces it as the one
//     to review; the base is marked SUPERSEDED (never approved, so it stays
//     history — nothing reads it as "was in force"), which keeps exactly one
//     open draft and makes a stale second tab's edit fail loudly instead of
//     forking the document.
//   · APPROVED base → it stays in force; the edit is a new INTERNAL_REVIEW
//     version for Jordan to approve.
// createStrategyVersion's content hash keeps a double click to one version.
// ---------------------------------------------------------------------------
const EDITABLE = ["DRAFT", "INTERNAL_REVIEW", "APPROVED"];

export type DerivedVersion = { versionId: string; versionNo: number; existed: boolean; changedSectionIds: string[] };

/** A new version from `baseId` with some sections' text replaced and/or some removed. Shared by the manual edit and the AI revision. */
export async function deriveStrategyVersion(o: {
  baseId: string; replace?: Map<string, string>; remove?: Set<string>; by: string;
  sourceKind: "manual" | "ai"; aiRunId?: string | null; changeSummary: string;
}): Promise<DerivedVersion> {
  const base = await prisma.contentStrategyVersion.findUnique({ where: { id: o.baseId } });
  if (!base) throw new Error("Strategy version not found.");
  if (!EDITABLE.includes(base.status)) throw new Error(`v${base.versionNo} is ${base.status.toLowerCase()} — make the change on the newest version instead.`);
  // Oct 13 2026: changes CHAIN. An edit to an older version while a newer one
  // is open would fork the document (the newer one's changes missing from
  // the edit), so it is made on the newest instead.
  const newest = await newestWorkingVersion(base.enrollmentId);
  if (newest && newest.id !== base.id) throw new Error(`v${newest.versionNo} is the newest version — make the change there, so nothing in it is lost.`);
  const stored = parseStoredSections(base.sectionsJson);
  if (!stored) throw new Error("That version's sections can't be read.");
  const changed: string[] = [];
  const sections: StoredSection[] = [];
  for (const sec of stored.sections) {
    if (o.remove?.has(sec.id)) { changed.push(sec.id); continue; }
    const next = o.replace?.get(sec.id);
    if (next != null && next.trim() !== sec.text.trim()) { changed.push(sec.id); sections.push({ ...sec, text: next.trim() }); }
    else sections.push(sec);
  }
  if (!changed.length) return { versionId: base.id, versionNo: base.versionNo, existed: true, changedSectionIds: [] };
  if (!sections.length) throw new Error("A strategy needs at least one section — edit this one instead of removing it.");
  const next: StoredSections = { ...stored, sections, document: refreshedDocument(stored, sections) };
  const title = titleBlockOf(base.rawText, stored.sections[0]?.heading);
  const r = await createStrategyVersion({
    enrollmentId: base.enrollmentId, stored: next, rawText: [title, ...sections.map((x) => `${x.heading}\n${x.text}`)].filter(Boolean).join("\n\n"),
    sourceKind: o.sourceKind, sourceRef: base.sourceRef, callRecordId: base.callRecordId, aiRunId: o.aiRunId ?? null, policyVersionId: base.policyVersionId,
    basedOnVersionId: base.id, createdBy: o.by, status: "INTERNAL_REVIEW", changeSummary: o.changeSummary.slice(0, 1000),
  });
  if (!r.existed && base.status !== "APPROVED") {
    await prisma.contentStrategyVersion.updateMany({ where: { id: base.id, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } }, data: { status: "SUPERSEDED" } });
  }
  return { versionId: r.versionId, versionNo: r.versionNo, existed: r.existed, changedSectionIds: changed };
}

/** Jordan edits (or removes, with text null) ONE section of a version. No AI; see the block above. */
export async function editStrategyVersionSection(versionId: string, sectionId: string, text: string | null, by: string): Promise<DerivedVersion & { heading: string }> {
  const base = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId }, select: { sectionsJson: true } });
  if (!base) throw new Error("Strategy version not found.");
  const sec = parseStoredSections(base.sectionsJson)?.sections.find((x) => x.id === sectionId);
  if (!sec) throw new Error("That section isn't in this version any more — reload and try again.");
  if (text != null) {
    if (!text.trim()) throw new Error("Write the section's text, or remove the section instead.");
    if (CONFIDENTIAL_RE.test(text)) throw new Error("Take the [CONFIDENTIAL] marker out — this document is shown to the client once it's released.");
  }
  const r = await deriveStrategyVersion({
    baseId: versionId, by, sourceKind: "manual",
    ...(text == null ? { remove: new Set([sectionId]) } : { replace: new Map([[sectionId, text]]) }),
    changeSummary: text == null ? `Removed the "${sec.heading}" section (edited by ${by})` : `Edited the "${sec.heading}" section by hand (${by})`,
  });
  return { ...r, heading: sec.heading };
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
  // Oct 6 2026: every prompt built from this document gets the house Video
  // Structure Framework, never the imported document's own (read-time swap —
  // the stored version is not touched). The style note is read from the
  // section's verbatim text, which an older parse could have split badly.
  const fwSection = stored.sections.find((x) => isFrameworkSection(x));
  const document = stored.document ? withCanonicalFramework(stored.document, fwSection?.text ?? null) : null;
  return { versionId: v.id, versionNo: v.versionNo, label: `v${v.versionNo}`, document, stored, releasedAt: v.releasedAt };
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
 * The version a change is made on: the NEWEST one still in play (a draft
 * waiting for approval, or the version in force when nothing newer is open).
 * Proposals, edits and revisions all build on it, so every change carries the
 * ones before it (Oct 13 2026).
 */
export async function newestWorkingVersion(enrollmentId: string): Promise<{ id: string; versionNo: number; status: string } | null> {
  return prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, status: { in: ["DRAFT", "INTERNAL_REVIEW", "APPROVED"] } }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true, status: true } });
}

/**
 * Accept a proposal: the change goes into the NEXT draft, for Jordan to approve.
 *
 * Oct 13 2026 (Jordan: "V2 changes should be included in V3, and V2 should
 * automatically be superseded when a later version is released"). Two things
 * were wrong with the CP-11 accept:
 *   · each accepted proposal made its own draft from the version in force, so
 *     two proposals from one call became two drafts that each lacked the
 *     other's change, and approving one threw the other away;
 *   · the call analysis sees the strategy's HEADINGS, not its text, so its
 *     "replacement text" was a fragment or an instruction ("Update all
 *     instances of 'Lita' to 'Lyda'…"), and accepting it replaced the whole
 *     section with that fragment (Arielle Roemer's Brand Overview, v2 and v3).
 * Now the proposal is applied by the strategy revision (it reads every
 * section's full text, changes only what was asked and returns whole
 * sections) on the newest version in play, whose open draft it replaces.
 * Proposal 2 after proposal 1 is v3 = v2 + change 2; v2 is marked replaced.
 * `note` is passed to the revision as Jordan's own instruction. A PROFILE
 * proposal is refused here (it is applied from the Facts tab), as is anything
 * confidential.
 */
export async function acceptStrategyProposal(proposalId: string, by: string, note?: string, opts: { sectionId?: string | null } = {}): Promise<{ versionId: string | null; versionNo?: number | null; sectionHeadings?: string[]; basedOnVersionNo?: number | null }> {
  const p = await prisma.contentStrategyProposal.findUnique({ where: { id: proposalId } });
  if (!p || p.status !== "PROPOSED") throw new Error("That proposal was already handled.");
  if (p.targetKey?.startsWith("profile.")) throw new Error("That's a change to the client's profile, not the strategy — apply it (or ignore it) on the Facts tab.");
  const fact = p.factId ? await prisma.clientFact.findUnique({ where: { id: p.factId }, select: { confidential: true } }) : null;
  let proposedTo = "";
  try { proposedTo = (JSON.parse(p.diffJson ?? "[]") as { to?: string }[]).map((d) => d.to ?? "").join("\n"); } catch { proposedTo = p.diffJson ?? ""; }
  const instruction = (note ?? "").trim();
  if (fact?.confidential || CONFIDENTIAL_RE.test(p.summary) || CONFIDENTIAL_RE.test(proposedTo) || CONFIDENTIAL_RE.test(instruction)) {
    throw new Error("This carries confidential knowledge, so it can't go into the strategy. Reject it.");
  }
  const first = await newestWorkingVersion(p.enrollmentId);
  if (!first) {
    // Nothing to change yet: recorded as accepted, folded in when a strategy exists.
    const won = await prisma.contentStrategyProposal.updateMany({ where: { id: p.id, status: "PROPOSED" }, data: { status: "ACCEPTED", resolvedBy: by, resolvedAt: new Date(), resolutionNote: instruction || null } });
    if (!won.count) throw new Error("That proposal was already handled.");
    return { versionId: null };
  }
  // An unplaced proposal the person places on a section: recorded on the row
  // (so the revision is told which section), and only while it is still open.
  if (!p.targetKey && opts.sectionId) {
    const placed = await prisma.contentStrategyProposal.updateMany({ where: { id: p.id, status: "PROPOSED", targetKey: null }, data: { targetKey: `strategy.section:${opts.sectionId}` } });
    if (!placed.count) throw new Error("That proposal was already handled.");
  }
  // Claim FIRST (compare-and-set): a second tab, or a double click, is told
  // "already handled" and runs nothing. A failure hands the proposal back.
  const won = await prisma.contentStrategyProposal.updateMany({ where: { id: p.id, status: "PROPOSED" }, data: { status: "ACCEPTED", resolvedBy: by, resolvedAt: new Date(), resolutionNote: instruction || null } });
  if (!won.count) throw new Error("That proposal was already handled.");
  const giveBack = () => prisma.contentStrategyProposal.updateMany({ where: { id: p.id, status: "ACCEPTED", resolvedBy: by, resultVersionId: null }, data: { status: "PROPOSED", resolvedBy: null, resolvedAt: null, resolutionNote: null } }).catch(() => {});
  const { reviseStrategyWithFeedback } = await import("@/lib/contentGeneration");
  let base: { id: string; versionNo: number; status: string } = first;
  let r: Awaited<ReturnType<typeof reviseStrategyWithFeedback>> | null = null;
  try {
    // The revision takes a while; if ANOTHER change landed a newer draft in
    // the meantime, the write is refused (deriveStrategyVersion) and this one
    // is made again on top of it, so it never forks.
    for (let attempt = 0; ; attempt++) {
      const at: { id: string; versionNo: number; status: string } | null = attempt === 0 ? first : await newestWorkingVersion(p.enrollmentId);
      if (!at) throw new Error("There's no strategy to change any more.");
      try {
        r = await reviseStrategyWithFeedback(at.id, { notes: instruction || null, proposalIds: [p.id], preclaimed: true }, by);
        base = at;
        break;
      } catch (e) {
        if (attempt < 2 && /is the newest version/.test(e instanceof Error ? e.message : String(e))) continue;
        throw e;
      }
    }
  } catch (e) {
    await giveBack();
    throw e;
  }
  if (!r || r.versionId === base.id) {
    await giveBack();
    const why = r ? [...r.unaddressed, ...r.ignoredSections.map((s) => `an unknown section (${s})`)].join("; ") : "";
    throw new Error(`The change couldn't be placed in v${base.versionNo}${why ? `: ${why}` : ""}. Edit the section by hand on v${base.versionNo}, or reject this.`);
  }
  await prisma.contentStrategyProposal.updateMany({ where: { id: p.id, status: "ACCEPTED", resultVersionId: null }, data: { resultVersionId: r.versionId } });
  return { versionId: r.versionId, versionNo: r.versionNo, sectionHeadings: r.changedSections, basedOnVersionNo: base.versionNo };
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
    // The team's working-notes sections (the drafter's gap list, a legacy
    // appended proposal) are not part of the document and would make every
    // re-parse of an AI draft "different" — so an edit to a draft that still
    // had its gap list kept the OLD structured read, and approving it would
    // have created pillars from the words before the edit (A08).
    const body = sections.filter((s) => !isInternalStrategySection(s));
    const text = body.map((s) => `${s.heading}\n${s.text}`).join("\n");
    const parsed = parseStrategyDocument(text);
    const same = parsed.sections.length === body.length && parsed.sections.every((s, i) => s.heading === body[i].heading);
    // The sections carry no title block, so the re-parse has no client name,
    // year or subtitle; those are the document's, unchanged by a section edit
    // (A08: an edited draft still reads "<Client> / 2026 Social Content Strategy").
    return same ? { ...parsed, clientName: parsed.clientName ?? before.document.clientName, year: parsed.year ?? before.document.year, subtitle: parsed.subtitle ?? before.document.subtitle } : before.document;
  } catch {
    return before.document;
  }
}

/** The title lines of a version's text — everything before its first section heading — so a derived version's text keeps them. */
function titleBlockOf(rawText: string | null, firstHeading: string | undefined): string {
  if (!rawText || !firstHeading) return "";
  const at = rawText.indexOf(firstHeading);
  return at > 0 ? rawText.slice(0, at).trim() : "";
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
