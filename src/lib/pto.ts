import "server-only";
import { prisma } from "@/lib/prisma";
import { companyHolidayName } from "@/lib/paySavings";
import { FIXED_PAY, FIXED_PAY_ORDER, fixedPayFor } from "@/lib/payStructure";

// ---------------------------------------------------------------------------
// PAID TIME OFF (Jordan, Oct 22 2026: "I also need a PTO tracker").
//
// The terms, as built:
//   · 10 paid service days per agreement year, one combined bank for
//     vacation, personal, sick and family care ("sick days count as PTO
//     days");
//   · the agreement year starts Sep 25 (Sep 25 2026 to Sep 24 2027, …), and
//     the full bank is available at once;
//   · a service day is Monday to Friday; a partial day uses the matching
//     fraction (a half day is 0.5);
//   · no carryover and no payout: each agreement year starts at 10 again;
//   · paid time off does not reduce regular pay (nothing here touches payroll);
//   · the six company holidays (New Year's Day, Memorial Day, Independence
//     Day, Labor Day, Thanksgiving, Christmas: lib/paySavings
//     companyHolidayName, the list the weekend and holiday premium uses) do
//     NOT use the bank: a range over one skips it.
//
// Who: the people on these terms (lib/payStructure FIXED_PAY, exact roster
// name on an active row): Harrison and James.
//
// WHERE IT LIVES: AppSetting `pto:<teamMemberId>:<agreementYearStartKey>`,
// JSON { entries, log }, compare-and-set like the KPI review (no schema
// change). Owner writes (app/sales/ptoActions); each person sees their own
// balance and days on My Performance.
//
// NOT DONE HERE: booking does not see PTO. Shoot availability is Aryeo's
// (lib/sessionTravel reads it), and the hub never writes a creative's Aryeo
// calendar, so a PTO day still has to be blocked in Aryeo by hand.
// ---------------------------------------------------------------------------

export const PTO_BANK_DAYS = 10;
/** Month and day the agreement year starts. */
export const AGREEMENT_YEAR_START_MD = "09-25";

export type PtoType = "vacation" | "personal" | "sick" | "family";
export const PTO_TYPES: { key: PtoType; label: string }[] = [
  { key: "vacation", label: "Vacation" },
  { key: "personal", label: "Personal" },
  { key: "sick", label: "Sick" },
  { key: "family", label: "Family care" },
];
/** The partial-day fractions offered (a single service day only). */
export const PTO_FRACTIONS = [1, 0.75, 0.5, 0.25] as const;

export type PtoEntry = {
  id: string;
  startKey: string;
  endKey: string;
  type: PtoType;
  /** 1 = full day(s); a fraction only on a single service day */
  fraction: number;
  note: string;
  by: string;
  at: string;
  editedBy?: string | null;
  editedAt?: string | null;
};
export type PtoLogLine = { at: string; by: string; what: string };
type PtoDoc = { v: 1; entries: PtoEntry[]; log: PtoLogLine[] };

export type PtoYear = { key: string; startKey: string; endKey: string; label: string };

const DAY = 86_400_000;
const noon = (k: string) => Date.parse(`${k}T12:00:00Z`);
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (k: string, n: number) => keyOf(noon(k) + n * DAY);
const short = (k: string, year = true) => new Date(noon(k)).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
export const isDayKey = (k: unknown): k is string => typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(noon(k));

/** The agreement year holding an ET day (pure). */
export function agreementYearFor(dayKey: string): PtoYear {
  const y = Number(dayKey.slice(0, 4));
  const startYear = dayKey.slice(5) >= AGREEMENT_YEAR_START_MD ? y : y - 1;
  const startKey = `${startYear}-${AGREEMENT_YEAR_START_MD}`;
  const endKey = addDays(`${startYear + 1}-${AGREEMENT_YEAR_START_MD}`, -1);
  return { key: startKey, startKey, endKey, label: `${short(startKey)} to ${short(endKey)}` };
}

/** Is an ET day a service day (Monday to Friday)? */
export const isServiceDay = (k: string) => {
  const dow = new Date(noon(k)).getUTCDay();
  return dow >= 1 && dow <= 5;
};

/** The service days a range uses, and the company holidays it skips (pure). */
export function serviceDaysIn(startKey: string, endKey: string): { days: string[]; holidays: { day: string; name: string }[] } {
  const days: string[] = [];
  const holidays: { day: string; name: string }[] = [];
  for (let k = startKey, guard = 0; k <= endKey && guard < 400; k = addDays(k, 1), guard++) {
    if (!isServiceDay(k)) continue;
    const h = companyHolidayName(k);
    if (h) holidays.push({ day: k, name: h });
    else days.push(k);
  }
  return { days, holidays };
}

/** Bank days an entry uses (pure): its service days × its fraction. */
export function ptoDaysUsed(e: Pick<PtoEntry, "startKey" | "endKey" | "fraction">): number {
  const n = serviceDaysIn(e.startKey, e.endKey).days.length;
  return Math.round(n * (n === 1 ? e.fraction : 1) * 100) / 100;
}

/** The company holidays in an agreement year (pure). */
export function companyHolidaysIn(year: PtoYear): { day: string; name: string; serviceDay: boolean }[] {
  const out: { day: string; name: string; serviceDay: boolean }[] = [];
  for (let k = year.startKey; k <= year.endKey; k = addDays(k, 1)) {
    const h = companyHolidayName(k);
    if (h) out.push({ day: k, name: h, serviceDay: isServiceDay(k) });
  }
  return out;
}

export type PtoBalance = {
  memberId: string;
  name: string;
  year: PtoYear;
  bank: number;
  used: number;
  remaining: number;
  /** days beyond the paid bank (0 when inside it) */
  over: number;
  entries: (PtoEntry & { days: number; serviceDays: string[]; holidaysSkipped: { day: string; name: string }[] })[];
  holidays: { day: string; name: string; serviceDay: boolean }[];
  log: PtoLogLine[];
};

export const ptoKey = (memberId: string, yearKey: string) => `pto:${memberId}:${yearKey}`;

/** A stored PTO year (AppSetting `pto:<memberId>:<yearKey>`), tolerant of a blank or broken value. Also read by lib/timeOff. */
export function parse(raw: string | null | undefined): PtoDoc {
  if (!raw) return { v: 1, entries: [], log: [] };
  try {
    const j = JSON.parse(raw) as Partial<PtoDoc>;
    return { v: 1, entries: Array.isArray(j.entries) ? j.entries : [], log: Array.isArray(j.log) ? j.log : [] };
  } catch {
    return { v: 1, entries: [], log: [] };
  }
}

/** Pure: a stored year as a balance. */
export function balanceOf(memberId: string, name: string, year: PtoYear, entries: PtoEntry[], log: PtoLogLine[] = []): PtoBalance {
  const rows = [...entries]
    .sort((a, b) => a.startKey.localeCompare(b.startKey))
    .map((e) => {
      const s = serviceDaysIn(e.startKey, e.endKey);
      return { ...e, days: ptoDaysUsed(e), serviceDays: s.days, holidaysSkipped: s.holidays };
    });
  const used = Math.round(rows.reduce((s, e) => s + e.days, 0) * 100) / 100;
  return {
    memberId,
    name,
    year,
    bank: PTO_BANK_DAYS,
    used,
    remaining: Math.max(0, Math.round((PTO_BANK_DAYS - used) * 100) / 100),
    over: Math.max(0, Math.round((used - PTO_BANK_DAYS) * 100) / 100),
    entries: rows,
    holidays: companyHolidaysIn(year),
    log,
  };
}

export async function ptoBalance(memberId: string, name: string, yearKey: string): Promise<PtoBalance> {
  const year = agreementYearFor(yearKey);
  const row = await prisma.appSetting.findUnique({ where: { key: ptoKey(memberId, year.key) }, select: { value: true } });
  const doc = parse(row?.value);
  return balanceOf(memberId, name, year, doc.entries, doc.log);
}

/** Pure: the entry that takes this whole day off (a partial day never does: they still work part of it). */
export function fullDayOffEntry(entries: PtoEntry[], dayKey: string): PtoEntry | null {
  return entries.find((e) => (e.fraction ?? 1) >= 1 && isDayKey(e.startKey) && isDayKey(e.endKey) && e.startKey <= dayKey && dayKey <= e.endKey) ?? null;
}

/**
 * THE FIELD SIDE'S READ (audit Oct 25 2026: Harrison's week off, Oct 26 to 30,
 * was on the tracker while five shoots that week still named him, and the
 * photographer brief texted him Monday's). For each person and ET day, the PTO
 * entry that takes the whole day off, keyed `<memberId>|<day>`. Reads only; a
 * read that fails answers "nobody is off", so nothing is held by a database blip.
 */
export async function fullDaysOff(pairs: { teamMemberId: string; day: string }[]): Promise<Map<string, PtoEntry>> {
  const out = new Map<string, PtoEntry>();
  const wanted = pairs.filter((p) => p.teamMemberId && isDayKey(p.day));
  if (!wanted.length) return out;
  const keys = [...new Set(wanted.map((p) => ptoKey(p.teamMemberId, agreementYearFor(p.day).key)))];
  const rows = await prisma.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } }).catch(() => []);
  const docs = new Map(rows.map((r) => [r.key, parse(r.value)]));
  for (const p of wanted) {
    const doc = docs.get(ptoKey(p.teamMemberId, agreementYearFor(p.day).key));
    const e = doc ? fullDayOffEntry(doc.entries, p.day) : null;
    if (e) out.set(`${p.teamMemberId}|${p.day}`, e);
  }
  return out;
}

/** The people PTO is tracked for: active roster rows on the terms (Harrison, James). */
export async function ptoRoster(): Promise<{ id: string; name: string }[]> {
  const names = FIXED_PAY_ORDER.map((k) => FIXED_PAY[k].fullName.toLowerCase());
  const rows = await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true, active: true } });
  return rows
    .filter((r) => fixedPayFor(r))
    .sort((a, b) => names.indexOf(a.name.trim().toLowerCase()) - names.indexOf(b.name.trim().toLowerCase()))
    .map((r) => ({ id: r.id, name: r.name }));
}

/** Change one person-year, compare-and-set. `change` returns the new entries and a log line, or a refusal. */
export async function updatePto(
  memberId: string,
  yearKey: string,
  by: string,
  change: (entries: PtoEntry[]) => { entries: PtoEntry[]; what: string } | string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const key = ptoKey(memberId, yearKey);
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    const doc = parse(row?.value);
    const out = change(structuredClone(doc.entries));
    if (typeof out === "string") return { ok: false, message: out };
    const value = JSON.stringify({ v: 1, entries: out.entries, log: [...doc.log, { at: new Date().toISOString(), by, what: out.what }].slice(-200) });
    if (!row) {
      if (await prisma.appSetting.create({ data: { key, value, updatedBy: by.slice(0, 120) } }).then(() => true, () => false)) return { ok: true };
      continue;
    }
    const r = await prisma.appSetting.updateMany({ where: { key, value: row.value }, data: { value, updatedBy: by.slice(0, 120) } });
    if (r.count === 1) return { ok: true };
  }
  return { ok: false, message: "Someone else changed this at the same moment. Reload and try again." };
}

/** "Mon Oct 26" or "Mon Oct 26 to Fri Oct 30" (pure). */
export function rangeLabel(startKey: string, endKey: string): string {
  const one = (k: string) => new Date(noon(k)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(/,/g, "");
  return startKey === endKey ? one(startKey) : `${one(startKey)} to ${one(endKey)}`;
}
