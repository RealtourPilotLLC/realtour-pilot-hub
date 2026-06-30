import "server-only";
import { prisma } from "@/lib/prisma";
import { driveBetween } from "@/lib/travel";
import { etDayKey, etDayStartUtc } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Creative payroll engine.
//
// Per Jordan's formulas (rates are set per creative in their profile):
//   Shoot Pay  = max(eligible services invoice × payPercent, payFloor)
//   Daily Mileage Pay = max(total daily drive miles − (homeRadius × 2), 0) × mileageRate
//   Mileage Pay Per Job = Daily Mileage Pay ÷ jobs that day (that take mileage)
//   Job Total  = Shoot Pay + Mileage Pay Per Job
//   Period Total = Σ Job Totals ± manual adjustments
//
// The eligible invoice (Project.payableInvoice) already excludes virtual/AI
// add-ons + canceled items. Mileage is real road distance (home → that day's
// shoots → home) via OSRM, cached per day in MileageDay.
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- Bi-weekly pay periods --------------------------------------------------
// Periods are 14 days, anchored at 2026-05-31 (a real period start). Payout is
// the Friday 6 days after the period ends (e.g. May 31–Jun 13 → paid Jun 19;
// Jun 14–Jun 27 → paid Jul 3).
const PERIOD_ANCHOR = "2026-05-31";
const PERIOD_DAYS = 14;
const DAY_MS = 86400000;
const noonUTC = (key: string) => new Date(key + "T12:00:00Z").getTime();
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type PayPeriod = { startKey: string; endKey: string; payoutKey: string };

// The pay period containing a given yyyy-mm-dd (defaults to today, in ET — the
// business's timezone. Using the UTC day here would roll the period over a few
// hours early on the evening a period ends.)
export function payPeriodFor(dateKey?: string): PayPeriod {
  const today = etDayKey(new Date());
  const d = noonUTC(dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : today);
  const anchor = noonUTC(PERIOD_ANCHOR);
  const idx = Math.floor((d - anchor) / (PERIOD_DAYS * DAY_MS));
  const startMs = anchor + idx * PERIOD_DAYS * DAY_MS;
  return {
    startKey: keyOf(startMs),
    endKey: keyOf(startMs + (PERIOD_DAYS - 1) * DAY_MS),
    payoutKey: keyOf(startMs + (PERIOD_DAYS - 1 + 6) * DAY_MS),
  };
}

// Shift a period start by N periods (negative = earlier).
export function shiftPeriod(startKey: string, periods: number): PayPeriod {
  return payPeriodFor(keyOf(noonUTC(startKey) + periods * PERIOD_DAYS * DAY_MS));
}

// The [start, end] instant window for a period, anchored to ET calendar days.
// A shoot at 8pm ET on the last day of a period is 00:00 UTC the next day — a
// UTC midnight-to-midnight window would push it (and its pay) into the next
// period. These bounds are ET-midnight(startKey) → last-ms-of(endKey, ET), so
// pay lands in the period the shoot actually happened in.
export function periodBounds(p: { startKey: string; endKey: string }): { start: Date; end: Date } {
  const start = etDayStartUtc(new Date(p.startKey + "T12:00:00Z"));
  const endDayStart = etDayStartUtc(new Date(p.endKey + "T12:00:00Z"));
  const end = new Date(endDayStart.getTime() + DAY_MS - 1);
  return { start, end };
}

export function shootPay(invoice: number, percent?: number | null, floor?: number | null): number {
  return r2(Math.max(invoice * (percent ?? 0), floor ?? 0));
}

type Stop = { lat: number; lng: number; at: number };

// Total drive miles for a day: home → stops (in time order) → home.
async function routeMiles(home: { lat: number; lng: number }, stops: Stop[]): Promise<number> {
  if (stops.length === 0) return 0;
  const ordered = [...stops].sort((a, b) => a.at - b.at).map((s) => ({ lat: s.lat, lng: s.lng }));
  const points = [home, ...ordered, home];
  // Each leg is independent — route them in parallel (was serial, so a multi-stop
  // day meant N sequential OSRM round-trips on the payouts render path).
  const legs = await Promise.all(
    points.slice(0, -1).map((p, i) => driveBetween(p.lat, p.lng, points[i + 1].lat, points[i + 1].lng)),
  );
  const miles = legs.reduce((sum, d) => sum + (d?.miles ?? 0), 0);
  return r2(miles);
}

// Cached daily miles (recomputes if the day's stop count changed).
async function dailyMiles(
  memberId: string,
  dayKey: string,
  home: { lat: number; lng: number },
  stops: Stop[],
): Promise<number> {
  const cached = await prisma.mileageDay.findUnique({
    where: { teamMemberId_dayKey: { teamMemberId: memberId, dayKey } },
  });
  if (cached && cached.stops === stops.length) return cached.miles;
  const miles = await routeMiles(home, stops);
  await prisma.mileageDay.upsert({
    where: { teamMemberId_dayKey: { teamMemberId: memberId, dayKey } },
    create: { teamMemberId: memberId, dayKey, miles, stops: stops.length },
    update: { miles, stops: stops.length, computedAt: new Date() },
  });
  return miles;
}

export type PayrollJob = {
  projectId: string;
  title: string;
  shootISO: string | null;
  dayKey: string;
  invoice: number; // eligible services invoice the % is applied to
  invoiceIsFallback: boolean; // true when we fell back to order total (no payableInvoice)
  invoiceOverridden: boolean; // true when the invoice was manually corrected
  shootPay: number; // after any flat override
  baseShootPay: number; // before override (for transparency)
  mileageShare: number;
  jobTotal: number;
  hasCoords: boolean;
  override: { invoiceOverride: number | null; flatAmount: number | null; noMileage: boolean; excluded: boolean; note: string | null } | null;
};

export type PayrollDay = {
  dayKey: string;
  miles: number;
  freeMiles: number;
  payableMiles: number;
  mileagePay: number;
  jobs: number; // jobs sharing the mileage
};

export type PayrollIssue = { level: "warn" | "info"; message: string; projectId?: string };

export type PayrollPerson = {
  member: { id: string; name: string; avatarColor: string };
  configured: boolean; // percent + floor set
  hasHome: boolean;
  payPercent: number | null;
  payFloor: number | null;
  mileageRate: number;
  homeRadiusMi: number;
  jobs: PayrollJob[];
  days: PayrollDay[];
  adjustments: { id: string; label: string; amount: number; dateISO: string }[];
  issues: PayrollIssue[];
  shootPayTotal: number;
  mileageTotal: number;
  adjustmentTotal: number;
  total: number;
};

// Shoots in the period with NO photographer assigned — nobody is being paid for
// them, so they're a payout discrepancy to surface.
export async function unassignedShootsInRange(start: Date, end: Date): Promise<{ id: string; title: string; shootISO: string | null }[]> {
  const rows = await prisma.project.findMany({
    where: { shootDate: { gte: start, lte: end }, photographerId: null, status: { not: "CANCELLED" } },
    select: { id: true, title: true, shootDate: true },
    orderBy: { shootDate: "asc" },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, shootISO: r.shootDate ? r.shootDate.toISOString() : null }));
}

// Compute payroll for every photographer with shoots in [start, end]. Pass
// `opts.memberId` to scope to a single creative (used by the /shoot pay card so
// one photographer's view doesn't route everyone's day).
export async function computePayroll(start: Date, end: Date, opts?: { memberId?: string }): Promise<PayrollPerson[]> {
  // Attribute pay to the ORIGINAL shoot (earliest appointment), not the latest.
  // A return/reshoot trip adds a later appointment + moves Project.shootDate
  // forward; without this a job would be re-counted in a later period. So we
  // match any project with a relevant appointment OR shootDate in range, then
  // keep only those whose EARLIEST appointment (the paid shoot) lands in range.
  const projects = await prisma.project.findMany({
    where: {
      photographerId: opts?.memberId ?? { not: null },
      status: { not: "CANCELLED" },
      OR: [
        { appointments: { some: { startAt: { gte: start, lte: end }, status: { not: "CANCELED" } } } },
        { shootDate: { gte: start, lte: end } },
      ],
    },
    select: {
      id: true, title: true, shootDate: true, lat: true, lng: true,
      price: true, payableInvoice: true, photographerId: true,
      photographer: {
        select: {
          id: true, name: true, avatarColor: true,
          payPercent: true, payFloor: true, mileageRate: true, homeRadiusMi: true,
          homeLat: true, homeLng: true, homeAddress: true,
        },
      },
      appointments: { where: { status: { not: "CANCELED" }, startAt: { not: null } }, select: { startAt: true }, orderBy: { startAt: "asc" } },
      payOverrides: { select: { teamMemberId: true, invoiceOverride: true, flatAmount: true, noMileage: true, excluded: true, note: true } },
    },
    orderBy: { shootDate: "asc" },
  });

  // Manual adjustments in the period, grouped by member.
  const adjustments = await prisma.payoutAdjustment.findMany({
    where: { date: { gte: start, lte: end } },
    orderBy: { date: "asc" },
  });
  const adjByMember = new Map<string, typeof adjustments>();
  for (const a of adjustments) {
    if (!adjByMember.has(a.teamMemberId)) adjByMember.set(a.teamMemberId, []);
    adjByMember.get(a.teamMemberId)!.push(a);
  }

  // Group projects by photographer.
  const byMember = new Map<string, typeof projects>();
  for (const p of projects) {
    if (!p.photographer) continue;
    if (!byMember.has(p.photographer.id)) byMember.set(p.photographer.id, []);
    byMember.get(p.photographer.id)!.push(p);
  }

  const out: PayrollPerson[] = [];
  for (const [memberId, jobs] of byMember) {
    const m = jobs[0].photographer!;
    const home = m.homeLat != null && m.homeLng != null ? { lat: m.homeLat, lng: m.homeLng } : null;

    // Build job lines (apply per-job overrides; drop excluded).
    type Built = PayrollJob & { _at: number };
    const built: Built[] = [];
    const returnTripJobs: { title: string; original: string; returns: string[] }[] = [];
    for (const p of jobs) {
      const ov = p.payOverrides.find((o) => o.teamMemberId === memberId) ?? null;
      if (ov?.excluded) continue;

      // Pay date = earliest non-canceled appointment (the original shoot); later
      // appointments are return/reshoot trips and aren't separately paid.
      const apptDates = p.appointments.map((a) => a.startAt!).filter(Boolean);
      const payDate = apptDates[0] ?? p.shootDate;
      if (!payDate) continue;
      const t = payDate.getTime();
      if (t < start.getTime() || t > end.getTime()) continue; // belongs to another period

      // Note any later visit days (a return trip) for transparency / flagging.
      const payDayKey = etDayKey(payDate);
      const extraDays = Array.from(new Set(apptDates.map((d) => etDayKey(d)))).filter((k) => k > payDayKey);
      if (extraDays.length > 0) returnTripJobs.push({ title: p.title, original: payDayKey, returns: extraDays });

      // Invoice the % applies to: manual correction wins, else eligible invoice, else order total.
      const invoice = ov?.invoiceOverride != null ? ov.invoiceOverride : (p.payableInvoice ?? p.price ?? 0);
      const base = shootPay(invoice, m.payPercent, m.payFloor);
      const pay = ov?.flatAmount != null ? r2(ov.flatAmount) : base;
      built.push({
        projectId: p.id,
        title: p.title,
        shootISO: payDate.toISOString(),
        dayKey: payDayKey,
        invoice: r2(invoice),
        invoiceIsFallback: ov?.invoiceOverride == null && p.payableInvoice == null,
        invoiceOverridden: ov?.invoiceOverride != null,
        shootPay: pay,
        baseShootPay: base,
        mileageShare: 0,
        jobTotal: pay,
        hasCoords: p.lat != null && p.lng != null,
        override: ov ? { invoiceOverride: ov.invoiceOverride ?? null, flatAmount: ov.flatAmount ?? null, noMileage: ov.noMileage, excluded: ov.excluded, note: ov.note ?? null } : null,
        _at: payDate.getTime(),
      });
    }

    // Mileage by day.
    const freeMiles = (m.homeRadiusMi ?? 35) * 2;
    const days: PayrollDay[] = [];
    const dayKeys = Array.from(new Set(built.map((b) => b.dayKey))).filter((k) => k !== "unknown");
    for (const dayKey of dayKeys) {
      const dayJobs = built.filter((b) => b.dayKey === dayKey);
      // Jobs that take a mileage share (not flagged no-mileage, with coords for the route).
      const mileageJobs = dayJobs.filter((b) => !b.override?.noMileage);
      let miles = 0;
      if (home) {
        const stops: Stop[] = dayJobs.filter((b) => b.hasCoords).map((b) => {
          const p = jobs.find((j) => j.id === b.projectId)!;
          return { lat: p.lat!, lng: p.lng!, at: b._at };
        });
        miles = await dailyMiles(memberId, dayKey, home, stops);
      }
      const payableMiles = Math.max(miles - freeMiles, 0);
      const mileagePay = r2(payableMiles * (m.mileageRate ?? 0.65));
      const share = mileageJobs.length > 0 ? r2(mileagePay / mileageJobs.length) : 0;
      for (const b of mileageJobs) {
        b.mileageShare = share;
        b.jobTotal = r2(b.shootPay + share);
      }
      days.push({ dayKey, miles, freeMiles, payableMiles: r2(payableMiles), mileagePay, jobs: mileageJobs.length });
    }

    // ---- Discrepancy detection ------------------------------------------
    const issues: PayrollIssue[] = [];
    if (!(m.payPercent != null && m.payFloor != null)) {
      issues.push({ level: "warn", message: "Pay rates not set — shoot pay shows $0. Set them on the team page." });
    }
    if (m.payPercent != null && !home) {
      issues.push({ level: "warn", message: "No home address — mileage can't be calculated. Add it on the team page." });
    }
    // Shoots missing a map location can't be routed → understate the day's miles.
    const noCoords = built.filter((b) => !b.hasCoords);
    if (home && noCoords.length > 0) {
      issues.push({
        level: "warn",
        message: `${noCoords.length} shoot${noCoords.length === 1 ? "" : "s"} missing a map location — not counted in mileage (${noCoords[0].title.split(",")[0]}${noCoords.length > 1 ? ", …" : ""}).`,
        projectId: noCoords[0].projectId,
      });
    }
    // Implausible daily mileage usually means a shoot geocoded to the wrong place.
    for (const d of days) {
      if (d.miles > 350 || (d.jobs > 0 && d.miles / d.jobs > 200)) {
        issues.push({
          level: "warn",
          message: `Unusually high mileage on ${new Date(d.dayKey + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${d.miles.toFixed(0)} mi for ${d.jobs} shoot${d.jobs === 1 ? "" : "s"} — verify the locations.`,
        });
      }
    }
    // $0 eligible invoice → shoot pay fell to the floor (or $0).
    const zeroInvoice = built.filter((b) => b.invoice === 0 && !b.override);
    if (zeroInvoice.length > 0) {
      issues.push({
        level: "info",
        message: `${zeroInvoice.length} shoot${zeroInvoice.length === 1 ? "" : "s"} have a $0 eligible invoice (all add-ons virtual/AI, or pricing missing) — paid at the floor.`,
        projectId: zeroInvoice[0].projectId,
      });
    }
    // Return/reshoot trips: a later visit to a shoot already paid this period.
    // Pay stays on the original shoot; flag so it's clear the return isn't re-paid.
    for (const rt of returnTripJobs) {
      const days = rt.returns.map((k) => new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })).join(", ");
      issues.push({
        level: "info",
        message: `${rt.title.split(",")[0]}: return trip on ${days} — paid once on the original shoot, not re-paid.`,
      });
    }
    // Order total used because there's no itemized invoice to exclude add-ons from.
    const fallback = built.filter((b) => b.invoiceIsFallback);
    if (fallback.length > 0) {
      issues.push({
        level: "info",
        message: `${fallback.length} shoot${fallback.length === 1 ? "" : "s"} use the order total (no itemized invoice synced) — virtual/AI add-ons may not be excluded.`,
      });
    }

    const adj = (adjByMember.get(memberId) ?? []).map((a) => ({ id: a.id, label: a.label, amount: r2(a.amount), dateISO: a.date.toISOString() }));
    const shootPayTotal = r2(built.reduce((s, b) => s + b.shootPay, 0));
    const mileageTotal = r2(built.reduce((s, b) => s + b.mileageShare, 0));
    const adjustmentTotal = r2(adj.reduce((s, a) => s + a.amount, 0));
    const total = r2(shootPayTotal + mileageTotal + adjustmentTotal);

    out.push({
      member: { id: m.id, name: m.name, avatarColor: m.avatarColor },
      configured: m.payPercent != null && m.payFloor != null,
      hasHome: !!home,
      payPercent: m.payPercent ?? null,
      payFloor: m.payFloor ?? null,
      mileageRate: m.mileageRate ?? 0.65,
      homeRadiusMi: m.homeRadiusMi ?? 35,
      // strip the internal _at field
      jobs: built.map(({ _at, ...j }) => { void _at; return j; }).sort((a, b) => (a.shootISO ?? "").localeCompare(b.shootISO ?? "")),
      days: days.sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
      adjustments: adj,
      issues,
      shootPayTotal,
      mileageTotal,
      adjustmentTotal,
      total,
    });
  }

  return out.sort((a, b) => b.total - a.total);
}
