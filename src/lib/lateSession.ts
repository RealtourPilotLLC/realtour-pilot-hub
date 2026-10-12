// ---------------------------------------------------------------------------
// A LATE MONTH'S SESSION, FILMED THIS MONTH (Oct 12 2026) — the pure half. No
// prisma, no server-only: the derivation, the portal and client components
// all read it.
//
// Jordan: "We have been waiting on Arielle to schedule her September content
// session. I already sent the scripts. We also need her to schedule her
// October session ... similar to John's case."
//
// NOT A CATCH-UP. John's missed month had nothing planned, so its videos
// folded into October and September closed (catchUp.ts). A LATE month is
// PLANNED (a call held, scripts written): it keeps its own topics, scripts,
// videos and its own one session. Only the filming happens late, in the
// month that brings it in (the HOST). So nothing is moved and no count
// changes: September still owes September's videos and its one session,
// October still owes its own. The record only says "September's session is
// booked in October":
//
//   { "lateSessions": { "2026-09": { hostMonthKey: "2026-10", ...by, at } } }
//
// keyed by the LATE month, in the enrollment's ledgered overrides bag
// (ContentEnrollment.overridesJson) — the same bag the catch-up uses, no
// schema change. What reads it:
//   · the portal offers the late month's session next to the host month's
//     (the request is filed on the LATE month, so the shoot, scripts, videos
//     and editor brief are its own);
//   · the late month is never forfeited, and its reminders say "booking in
//     October" on October's calendar instead of chasing an over month;
//   · the office's counts are untouched (each month owes its own).
// ---------------------------------------------------------------------------

export const LATE_SESSIONS_KEY = "lateSessions";

export type LateSessionRecord = {
  /** The planned month whose session is filmed late (the map key). */
  lateMonthKey: string;
  lateMonthId: string;
  /** The month the session is booked in. */
  hostMonthKey: string;
  hostMonthId: string;
  /** Staff said the late month's scripts already reached the client outside the hub (Jordan emailed them). */
  scriptsSentOutside: boolean;
  by: string | null;
  at: string;
};

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function bag(overridesJson: string | null | undefined): Record<string, unknown> {
  try {
    const v = overridesJson ? JSON.parse(overridesJson) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** Every well-formed late session on the enrollment. A malformed entry reads as none. */
export function readLateSessions(overridesJson: string | null | undefined): LateSessionRecord[] {
  const raw = bag(overridesJson)[LATE_SESSIONS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: LateSessionRecord[] = [];
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!MONTH_KEY.test(key) || !v || typeof v !== "object") continue;
    const r = v as Partial<LateSessionRecord>;
    if (typeof r.hostMonthKey !== "string" || !MONTH_KEY.test(r.hostMonthKey) || r.hostMonthKey <= key) continue;
    out.push({
      lateMonthKey: key, lateMonthId: String(r.lateMonthId ?? ""), hostMonthKey: r.hostMonthKey, hostMonthId: String(r.hostMonthId ?? ""),
      scriptsSentOutside: r.scriptsSentOutside === true, by: typeof r.by === "string" ? r.by : null, at: String(r.at ?? ""),
    });
  }
  return out.sort((a, b) => a.lateMonthKey.localeCompare(b.lateMonthKey));
}

/** This month's own session is filmed late, in the record's host month — or null. */
export function lateSessionOf(overridesJson: string | null | undefined, monthKey: string | null | undefined): LateSessionRecord | null {
  if (!monthKey) return null;
  return readLateSessions(overridesJson).find((r) => r.lateMonthKey === monthKey) ?? null;
}

/** The late sessions this month brings in (books alongside its own). */
export function lateSessionsInto(overridesJson: string | null | undefined, hostMonthKey: string | null | undefined): LateSessionRecord[] {
  if (!hostMonthKey) return [];
  return readLateSessions(overridesJson).filter((r) => r.hostMonthKey === hostMonthKey);
}

/** The bag with this late month's record set (record) or removed (null). Other keys are untouched. */
export function withLateSession(overridesJson: string | null | undefined, lateMonthKey: string, record: LateSessionRecord | null): string | null {
  const b = bag(overridesJson);
  const map = { ...((b[LATE_SESSIONS_KEY] && typeof b[LATE_SESSIONS_KEY] === "object" && !Array.isArray(b[LATE_SESSIONS_KEY])) ? b[LATE_SESSIONS_KEY] as Record<string, unknown> : {}) };
  if (record) map[lateMonthKey] = record; else delete map[lateMonthKey];
  if (Object.keys(map).length) b[LATE_SESSIONS_KEY] = map; else delete b[LATE_SESSIONS_KEY];
  return Object.keys(b).length ? JSON.stringify(b) : null;
}

/** "September", or "September 2025" when the year differs from `relativeTo`'s. */
export function lateMonthName(monthKey: string, relativeTo?: string | null): string {
  const [y, m] = monthKey.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return relativeTo && relativeTo.slice(0, 4) !== monthKey.slice(0, 4) ? `${name} ${y}` : name;
}

// ---- the client's words (no em dashes: Jordan's rule for anything a client reads) ----

export type LateState = "TO_BOOK" | "REQUESTED" | "BOOKED";

/** The scheduler's tab for the late month: "September session (your scripts are ready)". */
export function lateSlotLabel(lateMonthKey: string, hostMonthKey: string, scriptsReady: boolean): string {
  return `${lateMonthName(lateMonthKey, hostMonthKey)} session${scriptsReady ? " (your scripts are ready)" : ""}`;
}

/** The host month's own tab beside it: "October session". */
export function hostSlotLabel(hostMonthKey: string): string {
  return `${lateMonthName(hostMonthKey)} session`;
}

/** The one line on Your Month, Home and Schedule. */
export function latePortalLine(i: { lateMonthKey: string; hostMonthKey: string; state: LateState; hostStillToBook: boolean; bookedLabel?: string | null }): string {
  const late = lateMonthName(i.lateMonthKey, i.hostMonthKey), host = lateMonthName(i.hostMonthKey);
  if (i.state === "BOOKED") return `Your ${late} session is booked${i.bookedLabel ? ` for ${i.bookedLabel}` : ""}.${i.hostStillToBook ? ` ${host}'s still needs booking.` : ""}`;
  if (i.state === "REQUESTED") return `Your ${late} session is requested, and we'll confirm the time.${i.hostStillToBook ? ` ${host}'s still needs booking.` : ""}`;
  return i.hostStillToBook ? `Your ${late} session still needs booking, and ${host}'s too.` : `Your ${late} session still needs booking.`;
}

/** The late slot's lock while its scripts are not ready yet (client words). */
export function lateScriptsLock(lateMonthKey: string, hostMonthKey: string): string {
  return `We're finishing your ${lateMonthName(lateMonthKey, hostMonthKey)} scripts. Booking for that session opens as soon as they're ready.`;
}

/** How the HOST month will be planned, for the message's last sentence. */
export type HostPlanning = "TOPICS" | "CHOOSE" | "CALL_TO_BOOK" | "CALL_BOOKED" | "OFFICE" | "CLIENT_PLANNED" | "PLANNED";

/**
 * Jordan's message, filled in (Oct 12 2026): "Hey Arielle, we still need to
 * schedule your content session for September ... and to get caught back up,
 * we need to schedule everything for October as well." Copy only: the office
 * sends it. Short, his voice, no em dashes.
 */
export function lateSessionMessage(i: {
  firstName: string | null; lateMonthKey: string; hostMonthKey: string; link: string;
  lateState: LateState; hostSessionBooked: boolean; hostPlanning: HostPlanning;
}): string {
  const hi = `Hi ${i.firstName?.trim() || "there"}!`;
  const late = lateMonthName(i.lateMonthKey, i.hostMonthKey), host = lateMonthName(i.hostMonthKey);
  const planLine: Record<HostPlanning, string | null> = {
    TOPICS: `For ${host} you can pick your topics right in the portal.`,
    CHOOSE: `For ${host} you can pick your topics right in the portal, or book a strategy call if you'd rather talk them through.`,
    CALL_TO_BOOK: `For ${host}, you can book your strategy call in the portal too.`,
    CALL_BOOKED: null,
    OFFICE: `We'll have your ${host} scripts ready for you in the portal too.`,
    CLIENT_PLANNED: null,
    PLANNED: null,
  };
  const tail = i.hostSessionBooked ? null : planLine[i.hostPlanning];
  const lateDone = i.lateState !== "TO_BOOK";
  if (lateDone && i.hostSessionBooked) return `${hi} You're all caught up: your ${late} and ${host} sessions are both on the calendar. You can see them here: ${i.link}`;
  // The link ends the message (Oct 12 2026): a period straight after a URL breaks it in some apps.
  if (lateDone) return [`${hi} Your ${late} session is on the calendar. To get you caught back up we also need to schedule ${host}.`, tail, `You can book it here: ${i.link}`].filter(Boolean).join(" ");
  if (i.hostSessionBooked) return `${hi} We still need to get your ${late} content session on the calendar. You can book it here: ${i.link}`;
  return [`${hi} We still need to get your ${late} content session on the calendar, and to get you caught back up we also need to schedule ${host}.`, tail, `You can book both here: ${i.link}`].filter(Boolean).join(" ");
}
