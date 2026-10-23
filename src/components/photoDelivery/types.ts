// ---------------------------------------------------------------------------
// PHOTO DELIVERY PAGE: the shapes the server loaders hand to the screens
// (docs/photo-delivery/01 section 9). Plain serializable data only: dates are
// ISO strings, and anything that is money is null unless the viewer is the
// OWNER (canSeeMoney), so a dollar figure never reaches Kyle's browser, not
// even inside the page payload.
//
// This file is imported by client components, so it must stay free of
// server-only modules (prisma, the rules registry JSON, jobState).
// ---------------------------------------------------------------------------

import type { HoldingBase } from "@/lib/photoDelivery/holding";

export type Severity = "CRITICAL" | "MAJOR" | "MINOR";

export type Viewer = {
  role: string;
  name: string;
  isOwner: boolean;
  /** Only the OWNER sees dollars (canSeeMoney). Credits are fine for OWNER and ADMIN. */
  canSeeMoney: boolean;
  /**
   * VIEW ONLY (Oct 22 2026): the creative manager reads the desk (the board,
   * the photos, the findings, the history) and acts on none of it: no
   * approve or deliver, no Aryeo, no AutoHDR, no fixes or decisions, no
   * credit amounts. Set once on the server (loadViewer: anyone outside the
   * office) and read by every control; the server actions refuse them on
   * their own (requireAdmin, requireOwner). Absent = the office's desk.
   */
  readOnly?: boolean;
};

/** The note a view-only viewer reads at the top of every photo desk page. */
export const VIEW_ONLY_NOTE = "View only: Kyle approves and delivers photos.";

/** One image the UI can draw: the hub's derivative route first, the Aryeo CDN as a fallback. */
export type ThumbRef = { photoId: string; hash: string | null; fallbackUrl: string | null; alt: string };

// ---- global strip (plan 9.2) ------------------------------------------------------------

export type CreditStripView = {
  connected: boolean;
  balance: number | null;
  checkedAt: string | null;
  level: "ok" | "warn" | "critical" | "unknown";
  runwayDays: number | null;
  perDay: number;
  committed: number;
  warn: number;
  critical: number;
  resetBuffer: number;
  lastError: string | null;
  /** Owner only. */
  usdPerCredit: number | null;
};

export type StripData = {
  credit: CreditStripView | null;
  qcShadow: boolean;
  isOwner: boolean;
  /** Oct 22 2026: a view-only viewer: no credits chip or banner, no Credits or Settings tab, the view-only note instead. */
  readOnly?: boolean;
};

// ---- queue (plan 9.3) ------------------------------------------------------------------

export type QueueColumnKey = "editing" | "qc" | "decision" | "fixing" | "hold" | "ready" | "delivering" | "delivered";

export type FixStatusView = { status: string; label: string; tone: "ok" | "warn" | "danger" | "muted" };

export type QueueCard = {
  id: string;
  projectId: string;
  stage: string;
  stageLabel: string;
  street: string;
  clientId: string | null;
  clientName: string | null;
  photographerId: string | null;
  photographerName: string | null;
  slaDueAt: string | null;
  deliveredAt: string | null;
  shootDate: string | null;
  photoCount: number;
  issues: Record<Severity, number>;
  shadow: boolean;
  hero: ThumbRef | null;
  fix: FixStatusView | null;
  paymentStatus: string | null;
  atRisk: boolean;
  holdReason: string | null;
  lastError: string | null;
  /**
   * Oct 22 2026: what holds the job, in one line (holding.ts: the first item
   * of the job page's "What's holding this", or "Ready to send"), and the
   * add-on work still to confirm ("Lot Lines needed"). Only on the Photo
   * Delivery board (loadQueue `holding`).
   */
  holding?: { line: string; tone: "held" | "waiting" | "ready" | "done" } | null;
  addOns?: string[];
};

export type QueueColumn = { key: QueueColumnKey; label: string; hint: string; stages: string[]; cards: QueueCard[] };

export type QueueFilters = { client: string | null; photographer: string | null; atRisk: boolean };

export type QueueData = {
  columns: QueueColumn[];
  /** Jobs on the board before filters. */
  total: number;
  /** Jobs shown after filters. */
  shown: number;
  clients: { id: string; name: string }[];
  photographers: { id: string; name: string }[];
  filters: QueueFilters;
  nowIso: string;
};

// ---- job detail (plan 9.4) -------------------------------------------------------------

export type VersionView = {
  id: string;
  label: string;
  source: string;
  contentHash: string | null;
  createdAt: string;
  createdBy: string | null;
  width: number | null;
  height: number | null;
  current: boolean;
  /** A copy of this version is kept (it can be shown side by side). */
  kept: boolean;
  /** Sharpness at a fixed resolution (higher is crisper); null when not measured. */
  sharpness: number | null;
  /** The version lives in AutoHDR, so it can be restored from the hub. */
  inAutohdr: boolean;
  /** Oct 21 2026: Restore can make it current (an AutoHDR version, a hub edit, or the photo's own file under a hub edit). */
  restorable?: boolean;
  /** Oct 21 2026: straightened or cropped in the hub (photoEdit.ts). */
  hubEdit?: boolean;
};

/** Oct 21 2026: the photo's current version is the hub's own edit (straighten, keystone, crop). */
export type HubEditView = {
  versionId: string;
  label: string;
  /** Oct 22 2026: what made it (photoEdit.ts HubEditKind): straighten, lot lines, an upload, a photo added by hand. */
  kind?: "straighten" | "lotLines" | "upload" | "added";
  params: { rotate: number; keystone: number; crop: { x: number; y: number; w: number; h: number }; aspect: "original" | "3:2" | "4:3" | "16:9" | "free" };
  /** The Aryeo listing still has the photo's old file: Update on Aryeo replaces it. */
  needsListingUpdate: boolean;
  /** The edited file, full size (staff only). */
  downloadUrl: string | null;
};

export type CvMetric = { label: string; value: string };

export type PhotoView = {
  id: string;
  name: string;
  /** ON_LISTING (Oct 22 2026): already delivered on the Aryeo listing beside a split job's new visit. */
  status: "ACTIVE" | "EXCLUDED" | "GONE" | "ON_LISTING" | string;
  excludeReason: string | null;
  sequence: number;
  roomType: string | null;
  roomLabel: string;
  description: string | null;
  features: string[];
  width: number | null;
  height: number | null;
  contentHash: string | null;
  sourceKind: string;
  /** The Aryeo CDN URL (ARYEO photos only): the display fallback when the derivative route has nothing yet. */
  sourceUrl: string | null;
  dropboxPath: string | null;
  isAerial: boolean;
  isTwilight: boolean;
  isVirtuallyStaged: boolean;
  heroScore: number | null;
  verdict: string | null;
  cv: CvMetric[];
  versions: VersionView[];
  /** 1-based position in the delivery order (ACTIVE photos); on a split job, the place on the listing (the delivered ones first). */
  position: number | null;
  deliveryName: string | null;
  /** A fix operation is queued or running on this photo. */
  fixing: boolean;
  /** Oct 21 2026: the hub's own edit, when that is the current version. */
  hubEdit?: HubEditView | null;
  /**
   * Oct 22 2026 (615 Cliff Ln): already delivered on the Aryeo listing (ON_LISTING):
   * when the hub first saw it there, and the listing's file name when Kyle added it by hand.
   */
  delivered?: { since: string; asName: string | null } | null;
};

export type FindingView = {
  id: string;
  photoId: string | null;
  photoIds: string[];
  ruleId: string;
  ruleLabel: string;
  groupKey: string;
  pass: string;
  source: string;
  specificIssue: string;
  explanation: string;
  locationText: string | null;
  bbox: [number, number, number, number] | null;
  severity: Severity;
  confidence: number;
  responsibility: string;
  postFixable: boolean;
  reshootMayBeNeeded: boolean;
  isPermanentFeature: boolean;
  privacySensitive: boolean;
  recommendedAction: string | null;
  fixStrategy: string;
  status: string;
  statusReason: string | null;
  /** Why the automatic fix plan fixed or skipped it, in plain words (huddle finding 5). */
  planNote: string | null;
  /** House policy fixes it on every shoot (trash cans, cars, camera mistakes, lens distortion): never switched off house-wide (audit C19). */
  alwaysFixed?: boolean;
  /** About the outside of the house (an outside check, or a photo of the outside): a major one is set aside only with a typed reason (Oct 21 2026). */
  exterior?: boolean;
  /** The open client request it is about ("Client asked for this to be removed (order note)"): set aside only once that is answered (Oct 21 2026). */
  clientAsk?: { askId: string; label: string; what: string } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  arbitration: string;
  /** P4 only: MET | NOT_MET | UNKNOWN when the QC engine recorded it. */
  coverageStatus: string | null;
};

export type CartLineView = {
  findingIds: string[];
  photoId: string | null;
  photoName: string | null;
  ruleId: string;
  label: string;
  specificIssue: string;
  severity: Severity;
  confidence: number;
  strategy: string;
  transform: string | null;
  credits: number | null;
  humanCall: string | null;
  selectedByDefault: boolean;
  /** A free fix in AutoHDR's own editor: what to press. */
  howTo?: string | null;
  /** An ordered add-on (virtual twilight, staging, declutter): not part of the fix budget. */
  addOn?: boolean;
  params?: Record<string, unknown> | null;
};

export type CartView = {
  lines: CartLineView[];
  /** Oct 14 2026: the shoot's QC fix budget (credits) and what is already used. */
  budget: { targetCredits: number; maxCredits: number; spent: number; pending: number; automatic: number; byHand: number; reverted: number; repeats: number; refunded: number } | null;
  /** The fix planner's estimate for its default picks (null = a price could not be read). */
  estimatedCredits: number | null;
  balance: number | null;
  autohdrConnected: boolean;
  photoshootLinked: boolean;
  adminCap: number;
  blockers: string[];
  criticalThreshold: number;
  /** Owner only. */
  usdPerCredit: number | null;
};

/** `advisory`: information on the checklist, never a hold (open photo flags). `href`: where its work is.
 *  Oct 21 2026 (delivery.ts GateCheck): `hold` holds a person's delivery too (the wrap-up, what the client
 *  asked); `overridable`/`overridden` the wrap-up's typed reason; `askId` the request's Done / Answer. */
export type GateCheckView = {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  advisory?: boolean;
  href?: string;
  hrefLabel?: string;
  hold?: boolean;
  overridable?: boolean;
  overridden?: string | null;
  askId?: string;
  /** Oct 22 2026 (addOns.ts): add-on work to confirm before delivery (Lot Lines needed), with the agent's words. */
  addOn?: AddOnView;
  /** Never counts for the hub's own same-day delivery (Kyle approves a job with lot lines or staging). */
  personOnly?: boolean;
  /** Oct 22 2026: the photos the line is about (Update on Aryeo of photos edited in the hub). */
  photoIds?: string[];
};
export type AddOnView = {
  key: string;
  need: string;
  done: string;
  ordered: string;
  quotes: { from: string; text: string }[];
  cleared: { how: "version" | "confirmed" | "listing"; by: string | null; atISO: string; note: string | null; photoName: string | null } | null;
};
/** `ignored`: "You're delivering with 6 exterior issues ignored (…)", shown before delivering. */
export type GateView = { checks: GateCheckView[]; passed: boolean; advisory: boolean; canDeliver: boolean; overrideAllowed: boolean; blockedForOverride: string | null; holdsOpen: number; ignored: string | null };

/** `downloadUrl`: null for a view-only viewer (Oct 22 2026: the fixed file is the office's to swap in). */
export type ReplacementView = { photoId: string; photoName: string; versionId: string; downloadUrl: string | null; label: string; at: string };

export type StepsView = {
  /** Photos fixed through AutoHDR that still need swapping on the Aryeo listing. */
  replacements: ReplacementView[];
  listingUrl: string | null;
  orderUrl: string | null;
  folderPath: string | null;
  folderLabel: string;
  order: { photoId: string; name: string; deliveryName: string }[];
  message: string;
  /** Oct 14 2026: `preparing` while a copy run is going (the progress bar follows it); `failed` copies that gave up. */
  ready: { folderUrl: string; files: number; expected: number; ready: boolean; stagedAt: string | null; preparing?: boolean; failed?: number; note?: string | null } | null;
};

export type RunView = {
  id: string;
  trigger: string;
  status: string;
  shadow: boolean;
  passes: string[];
  models: string[];
  photoCount: number;
  verdict: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Owner only. */
  costUsd: number | null;
};

export type EventView = { id: string; at: string; actor: string; action: string; detail: string | null };

export type FixBatchView = {
  id: string;
  mode: string;
  status: string;
  estimatedCredits: number;
  approvedBy: string;
  approvedAt: string;
  operations: { id: string; photoId: string; strategy: string; status: string; estimatedCredits: number; chargedCredits: number | null; error: string | null }[];
  /** Owner only. */
  estimatedUsd: number | null;
};

export type ExpectedView = { label: string; value: string; source: string | null }[];

export type CoverageCounts = { photos: number; aerial: number; twilight: number; staged: number };

export type JobHeaderView = {
  id: string;
  projectId: string;
  street: string;
  cityLine: string | null;
  clientId: string | null;
  clientName: string | null;
  photographerName: string | null;
  shootDate: string | null;
  slaDueAt: string | null;
  deliveredAt: string | null;
  stage: string;
  stageLabel: string;
  holdReason: string | null;
  holdNote: string | null;
  holdResumeStage: string | null;
  qcVerdict: string | null;
  qcShadow: boolean;
  qcRequestedAt: string | null;
  /** AutoHDR credits spent on the job; null for a view-only viewer (no credit amounts). */
  creditsSpent: number | null;
  listingUrl: string | null;
  orderUrl: string | null;
  paymentStatus: string | null;
  lastError: string | null;
  autohdrPhotoshootId: number | null;
  autohdrShootName: string | null;
  autohdrExpiresAt: string | null;
  /** Owner only: the latest QC run's Anthropic cost. */
  lastRunCostUsd: number | null;
  lastRunAt: string | null;
  /** Delivery checks against Aryeo (huddle finding 12): when the job was marked delivering, the last check and what it found, and the next one. */
  deliveryStartedAt: string | null;
  deliveryCheckedAt: string | null;
  deliveryCheckNote: string | null;
  deliveryNextCheckAt: string | null;
};

/** The QC engine's view of each group (qc/verdict.ts groupFindings), keyed `${ruleId}::${groupKey}`. */
export type GroupMeta = { severity: Severity; escalated: boolean; escalationReason: string | null; holds: boolean };

/** Oct 15 2026: how prepared the home is (prep.ts) and the clutter that is therefore not shown. */
export type PrepModeKey = "AS_IS" | "PREPARED" | "VACANT";
export type PrepView = {
  mode: PrepModeKey | null;
  /** "auto", or the person who set it. */
  by: string | null;
  at: string | null;
  reason: string | null;
  rated: number;
  /** Clutter findings set aside because the home (asIs) or the room (rooms) was not prepared: never shown. */
  hiddenAsIs: number;
  hiddenRooms: number;
};

/** Oct 15 2026: the free room coverage check (coverage.ts). */
export type RoomCoverageRow = { key: string; label: string; status: "DELIVERED" | "NOT_DELIVERED" | "NOT_CAPTURED" | "UNKNOWN" | "ADVISORY"; severity: Severity | null; photos: string[]; note: string };
export type RoomCoverageView = {
  checkedAt: string | null;
  /** Worked out for the photos in the delivery now. */
  current: boolean;
  rooms: RoomCoverageRow[];
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;
  counts: { raw: number | null; expectedPhotos: number | null; autohdr: number | null; delivered: number; leftOut: number };
  capturedNote: string | null;
};

export type JobDetail = {
  header: JobHeaderView;
  prep: PrepView;
  roomCoverage: RoomCoverageView | null;
  groupMeta: Record<string, GroupMeta>;
  photos: PhotoView[];
  /** Oct 22 2026: a split job: photos already delivered on the listing, and the ones not delivered yet. Null on a single visit. */
  listing?: { delivered: number; notDelivered: number } | null;
  heroPhotoId: string | null;
  findings: FindingView[];
  displayFloor: number;
  cart: CartView | null;
  cartError: string | null;
  gate: GateView | null;
  gateError: string | null;
  steps: StepsView | null;
  stepsError: string | null;
  /** The hub's own upload and delivery into Aryeo (aryeoPush.ts, Oct 14 2026). */
  aryeoPush: AryeoPushView;
  /** Oct 22 2026: the job's own facts for "What's holding this" (holding.ts holdingFor, with the gate and the live push). */
  holdingBase: HoldingBase;
  runs: RunView[];
  events: EventView[];
  batches: FixBatchView[];
  expected: ExpectedView;
  specialInstructions: string | null;
  requestedFeatures: string[];
  coverageCounts: CoverageCounts;
  coverageMet: { label: string; evidence: string | null }[];
  /** Oct 14 2026: the free photo check runs by itself. (Oct 23 2026: the paid QC is off; its switches are no longer sent.) */
  freeCheck: boolean;
  /** Oct 14 2026: the hub's own sends to AutoHDR for this job (intake.ts), oldest first. */
  intake: IntakeView[];
  nowIso: string;
};

export type IntakeView = { batchNo: number; state: string; fileCount: number; expectedPhotos: number | null; sentAt: string | null; doneAt: string | null; imageCount: number | null; lastError: string | null };

// ---- credits page (plan 10.4) ----------------------------------------------------------

export type LedgerRowView = {
  id: string;
  at: string;
  kind: string;
  credits: number;
  balanceAfter: number | null;
  jobId: string | null;
  jobLabel: string | null;
  note: string | null;
};

export type SpendRow = { key: string; label: string; d14: number; d30: number };

export type CreditsPageData = {
  credit: CreditStripView;
  snapshots: { at: string; balance: number }[];
  ledger: LedgerRowView[];
  ledgerHasMore: boolean;
  spend: SpendRow[];
  alert: { below250Sent: boolean; below100Sent: boolean; lastBalance: number | null; lastCheckedAt: string | null };
  billingUrl: string;
};

// ---- settings page (plan 9.1, 14) ------------------------------------------------------

export type RuleOption = { id: string; label: string; section: string; severity: Severity };
export type RuleOverrideView = { ruleId: string; severity?: Severity; disabled?: boolean; reason: string };

export type ClientProfileView = {
  clientId: string;
  clientName: string;
  company: string | null;
  jobCount: number;
  openJobCount: number;
  slaHours: number | null;
  notes: string;
  deliveryMessage: string;
  overrides: RuleOverrideView[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export type AryeoPushView = {
  /** on: nothing reaches Aryeo before Kyle approves the job (Oct 15). */
  mode: "off" | "on";
  /** The hub's Aryeo login is saved (Connections). */
  connected: boolean;
  /** The order has the same-day photos add-on, and the hub approves those by itself once every check passes. */
  sameDayAuto: boolean;
  progress: {
    state: string;
    active: boolean;
    total: number;
    sent: number;
    already: number;
    note: string | null;
    /** The photos changed after they went on the listing: approve again. */
    changed?: boolean;
    startedAt: string;
    finishedAt: string | null;
    deliveredAt: string | null;
    waitingForApproval: boolean;
    /** Oct 21 2026: an Update on Aryeo (the hub's edit replacing photos on the listing). */
    update?: boolean;
    /** Oct 22 2026: a split job: the photos already on the listing, kept first. */
    kept?: number;
    /** Photos found on the listing already (never sent again). */
    matched?: number;
    /** Photos on the listing twice when it was checked (the images' names). */
    duplicates?: string[][];
    /** Oct 22 2026: new photos put on an already delivered listing, and their re-delivery (aryeoPush). */
    redeliver?: { pending: number; state: string | null; at: string | null; photos: number; note: string | null } | null;
  } | null;
  /** Oct 21 2026: the last Update on Aryeo of this job and how it ended. */
  lastUpdate?: { at: string; ok: boolean; note: string; photoIds: string[] } | null;
};
