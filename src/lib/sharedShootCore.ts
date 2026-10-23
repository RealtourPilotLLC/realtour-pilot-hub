import { addonSlugNamesType } from "@/app/upload/shootAddOns";

// ---------------------------------------------------------------------------
// SHARED SHOOTS ON THE UPLOAD PAGE (Oct 23 2026, Jordan's spec). Pure and
// client-safe: the page, the server half (lib/sharedShoot) and the drills
// share every rule here.
//
// THE MODE comes from the shoot record alone: the people assigned to its live
// (not cancelled) appointments, plus a second shooter the office added
// (ProjectCrew). One person = the standard page; two or more = shared, with
// no toggle anywhere. An address never makes two jobs one shoot.
//
// WHAT EACH PERSON OWNS: their own contribution (what they captured, what
// they say is uploaded, when they submitted their part). One person's submit
// never marks another's part done. The job's own stamps (the halves, the
// whole wrap-up) stay exactly what they were: pay and the KPIs read those,
// and nothing here changes how.
//
// WHAT THEY SHARE: the instructions for the editor, as entries either of them
// can add to or edit, each with its author and every earlier version. A save
// against a version somebody else has already replaced is refused with
// theirs, never written over it.
// ---------------------------------------------------------------------------

/** What a photographer can say they captured. */
export type ServiceKey = "photos" | "drone" | "twilight" | "video" | "floorplan" | "tour" | "headshots";
export const SERVICE_KEYS: readonly ServiceKey[] = ["photos", "drone", "twilight", "video", "floorplan", "tour", "headshots"];
/** Always offered, whatever was ordered (Jordan's five). */
export const BASE_SERVICES: readonly ServiceKey[] = ["photos", "drone", "video", "floorplan", "tour"];
export const SERVICE_LABEL: Record<ServiceKey, string> = {
  photos: "Photos",
  drone: "Drone photos",
  twilight: "Twilight",
  video: "Video",
  floorplan: "Floor plan",
  tour: "3D tour",
  headshots: "Headshots",
};
export const isServiceKey = (v: unknown): v is ServiceKey => typeof v === "string" && (SERVICE_KEYS as readonly string[]).includes(v);

/** The service a deliverable row is (null: not something a photographer captures, e.g. virtual staging). */
export function serviceOfType(type: string): ServiceKey | null {
  switch (type) {
    case "PHOTOS": return "photos";
    case "DRONE": return "drone";
    case "TWILIGHT": return "twilight";
    case "VIDEO":
    case "SOCIAL_REEL": return "video";
    case "FLOORPLAN": return "floorplan";
    case "MATTERPORT_3D":
    case "ZILLOW_3D": return "tour";
    case "HEADSHOT": return "headshots";
    default: return null;
  }
}

export type Half = "photos" | "video";
/** Which handoff half a service belongs to (lib/handoff's PHOTO / VIDEO types); floor plans and tours have none. */
export function halfOfService(s: ServiceKey): Half | null {
  return s === "photos" || s === "drone" || s === "twilight" ? "photos" : s === "video" ? "video" : null;
}

/** The service an "Added at the shoot" item names (the office's add-on card), by the same words the order reconcile matches. */
export function serviceOfAddonItem(item: string): ServiceKey | null {
  const slug = item.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const order: [string, ServiceKey][] = [
    ["FLOORPLAN", "floorplan"], ["MATTERPORT_3D", "tour"], ["ZILLOW_3D", "tour"], ["TWILIGHT", "twilight"], ["DRONE", "drone"],
    ["HEADSHOT", "headshots"], ["SOCIAL_REEL", "video"], ["VIDEO", "video"], ["PHOTOS", "photos"],
  ];
  for (const [type, key] of order) if (addonSlugNamesType(slug, type)) return key;
  return null;
}

// ---- the roster ----------------------------------------------------------------

export type RosterMember = { memberId: string; name: string; via: "appointment" | "crew" | "photographer" };
type RosterAppt = { assignedToId: string | null; status: string | null; startAt?: Date | string | null };

/**
 * Who is on this shoot: the assignee of every live appointment (in the order
 * they shoot), then any second shooter the office added. The job's own
 * photographer counts only when no appointment names anyone. Pure.
 */
export function rosterOf(input: {
  photographer: { id: string; name: string } | null;
  appointments: RosterAppt[];
  crew: { memberId: string; name: string }[];
  names: Map<string, string>;
}): { members: RosterMember[]; shared: boolean } {
  const out: RosterMember[] = [];
  const seen = new Set<string>();
  const live = input.appointments
    .filter((a) => !/cancel/i.test(a.status ?? ""))
    .sort((a, b) => (a.startAt ? new Date(a.startAt).getTime() : Infinity) - (b.startAt ? new Date(b.startAt).getTime() : Infinity));
  for (const a of live) {
    if (!a.assignedToId || seen.has(a.assignedToId)) continue;
    seen.add(a.assignedToId);
    out.push({ memberId: a.assignedToId, name: input.names.get(a.assignedToId) ?? (input.photographer?.id === a.assignedToId ? input.photographer.name : "A photographer"), via: "appointment" });
  }
  if (!out.length && input.photographer) {
    seen.add(input.photographer.id);
    out.push({ memberId: input.photographer.id, name: input.photographer.name, via: "photographer" });
  }
  for (const c of input.crew) {
    if (seen.has(c.memberId)) continue;
    seen.add(c.memberId);
    out.push({ memberId: c.memberId, name: c.name, via: "crew" });
  }
  return { members: out, shared: out.length >= 2 };
}

// ---- contributions -------------------------------------------------------------

export type ContributionSubmit = { scope: "photos" | "video" | "all" | "part"; atISO: string; services: ServiceKey[] };
export type Contribution = {
  memberId: string;
  name: string;
  captured: ServiceKey[];
  /** the "Includes drone footage" tick under Video */
  videoDrone: boolean;
  /** "My selected files are uploaded", per service: the person's word, never a file check */
  uploaded: ServiceKey[];
  submits: ContributionSubmit[];
  version: number;
  updatedAtISO: string;
};
export const CONTRIBUTION_ACTION = "upload_contribution";
export const contributionRowId = (projectId: string, memberId: string, version: number) => `upl-contrib:${projectId}:${memberId}:${version}`;

const services = (v: unknown): ServiceKey[] => (Array.isArray(v) ? [...new Set(v.filter(isServiceKey))] : []);

/** One stored contribution version, or null when it cannot be read. */
export function parseContribution(detail: string | null | undefined): Contribution | null {
  try {
    const o = JSON.parse(detail ?? "") as Record<string, unknown>;
    if (typeof o.memberId !== "string" || !o.memberId || typeof o.version !== "number") return null;
    const submits = (Array.isArray(o.submits) ? o.submits : []).flatMap((x): ContributionSubmit[] => {
      const s = x as Record<string, unknown>;
      const scope = s?.scope === "photos" || s?.scope === "video" || s?.scope === "all" || s?.scope === "part" ? s.scope : null;
      return scope && typeof s.atISO === "string" ? [{ scope, atISO: s.atISO, services: services(s.services) }] : [];
    });
    return {
      memberId: o.memberId,
      name: typeof o.name === "string" && o.name.trim() ? o.name : "A photographer",
      captured: services(o.captured),
      videoDrone: o.videoDrone === true,
      uploaded: services(o.uploaded),
      submits: submits.slice(-20),
      version: o.version,
      updatedAtISO: typeof o.updatedAtISO === "string" ? o.updatedAtISO : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

/** The newest version of each person's contribution. */
export function latestContributions(details: string[]): Map<string, Contribution> {
  const out = new Map<string, Contribution>();
  for (const d of details) {
    const c = parseContribution(d);
    if (!c) continue;
    const cur = out.get(c.memberId);
    if (!cur || c.version > cur.version) out.set(c.memberId, c);
  }
  return out;
}

export type ContributionState = "not_started" | "in_progress" | "submitted";

/**
 * Where one person's part stands. Submitted = a submit of theirs covers every
 * service they say they captured (a submit before `floor` — an earlier visit
 * of their own — does not count, lib/visitSubmission's rule).
 */
export function contributionState(c: Contribution | null | undefined, floor: Date | null = null): ContributionState {
  if (!c) return "not_started";
  const subs = c.submits.filter((s) => !floor || Date.parse(s.atISO) >= floor.getTime());
  if (subs.length) {
    const covered = new Set(subs.flatMap((s) => s.services));
    const halves = new Set(subs.map((s) => s.scope));
    const all = halves.has("all");
    if (c.captured.every((k) => covered.has(k) || all || (halfOfService(k) && halves.has(halfOfService(k)!)))) return "submitted";
  }
  return c.captured.length || c.uploaded.length || subs.length ? "in_progress" : "not_started";
}

/** The newest submit that counts (see contributionState). */
export function lastSubmit(c: Contribution | null | undefined, floor: Date | null = null): ContributionSubmit | null {
  const subs = (c?.submits ?? []).filter((s) => !floor || Date.parse(s.atISO) >= floor.getTime());
  return subs.length ? subs[subs.length - 1] : null;
}

/**
 * What one submit hands off. Single page: the halves the job owes (two at
 * once only through the existing per-half buttons). Shared page: the halves of
 * the services THIS person captured; none of them (a floor plan or tour
 * only, or nothing ticked) is a submit of their part alone.
 */
export function halvesToSubmit(input: { shared: boolean; liveHalves: Half[]; myServices: ServiceKey[] }): Half[] {
  if (!input.shared) return input.liveHalves;
  const mine = new Set(input.myServices.map(halfOfService).filter((h): h is Half => !!h));
  return input.liveHalves.filter((h) => mine.has(h));
}

// ---- shared instructions -------------------------------------------------------

export const SHARED_NOTE_ACTION = "upload_shared_note";
export const sharedNoteRowId = (projectId: string, entryId: string, version: number) => `upl-note:${projectId}:${entryId}:v${version}`;
export const SHARED_NOTE_CAP = 2000;

export type SharedNoteVersion = {
  entryId: string;
  version: number;
  text: string;
  byName: string;
  byKey: string;
  atISO: string;
  deleted: boolean;
};
export type SharedNote = {
  entryId: string;
  version: number;
  text: string;
  /** who wrote it first */
  authorName: string;
  authorKey: string;
  createdAtISO: string;
  /** who changed it last, and when */
  lastByName: string;
  lastByKey: string;
  lastAtISO: string;
  deleted: boolean;
  /** every version, oldest first */
  history: SharedNoteVersion[];
};

export function parseSharedNoteVersion(detail: string | null | undefined): SharedNoteVersion | null {
  try {
    const o = JSON.parse(detail ?? "") as Record<string, unknown>;
    if (typeof o.entryId !== "string" || typeof o.version !== "number" || typeof o.text !== "string") return null;
    return {
      entryId: o.entryId,
      version: o.version,
      text: o.text,
      byName: typeof o.byName === "string" ? o.byName : "Someone",
      byKey: typeof o.byKey === "string" ? o.byKey : "",
      atISO: typeof o.atISO === "string" ? o.atISO : new Date(0).toISOString(),
      deleted: o.deleted === true,
    };
  } catch {
    return null;
  }
}

/** Every entry at its newest version, oldest entry first, with its history. */
export function foldSharedNotes(versions: SharedNoteVersion[]): SharedNote[] {
  const by = new Map<string, SharedNoteVersion[]>();
  for (const v of versions) by.set(v.entryId, [...(by.get(v.entryId) ?? []), v]);
  const out: SharedNote[] = [];
  for (const [entryId, list] of by) {
    const h = [...list].sort((a, b) => a.version - b.version);
    const first = h[0];
    const last = h[h.length - 1];
    out.push({
      entryId, version: last.version, text: last.text,
      authorName: first.byName, authorKey: first.byKey, createdAtISO: first.atISO,
      lastByName: last.byName, lastByKey: last.byKey, lastAtISO: last.atISO, deleted: last.deleted, history: h,
    });
  }
  return out.sort((a, b) => Date.parse(a.createdAtISO) - Date.parse(b.createdAtISO));
}

/** The refusal a stale save gets: who changed it, and their words. */
export function staleSaveMessage(current: { lastByName: string; text: string; deleted: boolean }, viewerName?: string | null): string {
  const who = current.lastByName && current.lastByName !== viewerName ? current.lastByName : "Someone (maybe you, in another tab)";
  return current.deleted
    ? `${who} removed this instruction while you were editing. Nothing was saved; your words are still in the box.`
    : `${who} changed this; here's ${who === current.lastByName ? "their" : "the newer"} version. Nothing was saved; your words are still in the box.`;
}

/** Entries changed after `at` (an earlier handoff), so the editor sees what moved since. */
export function changedSince<T extends { lastAtISO: string; createdAtISO: string }>(notes: T[], at: string | Date | null | undefined): T[] {
  if (!at) return [];
  const t = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(t)) return [];
  return notes.filter((n) => Date.parse(n.lastAtISO) > t);
}

// ---- conflicting instructions --------------------------------------------------
//
// The editor gets ONE organised brief, and where two instructions point
// opposite ways the brief says so instead of picking one. Read by words, so it
// is a flag for a person to look at, never a decision: "Feature the pool"
// against "Skip the pool shots" is flagged; "Feature the pool" twice is not.

const NEGATIVE = /\b(?:skip|skipping|avoid|avoiding|don'?t|do not|never|no|remove|removing|exclude|excluding|cut|cutting|leave out|drop|dropping|without|hide|not)\b/i;
const POSITIVE = /\b(?:show|showing|feature|featuring|include|including|use|using|keep|keeping|highlight|highlighting|focus|start with|open with|end with|lead with|add|want|wants|make sure|must|emphasi[sz]e|hero|get)\b/i;
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with", "from", "by", "it", "its", "this", "that", "these", "those", "is", "are", "be",
  "shot", "shots", "photo", "photos", "video", "videos", "clip", "clips", "footage", "edit", "editor", "please", "any", "all", "more", "less", "some",
  "first", "last", "then", "before", "after", "wide", "close", "ups", "up", "out", "them", "they", "their", "there", "here", "also", "just", "only",
  "make", "sure", "want", "wants", "show", "feature", "include", "use", "keep", "highlight", "focus", "start", "open", "end", "lead", "add", "must", "get",
  "skip", "avoid", "dont", "don't", "not", "never", "remove", "exclude", "cut", "leave", "drop", "without", "hide", "do", "no", "agent", "client", "realtor",
]);
const stem = (w: string) => w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
function subjects(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9'\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem),
  );
}
function polarity(text: string): "pos" | "neg" | null {
  const neg = NEGATIVE.test(text);
  const pos = POSITIVE.test(text);
  if (neg && !/\b(?:don'?t|do not|never) (?:skip|avoid|remove|cut|forget|miss)\b/i.test(text)) return "neg";
  if (pos || /\b(?:don'?t|do not|never) (?:skip|avoid|remove|cut|forget|miss)\b/i.test(text)) return "pos";
  return null;
}

export type ConflictItem = { id: string; who: string; text: string; source: string };
export type InstructionConflict = { a: ConflictItem; b: ConflictItem; subject: string };

/** Pairs of instructions that point opposite ways about the same thing. */
export function findConflicts(items: ConflictItem[]): InstructionConflict[] {
  const out: InstructionConflict[] = [];
  const read = items
    .map((it) => {
      // Each sentence on its own: "Show the pool. Skip the garage." is two instructions.
      const parts = it.text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
      return parts.map((p) => ({ it, pol: polarity(p), subj: subjects(p) }));
    })
    .flat()
    .filter((x) => x.pol && x.subj.size);
  const seen = new Set<string>();
  for (let i = 0; i < read.length; i++) {
    for (let j = i + 1; j < read.length; j++) {
      const x = read[i], y = read[j];
      if (x.it.id === y.it.id || x.pol === y.pol) continue;
      const shared = [...x.subj].filter((w) => y.subj.has(w));
      if (!shared.length) continue;
      const key = [x.it.id, y.it.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a: x.it, b: y.it, subject: shared[0] });
    }
  }
  return out;
}
