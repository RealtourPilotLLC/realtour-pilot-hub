import {
  ProjectStatus,
  Priority,
  Role,
  DeliverableType,
  DeliverableStatus,
} from "@prisma/client";

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
    color: "#818cf8",
    soft: "rgba(129,140,248,0.14)",
  },
  {
    status: ProjectStatus.SCHEDULED,
    label: "Scheduled",
    short: "Scheduled",
    description: "Shoot date set, photographer assigned",
    color: "#38bdf8",
    soft: "rgba(56,189,248,0.14)",
  },
  {
    status: ProjectStatus.SHOT,
    label: "Shot / Uploaded",
    short: "Shot",
    description: "Content captured and uploaded",
    color: "#a78bfa",
    soft: "rgba(167,139,250,0.14)",
  },
  {
    status: ProjectStatus.EDITING,
    label: "In Editing",
    short: "Editing",
    description: "Assigned to an editor, in production",
    color: "#fbbf24",
    soft: "rgba(251,191,36,0.14)",
  },
  {
    status: ProjectStatus.REVIEW,
    label: "Review / QC",
    short: "Review",
    description: "Internal quality check before delivery",
    color: "#f472b6",
    soft: "rgba(244,114,182,0.14)",
  },
  {
    status: ProjectStatus.DELIVERED,
    label: "Delivered",
    short: "Delivered",
    description: "Sent to client",
    color: "#34d399",
    soft: "rgba(52,211,153,0.14)",
  },
];

// Off-pipeline states (shown separately, not as flow columns).
export const SIDE_STATES: StageMeta[] = [
  {
    status: ProjectStatus.REVISION,
    label: "Revisions",
    short: "Revision",
    description: "Delivered — client requested changes",
    color: "#fb923c",
    soft: "rgba(251,146,60,0.14)",
  },
  {
    status: ProjectStatus.ON_HOLD,
    label: "On Hold",
    short: "On Hold",
    description: "Blocked — waiting on client or info",
    color: "#94a3b8",
    soft: "rgba(148,163,184,0.14)",
  },
  {
    status: ProjectStatus.CANCELLED,
    label: "Cancelled",
    short: "Cancelled",
    description: "Order cancelled",
    color: "#f87171",
    soft: "rgba(248,113,113,0.14)",
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
  [Priority.LOW]: { label: "Low", color: "#94a3b8", soft: "rgba(148,163,184,0.14)" },
  [Priority.NORMAL]: { label: "Normal", color: "#38bdf8", soft: "rgba(56,189,248,0.14)" },
  [Priority.HIGH]: { label: "High", color: "#fbbf24", soft: "rgba(251,191,36,0.14)" },
  [Priority.URGENT]: { label: "Urgent", color: "#f87171", soft: "rgba(248,113,113,0.14)" },
};

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLE_META: Record<Role, { label: string; color: string }> = {
  [Role.ADMIN]: { label: "Admin", color: "#0f172a" },
  [Role.MANAGER]: { label: "Manager", color: "#4f46e5" },
  [Role.SALES]: { label: "Sales", color: "#0ea5e9" },
  [Role.PHOTOGRAPHER]: { label: "Photographer", color: "#8b5cf6" },
  [Role.EDITOR]: { label: "Editor", color: "#d97706" },
  [Role.VA]: { label: "VA", color: "#16a34a" },
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

export const DELIVERABLE_STATUS_META: Record<
  DeliverableStatus,
  { label: string; color: string; soft: string }
> = {
  [DeliverableStatus.PENDING]: { label: "Pending", color: "#94a3b8", soft: "rgba(148,163,184,0.14)" },
  [DeliverableStatus.UPLOADED]: { label: "Uploaded", color: "#38bdf8", soft: "rgba(56,189,248,0.14)" },
  [DeliverableStatus.IN_PROGRESS]: { label: "In Progress", color: "#fbbf24", soft: "rgba(251,191,36,0.14)" },
  [DeliverableStatus.DONE]: { label: "Done", color: "#34d399", soft: "rgba(52,211,153,0.14)" },
  [DeliverableStatus.FLAGGED]: { label: "Flagged", color: "#f87171", soft: "rgba(248,113,113,0.14)" },
};
