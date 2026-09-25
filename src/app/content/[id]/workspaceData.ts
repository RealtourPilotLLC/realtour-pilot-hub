import "server-only";
import { prisma } from "@/lib/prisma";
import { monthLabel, etMonthKey, PACKAGE_RULES, ownersFor, OWNER_DUTIES } from "@/lib/contentProgram";
import { callModeOf } from "@/lib/programMonths";
import { DUTY_WORDS, staffChoices } from "@/lib/programOwners";
import { billingTruth, enrollmentHistory, readOverrides, nextMonth } from "@/lib/enrollmentChanges";
import { assetRegistry, assetVersions, brandSources, ASSET_TYPES, ASSET_TYPE_WORDS, TEXT_ASSET_TYPES } from "@/lib/clientAssets";
import { factsForPrompt } from "@/lib/clientFacts";
import type { SettingsUi, BillingUi, OwnersUi, HistoryUi } from "@/components/content/SettingsPanel";
import type { AssetUi, AssetVersionUi, SourcesUi, ProvenanceUi, BrandChangeUi } from "@/components/content/BrandAssetsPanel";
import type { FieldProposalUi } from "@/components/content/FactsPanel";
import type { ProposalTargetUi } from "@/components/content/StrategyPanel";
import type { LibraryVideoUi, LibraryWindowUi, LibraryRoundUi, LibraryIdentityUi, LibraryIdentityOptions, IdentityFlag } from "@/components/content/ContentLibraryPanel";

// Server loaders for the three tabs W2-E added to the client file: Content,
// Brand & Assets, Settings. One function per tab so a tab pays only for its
// own queries (the same rule programData.ts follows).

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
export async function loadSettingsTab(enrollmentId: string, ownerEyes: boolean) {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId } });
  if (!e) return null;
  const nowKey = etMonthKey();
  const [month, owners, staff, history, billing] = await Promise.all([
    prisma.contentMonth.findFirst({ where: { enrollmentId, monthKey: nowKey }, select: { videosOwed: true } }),
    ownersFor(enrollmentId, null),
    staffChoices(),
    enrollmentHistory(enrollmentId, 80),
    ownerEyes ? billingTruth(enrollmentId) : Promise.resolve(null),
  ]);
  const settings: SettingsUi = {
    enrollmentId, clientId: e.clientId, pkg: e.package, status: e.status, packageSource: e.packageSource,
    videosPerMonth: e.videosPerMonth, sessionsPerMonth: e.sessionsPerMonth, sessionHours: e.sessionHours,
    callMode: callModeOf(e), noCallEligible: e.noCallEligible, clientSuppliesTopics: e.clientSuppliesTopics,
    timezone: e.timezone, notes: e.notes, overrides: readOverrides(e.overridesJson),
    currentMonthKey: nowKey, currentMonthLabel: monthLabel(nowKey),
    nextMonthKey: nextMonth(nowKey), nextMonthLabel: monthLabel(nextMonth(nowKey)),
    currentMonthOwed: month?.videosOwed ?? null,
    packages: Object.entries(PACKAGE_RULES).map(([name, r]) => ({ name, ...r })),
  };
  const ownersUi: OwnersUi = OWNER_DUTIES.map((d) => ({ duty: d, word: DUTY_WORDS[d], label: owners[d].label, appUserId: owners[d].appUserId, scope: owners[d].scope }));
  const historyUi: HistoryUi = history.map((h) => ({
    id: h.id, field: h.field, from: h.from, to: h.to, effectiveAtISO: h.effectiveAt.toISOString(), effectiveMonthKey: h.effectiveMonthKey,
    currentMonthChoice: h.currentMonthChoice, reason: h.reason, source: h.source, billingTruth: h.billingTruth, changedBy: h.changedBy,
    appliedAtISO: iso(h.appliedAt), createdAtISO: h.createdAt.toISOString(), superseded: h.superseded,
  }));
  const billingUi: BillingUi | null = billing
    ? {
        source: billing.source, typed: billing.typed, packageSource: billing.packageSource,
        signup: billing.signup ? { ...billing.signup, paidAtISO: billing.signup.paidAt.toISOString() } : null,
      }
    : null;
  return { settings, owners: ownersUi, history: historyUi, billing: billingUi, staff };
}

// ---------------------------------------------------------------------------
// BRAND & ASSETS
// ---------------------------------------------------------------------------
export async function loadBrandTab(clientId: string) {
  const { recentBrandChanges } = await import("@/lib/brandProfile");
  const [rows, sources, facts, changeRows] = await Promise.all([
    assetRegistry(clientId, { links: true, includeRetired: true }),
    brandSources(clientId, { folder: true }),
    factsForPrompt(clientId, { take: 60 }),
    recentBrandChanges(clientId, 30),
  ]);
  const assets: AssetUi[] = [];
  for (const a of rows) {
    const versions = a.versionCount > 1 ? await assetVersions(a.id, { links: false }) : a.active ? [a.active] : [];
    const toUi = (v: (typeof versions)[number]): AssetVersionUi => ({ id: v.id, versionNo: v.versionNo, source: v.source, fileName: v.fileName, valueText: v.valueText, note: v.note, uploadedBy: v.uploadedBy, createdAtISO: v.createdAt.toISOString(), url: v.url, cleared: v.cleared });
    assets.push({
      id: a.id, type: a.type, typeWord: ASSET_TYPE_WORDS[a.type], name: a.name, ownership: a.ownership, status: a.status, notes: a.notes,
      // CP-06: text-or-file follows the ACTIVE version (a FONT can be either),
      // the type only when there is no version to look at.
      isText: a.active ? !a.active.fileRef : (TEXT_ASSET_TYPES as readonly string[]).includes(a.type),
      profileKey: a.profileKey,
      active: a.active ? toUi(a.active) : null, versions: versions.map(toUi),
    });
  }
  const registered = new Set(Object.keys(sources?.registeredPaths ?? {}));
  const sourcesUi: SourcesUi = {
    client: {
      brandColors: sources?.client.brandColors ?? null, brandAssetsPath: sources?.client.brandAssetsPath ?? null, avatarUrl: sources?.client.avatarUrl ?? null,
      portalVideoStyle: sources?.client.portalVideoStyle ?? null, portalPreferences: sources?.client.portalPreferences ?? null, generalNotes: sources?.client.generalNotes ?? null,
    },
    profile: sources?.profile ?? {},
    folder: sources?.folder
      ? {
          path: sources.folder.path, folderUrl: sources.folder.folderUrl, folderExists: sources.folder.folderExists,
          files: sources.folder.files.map((f) => ({ name: f.name, path: f.path, url: f.url, tracked: registered.has(f.path.toLowerCase()) })),
        }
      : null,
  };
  const provenance: ProvenanceUi = facts
    .filter((f) => f.category === "BRAND_PREFERENCE" || f.category === "PRODUCTION_PREFERENCE" || f.scope === "PROJECT")
    .map((f) => ({ id: f.id, body: f.body, category: f.category, scope: f.scope, source: f.source, projectId: f.projectId, monthId: f.monthId, factDateISO: iso(f.factDate) }));
  // CP-06: every brand change, who made it, and whether the editor has it.
  const changes: BrandChangeUi[] = changeRows.map((c) => ({
    id: c.id, label: c.label, kind: c.kind, fromText: c.fromText, toText: c.toText, source: c.source, actorLabel: c.actorLabel, createdAtISO: c.createdAt.toISOString(),
    alertChannel: c.alertChannel, alertEditorKeys: c.alertEditorKeys, ackAtISO: iso(c.ackAt), ackBy: c.ackBy,
  }));
  return {
    assets, sources: sourcesUi, provenance, changes,
    types: ASSET_TYPES.map((t) => ({ key: t as string, word: ASSET_TYPE_WORDS[t] })),
  };
}

// ---------------------------------------------------------------------------
// CP-11 — proposed profile changes from calls (Facts tab), and the section a
// strategy proposal targets (Strategy tab). Separate loaders so the existing
// tab loaders stay as they are.
// ---------------------------------------------------------------------------
export async function loadFieldProposals(clientId: string): Promise<FieldProposalUi[]> {
  const { openFieldProposals, targetLabel, currentTargetValue } = await import("@/lib/profileFields");
  const rows = await openFieldProposals(clientId);
  const calls = rows.map((r) => r.callRecordId).filter((x): x is string => !!x);
  const callDates = calls.length ? await prisma.programCallRecord.findMany({ where: { id: { in: calls } }, select: { id: true, scheduledStart: true } }) : [];
  const facts = rows.map((r) => r.factId).filter((x): x is string => !!x);
  const factRows = facts.length ? await prisma.clientFact.findMany({ where: { id: { in: facts } }, select: { id: true, excerptJson: true } }) : [];
  const out: FieldProposalUi[] = [];
  for (const r of rows) {
    let excerpt: string | null = null;
    try { const ex = JSON.parse(factRows.find((f) => f.id === r.factId)?.excerptJson ?? "[]") as { text?: string }[]; excerpt = ex[0]?.text ?? null; } catch { excerpt = null; }
    const now = await currentTargetValue(clientId, r.target).catch(() => null);
    out.push({
      id: r.id, factId: r.factId, target: r.target, label: targetLabel(r.target), from: r.diff?.from ?? null, to: r.diff?.to ?? "", current: now,
      drifted: (now ?? "").replace(/\s+/g, " ").trim().toLowerCase() !== (r.diff?.from ?? "").replace(/\s+/g, " ").trim().toLowerCase(),
      callDateISO: iso(callDates.find((c) => c.id === r.callRecordId)?.scheduledStart ?? null) ?? r.createdAt.toISOString(), excerpt,
    });
  }
  return out;
}

export async function loadStrategyTargets(enrollmentId: string): Promise<{ targets: Record<string, ProposalTargetUi>; sections: { id: string; heading: string }[] }> {
  const { approvedStrategy } = await import("@/lib/contentStrategy");
  const [rows, approved] = await Promise.all([
    prisma.contentStrategyProposal.findMany({ where: { enrollmentId, status: "PROPOSED", targetKey: { startsWith: "strategy.section:" } }, select: { id: true, targetKey: true, diffJson: true, baseVersionId: true } }),
    approvedStrategy(enrollmentId),
  ]);
  const out: Record<string, ProposalTargetUi> = {};
  for (const r of rows) {
    const sectionId = (r.targetKey ?? "").slice("strategy.section:".length);
    let diff: { from: string | null; to: string } | null = null;
    try { diff = (JSON.parse(r.diffJson ?? "[]") as { from: string | null; to: string }[])[0] ?? null; } catch { diff = null; }
    const section = approved?.stored.sections.find((s) => s.id === sectionId) ?? null;
    out[r.id] = {
      heading: section?.heading ?? null, current: section?.text ?? null, proposed: diff?.to ?? "",
      stale: !section || (approved?.versionId !== r.baseVersionId && (section.text ?? "").replace(/\s+/g, " ").trim() !== (diff?.from ?? "").replace(/\s+/g, " ").trim()),
    };
  }
  return { targets: out, sections: (approved?.stored.sections ?? []).map((x) => ({ id: x.id, heading: x.heading })) };
}

// ---------------------------------------------------------------------------
// CONTENT — the shared video library with STAFF permissions.
//
// Staff see EVERY cut of every video, including the rounds that never left the
// building; the client's view is the same library filtered to what was
// released to them. The row shows both, side by side, so "what have they
// actually seen" is answerable without opening the Review Room.
// ---------------------------------------------------------------------------
export async function loadContentTab(enrollmentId: string, clientId: string, monthKey?: string | null) {
  const videos = await prisma.contentVideo.findMany({
    where: { enrollmentId, clientId, ...(monthKey ? { monthKey } : {}) },
    orderBy: [{ monthKey: "desc" }, { filmedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  if (videos.length === 0) {
    // The library may simply not have been built for this client yet; the
    // caller shows the pipeline's own count beside the empty state so nobody
    // reads "no videos" as "we delivered nothing".
    // Project.contentMonthId is a plain ref (no Prisma relation), so the
    // months come first and the projects are fetched by their ids.
    const months = await prisma.contentMonth.findMany({ where: { enrollmentId, ...(monthKey ? { monthKey } : {}) }, select: { id: true, monthKey: true } });
    const projects = months.length
      ? await prisma.project.findMany({
          where: { contentMonthId: { in: months.map((m) => m.id) } },
          select: { id: true, title: true, status: true, shootDate: true, contentMonthId: true },
          orderBy: { shootDate: "desc" }, take: 60,
        })
      : [];
    const keyOf = new Map(months.map((m) => [m.id, m.monthKey]));
    return { rows: [] as LibraryVideoUi[], pipelineOnly: projects.map((p) => ({ id: p.id, title: p.title, status: p.status, monthKey: p.contentMonthId ? keyOf.get(p.contentMonthId) ?? null : null, shootDateISO: iso(p.shootDate) })), identity: null as LibraryIdentityOptions | null };
  }
  const ids = videos.map((v) => v.id);
  const projectIds = videos.map((v) => v.projectId).filter((x): x is string => !!x);
  // The fee is OWNER/ADMIN business (CP-02): anyone else granted this tab sees
  // the rounds, never the amount or the charge/waive controls.
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  const moneyEyes = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
  const [cuts, decisions, pillars, sources, windows, rounds] = await Promise.all([
    prisma.reviewSubmission.findMany({
      where: { OR: [{ videoId: { in: ids } }, { projectId: { in: videos.map((v) => v.projectId).filter((x): x is string => !!x) } }] },
      orderBy: [{ round: "asc" }],
      select: { id: true, videoId: true, projectId: true, round: true, status: true, fileName: true, submittedByName: true, submittedByKey: true, createdAt: true, decidedAt: true, decidedBy: true, clientReleasedAt: true, clientRequestedAt: true, withdrawnAt: true, note: true, slot: true },
    }),
    prisma.clientDecision.findMany({ where: { enrollmentId, OR: [{ videoId: { in: ids } }, { projectId: { in: projectIds } }] }, select: { id: true, videoId: true, submissionId: true, decision: true, createdAt: true, actorLabel: true, basis: true } }),
    prisma.contentPillar.findMany({ where: { enrollmentId }, select: { id: true, name: true } }),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: ids } }, select: { id: true, videoId: true, kind: true, ref: true, portalVideoId: true, isFinal: true, label: true, matchBasis: true, confirmedAt: true, confirmedBy: true } }),
    // CP-02: every review window and revision round, staff-side — the client's
    // page shows only the current version; this shows the whole history.
    prisma.contentReviewWindow.findMany({ where: { enrollmentId, projectId: { in: projectIds } }, orderBy: { openedAt: "asc" } }),
    prisma.contentRevisionRound.findMany({ where: { enrollmentId, projectId: { in: projectIds } }, orderBy: { createdAt: "asc" } }),
  ]);
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const rows: LibraryVideoUi[] = videos.map((v) => {
    const mine = cuts.filter((c) => (c.videoId ? c.videoId === v.id : c.projectId === v.projectId));
    const cutIds = new Set(mine.map((c) => c.id));
    const reviewWindows: LibraryWindowUi[] = windows
      .filter((w) => (w.videoId ? w.videoId === v.id : cutIds.has(w.submissionId)))
      .map((w) => {
        let evidence: string | null = null;
        try { evidence = w.closeEvidenceJson ? Object.entries(JSON.parse(w.closeEvidenceJson) as Record<string, unknown>).filter(([k]) => k !== "policy" && k !== "holds").map(([k, x]) => `${k}: ${String(x)}`).join(" · ") : null; } catch { /* unreadable evidence stays off the card */ }
        return {
          id: w.id, submissionId: w.submissionId, round: w.round, state: w.state, source: w.source,
          openedAtISO: w.openedAt.toISOString(), deadlineISO: w.deadlineAt.toISOString(), originalDeadlineISO: iso(w.originalDeadlineAt),
          restartedBy: w.restartedBy, notifiedAtISO: iso(w.clientNotifiedAt), viewedAtISO: iso(w.firstViewedAt),
          heldReason: w.heldAt ? `${w.holdReason ?? "held"}${w.heldBy ? ` (${w.heldBy})` : ""}` : null,
          expiryOutcome: w.expiryOutcome, closedReason: w.closedReason, evidence,
          decidedBy: w.decisionId ? decisionById.get(w.decisionId)?.actorLabel ?? null : null,
        };
      });
    const windowIds = new Set(reviewWindows.map((w) => w.id));
    const revisionRounds: LibraryRoundUi[] = rounds
      .filter((r) => windowIds.has(r.windowId) || (r.videoId ? r.videoId === v.id : false))
      .map((r) => ({
        id: r.id, ordinal: r.ordinal, included: r.included, includedRounds: r.includedRounds, state: r.state,
        requestedBy: decisionById.get(r.decisionId)?.actorLabel ?? null, createdAtISO: r.createdAt.toISOString(),
        feeAckBy: r.feeAckBy, feeAckAtISO: iso(r.feeAckAt), feeDecision: r.feeDecision, feeDecidedBy: r.feeDecidedBy,
        feeCents: moneyEyes ? r.feeCents : null, lateOverrideBy: r.lateOverrideBy, answeredAtISO: iso(r.answeredAt),
      }));
    return {
      id: v.id, title: v.title ?? "Video", monthKey: v.monthKey, kind: v.kind, countsTowardAllowance: v.countsTowardAllowance,
      status: v.status, format: v.format, pillarName: pillars.find((p) => p.id === v.pillarId)?.name ?? null,
      filmedAtISO: iso(v.filmedAt), deliveredAtISO: iso(v.deliveredAt), releasedAtISO: iso(v.releasedToClientAt), postedAtISO: iso(v.postedByClientAt),
      projectId: v.projectId, scriptId: v.scriptId, topicId: v.topicId,
      finalVersionLabel: v.finalVersionLabel, source: v.source,
      sources: sources.filter((s) => s.videoId === v.id).map((s) => ({ kind: s.kind, isFinal: s.isFinal, label: s.label })),
      cuts: mine.map((c) => ({
        id: c.id, round: c.round, slot: c.slot, status: c.status, fileName: c.fileName,
        submittedBy: c.submittedByName ?? c.submittedByKey, createdAtISO: c.createdAt.toISOString(),
        decidedAtISO: iso(c.decidedAt), decidedBy: c.decidedBy,
        releasedToClientAtISO: iso(c.clientReleasedAt), withdrawn: !!c.withdrawnAt, note: c.note,
        clientDecision: decisions.find((d) => d.submissionId === c.id)?.decision ?? null,
      })),
      reviewWindows, revisionRounds, moneyEyes,
    };
  });
  // CP-12: identity flags and the correction tool's data.
  const identity = await loadLibraryIdentity(enrollmentId, videos, sources, cuts);
  for (const r of rows) r.identity = identity.byVideo.get(r.id);
  return { rows, pipelineOnly: [] as { id: string; title: string; status: string; monthKey: string | null; shootDateISO: string | null }[], identity: identity.options };
}

/** A positional Aryeo key — aryeo:<listing>:<n> — the four legacy rows' shape (portalLibrary.rekeyIndexedLibraryRows). */
const LEGACY_KEY = /^aryeo:[^:]+:\d+$/;

/**
 * CP-12 — WHICH ROWS NEED A PERSON, and what the identity tool offers each.
 *
 *   check pairing                     a delivered file tied to its cut chain by
 *                                     list position only, nobody confirmed it
 *   unverified legacy row             a delivered file still on a positional
 *                                     Aryeo key whose URL has left the listing
 *   filmed topic not linked to a cut  a photographer-confirmed topic row with no
 *                                     cut, beside a same-shoot video holding the
 *                                     cuts and no topic (CP-09's gap) — only
 *                                     then: a topic whose edit has not landed yet
 *                                     is not a problem
 *   month unconfirmed                 on a backfilled month nobody has confirmed
 *                                     (the client sees it under Previous content)
 */
async function loadLibraryIdentity(
  enrollmentId: string,
  videos: { id: string; projectId: string | null; monthId: string | null; monthKey: string | null; title: string | null; topicId: string | null; filmedConfirmedAt: Date | null; status: string; identityConfirmedAt: Date | null; identityConfirmedBy: string | null }[],
  sources: { id: string; videoId: string; kind: string; portalVideoId: string | null; ref: string; isFinal: boolean; label: string | null; matchBasis: string | null; confirmedAt: Date | null; confirmedBy: string | null }[],
  cuts: { videoId: string | null }[],
): Promise<{ byVideo: Map<string, LibraryIdentityUi>; options: LibraryIdentityOptions }> {
  const { librarySection } = await import("@/lib/contentVideos");
  const ids = videos.map((v) => v.id);
  const pvIds = sources.map((s) => s.portalVideoId).filter((x): x is string => !!x);
  const [months, pvs, corrections, topics, scripts] = await Promise.all([
    prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true, historical: true, status: true } }),
    pvIds.length ? prisma.portalVideo.findMany({ where: { id: { in: pvIds } }, select: { id: true, externalKey: true, title: true } }) : Promise.resolve([]),
    prisma.contentVideoCorrection.findMany({ where: { enrollmentId, videoId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 600 }),
    prisma.contentTopic.findMany({ where: { enrollmentId }, select: { id: true, title: true, status: true }, orderBy: { title: "asc" }, take: 500 }),
    prisma.contentScript.findMany({ where: { enrollmentId }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 400 }),
  ]);
  const oldIds = new Set(months.filter((m) => m.historical || m.status === "IMPORTED").map((m) => m.id));
  const oldKeys = new Set(months.filter((m) => m.historical || m.status === "IMPORTED").map((m) => m.monthKey));
  const pvById = new Map(pvs.map((p) => [p.id, p]));
  const withCuts = new Set(cuts.map((c) => c.videoId).filter((x): x is string => !!x));
  for (const s of sources) if (s.kind === "REVIEW_CUT") withCuts.add(s.videoId);
  const live = videos.filter((v) => v.status !== "ARCHIVED");
  const byVideo = new Map<string, LibraryIdentityUi>();
  for (const v of videos) {
    const monthHistorical = v.monthId ? oldIds.has(v.monthId) : !!v.monthKey && oldKeys.has(v.monthKey);
    const files = sources.filter((s) => s.videoId === v.id && s.kind === "PORTAL_VIDEO").map((s) => {
      const pv = s.portalVideoId ? pvById.get(s.portalVideoId) : undefined;
      const key = pv?.externalKey ?? s.ref;
      return {
        sourceId: s.id, externalKey: key, title: pv?.title ?? s.label, isFinal: s.isFinal,
        matchBasis: s.matchBasis, confirmedAtISO: iso(s.confirmedAt), confirmedBy: s.confirmedBy, legacyKey: LEGACY_KEY.test(key),
      };
    });
    const unconfirmed = (f: (typeof files)[number]) => !f.confirmedAtISO && f.matchBasis !== "staff";
    const sameShoot = v.projectId ? live.filter((o) => o.id !== v.id && o.projectId === v.projectId) : [];
    const adoptInto = (v.topicId || v.filmedConfirmedAt) && v.projectId && !withCuts.has(v.id)
      ? sameShoot.filter((o) => withCuts.has(o.id) && !o.topicId).map((o) => ({ id: o.id, title: o.title ?? "Video" }))
      : [];
    const flags: IdentityFlag[] = [];
    if (files.some((f) => unconfirmed(f) && f.matchBasis === "index")) flags.push("check pairing");
    if (files.some((f) => unconfirmed(f) && f.legacyKey)) flags.push("unverified legacy row");
    if (adoptInto.length) flags.push("filmed topic not linked to a cut");
    if (monthHistorical && !v.identityConfirmedAt) flags.push("month unconfirmed");
    byVideo.set(v.id, {
      section: librarySection(v, monthHistorical), monthHistorical,
      confirmedAtISO: iso(v.identityConfirmedAt), confirmedBy: v.identityConfirmedBy,
      flags, files,
      relinkTargets: sameShoot.map((o) => ({ id: o.id, title: o.title ?? "Video" })),
      adoptInto,
      corrections: corrections.filter((c) => c.videoId === v.id).map((c) => ({ id: c.id, field: c.field, fromValue: c.fromValue, toValue: c.toValue, by: c.by, reason: c.reason, createdAtISO: c.createdAt.toISOString() })),
    });
  }
  return { byVideo, options: { enrollmentId, topics, scripts } };
}
