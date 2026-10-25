import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etMonthDay } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// WHO IS OFF ON A SHOOT DAY (audit, Oct 25 2026).
//
// Harrison's week off (Mon Oct 26 to Fri Oct 30) was on his PTO record, and
// five of his shoots were still on the calendar in Aryeo that week. Every home
// read them as covered: Jordan's Production health listed them as "shoots
// coming up" in green, Team coverage said "Covered", Weekly performance said
// "Upcoming shoots covered 13/13", and Kyle's desk showed Tuesday's two as
// "Ready" with Harrison as the photographer. lib/pto says it plainly: booking
// does not see PTO, and a PTO day has to be blocked in Aryeo by hand. So the
// homes check it instead: a shoot assigned to someone who is off that day is
// a problem to fix (reassign or move it), said on the shoot itself.
//
// Two records say someone is off, and both are read:
//   · the PTO tracker (AppSetting `pto:<teamMemberId>:<year>`, lib/pto), by ET
//     day; a partial day (fraction under 1) is "off part of the day", which
//     is a question for the office, not a clash;
//   · the capacity register's TIME_OFF entries (CapacityException), by time.
// Reads only; nothing here moves a shoot, writes a record or tells anyone.
// ---------------------------------------------------------------------------

export type TimeOffSpan = {
  teamMemberId: string;
  /** ET day keys, inclusive */
  startKey: string;
  endKey: string;
  /** the capacity register is timed; PTO is whole ET days */
  startsAt: Date | null;
  endsAt: Date | null;
  /** 1 = the whole day(s); under 1 = part of a single day */
  fraction: number;
  /** "Off Oct 26 to Oct 30" */
  words: string;
  source: "pto" | "capacity";
};

const dayWords = (k: string) => etMonthDay(new Date(`${k}T12:00:00Z`));
export const spanWords = (startKey: string, endKey: string) => `Off ${startKey === endKey ? dayWords(startKey) : `${dayWords(startKey)} to ${dayWords(endKey)}`}`;

/** Time off overlapping the ET days [fromKey, toKey], from PTO and the capacity register. */
export async function timeOffBetween(fromKey: string, toKey: string): Promise<TimeOffSpan[]> {
  const [ptoRows, caps] = await Promise.all([
    prisma.appSetting.findMany({ where: { key: { startsWith: "pto:" } }, select: { key: true, value: true } }),
    prisma.capacityException.findMany({
      where: {
        kind: "TIME_OFF", cancelledAt: null,
        startsAt: { lte: new Date(`${toKey}T23:59:59Z`) },
        OR: [{ endsAt: null }, { endsAt: { gte: new Date(`${fromKey}T00:00:00Z`) } }],
      },
      select: { teamMemberId: true, startsAt: true, endsAt: true },
    }),
  ]);
  const out: TimeOffSpan[] = [];
  for (const r of ptoRows) {
    const memberId = r.key.split(":")[1];
    if (!memberId) continue;
    let entries: { startKey?: string; endKey?: string; fraction?: number }[] = [];
    try { entries = (JSON.parse(r.value) as { entries?: typeof entries }).entries ?? []; } catch { continue; }
    for (const e of entries) {
      if (!e.startKey || !e.endKey || e.endKey < fromKey || e.startKey > toKey) continue;
      const fraction = typeof e.fraction === "number" && e.fraction > 0 && e.fraction <= 1 ? e.fraction : 1;
      out.push({ teamMemberId: memberId, startKey: e.startKey, endKey: e.endKey, startsAt: null, endsAt: null, fraction, words: spanWords(e.startKey, e.endKey), source: "pto" });
    }
  }
  for (const c of caps) {
    const startKey = etDayKey(c.startsAt);
    const endKey = c.endsAt ? etDayKey(new Date(c.endsAt.getTime() - 1)) : "9999-12-31";
    out.push({
      teamMemberId: c.teamMemberId, startKey, endKey, startsAt: c.startsAt, endsAt: c.endsAt, fraction: 1,
      words: `Off ${etMonthDay(c.startsAt)}${c.endsAt ? ` to ${etMonthDay(new Date(c.endsAt.getTime() - 1))}` : ""}`,
      source: "capacity",
    });
  }
  return out;
}

/**
 * The time off covering this person at this moment (pure): a PTO day holds
 * the whole ET day, a capacity entry its own hours. Whole-day spans first, so
 * a full day off wins over a partial one.
 */
export function offAt(spans: TimeOffSpan[], teamMemberId: string | null | undefined, at: Date | null | undefined): TimeOffSpan | null {
  if (!teamMemberId || !at) return null;
  const key = etDayKey(at);
  const t = at.getTime();
  const hits = spans.filter((s) => {
    if (s.teamMemberId !== teamMemberId) return false;
    if (s.source === "capacity" && s.startsAt) return s.startsAt.getTime() <= t && (!s.endsAt || s.endsAt.getTime() > t);
    return s.startKey <= key && key <= s.endKey;
  });
  return hits.sort((a, b) => b.fraction - a.fraction)[0] ?? null;
}

/** "Harrison is off (Off Oct 26 to Oct 30)" / "Harrison is off part of that day (Off Oct 27)". Pure. */
export function offWords(name: string | null | undefined, span: TimeOffSpan): string {
  const who = (name ?? "").trim().split(/\s+/)[0] || "The photographer";
  return span.fraction < 1 ? `${who} is off part of that day (${span.words})` : `${who} is off that day (${span.words})`;
}
