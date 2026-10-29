import "server-only";

import { prisma } from "@/lib/prisma";
import { ruleById, type RuleOverride } from "./registry";

// ---------------------------------------------------------------------------
// CHECKS JORDAN SWITCHED OFF, FOR EVERY SHOOT (Oct 14 2026).
//
// Jordan: "For the QC I dont need to know about Resolution consistency ...
// Look over the things I ignored or said were not an issue, and let's try to
// make sure that stuff doesn't get added." One house-wide list (a client's own
// profile can still say otherwise, rule by rule). A rule on it is:
//   · never asked about (the paid QC's rule lists, the free check's prompt),
//   · never written (measured checks such as gallery resolution included),
//   · never counted in a verdict or shown,
// and its open findings are set aside, with the reason, when it goes on.
// Taken off again from Photo Delivery settings. Owner only.
// ---------------------------------------------------------------------------

export type HouseRule = { ruleId: string; reason: string; by: string; at: string };
const KEY = "photo_delivery:house_rules";

async function readList(): Promise<{ raw: string | null; rules: HouseRule[] }> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  if (!row) return { raw: null, rules: [] };
  let parsed: { rules?: unknown } = {};
  try {
    parsed = JSON.parse(row.value) as { rules?: unknown };
  } catch {
    /* an unreadable row reads as an empty list; the next change replaces it */
  }
  const rules = (Array.isArray(parsed.rules) ? (parsed.rules as HouseRule[]) : []).filter((r) => r && typeof r.ruleId === "string");
  return { raw: row.value, rules };
}

/**
 * The list, read fresh (audit C19, Oct 20 2026): a check switched off applies
 * on the next QC everywhere, not a minute later. A read that fails is an empty
 * list, as before: it must never break a QC run.
 */
export async function houseRules(): Promise<HouseRule[]> {
  return (await readList().catch(() => null))?.rules ?? [];
}

/**
 * One compare-and-swap on the list (audit C19): two quick presses never drop
 * each other's rule. `change` answers null when there is nothing to change.
 */
async function changeList(by: string, change: (list: HouseRule[]) => HouseRule[] | null): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, rules } = await readList();
    const next = change(rules);
    if (!next) return false;
    const value = JSON.stringify({ rules: next });
    const updatedBy = by.slice(0, 120);
    if (raw == null) {
      const made = await prisma.appSetting.create({ data: { key: KEY, value, updatedBy } }).then(() => true, () => false);
      if (made) return true;
      continue; // someone else wrote the first rule a moment ago: read again
    }
    const r = await prisma.appSetting.updateMany({ where: { key: KEY, value: raw }, data: { value, updatedBy } });
    if (r.count === 1) return true;
  }
  throw new Error("The list of switched-off checks kept changing. Try again in a moment.");
}

/**
 * As rule overrides (disabled), for the engines. Oct 23 2026: with what the
 * check learned to stop flagging altogether (learnedChecks, scope "rule").
 */
export async function houseOverrides(): Promise<RuleOverride[]> {
  const [list, lessons] = await Promise.all([houseRules(), learnedChecks().catch(() => [] as Lesson[])]);
  const off = list.map((r) => ({ ruleId: r.ruleId, disabled: true, reason: r.reason }));
  const learned = lessons.filter((l) => l.active && l.scope === "rule" && !off.some((o) => o.ruleId === l.ruleId)).map((l) => ({ ruleId: l.ruleId, disabled: true, reason: `Learned from the office's calls: ${l.reason}` }));
  return [...off, ...learned];
}

// ---------------------------------------------------------------------------
// WHAT THE CHECK HAS LEARNED (Oct 23 2026, Jordan and Kyle's huddle, item 5).
//
// Jordan: Kyle writes a few words when he sets something aside; "look at the
// image, look at what was written, and learn", so the check stops flagging
// those things. Every "Not worth fixing" (and "Not there") keeps its reason
// with the finding's check and photo (PhotoQcFinding: ruleId, photoId,
// statusReason, decidedBy). A reason that REPEATS becomes a house lesson:
// the same check, the same kind of reason, LESSON_MIN_CALLS times or more on
// LESSON_MIN_JOBS different jobs or more, in the last LESSON_DAYS days. What
// the reason says decides what changes:
//   neighbor    "neighbor's car"            not flagged on a neighbor's property
//   unfinished  "it's the garage"           not flagged in an unfinished space
//   attached    "part of the house"         not flagged when it belongs to the house
//   faint       "barely visible"            flagged only when clearly visible
//   staged      "intentional staging"       not flagged when it is staging or decor
//   rule        any other words, repeated   not flagged at all (the house list)
// A listing-specific reason ("Not worth a fix on this listing", "Client
// preference", the client or the agent named) never teaches: it is a call on
// one photo (feedback Oct 14: a listing-specific ignore is not a house rule
// unless the same reason repeats), and neither do the hub's own calls, Skip
// all, or the checks switched off. ALWAYS_FLAG checks (trash cans, cars on
// this home's driveway, lines, camera and edit mistakes) are never learned
// away: only narrowed, to this home and (Oct 29 2026) to what is clearly
// visible, never for lines or edit mistakes (narrowsAlways). The lessons go into the free check's question and its
// code screen (autohdrCheck), the "rule" ones into the house overrides above.
// Jordan sees them on Photo Delivery settings and can undo one: it stops,
// and only calls made after the undo can teach it again.
// ---------------------------------------------------------------------------

export const LESSON_MIN_CALLS = 3;
export const LESSON_MIN_JOBS = 2;
export const LESSON_DAYS = 60;
export const LESSON_SCOPES = ["neighbor", "unfinished", "attached", "faint", "staged", "rule"] as const;
export type LessonScope = (typeof LESSON_SCOPES)[number];
export type LessonExample = { findingId: string; jobId: string; photoId: string | null; reason: string; by: string; atISO: string };
export type Lesson = {
  key: string;
  ruleId: string;
  scope: LessonScope;
  /** The reason people gave, in the words of the newest call. */
  reason: string;
  count: number;
  jobs: number;
  examples: LessonExample[];
  lastISO: string;
  /** Applied by the check. False while building, on an ALWAYS_FLAG check, or undone. */
  active: boolean;
  alwaysFlagged: boolean;
  undone: { by: string; atISO: string } | null;
};
const LESSONS_KEY = "photo_delivery:learned_checks";
type StoredLessons = { lessons: Lesson[]; undone: { key: string; by: string; at: string }[]; at: string };

const LISTING_ONLY = /^(?:not worth a fix on this listing|client preference|skipped all findings|as-is home|not checked any more|nothing like this is in the photo|stop flagging)/i;
const NAMES_THE_LISTING = /\bthis (?:listing|house|home|one|shoot|property)\b|\b(?:the )?(?:client|agent|seller|owner|homeowner|buyer)s?\b/i;

/** What a reason teaches about a check, or null (listing-specific, or too short to repeat). Pure. */
export function lessonOf(reason: string | null | undefined): { scope: LessonScope; norm: string } | null {
  const r = (reason ?? "").replace(/\s+/g, " ").trim();
  if (r.length < 4 || LISTING_ONLY.test(r)) return null;
  if (/neighbou?r|next[\s-]door|not (?:on )?(?:the|this|our) property|across the street/i.test(r)) return { scope: "neighbor", norm: "neighbor" };
  if (/garage|basement|unfinished|storage|utility|\bshed\b|attic|workshop|mechanical/i.test(r)) return { scope: "unfinished", norm: "unfinished" };
  if (/part of the house|built[\s-]?in|permanent|plugged|attached|fixture|hard[\s-]?wired|\btv\b|television/i.test(r)) return { scope: "attached", norm: "attached" };
  // Oct 29 2026 (Kyle's words): "Drone shot", "Car is far from property", "Out of view", "Not that visible".
  if (/barely|hardly|faint|tiny|too small|far (?:away|from)|in the distance|not (?:very |really |that |too )?noticeable|can'?t (?:really )?see|not (?:very |really |that |too )?visible|out of (?:view|frame|sight)|\bdrone\b/i.test(r)) return { scope: "faint", norm: "faint" };
  if (/stag(?:ing|ed)|\bdecor\b|intentional/i.test(r)) return { scope: "staged", norm: "staged" };
  if (NAMES_THE_LISTING.test(r)) return null;
  const norm = r.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  return norm.length >= 4 ? { scope: "rule", norm } : null;
}

/**
 * NARROWED, NEVER SWITCHED OFF (Oct 29 2026, Jordan: "review some of Kyle's
 * notes on the QC checks, and let's tighten them up so we don't flag things we
 * dont need to fix"). An always-flagged check still learns where it does not
 * apply: something on a neighbor's property is not this home's, and something
 * barely visible (far off, out of view, in a drone shot) is not one to fix:
 * Kyle set aside cars seen through windows "barely visible" 12 times on 6
 * jobs, trash cans and driveway cars the same way. A clearly visible bin or
 * car is still always flagged. Lines and the AI edit's own mistakes are never
 * narrowed (913 Lakeview went out leaning), and no lesson ever switches an
 * always-flagged check off.
 */
export function narrowsAlways(ruleId: string, scope: LessonScope): boolean {
  return scope === "neighbor" || (scope === "faint" && !/^(?:PERSP_|AIEDIT_)/.test(ruleId));
}

/** What a lesson changes, in Jordan's words (the settings list). Pure. */
export function lessonWords(l: Pick<Lesson, "ruleId" | "scope" | "alwaysFlagged" | "active" | "undone">): string {
  // A neighbor's property is never this home's, and a barely visible thing is not one to fix (narrowsAlways); anything else on an always-flagged check is not applied.
  if (l.alwaysFlagged && !narrowsAlways(l.ruleId, l.scope)) return "Not applied: Jordan always wants this flagged";
  if (l.undone && !l.active) return "Undone";
  const w: Record<LessonScope, string> = {
    neighbor: "Not flagged on a neighbor's property",
    unfinished: "Not flagged in a garage, basement or other unfinished space",
    attached: "Not flagged when it is part of the house",
    faint: "Flagged only when it is clearly visible",
    staged: "Not flagged when it is intentional staging or decor",
    rule: "No longer flagged on any shoot",
  };
  return l.active ? w[l.scope] : `Learning: ${w[l.scope].toLowerCase()} after ${LESSON_MIN_CALLS} calls on ${LESSON_MIN_JOBS} jobs`;
}

/** The free check's question gets the active lessons it can follow (the "rule" ones leave the check out entirely). Pure. */
export function lessonPromptLines(lessons: Lesson[]): string[] {
  const say: Partial<Record<LessonScope, string>> = {
    neighbor: "never when it is on a neighbor's property",
    unfinished: "never in a garage, basement or other unfinished space",
    attached: "never when it is part of the house (built in, plugged in, a fixture)",
    faint: "only when it is clearly visible, never barely visible or far away",
    staged: "never intentional staging or decor",
  };
  return lessons.filter((l) => l.active && say[l.scope]).map((l) => `${l.ruleId}: ${say[l.scope]} (people said "${l.reason.slice(0, 60)}" ${l.count} times)`);
}

const SYSTEM_DECIDER = /^(auto-|free second look|fix-runner|hub\b|system)/i;

/**
 * The lessons from people's calls (pure, for a drill): rows are decided
 * findings (IGNORED or FALSE_POSITIVE) with their reason. `undone`: Jordan's
 * undos, by lesson key (only later calls count again).
 */
export function lessonsFrom(
  rows: { id: string; jobId: string; photoId: string | null; ruleId: string; statusReason: string | null; decidedBy: string | null; decidedAt: Date | null; status?: string | null }[],
  undone: { key: string; by: string; at: string }[],
  alwaysFlag: Set<string>,
): Lesson[] {
  const groups = new Map<string, { ruleId: string; scope: LessonScope; rows: typeof rows }>();
  for (const r of rows) {
    if (!r.decidedBy || SYSTEM_DECIDER.test(r.decidedBy) || !r.decidedAt) continue;
    const t = lessonOf(r.statusReason);
    // A "Not there" (the check saw something that is not in the photo) never switches a check off: its strictness is learnedRules' job (fixPolicy). Only a reason that names a condition teaches.
    if (t && r.status === "FALSE_POSITIVE" && t.scope === "rule") continue;
    if (!t) continue;
    const key = `${r.ruleId}|${t.scope}|${t.norm}`;
    const g = groups.get(key) ?? { ruleId: r.ruleId, scope: t.scope, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const out: Lesson[] = [];
  for (const [key, g] of groups) {
    const u = undone.filter((x) => x.key === key).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
    const counted = (u ? g.rows.filter((r) => r.decidedAt!.getTime() > Date.parse(u.at)) : g.rows).sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime());
    const all = [...g.rows].sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime());
    const jobs = new Set(counted.map((r) => r.jobId)).size;
    const alwaysFlagged = alwaysFlag.has(g.ruleId);
    const ripe = counted.length >= LESSON_MIN_CALLS && jobs >= LESSON_MIN_JOBS;
    out.push({
      key,
      ruleId: g.ruleId,
      scope: g.scope,
      reason: (all[0].statusReason ?? "").trim().slice(0, 200),
      count: counted.length,
      jobs,
      examples: (counted.length ? counted : all).slice(0, 4).map((r) => ({ findingId: r.id, jobId: r.jobId, photoId: r.photoId, reason: (r.statusReason ?? "").slice(0, 200), by: r.decidedBy!.slice(0, 120), atISO: r.decidedAt!.toISOString() })),
      lastISO: all[0].decidedAt!.toISOString(),
      active: ripe && (!alwaysFlagged || narrowsAlways(g.ruleId, g.scope)),
      alwaysFlagged,
      undone: u ? { by: u.by, atISO: u.at } : null,
    });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.count - a.count || a.ruleId.localeCompare(b.ruleId));
}

async function readLessons(): Promise<{ raw: string | null; stored: StoredLessons }> {
  const row = await prisma.appSetting.findUnique({ where: { key: LESSONS_KEY }, select: { value: true } });
  const empty: StoredLessons = { lessons: [], undone: [], at: "" };
  if (!row) return { raw: null, stored: empty };
  try {
    const v = JSON.parse(row.value) as Partial<StoredLessons>;
    return { raw: row.value, stored: { lessons: Array.isArray(v.lessons) ? v.lessons : [], undone: Array.isArray(v.undone) ? v.undone : [], at: typeof v.at === "string" ? v.at : "" } };
  } catch {
    return { raw: row.value, stored: empty };
  }
}

async function writeLessons(by: string, change: (s: StoredLessons) => StoredLessons): Promise<StoredLessons> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, stored } = await readLessons();
    const next = change(stored);
    const value = JSON.stringify(next);
    if (raw === value) return next;
    const ok = raw == null
      ? await prisma.appSetting.create({ data: { key: LESSONS_KEY, value, updatedBy: by.slice(0, 120) } }).then(() => true, () => false)
      : (await prisma.appSetting.updateMany({ where: { key: LESSONS_KEY, value: raw }, data: { value, updatedBy: by.slice(0, 120) } })).count === 1;
    if (ok) return next;
  }
  throw new Error("What the check learned kept changing. Try again in a moment.");
}

/** What the check has learned, as stored (fast: the free check and the engines read this). A read that fails is no lessons. */
export async function learnedChecks(): Promise<Lesson[]> {
  return (await readLessons().catch(() => null))?.stored.lessons ?? [];
}

/** Work the lessons out again from people's calls (after a decision, on the settings page). */
export async function refreshLessons(now: Date = new Date(), by = "hub"): Promise<Lesson[]> {
  const rows = await prisma.photoQcFinding.findMany({
    where: { decidedAt: { gte: new Date(now.getTime() - LESSON_DAYS * 86_400_000) }, status: { in: ["IGNORED", "FALSE_POSITIVE"] }, source: { not: "ADDON" }, statusReason: { not: null } },
    orderBy: { decidedAt: "desc" },
    select: { id: true, jobId: true, photoId: true, ruleId: true, statusReason: true, decidedBy: true, decidedAt: true, status: true },
    take: 5000,
  });
  const { ALWAYS_FLAG } = await import("./fixPolicy");
  // Written only when the lessons changed (the settings page reads them fresh on every visit).
  const { stored } = await readLessons();
  const fresh = lessonsFrom(rows, stored.undone, ALWAYS_FLAG);
  if (JSON.stringify(fresh) === JSON.stringify(stored.lessons)) return fresh;
  const saved = await writeLessons(by, (s) => ({ lessons: lessonsFrom(rows, s.undone, ALWAYS_FLAG), undone: s.undone, at: now.toISOString() }));
  return saved.lessons;
}

/** Jordan undoes a lesson: the check stops following it; only calls made after this can teach it again. Owner only (the caller checks). */
export async function undoLesson(key: string, by: string): Promise<{ ok: boolean; message: string }> {
  const { stored } = await readLessons();
  const l = stored.lessons.find((x) => x.key === key);
  if (!l) return { ok: false, message: "That lesson is not on the list any more. Reload the page." };
  const at = new Date().toISOString();
  await writeLessons(by, (s) => ({ ...s, undone: [...s.undone.filter((u) => u.key !== key), { key, by: by.slice(0, 120), at }].slice(-200) }));
  await refreshLessons(new Date(), by);
  return { ok: true, message: `Undone: "${ruleById(l.ruleId)?.shortLabel ?? l.ruleId}" is flagged as before. Only calls from now on can teach it again.` };
}

/** House rules first, then the client's own: a client entry for the same rule wins. */
export function mergeOverrides(house: RuleOverride[], client: RuleOverride[] | null | undefined): RuleOverride[] {
  const own = new Set((client ?? []).map((o) => o.ruleId));
  return [...house.filter((o) => !own.has(o.ruleId)), ...(client ?? [])];
}

export const disabledIn = (overrides: RuleOverride[] | null | undefined) => new Set((overrides ?? []).filter((o) => o.disabled).map((o) => o.ruleId));

/** Switch a check off for every shoot and set its open findings aside. */
/** Oct 22 2026 (photo audit M6): checks only the owner can switch off for every shoot, whoever calls stopRule (the caller passes the real role). */
export const OWNER_ONLY_SWITCH = new Set(["AIEDIT_FLOATING_OBJECT"]);

export async function stopRule(ruleId: string, reason: string, by: string, opts: { role?: string | null } = {}): Promise<{ ok: boolean; message: string; setAside: number }> {
  const rule = ruleById(ruleId);
  if (!rule) return { ok: false, message: "That check is not one the hub knows.", setAside: 0 };
  if (ruleId === "OTHER_DEFECT") return { ok: false, message: "The catch-all check can't be switched off; ignore those one by one.", setAside: 0 };
  // Oct 14 2026 (huddle): an AI fix that changed the house is never hidden house-wide.
  if (ruleId === "FIX_DAMAGE_AI_EDIT") return { ok: false, message: "This one can't be switched off: it is how the hub says an AI fix changed a house. Restore the photo, or decide it one by one.", setAside: 0 };
  // Audit C19 (Oct 20 2026): what the house fixes on every shoot (trash cans
  // above all: always wanted) is never switched off for every shoot. Oct 23
  // 2026 (huddle): nor anything Jordan always wants flagged (fixPolicy
  // ALWAYS_FLAG): lines, a cut-off roof, the AI edit's own mistakes (the
  // floating lamp shade: once the owner's to switch off, now nobody's), a
  // crooked door mat.
  const { ALWAYS_FIX, ALWAYS_FLAG } = await import("./fixPolicy");
  if (ALWAYS_FIX.has(ruleId)) return { ok: false, message: "This one can't be switched off: the hub fixes it on every shoot (trash cans, cars, camera mistakes, lens distortion). Decide it one by one instead.", setAside: 0 };
  if (ALWAYS_FLAG.has(ruleId)) return { ok: false, message: "This one can't be switched off: Jordan always wants it flagged (lines, a cut-off roof, an editing mistake, a crooked door mat). Decide it one by one instead.", setAside: 0 };
  if (OWNER_ONLY_SWITCH.has(ruleId) && opts.role !== "OWNER") return { ok: false, message: "Only Jordan can switch this check off for every shoot (an editing mistake the client sees). Decide it one by one instead.", setAside: 0 };
  const why = reason.trim().slice(0, 300) || "Jordan does not need to know about this";
  await changeList(by, (list) => (list.some((r) => r.ruleId === ruleId) ? null : [...list, { ruleId, reason: why, by: by.slice(0, 120), at: new Date().toISOString() }]));
  const r = await prisma.photoQcFinding.updateMany({
    where: { ruleId, status: "OPEN" },
    data: { status: "IGNORED", statusReason: `Not checked any more: ${why}`.slice(0, 300), decidedBy: by.slice(0, 120), decidedAt: new Date() },
  });
  return { ok: true, message: `"${rule.shortLabel}" is no longer checked on any shoot${r.count ? ` (${r.count} open finding${r.count === 1 ? "" : "s"} set aside)` : ""}.`, setAside: r.count };
}

/** Check it again from the next QC on. Findings set aside stay decided. */
export async function resumeRule(ruleId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const changed = await changeList(by, (list) => (list.some((r) => r.ruleId === ruleId) ? list.filter((r) => r.ruleId !== ruleId) : null));
  if (!changed) return { ok: false, message: "That check is already on." };
  return { ok: true, message: `"${ruleById(ruleId)?.shortLabel ?? ruleId}" is checked again from the next QC on.` };
}
