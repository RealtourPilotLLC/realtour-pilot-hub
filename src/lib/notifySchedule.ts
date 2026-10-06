import "server-only";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { etAt, etDayKey, etMinutesOfDay } from "@/lib/datetime";
import {
  OWNER_PRESET_WINDOWS,
  parseQuietWindows,
  type QuietWindow,
} from "@/lib/notifyPrefDefaults";

// ---------------------------------------------------------------------------
// WHEN A PERSON MAY BE INTERRUPTED — the notification schedule's server half
// (Jordan, Sep 26 2026; the words and the shape are in notifyPrefDefaults.ts).
//
// ONE QUESTION, ASKED BY EVERY CHANNEL THAT REACHES A PERSON: holdFor(person,
// at) → the instant their notices may go, or null for "now". The Slack DM
// bridge, the staff text queue and its flusher, the owner's broadcast leg,
// Kyle's two digests and the urgent on-call page all ask it (notify.ts); so,
// since the review, do the senders that bypass the bridge — the 7 PM upload
// digest, the 10 PM chaser and its split notice (uploadDigest.ts) and the
// comms coaching DM (commsCoaching.ts). Two
// copies of this rule is how the Saturday wave of Sep 19 happened — the
// coverage rule existed and one path forgot to read it.
//
// THREE RULES, same spirit as coverage.ts:
//   1. THE BELL IS NEVER HELD. The in-app row is written at once; only what
//      buzzes a phone waits. A quiet window decides when, never whether.
//   2. NOTHING IS DROPPED. A held text sits in PendingSms with deferUntil; a
//      held Slack DM sits in its own row (notify.ts holdStaffDm) until the
//      window ends, then goes once, in the order it came. When nothing can
//      hold it, it goes now — louder than asked beats silent.
//   3. A READ THAT FAILS SENDS. holdFor never throws; a broken store answers
//      "now", the same fail-open rule coverage.ts and BELL_RULES follow.
//
// WHOSE CLOCK. Windows are Eastern (the card says so).
//
// NO HOUSE NIGHT (Oct 6 2026, Jordan: "Editors can get night time pings.
// Anyone on the team can get pinged anytime. Just not Jordan on Saturday until
// 7:30PM."). Until then an urgent page to the on-call waited 10 PM–7 AM ET,
// staff texts kept a 7 AM–10 PM window, a Manila editor's DMs waited for
// their 7 AM, and a routine work notice on a Saturday or Sunday to somebody
// with no schedule waited for Monday 9 AM (the office-rota weekend hold, which
// scheduleHold used to arbitrate). All of it is gone: the only windows are a
// person's own — saved on the card, or Jordan's Saturday preset.
// ---------------------------------------------------------------------------

export const notifyScheduleKey = (teamMemberId: string) => `notify-schedule:${teamMemberId}`;

/** Held Slack DMs, one AppSetting row each (see notify.ts holdStaffDm). The
 *  prefix is here so the Settings card can count them without importing the
 *  bridge. */
export const HELD_DM_PREFIX = "held-dm:";
export const heldDmKey = (teamMemberId: string) =>
  `${HELD_DM_PREFIX}${teamMemberId}:${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

type StoredSchedule = { windows?: unknown; setBy?: string | null; setAt?: string | null };

export type PersonSchedule = {
  windows: QuietWindow[];
  source: "saved" | "preset" | "none";
  setBy: string | null;
  setAt: string | null;
};

/**
 * This person's windows: what the card saved for them, else Jordan's preset if
 * they are the OWNER login's roster row, else none. `{ windows: null }` in the
 * store is "back to the default" (the card's Reset) — the row is kept so its
 * stamp and author survive for the audit trail.
 */
export async function scheduleOf(teamMemberId: string): Promise<PersonSchedule> {
  const stored = await getSetting<StoredSchedule>(notifyScheduleKey(teamMemberId), {});
  const setBy = typeof stored.setBy === "string" ? stored.setBy : null;
  const setAt = typeof stored.setAt === "string" ? stored.setAt : null;
  if (Array.isArray(stored.windows)) {
    const windows = parseQuietWindows(stored.windows);
    // A hand-edited row that no longer parses is treated as unset rather than
    // as "quiet all the time": silence is the outcome a bad row must not have.
    if (windows) return { windows, source: "saved", setBy, setAt };
  }
  const { ownerTeamMemberIds } = await import("@/lib/smsPrefs");
  if ((await ownerTeamMemberIds().catch(() => [] as string[])).includes(teamMemberId)) {
    return { windows: OWNER_PRESET_WINDOWS.map((w) => ({ ...w })), source: "preset", setBy, setAt };
  }
  return { windows: [], source: "none", setBy, setAt };
}

/** Store a person's windows (null = back to the default). Authorization and the
 *  audit row live in the settings action; the shape is checked again here so a
 *  caller can never persist something the reader would have to guess at. */
export async function saveSchedule(teamMemberId: string, windows: QuietWindow[] | null, by: string | null): Promise<PersonSchedule> {
  let clean: QuietWindow[] | null = null;
  if (windows) {
    clean = parseQuietWindows(windows);
    if (!clean) throw new Error("Those quiet times don't read as whole windows inside one day.");
  }
  await putSetting<StoredSchedule>(notifyScheduleKey(teamMemberId), { windows: clean, setBy: by, setAt: new Date().toISOString() }, by);
  return scheduleOf(teamMemberId);
}

const nextDayKey = (key: string): string => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
};
const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay();
/** A minute-of-day on an ET day key as a real instant; 1440 is the next midnight. */
const instantAt = (key: string, mins: number): Date =>
  mins >= 1440 ? etAt(nextDayKey(key), 0) : etAt(key, Math.floor(mins / 60), mins % 60);

/**
 * PURE: when the quiet period covering `at` ends, or null when `at` is not
 * quiet. Windows on consecutive days that touch at midnight chain (Friday
 * from 10 PM + Saturday until 7 AM is one night). Day-key arithmetic
 * throughout, so a clock change cannot move it.
 */
export function quietEnd(windows: readonly QuietWindow[], at: Date): Date | null {
  let t = at;
  let moved = false;
  // Bounded: seven chained days of windows is the most a real schedule can
  // produce; the guard only stops a pathological one.
  for (let i = 0; i < 16; i++) {
    const key = etDayKey(t);
    const dow = weekdayOf(key);
    const mins = etMinutesOfDay(t);
    let end: Date | null = null;
    for (const w of windows) {
      if (w.day === dow && mins >= w.from && mins < w.to) {
        const e = instantAt(key, w.to);
        if (!end || e > end) end = e;
      }
    }
    if (!end || end.getTime() <= t.getTime()) break;
    t = end;
    moved = true;
  }
  return moved ? t : null;
}

/**
 * THE ONE QUESTION. The instant this person's notices may go, or null for now:
 * their own windows (saved, or Jordan's preset) and nothing else — an urgent
 * page, an ops relay and a Manila editor at 3 AM their time all ask the same
 * question (Oct 6 2026). Never throws (rule 3). `teamMemberId` null — a
 * recipient the roster does not know, like the literal Slack ID the digests
 * fall back to — is never held.
 */
export async function holdFor(
  teamMemberId: string | null | undefined,
  at: Date = new Date(),
): Promise<Date | null> {
  try {
    const windows = teamMemberId ? (await scheduleOf(teamMemberId)).windows : [];
    return quietEnd(windows, at);
  } catch (e) {
    console.warn("notification schedule read failed (sending now)", teamMemberId, e);
    return null;
  }
}

/** What is waiting for each person right now — queued texts with a hold on
 *  them, held Slack DMs — and when the first goes. For the Settings card. */
export async function heldForMembers(ids: string[], now: Date = new Date()): Promise<Map<string, { texts: number; dms: number; nextAt: string | null }>> {
  const out = new Map<string, { texts: number; dms: number; nextAt: string | null }>();
  if (ids.length === 0) return out;
  const bump = (id: string, kind: "texts" | "dms", at: Date | null) => {
    const cur = out.get(id) ?? { texts: 0, dms: 0, nextAt: null };
    cur[kind]++;
    if (at && (!cur.nextAt || at.toISOString() < cur.nextAt)) cur.nextAt = at.toISOString();
    out.set(id, cur);
  };
  try {
    const texts = await prisma.pendingSms.findMany({
      where: { teamMemberId: { in: ids }, sentAt: null, skippedAt: null, deferUntil: { gt: now } },
      select: { teamMemberId: true, deferUntil: true },
    });
    for (const t of texts) bump(t.teamMemberId, "texts", t.deferUntil);
    const dms = await prisma.appSetting.findMany({ where: { key: { startsWith: HELD_DM_PREFIX } }, select: { value: true } });
    for (const r of dms) {
      try {
        const v = JSON.parse(r.value) as { teamMemberId?: string; until?: string; settledAt?: string };
        // settledAt = already sent (or given up), only its delete is owed —
        // not waiting for anybody (notify.ts releaseHeldStaffDms).
        if (v.settledAt) continue;
        if (v.teamMemberId && ids.includes(v.teamMemberId)) bump(v.teamMemberId, "dms", v.until ? new Date(v.until) : null);
      } catch { /* an unreadable row is the flusher's business, not the card's */ }
    }
  } catch (e) {
    console.warn("held-notice count failed", e);
  }
  return out;
}
