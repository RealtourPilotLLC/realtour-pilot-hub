// ---------------------------------------------------------------------------
// Small pure helpers shared by the Photo Delivery screens (server and client).
// No server-only imports here: client components read this file.
// Copy rule (Jordan's standing rule, plan 0.3): no em or en dashes in anything
// a person reads. Use commas, colons or periods.
// ---------------------------------------------------------------------------

import type { FindingView, GroupMeta, IntakeView, Severity } from "./types";
import { etTime } from "@/lib/datetime";

export const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 3, MAJOR: 2, MINOR: 1 };

export const SEVERITY_LABEL: Record<Severity, string> = { CRITICAL: "Critical", MAJOR: "Major", MINOR: "Minor" };

/** Text + soft background classes per severity (theme tokens only). */
export const SEVERITY_CLASS: Record<Severity, string> = {
  CRITICAL: "bg-danger-soft text-danger ring-danger/30",
  MAJOR: "bg-warning-soft text-warning ring-warning/30",
  MINOR: "bg-surface-2 text-muted ring-border",
};

export function worstOf(list: Severity[]): Severity | null {
  let best: Severity | null = null;
  for (const s of list) if (!best || SEVERITY_ORDER[s] > SEVERITY_ORDER[best]) best = s;
  return best;
}

export const plural = (n: number, word: string, many?: string) => `${n} ${n === 1 ? word : many ?? `${word}s`}`;

export const credits = (n: number) => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;

export const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "PRIMARY_BATHROOM" → "Primary bathroom". */
export function prettyRoom(roomType: string | null | undefined): string {
  if (!roomType) return "Unlabeled";
  const s = roomType.toLowerCase().replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Unlabeled";
}

/** "SENT_TO_EDITOR" → "Sent to editor". */
export function prettyEnum(v: string | null | undefined): string {
  if (!v) return "";
  const s = v.toLowerCase().replace(/_/g, " ");
  return s[0].toUpperCase() + s.slice(1);
}

export const FINDING_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  APPROVED_FIX: "Fix approved",
  FIXING: "Fixing",
  FIXED: "Fixed",
  IGNORED: "Not worth fixing",
  OVERRIDDEN: "Overridden",
  SENT_TO_EDITOR: "Sent to editor",
  RESHOOT_REQUESTED: "Reshoot recommended",
  FALSE_POSITIVE: "Not there",
  SUPERSEDED: "Replaced by a newer QC run",
};

/** Human decisions a person can undo (back to OPEN). */
export const UNDOABLE = new Set(["IGNORED", "OVERRIDDEN", "SENT_TO_EDITOR", "RESHOOT_REQUESTED", "FALSE_POSITIVE"]);

export const VERDICT_LABEL: Record<string, string> = {
  PASS: "Pass",
  PASS_WITH_MINOR: "Pass with minor notes",
  NEEDS_DECISION: "Needs a decision",
  HOLD: "Hold",
};

export const RESPONSIBILITY_LABEL: Record<string, string> = {
  PHOTOGRAPHER: "Photographer",
  EDITOR: "Editor",
  ADMIN: "Office",
  HUMAN_REVIEW: "Needs a person",
};

export const STRATEGY_LABEL: Record<string, string> = {
  AUTOREMOVE_MASK: "AutoRemove",
  DECLUTTER: "Declutter",
  REEDIT_PROMPT: "AI re-edit",
  CAMERA_REMOVAL: "Camera removal",
  GRASS: "Grass",
  STYLE_RERENDER: "Style re-render",
  VIRTUAL_TWILIGHT: "Virtual twilight",
  VIRTUAL_STAGING: "Virtual staging",
  REVERT_VERSION: "Revert version",
  EDITOR_MANUAL: "Editor by hand",
  RESHOOT: "Reshoot",
  ADMIN_ACTION: "Office action",
  HUMAN_REVIEW: "Human review",
  NONE: "No fix",
};

/** Why a cart line cannot run automatically (FixCart.humanCall), in plain words. */
export const HUMAN_CALL_LABEL: Record<string, string> = {
  "permanent-feature": "It may change a permanent feature of the house, so a person decides.",
  privacy: "Privacy: choose blur, remove, or leave the photo out.",
  "color-truth": "Color truth: compare with the original or ask the photographer.",
  reshoot: "Only a reshoot fixes this. That is a recommendation, never automatic.",
  editor: "This needs an editor by hand.",
  review: "A person has to look at this one.",
  "no-autohdr": "This job's AutoHDR shoot is not linked yet, so AutoHDR cannot fix it.",
  "autohdr-editor": "Fix it free in AutoHDR's own editor (no credits).",
};

export const HOLD_REASON_LABEL: Record<string, string> = {
  CRITICAL: "Critical issue",
  CREDITS: "Out of AutoHDR credits",
  RESHOOT: "Reshoot",
  MANUAL: "Held by hand",
};

/** Presets for "why are you ignoring this" (plan 8.3). */
export const IGNORE_PRESETS = ["Client preference", "Intentional staging", "Permanent feature", "Not worth a fix on this listing"] as const;

/** Presets for "why is this photo left out". */
export const EXCLUDE_PRESETS = ["Duplicate", "Out of focus or soft", "Privacy", "Not this property", "Weak angle, better one in the set"] as const;

/** Derivative sizes the image route serves (plan 3.4). */
export type DerivSize = "thumb256" | "thumb768" | "qc1024" | "qc2048";

/**
 * The hub's staff-only image route. `v` pins the cache to the content hash;
 * `version` asks for one PhotoVersion (original vs current in review mode).
 */
export function photoSrc(photoId: string, size: DerivSize, hash: string | null, versionId?: string | null): string {
  const q = new URLSearchParams();
  if (hash) q.set("v", hash);
  if (versionId) q.set("version", versionId);
  const s = q.toString();
  return `/api/photo-delivery/img/${encodeURIComponent(photoId)}/${size}${s ? `?${s}` : ""}`;
}

// ---- SLA (plan 9.3: green, amber at 6 h left, red at 2 h, late) ------------------------------

export type SlaTone = "ok" | "warn" | "danger" | "late" | "none" | "done";

const H = 3_600_000;

function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) {
    const rest = m - h * 60;
    return rest && h < 10 ? `${h} h ${rest} min` : `${h} h`;
  }
  return `${Math.round(h / 24)} days`;
}

export function slaState(dueIso: string | null, nowMs: number, delivered = false): { tone: SlaTone; label: string } {
  if (delivered) return { tone: "done", label: "Delivered" };
  if (!dueIso) return { tone: "none", label: "No due time" };
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due)) return { tone: "none", label: "No due time" };
  const left = due - nowMs;
  if (left < 0) return { tone: "late", label: `Late by ${span(-left)}` };
  if (left < 2 * H) return { tone: "danger", label: `${span(left)} left` };
  if (left < 6 * H) return { tone: "warn", label: `${span(left)} left` };
  return { tone: "ok", label: `${span(left)} left` };
}

export const SLA_CLASS: Record<SlaTone, string> = {
  ok: "bg-success-soft text-success ring-success/30",
  warn: "bg-warning-soft text-warning ring-warning/30",
  danger: "bg-danger-soft text-danger ring-danger/30",
  late: "bg-danger-action text-white ring-danger/40",
  none: "bg-surface-2 text-muted ring-border",
  done: "bg-surface-2 text-muted ring-border",
};

// ---- finding groups (plan 7.5: "Toilet seat open, 3 photos") ---------------------------------

export type FindingGroup = {
  key: string;
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: number;
  responsibility: string;
  photoIds: string[];
  findings: FindingView[];
  /** OPEN findings in the group: what a group-level decision applies to. */
  openIds: string[];
  /** Every finding in the group carries this status (null when they differ). */
  sharedStatus: string | null;
  privacy: boolean;
  /** The QC engine raised the severity (for example the same dust on several photos). */
  escalationReason: string | null;
  /** An unresolved CRITICAL that holds delivery, by the engine's rule. */
  holds: boolean;
};

const ACTIVE_FINDING = new Set(["OPEN", "APPROVED_FIX", "FIXING"]);

/**
 * Group findings with the same rule and groupKey across photos into one
 * ticket (plan 7.5), keyed exactly like the QC engine's groupFindings
 * (qc/verdict.ts). The engine reads the rules registry, which is too big to
 * ship to the browser, so the server computes its verdict per group and hands
 * it over as `meta` (severity after escalation and client overrides, and
 * whether the group holds delivery); without it the raw severities are used.
 */
export function groupFindings(findings: FindingView[], meta?: Record<string, GroupMeta> | null): FindingGroup[] {
  const map = new Map<string, FindingView[]>();
  for (const f of findings) {
    const k = `${f.ruleId}::${f.groupKey}`;
    const list = map.get(k);
    if (list) list.push(f);
    else map.set(k, [f]);
  }
  const groups: FindingGroup[] = [];
  for (const [key, list] of map) {
    const photoIds = [...new Set(list.flatMap((f) => (f.photoIds.length ? f.photoIds : f.photoId ? [f.photoId] : [])))];
    const resp = new Map<string, number>();
    for (const f of list) resp.set(f.responsibility, (resp.get(f.responsibility) ?? 0) + 1);
    const responsibility = [...resp.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "HUMAN_REVIEW";
    const statuses = new Set(list.map((f) => f.status));
    const first = list[0];
    const title = first.ruleId === "OTHER_DEFECT" || !first.ruleLabel ? first.specificIssue : first.ruleLabel;
    const m = meta?.[key];
    groups.push({
      key,
      ruleId: first.ruleId,
      title,
      severity: m?.severity ?? worstOf(list.map((f) => f.severity)) ?? "MINOR",
      confidence: Math.max(...list.map((f) => f.confidence)),
      responsibility,
      photoIds,
      findings: list,
      openIds: list.filter((f) => f.status === "OPEN").map((f) => f.id),
      sharedStatus: statuses.size === 1 ? first.status : null,
      privacy: list.some((f) => f.privacySensitive),
      escalationReason: m?.escalated ? m.escalationReason : null,
      holds: !!m?.holds,
    });
  }
  // Open work first, then the worst severity, then the most photos.
  return groups.sort(
    (a, b) =>
      Number(b.findings.some((f) => ACTIVE_FINDING.has(f.status))) - Number(a.findings.some((f) => ACTIVE_FINDING.has(f.status))) ||
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      b.photoIds.length - a.photoIds.length ||
      a.title.localeCompare(b.title),
  );
}

/** The photos a finding is about (one for photo findings, several for gallery findings). */
export function findingPhotoIds(f: Pick<FindingView, "photoId" | "photoIds">): string[] {
  return f.photoIds.length ? f.photoIds : f.photoId ? [f.photoId] : [];
}

/** Does a reason have to be typed for this decision? Mirrors decisions.ts (plan 8.3). */
export function reasonRequired(status: string, severities: Severity[]): boolean {
  return (status === "IGNORED" || status === "OVERRIDDEN" || status === "FALSE_POSITIVE") && severities.some((s) => s !== "MINOR");
}

/** Replace long dashes with a comma (client-facing text, plan 0.3). */
export const noLongDashes = (s: string) => s.replace(/\s*[\u2013\u2014]\s*/g, ", ");

// ---- queue links ------------------------------------------------------------------------------

export type QueueParams = { client: string | null; photographer: string | null; risk: boolean; view: "board" | "table" };

/** The queue URL for a set of filters (server and client build the same links). */
export function queueHref(p: QueueParams): string {
  const q = new URLSearchParams();
  if (p.client) q.set("client", p.client);
  if (p.photographer) q.set("photographer", p.photographer);
  if (p.risk) q.set("risk", "1");
  if (p.view === "table") q.set("view", "table");
  const s = q.toString();
  return `/ops/photo-delivery${s ? `?${s}` : ""}`;
}

/**
 * Where the edits are, in plain words (Oct 14 2026): the hub sends the raws to
 * AutoHDR itself, so "waiting for the Aryeo listing" is no longer the story.
 * The first batch that is not finished speaks; null when every batch is in.
 */
export function intakeLine(intake: IntakeView[], hasPhotos: boolean): string | null {
  const live = intake.find((b) => !["DONE", "LINKED"].includes(b.state)) ?? null;
  const more = (b: IntakeView) => (b.batchNo > 1 ? "Photos added later: " : "");
  const about = (b: IntakeView) => `${b.fileCount} raw file${b.fileCount === 1 ? "" : "s"}${b.expectedPhotos ? `, about ${b.expectedPhotos} photo${b.expectedPhotos === 1 ? "" : "s"}` : ""}`;
  if (!live) {
    if (hasPhotos) return null;
    const done = intake.find((b) => b.state === "DONE");
    if (done) return `AutoHDR finished${done.doneAt ? ` at ${etTime(done.doneAt)}` : ""} (${done.imageCount ?? 0} photos). They appear here within a few minutes.`;
    if (intake.some((b) => b.state === "LINKED")) return "This shoot was already in AutoHDR (added by hand), so the hub did not send it again. The photos appear here once they are on the Aryeo listing.";
    return "No photos yet. When the photographer's upload is finished, the hub sends the raws to AutoHDR; the edited photos appear here as soon as AutoHDR is done.";
  }
  if (live.state === "WAITING") return `${more(live)}The raws are in Dropbox (${about(live)}). The hub sends them to AutoHDR once the upload has been still for 10 minutes.`;
  if (live.state === "SENDING" || live.state === "LANDING") return `${more(live)}Sending to AutoHDR now (${about(live)}).`;
  if (live.state === "PROCESSING") return `${more(live)}Sent to AutoHDR${live.sentAt ? ` at ${etTime(live.sentAt)}` : ""} (${about(live)}). AutoHDR is editing them, usually 30 to 60 minutes; the photos appear here when it is done.`;
  if (live.state === "UNCERTAIN") return `${more(live)}Checking whether AutoHDR received the upload (the reply was lost).`;
  if (live.state === "FAILED") return `${more(live)}Sending to AutoHDR did not work: ${live.lastError ?? "unknown error"}`;
  return null;
}

// ---- the gallery order (Oct 14 2026, huddle finding 10) ---------------------------------------

/** `ids` moved together (in their current order) so they land where `targetId` is. */
export function moveTogether(order: string[], ids: string[], targetIndex: number): string[] {
  const set = new Set(ids);
  const moving = order.filter((id) => set.has(id));
  if (!moving.length) return order;
  const rest = order.filter((id) => !set.has(id));
  const target = order[Math.max(0, Math.min(order.length - 1, targetIndex))];
  let at: number;
  if (set.has(target)) {
    // Dropped on one of the moving photos: the block starts where that photo is now.
    at = order.slice(0, targetIndex).filter((id) => !set.has(id)).length;
  } else {
    const firstFrom = order.indexOf(moving[0]);
    const pos = rest.indexOf(target);
    at = firstFrom < targetIndex ? pos + 1 : pos;
  }
  at = Math.max(0, Math.min(rest.length, at));
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}
