import {
  ProjectStatus,
  Priority,
  Role,
  DeliverableType,
  DeliverableStatus,
} from "@prisma/client";
import { PALETTE, soft as softTint } from "@/lib/palette";

// ---------------------------------------------------------------------------
// Pipeline stages (the booked -> delivered workflow)
// ---------------------------------------------------------------------------

export type StageMeta = {
  status: ProjectStatus;
  label: string;
  short: string;
  description: string;
  /** Tailwind-ready colors via inline style tokens */
  color: string; // accent color (hex)
  soft: string; // soft background (hex)
};

// The ordered stages that appear as board columns.
export const PIPELINE_STAGES: StageMeta[] = [
  {
    status: ProjectStatus.BOOKED,
    label: "Booked",
    short: "Booked",
    description: "Order received — needs scheduling",
    color: PALETTE.gray,
    soft: softTint(PALETTE.gray),
  },
  {
    status: ProjectStatus.SCHEDULED,
    label: "Scheduled",
    short: "Scheduled",
    description: "Shoot date set, photographer assigned",
    color: PALETTE.blue,
    soft: softTint(PALETTE.blue),
  },
  {
    status: ProjectStatus.SHOT,
    label: "Shot / Uploaded",
    short: "Shot",
    description: "Content captured and uploaded",
    color: PALETTE.teal,
    soft: softTint(PALETTE.teal),
  },
  {
    status: ProjectStatus.EDITING,
    label: "In Editing",
    short: "Editing",
    description: "Assigned to an editor, in production",
    color: PALETTE.indigo,
    soft: softTint(PALETTE.indigo),
  },
  {
    status: ProjectStatus.REVIEW,
    label: "Review / QC",
    short: "Review",
    description: "Internal quality check before delivery",
    color: PALETTE.violet,
    soft: softTint(PALETTE.violet),
  },
  {
    status: ProjectStatus.DELIVERED,
    label: "Delivered",
    short: "Delivered",
    description: "Sent to client",
    color: PALETTE.green,
    soft: softTint(PALETTE.green),
  },
];

// Off-pipeline states (shown separately, not as flow columns).
export const SIDE_STATES: StageMeta[] = [
  {
    status: ProjectStatus.REVISION,
    label: "Revisions",
    short: "Revision",
    description: "Delivered — client requested changes",
    color: PALETTE.gold,
    soft: softTint(PALETTE.gold),
  },
  {
    status: ProjectStatus.ON_HOLD,
    label: "On Hold",
    short: "On Hold",
    description: "Blocked — waiting on client or info",
    color: PALETTE.gray,
    soft: softTint(PALETTE.gray),
  },
  {
    status: ProjectStatus.CANCELLED,
    label: "Cancelled",
    short: "Cancelled",
    description: "Order cancelled",
    color: PALETTE.red,
    soft: softTint(PALETTE.red),
  },
];

export const ALL_STAGES = [...PIPELINE_STAGES, ...SIDE_STATES];

export function stageMeta(status: ProjectStatus): StageMeta {
  return ALL_STAGES.find((s) => s.status === status) ?? PIPELINE_STAGES[0];
}

/** Next stage in the linear flow, or null if at the end / off-pipeline. */
export function nextStage(status: ProjectStatus): ProjectStatus | null {
  const idx = PIPELINE_STAGES.findIndex((s) => s.status === status);
  if (idx === -1 || idx === PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[idx + 1].status;
}

export function prevStage(status: ProjectStatus): ProjectStatus | null {
  const idx = PIPELINE_STAGES.findIndex((s) => s.status === status);
  if (idx <= 0) return null;
  return PIPELINE_STAGES[idx - 1].status;
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export const PRIORITY_META: Record<Priority, { label: string; color: string; soft: string }> = {
  [Priority.LOW]: { label: "Low", color: PALETTE.gray, soft: softTint(PALETTE.gray) },
  [Priority.NORMAL]: { label: "Normal", color: PALETTE.blue, soft: softTint(PALETTE.blue) },
  [Priority.HIGH]: { label: "High", color: PALETTE.gold, soft: softTint(PALETTE.gold) },
  [Priority.URGENT]: { label: "Urgent", color: PALETTE.red, soft: softTint(PALETTE.red) },
};

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLE_META: Record<Role, { label: string; color: string }> = {
  [Role.ADMIN]: { label: "Admin", color: PALETTE.violet },
  [Role.MANAGER]: { label: "Manager", color: PALETTE.indigo },
  [Role.SALES]: { label: "Sales", color: PALETTE.blue },
  [Role.PHOTOGRAPHER]: { label: "Photographer", color: PALETTE.teal },
  [Role.EDITOR]: { label: "Editor", color: PALETTE.gold },
  [Role.VA]: { label: "VA", color: PALETTE.green },
};

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

export const DELIVERABLE_META: Record<DeliverableType, { label: string; icon: string }> = {
  [DeliverableType.PHOTOS]: { label: "Photos", icon: "camera" },
  [DeliverableType.VIDEO]: { label: "Video", icon: "video" },
  [DeliverableType.FLOORPLAN]: { label: "Floor Plan", icon: "ruler" },
  [DeliverableType.DRONE]: { label: "Drone / Aerial", icon: "plane" },
  [DeliverableType.TWILIGHT]: { label: "Twilight", icon: "sunset" },
  [DeliverableType.MATTERPORT_3D]: { label: "Matterport 3D", icon: "box" },
  [DeliverableType.VIRTUAL_STAGING]: { label: "Virtual Staging", icon: "sofa" },
  [DeliverableType.SOCIAL_REEL]: { label: "Social Reel", icon: "clapperboard" },
  [DeliverableType.ZILLOW_3D]: { label: "Zillow 3D Tour", icon: "home" },
  [DeliverableType.HEADSHOT]: { label: "Headshot", icon: "user" },
  [DeliverableType.OTHER]: { label: "Other", icon: "package" },
};

// Refine the display name of video/reel deliverables from the order item text,
// so the project page distinguishes our three video products:
//   • Premium Reel  (premium listing reel — outsourced to Luma)
//   • Monthly Content  (personal-branding: Video Starter/Accelerator/Pro, "influencer")
//   • Standard Reel  (in-house standard reel)
function prettifyLabel(raw: string): string {
  // "SILVER BUNDLE - Effortless Essentials…" → "Silver Bundle"
  let s = raw.split(/\s+[-–—:]\s+/)[0].trim();
  if (s && s === s.toUpperCase()) s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return s;
}

export function refinedDeliverableLabel(type: DeliverableType, label?: string | null): string {
  const l = (label ?? "").trim();
  // NEVER show the bare word "Other" — use the real order-item name.
  if (type === DeliverableType.OTHER) return prettifyLabel(l) || "Add-on";
  const base = DELIVERABLE_META[type]?.label ?? String(type);
  if (type !== DeliverableType.SOCIAL_REEL && type !== DeliverableType.VIDEO) return base;
  // MONTHLY_PLAN_RE is the one shared monthly signal — the old inline regex
  // missed the broadened wordings it accepts ("Content Day", "Branding Shoot"),
  // so those chips read "Standard Reel"/"Video" while everything else treated
  // them as monthly. Premium keeps the \bstandard\b veto for the same reason.
  if (MONTHLY_PLAN_RE.test(l)) return "Monthly Content";
  if (/premium|influencer/i.test(l) && !/\bstandard\b/i.test(l)) return "Premium Reel";
  if (/reel|social/i.test(l)) return "Standard Reel";
  return base;
}

export const DELIVERABLE_STATUS_META: Record<
  DeliverableStatus,
  { label: string; color: string; soft: string }
> = {
  [DeliverableStatus.PENDING]: { label: "Pending", color: PALETTE.gray, soft: softTint(PALETTE.gray) },
  [DeliverableStatus.UPLOADED]: { label: "Uploaded", color: PALETTE.blue, soft: softTint(PALETTE.blue) },
  [DeliverableStatus.IN_PROGRESS]: { label: "In Progress", color: PALETTE.gold, soft: softTint(PALETTE.gold) },
  [DeliverableStatus.DONE]: { label: "Done", color: PALETTE.green, soft: softTint(PALETTE.green) },
  [DeliverableStatus.FLAGGED]: { label: "Flagged", color: PALETTE.red, soft: softTint(PALETTE.red) },
};

// ---------------------------------------------------------------------------
// Is THIS project a monthly personal-branding / social-content job (7–10
// business-day turnaround, Kim's lane), or a normal listing shoot?
// `Client.socialClient` is a CLIENT attribute — using it alone branded every
// listing shoot those agents booked as "monthly content" (wrong QC copy,
// wrong SLA, wrong editor routing — caught live on 523 S Coventry / 238
// Hudson / 419 Riverview, July 2026). Jordan's definitive rule: monthly
// content is one of the three PLANS — Video Starter, Video Accelerator, or
// Video Pro — and those names appear right on the order item ("Video Starter
// - 2h session", "Video Accelerator - 4HR Content Session", …). Anything else
// — including a one-off "Premium Social Reel" at an office address — is NOT
// monthly. (\b after "pro" keeps "Video Production" from matching.)
// ---------------------------------------------------------------------------
// Exported: the Aryeo sync uses this to KEEP a plan title as the deliverable
// label (a generic "Video" label destroys the monthly signal — Aug 18 audit:
// 39 live monthly-plan jobs classified as ordinary listing videos). Also
// broadened: "Monthly Social Media Content Session" / "August Social Media
// Content Day" / "Branding Shoot" are monthly-content wordings the old
// adjacent-words regex missed.
export const MONTHLY_PLAN_RE =
  /video\s*[-–]?\s*(starter|accelerator|pro)\b|monthly\s+(social\s+)?(media\s+)?content|social\s+(media\s+)?content|personal[-\s]*brand|content\s+(session|day)\b|branding\s+(shoot|session)\b/i;

export function isMonthlyContentJob(
  deliverables: { type?: string; label?: string | null }[],
  packageName?: string | null,
): boolean {
  if (packageName && MONTHLY_PLAN_RE.test(packageName)) return true;
  return deliverables.some((d) => !!d.label && MONTHLY_PLAN_RE.test(d.label));
}
