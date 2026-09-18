import "server-only";
import { prisma } from "@/lib/prisma";
import { sha256, setRunDisposition } from "@/lib/aiRuns";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import {
  parseDeliveredScript, renderScript, estimateSpokenSeconds, makeBlock, emptyInternal, validateNewScript, TALKING_POINT_ROLES, roleFromLabel,
  type ApprovedPillar, type CanonicalScript, type Finding, type Gap, type TalkingPointRole,
} from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Script VERSIONS (spec §6/§22/§27, Jordan's rulings). ContentScript is the
// stable identity; the words live in ContentScriptVersion. Every regenerate,
// revise, edit or import is a NEW version row — nothing here ever overwrites
// one. Approval is attributable (approvedBy/At + a ContentScriptRelease
// ledger row); release to the portal is a separate act that pins
// sharedVersionId; an edit after sharing produces a new draft while the
// shared version stays exactly what the client saw.
//
// The legacy ContentScript.body/sectionsJson columns mirror ONE version for
// the readers that still exist (roster, portal): the shared version when one
// exists, else the approved version, else the current draft.
// ---------------------------------------------------------------------------

export type VersionParts = {
  title: string; categoryLabel?: string | null; pillarId?: string | null; secondaryPillarId?: string | null;
  hook: string; points: { role: TalkingPointRole | null; text: string }[]; close: string; captionCta?: string | null;
  filmingNotes?: string | null; creativeDirection?: string | null; productionNotes?: string[]; goal?: string | null; alternateHooks?: string[]; placeholders?: string[]; speakerLabels?: string[];
  sourceExcerpts?: string[]; dimensionsCheck?: Record<string, string> | null; timingNote?: string | null;
};

export type NewVersionOpts = {
  scriptId?: string | null;
  enrollmentId: string; monthId?: string | null; topicId?: string | null;
  parts: VersionParts;
  source: "AI" | "MANUAL" | "IMPORT" | "CLIENT_REQUEST" | "REGENERATE_SECTION" | "REVISION";
  basedOnVersionId?: string | null; regeneratedSections?: string[] | null; changeSummary?: string | null;
  interviewId?: string | null; answerIds?: string[] | null; callRecordId?: string | null;
  strategyVersionId?: string | null; policyVersionId?: string | null; aiRunId?: string | null; importItemId?: string | null;
  validation?: { ok: boolean; findings: Finding[] } | null; gaps?: Gap[] | null;
  createdBy: string;
  status?: "DRAFT" | "INTERNAL_REVIEW";
  /** Historical import: the script row is marked historical and never enters the review queue. */
  historical?: boolean;
  sourceFile?: string | null;
};

export function canonicalFromParts(p: VersionParts, clientId: string | null = null): CanonicalScript {
  const internal = emptyInternal();
  internal.filmingNotes = p.filmingNotes ?? null;
  internal.creativeDirection = p.creativeDirection ?? null;
  internal.productionNotes = p.productionNotes ?? [];
  internal.goal = p.goal ?? null;
  internal.alternateHooks = p.alternateHooks ?? [];
  internal.placeholders = p.placeholders ?? [];
  internal.speakerLabels = p.speakerLabels ?? [];
  internal.sourceExcerpts = p.sourceExcerpts ?? [];
  internal.contentPillarCheck = (p.dimensionsCheck as CanonicalScript["internal"]["contentPillarCheck"]) ?? null;
  return {
    title: p.title, titleAsDelivered: null, number: null,
    pillarRef: p.categoryLabel ? { pillarId: p.pillarId ?? null, pillarName: p.categoryLabel.split(/\s+(?:\/|•|\||·)\s+/)[0] ?? null, categoryAsDelivered: p.categoryLabel, secondary: [] } : null,
    hook: p.hook ? makeBlock(p.hook) : null,
    points: p.points.map((pt, i) => ({ ...makeBlock(pt.text), index: i + 1, role: pt.role, roleSource: pt.role ? "generated" : null })),
    extraSpokenBlocks: [], close: p.close ? makeBlock(p.close) : null, captionCta: p.captionCta ?? null, clientId, internal, gaps: [], stamp: null, parseWarnings: [],
  };
}

/** A delivered/legacy body read faithfully (four points stay four) → parts. */
export function partsFromBody(title: string, body: string): VersionParts {
  const c = parseDeliveredScript(body);
  return {
    title: c.title || title, categoryLabel: c.pillarRef?.categoryAsDelivered ?? null,
    hook: c.hook?.text ?? "", points: [...c.points.map((p) => ({ role: p.role, text: p.text })), ...c.extraSpokenBlocks.map((b) => ({ role: b.kind === "re-hook" ? ("re-hook" as const) : b.kind === "payoff" ? ("payoff" as const) : null, text: b.text }))],
    close: c.close?.text ?? "", captionCta: c.captionCta, filmingNotes: c.internal.filmingNotes, creativeDirection: c.internal.creativeDirection, productionNotes: c.internal.productionNotes, goal: c.internal.goal,
    placeholders: c.internal.placeholders, speakerLabels: c.internal.speakerLabels, dimensionsCheck: c.internal.contentPillarCheck ?? null,
  };
}

function bodyFor(parts: VersionParts, forStaff = false): string {
  return renderScript(canonicalFromParts(parts), { includeInternal: forStaff }).trim();
}

/** Create the next version of a script (creating the script identity when scriptId is null). */
export async function createScriptVersion(opts: NewVersionOpts): Promise<{ scriptId: string; versionId: string; versionNo: number }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: opts.enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const parts = opts.parts;
  const title = parts.title.trim().slice(0, 200) || "(untitled)";
  const canonical = canonicalFromParts(parts);
  const body = bodyFor(parts);
  const estimate = estimateSpokenSeconds(canonical);
  const pillarId = parts.pillarId ?? (parts.categoryLabel ? await resolvePillarByLabel(opts.enrollmentId, parts.categoryLabel.split(/\s+(?:\/|•|\||·)\s+/)[0]) : null);
  const contentHash = sha256(JSON.stringify({ hook: parts.hook, points: parts.points.map((p) => p.text), close: parts.close, caption: parts.captionCta ?? null }));

  let scriptId = opts.scriptId ?? null;
  let wasApprovedLive = false;
  if (scriptId) {
    const head = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { historical: true, approvedVersionId: true, sharedVersionId: true, status: true } });
    if (!head) throw new Error("Script not found.");
    // Import versions attach to historical records only; everything else on a
    // historical record is refused — its text is what was filmed (Jordan's ruling).
    if (head.historical && opts.source !== "IMPORT") throw new Error("This is an imported historical script — it is not edited, revised or regenerated; draft a new script instead.");
    if (!head.historical && opts.historical) throw new Error("An import cannot become a version of a live script — it is stored as a proposal instead.");
    wasApprovedLive = !head.historical && !!head.approvedVersionId && !head.sharedVersionId;
  }
  if (!scriptId) {
    const row = await prisma.contentScript.create({
      data: {
        enrollmentId: opts.enrollmentId, clientId: e.clientId, monthId: opts.monthId ?? null, topicId: opts.topicId ?? null, title, body,
        sectionsJson: JSON.stringify({ hook: parts.hook, points: parts.points, close: parts.close, captionCta: parts.captionCta ?? null }),
        status: opts.historical ? "DRAFT" : (opts.status ?? "INTERNAL_REVIEW"), source: opts.source === "IMPORT" ? "import" : opts.source === "MANUAL" ? "manual" : "ai", sourceFile: opts.sourceFile ?? null,
        historical: opts.historical ?? false, releaseState: opts.historical ? "historical" : null, pillarId, strategyVersionId: opts.strategyVersionId ?? null, policyVersionId: opts.policyVersionId ?? null,
        interviewId: opts.interviewId ?? null, callRecordId: opts.callRecordId ?? null, importItemId: opts.importItemId ?? null,
      },
      select: { id: true },
    });
    scriptId = row.id;
  }
  const last = await prisma.contentScriptVersion.findFirst({ where: { scriptId }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
  const versionNo = (last?.versionNo ?? 0) + 1;
  const v = await prisma.contentScriptVersion.create({
    data: {
      scriptId, enrollmentId: opts.enrollmentId, clientId: e.clientId, versionNo, title, categoryLabel: parts.categoryLabel ?? null, pillarId, secondaryPillarId: parts.secondaryPillarId ?? null,
      hook: parts.hook, pointsJson: JSON.stringify(parts.points.map((p) => ({ role: p.role ? p.role.toUpperCase().replace("-", "_") : null, text: p.text }))), close: parts.close, captionCta: parts.captionCta ?? null, body,
      filmingNotes: parts.filmingNotes ?? null, creativeDirection: parts.creativeDirection ?? null, productionNotes: parts.productionNotes?.length ? parts.productionNotes.join("\n") : null, goal: parts.goal ?? null,
      alternateHooksJson: parts.alternateHooks?.length ? JSON.stringify(parts.alternateHooks) : null, placeholdersJson: canonical.internal.placeholders.length ? JSON.stringify(canonical.internal.placeholders) : null,
      speakerLabelsJson: parts.speakerLabels?.length ? JSON.stringify(parts.speakerLabels) : null, sourceExcerptsJson: parts.sourceExcerpts?.length ? JSON.stringify(parts.sourceExcerpts) : null,
      dimensionsCheckJson: parts.dimensionsCheck ? JSON.stringify(parts.dimensionsCheck) : null,
      spokenWordCount: estimate.words, estimatedSeconds: estimate.seconds, timingNote: parts.timingNote ?? (estimate.inTarget ? null : `Estimate ≈${estimate.seconds}s (${estimate.words} words) vs the ${estimate.target[0]}–${estimate.target[1]}s target — informational, not an override.`),
      validationJson: opts.validation ? JSON.stringify(opts.validation) : null, gapsJson: opts.gaps?.length ? JSON.stringify(opts.gaps) : null,
      source: opts.source, basedOnVersionId: opts.basedOnVersionId ?? null, regeneratedSections: opts.regeneratedSections?.length ? JSON.stringify(opts.regeneratedSections) : null, changeSummary: opts.changeSummary ?? null,
      interviewId: opts.interviewId ?? null, answerIdsJson: opts.answerIds?.length ? JSON.stringify(opts.answerIds) : null, callRecordId: opts.callRecordId ?? null,
      strategyVersionId: opts.strategyVersionId ?? null, policyVersionId: opts.policyVersionId ?? null, aiRunId: opts.aiRunId ?? null, importItemId: opts.importItemId ?? null, contentHash,
      status: opts.status ?? "DRAFT", createdBy: opts.createdBy,
    },
    select: { id: true },
  });
  await syncLegacyPointer(scriptId, v.id);
  // A new draft on an approved-but-unshared script puts the script back in
  // review: the month tab's "N need your OK" and the Scripts queue then agree.
  // A SHARED script keeps its status — the client keeps seeing the shared
  // version; the queue lists the new draft through its version status.
  if (wasApprovedLive) await prisma.contentScript.update({ where: { id: scriptId }, data: { status: "INTERNAL_REVIEW" } });
  return { scriptId, versionId: v.id, versionNo };
}

/**
 * currentVersionId follows the newest version; body/sectionsJson mirror
 * shared → approved → current. A HISTORICAL record is exempt: its legacy
 * body is the record of what was filmed and no later version (an import
 * proposal) moves it — the portal serves that body today.
 */
async function syncLegacyPointer(scriptId: string, newVersionId: string): Promise<void> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { sharedVersionId: true, approvedVersionId: true, historical: true, currentVersionId: true } });
  if (s?.historical) {
    if (!s.currentVersionId) await prisma.contentScript.update({ where: { id: scriptId }, data: { currentVersionId: newVersionId } });
    return;
  }
  const mirrorId = s?.sharedVersionId ?? s?.approvedVersionId ?? newVersionId;
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: mirrorId }, select: { body: true, hook: true, pointsJson: true, close: true, captionCta: true, title: true } });
  await prisma.contentScript.update({
    where: { id: scriptId },
    data: { currentVersionId: newVersionId, ...(v ? { body: v.body, sectionsJson: JSON.stringify({ hook: v.hook, points: JSON.parse(v.pointsJson), close: v.close, captionCta: v.captionCta }) } : {}) },
  });
}

/**
 * Give a pre-versioning script its version 1, read faithfully from the
 * legacy body (four points stay four). Idempotent. Called before any edit /
 * approve / regenerate so those always have a base, and by the bulk lift.
 */
export async function ensureScriptVersioned(scriptId: string): Promise<string> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId } });
  if (!s) throw new Error("Script not found.");
  if (s.currentVersionId) return s.currentVersionId;
  const existing = await prisma.contentScriptVersion.findFirst({ where: { scriptId }, orderBy: { versionNo: "desc" }, select: { id: true } });
  if (existing) { await prisma.contentScript.update({ where: { id: scriptId }, data: { currentVersionId: existing.id } }); return existing.id; }
  const parts = partsFromBody(s.title, s.body);
  const approvedLike = ["APPROVED", "READY_TO_FILM", "CLIENT_VISIBLE"].includes(s.status);
  const canonical = canonicalFromParts(parts);
  const estimate = estimateSpokenSeconds(canonical);
  const v = await prisma.contentScriptVersion.create({
    data: {
      scriptId, enrollmentId: s.enrollmentId, clientId: s.clientId, versionNo: 1, title: s.title, categoryLabel: parts.categoryLabel ?? null, pillarId: s.pillarId,
      hook: parts.hook, pointsJson: JSON.stringify(parts.points.map((p) => ({ role: p.role ? p.role.toUpperCase().replace("-", "_") : null, text: p.text }))), close: parts.close, captionCta: parts.captionCta ?? null,
      // The legacy body is kept as THE text of v1 — parsing is for structure, the words are untouched.
      body: s.body, filmingNotes: parts.filmingNotes ?? null, creativeDirection: parts.creativeDirection ?? null, productionNotes: parts.productionNotes?.length ? parts.productionNotes.join("\n") : (s.productionJson ?? null), goal: parts.goal ?? null,
      placeholdersJson: canonical.internal.placeholders.length ? JSON.stringify(canonical.internal.placeholders) : null, speakerLabelsJson: parts.speakerLabels?.length ? JSON.stringify(parts.speakerLabels) : null,
      spokenWordCount: estimate.words, estimatedSeconds: estimate.seconds,
      source: s.source === "import" ? "IMPORT" : s.source === "manual" ? "MANUAL" : "AI", changeSummary: "Version 1 lifted from the pre-versioning script row (text untouched; archive format read as delivered).",
      status: s.historical ? "DRAFT" : approvedLike ? "APPROVED" : "DRAFT", createdBy: "migration",
      approvedBy: !s.historical && approvedLike ? (s.approvedBy ?? "legacy") : null, approvedAt: !s.historical && approvedLike ? (s.approvedAt ?? s.updatedAt) : null, contentHash: sha256(s.body),
    },
    select: { id: true },
  });
  await prisma.contentScript.update({ where: { id: scriptId }, data: { currentVersionId: v.id, ...(!s.historical && approvedLike && !s.approvedVersionId ? { approvedVersionId: v.id } : {}) } });
  return v.id;
}

export async function backfillScriptVersions(): Promise<{ created: number }> {
  const rows = await prisma.contentScript.findMany({ where: { currentVersionId: null }, select: { id: true } });
  let created = 0;
  for (const r of rows) { await ensureScriptVersioned(r.id); created++; }
  return { created };
}

/** A human edit = a new MANUAL version based on the current one, format-checked (findings stored, never "fixed"). */
export async function editScriptVersion(scriptId: string, parts: VersionParts, by: string, changeSummary?: string | null): Promise<{ versionId: string; versionNo: number }> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { enrollmentId: true, monthId: true, topicId: true, interviewId: true, callRecordId: true, strategyVersionId: true, policyVersionId: true, sharedVersionId: true, historical: true, clientId: true } });
  if (!s) throw new Error("Script not found.");
  if (s.historical) throw new Error("This is an imported historical script — it is not edited; draft a new script instead.");
  const baseId = await ensureScriptVersioned(scriptId);
  // Resolve the pillar BEFORE validating, not after. createScriptVersion
  // resolves the label itself when parts carries no id, so every hand edit used
  // to store "Category X has no pillar id yet" on a row that got one a moment
  // later — nine of nine validated rows in production said that about a script
  // whose pillarId was set (measured Sep 17 2026). Now the findings describe
  // the row that is written.
  const [pillars, resolvedPillarId] = await Promise.all([
    approvedPillarsFor(s.enrollmentId),
    parts.pillarId ? Promise.resolve(parts.pillarId) : parts.categoryLabel ? resolvePillarByLabel(s.enrollmentId, parts.categoryLabel.split(/\s+(?:\/|•|\||·)\s+/)[0]) : Promise.resolve(null),
  ]);
  const linked: VersionParts = resolvedPillarId && !parts.pillarId ? { ...parts, pillarId: resolvedPillarId } : parts;
  const validation = validateNewScript(canonicalFromParts(linked, s.clientId), { approvedPillars: pillars });
  const r = await createScriptVersion({
    scriptId, enrollmentId: s.enrollmentId, monthId: s.monthId, topicId: s.topicId, parts: linked, source: "MANUAL", basedOnVersionId: baseId, createdBy: by,
    changeSummary: changeSummary ?? (s.sharedVersionId ? "Edited after sharing — the shared version is untouched; this is a new draft." : "Edited by hand"),
    interviewId: s.interviewId, callRecordId: s.callRecordId, strategyVersionId: s.strategyVersionId, policyVersionId: s.policyVersionId, status: "DRAFT",
    validation: { ok: validation.ok, findings: validation.findings }, gaps: validation.gaps,
  });
  return { versionId: r.versionId, versionNo: r.versionNo };
}

/** Edit from a plain body (the workspace textarea) — parsed with the archive reader, words kept. */
export async function editScriptFromBody(scriptId: string, body: string, by: string): Promise<{ versionId: string; versionNo: number }> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { title: true, historical: true } });
  if (!s) throw new Error("Script not found.");
  if (s.historical) throw new Error("This is an imported historical script — it is not edited; draft a new script instead.");
  const parts = partsFromBody(s.title, body);
  if (!parts.hook && !parts.points.length && !parts.close) {
    // No labels at all: keep the text whole as the hook so nothing is lost.
    parts.hook = body.trim();
  }
  return editScriptVersion(scriptId, parts, by);
}

/**
 * The shape of a script: hook, exactly three roled points, a close, a title, and
 * no greeting in the spoken body. A blocking finding with one of these codes is
 * not a judgement call an approver can write their way past — see the override
 * split in approveScriptVersion.
 *
 * THE PILLAR CODES ARE DELIBERATELY ABSENT (Sep 17 2026). pillar.missing,
 * pillar.unknown and pillar.retired all block, and all stay overridable with a
 * written reason, because which bucket a script belongs to is a MAPPING
 * judgement about the strategy document, not a fact about the words: the same
 * script is filmable whether or not the label has been reconciled, and Jordan
 * renames pillars at every strategy refresh. Shape is different — no reason
 * turns four talking points into three. timing.out-of-range is absent for the
 * opposite reason: it is only a warning, because the seconds are estimated from
 * a word count and word count alone must not reject a script.
 */
export const STRUCTURAL_CODES = new Set([
  "title.missing",
  "hook.missing",
  "hook.banned-opener",
  "intro.greeting",
  "talking-points.count",
  "talking-points.extra-blocks",
  "talking-points.roles",
  "talking-points.empty",
  "close.missing",
]);

/**
 * Approve: explicit and attributable. The version becomes APPROVED, any
 * earlier approved version SUPERSEDED, the script's approvedVersionId moves,
 * and a ContentScriptRelease row records the act. Approval does NOT release
 * to the portal (releaseScriptVersion does), and never touches a historical
 * import.
 */
export async function approveScriptVersion(versionId: string, actor: { email: string; appUserId?: string | null }, note?: string | null): Promise<{ alreadyApproved: boolean }> {
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("Script version not found.");
  const s = await prisma.contentScript.findUnique({ where: { id: v.scriptId }, select: { historical: true, monthId: true, topicId: true, approvedVersionId: true, clientId: true } });
  if (!s) throw new Error("Script not found.");
  if (s.historical) throw new Error("Imported scripts are history — they are not approved, filmed or released by an import.");
  // A repeated click is not a second approval — no second ledger row. SHARED
  // counts as approved here: after a release the version's status moves
  // APPROVED → SHARED, so a guard that only looked for APPROVED missed it and
  // ran the whole approval again — which rewrote releaseState to "withheld"
  // and pulled a released script back off the client's portal with nothing
  // said to anyone (review, Sep 17).
  if (s.approvedVersionId === versionId && (v.status === "APPROVED" || v.status === "SHARED")) return { alreadyApproved: true };
  // The format check runs again at the gate: a hand-edited version stores its
  // findings, a lifted legacy one may have none — either way a "block" finding
  // (four points, no hook…) needs the approver's explicit note to pass.
  const check = validateNewScript(
    canonicalFromParts({ title: v.title, categoryLabel: v.categoryLabel, pillarId: v.pillarId, hook: v.hook, points: pointsFromJson(v.pointsJson), close: v.close, captionCta: v.captionCta }, s.clientId),
    // Membership is checked HERE, at the gate, against the pillars the client
    // has today — not against whatever list existed when the draft was written.
    { approvedPillars: await approvedPillarsFor(v.enrollmentId) },
  );
  const blocking = check.findings.filter((f) => f.severity === "block");
  // A NOTE CANNOT MAKE A FOUR-POINT SCRIPT HAVE THREE (audit finding 6, Sep 17).
  // Every blocking finding used to clear on any non-empty note, and the panel
  // asked "Approve anyway?" — so a script with no hook, no close or the wrong
  // number of points could be approved and released. These codes are facts
  // about the SHAPE of a script, which is the house format Jordan dictated and
  // the one thing a reason cannot argue with. Everything else that blocks (a
  // missing pillar link, say) is a mapping judgement and still takes a written
  // override, recorded on the ledger. Pacing stays a warning, deliberately: the
  // 20–30s figure is an ESTIMATE from a word count, and it is Jordan's open
  // question whether it should ever hard-block.
  const unoverridable = blocking.filter((f) => STRUCTURAL_CODES.has(f.code));
  if (unoverridable.length) {
    // NOT prefixed "Format check:" on purpose — that prefix is what the panel
    // matches to offer "Approve anyway?", and offering an override the server
    // refuses is the trap this fix exists to remove.
    throw new Error(`House script format: ${unoverridable.map((f) => f.message).join(" · ")} — fix this before approving. There is no override for the script's shape.`);
  }
  if (blocking.length && !note?.trim()) {
    throw new Error(`Format check: ${blocking.map((f) => f.message).join(" · ")} — fix the script, or approve it anyway with a note saying why.`);
  }
  const now = new Date();
  await prisma.contentScriptVersion.updateMany({ where: { scriptId: v.scriptId, status: { in: ["APPROVED", "SHARED"] }, id: { not: versionId } }, data: { status: "SUPERSEDED" } });
  await prisma.contentScriptVersion.update({ where: { id: versionId }, data: { status: "APPROVED", approvedBy: actor.email, approvedAt: now } });
  await prisma.contentScript.update({ where: { id: v.scriptId }, data: { approvedVersionId: versionId, approvedAt: now, approvedBy: actor.email, status: "APPROVED", releaseState: "withheld" } });
  await prisma.contentScriptRelease.create({ data: { scriptId: v.scriptId, scriptVersionId: versionId, enrollmentId: v.enrollmentId, clientId: v.clientId, monthId: s.monthId, action: "APPROVE", actorAppUserId: actor.appUserId ?? null, actorEmail: actor.email, note: blocking.length ? `Approved despite format findings (${blocking.map((f) => f.code).join(", ")}): ${note}` : note ?? null } });
  await syncLegacyPointer(v.scriptId, versionId);
  if (s.topicId) await prisma.contentTopic.updateMany({ where: { id: s.topicId, status: { in: ["SELECTED", "SCRIPTED"] } }, data: { status: "SCRIPTED" } });
  await setRunDisposition(v.aiRunId, "ACCEPTED", actor.email);
  return { alreadyApproved: false };
}

/**
 * Release the APPROVED version to the portal. Pins sharedVersionId so a
 * later edit becomes a new draft and the client keeps seeing exactly this
 * text. The email is W2-F's, behind script_share_email — here it is recorded
 * as SUPPRESSED (switch off) or QUEUED (switch on, sender not yet wired).
 */
export async function releaseScriptVersion(scriptId: string, actor: { email: string; appUserId?: string | null }, opts: { batchKey?: string | null; note?: string | null } = {}): Promise<{ versionId: string; notificationState: string }> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { approvedVersionId: true, enrollmentId: true, clientId: true, monthId: true, historical: true } });
  if (!s) throw new Error("Script not found.");
  if (s.historical) throw new Error("Imported scripts are history — nothing to release.");
  if (!s.approvedVersionId) throw new Error("Approve a version first.");
  // A POINTER IS NOT A CURRENT AUTHORISATION (audit, Sep 17). returnScriptToQueue
  // now clears both pointers, but rows returned BEFORE that fix still carry a
  // stale approvedVersionId over a version that went back to review — and this
  // gate was the one click between such a row and the client's portal. Ask the
  // version itself. (SHARED passes: re-releasing the live version is a no-op.)
  const approvedVersion = await prisma.contentScriptVersion.findUnique({ where: { id: s.approvedVersionId }, select: { status: true } });
  if (!approvedVersion || (approvedVersion.status !== "APPROVED" && approvedVersion.status !== "SHARED")) {
    throw new Error("That approval was withdrawn — approve the current version again before releasing it.");
  }
  const now = new Date();
  const emailOn = await isAutomationEnabled("script_share_email");
  const notificationState = emailOn ? "QUEUED" : "SUPPRESSED";
  await prisma.contentScriptVersion.update({ where: { id: s.approvedVersionId }, data: { status: "SHARED", sharedAt: now } });
  await prisma.contentScript.update({ where: { id: scriptId }, data: { sharedVersionId: s.approvedVersionId, sharedAt: now, releaseState: "released" } });
  await prisma.contentScriptRelease.create({ data: { scriptId, scriptVersionId: s.approvedVersionId, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId, action: "SHARE", actorAppUserId: actor.appUserId ?? null, actorEmail: actor.email, batchKey: opts.batchKey ?? null, releasedAt: now, notificationState, note: opts.note ?? (emailOn ? "Email queued for the share sender (W2-F)." : "Email suppressed: script_share_email is off.") } });
  await syncLegacyPointer(scriptId, s.approvedVersionId);
  return { versionId: s.approvedVersionId, notificationState };
}

/**
 * Pull a script back off the portal / out of approval (recorded, never deleted).
 *
 * WHAT "BACK TO THE QUEUE" HAS TO UNDO (audit, Sep 17). This used to move the
 * PARENT to INTERNAL_REVIEW and stop, leaving the version APPROVED/SHARED and
 * both pointers standing. Three things went wrong, and every one of them was
 * silent:
 *   · scriptsAwaitingReview lists a script by its CURRENT VERSION's status, so
 *     a returned script never reached the queue it said it was going back to;
 *   · releaseScriptVersion only wanted an approvedVersionId, so a withdrawn
 *     approval stayed one click from the client's portal;
 *   · the panel read sharedVersionId before releaseState, so a withheld script
 *     still wore the "released to the portal" chip — and a returned SHARED
 *     script rendered neither Approve nor Release, so it was simply stuck.
 * So the version, the pointers and the parent all move together, in one
 * transaction. History is not touched: every APPROVE and SHARE stays on the
 * ContentScriptRelease ledger with its actor and time, and each version row
 * keeps its own approvedBy/approvedAt/sharedAt. What is cleared is CURRENT
 * AUTHORISATION, which is a different fact from what happened before.
 */
export async function returnScriptToQueue(scriptId: string, actor: { email: string; appUserId?: string | null }, note?: string | null): Promise<void> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { currentVersionId: true, approvedVersionId: true, sharedVersionId: true, enrollmentId: true, clientId: true, monthId: true, historical: true } });
  if (!s || !s.currentVersionId) throw new Error("Script not found.");
  if (s.historical) throw new Error("Imported scripts are history — there is no approval to withdraw.");
  // The version the ledger row is ABOUT: what was live before this click.
  const pinned = s.sharedVersionId ?? s.approvedVersionId ?? s.currentVersionId;
  await prisma.$transaction([
    // approveScriptVersion supersedes every other APPROVED/SHARED row, so this
    // matches at most one version — the live one — and hands it back to review.
    prisma.contentScriptVersion.updateMany({
      where: { scriptId, status: { in: ["APPROVED", "SHARED"] } },
      data: { status: "INTERNAL_REVIEW" },
    }),
    prisma.contentScript.update({
      where: { id: scriptId },
      data: { status: "INTERNAL_REVIEW", releaseState: "withheld", approvedVersionId: null, sharedVersionId: null, approvedAt: null, approvedBy: null, sharedAt: null },
    }),
    prisma.contentScriptRelease.create({ data: { scriptId, scriptVersionId: pinned, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId, action: "RETURN_TO_QUEUE", actorAppUserId: actor.appUserId ?? null, actorEmail: actor.email, note: note ?? null } }),
  ]);
  // The legacy body mirrored shared → approved → current; with both pointers
  // gone it follows the current version again.
  await syncLegacyPointer(scriptId, s.currentVersionId);
}

export async function scriptVersions(scriptId: string) {
  return prisma.contentScriptVersion.findMany({ where: { scriptId }, orderBy: { versionNo: "desc" } });
}

export type QueueRow = {
  scriptId: string; versionId: string; versionNo: number; title: string; enrollmentId: string; clientId: string; clientName: string; monthId: string | null; monthKey: string | null;
  path: "interview" | "call" | "ai" | "manual" | "import"; pillarName: string | null; estimatedSeconds: number | null; spokenWordCount: number | null;
  validationOk: boolean | null; blockingFindings: number; gaps: number; createdAt: string; hasApprovedVersion: boolean; hasSharedVersion: boolean;
};

/**
 * ONE review queue for both planning paths (spec §22): every non-historical
 * script whose current version is a DRAFT / INTERNAL_REVIEW, whether it came
 * from a call transcript, a written interview, a regenerate or a hand edit.
 */
export async function scriptsAwaitingReview(enrollmentId?: string | null): Promise<QueueRow[]> {
  const scripts = await prisma.contentScript.findMany({ where: { historical: false, currentVersionId: { not: null }, ...(enrollmentId ? { enrollmentId } : {}) }, select: { id: true, currentVersionId: true, approvedVersionId: true, sharedVersionId: true, enrollmentId: true, clientId: true, monthId: true, interviewId: true, callRecordId: true, status: true } });
  if (!scripts.length) return [];
  const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId!) }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } } });
  if (!versions.length) return [];
  const [clients, months, pillars] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: [...new Set(scripts.map((s) => s.clientId))] } }, select: { id: true, name: true } }),
    prisma.contentMonth.findMany({ where: { id: { in: scripts.map((s) => s.monthId).filter((x): x is string => !!x) } }, select: { id: true, monthKey: true } }),
    prisma.contentPillar.findMany({ where: { id: { in: versions.map((v) => v.pillarId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  return versions.map((v): QueueRow => {
    const s = scripts.find((x) => x.currentVersionId === v.id)!;
    let validationOk: boolean | null = null, blocking = 0, gaps = 0;
    try { if (v.validationJson) { const val = JSON.parse(v.validationJson) as { ok: boolean; findings: Finding[] }; validationOk = val.ok; blocking = val.findings.filter((f) => f.severity === "block").length; } } catch { /* ignore */ }
    try { if (v.gapsJson) gaps = (JSON.parse(v.gapsJson) as unknown[]).length; } catch { /* ignore */ }
    return {
      scriptId: s.id, versionId: v.id, versionNo: v.versionNo, title: v.title, enrollmentId: s.enrollmentId, clientId: s.clientId, clientName: clients.find((c) => c.id === s.clientId)?.name ?? "?",
      monthId: s.monthId, monthKey: months.find((m) => m.id === s.monthId)?.monthKey ?? null,
      path: v.interviewId ? "interview" : v.callRecordId ? "call" : v.source === "MANUAL" ? "manual" : v.source === "IMPORT" ? "import" : "ai",
      pillarName: pillars.find((p) => p.id === v.pillarId)?.name ?? v.categoryLabel ?? null, estimatedSeconds: v.estimatedSeconds, spokenWordCount: v.spokenWordCount,
      validationOk, blockingFindings: blocking, gaps, createdAt: v.createdAt.toISOString(), hasApprovedVersion: !!s.approvedVersionId, hasSharedVersion: !!s.sharedVersionId,
    };
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The historical-import stamp (Jordan's ruling, spec §14/D5): every
 * source=import script is HISTORY — historical=true, releaseState
 * "historical" — with its status column UNTOUCHED (the portal's
 * status-based gate is A's to switch to releaseState). Idempotent.
 */
export async function markHistoricalImports(): Promise<{ stamped: number; total: number }> {
  const total = await prisma.contentScript.count({ where: { source: "import" } });
  const r = await prisma.contentScript.updateMany({ where: { source: "import", OR: [{ historical: false }, { releaseState: null }] }, data: { historical: true, releaseState: "historical" } });
  return { stamped: r.count, total };
}

/**
 * The client's pillars for the validator's membership check — RETIRED ones
 * included, because a script pinned to a pillar Jordan took out of the strategy
 * has to be told apart from one naming a pillar that never existed. Both block,
 * with different words and different fixes.
 */
async function approvedPillarsFor(enrollmentId: string): Promise<ApprovedPillar[]> {
  const rows = await listPillars(enrollmentId, { includeRetired: true });
  return rows.map((p) => ({ id: p.id, name: p.name, status: p.status, aliases: p.aliases }));
}

export function pointsFromJson(json: string): { role: TalkingPointRole | null; text: string }[] {
  try {
    const arr = JSON.parse(json) as { role: string | null; text: string }[];
    return arr.map((p) => ({ role: p.role ? (TALKING_POINT_ROLES.find((r) => r.toUpperCase().replace("-", "_") === p.role) ?? roleFromLabel(p.role)) : null, text: p.text }));
  } catch { return []; }
}

export async function pillarNameOf(pillarId: string | null, enrollmentId: string): Promise<string | null> {
  if (!pillarId) return null;
  return (await listPillars(enrollmentId, { includeRetired: true })).find((p) => p.id === pillarId)?.name ?? null;
}
