import "server-only";

// ---------------------------------------------------------------------------
// THE QC ENGINE'S PUBLIC SURFACE (plan §7). Server code imports from here.
// A client component (or anything that must not pull in Prisma and sharp)
// imports the pure helpers straight from "@/lib/photoDelivery/qc/verdict".
// ---------------------------------------------------------------------------

export { requestQc, driveQc, monthQcSpendUsd, type DriveSummary, type JobTickResult, type QcRunSummary, type RunProgress, type ChecksLedger } from "./run";
export {
  groupFindings,
  jobVerdict,
  photoVerdicts,
  effectiveSeverity,
  isLowConfidence,
  isUnresolved,
  photoIdsOf,
  qcStageFor,
  deliveryOrder,
  suggestedHero,
  finalFilenames,
  roomLabel,
  DEFAULT_SEQUENCE,
  DEFAULT_DISPLAY_FLOOR,
  UNRESOLVED_STATUSES,
  HOLDING_ARBITRATION,
  type FindingLike,
  type FindingGroup,
  type JobVerdict,
  type PhotoVerdict,
  type VerdictResult,
  type OrderPhoto,
} from "./verdict";
export { parseCv, type CvMetrics, type DustCandidate, type StoredCv, type P1bState } from "./cv";
export { parseDerivMap, UI_SIZES, type DerivMap, type DerivRef, type UiSize } from "./derivatives";
export { runPass, QcCallError, type PassSpec, type PassOutcome, type CallRecord } from "./claude";
export { promptVersions, ACTIVE_PROMPTS } from "./prompts";
