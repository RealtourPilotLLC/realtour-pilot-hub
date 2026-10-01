// Shared presentation facts only. Eligibility, travel and bookings stay in
// the existing server readers/actions.
export const PROGRAM_SLOT_HORIZON_DAYS = 21;
export const SESSION_DATES_PER_PAGE = 6;
export const portalMonthKey = (value: unknown): string | null => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;

export function portalSessionIndex(value: unknown, required: number): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d{1,2}$/.test(value))) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= required ? n : null;
}

/** Query-only navigation; never reads or serializes the portal's bearer path. */
export function portalMonthHref(href: string, monthKey: string, sessionIndex?: number | null): string {
  const [query, hash] = href.replace(/^\?/, "").split("#", 2);
  const source = new URLSearchParams(query);
  const params = new URLSearchParams();
  const allowed: Record<string, RegExp> = {
    e: /^[a-z0-9]{10,40}$/i, layout: /^v[12]$/,
    tab: /^(home|plan|library|schedule|more|brand|messages|resources|team|terms|videos|topics|ideas|strategy|profile|settings)$/,
    pv: /^(month|scripts|bank|strategy)$/, filter: /^(ALL|SUGGESTED|SELECTED|PREPARING|FILMED)$/,
  };
  for (const key of Object.keys(allowed)) {
    const value = source.get(key);
    if (value && allowed[key].test(value)) params.set(key, value);
  }
  const month = portalMonthKey(monthKey);
  if (month) params.set("month", month); else params.delete("month");
  if (month && portalSessionIndex(sessionIndex, 10)) params.set("session", String(sessionIndex)); else params.delete("session");
  // These address a specific old month's detail or page; switching month is
  // deliberate and must not reopen that interview/cut against a new heading.
  return `?${params.toString()}${hash && /^(this-month|step-(route|topics|answers|call|filming|scripts))$/.test(hash) ? `#${hash}` : ""}`;
}

/** Select only a month already loaded through the viewer's enrollment scope. */
export function selectedPortalMonth<T extends { monthKey: string }>(months: T[], requested: unknown): T | null {
  const key = portalMonthKey(requested);
  return key ? months.find((month) => month.monthKey === key) ?? null : null;
}

/** A selection belongs to one address version and one session's load. */
export function sessionOfferKey(loadKey: string, result: { planId?: string; addressVersion?: number } | null): string {
  return `${loadKey}:${result?.planId ?? ""}:${result?.addressVersion ?? ""}`;
}

export function currentSessionSlot(pick: { key: string; value: string } | null, offerKey: string, day: { slots: string[] } | null): string | null {
  return pick?.key === offerKey && day?.slots.includes(pick.value) ? pick.value : null;
}

export function sessionDatePage<T extends { date: string; slots: string[] }>(days: T[], page: number, selectedDay: string | null) {
  const lastPage = Math.max(0, Math.ceil(days.length / SESSION_DATES_PER_PAGE) - 1);
  const current = Math.max(0, Math.min(Number.isFinite(page) ? Math.floor(page) : 0, lastPage));
  const visible = days.slice(current * SESSION_DATES_PER_PAGE, (current + 1) * SESSION_DATES_PER_PAGE);
  return { page: current, visible, active: visible.find((day) => day.date === selectedDay) ?? visible[0] ?? null };
}
