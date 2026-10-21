import "server-only";

import { prisma } from "@/lib/prisma";
import { photoDeliverySettings } from "./settings";
import { logJobEvent } from "./jobState";
import { fixClass } from "./fixPolicy";
import { isExteriorFinding, isExteriorRoom, type RoomType } from "./registry";

// ---------------------------------------------------------------------------
// PREPARED HOME OR NOT (Oct 15 2026).
//
// Jordan: "I don't need to know about clutter in an already cluttered house,
// but if it looks like its been taken care of and is not cluttered, but theres
// a random broom by the door, or a toilet seat is open, or a door mat is
// crooked, or if its vacant and relatively empty and there is random clutter
// there ... then thats what should be removed but I want to focus on removing
// things from properties where they took the time to prepare, not the ones
// that are dumps like Nehemiah's shoots."
//
// The free check rates every photo's room (prep): staged | tidy | lived_in |
// cluttered | empty. From those, once per shoot (finishCheck):
//   AS_IS     the client is on the as-is list, or a third or more of the
//             interior photos are lived in or cluttered: clutter is not
//             checked at all (filed IGNORED, "As-is home: clutter not
//             checked", never shown, never counted);
//   VACANT    60% or more of the interior photos are empty rooms: an item
//             left behind in an empty room counts (at 70% sure or more);
//   PREPARED  otherwise.
// Too few room readings (under 3 interior photos rated) and not listed: no
// shoot-level call (prepMode stays empty, the old fix-plan rule applies).
// Room level, in a prepared or vacant home: clutter counts only on photos
// rated staged, tidy or empty (or not rated); a lived-in or cluttered room is
// that room's state, not something the photographer missed.
// Camera mistakes, cars, trash cans (always wanted), privacy and geometry are
// never touched by any of this, and since Oct 21 2026 nothing outside either
// (isInteriorClutter): the rooms' state says nothing about the yard or the
// sidewalk. A person can set the mode on the job page;
// their choice stays until they put it back to automatic.
// ---------------------------------------------------------------------------

export const PREP_MODES = ["AS_IS", "PREPARED", "VACANT"] as const;
export type PrepMode = (typeof PREP_MODES)[number];
export const PHOTO_PREPS = ["staged", "tidy", "lived_in", "cluttered", "empty"] as const;
export type PhotoPrep = (typeof PHOTO_PREPS)[number];

export const AS_IS_SHARE = 0.34;
export const VACANT_SHARE = 0.6;
export const MIN_ROOM_READINGS = 3;
/** An item left behind counts in an empty room only at this confidence. */
export const VACANT_ITEM_CONFIDENCE = 0.7;
export const LEFTOVER_RULE = "PREP_LEFTOVER_ITEM_VACANT";

/** Who set an IGNORED by the gate (learnedRules skips "hub ..." deciders). */
export const GATE_BY = { asIs: "hub: as-is home", room: "hub: room not prepared", empty: "hub: empty rooms only" } as const;
const GATE_DECIDERS = Object.values(GATE_BY);
export const AS_IS_REASON = "As-is home: clutter not checked";

export type PrepStats = {
  interiors: number;
  rated: number;
  staged: number;
  tidy: number;
  livedIn: number;
  cluttered: number;
  empty: number;
  listed: boolean;
  reason: string;
};

/** Clutter the gate may set aside: what the fix plan calls clutter (prep), never trash, cars, camera, privacy or geometry. */
export function isClutterRule(ruleId: string): boolean {
  return fixClass(ruleId) === "prep";
}

/**
 * INSIDE CLUTTER ONLY (Oct 21 2026, 859 N Lawrence St). The fix plan's
 * "prep" class covers outside rules too (construction materials, hoses), and
 * the gate set the sidewalk forms the client had been promised aside as "room
 * not prepared (lived in)". A lived-in or cluttered room, or an as-is home, is
 * about the rooms inside: an outside check, or any check on a photo of the
 * outside, is never set aside here. Pure.
 */
export function isInteriorClutter(ruleId: string, room: string | null | undefined): boolean {
  return isClutterRule(ruleId) && !isExteriorFinding(ruleId, room);
}

const asPrep = (v: unknown): PhotoPrep | null => (typeof v === "string" && (PHOTO_PREPS as readonly string[]).includes(v) ? (v as PhotoPrep) : null);

/** The shoot's mode from its room readings. Pure. null = not enough to decide. */
export function decidePrepMode(input: { listed: boolean; photos: { room: RoomType | null; prep: string | null | undefined; furnished?: string | null }[] }): { mode: PrepMode | null; stats: PrepStats } {
  const interior = input.photos.filter((p) => !p.room || !isExteriorRoom(p.room));
  const rated = interior.map((p) => asPrep(p.prep) ?? (p.furnished === "empty" ? "empty" : null)).filter((x): x is PhotoPrep => !!x);
  const n = (k: PhotoPrep) => rated.filter((r) => r === k).length;
  const stats: PrepStats = { interiors: interior.length, rated: rated.length, staged: n("staged"), tidy: n("tidy"), livedIn: n("lived_in"), cluttered: n("cluttered"), empty: n("empty"), listed: input.listed, reason: "" };
  const pct = (x: number) => `${x} of ${rated.length} rooms`;
  if (input.listed) return { mode: "AS_IS", stats: { ...stats, reason: "the client is on the as-is list" } };
  if (rated.length < MIN_ROOM_READINGS) return { mode: null, stats: { ...stats, reason: `only ${rated.length} room${rated.length === 1 ? "" : "s"} rated, not enough to decide` } };
  const messy = stats.livedIn + stats.cluttered;
  if (messy / rated.length >= AS_IS_SHARE) return { mode: "AS_IS", stats: { ...stats, reason: `${pct(messy)} lived in or cluttered` } };
  if (stats.empty / rated.length >= VACANT_SHARE) return { mode: "VACANT", stats: { ...stats, reason: `${pct(stats.empty)} empty` } };
  return { mode: "PREPARED", stats: { ...stats, reason: `${pct(stats.staged + stats.tidy + stats.empty)} staged, tidy or empty` } };
}

/** Is this finding set aside by the gate, and why. Pure. null = it counts. `room`: the photo's room (an outside photo is never gated). */
export function gateFor(f: { ruleId: string; confidence: number }, mode: PrepMode | null, prep: string | null | undefined, room?: string | null): { by: string; reason: string } | null {
  if (!isInteriorClutter(f.ruleId, room)) return null;
  if (mode === "AS_IS") return { by: GATE_BY.asIs, reason: AS_IS_REASON };
  const p = asPrep(prep);
  if (f.ruleId === LEFTOVER_RULE) {
    if (p !== "empty") return { by: GATE_BY.empty, reason: "Only checked in empty rooms: this room is furnished" };
    if (f.confidence < VACANT_ITEM_CONFIDENCE) return { by: GATE_BY.empty, reason: `Empty room, but the check was only ${Math.round(f.confidence * 100)}% sure (needs ${Math.round(VACANT_ITEM_CONFIDENCE * 100)}%)` };
    return null;
  }
  if (p === "lived_in" || p === "cluttered") return { by: GATE_BY.room, reason: `This room was not prepared (${p === "lived_in" ? "lived in" : "cluttered"}): clutter not checked here` };
  return null;
}

/**
 * Apply the gate to a job's findings: set aside what it covers (IGNORED, with
 * the reason) and reopen what it set aside earlier but no longer covers (a
 * person changed the mode, a photo was re-rated). Never touches a person's
 * decision. Returns the counts.
 */
export async function applyPrepGate(jobId: string): Promise<{ setAside: number; reopened: number }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { prepMode: true } });
  if (!job) return { setAside: 0, reopened: 0 };
  const mode = (PREP_MODES as readonly string[]).includes(job.prepMode ?? "") ? (job.prepMode as PrepMode) : null;
  const [photos, findings] = await Promise.all([
    prisma.photoAsset.findMany({ where: { jobId }, select: { id: true, prep: true, roomType: true } }),
    prisma.photoQcFinding.findMany({
      where: { jobId, photoId: { not: null }, source: { not: "ADDON" }, OR: [{ status: "OPEN" }, { status: "IGNORED", decidedBy: { in: GATE_DECIDERS } }] },
      select: { id: true, ruleId: true, confidence: true, status: true, photoId: true, decidedBy: true },
    }),
  ]);
  const prepOf = new Map(photos.map((p) => [p.id, p.prep]));
  const roomOf = new Map(photos.map((p) => [p.id, p.roomType]));
  const toSet = new Map<string, { by: string; reason: string; ids: string[] }>();
  const toOpen: string[] = [];
  for (const f of findings) {
    // An outside finding the gate set aside before Oct 21 2026 is no longer
    // covered, so it is reopened here (the branch below), on the next refresh.
    const g = gateFor(f, mode, prepOf.get(f.photoId!), roomOf.get(f.photoId!));
    // Set aside now, or set aside earlier for another reason (room → as-is): restated.
    if (g && (f.status === "OPEN" || f.decidedBy !== g.by)) {
      const k = `${g.by}\u0000${g.reason}`;
      const e = toSet.get(k) ?? { ...g, ids: [] };
      e.ids.push(f.id);
      toSet.set(k, e);
    } else if (!g && f.status === "IGNORED") toOpen.push(f.id);
  }
  let setAside = 0;
  const now = new Date();
  for (const g of toSet.values()) {
    const r = await prisma.photoQcFinding.updateMany({ where: { id: { in: g.ids }, OR: [{ status: "OPEN" }, { status: "IGNORED", decidedBy: { in: GATE_DECIDERS } }] }, data: { status: "IGNORED", statusReason: g.reason.slice(0, 300), decidedBy: g.by, decidedAt: now, planNote: null } });
    setAside += r.count;
  }
  const reopened = toOpen.length
    ? (await prisma.photoQcFinding.updateMany({ where: { id: { in: toOpen }, status: "IGNORED", decidedBy: { in: GATE_DECIDERS } }, data: { status: "OPEN", statusReason: null, decidedBy: null, decidedAt: null } })).count
    : 0;
  return { setAside, reopened };
}

/** Is this IGNORED finding one the gate set aside (never a person's call)? */
export const gatedBy = (decidedBy: string | null | undefined): boolean => !!decidedBy && GATE_DECIDERS.includes(decidedBy as (typeof GATE_DECIDERS)[number]);

/**
 * Decide and store the shoot's mode from its photos (a person's choice is
 * kept), then apply the gate. Called when a free check finishes.
 */
export async function refreshPrepMode(jobId: string): Promise<{ mode: PrepMode | null; changed: boolean; byPerson: boolean; setAside: number; reopened: number }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true, prepMode: true, prepModeBy: true } });
  if (!job) return { mode: null, changed: false, byPerson: false, setAside: 0, reopened: 0 };
  const byPerson = !!job.prepModeBy && job.prepModeBy !== "auto";
  let mode = (job.prepMode as PrepMode | null) ?? null;
  let changed = false;
  if (!byPerson) {
    const [settings, project, photos, run] = await Promise.all([
      photoDeliverySettings(),
      prisma.project.findUnique({ where: { id: job.projectId }, select: { clientId: true } }),
      prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, select: { id: true, roomType: true, prep: true } }),
      prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "DONE" }, orderBy: { startedAt: "desc" }, select: { checksJson: true } }),
    ]);
    let furnished: Record<string, string> = {};
    try { furnished = (JSON.parse(run?.checksJson ?? "{}") as { furnished?: Record<string, string> }).furnished ?? {}; } catch { furnished = {}; }
    const listed = !!project?.clientId && settings.asIsClientIds.includes(project.clientId);
    const d = decidePrepMode({ listed, photos: photos.map((p) => ({ room: (p.roomType as RoomType | null) ?? null, prep: p.prep, furnished: furnished[p.id] ?? null })) });
    changed = d.mode !== job.prepMode;
    mode = d.mode;
    await prisma.photoJob.update({ where: { id: jobId }, data: { prepMode: d.mode, prepModeBy: "auto", prepModeAt: new Date(), prepStatsJson: JSON.stringify(d.stats) } });
    if (changed) await logJobEvent(jobId, "prep", d.mode ? `home read as ${MODE_WORDS[d.mode]}: ${d.stats.reason}` : `home not rated: ${d.stats.reason}`, { stats: d.stats });
  }
  const g = await applyPrepGate(jobId);
  if (g.setAside || g.reopened) await logJobEvent(jobId, "prep", `clutter ${g.setAside ? `set aside on ${g.setAside} finding${g.setAside === 1 ? "" : "s"}` : ""}${g.setAside && g.reopened ? ", " : ""}${g.reopened ? `${g.reopened} reopened` : ""} (${mode ? MODE_WORDS[mode] : "home not rated"})`);
  return { mode, changed, byPerson, ...g };
}

export const MODE_WORDS: Record<PrepMode, string> = { AS_IS: "as-is home", PREPARED: "prepared home", VACANT: "vacant home" };

/**
 * A person sets the mode (or null: back to automatic). The gate follows at
 * once, the verdict and stage after it (the one review rule).
 */
export async function setPrepMode(jobId: string, mode: PrepMode | null, by: string): Promise<{ ok: boolean; message: string }> {
  if (mode !== null && !(PREP_MODES as readonly string[]).includes(mode)) return { ok: false, message: "That is not a home type the hub knows." };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) return { ok: false, message: "That photo job no longer exists." };
  const who = by.trim().slice(0, 120) || "staff";
  if (mode === null) {
    await prisma.photoJob.update({ where: { id: jobId }, data: { prepModeBy: "auto" } });
    await logJobEvent(jobId, who, "home type back to automatic");
    const r = await refreshPrepMode(jobId);
    const { refreshVerdict } = await import("./fixPolicy");
    await refreshVerdict(jobId, who).catch(() => {});
    return { ok: true, message: `Back to automatic: ${r.mode ? MODE_WORDS[r.mode] : "not enough rooms rated yet"}.` };
  }
  await prisma.photoJob.update({ where: { id: jobId }, data: { prepMode: mode, prepModeBy: who, prepModeAt: new Date() } });
  await logJobEvent(jobId, who, `home set to ${MODE_WORDS[mode]}`);
  const g = await applyPrepGate(jobId);
  const { refreshVerdict } = await import("./fixPolicy");
  await refreshVerdict(jobId, who).catch(() => {});
  const what = mode === "AS_IS" ? `${g.setAside} clutter finding${g.setAside === 1 ? "" : "s"} set aside` : `${g.reopened} clutter finding${g.reopened === 1 ? "" : "s"} back on the list`;
  return { ok: true, message: `Set to ${MODE_WORDS[mode]}: ${what}.` };
}
