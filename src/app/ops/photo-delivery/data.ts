import "server-only";

import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney, isOffice } from "@/lib/auth/access";
import { STAGE_LABEL, type JobStage } from "@/lib/photoDelivery/jobState";
import { photoDeliverySettings } from "@/lib/photoDelivery/settings";
import { creditAlertState, creditView, type CreditView } from "@/lib/photoDelivery/credits";
import { buildFixCart } from "@/lib/photoDelivery/fixes";
import { houseOverrides, mergeOverrides } from "@/lib/photoDelivery/houseRules";
import { ALWAYS_FIX } from "@/lib/photoDelivery/fixPolicy";
import { deliveryGate, deliverySteps, type GateResult } from "@/lib/photoDelivery/delivery";
import { holdingFor, needsListingUpdate, type HoldingBase } from "@/lib/photoDelivery/holding";
import { checkEveryMs } from "@/lib/photoDelivery/verifySweep";
import { RULES, isExteriorFinding, ruleById } from "@/lib/photoDelivery/registry";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";
import { AUTOHDR_BILLING_URL } from "@/lib/integrations/autohdr";
import { prettyRoom } from "@/components/photoDelivery/format";
import { HUB_EDIT, hubMeta, isHubEditHash } from "@/lib/photoDelivery/photoEdit";
import { BY_HAND_LABEL, ON_LISTING } from "@/lib/photoDelivery/listingMatch";
import type { RuleOverride } from "@/lib/photoDelivery/registry";
import type {
  CartView, ClientProfileView, CoverageCounts, CreditStripView, CreditsPageData, CvMetric, EventView, ExpectedView, FindingView, FixBatchView, VersionView,
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
//
// VIEW ONLY (Oct 22 2026): the creative manager reads the desk (Viewer
// `readOnly`). For them the loaders also leave out every credit amount (the
// strip, the job's credits spent, the Fix Cart, the history's batches and
// event lines), payment status, and the download links of fixed files, and
// they skip the reads only an acting desk needs (the Fix Cart, which can ask
// AutoHDR for its price list; the credit balance).
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

// Read once per page render (React cache).
const houseOverridesOnce = cache(houseOverrides);
const houseRuleIds = async () => (await houseOverridesOnce()).map((o) => o.ruleId);
const overridesOf = (json: string | null | undefined): RuleOverride[] => (parse<RuleOverride[]>(json) ?? []).filter((o) => o && typeof o.ruleId === "string");

/**
 * Open QC issues as TICKETS by severity (one per rule and groupKey, the
 * engine's effective severity). Oct 22 2026: one count for the board's chips
 * and the job page's "N issues to decide", so the two always agree.
 */
function ticketCounts(verdict: VerdictModule | null, open: Parameters<VerdictModule["groupFindings"]>[0], floor: number, overrides: RuleOverride[]): Record<Severity, number> {
  const rec: Record<Severity, number> = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  if (verdict) {
    for (const g of verdict.groupFindings(open, { floor, overrides }).groups) rec[g.severity] += 1;
  } else {
    for (const f of open) if (f.confidence >= floor && (f.severity === "CRITICAL" || f.severity === "MAJOR" || f.severity === "MINOR")) rec[f.severity] += 1;
  }
  return rec;
}

/** The photos edited in the hub whose old file is still on the Aryeo listing (holding.needsListingUpdate), in gallery order. Pure. */
export function listingUpdatesOf(photos: { id: string; name: string; status: string; sourceKind: string; contentHash: string | null }[], stage: string): HoldingBase["listingUpdates"] {
  const due = photos.filter((p) => (p.status === "ACTIVE" || p.status === ON_LISTING) && needsListingUpdate(p, stage));
  return { photoIds: due.map((p) => p.id), names: due.map((p) => p.name) };
}

const VISIT_WAIT = /split job: waiting for the photos from ([^;]+);/;
/**
 * "Tue, Oct 21" while a split job waits for a later visit's photos (the
 * sync's own line, jobs.ts), from the job's events, newest first. Null once
 * that visit's photos are linked, or when the job is not editing. Pure.
 */
export function waitingForVisitOf(stage: string, events: { action: string }[]): string | null {
  if (stage !== "EDITING") return null;
  for (const e of events) {
    const m = VISIT_WAIT.exec(e.action);
    if (m) return m[1].trim();
    if (e.action.startsWith("linked to this visit's AutoHDR shoot") || / → EDITING\b/.test(e.action)) return null;
  }
  return null;
}

// ---- who is looking ------------------------------------------------------------------------

/**
 * The person viewing, for display decisions (dollars, owner-only controls).
 * Authorization itself is requirePageAccess on the page and the guards in
 * actions.ts. Local dev with the gate off renders as the owner would see it,
 * exactly as the guards are no-ops there.
 *
 * `readOnly` (Oct 22 2026): everyone outside the office (owner and admin)
 * reads the desk without a single control: the creative manager is the one
 * such viewer the pages let in. It follows the EFFECTIVE role, so the owner
 * previewing as James sees James's desk; the actions refuse a preview anyway.
 */
export async function loadViewer(): Promise<Viewer | null> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (authEnforced()) return null;
    return { role: "OWNER", name: "local dev", isOwner: true, canSeeMoney: true, readOnly: false };
  }
  return { role: me.role, name: me.name || me.email, isOwner: me.role === "OWNER", canSeeMoney: canSeeMoney(me.role), readOnly: !isOffice(me.role) };
}

/**
 * What a line of the job's history may say to this viewer (Oct 22 2026).
 * Dollars are the owner's: a few automatic lines carry them ("3 credits
 * ($1.50; target $5.00, max $8.00)"), and the office never sees money. Credit
 * amounts are the office's: a view-only viewer reads neither.
 */
/** A key that holds dollars (photo audit M7): costUsd, estimatedUsd, usdPerCredit, priceUsd, fixMaxUsd, cents… Credits are not dollars (Kyle may see them). */
const MONEY_KEY = /usd|dollar|cents|price|cost/i;

/** Event details without their dollar fields, at any depth (Oct 22 2026, photo audit M7). Pure. */
export function moneyFreeData(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(moneyFreeData);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !MONEY_KEY.test(k)).map(([k, x]) => [k, moneyFreeData(x)]));
  return v;
}

export function eventTextFor(text: string, viewer: Pick<Viewer, "canSeeMoney" | "readOnly">): string {
  let t = text;
  if (!viewer.canSeeMoney) t = t.replace(/\s*\(\$[^()]*\)/g, "").replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, "an amount");
  if (viewer.readOnly) {
    t = t
      .replace(/\s*\([^()]*\b\d[\d,]*\s+(?:AutoHDR\s+)?credits?\b[^()]*\)/gi, "")
      .replace(/,\s*\d[\d,]*\s+(?:AutoHDR\s+)?credits?\b/gi, "")
      .replace(/\b\d[\d,]*\s+(?:AutoHDR\s+)?credits?\b/gi, "credits");
  }
  return t;
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
  // A view-only viewer gets no credits at all (Oct 22 2026): not read, not sent.
  const readOnly = !!viewer.readOnly;
  const [credit, settings] = await Promise.all([readOnly ? null : creditView().catch(() => null), photoDeliverySettings()]);
  return { credit: credit ? creditStrip(credit, viewer) : null, qcShadow: settings.qcShadow, isOwner: viewer.isOwner, readOnly };
}

// ---- the queue (plan 9.3) --------------------------------------------------------------------

/**
 * Board columns, in pipeline order. EDITED (gallery landed, QC not started)
 * sits with QC: with QC off it is "landed, waiting for a check". A client's
 * revision waits for a decision like QC findings do (plan 3.3 loop).
 */
export const QUEUE_COLUMNS: { key: QueueColumnKey; label: string; hint: string; stages: JobStage[] }[] = [
  { key: "editing", label: "Editing", hint: "Waiting for AutoHDR's edits", stages: ["EDITING", "EDIT_FAILED"] },
  { key: "qc", label: "Checking", hint: "Edits landed, being checked", stages: ["EDITED", "QC_RUNNING"] },
  { key: "decision", label: "Needs decision", hint: "Issues found, or a client revision", stages: ["QC_REVIEW", "REVISION_REQUESTED"] },
  { key: "fixing", label: "Fixing", hint: "Fixes running in AutoHDR", stages: ["FIXING"] },
  { key: "hold", label: "On hold", hint: "Blocked until the hold is released", stages: ["ON_HOLD"] },
  { key: "ready", label: "Ready to review", hint: "Checks passed: Kyle reviews, then approves", stages: ["READY"] },
  { key: "delivering", label: "Delivering", hint: "Waiting for Aryeo to confirm", stages: ["DELIVERING", "DELIVERY_MISMATCH"] },
  { key: "delivered", label: "Delivered", hint: "Delivered in the last 7 days", stages: ["DELIVERED"] },
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

/** What a queue card needs of its cover photo. */
const COVER_FIELDS = { id: true, jobId: true, contentHash: true, sourceKind: true, sourceUrl: true, roomType: true } as const;

/**
 * `viewer`: a view-only viewer's cards carry no payment status (Oct 22 2026); without one, the office's board.
 * `holding` (Oct 22 2026): each card also says what holds it, in one line, and the add-on work still to
 * confirm (boardHolding). The Photo Delivery board asks for it; Home's QC counts do not.
 */
export async function loadQueue(opts: { now?: Date; filters?: Partial<QueueFilters>; viewer?: Pick<Viewer, "readOnly">; holding?: boolean } = {}): Promise<QueueData> {
  const now = opts.now ?? new Date();
  const filters: QueueFilters = { client: opts.filters?.client || null, photographer: opts.filters?.photographer || null, atRisk: !!opts.filters?.atRisk };
  const since = new Date(now.getTime() - 7 * DAY);
  const [settings, jobs] = await Promise.all([
    photoDeliverySettings(),
    prisma.photoJob.findMany({
      where: {
        OR: [{ stage: { not: "DELIVERED" } }, { stage: "DELIVERED", OR: [{ deliveredAt: { gte: since } }, { deliveredAt: null, stageChangedAt: { gte: since } }] }],
      },
      select: { id: true, projectId: true, stage: true, slaDueAt: true, qcShadow: true, heroPhotoId: true, holdReason: true, holdNote: true, lastError: true, deliveredAt: true, stageChangedAt: true, finalsCount: true, deliveryCheckNote: true },
      orderBy: { slaDueAt: { sort: "asc", nulls: "last" } },
      take: 400,
    }),
  ]);
  const ids = jobs.map((j) => j.id);
  const heroIds = jobs.map((j) => j.heroPhotoId).filter((x): x is string => !!x);
  const [projects, heroes, photoStats, counts, batches] = ids.length
    ? await Promise.all([
        prisma.project.findMany({
          where: { id: { in: jobs.map((j) => j.projectId) } },
          select: {
            id: true, title: true, addressLine: true, status: true, shootDate: true, paymentStatus: true, clientId: true, photographerId: true, aryeoListingId: true, aryeoOrderId: true,
            client: { select: { name: true } }, photographer: { select: { name: true } },
          },
        }),
        // The card's cover: the hero, read by id (not every photo of every job).
        heroIds.length ? prisma.photoAsset.findMany({ where: { id: { in: heroIds }, status: "ACTIVE" }, select: COVER_FIELDS }) : [],
        // Included photos per job, and the first one's place for a job with no hero.
        // Oct 22 2026: a split job counts the photos already delivered on the listing too, and shows the listing's cover.
        prisma.photoAsset.groupBy({ by: ["jobId", "status"], where: { jobId: { in: ids }, status: { in: ["ACTIVE", ON_LISTING] } }, _count: { _all: true }, _min: { sequence: true } }),
        prisma.photoQcFinding.findMany({
          where: { jobId: { in: ids }, status: "OPEN", confidence: { gte: settings.displayConfidenceFloor } },
          select: { id: true, jobId: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true, source: true },
        }),
        prisma.photoFixBatch.findMany({ where: { jobId: { in: ids } }, orderBy: { approvedAt: "desc" }, select: { id: true, jobId: true, status: true } }),
      ])
    : [[], [], [], [], []];

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const statsByJob = new Map<string, { count: number; first: number | null; listed: boolean }>();
  for (const r of photoStats) {
    const cur = statsByJob.get(r.jobId) ?? { count: 0, first: null, listed: false };
    const listed = r.status === ON_LISTING;
    // The listing's cover (its first photo) leads a split job's card; otherwise the first included photo.
    statsByJob.set(r.jobId, { count: cur.count + r._count._all, first: listed || !cur.listed ? r._min.sequence : cur.first, listed: cur.listed || listed });
  }
  const heroById = new Map(heroes.map((h) => [h.id, h]));
  const ownHero = (j: (typeof jobs)[number]) => {
    const h = j.heroPhotoId ? heroById.get(j.heroPhotoId) : undefined;
    return h?.jobId === j.id ? h : null;
  };
  // A job with no hero shows its first included photo (by sequence): one row
  // per job, matched on the place the groupBy found. (Prisma's `distinct`
  // would read every photo of those jobs and drop the rest in memory.)
  const needFirst = jobs.filter((j) => (!ownHero(j) || statsByJob.get(j.id)?.listed) && statsByJob.get(j.id)?.first != null);
  const latestBatch = new Map<string, { id: string; status: string }>();
  for (const b of batches) if (!latestBatch.has(b.jobId)) latestBatch.set(b.jobId, b);
  const clientIds = [...new Set(projects.map((p) => p.clientId))];

  // Open issues by severity, counted as TICKETS (one per rule and groupKey,
  // with the engine's effective severity) when the QC engine is available.
  const [verdict, profileRows, house, opRows, firsts] = await Promise.all([
    counts.length ? verdictModule() : null,
    counts.length && clientIds.length ? prisma.clientQcProfile.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, ruleOverridesJson: true } }) : [],
    houseOverridesOnce(),
    latestBatch.size
      ? prisma.photoFixOperation.groupBy({ by: ["batchId", "status"], where: { batchId: { in: [...latestBatch.values()].map((b) => b.id) } }, _count: { _all: true } })
      : [],
    needFirst.length
      ? prisma.photoAsset.findMany({ where: { status: { in: ["ACTIVE", ON_LISTING] }, OR: needFirst.map((j) => ({ jobId: j.id, sequence: statsByJob.get(j.id)!.first! })) }, select: COVER_FIELDS })
      : [],
  ]);
  const firstByJob = new Map<string, (typeof firsts)[number]>();
  for (const f of firsts) if (!firstByJob.has(f.jobId)) firstByJob.set(f.jobId, f);
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
    const clientId = projectById.get(projectOfJob.get(jobId) ?? "")?.clientId;
    issuesByJob.set(jobId, ticketCounts(verdict, list, settings.displayConfidenceFloor, (clientId ? overridesByClient.get(clientId) : null) ?? house));
  }
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
    const hero = (statsByJob.get(j.id)?.listed ? firstByJob.get(j.id) : undefined) ?? ownHero(j) ?? firstByJob.get(j.id) ?? null;
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
      photoCount: statsByJob.get(j.id)?.count || j.finalsCount,
      issues: issuesByJob.get(j.id) ?? { CRITICAL: 0, MAJOR: 0, MINOR: 0 },
      shadow: j.qcShadow,
      hero: hero ? { photoId: hero.id, hash: hero.contentHash, fallbackUrl: hero.sourceKind === "ARYEO" ? hero.sourceUrl : null, alt: `${streetOf(p)}: ${prettyRoom(hero.roomType)}` } : null,
      fix: batch ? fixStatusOf(batch.status, opsByBatch.get(batch.id) ?? new Map()) : null,
      paymentStatus: opts.viewer?.readOnly ? null : p?.paymentStatus ?? null,
      // Plan 9.3: amber at 6 h left; "at risk" is anything inside that or late.
      atRisk: !delivered && left != null && left < 6 * HOUR,
      holdReason: j.holdReason,
      lastError: j.lastError,
    });
  }

  // Oct 22 2026: what holds each job, in one line (the job page's first item), and the add-ons to confirm.
  if (opts.holding && cards.length) {
    const held = await boardHolding(
      jobs
        .filter((j) => cards.some((c) => c.id === j.id))
        .map((j) => {
          const p = projectById.get(j.projectId);
          return {
            jobId: j.id,
            projectId: j.projectId,
            stage: j.stage,
            holdReason: j.holdReason,
            holdNote: j.holdNote,
            lastError: j.lastError,
            waitingForVisit: null,
            photographer: p?.photographer?.name ?? null,
            decisions: (({ CRITICAL, MAJOR, MINOR }) => ({ critical: CRITICAL, major: MAJOR, minor: MINOR }))(issuesByJob.get(j.id) ?? { CRITICAL: 0, MAJOR: 0, MINOR: 0 }),
            listingUrl: p?.aryeoListingId ? aryeoListingUrl(p.aryeoListingId) : null,
            orderUrl: p?.aryeoOrderId ? aryeoOrderUrl(p.aryeoOrderId) : null,
            deliveryCheckNote: j.deliveryCheckNote,
            listingUpdates: { photoIds: [], names: [] }, // read for the whole board in boardHolding
            rawBatches: null, // read for the board's jobs in Editing in boardHolding (photo audit M3)
            photosRead: j.finalsCount,
          };
        }),
    ).catch((e: unknown) => {
      console.warn("[photo-delivery] the board's holding lines could not be read", (e as Error)?.message);
      return null;
    });
    for (const c of cards) {
      const h = held?.get(c.id);
      c.holding = h?.holding ?? null;
      c.addOns = h?.addOns ?? [];
    }
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

/** The stages where the delivery checklist can be what holds a job (a job before them is held by its own stage first). */
const GATE_STAGES = new Set(["READY", "QC_REVIEW", "DELIVERING", "DELIVERY_MISMATCH", "REVISION_REQUESTED"]);
/** At most this many checklists are read for one board (a few at a time); a job past it shows no line rather than a wrong one. */
const BOARD_GATE_CAP = 40;

/**
 * The board's "what holds it" line for each job (Oct 22 2026): the same
 * holdingFor the job page's panel runs, from the same facts, so the card says
 * what the panel's first line says. The checklist is read (without filing
 * anything first) only where it can be what holds the job; the push runs, a
 * split job's wait and the add-ons are one read each for the whole board.
 */
async function boardHolding(bases: HoldingBase[]): Promise<Map<string, { holding: QueueCard["holding"]; addOns: string[] }>> {
  const out = new Map<string, { holding: QueueCard["holding"]; addOns: string[] }>();
  if (!bases.length) return out;
  const ids = bases.map((b) => b.jobId);
  const editing = bases.filter((b) => b.stage === "EDITING").map((b) => b.jobId);
  const [{ progressOf }, { openAddOnsByProject }] = await Promise.all([import("@/lib/photoDelivery/aryeoPush"), import("@/lib/photoDelivery/addOns")]);
  // Oct 22 2026 (photo audit M3): the raw uploads seen for each job in Editing (none: "Not uploaded yet").
  // A read that fails says nothing (null), never "not uploaded".
  const rawRows = editing.length
    ? await prisma.photoIntakeBatch.groupBy({ by: ["projectId"], where: { projectId: { in: bases.filter((b) => b.stage === "EDITING").map((b) => b.projectId) } }, _count: { _all: true } }).catch(() => null)
    : [];
  const rawCounts = rawRows ? new Map(rawRows.map((r) => [r.projectId, r._count._all])) : null;
  const [settings, conn, runs, events, addOns, edited] = await Promise.all([
    photoDeliverySettings(),
    prisma.connection.findUnique({ where: { provider: "aryeo_web" }, select: { secretEncrypted: true } }).catch(() => null),
    prisma.appSetting.findMany({ where: { key: { in: ids.map((id) => `photo_aryeo_push:${id}`) } }, select: { key: true, value: true } }),
    editing.length
      ? prisma.photoJobEvent.findMany({
          where: { jobId: { in: editing }, OR: [{ action: { contains: "split job: waiting for the photos from" } }, { action: { contains: " → EDITING" } }, { action: { startsWith: "linked to this visit's AutoHDR shoot" } }] },
          orderBy: { at: "desc" },
          select: { jobId: true, action: true },
          take: 300,
        })
      : Promise.resolve([] as { jobId: string; action: string }[]),
    openAddOnsByProject(bases.filter((b) => b.stage !== "DELIVERED").map((b) => b.projectId)).catch(() => new Map<string, string[]>()),
    // Photos edited in the hub (their hash is the hub's own): which still need Update on Aryeo.
    prisma.photoAsset.findMany({
      where: { jobId: { in: ids }, status: { in: ["ACTIVE", ON_LISTING] }, contentHash: { startsWith: "hub-" } },
      orderBy: { sequence: "asc" },
      select: { id: true, jobId: true, name: true, status: true, sourceKind: true, contentHash: true },
    }),
  ]);
  const editedOf = new Map<string, typeof edited>();
  for (const p of edited) editedOf.set(p.jobId, [...(editedOf.get(p.jobId) ?? []), p]);
  const runOf = new Map(runs.map((r) => [r.key.slice("photo_aryeo_push:".length), r.value]));
  const progress = (jobId: string) => {
    const raw = runOf.get(jobId);
    try {
      return raw ? progressOf(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  };
  const eventsOf = new Map<string, { action: string }[]>();
  for (const e of events) eventsOf.set(e.jobId, [...(eventsOf.get(e.jobId) ?? []), e]);
  const gates = new Map<string, GateResult | null>();
  const need = bases.filter((b) => GATE_STAGES.has(b.stage)).slice(0, BOARD_GATE_CAP);
  for (let i = 0; i < need.length; i += 4) {
    await Promise.all(need.slice(i, i + 4).map(async (b) => gates.set(b.jobId, await deliveryGate(b.jobId, { sync: false }).catch(() => null))));
  }
  const push = { mode: settings.aryeoPush, connected: !!conn?.secretEncrypted, sameDayAuto: false };
  for (const b of bases) {
    const extras = addOns.get(b.projectId) ?? [];
    if (GATE_STAGES.has(b.stage) && !gates.has(b.jobId)) {
      out.set(b.jobId, { holding: null, addOns: extras });
      continue;
    }
    const gate = gates.get(b.jobId) ?? null;
    const view = holdingFor({
      ...b,
      rawBatches: b.stage === "EDITING" && rawCounts ? rawCounts.get(b.projectId) ?? 0 : b.rawBatches ?? null,
      waitingForVisit: waitingForVisitOf(b.stage, eventsOf.get(b.jobId) ?? []),
      listingUpdates: listingUpdatesOf(editedOf.get(b.jobId) ?? [], b.stage),
      gate,
      gateError: gate || !GATE_STAGES.has(b.stage) ? null : "not read just now",
      push: { ...push, progress: progress(b.jobId) },
    });
    out.set(b.jobId, { holding: view.line ? { line: view.line, tone: view.tone } : null, addOns: extras });
  }
  return out;
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
  minPhotos?: number; maxPhotos?: number; droneCount?: number; twilightReal?: number; twilightVirtual?: number; virtualStagingCount?: number; virtualStagingUnknown?: boolean;
  floorPlan?: boolean; sqft?: number; propertyType?: string; requestedFeatures?: string[]; specialInstructions?: string; source?: Record<string, string>;
  bedrooms?: number; bathrooms?: number;
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
  // Oct 23 2026: a staging line that does not say how many is said so, never guessed (stagingCount.ts).
  add("virtualStagingCount", "Virtually staged photos", e.virtualStagingUnknown ? "Not on the order: ask the office" : typeof e.virtualStagingCount === "number" ? String(e.virtualStagingCount) : null);
  add("floorPlan", "Floor plan", e.floorPlan ? "Ordered" : null);
  add("sqft", "Size", typeof e.sqft === "number" ? `${e.sqft.toLocaleString("en-US")} sq ft (top of the ordered band)` : null);
  add("propertyType", "Property type", typeof e.propertyType === "string" && e.propertyType ? e.propertyType : null);
  add("bedrooms", "Bedrooms", typeof e.bedrooms === "number" ? String(e.bedrooms) : null);
  add("bathrooms", "Bathrooms", typeof e.bathrooms === "number" ? String(e.bathrooms) : null);
  return rows;
}

const COVERAGE = new Set(["MET", "NOT_MET", "UNKNOWN"]);

/** What the job page reads of a photo (not derivJson and the other bookkeeping columns). */
const PHOTO_FIELDS = {
  id: true, name: true, status: true, excludeReason: true, sequence: true, roomType: true, sequenceGroup: true, description: true, featuresJson: true,
  width: true, height: true, cvJson: true, contentHash: true, sourceKind: true, sourceUrl: true, dropboxPath: true, isAerial: true, isTwilight: true,
  isVirtuallyStaged: true, heroScore: true, verdict: true, autohdrVersionUuid: true, createdAt: true,
} as const;

/** What the job page and the verdict engine read of a finding (the model's raw answer is read only for the P4 checklist). */
const FINDING_FIELDS = {
  id: true, photoId: true, photoIdsJson: true, ruleId: true, groupKey: true, pass: true, source: true, specificIssue: true, explanation: true,
  locationText: true, bboxJson: true, severity: true, confidence: true, responsibility: true, postFixable: true, reshootMayBeNeeded: true,
  isPermanentFeature: true, privacySensitive: true, recommendedAction: true, fixStrategy: true, status: true, statusReason: true, planNote: true,
  decidedBy: true, decidedAt: true, arbitration: true,
} as const;

/** How many of the job's newest events the Activity tab shows. */
const EVENT_LIMIT = 100;

export async function loadJobDetail(jobId: string, opts: { viewer: Viewer; now?: Date }): Promise<JobDetail | null> {
  const now = opts.now ?? new Date();
  const { viewer } = opts;
  const readOnly = !!viewer.readOnly;
  const [job, settings] = await Promise.all([prisma.photoJob.findUnique({ where: { id: jobId } }), photoDeliverySettings()]);
  if (!job) return null;

  // Every read the page needs, in one round: none of them waits for another.
  const outcome = <T,>(p: Promise<T>) => p.then((v) => ({ v, e: null as string | null })).catch((e: Error) => ({ v: null, e: e.message }));
  const projectP = prisma.project.findUnique({
    where: { id: job.projectId },
    select: {
      id: true, title: true, addressLine: true, city: true, state: true, shootDate: true, paymentStatus: true, aryeoListingId: true, aryeoOrderId: true, clientId: true,
      client: { select: { name: true } }, photographer: { select: { name: true } },
    },
  });
  const [project, profile, photos, findingsAll, p4Raw, versions, runs, events, batches, ops, gateR, stepsR, cartR, creditR, aryeoPush, intake] = await Promise.all([
    projectP,
    projectP.then((p) => (p?.clientId ? prisma.clientQcProfile.findUnique({ where: { clientId: p.clientId }, select: { ruleOverridesJson: true } }) : null)).catch(() => null),
    prisma.photoAsset.findMany({ where: { jobId }, orderBy: { sequence: "asc" }, select: PHOTO_FIELDS }),
    // Oct 14 2026: a check Jordan switched off for every shoot is not shown at all (houseRules.ts).
    houseRuleIds().then((off) => prisma.photoQcFinding.findMany({ where: { jobId, status: { not: "SUPERSEDED" }, ...(off.length ? { ruleId: { notIn: off } } : {}) }, orderBy: [{ createdAt: "asc" }], select: FINDING_FIELDS })),
    prisma.photoQcFinding.findMany({ where: { jobId, pass: "P4_ORDER", status: { not: "SUPERSEDED" } }, select: { id: true, rawJson: true } }),
    prisma.photoVersion.findMany({
      where: { photo: { jobId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, photoId: true, label: true, source: true, contentHash: true, createdAt: true, createdBy: true, width: true, height: true, autohdrVersionUuid: true, derivJson: true },
    }),
    prisma.photoQcRun.findMany({ where: { jobId }, orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.photoJobEvent.findMany({ where: { jobId }, orderBy: { at: "desc" }, take: EVENT_LIMIT }),
    prisma.photoFixBatch.findMany({ where: { jobId }, orderBy: { approvedAt: "desc" }, take: 10 }),
    prisma.photoFixOperation.findMany({
      where: { jobId },
      select: { id: true, batchId: true, photoId: true, strategy: true, status: true, estimatedCredits: true, chargedCredits: true, error: true, seq: true },
      orderBy: [{ photoId: "asc" }, { seq: "asc" }],
    }),
    outcome(deliveryGate(jobId)),
    outcome(deliverySteps(jobId)),
    // A view-only viewer has no Fix Cart (it prices fixes, and may read
    // AutoHDR's live price list to do it) and no credit balance (Oct 22 2026).
    readOnly ? { v: null, e: null } : outcome(buildFixCart(jobId)),
    readOnly ? null : creditView().catch(() => null),
    aryeoPushView(job.id),
    prisma.photoIntakeBatch
      .findMany({ where: { projectId: job.projectId }, orderBy: { batchNo: "asc" }, select: { batchNo: true, state: true, fileCount: true, expectedPhotos: true, sentAt: true, doneAt: true, imageCount: true, lastError: true } })
      .catch(() => null), // null: unreadable (never read as "not uploaded", photo audit M3)
  ]);
  const p4RawById = new Map(p4Raw.map((f) => [f.id, f.rawJson]));
  // Oct 15 2026: clutter set aside because the home or the room was not
  // prepared is never shown (prep.ts); the Issues tab says how many.
  const { GATE_BY, gatedBy } = await import("@/lib/photoDelivery/prep");
  const hiddenAsIs = findingsAll.filter((f) => f.status === "IGNORED" && f.decidedBy === GATE_BY.asIs).length;
  const hiddenRooms = findingsAll.filter((f) => f.status === "IGNORED" && gatedBy(f.decidedBy) && f.decidedBy !== GATE_BY.asIs).length;
  const findings = findingsAll.filter((f) => !(f.status === "IGNORED" && gatedBy(f.decidedBy)));

  // Delivery order: the steps' order (a person's order, else the QC suggestion,
  // else AutoHDR's) for included photos; excluded ones follow, so they can be put back.
  const orderIds = stepsR.v?.order.map((o) => o.photoId) ?? photos.filter((p) => p.status === "ACTIVE").map((p) => p.id);
  const deliveryNameOf = new Map(stepsR.v?.order.map((o) => [o.photoId, o.deliveryName]) ?? []);
  // Oct 22 2026 (615 Cliff Ln): a split job's gallery is the whole listing:
  // the photos already delivered on it come first (its order, its cover),
  // then the ones to deliver, numbered after them.
  const listedCount = photos.filter((p) => p.status === ON_LISTING).length;
  const position = new Map(orderIds.map((id, i) => [id, listedCount + i + 1]));
  const fixingPhotos = new Set(ops.filter((o) => RUNNING_OPS.has(o.status)).map((o) => o.photoId));
  const versionsByPhoto = new Map<string, typeof versions>();
  for (const v of versions) {
    const list = versionsByPhoto.get(v.photoId);
    if (list) list.push(v);
    else versionsByPhoto.set(v.photoId, [v]);
  }
  // A view-only viewer reads that a photo was edited in the hub, never gets its file (Oct 22 2026).
  const hubEditOf = (e: ReturnType<typeof hubEditView>) => (e && readOnly ? { ...e, downloadUrl: null } : e);
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
    // Oct 21 2026: a photo straightened in the hub never falls back to the listing's old copy.
    sourceUrl: p.sourceKind === "ARYEO" && !isHubEditHash(p.contentHash) ? p.sourceUrl : null,
    dropboxPath: p.dropboxPath,
    isAerial: p.isAerial,
    isTwilight: p.isTwilight,
    isVirtuallyStaged: p.isVirtuallyStaged,
    heroScore: p.heroScore,
    verdict: p.verdict,
    cv: cvSummary(p.cvJson),
    versions: versionViews(versionsByPhoto.get(p.id) ?? [], p),
    position: p.status === "ACTIVE" ? position.get(p.id) ?? null : null,
    deliveryName: p.status === "ACTIVE" ? deliveryNameOf.get(p.id) ?? null : null,
    fixing: fixingPhotos.has(p.id),
    hubEdit: hubEditOf(hubEditView(versionsByPhoto.get(p.id) ?? [], p, job.stage)),
    delivered: p.status === ON_LISTING ? deliveredView(versionsByPhoto.get(p.id) ?? [], p.createdAt) : null,
  }));
  const rank = (p: PhotoView) => (p.status === ON_LISTING ? -10_000 + p.sequence : p.status === "ACTIVE" ? p.position ?? 9_000 + p.sequence : p.status === "EXCLUDED" ? 20_000 + p.sequence : 40_000 + p.sequence);
  photoViews.sort((a, b) => rank(a) - rank(b));
  const listedViews = photoViews.filter((p) => p.status === ON_LISTING);
  listedViews.forEach((p, i) => (p.position = i + 1));

  const roomOfPhoto = new Map(photos.map((p) => [p.id, p.roomType]));
  // Oct 21 2026: the finding the client asked to have removed (read after the checklist filed the job's items).
  const askLinks = await import("@/lib/photoDelivery/clientAsked")
    .then((m) => m.findingAskLinks(job.projectId, findings))
    .catch(() => new Map<string, { askId: string; label: string; what: string }>());
  const findingViews: FindingView[] = findings.map((f) => {
    const raw = f.pass === "P4_ORDER" ? parse<Record<string, unknown>>(p4RawById.get(f.id)) : null;
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
      // Oct 22 2026 (photo audit M7): "the automatic fix maximum ($10)" and the like, dollars for the owner only.
      statusReason: f.statusReason ? eventTextFor(f.statusReason, viewer) : f.statusReason,
      planNote: f.planNote ? eventTextFor(f.planNote, viewer) : f.planNote,
      alwaysFixed: ALWAYS_FIX.has(f.ruleId),
      exterior: isExteriorFinding(f.ruleId, f.photoId ? roomOfPhoto.get(f.photoId) : null),
      clientAsk: askLinks.get(f.id) ?? null,
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
  const jobOverrides = mergeOverrides(await houseOverridesOnce(), overridesOf(profile?.ruleOverridesJson));
  if (verdict) {
    const res = verdict.groupFindings(findings, {
      floor: settings.displayConfidenceFloor,
      overrides: jobOverrides,
      excludedPhotoIds: photos.filter((p) => p.status === "EXCLUDED").map((p) => p.id),
    });
    for (const g of [...res.groups, ...res.lowConfidence]) groupMeta[g.key] = { severity: g.severity, escalated: g.escalated, escalationReason: g.escalationReason, holds: g.holds };
  }
  // Oct 22 2026: the open issues to decide, counted exactly as the board counts them (ticketCounts).
  const tickets = ticketCounts(verdict, findings.filter((f) => f.status === "OPEN"), settings.displayConfidenceFloor, jobOverrides);

  const cart: CartView | null = cartR.v
    ? {
        lines: cartR.v.lines.map((l) => ({ ...l, findingIds: [...l.findingIds] })),
        budget: cartR.v.budget,
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
  // A view-only viewer reads the delivery order and what is waiting to be
  // swapped on the listing, never the office's files: no download of a fixed
  // photo, no 06-Ready-for-Aryeo folder (Oct 22 2026).
  const steps: StepsView | null = stepsR.v
    ? {
        replacements: (stepsR.v.replacements ?? []).map((r) => ({ ...r, downloadUrl: readOnly ? null : r.downloadUrl })),
        listingUrl: stepsR.v.listingUrl,
        orderUrl: stepsR.v.orderUrl,
        folderPath: readOnly ? null : stepsR.v.folderPath,
        folderLabel: stepsR.v.folderLabel,
        order: stepsR.v.order,
        message: stepsR.v.message,
        ready: readOnly ? null : stepsR.v.ready,
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

  // Oct 22 2026: each line as this viewer may read it (eventTextFor); a
  // view-only viewer gets no raw details (they carry credit counts and ids).
  const eventViews: EventView[] = events.map((e) => {
    // Oct 22 2026 (photo audit M7): an event's details can carry dollar fields
    // ("costUsd", a price, the fix maximum): only the owner reads them.
    const raw = readOnly ? null : parse<Record<string, unknown>>(e.dataJson);
    const data = raw && !viewer.canSeeMoney ? (moneyFreeData(raw) as Record<string, unknown>) : raw;
    const detail = data && typeof data === "object" && Object.keys(data).length ? eventTextFor(JSON.stringify(data, null, 1).slice(0, 1200), viewer) : null;
    return { id: e.id, at: e.at.toISOString(), actor: e.actor, action: eventTextFor(e.action, viewer), detail };
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
    operations: (opsByBatch.get(b.id) ?? []).map((o) => ({ id: o.id, photoId: o.photoId, strategy: o.strategy, status: o.status, estimatedCredits: o.estimatedCredits, chargedCredits: o.chargedCredits, error: o.error ? eventTextFor(o.error, viewer) : o.error })),
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

  const prepStats = parse<{ reason?: string; rated?: number }>(job.prepStatsJson);
  const { parseCoverage, photoSetKey } = await import("@/lib/photoDelivery/coverage");
  const cov = parseCoverage(job.coverageJson);
  return {
    groupMeta,
    prep: {
      mode: job.prepMode === "AS_IS" || job.prepMode === "PREPARED" || job.prepMode === "VACANT" ? job.prepMode : null,
      by: job.prepModeBy,
      at: iso(job.prepModeAt),
      reason: typeof prepStats?.reason === "string" ? prepStats.reason : null,
      rated: typeof prepStats?.rated === "number" ? prepStats.rated : 0,
      hiddenAsIs,
      hiddenRooms,
    },
    roomCoverage: cov
      ? {
          checkedAt: iso(job.coverageCheckedAt),
          current: cov.done && cov.photoSet === photoSetKey(photos.filter((p) => p.status === "ACTIVE" || p.status === ON_LISTING).map((p) => p.id)),
          rooms: cov.rooms.map((r) => ({ ...r, photos: [...r.photos] })),
          bedrooms: cov.expected.bedrooms,
          bathrooms: cov.expected.bathrooms,
          propertyType: cov.expected.propertyType,
          counts: { ...cov.counts },
          capturedNote: cov.capturedNote,
        }
      : null,
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
      creditsSpent: readOnly ? null : job.creditsSpent,
      listingUrl: project?.aryeoListingId ? aryeoListingUrl(project.aryeoListingId) : null,
      orderUrl: project?.aryeoOrderId ? aryeoOrderUrl(project.aryeoOrderId) : null,
      paymentStatus: readOnly ? null : project?.paymentStatus ?? null,
      lastError: job.lastError,
      autohdrPhotoshootId: job.autohdrPhotoshootId,
      autohdrShootName: job.autohdrShootName,
      autohdrExpiresAt: job.autohdrCreatedAt ? new Date(job.autohdrCreatedAt.getTime() + 7 * DAY).toISOString() : null,
      lastRunCostUsd: viewer.canSeeMoney && lastRun ? lastRun.costUsd : null,
      lastRunAt: lastRun ? lastRun.startedAt.toISOString() : null,
      deliveryStartedAt: iso(job.deliveryStartedAt),
      deliveryCheckedAt: iso(job.deliveryCheckedAt),
      deliveryCheckNote: job.deliveryCheckNote,
      deliveryNextCheckAt: job.stage === "DELIVERING" ? nextDeliveryCheck(job.deliveryStartedAt, job.deliveryCheckedAt) : null,
    },
    photos: photoViews,
    listing: listedCount ? { delivered: listedCount, notDelivered: photos.filter((p) => p.status === "ACTIVE").length } : null,
    heroPhotoId: job.heroPhotoId,
    findings: findingViews,
    displayFloor: settings.displayConfidenceFloor,
    cart,
    cartError: cartR.e,
    gate,
    gateError: gateR.e,
    steps,
    stepsError: stepsR.e,
    aryeoPush,
    holdingBase: {
      jobId: job.id,
      projectId: job.projectId,
      stage: job.stage,
      holdReason: job.holdReason,
      holdNote: job.holdNote,
      lastError: job.lastError,
      waitingForVisit: waitingForVisitOf(job.stage, events),
      photographer: project?.photographer?.name ?? null,
      decisions: { critical: tickets.CRITICAL, major: tickets.MAJOR, minor: tickets.MINOR },
      listingUrl: project?.aryeoListingId ? aryeoListingUrl(project.aryeoListingId) : null,
      orderUrl: project?.aryeoOrderId ? aryeoOrderUrl(project.aryeoOrderId) : null,
      deliveryCheckNote: job.deliveryCheckNote,
      listingUpdates: listingUpdatesOf(photos, job.stage),
      // Oct 22 2026 (photo audit M3): no raws seen and no photos read: not uploaded yet (the photographer's, not AutoHDR's).
      rawBatches: intake ? intake.length : null,
      photosRead: job.finalsCount,
    },
    runs: runViews,
    events: eventViews,
    batches: batchViews,
    expected: expectedRows(expected),
    specialInstructions: typeof expected?.specialInstructions === "string" ? expected.specialInstructions : null,
    requestedFeatures: Array.isArray(expected?.requestedFeatures) ? expected!.requestedFeatures.filter((x): x is string => typeof x === "string") : [],
    coverageCounts,
    coverageMet,
    freeCheck: settings.freeCheck,
    intake: (intake ?? []).map((b) => ({ ...b, sentAt: b.sentAt?.toISOString() ?? null, doneAt: b.doneAt?.toISOString() ?? null })),
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
    // Without a fixed clock this is the strip's credit view (React cache), not a second one.
    creditView(opts.now),
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
  // Jobs per client, counted in the database: one row per client, not one per
  // job ever made. (PhotoJob has no Prisma relation to Project to group through.)
  const rows = await prisma.$queryRaw<{ clientId: string; all: number; open: number }[]>`
    SELECT p."clientId" AS "clientId", COUNT(*)::int AS "all", COUNT(*) FILTER (WHERE j."stage" <> 'DELIVERED')::int AS "open"
    FROM "PhotoJob" j JOIN "Project" p ON p."id" = j."projectId"
    GROUP BY p."clientId"`;
  if (!rows.length) return [];
  const counts = new Map(rows.map((r) => [r.clientId, { all: Number(r.all), open: Number(r.open) }]));
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

/**
 * A photo's versions for the lightbox strip (Oct 14 2026, huddle finding 1):
 * one entry per AutoHDR version (the kept copy wins over an older bare row),
 * "current" by the AutoHDR version the hub uses (the content hash for a
 * Dropbox or Aryeo file), with whether a copy was kept and its sharpness.
 */
/**
 * A photo already delivered on the Aryeo listing (Oct 22 2026): when the hub
 * first saw it there, and, for a photo of the new visit Kyle added by hand,
 * the file name it has on the listing.
 */
function deliveredView(rows: { label: string; source: string; createdAt: Date }[], createdAt: Date): NonNullable<PhotoView["delivered"]> {
  const hand = rows.find((v) => v.source === "EDITOR" && v.label.startsWith(BY_HAND_LABEL));
  if (hand) return { since: hand.createdAt.toISOString(), asName: hand.label.slice(BY_HAND_LABEL.length).replace(/^:\s*/, "") || null };
  const first = rows.find((v) => v.label === "On the Aryeo listing");
  return { since: (first?.createdAt ?? createdAt).toISOString(), asName: null };
}

function versionViews(
  rows: { id: string; label: string; source: string; contentHash: string | null; createdAt: Date; createdBy: string | null; width: number | null; height: number | null; autohdrVersionUuid: string | null; derivJson: string | null }[],
  p: { contentHash: string | null; autohdrVersionUuid: string | null; sourceKind: string },
): VersionView[] {
  const meta = (j: string | null) => {
    try {
      return j ? (JSON.parse(j) as { preview?: unknown; sharpness?: number }) : {};
    } catch {
      return {};
    }
  };
  const byUuid = new Map<string, (typeof rows)[number]>();
  const out: (typeof rows)[number][] = [];
  for (const v of rows) {
    if (!v.autohdrVersionUuid) {
      out.push(v);
      continue;
    }
    const had = byUuid.get(v.autohdrVersionUuid);
    if (!had) {
      byUuid.set(v.autohdrVersionUuid, v);
      out.push(v);
    } else if (!meta(had.derivJson).preview && meta(v.derivJson).preview) {
      out[out.indexOf(had)] = v;
      byUuid.set(v.autohdrVersionUuid, v);
    }
  }
  // Oct 21 2026: the hub's own edit (photoEdit.ts) and the photo's own file under it.
  const curHub = isHubEditHash(p.contentHash) ? [...rows].reverse().find((v) => v.source === HUB_EDIT && v.contentHash === p.contentHash) : undefined;
  const hubBase = curHub ? hubMeta(curHub.derivJson).hub?.base ?? null : null;
  const ownHash = curHub ? hubBase?.sourceHash ?? null : p.contentHash;
  return out.map((v) => {
    const m = meta(v.derivJson);
    // The hub's own AutoHDR photo IS its current AutoHDR version; a photo read from the Aryeo listing (or
    // Dropbox) is the file there, and its AutoHDR versions are the ones that can be restored.
    const current = p.sourceKind === "AUTOHDR" && v.autohdrVersionUuid && p.autohdrVersionUuid ? v.autohdrVersionUuid === p.autohdrVersionUuid : !!p.contentHash && v.contentHash === p.contentHash;
    const hm = v.source === HUB_EDIT ? hubMeta(v.derivJson) : null;
    const restorable = !!v.autohdrVersionUuid || (!!hm?.file && !!hm.hub && (hm.hub.base.sourceHash ?? null) === (ownHash ?? null)) || (!!hubBase && !!v.contentHash && v.contentHash === hubBase.sourceHash);
    return {
      restorable,
      hubEdit: v.source === HUB_EDIT,
      id: v.id,
      label: v.label,
      source: v.source,
      contentHash: v.contentHash,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
      width: v.width,
      height: v.height,
      current,
      kept: !!m.preview,
      sharpness: typeof m.sharpness === "number" ? m.sharpness : null,
      inAutohdr: !!v.autohdrVersionUuid,
    };
  });
}

/**
 * Oct 21 2026: the photo's current version when it is the hub's own edit
 * (straighten, keystone, crop): its settings (the editor reopens on them),
 * and whether the Aryeo listing still has the old file (a photo that lives
 * on the listing, or a delivered job): Update on Aryeo replaces it.
 */
function hubEditView(
  rows: { id: string; label: string; source: string; contentHash: string | null; derivJson: string | null }[],
  p: { contentHash: string | null; sourceKind: string; status: string },
  stage: string,
): import("@/components/photoDelivery/types").HubEditView | null {
  if (!isHubEditHash(p.contentHash)) return null;
  const row = [...rows].reverse().find((v) => v.source === HUB_EDIT && v.contentHash === p.contentHash);
  const m = row ? hubMeta(row.derivJson) : null;
  if (!row || !m?.hub) return null;
  return {
    versionId: row.id,
    label: row.label,
    kind: m.hub.kind ?? "straighten",
    params: m.hub.params,
    // Oct 22 2026: a photo added by hand is on no listing until the delivery sends it.
    // Oct 22 2026: one rule with "What's holding this" (holding.needsListingUpdate), a split job's delivered photo included.
    needsListingUpdate: needsListingUpdate(p, stage),
    downloadUrl: m.file ? `/api/photo-fixes/${row.id}` : null,
  };
}

/** When the sweep (every 5 minutes, verifySweep.checkEveryMs) next asks Aryeo about a DELIVERING job. */
function nextDeliveryCheck(startedAt: Date | null, checkedAt: Date | null): string {
  const now = Date.now();
  if (!checkedAt) return new Date(now + 5 * 60_000).toISOString();
  const due = checkedAt.getTime() + checkEveryMs(now - (startedAt ?? checkedAt).getTime());
  // The sweep runs on the five-minute mark after the job is due.
  const at = Math.max(due, now);
  return new Date(Math.ceil(at / (5 * 60_000)) * 5 * 60_000).toISOString();
}

/** The Deliver panel's Aryeo row: the stage, whether the hub's login is saved, and the last push. */
async function aryeoPushView(jobId: string): Promise<import("@/components/photoDelivery/types").AryeoPushView> {
  const [settings, conn, progress, sameDay, lastUpdate] = await Promise.all([
    photoDeliverySettings(),
    prisma.connection.findUnique({ where: { provider: "aryeo_web" }, select: { secretEncrypted: true } }).catch(() => null),
    import("@/lib/photoDelivery/aryeoPush").then((m) => m.pushProgress(jobId)).catch(() => null),
    import("@/lib/photoDelivery/aryeoPush").then((m) => m.isSameDayJob(jobId)).catch(() => false),
    import("@/lib/photoDelivery/aryeoPush").then((m) => m.lastListingUpdate(jobId)).catch(() => null),
  ]);
  return { mode: settings.aryeoPush, connected: !!conn?.secretEncrypted, progress, sameDayAuto: sameDay && settings.sameDayAutoDeliver, lastUpdate };
}
