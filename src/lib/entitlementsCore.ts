// ---------------------------------------------------------------------------
// THE CLIENT ENTITLEMENT LEDGER, PURE HALF (Oct 15 2026). No prisma, no
// server-only: the staff card, the server and the drill read the same words
// and the same term arithmetic.
//
// Marcee McMullen's Oct 15 call settled four things nobody had a place for:
// one extra month at the end for the July session, the missed months carried
// to the end of her term, a bio/lifestyle video like Erica Walker's but
// shorter, and no refund. Catch-up months (catchUp.ts) fold a missed month
// INTO a later open one; this ledger records what was agreed BEYOND the
// package, and the term it changes:
//
//   end of term = the signed end (termEndMonth, or start + billingMonths - 1)
//                 + every live EXTENSION_MONTH + every live CARRY_TO_END
//
// A row is an agreement, never a charge. Undo is VOID: the row stays, with who
// and why.
// ---------------------------------------------------------------------------

export const ENTITLEMENT_KINDS = ["EXTENSION_MONTH", "CARRY_TO_END", "EXTRA_DELIVERABLE", "CREDIT", "REFUND_DECLINED", "SESSION_POSTPONED"] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];
export const isEntitlementKind = (v: unknown): v is EntitlementKind => typeof v === "string" && (ENTITLEMENT_KINDS as readonly string[]).includes(v);

export const ENTITLEMENT_LABEL: Record<EntitlementKind, string> = {
  EXTENSION_MONTH: "Extra month at the end",
  CARRY_TO_END: "Missed month carried to the end",
  EXTRA_DELIVERABLE: "Extra video promised",
  CREDIT: "Credit given",
  REFUND_DECLINED: "Refund asked for, not agreed",
  SESSION_POSTPONED: "Session postponed",
};

export const ENTITLEMENT_STATES = ["OPEN", "SCHEDULED", "FULFILLED", "VOID"] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];
export const STATE_LABEL: Record<EntitlementState, string> = { OPEN: "Owed", SCHEDULED: "Scheduled", FULFILLED: "Done", VOID: "Undone" };

/** Kinds that are a record of a decision, not something we still owe. */
export const RECORD_ONLY: ReadonlySet<EntitlementKind> = new Set(["REFUND_DECLINED", "CREDIT"]);

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonthKey = (v: unknown): v is string => typeof v === "string" && MONTH_RE.test(v);

/** "2026-07" + 3 → "2026-10". Pure. */
export function addMonths(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const idx = y * 12 + (m - 1) + Math.trunc(n);
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Inclusive count of months from a to b ("2026-01".."2026-03" = 3). */
export function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  return yb * 12 + mb - (ya * 12 + ma) + 1;
}

/** "2026-07" → "July 2026". */
export function monthName(key: string | null | undefined): string {
  if (!key || !isMonthKey(key)) return "not set";
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export type TermInput = {
  termStartMonth: string | null;
  termEndMonth: string | null;
  billingMonths: number | null;
  /** the client's first program month on record, when the start was never set
   *  (earliestMonthKey: imported history and the enrollment's start count) */
  firstMonthKey: string | null;
};

/** Oct 27 2026 (Jordan, a client's Settings tab: "signed August, 2026, no ...
 *  she did not sign in August, she signed much before that"). With no signed
 *  start on file, the term started at the EARLIEST evidence: the first month
 *  on record including imported history, or the day the enrollment started.
 *  It used to read the first live month only, so every client whose earlier
 *  months were imported rather than run through the hub "started" the month
 *  the hub took over (August 2026). Pure. */
export function earliestMonthKey(keys: (string | null | undefined)[]): string | null {
  return keys.filter(isMonthKey).sort()[0] ?? null;
}
export type LedgerRow = { kind: string; qty: number; state: string };

export type Term = {
  start: string | null;
  /** the end as signed, before anything was added */
  signedEnd: string | null;
  /** the end with extensions and carried months */
  end: string | null;
  extensions: number;
  carried: number;
  /** total months from start to end, when both are known */
  months: number | null;
  /** how the start and signed end were found, in words */
  basis: string;
};

/** The term, from the enrollment's columns and the live ledger rows. Pure. */
export function termOf(t: TermInput, rows: LedgerRow[]): Term {
  const live = rows.filter((r) => r.state !== "VOID");
  const sum = (k: EntitlementKind) => live.filter((r) => r.kind === k).reduce((n, r) => n + Math.max(0, r.qty || 0), 0);
  const extensions = sum("EXTENSION_MONTH");
  const carried = sum("CARRY_TO_END");
  const start = isMonthKey(t.termStartMonth) ? t.termStartMonth : isMonthKey(t.firstMonthKey) ? t.firstMonthKey : null;
  const signedEnd = isMonthKey(t.termEndMonth)
    ? t.termEndMonth
    : start && t.billingMonths && t.billingMonths > 0 ? addMonths(start, t.billingMonths - 1) : null;
  const end = signedEnd ? addMonths(signedEnd, extensions + carried) : null;
  const basis = [
    isMonthKey(t.termStartMonth) ? "start set by the office" : start ? "start = the first program month" : "no start on file",
    isMonthKey(t.termEndMonth) ? "end set by the office" : signedEnd ? `end = start + ${t.billingMonths} months` : "no end on file",
  ].join(" · ");
  return { start, signedEnd, end, extensions, carried, months: start && end ? monthsBetween(start, end) : null, basis };
}
