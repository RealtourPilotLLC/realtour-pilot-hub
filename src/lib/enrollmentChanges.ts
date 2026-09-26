import "server-only";
import { prisma } from "@/lib/prisma";
import { PACKAGE_RULES, etMonthKey } from "@/lib/contentProgram";
import { callModeOf, recalcProgramMonthsForEnrollment, type CallMode } from "@/lib/programMonths";

// ---------------------------------------------------------------------------
// ENROLLMENT CHANGES (spec §17, Jordan's rules). Every settings edit on a
// ContentEnrollment is a ProgramEnrollmentChange row FIRST — field, from, to,
// effective date, what happens to the month in flight, who, why — and only
// then a column update. Three rules this module exists to enforce:
//
//   1. A package change carries an EFFECTIVE MONTH and an EXPLICIT choice for
//      the current month's obligation (KEEP the minted number or APPLY the
//      new one). Past months are never touched: videosOwed is a per-month
//      column and only the effective month forward is rewritten.
//   2. NOTHING here talks to Stripe, QuickBooks or Aryeo. billingTruth is
//      false on every row this module writes; a row with billingTruth=true
//      can only come from a processor sync (none exists — see billingTruth()).
//      The UI shows the difference; the code cannot charge anyone.
//   3. A scheduled change (effective next month) sits pending, appliedAt null,
//      until applyDueEnrollmentChanges() runs — from the hourly sweep, so the
//      month is minted with the new quantity on the 1st — never from a render.
// ---------------------------------------------------------------------------

export type ChangeField =
  | "package" | "videosPerMonth" | "sessionsPerMonth" | "sessionHours" | "status" | "callMode" | "noCallEligible"
  | "billingType" | "billingRate" | "billingMonths" | "overrides" | "clientSuppliesTopics" | "strategyCallRequired" | "timezone" | "notes";

export type CurrentMonthChoice = "KEEP" | "APPLY";

const enc = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** First day of an ET month as an instant (05:00Z is safely inside the ET day in both DST states). */
function monthStart(monthKey: string): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 5));
}
export function nextMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export type NewChange = {
  enrollmentId: string; clientId: string; field: ChangeField; from: unknown; to: unknown;
  effectiveAt: Date; effectiveMonthKey?: string | null; currentMonthChoice?: CurrentMonthChoice | null; reason?: string | null;
  changedBy: string | null; source?: "manual" | "aryeo" | "stripe" | "system"; appliedAt?: Date | null;
};

// ---------------------------------------------------------------------------
// SUPERSEDING A SCHEDULED CHANGE.
//
// Found while accepting this module (Sep 17): schedule "Pro from October",
// then change your mind and go back to Starter, and the October row was still
// sitting there pending — on the 1st it would have quietly raised the client
// to 8 videos, from a decision that had already been reversed. A scheduled
// change that a newer decision replaces must stop being a future instruction.
//
// The schema is frozen for this wave and has no supersededAt column, so a
// superseded row is CLOSED (appliedAt stamped, which is what stops the
// applier) and its reason is prefixed so that every reader can tell the
// difference between "this took effect" and "this never did". Nothing is
// deleted. `isSupersededChange` is the one predicate; the Settings history
// labels such a row "superseded — never applied", not "applied".
// HANDOVER: a real `supersededAt DateTime?` + `supersededById String?` on
// ProgramEnrollmentChange would retire this convention. Additive, nullable.
// ---------------------------------------------------------------------------
export const SUPERSEDED_PREFIX = "SUPERSEDED — never took effect";
export const isSupersededChange = (r: { reason: string | null }) => !!r.reason?.startsWith(SUPERSEDED_PREFIX);

/** A superseded scheduled decision, in the words the owner is told about it. */
export type SupersededChange = { id: string; field: ChangeField; effectiveMonthKey: string | null; to: string; sentence: string };

const FIELD_WORDS: Partial<Record<ChangeField, string>> = {
  package: "package", videosPerMonth: "videos per month", sessionsPerMonth: "sessions per month", sessionHours: "session hours",
};

// WHICH pending rows a decision replaces (Sep 24 fix). A decision "X from
// month M" replaces what was scheduled from M on — but only where it actually
// SAYS something new. When it wrote a row for this field, every other pending
// row from M on is replaced (`inclusive`). When it wrote none — the field
// already reads X in M, very often BECAUSE of a pending row — the rows that
// put it there must survive, so only rows strictly AFTER M go. The old rule
// superseded from M inclusive either way: pressing "Pro from October" twice,
// or re-typing the Pro count after a KEEP upgrade, cancelled the very rows
// that made it Pro, and the client stayed on the old numbers for good.
async function supersedePending(enrollmentId: string, field: ChangeField, fromMonthKey: string, byId: string | null, keep: Set<string>, inclusive: boolean): Promise<SupersededChange[]> {
  const pending = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId, field, appliedAt: null }, select: { id: true, effectiveMonthKey: true, reason: true, toValue: true } });
  const done: SupersededChange[] = [];
  for (const p of pending) {
    if (keep.has(p.id)) continue; // the decision we are recording right now
    if (isSupersededChange(p)) continue;
    const m = p.effectiveMonthKey ?? "";
    if (inclusive ? m < fromMonthKey : m <= fromMonthKey) continue;
    await prisma.programEnrollmentChange.update({
      where: { id: p.id },
      data: { appliedAt: new Date(), reason: `${SUPERSEDED_PREFIX}${byId ? ` (replaced by ${byId})` : ""}${p.reason ? ` · was: ${p.reason}` : ""}`.slice(0, 900) },
    });
    let to = p.toValue ?? "";
    try { to = String(JSON.parse(p.toValue ?? "null") ?? ""); } catch { /* keep the raw text */ }
    done.push({
      id: p.id, field, effectiveMonthKey: p.effectiveMonthKey, to,
      sentence: `${FIELD_WORDS[field] ?? field} → ${to || "?"} from ${p.effectiveMonthKey ?? "an unset month"}`,
    });
  }
  return done;
}

/**
 * What a field will BE in `monthKey`, counting changes that are scheduled but
 * not yet applied. Comparing a new decision against the current column alone
 * was the second half of the bug above: with an October raise pending, a
 * revert to today's numbers looked like "nothing changed" and wrote no row.
 */
async function valueInForce<T>(enrollmentId: string, field: ChangeField, monthKey: string, current: T): Promise<T> {
  const rows = await prisma.programEnrollmentChange.findMany({
    where: { enrollmentId, field, appliedAt: null },
    orderBy: [{ effectiveMonthKey: "asc" }, { createdAt: "asc" }],
    select: { toValue: true, effectiveMonthKey: true, reason: true },
  });
  let v = current;
  for (const r of rows) {
    if (isSupersededChange(r)) continue;
    if ((r.effectiveMonthKey ?? "") > monthKey) continue;
    v = (r.toValue == null ? null : JSON.parse(r.toValue)) as T;
  }
  return v;
}

/**
 * The package terms a month will run on, scheduled changes included — the
 * same fold changePackage compares against, so a settings form can start from
 * (and compare with) what next month will really be rather than today's
 * column, which after a KEEP upgrade still reads the old quantities.
 */
export async function termsInMonth(enrollmentId: string, monthKey: string): Promise<{ pkg: string; videosPerMonth: number; sessionsPerMonth: number; sessionHours: number }> {
  const e = await enrollment(enrollmentId);
  const [pkg, videosPerMonth, sessionsPerMonth, sessionHours] = await Promise.all([
    valueInForce(enrollmentId, "package", monthKey, e.package),
    valueInForce(enrollmentId, "videosPerMonth", monthKey, e.videosPerMonth),
    valueInForce(enrollmentId, "sessionsPerMonth", monthKey, e.sessionsPerMonth),
    valueInForce(enrollmentId, "sessionHours", monthKey, e.sessionHours),
  ]);
  return { pkg, videosPerMonth, sessionsPerMonth, sessionHours };
}

/** The ledger write. Returns the row id. Never touches the enrollment. */
export async function recordEnrollmentChange(c: NewChange): Promise<string> {
  const r = await prisma.programEnrollmentChange.create({
    data: {
      enrollmentId: c.enrollmentId, clientId: c.clientId, field: c.field, fromValue: enc(c.from), toValue: enc(c.to),
      effectiveAt: c.effectiveAt, effectiveMonthKey: c.effectiveMonthKey ?? null, currentMonthChoice: c.currentMonthChoice ?? null,
      reason: c.reason?.trim() || null, source: c.source ?? "manual", billingTruth: false, changedBy: c.changedBy, appliedAt: c.appliedAt ?? null,
    },
    select: { id: true },
  });
  return r.id;
}

async function enrollment(enrollmentId: string) {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId } });
  if (!e) throw new Error("Enrollment not found.");
  return e;
}

// ---- package ------------------------------------------------------------------

export type PackageChangeInput = {
  package: string;
  /** The first month the new package applies to ("2026-10"). Defaults to the current ET month. */
  effectiveMonthKey?: string | null;
  /** What happens to the month in flight when the change is effective now. REQUIRED when effective this month. */
  currentMonthChoice?: CurrentMonthChoice | null;
  /** Custom quantities (the 5-video Accelerators); null = the package rule. */
  videosPerMonth?: number | null;
  sessionsPerMonth?: number | null;
  reason?: string | null;
};

/**
 * Change the package. Writes one ledger row per field that differs (package,
 * videosPerMonth, sessionsPerMonth, sessionHours), all sharing the effective
 * date and the current-month choice, then applies them if they are due.
 */
export async function changePackage(enrollmentId: string, input: PackageChangeInput, by: string | null): Promise<{ applied: boolean; effectiveMonthKey: string; obligationMonthKey: string; changeIds: string[]; superseded: SupersededChange[] }> {
  const e = await enrollment(enrollmentId);
  const rules = PACKAGE_RULES[input.package];
  if (!rules) throw new Error("Unknown package.");
  const now = etMonthKey();
  const effectiveMonthKey = input.effectiveMonthKey && /^\d{4}-\d{2}$/.test(input.effectiveMonthKey) ? input.effectiveMonthKey : now;
  if (effectiveMonthKey < now) throw new Error("A package change cannot be back-dated — past months keep their quantities.");
  const immediate = effectiveMonthKey === now;
  if (immediate && !input.currentMonthChoice) throw new Error("Choose what happens to this month's obligation: keep it, or apply the new quantity.");
  const choice: CurrentMonthChoice | null = immediate ? input.currentMonthChoice! : null;
  // The obligation month: with KEEP, quantities change from NEXT month; the
  // package label itself changes on the effective date either way.
  const obligationMonthKey = immediate && choice === "KEEP" ? nextMonth(now) : effectiveMonthKey;
  const effectiveAt = immediate ? new Date() : monthStart(effectiveMonthKey);
  // With KEEP the quantities (videos, sessions, hours) only take effect when
  // the obligation month begins — the enrollment row keeps this month's
  // numbers so every reader (roster flags, session capacity) agrees with the
  // minted month. The package LABEL changes on the effective date either way.
  const qtyEffectiveAt = obligationMonthKey === effectiveMonthKey ? effectiveAt : monthStart(obligationMonthKey);
  const videos = input.videosPerMonth ?? rules.videosPerMonth;
  const sessions = input.sessionsPerMonth ?? rules.sessionsPerMonth;
  if (!Number.isInteger(videos) || videos < 1 || videos > 31) throw new Error("Bad video count.");
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 10) throw new Error("Bad session count.");
  const base = { enrollmentId, clientId: e.clientId, effectiveAt, currentMonthChoice: choice, reason: input.reason ?? null, changedBy: by } as const;
  const ids: string[] = [];
  // Compare against what each field WILL be in the effective month (scheduled
  // changes included), not just today's column — see valueInForce.
  const [pkgNow, vNow, sNow, hNow] = await Promise.all([
    valueInForce(enrollmentId, "package", effectiveMonthKey, e.package),
    valueInForce(enrollmentId, "videosPerMonth", obligationMonthKey, e.videosPerMonth),
    valueInForce(enrollmentId, "sessionsPerMonth", obligationMonthKey, e.sessionsPerMonth),
    valueInForce(enrollmentId, "sessionHours", obligationMonthKey, e.sessionHours),
  ]);
  const wrote = new Set<ChangeField>();
  const put = async (c: NewChange) => { ids.push(await recordEnrollmentChange(c)); wrote.add(c.field); };
  if (pkgNow !== input.package) await put({ ...base, field: "package", from: pkgNow, to: input.package, effectiveMonthKey });
  const qty = { ...base, effectiveAt: qtyEffectiveAt, effectiveMonthKey: obligationMonthKey } as const;
  if (vNow !== videos) await put({ ...qty, field: "videosPerMonth", from: vNow, to: videos });
  if (sNow !== sessions) await put({ ...qty, field: "sessionsPerMonth", from: sNow, to: sessions });
  if (hNow !== rules.sessionHours) await put({ ...qty, field: "sessionHours", from: hNow, to: rules.sessionHours });
  // A change still scheduled for the effective month or later has been
  // replaced by this decision and must not fire on its own — for a field this
  // decision wrote; for one it left alone, only rows AFTER the month (see
  // supersedePending: the rows that already make it read this way survive).
  const newest = ids[ids.length - 1] ?? null;
  const keep = new Set(ids);
  // Retiring a future decision is a decision. It is RETURNED so the caller can
  // name it — Jordan's rule is that a package change is never a silent
  // rewrite, and "Recorded" alone would hide that an Accelerator-from-November
  // he had already agreed has just been cancelled.
  const superseded = (await Promise.all([
    supersedePending(enrollmentId, "package", effectiveMonthKey, newest, keep, wrote.has("package")),
    supersedePending(enrollmentId, "videosPerMonth", obligationMonthKey, newest, keep, wrote.has("videosPerMonth")),
    supersedePending(enrollmentId, "sessionsPerMonth", obligationMonthKey, newest, keep, wrote.has("sessionsPerMonth")),
    supersedePending(enrollmentId, "sessionHours", obligationMonthKey, newest, keep, wrote.has("sessionHours")),
  ])).flat();
  if (ids.length === 0) return { applied: false, effectiveMonthKey, obligationMonthKey, changeIds: [], superseded };
  const r = await applyDueEnrollmentChanges(enrollmentId);
  return { applied: r.applied > 0, effectiveMonthKey, obligationMonthKey, changeIds: ids, superseded };
}

// ---- the other settings (effective now, still ledgered) -------------------------------

export async function setCallMode(enrollmentId: string, mode: CallMode, noCallEligible: boolean | null, by: string | null, reason?: string | null): Promise<void> {
  const e = await enrollment(enrollmentId);
  const cur = callModeOf(e);
  const now = new Date();
  const base = { enrollmentId, clientId: e.clientId, effectiveAt: now, effectiveMonthKey: etMonthKey(), changedBy: by, reason: reason ?? null, appliedAt: now } as const;
  if (cur !== mode || e.callMode !== mode) await recordEnrollmentChange({ ...base, field: "callMode", from: e.callMode ?? `${cur} (derived)`, to: mode });
  if (e.noCallEligible !== noCallEligible) await recordEnrollmentChange({ ...base, field: "noCallEligible", from: e.noCallEligible, to: noCallEligible });
  // strategyCallRequired is the legacy mirror every older reader still
  // checks (roster flags, the call-invite minter): REQUIRED → true, else false.
  const legacy = mode === "REQUIRED";
  if (e.strategyCallRequired !== legacy) await recordEnrollmentChange({ ...base, field: "strategyCallRequired", from: e.strategyCallRequired, to: legacy });
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { callMode: mode, noCallEligible, strategyCallRequired: legacy } });
  // Open months re-derive NOT_SCHEDULED ↔ NOT_REQUIRED by rule (programMonths).
  await recalcProgramMonthsForEnrollment(enrollmentId).catch(() => {});
}

export async function setEnrollmentStatus(enrollmentId: string, status: "ACTIVE" | "PAUSED" | "ENDED", by: string | null, reason?: string | null): Promise<void> {
  const e = await enrollment(enrollmentId);
  if (e.status === status) return;
  const now = new Date();
  await recordEnrollmentChange({ enrollmentId, clientId: e.clientId, field: "status", from: e.status, to: status, effectiveAt: now, effectiveMonthKey: etMonthKey(), changedBy: by, reason: reason ?? null, appliedAt: now });
  // statusManual: a human owns this status from here — the Aryeo sync must not flip it back.
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { status, statusManual: true } });
}

export async function setBillingTerms(enrollmentId: string, terms: { type: string | null; rate: number | null; months: number | null }, by: string | null): Promise<void> {
  const e = await enrollment(enrollmentId);
  if (terms.type !== null && !["PAID_IN_FULL", "MONTHLY_CONTRACT", "MONTH_TO_MONTH", "TRIAL"].includes(terms.type)) throw new Error("Unknown billing type.");
  if (terms.rate !== null && (!Number.isFinite(terms.rate) || terms.rate < 0)) throw new Error("Bad rate.");
  if (terms.months !== null && (!Number.isInteger(terms.months) || terms.months < 1 || terms.months > 60)) throw new Error("Bad term length.");
  const now = new Date();
  const base = { enrollmentId, clientId: e.clientId, effectiveAt: now, effectiveMonthKey: etMonthKey(), changedBy: by, appliedAt: now } as const;
  if (e.billingType !== terms.type) await recordEnrollmentChange({ ...base, field: "billingType", from: e.billingType, to: terms.type });
  if (e.billingRate !== terms.rate) await recordEnrollmentChange({ ...base, field: "billingRate", from: e.billingRate, to: terms.rate });
  if (e.billingMonths !== terms.months) await recordEnrollmentChange({ ...base, field: "billingMonths", from: e.billingMonths, to: terms.months });
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { billingType: terms.type, billingRate: terms.rate, billingMonths: terms.months } });
}

export async function setWorkflowFlags(enrollmentId: string, flags: { clientSuppliesTopics?: boolean; timezone?: string | null; notes?: string | null }, by: string | null): Promise<void> {
  const e = await enrollment(enrollmentId);
  const now = new Date();
  const base = { enrollmentId, clientId: e.clientId, effectiveAt: now, effectiveMonthKey: etMonthKey(), changedBy: by, appliedAt: now } as const;
  const data: Record<string, unknown> = {};
  if (flags.clientSuppliesTopics !== undefined && flags.clientSuppliesTopics !== e.clientSuppliesTopics) { await recordEnrollmentChange({ ...base, field: "clientSuppliesTopics", from: e.clientSuppliesTopics, to: flags.clientSuppliesTopics }); data.clientSuppliesTopics = flags.clientSuppliesTopics; }
  if (flags.timezone !== undefined && flags.timezone !== e.timezone) { await recordEnrollmentChange({ ...base, field: "timezone", from: e.timezone, to: flags.timezone }); data.timezone = flags.timezone; }
  if (flags.notes !== undefined && (flags.notes ?? "") !== (e.notes ?? "")) { await recordEnrollmentChange({ ...base, field: "notes", from: (e.notes ?? "").slice(0, 200), to: (flags.notes ?? "").slice(0, 200) }); data.notes = flags.notes; }
  if (Object.keys(data).length) await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data });
}

/**
 * Permitted overrides (spec §17): a small JSON bag on the enrollment, ledgered per key.
 *
 * `preparationWindowHours` (W01, Sep 25 2026) is the preparation window in
 * weekday hours — the rule's own unit; the program default is 72. The old
 * `preparationWindowDays` key was a dead control (nothing read it); it is now
 * READ as days × 24 (programMonths.enrollmentWindowOverrideHours) and kept
 * editable only so an owner can clear a legacy value. Hours win when both exist.
 */
export const OVERRIDE_KEYS = ["preparationWindowHours", "preparationWindowDays", "extraSessionsAllowed", "requireCallForMonths"] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];
export function readOverrides(json: string | null | undefined): Record<string, unknown> {
  try { const v = json ? JSON.parse(json) : {}; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}
export async function setOverride(enrollmentId: string, key: OverrideKey, value: unknown, by: string | null): Promise<void> {
  // The window is read by every filming gate the moment it is saved, so a
  // nonsense value is refused here rather than turned into a calendar: whole
  // weekday hours, up to four weeks of weekdays.
  if (key === "preparationWindowHours" && value !== null && value !== undefined && value !== "") {
    const h = Number(value);
    if (!Number.isInteger(h) || h < 1 || h > 480) throw new Error("The preparation window is whole weekday hours, from 1 to 480 (the program default is 72).");
  }
  if (key === "preparationWindowDays" && value !== null && value !== undefined && value !== "") {
    const d = Number(value);
    if (!Number.isFinite(d) || d <= 0 || d > 20) throw new Error("Set the window in weekday hours instead (the program default is 72).");
  }
  const e = await enrollment(enrollmentId);
  const cur = readOverrides(e.overridesJson);
  if (JSON.stringify(cur[key] ?? null) === JSON.stringify(value ?? null)) return;
  const next = { ...cur };
  if (value === null || value === undefined || value === "") delete next[key]; else next[key] = value;
  const now = new Date();
  await recordEnrollmentChange({ enrollmentId, clientId: e.clientId, field: "overrides", from: { [key]: cur[key] ?? null }, to: { [key]: value ?? null }, effectiveAt: now, effectiveMonthKey: etMonthKey(), changedBy: by, appliedAt: now });
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { overridesJson: Object.keys(next).length ? JSON.stringify(next) : null } });
}

// ---- applying due changes ---------------------------------------------------------------

/**
 * Apply every pending change whose effective date has arrived. Idempotent
 * (appliedAt marks a row done). Quantities land on the effective month
 * FORWARD only — a month before effectiveMonthKey keeps the number it was
 * minted with, which is how "this month's obligation stays unchanged" holds.
 */
export async function applyDueEnrollmentChanges(enrollmentId?: string): Promise<{ applied: number }> {
  const now = new Date();
  const due = await prisma.programEnrollmentChange.findMany({
    where: { appliedAt: null, effectiveAt: { lte: now }, source: { in: ["manual", "system"] }, ...(enrollmentId ? { enrollmentId } : {}) },
    orderBy: { effectiveAt: "asc" },
  });
  let applied = 0;
  for (const c of due) {
    // Belt and braces: a superseded row already carries appliedAt, so it never
    // reaches here — but the applier refuses one anyway rather than trusting
    // one stamp for two meanings.
    if (isSupersededChange(c)) continue;
    const to = c.toValue == null ? null : (JSON.parse(c.toValue) as unknown);
    const data: Record<string, unknown> = {};
    switch (c.field) {
      case "package": Object.assign(data, { package: String(to), packageSource: "manual" }); break;
      case "videosPerMonth": data.videosPerMonth = Number(to); break;
      case "sessionsPerMonth": data.sessionsPerMonth = Number(to); break;
      case "sessionHours": data.sessionHours = Number(to); break;
      default: break; // every other field is written by its own setter at record time
    }
    if (Object.keys(data).length) {
      await prisma.contentEnrollment.update({ where: { id: c.enrollmentId }, data });
      if (c.field === "videosPerMonth" && c.effectiveMonthKey) {
        // Only OPEN, live months from the obligation month forward. Past and
        // historical months are never rewritten (spec §17 / Jordan).
        await prisma.contentMonth.updateMany({ where: { enrollmentId: c.enrollmentId, historical: false, status: { notIn: ["SKIPPED", "IMPORTED"] }, monthKey: { gte: c.effectiveMonthKey } }, data: { videosOwed: Number(to) } });
      }
    }
    await prisma.programEnrollmentChange.update({ where: { id: c.id }, data: { appliedAt: now } });
    applied++;
  }
  return { applied };
}

// ---- reads for the Settings tab -----------------------------------------------------------

export type BillingTruth = {
  /** stripe = a paid website checkout created this enrollment; owner = typed on this screen; none = nothing recorded */
  source: "stripe" | "owner" | "none";
  typed: { type: string | null; rate: number | null; months: number | null };
  signup: { productName: string; amount: number; recurring: boolean; paidAt: Date; subscriptionId: string | null; status: string } | null;
  packageSource: string;
};

/** Where the money facts come from — shown beside them, never inferred silently. */
export async function billingTruth(enrollmentId: string): Promise<BillingTruth> {
  const e = await enrollment(enrollmentId);
  const signup = await prisma.programSignup.findFirst({ where: { enrollmentId }, orderBy: { paidAt: "desc" }, select: { productName: true, amount: true, recurring: true, paidAt: true, subscriptionId: true, status: true } });
  const typed = { type: e.billingType, rate: e.billingRate, months: e.billingMonths };
  return { source: signup ? "stripe" : typed.type ? "owner" : "none", typed, signup, packageSource: e.packageSource };
}

export type ChangeRow = { id: string; field: string; from: string | null; to: string | null; effectiveAt: Date; effectiveMonthKey: string | null; currentMonthChoice: string | null; reason: string | null; source: string; billingTruth: boolean; changedBy: string | null; appliedAt: Date | null; createdAt: Date; superseded: boolean };

export async function enrollmentHistory(enrollmentId: string, take = 60): Promise<ChangeRow[]> {
  const rows = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId }, orderBy: { createdAt: "desc" }, take });
  const dec = (v: string | null) => { if (v == null) return null; try { const x = JSON.parse(v); return typeof x === "string" ? x : JSON.stringify(x); } catch { return v; } };
  return rows.map((r) => ({ id: r.id, field: r.field, from: dec(r.fromValue), to: dec(r.toValue), effectiveAt: r.effectiveAt, effectiveMonthKey: r.effectiveMonthKey, currentMonthChoice: r.currentMonthChoice, reason: r.reason, source: r.source, billingTruth: r.billingTruth, changedBy: r.changedBy, appliedAt: r.appliedAt, createdAt: r.createdAt, superseded: isSupersededChange(r) }));
}

export async function pendingChanges(enrollmentId: string): Promise<ChangeRow[]> {
  return (await enrollmentHistory(enrollmentId, 200)).filter((r) => !r.appliedAt && !r.superseded && r.effectiveAt > new Date());
}
