// ---------------------------------------------------------------------------
// THE QC RULES REGISTRY (Photo Delivery, Oct 13 2026).
//
// docs/photo-delivery/02-QC-RULES-REGISTRY.md explains every rule; the JSON
// beside this file is the source of truth (425 rules, one per bullet of the
// Master Photography QC Checklist). This module is the only reader: it types
// the rows, expands room scopes, filters by pass and room, and renders the
// deterministic <rules> block the Claude passes receive (sorted by id, compact
// JSON, no timestamps, so the prompt cache prefix is stable per room type).
//
// Pure code: no database, no network. Client rule overrides are applied by the
// caller (see applyOverrides) so the same registry serves every client.
// ---------------------------------------------------------------------------

import seed from "./qc-rules.seed.json";

export const RULES_REGISTRY_VERSION = "v1-2026-10-13";

export const SEVERITIES = ["CRITICAL", "MAJOR", "MINOR"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PASSES = ["P1_PHOTO", "P2_GALLERY", "P3_COMPARE", "P4_ORDER"] as const;
export type Pass = (typeof PASSES)[number];
export type Detector = "VISION_PHOTO" | "VISION_GALLERY" | "VISION_COMPARE" | "CV" | "METADATA" | "ORDER_DATA" | "WORKFLOW";
export const RESPONSIBILITIES = ["PHOTOGRAPHER", "EDITOR", "ADMIN", "HUMAN_REVIEW"] as const;
export type Responsibility = (typeof RESPONSIBILITIES)[number];

export const ROOM_TYPES = [
  "EXTERIOR_FRONT", "EXTERIOR_REAR", "EXTERIOR_SIDE", "AERIAL", "TWILIGHT_EXTERIOR", "PATIO_DECK",
  "POOL_SPA", "YARD", "COMMUNITY_AMENITY", "ENTRY_FOYER", "LIVING", "FAMILY", "DINING", "KITCHEN",
  "OFFICE", "BEDROOM", "PRIMARY_BEDROOM", "BATHROOM", "PRIMARY_BATHROOM", "POWDER_ROOM", "LAUNDRY",
  "GARAGE", "BASEMENT_FINISHED", "BASEMENT_UNFINISHED", "STORAGE", "HALLWAY", "STAIRCASE", "CLOSET",
  "DETAIL", "OTHER",
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export type RoomScope = "ANY" | "INTERIOR" | "EXTERIOR" | "WET_ROOMS" | "BATHROOMS" | "BEDROOMS" | "LIVING_SPACES" | "UTILITY" | "GALLERY" | "ORDER";

export const FIX_STRATEGIES = [
  "AUTOREMOVE_MASK", "DECLUTTER", "REEDIT_PROMPT", "CAMERA_REMOVAL", "GRASS", "STYLE_RERENDER",
  "REVERT_VERSION", "EDITOR_MANUAL", "RESHOOT", "ADMIN_ACTION", "HUMAN_REVIEW", "NONE",
] as const;
export type FixStrategy = (typeof FIX_STRATEGIES)[number];
export type AutohdrTransform = "autoremove" | "declutter" | "reedit" | "camera_removal" | "grass" | "style" | "twilight" | "single_angle_staging";

/** Strategies that spend (or can spend) AutoHDR credits through a transform. */
export const AUTOHDR_STRATEGIES: ReadonlySet<FixStrategy> = new Set(["AUTOREMOVE_MASK", "DECLUTTER", "REEDIT_PROMPT", "CAMERA_REMOVAL", "GRASS", "STYLE_RERENDER"]);
/** The AutoHDR transform each credit strategy runs. */
export const STRATEGY_TRANSFORM: Partial<Record<FixStrategy, AutohdrTransform>> = {
  AUTOREMOVE_MASK: "autoremove",
  DECLUTTER: "declutter",
  REEDIT_PROMPT: "reedit",
  CAMERA_REMOVAL: "camera_removal",
  GRASS: "grass",
  STYLE_RERENDER: "style",
};

export type QcRule = {
  id: string;
  section: number;
  sectionName: string;
  checklistText: string;
  shortLabel: string;
  rooms: (RoomType | RoomScope)[];
  excludeRooms?: (RoomType | RoomScope)[];
  pass: Pass;
  detector: Detector;
  secondaryDetector?: Detector;
  defaultSeverity: Severity;
  escalateTo?: { severity: Severity; when: string } | null;
  deescalateTo?: { severity: Severity; when: string } | null;
  fixStrategies: FixStrategy[];
  autohdrTransform?: AutohdrTransform | null;
  reeditPromptTemplate?: string;
  responsibility: Responsibility;
  postFixable: "YES" | "NO" | "SOMETIMES";
  reshootPossible: boolean;
  permanentFeatureRisk: boolean;
  autoFixEligible: boolean;
  buildPhase: 1 | 2 | 3;
  priorityRank?: number;
  groupKey: string;
  visionHint?: string;
  cvHint?: string;
};

export const RULES: readonly QcRule[] = seed as unknown as QcRule[];
const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function ruleById(id: string): QcRule | undefined {
  return BY_ID.get(id);
}

export const OTHER_DEFECT = "OTHER_DEFECT";

// ---- room scopes ----------------------------------------------------------------

const EXTERIOR: RoomType[] = ["EXTERIOR_FRONT", "EXTERIOR_REAR", "EXTERIOR_SIDE", "AERIAL", "TWILIGHT_EXTERIOR", "PATIO_DECK", "POOL_SPA", "YARD", "COMMUNITY_AMENITY"];
const SCOPES: Record<Exclude<RoomScope, "ANY" | "INTERIOR" | "GALLERY" | "ORDER">, RoomType[]> = {
  EXTERIOR,
  WET_ROOMS: ["BATHROOM", "PRIMARY_BATHROOM", "POWDER_ROOM", "LAUNDRY", "KITCHEN"],
  BATHROOMS: ["BATHROOM", "PRIMARY_BATHROOM", "POWDER_ROOM"],
  BEDROOMS: ["BEDROOM", "PRIMARY_BEDROOM"],
  LIVING_SPACES: ["LIVING", "FAMILY", "OFFICE", "DINING", "ENTRY_FOYER"],
  UTILITY: ["GARAGE", "BASEMENT_UNFINISHED", "STORAGE", "LAUNDRY"],
};

export function isExteriorRoom(room: RoomType): boolean {
  return EXTERIOR.includes(room);
}

/** Expand one scope or room label to the concrete room types it covers. */
export function expandScope(token: RoomType | RoomScope): RoomType[] {
  if (token === "ANY") return [...ROOM_TYPES];
  if (token === "INTERIOR") return ROOM_TYPES.filter((r) => !EXTERIOR.includes(r));
  if (token === "GALLERY" || token === "ORDER") return [];
  if (token in SCOPES) return SCOPES[token as keyof typeof SCOPES];
  return (ROOM_TYPES as readonly string[]).includes(token) ? [token as RoomType] : [];
}

/** Does `rule` apply to a photo of `room`? (rooms minus excludeRooms) */
export function ruleAppliesToRoom(rule: QcRule, room: RoomType): boolean {
  const inScope = rule.rooms.some((t) => expandScope(t).includes(room));
  if (!inScope) return false;
  return !(rule.excludeRooms ?? []).some((t) => expandScope(t).includes(room));
}

// ---- overrides (client QC profile) ------------------------------------------------

export type RuleOverride = { ruleId: string; severity?: Severity; disabled?: boolean; reason: string };

/** Apply a client's overrides: disabled rules drop out; a severity override
 *  replaces the default (escalation and de-escalation still apply around it). */
export function applyOverrides(rules: readonly QcRule[], overrides: RuleOverride[] | null | undefined): QcRule[] {
  if (!overrides?.length) return [...rules];
  const map = new Map(overrides.map((o) => [o.ruleId, o]));
  const out: QcRule[] = [];
  for (const r of rules) {
    const o = map.get(r.id);
    if (o?.disabled) continue;
    out.push(o?.severity ? { ...r, defaultSeverity: o.severity } : r);
  }
  return out;
}

// ---- filtering ----------------------------------------------------------------------

export type RuleFilter = {
  pass: Pass;
  /** Rules up to this build phase. CRITICAL-capable rules always run. */
  maxBuildPhase: 1 | 2 | 3;
  /** Only rules whose detector is one of these (default: every detector). */
  detectors?: Detector[];
  overrides?: RuleOverride[] | null;
};

export function canBeCritical(r: QcRule): boolean {
  return r.defaultSeverity === "CRITICAL" || r.escalateTo?.severity === "CRITICAL";
}

/** The rules of one pass, phase-gated, with client overrides applied. */
export function rulesForPass(f: RuleFilter): QcRule[] {
  const base = applyOverrides(RULES, f.overrides);
  return base.filter(
    (r) =>
      r.pass === f.pass &&
      (r.buildPhase <= f.maxBuildPhase || canBeCritical(r)) &&
      (!f.detectors || f.detectors.includes(r.detector) || (r.secondaryDetector != null && f.detectors.includes(r.secondaryDetector))),
  );
}

/**
 * P1 vision rules for a photo. When the classifier is unsure (confidence below
 * 0.6) the union of the rules for both candidate rooms is injected, exactly as
 * the prompt pack (section 0.5) asks.
 */
export function visionRulesForPhoto(input: {
  roomType: RoomType;
  roomConfidence: number;
  alternateRoomType: RoomType | null;
  maxBuildPhase: 1 | 2 | 3;
  overrides?: RuleOverride[] | null;
}): QcRule[] {
  const rooms = [input.roomType];
  if (input.roomConfidence < 0.6 && input.alternateRoomType && input.alternateRoomType !== input.roomType) rooms.push(input.alternateRoomType);
  return rulesForPass({ pass: "P1_PHOTO", maxBuildPhase: input.maxBuildPhase, detectors: ["VISION_PHOTO"], overrides: input.overrides })
    .filter((r) => rooms.some((room) => ruleAppliesToRoom(r, room)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- rendering --------------------------------------------------------------------------

/** One compact JSON object per line, optional keys omitted. Deterministic. */
export function renderRuleLine(r: QcRule): string {
  const o: Record<string, unknown> = {
    id: r.id,
    shortLabel: r.shortLabel,
    checklistText: r.checklistText,
    defaultSeverity: r.defaultSeverity,
  };
  if (r.escalateTo) {
    o.escalateTo = r.escalateTo.severity;
    o.escalateWhen = r.escalateTo.when;
  }
  if (r.deescalateTo) {
    o.deescalateTo = r.deescalateTo.severity;
    o.deescalateWhen = r.deescalateTo.when;
  }
  if (r.visionHint) o.visionHint = r.visionHint;
  o.fixStrategies = r.fixStrategies;
  if (r.permanentFeatureRisk) o.permanentFeatureRisk = true;
  return JSON.stringify(o);
}

export function renderRulesBlock(rules: QcRule[], label: string): string {
  const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [
    `<rules ${label} registry_version="${RULES_REGISTRY_VERSION}" count="${sorted.length}">`,
    ...sorted.map(renderRuleLine),
    "</rules>",
    "OTHER_DEFECT: a real, clearly visible defect that no rule above covers. Any severity, any fixStrategy.",
  ].join("\n");
}

/** The severities a finding on this rule may carry. */
export function allowedSeverities(r: QcRule): Set<Severity> {
  const s = new Set<Severity>([r.defaultSeverity]);
  if (r.escalateTo) s.add(r.escalateTo.severity);
  if (r.deescalateTo) s.add(r.deescalateTo.severity);
  return s;
}

export const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 3, MAJOR: 2, MINOR: 1 };
export function worstSeverity(list: Severity[]): Severity | null {
  let best: Severity | null = null;
  for (const s of list) if (!best || SEVERITY_RANK[s] > SEVERITY_RANK[best]) best = s;
  return best;
}
