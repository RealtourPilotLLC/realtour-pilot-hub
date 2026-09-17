import "server-only";
import { prisma } from "@/lib/prisma";
import { monthLabel, etMonthKey, PACKAGE_RULES, ownersFor, OWNER_DUTIES } from "@/lib/contentProgram";
import { callModeOf } from "@/lib/programMonths";
import { DUTY_WORDS, staffChoices } from "@/lib/programOwners";
import { billingTruth, enrollmentHistory, readOverrides, nextMonth } from "@/lib/enrollmentChanges";
import { assetRegistry, assetVersions, brandSources, ASSET_TYPES, ASSET_TYPE_WORDS, TEXT_ASSET_TYPES } from "@/lib/clientAssets";
import { factsForPrompt } from "@/lib/clientFacts";
import type { SettingsUi, BillingUi, OwnersUi, HistoryUi } from "@/components/content/SettingsPanel";
import type { AssetUi, AssetVersionUi, SourcesUi, ProvenanceUi } from "@/components/content/BrandAssetsPanel";
import type { LibraryVideoUi } from "@/components/content/ContentLibraryPanel";

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
  const [rows, sources, facts] = await Promise.all([
    assetRegistry(clientId, { links: true, includeRetired: true }),
    brandSources(clientId, { folder: true }),
    factsForPrompt(clientId, { take: 60 }),
  ]);
  const assets: AssetUi[] = [];
  for (const a of rows) {
    const versions = a.versionCount > 1 ? await assetVersions(a.id, { links: false }) : a.active ? [a.active] : [];
    const toUi = (v: (typeof versions)[number]): AssetVersionUi => ({ id: v.id, versionNo: v.versionNo, source: v.source, fileName: v.fileName, valueText: v.valueText, note: v.note, uploadedBy: v.uploadedBy, createdAtISO: v.createdAt.toISOString(), url: v.url });
    assets.push({
      id: a.id, type: a.type, typeWord: ASSET_TYPE_WORDS[a.type], name: a.name, ownership: a.ownership, status: a.status, notes: a.notes,
      isText: (TEXT_ASSET_TYPES as readonly string[]).includes(a.type),
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
  return {
    assets, sources: sourcesUi, provenance,
    types: ASSET_TYPES.map((t) => ({ key: t as string, word: ASSET_TYPE_WORDS[t] })),
  };
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
    return { rows: [] as LibraryVideoUi[], pipelineOnly: projects.map((p) => ({ id: p.id, title: p.title, status: p.status, monthKey: p.contentMonthId ? keyOf.get(p.contentMonthId) ?? null : null, shootDateISO: iso(p.shootDate) })) };
  }
  const ids = videos.map((v) => v.id);
  const [cuts, decisions, pillars, sources] = await Promise.all([
    prisma.reviewSubmission.findMany({
      where: { OR: [{ videoId: { in: ids } }, { projectId: { in: videos.map((v) => v.projectId).filter((x): x is string => !!x) } }] },
      orderBy: [{ round: "asc" }],
      select: { id: true, videoId: true, projectId: true, round: true, status: true, fileName: true, submittedByName: true, submittedByKey: true, createdAt: true, decidedAt: true, decidedBy: true, clientReleasedAt: true, clientRequestedAt: true, withdrawnAt: true, note: true, slot: true },
    }),
    prisma.clientDecision.findMany({ where: { enrollmentId, videoId: { in: ids } }, select: { videoId: true, submissionId: true, decision: true, createdAt: true } }),
    prisma.contentPillar.findMany({ where: { enrollmentId }, select: { id: true, name: true } }),
    prisma.contentVideoSource.findMany({ where: { videoId: { in: ids } }, select: { videoId: true, kind: true, isFinal: true, label: true } }),
  ]);
  const rows: LibraryVideoUi[] = videos.map((v) => {
    const mine = cuts.filter((c) => (c.videoId ? c.videoId === v.id : c.projectId === v.projectId));
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
    };
  });
  return { rows, pipelineOnly: [] as { id: string; title: string; status: string; monthKey: string | null; shootDateISO: string | null }[] };
}
