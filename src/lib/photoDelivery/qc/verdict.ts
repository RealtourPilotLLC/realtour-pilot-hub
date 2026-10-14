import { ruleById, SEVERITY_RANK, type RuleOverride, type Severity } from "../registry";

// ---------------------------------------------------------------------------
// GROUPING, SEVERITY POLICY, VERDICTS AND DELIVERY ORDER (plan §7.5, §7.6).
//
// Pure functions over finding and photo rows, computed ON READ: the UI and
// the run call the same code, so a ticket count on the queue card and the
// verdict that moved the job can never disagree. No database, no server-only
// imports: safe in any server component (import from this file directly).
//
//   groupFindings  same ruleId + groupKey across photos = one ticket; the
//                  registry's count-based escalation; client overrides last;
//                  the display floor splits off a "low confidence" drawer
//                  that never blocks.
//   jobVerdict     HOLD / NEEDS_DECISION / PASS_WITH_MINOR / PASS, with the
//                  arbiter's outcome: an unresolved CRITICAL holds when its
//                  arbitration is CONFIRMED, NOT_REQUIRED or PENDING; an
//                  OVERTURNED one carries the arbiter's severity; privacy is
//                  never below MAJOR.
//   deliveryOrder  hero first (twilight if any, else the best front exterior
//                  by hero score), then the sequence groups in order, AutoHDR
//                  order inside a group, excluded photos out.
//   finalFilenames NN-Room-Label.jpg ("-Twilight" before the extension for a
//                  twilight frame).
// ---------------------------------------------------------------------------

export type JobVerdict = "HOLD" | "NEEDS_DECISION" | "PASS_WITH_MINOR" | "PASS";
export type PhotoVerdict = "HOLD" | "NEEDS_FIX" | "PASS_WITH_MINOR" | "PASS";

/** Unresolved = still waiting on the hub (the same set the delivery gate and
 *  the stage rule in decisions.ts use). A person's decision (ignored, false
 *  positive, overridden, sent to the editor, reshoot requested) resolves it
 *  for the verdict; FIXED is done; SUPERSEDED rows are history. */
export const UNRESOLVED_STATUSES = ["OPEN", "APPROVED_FIX", "FIXING"] as const;
export const HOLDING_ARBITRATION = ["CONFIRMED", "NOT_REQUIRED", "PENDING"] as const;
export const DEFAULT_DISPLAY_FLOOR = 0.5;

export type FindingLike = {
  id: string;
  ruleId: string;
  groupKey: string;
  photoId: string | null;
  /** The JSON column, or an already-parsed list. */
  photoIdsJson?: string | null;
  photoIds?: string[] | null;
  severity: string;
  confidence: number;
  status: string;
  arbitration: string;
  privacySensitive: boolean;
  specificIssue?: string | null;
  source?: string | null;
};

export function isUnresolved(status: string): boolean {
  return (UNRESOLVED_STATUSES as readonly string[]).includes(status);
}

export function photoIdsOf(f: Pick<FindingLike, "photoId" | "photoIdsJson" | "photoIds">): string[] {
  if (f.photoIds && f.photoIds.length) return f.photoIds;
  if (f.photoIdsJson) {
    try {
      const v = JSON.parse(f.photoIdsJson) as unknown;
      if (Array.isArray(v) && v.length) return v.filter((x): x is string => typeof x === "string");
    } catch {
      /* fall through to photoId */
    }
  }
  return f.photoId ? [f.photoId] : [];
}

const asSeverity = (s: string): Severity => (s === "CRITICAL" || s === "MAJOR" || s === "MINOR" ? s : "MAJOR");
const maxSev = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/** The severity a finding counts with: a client's rule override applies last,
 *  and a privacy finding never drops below MAJOR. */
export function effectiveSeverity(f: Pick<FindingLike, "ruleId" | "severity" | "privacySensitive">, overrides?: RuleOverride[] | null): Severity {
  let s = asSeverity(f.severity);
  const o = overrides?.find((x) => x.ruleId === f.ruleId && x.severity);
  if (o?.severity) s = o.severity;
  if (f.privacySensitive && SEVERITY_RANK[s] < SEVERITY_RANK.MAJOR) s = "MAJOR";
  return s;
}

/** Below the display floor (or the rule's calibrated cutoff): shown in the
 *  low-confidence drawer, never blocking (plan §7.5, pack 12.4). */
export function isLowConfidence(f: Pick<FindingLike, "ruleId" | "confidence">, floor = DEFAULT_DISPLAY_FLOOR, ruleFloors?: Record<string, number> | null): boolean {
  const cut = ruleFloors?.[f.ruleId] ?? floor;
  return f.confidence < cut;
}

/** "N or more photos" in a rule's escalateTo.when, and whether it is about the
 *  SAME spot (then only a spot-specific group may escalate). */
export function countEscalation(ruleId: string): { n: number; to: Severity; sameSpot: boolean; when: string } | null {
  const r = ruleById(ruleId);
  const when = r?.escalateTo?.when ?? "";
  const m = /(\d+) or more photos/i.exec(when);
  if (!r?.escalateTo || !m) return null;
  return { n: Number(m[1]), to: r.escalateTo.severity, sameSpot: /same spot/i.test(when), when };
}

/** Group keys that name ONE physical spot repeated across photos. */
export const isSpotSpecificGroup = (groupKey: string) => /-repeated-/.test(groupKey);

export type FindingGroup = {
  key: string;
  ruleId: string;
  groupKey: string;
  title: string;
  /** Effective severity after overrides, the privacy floor and escalation. */
  severity: Severity;
  escalated: boolean;
  escalationReason: string | null;
  photoIds: string[];
  findingIds: string[];
  unresolvedIds: string[];
  maxConfidence: number;
  lowConfidence: boolean;
  privacy: boolean;
  /** An unresolved CRITICAL that holds delivery (arbitration rule above). */
  holds: boolean;
};

export type GroupOptions = {
  floor?: number;
  ruleFloors?: Record<string, number> | null;
  overrides?: RuleOverride[] | null;
  /** Findings only about these photos drop out (excluded from delivery). */
  excludedPhotoIds?: Iterable<string> | null;
};

function buildGroups(rows: FindingLike[], opts: GroupOptions, low: boolean): FindingGroup[] {
  const byKey = new Map<string, FindingLike[]>();
  for (const f of rows) {
    const key = `${f.ruleId}::${f.groupKey}`;
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  const groups: FindingGroup[] = [];
  for (const [key, members] of byKey) {
    const open = members.filter((m) => isUnresolved(m.status));
    const counted = open.length ? open : members;
    let severity: Severity = "MINOR";
    for (const m of counted) severity = maxSev(severity, effectiveSeverity(m, opts.overrides));
    const photoIds = [...new Set(members.flatMap(photoIdsOf))];
    const openPhotos = [...new Set(open.flatMap(photoIdsOf))];
    let escalated = false;
    let escalationReason: string | null = null;
    const esc = countEscalation(members[0].ruleId);
    if (esc && openPhotos.length >= esc.n && SEVERITY_RANK[esc.to] > SEVERITY_RANK[severity] && (!esc.sameSpot || isSpotSpecificGroup(members[0].groupKey))) {
      severity = esc.to;
      escalated = true;
      escalationReason = `${openPhotos.length} photos: ${esc.when}`;
    }
    // Client overrides apply last (plan §7.5), including over an escalation.
    const override = opts.overrides?.find((o) => o.ruleId === members[0].ruleId && o.severity);
    if (override?.severity && override.severity !== severity) {
      severity = override.severity;
      escalationReason = escalated ? `${escalationReason}; client override ${override.severity}` : escalationReason;
    }
    const privacy = members.some((m) => m.privacySensitive);
    if (privacy && SEVERITY_RANK[severity] < SEVERITY_RANK.MAJOR) severity = "MAJOR";
    const holds =
      !low &&
      open.length > 0 &&
      severity === "CRITICAL" &&
      open.some((m) => (HOLDING_ARBITRATION as readonly string[]).includes(m.arbitration) && (escalated || effectiveSeverity(m, opts.overrides) === "CRITICAL" || !!override?.severity));
    const rule = ruleById(members[0].ruleId);
    const label = rule?.shortLabel ?? members[0].specificIssue ?? members[0].ruleId;
    groups.push({
      key,
      ruleId: members[0].ruleId,
      groupKey: members[0].groupKey,
      title: photoIds.length > 1 ? `${label}: ${photoIds.length} photos` : label,
      severity,
      escalated,
      escalationReason,
      photoIds,
      findingIds: members.map((m) => m.id),
      unresolvedIds: open.map((m) => m.id),
      maxConfidence: Math.max(...members.map((m) => m.confidence)),
      lowConfidence: low,
      privacy,
      holds,
    });
  }
  return groups.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.photoIds.length - a.photoIds.length || (a.key < b.key ? -1 : 1));
}

/**
 * Tickets: findings with the same ruleId and groupKey across photos become one
 * group. SUPERSEDED rows are history and drop out; findings about excluded
 * photos only drop out; findings below the display floor form their own
 * low-confidence groups (shown collapsed, never blocking).
 */
export function groupFindings(findings: FindingLike[], opts: GroupOptions = {}): { groups: FindingGroup[]; lowConfidence: FindingGroup[] } {
  const excluded = new Set(opts.excludedPhotoIds ?? []);
  const floor = opts.floor ?? DEFAULT_DISPLAY_FLOOR;
  // A check switched off (house-wide or for the client) never counts or shows.
  const off = new Set((opts.overrides ?? []).filter((o) => o.disabled).map((o) => o.ruleId));
  const live = findings.filter((f) => {
    if (f.status === "SUPERSEDED") return false;
    if (off.has(f.ruleId)) return false;
    // Oct 14 2026: an ordered add-on suggestion (virtual twilight, staging,
    // declutter) is a suggestion, never a defect.
    if (f.source === "ADDON") return false;
    const ids = photoIdsOf(f);
    return !ids.length || ids.some((id) => !excluded.has(id));
  });
  const main = live.filter((f) => !isLowConfidence(f, floor, opts.ruleFloors));
  const low = live.filter((f) => isLowConfidence(f, floor, opts.ruleFloors));
  return { groups: buildGroups(main, opts, false), lowConfidence: buildGroups(low, opts, true) };
}

export type VerdictResult = {
  verdict: JobVerdict;
  groups: FindingGroup[];
  lowConfidence: FindingGroup[];
  holding: FindingGroup[];
  counts: { critical: number; major: number; minor: number; lowConfidence: number };
  /** Anything unresolved at MAJOR or above (the shadow-mode stage rule). */
  hasMajorPlus: boolean;
};

/** The job verdict from all of a job's findings (plan §7.5). */
export function jobVerdict(findings: FindingLike[], opts: GroupOptions = {}): VerdictResult {
  const { groups, lowConfidence } = groupFindings(findings, opts);
  const open = groups.filter((g) => g.unresolvedIds.length > 0);
  const holding = open.filter((g) => g.holds);
  const counts = {
    critical: open.filter((g) => g.severity === "CRITICAL").length,
    major: open.filter((g) => g.severity === "MAJOR").length,
    minor: open.filter((g) => g.severity === "MINOR").length,
    lowConfidence: lowConfidence.filter((g) => g.unresolvedIds.length > 0).length,
  };
  const hasMajorPlus = counts.critical + counts.major > 0;
  // An OVERTURNED CRITICAL does not hold, but it still needs a decision.
  const verdict: JobVerdict = holding.length ? "HOLD" : hasMajorPlus ? "NEEDS_DECISION" : counts.minor ? "PASS_WITH_MINOR" : "PASS";
  return { verdict, groups, lowConfidence, holding, counts, hasMajorPlus };
}

/** Per-photo verdict (stored on PhotoAsset.verdict), with the same grouping,
 *  so a photo inside an escalated group carries the group's severity. */
export function photoVerdicts(findings: FindingLike[], photoIds: string[], opts: GroupOptions = {}): Record<string, PhotoVerdict> {
  const { groups } = groupFindings(findings, opts);
  const out: Record<string, PhotoVerdict> = {};
  for (const id of photoIds) out[id] = "PASS";
  const rank: Record<PhotoVerdict, number> = { PASS: 0, PASS_WITH_MINOR: 1, NEEDS_FIX: 2, HOLD: 3 };
  for (const g of groups) {
    if (!g.unresolvedIds.length) continue;
    const v: PhotoVerdict = g.holds ? "HOLD" : g.severity === "MINOR" ? "PASS_WITH_MINOR" : "NEEDS_FIX";
    const unresolved = new Set(g.unresolvedIds);
    const ids = new Set(findings.filter((f) => unresolved.has(f.id)).flatMap(photoIdsOf));
    for (const id of ids) if (id in out && rank[v] > rank[out[id]]) out[id] = v;
  }
  return out;
}

/** Where QC leaves the job (plan §3.3, §7.7). Shadow mode records the verdict
 *  and never holds: anything at MAJOR or above → QC_REVIEW, else READY. */
export function qcStageFor(v: Pick<VerdictResult, "verdict" | "hasMajorPlus">, shadow: boolean): "ON_HOLD" | "QC_REVIEW" | "READY" {
  if (shadow) return v.hasMajorPlus ? "QC_REVIEW" : "READY";
  if (v.verdict === "HOLD") return "ON_HOLD";
  if (v.verdict === "NEEDS_DECISION") return "QC_REVIEW";
  return "READY";
}

// ---- delivery order (plan §7.6) ----------------------------------------------------------------

export const DEFAULT_SEQUENCE = [
  "FRONT_EXTERIOR", "ENTRY", "MAIN_LIVING", "KITCHEN", "PRIMARY_SUITE", "BEDROOMS", "BATHROOMS", "FLEX",
  "LOWER_LEVEL", "UTILITY", "OUTDOOR_LIVING", "REAR_EXTERIOR", "AERIAL", "COMMUNITY", "DETAIL",
] as const;

const GROUP_OF_ROOM: Record<string, string> = {
  EXTERIOR_FRONT: "FRONT_EXTERIOR", TWILIGHT_EXTERIOR: "FRONT_EXTERIOR", ENTRY_FOYER: "ENTRY",
  LIVING: "MAIN_LIVING", FAMILY: "MAIN_LIVING", DINING: "MAIN_LIVING", KITCHEN: "KITCHEN",
  PRIMARY_BEDROOM: "PRIMARY_SUITE", PRIMARY_BATHROOM: "PRIMARY_SUITE", BEDROOM: "BEDROOMS", CLOSET: "BEDROOMS",
  BATHROOM: "BATHROOMS", POWDER_ROOM: "BATHROOMS", OFFICE: "FLEX", HALLWAY: "FLEX", STAIRCASE: "FLEX", OTHER: "FLEX",
  BASEMENT_FINISHED: "LOWER_LEVEL", BASEMENT_UNFINISHED: "LOWER_LEVEL", LAUNDRY: "UTILITY", GARAGE: "UTILITY", STORAGE: "UTILITY",
  PATIO_DECK: "OUTDOOR_LIVING", POOL_SPA: "OUTDOOR_LIVING", YARD: "OUTDOOR_LIVING",
  EXTERIOR_REAR: "REAR_EXTERIOR", EXTERIOR_SIDE: "REAR_EXTERIOR", AERIAL: "AERIAL", COMMUNITY_AMENITY: "COMMUNITY", DETAIL: "DETAIL",
};

export type OrderPhoto = {
  id: string;
  name: string;
  sequence: number;
  status: string;
  roomType?: string | null;
  sequenceGroup?: string | null;
  heroScore?: number | null;
  isTwilight?: boolean | null;
  isAerial?: boolean | null;
  isPrimaryCandidate?: boolean | null;
};

const bySeq = (a: OrderPhoto, b: OrderPhoto) => a.sequence - b.sequence || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byHero = (a: OrderPhoto, b: OrderPhoto) => (b.heroScore ?? -1) - (a.heroScore ?? -1) || bySeq(a, b);

export function groupOf(p: OrderPhoto): string | null {
  return p.sequenceGroup || (p.roomType ? GROUP_OF_ROOM[p.roomType] ?? null : null);
}

/** The suggested hero (plan §7.6): the best twilight frame if any (ground
 *  level before aerial), else the best front exterior, else the best primary
 *  candidate, else the best hero score, else the first photo. */
export function suggestedHero(photos: OrderPhoto[]): OrderPhoto | null {
  const active = photos.filter((p) => p.status === "ACTIVE");
  if (!active.length) return null;
  const twilight = active.filter((p) => p.isTwilight || p.roomType === "TWILIGHT_EXTERIOR");
  if (twilight.length) return [...twilight].sort((a, b) => Number(!!a.isAerial) - Number(!!b.isAerial) || byHero(a, b))[0];
  const front = active.filter((p) => groupOf(p) === "FRONT_EXTERIOR" || p.roomType === "EXTERIOR_FRONT");
  if (front.length) return [...front].sort(byHero)[0];
  const primary = active.filter((p) => p.isPrimaryCandidate);
  if (primary.length) return [...primary].sort(byHero)[0];
  if (active.some((p) => typeof p.heroScore === "number")) return [...active].sort(byHero)[0];
  return [...active].sort(bySeq)[0];
}

/**
 * The delivery order: hero first, then each sequence group in the template's
 * order (the client profile may supply one), AutoHDR order inside a group,
 * unclassified photos last. `manualOrder` (PhotoJob.orderJson, a person's
 * order) wins: its photos in its order, any new photo appended in suggested
 * order. `heroId` (PhotoJob.heroPhotoId) wins over the suggestion when active.
 */
export function deliveryOrder<P extends OrderPhoto>(photos: P[], opts: { groupOrder?: string[] | null; heroId?: string | null; manualOrder?: string[] | null } = {}): { order: P[]; heroId: string | null } {
  const active = photos.filter((p) => p.status === "ACTIVE");
  const byId = new Map(active.map((p) => [p.id, p]));
  const pinned = opts.heroId ? byId.get(opts.heroId) : undefined;
  const hero = (pinned ?? suggestedHero(active)) as P | null;
  const template = (opts.groupOrder?.length ? opts.groupOrder : [...DEFAULT_SEQUENCE]) as string[];
  const rest = active.filter((p) => p !== hero);
  const rankOf = (p: P) => {
    const g = groupOf(p);
    const i = g ? template.indexOf(g) : -1;
    return i >= 0 ? i : g ? template.length : template.length + 1;
  };
  const suggested = [...(hero ? [hero] : []), ...rest.sort((a, b) => rankOf(a) - rankOf(b) || bySeq(a, b))];
  if (opts.manualOrder?.length) {
    const seen = new Set<string>();
    const manual: P[] = [];
    for (const id of opts.manualOrder) {
      const p = byId.get(id);
      if (p && !seen.has(id)) {
        manual.push(p);
        seen.add(id);
      }
    }
    for (const p of suggested) if (!seen.has(p.id)) manual.push(p);
    return { order: manual, heroId: manual[0]?.id ?? null };
  }
  return { order: suggested, heroId: hero?.id ?? null };
}

const ROOM_LABEL: Record<string, string> = {
  EXTERIOR_FRONT: "Front-Exterior", TWILIGHT_EXTERIOR: "Front-Exterior", EXTERIOR_REAR: "Rear-Exterior", EXTERIOR_SIDE: "Side-Exterior",
  AERIAL: "Aerial", PATIO_DECK: "Patio", POOL_SPA: "Pool", YARD: "Yard", COMMUNITY_AMENITY: "Community",
  ENTRY_FOYER: "Entry", LIVING: "Living-Room", FAMILY: "Family-Room", DINING: "Dining-Room", KITCHEN: "Kitchen",
  OFFICE: "Office", BEDROOM: "Bedroom", PRIMARY_BEDROOM: "Primary-Bedroom", BATHROOM: "Bathroom",
  PRIMARY_BATHROOM: "Primary-Bathroom", POWDER_ROOM: "Powder-Room", LAUNDRY: "Laundry-Room", GARAGE: "Garage",
  BASEMENT_FINISHED: "Finished-Basement", BASEMENT_UNFINISHED: "Basement", STORAGE: "Storage", HALLWAY: "Hallway",
  STAIRCASE: "Staircase", CLOSET: "Closet", DETAIL: "Detail", OTHER: "Photo",
};

/** "Front-Exterior", "Primary-Bathroom"... ("Photo" when unclassified). */
export function roomLabel(p: Pick<OrderPhoto, "roomType">): string {
  return (p.roomType && ROOM_LABEL[p.roomType]) || "Photo";
}

/** Final names in delivery order: NN-Room-Label.jpg, zero-padded to the
 *  gallery's width (2 digits minimum), "-Twilight" before the extension for
 *  a twilight frame (01-Front-Exterior-Twilight.jpg). */
export function finalFilenames(ordered: Pick<OrderPhoto, "id" | "roomType" | "isTwilight">[]): { photoId: string; filename: string }[] {
  const width = Math.max(2, String(ordered.length).length);
  return ordered.map((p, i) => {
    const twilight = !!p.isTwilight || p.roomType === "TWILIGHT_EXTERIOR";
    return { photoId: p.id, filename: `${String(i + 1).padStart(width, "0")}-${roomLabel(p)}${twilight ? "-Twilight" : ""}.jpg` };
  });
}
