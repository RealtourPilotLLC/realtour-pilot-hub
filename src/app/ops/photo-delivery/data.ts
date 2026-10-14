import "server-only";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney } from "@/lib/auth/access";
import { STAGE_LABEL, type JobStage } from "@/lib/photoDelivery/jobState";
import { photoDeliverySettings, type PhotoDeliverySettings } from "@/lib/photoDelivery/settings";
import { creditAlertState, creditView, type CreditView } from "@/lib/photoDelivery/credits";
import { buildFixCart } from "@/lib/photoDelivery/fixes";
import { houseOverrides, mergeOverrides } from "@/lib/photoDelivery/houseRules";
import { deliveryGate, deliverySteps } from "@/lib/photoDelivery/delivery";
import { RULES, ruleById } from "@/lib/photoDelivery/registry";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";
import { AUTOHDR_BILLING_URL } from "@/lib/integrations/autohdr";
import { prettyRoom } from "@/components/photoDelivery/format";
import type { RuleOverride } from "@/lib/photoDelivery/registry";
import type {
  CartView, ClientProfileView, CoverageCounts, CreditStripView, CreditsPageData, CvMetric, EventView, ExpectedView, FindingView, FixBatchView,
  FixStatusView, GateView, GroupMeta, JobDetail, LedgerRowView, PhotoView, QueueCard, QueueColumn, QueueColumnKey, QueueData, QueueFilters, RuleOption,
  RuleOverrideView, RunView, Severity, SpendRow, StepsView, StripData, Viewer,
} from "@/components/photoDelivery/types";

// ---------------------------------------------------------------------------
// THE PHOTO DELIVERY PAGE LOADERS (docs/photo-delivery/01 sections 9 and 10.4).
// Server components call these; the drill calls them directly, which is why
// they live here and not inside the pages. Every loader batches its reads
// (findMany / groupBy over the whole set, then in-memory maps): no query per
// job, no query per photo.
//
// Money rule (Jordan, Sep 2 2026, lib/auth/access canSeeMoney): dollars are
// filled in for the OWNER only and are null for everyone else, so they never
// reach a non-owner's browser. Credits are operational and shown to admins.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const parse = <T,>(json: string | null | undefined): T | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const streetOf = (p: { addressLine: string | null; title: string } | null | undefined) => (p ? p.addressLine?.trim() || p.title.split(",")[0].trim() || p.title : "Unknown address");
const stageLabel = (s: string) => STAGE_LABEL[s as JobStage] ?? s;

/**
 * The QC engine's grouping and severity policy (qc/verdict.ts: same rule and
 * groupKey = one ticket, count escalation, client overrides, the privacy
 * floor), so the queue's counts and the job page's tickets match the verdict
 * that moved the job. Loaded defensively: the engine is optional at runtime,
 * and without it the screens fall back to the raw finding severities.
 */
type VerdictModule = typeof import("@/lib/photoDelivery/qc/verdict");
async function verdictModule(): Promise<VerdictModule | null> {
  try {
    const m = await import("@/lib/photoDelivery/qc/verdict");
    return typeof m.groupFindings === "function" ? m : null;
  } catch {
    return null;
  }
}

const houseRuleIds = async () => (await houseOverrides()).map((o) => o.ruleId);
const overridesOf = (json: string | null | undefined): RuleOverride[] => (parse<RuleOverride[]>(json) ?? []).filter((o) => o && typeof o.ruleId === "string");

// ---- who is looking ------------------------------------------------------------------------

/**
 * The person viewing, for display decisions (dollars, owner-only controls).
 * Authorization itself is requirePageAccess on the page and the guards in
 * actions.ts. Local dev with the gate off renders as the owner would see it,
 * exactly as the guards are no-ops there.
 */
export async function loadViewer(): Promise<Viewer | null> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (authEnforced()) return null;
    return { role: "OWNER", name: "local dev", isOwner: true, canSeeMoney: true };
  }
  return { role: me.role, name: me.name || me.email, isOwner: me.role === "OWNER", canSeeMoney: canSeeMoney(me.role) };
}

// ---- global strip (plan 9.2) ---------------------------------------------------------------

export function creditStrip(v: CreditView, viewer: Pick<Viewer, "canSeeMoney">): CreditStripView {
  return {
    connected: v.connected,
    balance: v.balance,
    checkedAt: iso(v.checkedAt),
    level: v.level,
    runwayDays: v.runwayDays,
    perDay: v.perDay,
    committed: v.committed,
    warn: v.thresholds.warn,
    critical: v.thresholds.critical,
    resetBuffer: v.thresholds.resetBuffer,
    lastError: v.lastError,
    usdPerCredit: viewer.canSeeMoney ? v.thresholds.usdPerCredit : null,
  };
}

export async function loadStrip(viewer: Viewer): Promise<StripData> {
  const [credit, settings] = await Promise.all([creditView().catch(() => null), photoDeliverySettings()]);
  return { credit: credit ? creditStrip(credit, viewer) : null, qcShadow: settings.qcShadow, qcEnabled: settings.qcEnabled, isOwner: viewer.isOwner };
}

// ---- the queue (plan 9.3) --------------------------------------------------------------------

/**
 * Board columns, in pipeline order. EDITED (gallery landed, QC not started)
 * sits with QC: with QC off it is "landed, waiting for a check". A client's
 * revision waits for a decision like QC findings do (plan 3.3 loop).
 */
export const QUEUE_COLUMNS: { key: QueueColumnKey; label: string; hint: string; stages: JobStage[] }[] = [
  { key: "editing", label: "Editing", hint: "Shot. The raws go to AutoHDR when the upload is finished; waiting for the edits.", stages: ["EDITING", "EDIT_FAILED"] },
  { key: "qc", label: "QC running", hint: "The edited gallery landed. QC is checking it, or waiting to.", stages: ["EDITED", "QC_RUNNING"] },
  { key: "decision", label: "Needs decision", hint: "QC found issues, or a client asked for a revision.", stages: ["QC_REVIEW", "REVISION_REQUESTED"] },
  { key: "fixing", label: "Fixing", hint: "Approved fixes are running in AutoHDR.", stages: ["FIXING"] },
  { key: "hold", label: "On hold", hint: "Delivery is blocked until the hold is released.", stages: ["ON_HOLD"] },
  { key: "ready", label: "Ready", hint: "Checks done. Deliver it in Aryeo.", stages: ["READY"] },
  { key: "delivering", label: "Delivering", hint: "Marked as delivering. The hub confirms when Aryeo says it was delivered.", stages: ["DELIVERING", "DELIVERY_MISMATCH"] },
  { key: "delivered", label: "Delivered", hint: "Delivered in the last 7 days.", stages: ["DELIVERED"] },
];
const COLUMN_OF = new Map<string, QueueColumnKey>(QUEUE_COLUMNS.flatMap((c) => c.stages.map((s) => [s, c.key] as const)));

const RUNNING_OPS = new Set(["QUEUED", "SUBMITTING", "SUBMITTED"]);
const GOOD_OPS = new Set(["SUCCEEDED", "VERIFIED", "NOOP"]);

function fixStatusOf(batchStatus: string, ops: Map<string, number>): FixStatusView {
  let total = 0, running = 0, good = 0;
  for (const [s, n] of ops) {
    total += n;
    if (RUNNING_OPS.has(s)) running += n;
    if (GOOD_OPS.has(s)) good += n;
  }
  switch (batchStatus) {
    case "PENDING":
      return { status: batchStatus, label: `Fixes queued (${total})`, tone: "warn" };
    case "RUNNING":
      return { status: batchStatus, label: `Fixing: ${total - running} of ${total} done`, tone: "warn" };
    case "DONE":
      return { status: batchStatus, label: `Fixes done (${total})`, tone: "ok" };
    case "PARTIAL":
      return { status: batchStatus, label: `Fixes partly done: ${good} of ${total}`, tone: "warn" };
    case "FAILED":
      return { status: batchStatus, label: "Fixes failed", tone: "danger" };
    default:
      return { status: batchStatus, label: `Fixes: ${batchStatus.toLowerCase()}`, tone: "muted" };
  }
}

export async function loadQueue(opts: { now?: Date; filters?: Partial<QueueFilters> } = {}): Promise<QueueData> {
  const now = opts.now ?? new Date();
  const filters: QueueFilters = { client: opts.filters?.client || null, photographer: opts.filters?.photographer || null, atRisk: !!opts.filters?.atRisk };
  const since = new Date(now.getTime() - 7 * DAY);
  const settings = await photoDeliverySettings();

  const jobs = await prisma.photoJob.findMany({
    where: {
      OR: [{ stage: { not: "DELIVERED" } }, { stage: "DELIVERED", OR: [{ deliveredAt: { gte: since } }, { deliveredAt: null, stageChangedAt: { gte: since } }] }],
    },
    select: { id: true, projectId: true, stage: true, slaDueAt: true, qcShadow: true, heroPhotoId: true, holdReason: true, lastError: true, deliveredAt: true, stageChangedAt: true, finalsCount: true },
    take: 400,
  });
  const ids = jobs.map((j) => j.id);
  const [projects, photos, counts, batches] = ids.length
    ? await Promise.all([
        prisma.project.findMany({
          where: { id: { in: jobs.map((j) => j.projectId) } },
          select: {
            id: true, title: true, addressLine: true, status: true, shootDate: true, paymentStatus: true, clientId: true, photographerId: true,
            client: { select: { name: true } }, photographer: { select: { name: true } },
          },
        }),
        prisma.photoAsset.findMany({
          where: { jobId: { in: ids }, status: "ACTIVE" },
          select: { id: true, jobId: true, name: true, sequence: true, contentHash: true, sourceKind: true, sourceUrl: true, roomType: true },
          orderBy: { sequence: "asc" },
        }),
        prisma.photoQcFinding.findMany({
          where: { jobId: { in: ids }, status: "OPEN", confidence: { gte: settings.displayConfidenceFloor } },
          select: { id: true, jobId: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true },
        }),
        prisma.photoFixBatch.findMany({ where: { jobId: { in: ids } }, orderBy: { approvedAt: "desc" }, select: { id: true, jobId: true, status: true } }),
      ])
    : [[], [], [], []];

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const photosByJob = new Map<string, typeof photos>();
  for (const p of photos) {
    const list = photosByJob.get(p.jobId);
    if (list) list.push(p);
    else photosByJob.set(p.jobId, [p]);
  }
  // Open issues by severity, counted as TICKETS (one per rule and groupKey,
  // with the engine's effective severity) when the QC engine is available.
  const verdict = counts.length ? await verdictModule() : null;
  const clientIds = [...new Set(projects.map((p) => p.clientId))];
  const profileRows = verdict && clientIds.length ? await prisma.clientQcProfile.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, ruleOverridesJson: true } }) : [];
  const house = await houseOverrides();
  const overridesByClient = new Map(profileRows.map((r) => [r.clientId, mergeOverrides(house, overridesOf(r.ruleOverridesJson))]));
  const projectOfJob = new Map(jobs.map((j) => [j.id, j.projectId]));
  const findingsByJob = new Map<string, typeof counts>();
  for (const f of counts) {
    const list = findingsByJob.get(f.jobId);
    if (list) list.push(f);
    else findingsByJob.set(f.jobId, [f]);
  }
  const issuesByJob = new Map<string, Record<Severity, number>>();
  for (const [jobId, list] of findingsByJob) {
    const rec: Record<Severity, number> = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
    if (verdict) {
      const clientId = projectById.get(projectOfJob.get(jobId) ?? "")?.clientId;
      const { groups } = verdict.groupFindings(list, { floor: settings.displayConfidenceFloor, overrides: (clientId ? overridesByClient.get(clientId) : null) ?? house });
      for (const g of groups) rec[g.severity] += 1;
    } else {
      for (const f of list) if (f.severity === "CRITICAL" || f.severity === "MAJOR" || f.severity === "MINOR") rec[f.severity] += 1;
    }
    issuesByJob.set(jobId, rec);
  }
  const latestBatch = new Map<string, { id: string; status: string }>();
  for (const b of batches) if (!latestBatch.has(b.jobId)) latestBatch.set(b.jobId, b);
  const opRows = latestBatch.size
    ? await prisma.photoFixOperation.groupBy({ by: ["batchId", "status"], where: { batchId: { in: [...latestBatch.values()].map((b) => b.id) } }, _count: { _all: true } })
    : [];
  const opsByBatch = new Map<string, Map<string, number>>();
  for (const r of opRows) {
    const m = opsByBatch.get(r.batchId) ?? new Map<string, number>();
    m.set(r.status, (m.get(r.status) ?? 0) + r._count._all);
    opsByBatch.set(r.batchId, m);
  }

  const cards: QueueCard[] = [];
  const columnOf = new Map<string, QueueColumnKey>();
  for (const j of jobs) {
    const p = projectById.get(j.projectId);
    // A cancelled shoot is not work: the sync stops following it, so the board does too.
    if (p?.status === "CANCELLED") continue;
    const list = photosByJob.get(j.id) ?? [];
    const hero = list.find((x) => x.id === j.heroPhotoId) ?? list[0] ?? null;
    const column = COLUMN_OF.get(j.stage) ?? "editing";
    const delivered = column === "delivered";
    const left = j.slaDueAt ? j.slaDueAt.getTime() - now.getTime() : null;
    const batch = latestBatch.get(j.id);
    columnOf.set(j.id, column);
    cards.push({
      id: j.id,
      projectId: j.projectId,
      stage: j.stage,
      stageLabel: stageLabel(j.stage),
      street: streetOf(p),
      clientId: p?.clientId ?? null,
      clientName: p?.client?.name ?? null,
      photographerId: p?.photographerId ?? null,
      photographerName: p?.photographer?.name ?? null,
      slaDueAt: iso(j.slaDueAt),
      deliveredAt: iso(j.deliveredAt ?? (j.stage === "DELIVERED" ? j.stageChangedAt : null)),
      shootDate: iso(p?.shootDate),
      photoCount: list.length || j.finalsCount,
      issues: issuesByJob.get(j.id) ?? { CRITICAL: 0, MAJOR: 0, MINOR: 0 },
      shadow: j.qcShadow,
      hero: hero ? { photoId: hero.id, hash: hero.contentHash, fallbackUrl: hero.sourceKind === "ARYEO" ? hero.sourceUrl : null, alt: `${streetOf(p)}: ${prettyRoom(hero.roomType)}` } : null,
      fix: batch ? fixStatusOf(batch.status, opsByBatch.get(batch.id) ?? new Map()) : null,
      paymentStatus: p?.paymentStatus ?? null,
      // Plan 9.3: amber at 6 h left; "at risk" is anything inside that or late.
      atRisk: !delivered && left != null && left < 6 * HOUR,
      holdReason: j.holdReason,
      lastError: j.lastError,
    });
  }

  const clients = [...new Map(cards.filter((c) => c.clientId).map((c) => [c.clientId!, c.clientName ?? "Unnamed client"])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const photographers = [...new Map(cards.filter((c) => c.photographerId).map((c) => [c.photographerId!, c.photographerName ?? "Unnamed"])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const shown = cards.filter(
    (c) => (!filters.client || c.clientId === filters.client) && (!filters.photographer || c.photographerId === filters.photographer) && (!filters.atRisk || c.atRisk),
  );
  const due = (c: QueueCard) => (c.slaDueAt ? Date.parse(c.slaDueAt) : Number.POSITIVE_INFINITY);
  const columns: QueueColumn[] = QUEUE_COLUMNS.map((col) => {
    const mine = shown.filter((c) => columnOf.get(c.id) === col.key);
    if (col.key === "delivered") mine.sort((a, b) => Date.parse(b.deliveredAt ?? "") - Date.parse(a.deliveredAt ?? "") || 0);
    else mine.sort((a, b) => due(a) - due(b) || a.street.localeCompare(b.street));
    return { key: col.key, label: col.label, hint: col.hint, stages: [...col.stages], cards: mine };
  });
  return { columns, total: cards.length, shown: shown.length, clients, photographers, filters, nowIso: now.toISOString() };
}

// ---- job detail (plan 9.4) ------------------------------------------------------------------

const CV_KNOWN: [string, string, (v: number) => string][] = [
  ["blurScore", "Sharpness score", (v) => v.toFixed(0)],
  ["blurRelativeToGallery", "Sharpness vs the gallery", (v) => `${Math.round(v * 100)}% of the median`],
  ["clipHighPct", "Blown highlights", (v) => `${v.toFixed(1)}%`],
  ["clipLowPct", "Crushed shadows", (v) => `${v.toFixed(1)}%`],
  ["meanLuma", "Mean brightness", (v) => `${v.toFixed(0)} of 255`],
  ["satHighPct", "Oversaturated pixels", (v) => `${v.toFixed(1)}%`],
];

/** What the CV pass stored on the photo (qc/cv.ts StoredCv: { v, metrics, unavailable, p1b }), read defensively. */
type StoredCvLoose = { metrics?: Record<string, unknown> | null; unavailable?: { reason?: string } | null; p1b?: { dust?: number; real?: number; texture?: number } | null } & Record<string, unknown>;

/** Full-resolution size from the CV metrics (box overlays fall back to it). */
export function cvFullSize(json: string | null): { w: number; h: number } | null {
  const raw = parse<StoredCvLoose>(json);
  const m = raw?.metrics;
  return m && typeof m.fullW === "number" && typeof m.fullH === "number" && m.fullW > 0 && m.fullH > 0 ? { w: m.fullW, h: m.fullH } : null;
}

/** A readable summary of PhotoAsset.cvJson (plan 7.3 metrics), tolerant of its exact shape. */
export function cvSummary(json: string | null): CvMetric[] {
  const raw = parse<StoredCvLoose>(json);
  if (!raw || typeof raw !== "object") return [];
  const out: CvMetric[] = [];
  if (raw.unavailable && typeof raw.unavailable === "object") out.push({ label: "Checks", value: `not run: ${String(raw.unavailable.reason ?? "the file could not be read")}` });
  const o: Record<string, unknown> = raw.metrics && typeof raw.metrics === "object" ? { ...raw, ...raw.metrics } : raw;
  if (typeof o.fullW === "number" && typeof o.fullH === "number") out.push({ label: "Full size", value: `${o.fullW} x ${o.fullH}${typeof o.format === "string" ? ` ${o.format.toUpperCase()}` : ""}${typeof o.space === "string" ? `, ${o.space}` : ""}` });
  for (const [key, label, fmt] of CV_KNOWN) {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push({ label, value: fmt(v) });
  }
  const cast = o.grayWorldCast;
  if (Array.isArray(cast) && cast.length === 2 && cast.every((n) => typeof n === "number")) out.push({ label: "Color cast (a*, b*)", value: `${(cast[0] as number).toFixed(1)}, ${(cast[1] as number).toFixed(1)}` });
  if (Array.isArray(o.dustCandidates)) out.push({ label: "Dust candidates", value: typeof o.dustSkipped === "string" && o.dustSkipped ? `not checked (${o.dustSkipped})` : String(o.dustCandidates.length) });
  const p1b = raw.p1b;
  if (p1b && typeof p1b === "object" && typeof p1b.dust === "number") out.push({ label: "Dust confirmed by the close-up check", value: `${p1b.dust} (${p1b.real ?? 0} real objects, ${p1b.texture ?? 0} texture)` });
  if (Array.isArray(o.flags) && o.flags.length) out.push({ label: "Flags", value: o.flags.filter((x) => typeof x === "string").join(", ").replace(/_/g, " ").toLowerCase() });
  if (!out.length) {
    // Unknown shape: show the plain values rather than hide them.
    for (const [k, v] of Object.entries(o)) {
      if (out.length >= 10) break;
      if (typeof v === "number" && Number.isFinite(v)) out.push({ label: k, value: String(Math.round(v * 100) / 100) });
      else if (typeof v === "boolean" || (typeof v === "string" && v.length <= 40)) out.push({ label: k, value: String(v) });
    }
  }
  return out;
}

type Expected = {
  minPhotos?: number; maxPhotos?: number; droneCount?: number; twilightReal?: number; twilightVirtual?: number; virtualStagingCount?: number;
  floorPlan?: boolean; sqft?: number; propertyType?: string; requestedFeatures?: string[]; specialInstructions?: string; source?: Record<string, string>;
};

function expectedRows(e: Expected | null): ExpectedView {
  if (!e) return [];
  const src = e.source ?? {};
  const rows: ExpectedView = [];
  const add = (key: keyof Expected, label: string, value: string | null) => {
    if (value != null) rows.push({ label, value, source: src[key as string] ?? null });
  };
  add("minPhotos", "Photos ordered (at least)", typeof e.minPhotos === "number" ? String(e.minPhotos) : null);
  add("maxPhotos", "Culling target (most)", typeof e.maxPhotos === "number" ? String(e.maxPhotos) : null);
  add("droneCount", "Drone photos", typeof e.droneCount === "number" ? String(e.droneCount) : null);
  add("twilightReal", "Twilight photos", typeof e.twilightReal === "number" ? String(e.twilightReal) : null);
  add("twilightVirtual", "Virtual twilight photos", typeof e.twilightVirtual === "number" ? String(e.twilightVirtual) : null);
  add("virtualStagingCount", "Virtually staged photos", typeof e.virtualStagingCount === "number" ? String(e.virtualStagingCount) : null);
  add("floorPlan", "Floor plan", e.floorPlan ? "Ordered" : null);
  add("sqft", "Size", typeof e.sqft === "number" ? `${e.sqft.toLocaleString("en-US")} sq ft (top of the ordered band)` : null);
  add("propertyType", "Property type", typeof e.propertyType === "string" && e.propertyType ? e.propertyType : null);
  return rows;
}

const COVERAGE = new Set(["MET", "NOT_MET", "UNKNOWN"]);

export async function loadJobDetail(jobId: string, opts: { viewer: Viewer; now?: Date }): Promise<JobDetail | null> {
  const now = opts.now ?? new Date();
  const { viewer } = opts;
  const job = await prisma.photoJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  const settings: PhotoDeliverySettings = await photoDeliverySettings();

  const [project, photos, findings, runs, events, batches, ops] = await Promise.all([
    prisma.project.findUnique({
      where: { id: job.projectId },
      select: {
        id: true, title: true, addressLine: true, city: true, state: true, shootDate: true, paymentStatus: true, aryeoListingId: true, aryeoOrderId: true, clientId: true,
        client: { select: { name: true } }, photographer: { select: { name: true } },
      },
    }),
    prisma.photoAsset.findMany({ where: { jobId }, orderBy: { sequence: "asc" } }),
    // Oct 14 2026: a check Jordan switched off for every shoot is not shown at all (houseRules.ts).
    houseRuleIds().then((off) => prisma.photoQcFinding.findMany({ where: { jobId, status: { not: "SUPERSEDED" }, ...(off.length ? { ruleId: { notIn: off } } : {}) }, orderBy: [{ createdAt: "asc" }] })),
    prisma.photoQcRun.findMany({ where: { jobId }, orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.photoJobEvent.findMany({ where: { jobId }, orderBy: { at: "desc" }, take: 300 }),
    prisma.photoFixBatch.findMany({ where: { jobId }, orderBy: { approvedAt: "desc" }, take: 10 }),
    prisma.photoFixOperation.findMany({
      where: { jobId },
      select: { id: true, batchId: true, photoId: true, strategy: true, status: true, estimatedCredits: true, chargedCredits: true, error: true, seq: true },
      orderBy: [{ photoId: "asc" }, { seq: "asc" }],
    }),
  ]);
  const versions = photos.length
    ? await prisma.photoVersion.findMany({ where: { photoId: { in: photos.map((p) => p.id) } }, orderBy: { createdAt: "asc" } })
    : [];

  const [gateR, stepsR, cartR, creditR] = await Promise.all([
    deliveryGate(jobId).then((v) => ({ v, e: null as string | null })).catch((e: Error) => ({ v: null, e: e.message })),
    deliverySteps(jobId).then((v) => ({ v, e: null as string | null })).catch((e: Error) => ({ v: null, e: e.message })),
    buildFixCart(jobId).then((v) => ({ v, e: null as string | null })).catch((e: Error) => ({ v: null, e: e.message })),
    creditView(now).catch(() => null),
  ]);

  // Delivery order: the steps' order (a person's order, else the QC suggestion,
  // else AutoHDR's) for included photos; excluded ones follow, so they can be put back.
  const orderIds = stepsR.v?.order.map((o) => o.photoId) ?? photos.filter((p) => p.status === "ACTIVE").map((p) => p.id);
  const deliveryNameOf = new Map(stepsR.v?.order.map((o) => [o.photoId, o.deliveryName]) ?? []);
  const position = new Map(orderIds.map((id, i) => [id, i + 1]));
  const fixingPhotos = new Set(ops.filter((o) => RUNNING_OPS.has(o.status)).map((o) => o.photoId));
  const versionsByPhoto = new Map<string, typeof versions>();
  for (const v of versions) {
    const list = versionsByPhoto.get(v.photoId);
    if (list) list.push(v);
    else versionsByPhoto.set(v.photoId, [v]);
  }
  const photoViews: PhotoView[] = photos.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    excludeReason: p.excludeReason,
    sequence: p.sequence,
    roomType: p.roomType,
    roomLabel: prettyRoom(p.roomType ?? p.sequenceGroup),
    description: p.description,
    features: (parse<unknown[]>(p.featuresJson) ?? []).filter((x): x is string => typeof x === "string").slice(0, 12),
    width: p.width ?? cvFullSize(p.cvJson)?.w ?? null,
    height: p.height ?? cvFullSize(p.cvJson)?.h ?? null,
    contentHash: p.contentHash,
    sourceKind: p.sourceKind,
    sourceUrl: p.sourceKind === "ARYEO" ? p.sourceUrl : null,
    dropboxPath: p.dropboxPath,
    isAerial: p.isAerial,
    isTwilight: p.isTwilight,
    isVirtuallyStaged: p.isVirtuallyStaged,
    heroScore: p.heroScore,
    verdict: p.verdict,
    cv: cvSummary(p.cvJson),
    versions: (versionsByPhoto.get(p.id) ?? []).map((v) => ({
      id: v.id,
      label: v.label,
      source: v.source,
      contentHash: v.contentHash,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
      width: v.width,
      height: v.height,
      current: !!p.contentHash && v.contentHash === p.contentHash,
    })),
    position: p.status === "ACTIVE" ? position.get(p.id) ?? null : null,
    deliveryName: p.status === "ACTIVE" ? deliveryNameOf.get(p.id) ?? null : null,
    fixing: fixingPhotos.has(p.id),
  }));
  const rank = (p: PhotoView) => (p.status === "ACTIVE" ? p.position ?? 9_000 + p.sequence : p.status === "EXCLUDED" ? 20_000 + p.sequence : 40_000 + p.sequence);
  photoViews.sort((a, b) => rank(a) - rank(b));

  const findingViews: FindingView[] = findings.map((f) => {
    const raw = parse<Record<string, unknown>>(f.rawJson);
    const bbox = parse<unknown[]>(f.bboxJson);
    const cov = typeof raw?.status === "string" && COVERAGE.has(raw.status) ? raw.status : null;
    return {
      id: f.id,
      photoId: f.photoId,
      photoIds: (parse<unknown[]>(f.photoIdsJson) ?? []).filter((x): x is string => typeof x === "string"),
      ruleId: f.ruleId,
      ruleLabel: ruleById(f.ruleId)?.shortLabel ?? (f.ruleId === "OTHER_DEFECT" ? "" : f.ruleId),
      groupKey: f.groupKey,
      pass: f.pass,
      source: f.source,
      specificIssue: f.specificIssue,
      explanation: f.explanation,
      locationText: f.locationText,
      bbox: Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => typeof n === "number" && Number.isFinite(n)) ? (bbox as [number, number, number, number]) : null,
      severity: (["CRITICAL", "MAJOR", "MINOR"].includes(f.severity) ? f.severity : "MINOR") as Severity,
      confidence: f.confidence,
      responsibility: f.responsibility,
      postFixable: f.postFixable,
      reshootMayBeNeeded: f.reshootMayBeNeeded,
      isPermanentFeature: f.isPermanentFeature,
      privacySensitive: f.privacySensitive,
      recommendedAction: f.recommendedAction,
      fixStrategy: f.fixStrategy,
      status: f.status,
      statusReason: f.statusReason,
      decidedBy: f.decidedBy,
      decidedAt: iso(f.decidedAt),
      arbitration: f.arbitration,
      coverageStatus: f.pass === "P4_ORDER" ? cov : null,
    };
  });

  // The engine's view of each group (severity after escalation and overrides,
  // and whether it holds delivery), keyed like the screen's own grouping.
  const groupMeta: Record<string, GroupMeta> = {};
  const verdict = findings.length ? await verdictModule() : null;
  if (verdict) {
    const profile = project?.clientId ? await prisma.clientQcProfile.findUnique({ where: { clientId: project.clientId }, select: { ruleOverridesJson: true } }).catch(() => null) : null;
    const res = verdict.groupFindings(findings, {
      floor: settings.displayConfidenceFloor,
      overrides: mergeOverrides(await houseOverrides(), overridesOf(profile?.ruleOverridesJson)),
      excludedPhotoIds: photos.filter((p) => p.status === "EXCLUDED").map((p) => p.id),
    });
    for (const g of [...res.groups, ...res.lowConfidence]) groupMeta[g.key] = { severity: g.severity, escalated: g.escalated, escalationReason: g.escalationReason, holds: g.holds };
  }

  const cart: CartView | null = cartR.v
    ? {
        lines: cartR.v.lines.map((l) => ({ ...l, findingIds: [...l.findingIds] })),
        estimatedCredits: cartR.v.estimatedCredits,
        balance: cartR.v.balance,
        autohdrConnected: cartR.v.autohdrConnected,
        photoshootLinked: cartR.v.photoshootLinked,
        adminCap: cartR.v.adminCap,
        blockers: cartR.v.blockers,
        criticalThreshold: creditR?.thresholds.critical ?? 100,
        usdPerCredit: viewer.canSeeMoney ? cartR.v.usdPerCredit : null,
      }
    : null;
  const gate: GateView | null = gateR.v ? { ...gateR.v, checks: gateR.v.checks.map((c) => ({ ...c })) } : null;
  const steps: StepsView | null = stepsR.v
    ? {
        replacements: (stepsR.v.replacements ?? []).map((r) => ({ ...r })),
        listingUrl: stepsR.v.listingUrl,
        orderUrl: stepsR.v.orderUrl,
        folderPath: stepsR.v.folderPath,
        folderLabel: stepsR.v.folderLabel,
        order: stepsR.v.order,
        message: stepsR.v.message,
      }
    : null;

  const runViews: RunView[] = runs.map((r) => {
    const models = parse<Record<string, unknown>>(r.modelsJson);
    return {
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      shadow: r.shadow,
      passes: (parse<unknown[]>(r.passesJson) ?? []).filter((x): x is string => typeof x === "string"),
      models: models && typeof models === "object" ? [...new Set(Object.values(models).filter((x): x is string => typeof x === "string"))] : [],
      photoCount: r.photoCount,
      verdict: r.verdict,
      error: r.error,
      startedAt: r.startedAt.toISOString(),
      finishedAt: iso(r.finishedAt),
      costUsd: viewer.canSeeMoney ? r.costUsd : null,
    };
  });

  const eventViews: EventView[] = events.map((e) => {
    const data = parse<Record<string, unknown>>(e.dataJson);
    const detail = data && typeof data === "object" && Object.keys(data).length ? JSON.stringify(data, null, 1).slice(0, 1200) : null;
    return { id: e.id, at: e.at.toISOString(), actor: e.actor, action: e.action, detail };
  });

  const opsByBatch = new Map<string, typeof ops>();
  for (const o of ops) {
    const list = opsByBatch.get(o.batchId);
    if (list) list.push(o);
    else opsByBatch.set(o.batchId, [o]);
  }
  const batchViews: FixBatchView[] = batches.map((b) => ({
    id: b.id,
    mode: b.mode,
    status: b.status,
    estimatedCredits: b.estimatedCredits,
    approvedBy: b.approvedBy,
    approvedAt: b.approvedAt.toISOString(),
    operations: (opsByBatch.get(b.id) ?? []).map((o) => ({ id: o.id, photoId: o.photoId, strategy: o.strategy, status: o.status, estimatedCredits: o.estimatedCredits, chargedCredits: o.chargedCredits, error: o.error })),
    estimatedUsd: viewer.canSeeMoney ? b.estimatedUsdCents / 100 : null,
  }));

  const expected = parse<Expected>(job.expectedJson);
  const active = photos.filter((p) => p.status === "ACTIVE");
  const coverageCounts: CoverageCounts = {
    photos: active.length,
    aerial: active.filter((p) => p.isAerial).length,
    twilight: active.filter((p) => p.isTwilight).length,
    staged: active.filter((p) => p.isVirtuallyStaged).length,
  };
  // The P4 checklist's MET items, when the QC engine kept them in the run summary.
  const lastRun = runs[0] ?? null;
  const summary = parse<{ coverage?: { label?: string; status?: string; evidence?: string }[] }>(runs.find((r) => r.id === job.lastQcRunId)?.summaryJson ?? lastRun?.summaryJson);
  const coverageMet = Array.isArray(summary?.coverage)
    ? summary!.coverage.filter((c) => c && c.status === "MET" && typeof c.label === "string").map((c) => ({ label: c.label as string, evidence: typeof c.evidence === "string" ? c.evidence : null })).slice(0, 60)
    : [];

  return {
    groupMeta,
    header: {
      id: job.id,
      projectId: job.projectId,
      street: streetOf(project),
      cityLine: project ? [project.city, project.state].filter(Boolean).join(", ") || null : null,
      clientId: project?.clientId ?? null,
      clientName: project?.client?.name ?? null,
      photographerName: project?.photographer?.name ?? null,
      shootDate: iso(project?.shootDate),
      slaDueAt: iso(job.slaDueAt),
      deliveredAt: iso(job.deliveredAt),
      stage: job.stage,
      stageLabel: stageLabel(job.stage),
      holdReason: job.holdReason,
      holdNote: job.holdNote,
      holdResumeStage: job.holdResumeStage,
      qcVerdict: job.qcVerdict,
      qcShadow: job.qcShadow,
      qcRequestedAt: iso(job.qcRequestedAt),
      creditsSpent: job.creditsSpent,
      listingUrl: project?.aryeoListingId ? aryeoListingUrl(project.aryeoListingId) : null,
      orderUrl: project?.aryeoOrderId ? aryeoOrderUrl(project.aryeoOrderId) : null,
      paymentStatus: project?.paymentStatus ?? null,
      lastError: job.lastError,
      autohdrPhotoshootId: job.autohdrPhotoshootId,
      autohdrShootName: job.autohdrShootName,
      autohdrExpiresAt: job.autohdrCreatedAt ? new Date(job.autohdrCreatedAt.getTime() + 7 * DAY).toISOString() : null,
      lastRunCostUsd: viewer.canSeeMoney && lastRun ? lastRun.costUsd : null,
      lastRunAt: lastRun ? lastRun.startedAt.toISOString() : null,
    },
    photos: photoViews,
    heroPhotoId: job.heroPhotoId,
    findings: findingViews,
    displayFloor: settings.displayConfidenceFloor,
    cart,
    cartError: cartR.e,
    gate,
    gateError: gateR.e,
    steps,
    stepsError: stepsR.e,
    runs: runViews,
    events: eventViews,
    batches: batchViews,
    expected: expectedRows(expected),
    specialInstructions: typeof expected?.specialInstructions === "string" ? expected.specialInstructions : null,
    requestedFeatures: Array.isArray(expected?.requestedFeatures) ? expected!.requestedFeatures.filter((x): x is string => typeof x === "string") : [],
    coverageCounts,
    coverageMet,
    qcEnabled: settings.qcEnabled,
    freeCheck: settings.freeCheck,
    paidQcAuto: settings.paidQcAuto,
    intake: (await prisma.photoIntakeBatch.findMany({ where: { projectId: job.projectId }, orderBy: { batchNo: "asc" }, select: { batchNo: true, state: true, fileCount: true, expectedPhotos: true, sentAt: true, doneAt: true, imageCount: true, lastError: true } }).catch(() => [])).map((b) => ({ ...b, sentAt: b.sentAt?.toISOString() ?? null, doneAt: b.doneAt?.toISOString() ?? null })),
    nowIso: now.toISOString(),
  };
}

// ---- credits page (plan 10.4) ----------------------------------------------------------------

const SPEND_ROWS: { key: string; label: string; match: (kind: string, credits: number) => boolean }[] = [
  { key: "DOWNLOAD", label: "Downloads (edited photos)", match: (k) => k === "DOWNLOAD" },
  { key: "TRANSFORM", label: "Fixes (transforms)", match: (k) => k === "TRANSFORM" },
  { key: "STYLE", label: "Style re-renders", match: (k) => k === "STYLE" },
  { key: "PRESET", label: "Presets", match: (k) => k === "PRESET" },
  { key: "REFUND", label: "Refunds from AutoHDR", match: (k) => k === "REFUND" },
  { key: "ADJ_OUT", label: "Used outside the pipeline", match: (k, c) => k === "ADJUSTMENT" && c < 0 },
  { key: "ADJ_IN", label: "Refills and credits returned", match: (k, c) => k === "ADJUSTMENT" && c > 0 },
];

export async function loadCreditsPage(viewer: Viewer, opts: { now?: Date; showChecks?: boolean; limit?: number } = {}): Promise<CreditsPageData> {
  const now = opts.now ?? new Date();
  const limit = Math.max(20, Math.min(1000, opts.limit ?? 100));
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since14 = new Date(now.getTime() - 14 * DAY);
  const [view, alert, snaps, ledger, recent] = await Promise.all([
    creditView(now),
    creditAlertState(),
    prisma.autohdrCreditEntry.findMany({ where: { kind: "BALANCE_SNAPSHOT", at: { gte: since30 }, balanceAfter: { not: null } }, orderBy: { at: "asc" }, select: { at: true, balanceAfter: true } }),
    prisma.autohdrCreditEntry.findMany({ where: opts.showChecks ? {} : { kind: { not: "BALANCE_SNAPSHOT" } }, orderBy: { at: "desc" }, take: limit + 1 }),
    prisma.autohdrCreditEntry.findMany({ where: { at: { gte: since30 }, kind: { not: "BALANCE_SNAPSHOT" } }, select: { kind: true, credits: true, at: true } }),
  ]);

  // Downsample to one point per 3 hours (the last reading in each), so a
  // month of 15-minute snapshots stays a light sparkline.
  const buckets = new Map<number, { at: string; balance: number }>();
  for (const s of snaps) if (s.balanceAfter != null) buckets.set(Math.floor(s.at.getTime() / (3 * HOUR)), { at: s.at.toISOString(), balance: s.balanceAfter });
  const snapshots = [...buckets.values()];

  const rows = ledger.slice(0, limit);
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => !!x))];
  const jobs = jobIds.length ? await prisma.photoJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, projectId: true } }) : [];
  const projects = jobs.length ? await prisma.project.findMany({ where: { id: { in: jobs.map((j) => j.projectId) } }, select: { id: true, title: true, addressLine: true } }) : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const labelOfJob = new Map(jobs.map((j) => [j.id, streetOf(projectById.get(j.projectId))]));
  const ledgerRows: LedgerRowView[] = rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    kind: r.kind,
    credits: r.credits,
    balanceAfter: r.balanceAfter,
    jobId: r.jobId,
    jobLabel: r.jobId ? labelOfJob.get(r.jobId) ?? null : null,
    note: r.note,
  }));

  const spend: SpendRow[] = SPEND_ROWS.map((row) => {
    let d14 = 0, d30 = 0;
    for (const e of recent) {
      if (!row.match(e.kind, e.credits)) continue;
      d30 += e.credits;
      if (e.at >= since14) d14 += e.credits;
    }
    return { key: row.key, label: row.label, d14, d30 };
  });

  return {
    credit: creditStrip(view, viewer),
    snapshots,
    ledger: ledgerRows,
    ledgerHasMore: ledger.length > limit,
    spend,
    alert: { below250Sent: alert.below250Sent, below100Sent: alert.below100Sent, lastBalance: alert.lastBalance, lastCheckedAt: alert.lastCheckedAt },
    billingUrl: AUTOHDR_BILLING_URL,
  };
}

// ---- settings page (owner) ---------------------------------------------------------------------

/** The rule picker's list: id, label, section and default severity (no prompt text). */
export function ruleOptions(): RuleOption[] {
  return RULES.map((r) => ({ id: r.id, label: r.shortLabel, section: r.sectionName, severity: r.defaultSeverity }));
}

/** Clients that have photo jobs, with their QC profile (if any). */
export async function loadClientProfiles(): Promise<ClientProfileView[]> {
  const jobs = await prisma.photoJob.findMany({ select: { projectId: true, stage: true } });
  if (!jobs.length) return [];
  const projects = await prisma.project.findMany({ where: { id: { in: [...new Set(jobs.map((j) => j.projectId))] } }, select: { id: true, clientId: true } });
  const clientOf = new Map(projects.map((p) => [p.id, p.clientId]));
  const counts = new Map<string, { all: number; open: number }>();
  for (const j of jobs) {
    const c = clientOf.get(j.projectId);
    if (!c) continue;
    const rec = counts.get(c) ?? { all: 0, open: 0 };
    rec.all++;
    if (j.stage !== "DELIVERED") rec.open++;
    counts.set(c, rec);
  }
  const clientIds = [...counts.keys()];
  const [clients, profiles] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, company: true } }),
    prisma.clientQcProfile.findMany({ where: { clientId: { in: clientIds } } }),
  ]);
  const profileOf = new Map(profiles.map((p) => [p.clientId, p]));
  return clients
    .map((c) => {
      const p = profileOf.get(c.id);
      const overrides = (parse<RuleOverrideView[]>(p?.ruleOverridesJson) ?? []).filter((o) => o && typeof o.ruleId === "string");
      return {
        clientId: c.id,
        clientName: c.name,
        company: c.company,
        jobCount: counts.get(c.id)?.all ?? 0,
        openJobCount: counts.get(c.id)?.open ?? 0,
        slaHours: p?.slaHours ?? null,
        notes: p?.notes ?? "",
        deliveryMessage: p?.deliveryMessage ?? "",
        overrides,
        updatedAt: iso(p?.updatedAt),
        updatedBy: p?.updatedBy ?? null,
      };
    })
    .sort((a, b) => b.openJobCount - a.openJobCount || a.clientName.localeCompare(b.clientName));
}
