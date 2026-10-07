// ---------------------------------------------------------------------------
// CATCH-UP MONTHS (Oct 7 2026) — the pure half. No prisma, no server-only:
// the derivation, the portal and client components all read it.
//
// Jordan: "For John, he missed a month so we are catching up and going to do
// two sessions for him this month. We need an option on the platform for that."
//
// WHERE IT LIVES. A month's videos already have a per-month column
// (ContentMonth.videosOwed), so the missed month's videos are simply ADDED to
// the catching-up month's column. Sessions have no per-month column — every
// reader took the package's ContentEnrollment.sessionsPerMonth — and the
// schema is not changed for this, so the extra session is recorded in the
// enrollment's ledgered overrides bag (ContentEnrollment.overridesJson), under
// one key, keyed by the CATCHING-UP month:
//
//   { "catchUps": { "2026-10": { missedMonthKey: "2026-09", extraSessions: 1,
//                                extraVideos: 4, by, at, before: {...} } } }
//
// `sessionsForMonth` is the ONE reading of "how many filming sessions does
// this month owe": the package's count plus that month's catch-up. Every
// reader that used to take enrollment.sessionsPerMonth for a MONTH goes
// through it, so the portal, the booking capacity, the gate, the reminders,
// the office counts and the cut quota all see the same number.
//
// The missed month is closed with status SKIPPED (every "nothing owed here"
// reader already honours that), and `catchUpFrom` tells the screens to say
// "caught up in October" instead of "skipped".
// ---------------------------------------------------------------------------

export const CATCH_UPS_KEY = "catchUps";

export type CatchUpRecord = {
  /** The month that carries the extra session and videos (the map key). */
  targetMonthKey: string;
  targetMonthId: string;
  missedMonthKey: string;
  missedMonthId: string;
  extraSessions: number;
  extraVideos: number;
  by: string | null;
  at: string;
  /** What both months held before, so Undo puts them back exactly. */
  before: {
    targetVideosOwed: number; missedStatus: string;
    /** The live monthly calls already on the catching-up month — a call filed later plans the catch-up, and Undo asks for it to be unfiled first. */
    callIds?: string[];
  };
};

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function bag(overridesJson: string | null | undefined): Record<string, unknown> {
  try {
    const v = overridesJson ? JSON.parse(overridesJson) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** Every well-formed catch-up on the enrollment. A malformed entry reads as none (never as an extra session). */
export function readCatchUps(overridesJson: string | null | undefined): CatchUpRecord[] {
  const raw = bag(overridesJson)[CATCH_UPS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: CatchUpRecord[] = [];
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!MONTH_KEY.test(key) || !v || typeof v !== "object") continue;
    const r = v as Partial<CatchUpRecord>;
    const extraSessions = Number(r.extraSessions), extraVideos = Number(r.extraVideos);
    if (typeof r.missedMonthKey !== "string" || !MONTH_KEY.test(r.missedMonthKey) || r.missedMonthKey >= key) continue;
    if (!Number.isInteger(extraSessions) || extraSessions < 1 || extraSessions > 4) continue;
    if (!Number.isInteger(extraVideos) || extraVideos < 0 || extraVideos > 60) continue;
    out.push({
      targetMonthKey: key, targetMonthId: String(r.targetMonthId ?? ""), missedMonthKey: r.missedMonthKey, missedMonthId: String(r.missedMonthId ?? ""),
      extraSessions, extraVideos, by: typeof r.by === "string" ? r.by : null, at: String(r.at ?? ""),
      before: {
        targetVideosOwed: Number(r.before?.targetVideosOwed ?? 0), missedStatus: String(r.before?.missedStatus ?? "OPEN"),
        ...(Array.isArray(r.before?.callIds) ? { callIds: r.before!.callIds!.filter((x): x is string => typeof x === "string") } : {}),
      },
    });
  }
  return out.sort((a, b) => a.targetMonthKey.localeCompare(b.targetMonthKey));
}

/** The catch-up this month CARRIES (it owes the extra session), or null. */
export function catchUpInto(overridesJson: string | null | undefined, monthKey: string): CatchUpRecord | null {
  return readCatchUps(overridesJson).find((r) => r.targetMonthKey === monthKey) ?? null;
}

/** The catch-up this month was CLOSED BY (it was caught up later), or null. */
export function catchUpFrom(overridesJson: string | null | undefined, monthKey: string): CatchUpRecord | null {
  return readCatchUps(overridesJson).find((r) => r.missedMonthKey === monthKey) ?? null;
}

/** The package's session count, as every reader has always floored it. */
export function baseSessions(sessionsPerMonth: number | null | undefined): number {
  return Math.max(1, Math.floor(sessionsPerMonth ?? 1) || 1);
}

/** THE reading: filming sessions this month owes = the package's + this month's catch-up. */
export function sessionsForMonth(e: { sessionsPerMonth: number | null | undefined; overridesJson?: string | null }, monthKey: string | null | undefined): number {
  const base = baseSessions(e.sessionsPerMonth);
  if (!monthKey) return base;
  return base + (catchUpInto(e.overridesJson, monthKey)?.extraSessions ?? 0);
}

/** The bag with this month's catch-up set (record) or removed (null). Other keys are untouched. */
export function withCatchUp(overridesJson: string | null | undefined, targetMonthKey: string, record: CatchUpRecord | null): string | null {
  const b = bag(overridesJson);
  const map = { ...((b[CATCH_UPS_KEY] && typeof b[CATCH_UPS_KEY] === "object" && !Array.isArray(b[CATCH_UPS_KEY])) ? b[CATCH_UPS_KEY] as Record<string, unknown> : {}) };
  if (record) map[targetMonthKey] = record; else delete map[targetMonthKey];
  if (Object.keys(map).length) b[CATCH_UPS_KEY] = map; else delete b[CATCH_UPS_KEY];
  return Object.keys(b).length ? JSON.stringify(b) : null;
}

/** "September", or "September 2025" when the year differs from `relativeTo`'s. */
export function catchUpMonthName(monthKey: string, relativeTo?: string | null): string {
  const [y, m] = monthKey.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return relativeTo && relativeTo.slice(0, 4) !== monthKey.slice(0, 4) ? `${name} ${y}` : name;
}
