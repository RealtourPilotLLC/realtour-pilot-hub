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

export type Severity = "CRITICAL" | "MAJOR" | "MINOR";

export type Viewer = {
  role: string;
  name: string;
  isOwner: boolean;
  /** Only the OWNER sees dollars (canSeeMoney). Credits are fine for OWNER and ADMIN. */
  canSeeMoney: boolean;
};

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
  qcEnabled: boolean;
  isOwner: boolean;
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
};

export type CvMetric = { label: string; value: string };

export type PhotoView = {
  id: string;
  name: string;
  status: "ACTIVE" | "EXCLUDED" | "GONE" | string;
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
  /** 1-based position in the delivery order (ACTIVE photos only). */
  position: number | null;
  deliveryName: string | null;
  /** A fix operation is queued or running on this photo. */
  fixing: boolean;
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
  /** An ordered add-on (virtual twilight, staging, declutter): not part of the fix budget. */
  addOn?: boolean;
  params?: Record<string, unknown> | null;
};

export type CartView = {
  lines: CartLineView[];
  /** Oct 14 2026: the shoot's QC fix budget (credits) and what is already used. */
  budget: { targetCredits: number; maxCredits: number; spent: number; pending: number; automatic: number; byHand: number } | null;
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

export type GateCheckView = { key: string; label: string; ok: boolean; detail?: string };
export type GateView = { checks: GateCheckView[]; passed: boolean; advisory: boolean; canDeliver: boolean; overrideAllowed: boolean; blockedForOverride: string | null };

export type ReplacementView = { photoId: string; photoName: string; versionId: string; downloadUrl: string; label: string; at: string };

export type StepsView = {
  /** Photos fixed through AutoHDR that still need swapping on the Aryeo listing. */
  replacements: ReplacementView[];
  listingUrl: string | null;
  orderUrl: string | null;
  folderPath: string | null;
  folderLabel: string;
  order: { photoId: string; name: string; deliveryName: string }[];
  message: string;
  ready: { folderUrl: string; files: number; expected: number; ready: boolean; stagedAt: string | null } | null;
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
  creditsSpent: number;
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
};

/** The QC engine's view of each group (qc/verdict.ts groupFindings), keyed `${ruleId}::${groupKey}`. */
export type GroupMeta = { severity: Severity; escalated: boolean; escalationReason: string | null; holds: boolean };

export type JobDetail = {
  header: JobHeaderView;
  groupMeta: Record<string, GroupMeta>;
  photos: PhotoView[];
  heroPhotoId: string | null;
  findings: FindingView[];
  displayFloor: number;
  cart: CartView | null;
  cartError: string | null;
  gate: GateView | null;
  gateError: string | null;
  steps: StepsView | null;
  stepsError: string | null;
  runs: RunView[];
  events: EventView[];
  batches: FixBatchView[];
  expected: ExpectedView;
  specialInstructions: string | null;
  requestedFeatures: string[];
  coverageCounts: CoverageCounts;
  coverageMet: { label: string; evidence: string | null }[];
  qcEnabled: boolean;
  /** Oct 14 2026: the free photo check runs by itself; the paid QC starts by itself. */
  freeCheck: boolean;
  paidQcAuto: boolean;
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
