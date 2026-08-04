import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etDayStartUtc } from "@/lib/datetime";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { canonicalPackage } from "@/lib/packageNames";
import type { DeliverableType } from "@prisma/client";

// ---------------------------------------------------------------------------
// Trends — the leading indicators, not the lagging ones.
//
// EVERYTHING here keys on Project.orderedAt (the real Aryeo order date), never
// createdAt (import time) and never shootDate. "How busy are we?" answered by
// shoot dates tells you about work already won; answered by ORDER dates it tells
// you what is coming — which is what the owner actually feels first when things
// slow down. Coverage is 100% (1,467/1,467 projects carry orderedAt), so no
// fallback is needed.
//
// Cancelled orders are counted as bookings by default: the order WAS placed, and
// hiding cancellations would flatter a bad month. They are reported separately
// so a spike in cancels is visible rather than silently netted out.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

// Use the hub's canonical ET helpers — they already handle the DST edge (the
// flip happens at 2am, so an offset sampled at the wrong instant is an hour
// out). A hand-rolled version here was machine-timezone-dependent and gave
// different window boundaries locally than on Vercel.
const etKey = (d: Date) => etDayKey(d);
const etMonth = (d: Date) => etKey(d).slice(0, 7);
const etTodayStart = () => etDayStartUtc();

export type TrendWindow = {
  key: string;
  label: string;
  count: number;
  revenue: number;
  avgTicket: number;
  prevCount: number;
  prevRevenue: number;
  countChangePct: number | null; // vs the immediately preceding equal-length window
  revenueChangePct: number | null;
  yoyCount: number | null; // same window one year earlier (null when out of data range)
  yoyChangePct: number | null;
  cancelled: number;
};

export type TrendPoint = { key: string; label: string; count: number; revenue: number };

export type MonthProjection = {
  monthLabel: string;
  daysElapsed: number;
  daysInMonth: number;
  mtdCount: number;
  mtdRevenue: number;
  projectedCount: number;
  projectedRevenue: number;
  lastMonthCount: number; // full previous month
  lastMonthRevenue: number;
  lastMonthSamePoint: number; // same number of days into the previous month
  paceVsLastMonthPct: number | null; // MTD vs that same point — the fair read
  yoyMonthCount: number | null; // same calendar month last year, full
};

export type BookingTrends = {
  windows: TrendWindow[];
  daily: TrendPoint[]; // last 90 ET days
  monthly: TrendPoint[]; // last 24 ET months
  leadTimeDays: { median: number | null; p75: number | null; p90: number | null };
  busiestDow: { dow: string; count: number }[];
  avgPerWeek: { last4: number; last12: number; last52: number };
  projection: MonthProjection;
};

type Row = { orderedAt: Date | null; price: number | null; payableInvoice: number | null; status: string; shootDate: Date | null };

const val = (r: Row) => r.payableInvoice ?? r.price ?? 0;

function summarize(rows: Row[], from: Date, to: Date) {
  const inWin = rows.filter((r) => r.orderedAt && r.orderedAt >= from && r.orderedAt < to);
  const revenue = inWin.reduce((s, r) => s + val(r), 0);
  return {
    count: inWin.length,
    revenue,
    cancelled: inWin.filter((r) => r.status === "CANCELLED").length,
    avgTicket: inWin.length ? revenue / inWin.length : 0,
  };
}

const pct = (now: number, prev: number): number | null => (prev === 0 ? null : ((now - prev) / prev) * 100);

export async function bookingTrends(): Promise<BookingTrends> {
  // Two years back covers every window plus the year-ago comparisons.
  const since = new Date(Date.now() - 800 * DAY);
  const rows = (await prisma.project.findMany({
    where: { orderedAt: { gte: since } },
    select: { orderedAt: true, price: true, payableInvoice: true, status: true, shootDate: true },
    orderBy: { orderedAt: "asc" },
  })) as Row[];

  const todayStart = etTodayStart();
  const tomorrow = new Date(todayStart.getTime() + DAY);

  const spans: { key: string; label: string; days: number }[] = [
    { key: "today", label: "Booked today", days: 1 },
    { key: "7d", label: "Past 7 days", days: 7 },
    { key: "30d", label: "Past 30 days", days: 30 },
    { key: "365d", label: "Past year", days: 365 },
  ];

  const windows: TrendWindow[] = spans.map((s) => {
    // "Today" runs to the end of today; longer windows are trailing and also
    // include today, so a booking made this morning shows up in every card.
    const to = tomorrow;
    const from = new Date(tomorrow.getTime() - s.days * DAY);
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - s.days * DAY);
    const cur = summarize(rows, from, to);
    const prev = summarize(rows, prevFrom, prevTo);
    // Year-over-year on a SINGLE day is noise (last year's Tuesday tells you
    // nothing), so it is only computed for the 7-day window and longer.
    const yoyFrom = new Date(from.getTime() - 365 * DAY);
    const yoyTo = new Date(to.getTime() - 365 * DAY);
    const yoy = s.days >= 7 && yoyFrom >= since ? summarize(rows, yoyFrom, yoyTo) : null;
    return {
      key: s.key,
      label: s.label,
      count: cur.count,
      revenue: cur.revenue,
      avgTicket: cur.avgTicket,
      prevCount: prev.count,
      prevRevenue: prev.revenue,
      countChangePct: pct(cur.count, prev.count),
      revenueChangePct: pct(cur.revenue, prev.revenue),
      yoyCount: yoy ? yoy.count : null,
      yoyChangePct: yoy ? pct(cur.count, yoy.count) : null,
      cancelled: cur.cancelled,
    };
  });

  // Every row's ET day key, computed ONCE. etDayKey goes through Intl, which
  // costs tens of microseconds a call — the daily loop below used to re-derive
  // the key for all ~1,300 rows on each of 90 days (115,000 Intl calls) and that
  // alone was ~2.9 of the 3 seconds this function took. The query itself is
  // 0.11s. Bucketing up front makes the whole thing linear.
  const dayOf = new Map<string, { count: number; revenue: number }>();
  for (const r of rows) {
    if (!r.orderedAt) continue;
    const k = etKey(r.orderedAt);
    const e = dayOf.get(k) ?? { count: 0, revenue: 0 };
    e.count++;
    e.revenue += val(r);
    dayOf.set(k, e);
  }

  // Daily series — last 90 ET days, zero-filled so gaps read as real zeros.
  const daily: TrendPoint[] = [];
  for (let i = 89; i >= 0; i--) {
    const day = new Date(todayStart.getTime() - i * DAY);
    const k = etKey(day);
    const hit = dayOf.get(k);
    daily.push({
      key: k,
      label: new Date(`${k}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      count: hit?.count ?? 0,
      revenue: hit?.revenue ?? 0,
    });
  }

  // Monthly series — last 24 ET months.
  const byMonth = new Map<string, { count: number; revenue: number }>();
  for (const r of rows) {
    if (!r.orderedAt) continue;
    const k = etMonth(r.orderedAt);
    const e = byMonth.get(k) ?? { count: 0, revenue: 0 };
    e.count++; e.revenue += val(r); byMonth.set(k, e);
  }
  const monthly: TrendPoint[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-24)
    .map(([k, v]) => ({
      key: k,
      label: new Date(`${k}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      count: v.count,
      revenue: v.revenue,
    }));

  // Lead time: how far ahead people book (orderedAt → shootDate), last 180 days.
  const recent = rows.filter(
    (r) => r.orderedAt && r.shootDate && r.orderedAt >= new Date(Date.now() - 180 * DAY) && r.shootDate >= r.orderedAt,
  );
  const leads = recent.map((r) => (r.shootDate!.getTime() - r.orderedAt!.getTime()) / DAY).sort((a, b) => a - b);
  const at = (p: number) => (leads.length ? Math.round(leads[Math.floor(leads.length * p)] * 10) / 10 : null);

  // Which weekday orders actually land on (last 365 days).
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowCount = new Array(7).fill(0);
  for (const r of rows) {
    if (!r.orderedAt || r.orderedAt < new Date(Date.now() - 365 * DAY)) continue;
    // Derive the weekday from the ET DAY KEY (not a locale-parsed Date, which
    // would be read in the server's own timezone).
    const [y, mo, da] = etKey(r.orderedAt).split("-").map(Number);
    dowCount[new Date(Date.UTC(y, mo - 1, da)).getUTCDay()]++;
  }

  // Average bookings per week over three horizons. Whole weeks ending today, so
  // a part-week never drags the average down.
  const avgWeeks = (weeks: number) => {
    const from = new Date(tomorrow.getTime() - weeks * 7 * DAY);
    const n = rows.filter((r) => r.orderedAt && r.orderedAt >= from && r.orderedAt < tomorrow).length;
    return Math.round((n / weeks) * 10) / 10;
  };

  // THIS MONTH'S PROJECTION. Run-rate on elapsed ET days, which is simple and
  // explainable — but a run rate early in a month is jumpy, so the honest
  // comparison shipped alongside it is MTD vs the SAME POINT last month.
  const todayKey = etKey(todayStart);
  const [yy, mm, dd] = todayKey.split("-").map(Number);
  const monthStart = etDayStartUtc(new Date(Date.UTC(yy, mm - 1, 1, 12)));
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const daysElapsed = dd;
  const mtd = summarize(rows, monthStart, tomorrow);

  const prevY = mm === 1 ? yy - 1 : yy;
  const prevM = mm === 1 ? 12 : mm - 1;
  const prevMonthStart = etDayStartUtc(new Date(Date.UTC(prevY, prevM - 1, 1, 12)));
  const prevMonthDays = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const prevMonthEnd = etDayStartUtc(new Date(Date.UTC(prevY, prevM - 1, prevMonthDays, 12)));
  const prevFull = summarize(rows, prevMonthStart, new Date(prevMonthEnd.getTime() + DAY));
  // Same number of days into the previous month (clamped to its length).
  const samePointDay = Math.min(daysElapsed, prevMonthDays);
  const prevSamePointEnd = etDayStartUtc(new Date(Date.UTC(prevY, prevM - 1, samePointDay, 12)));
  const prevSamePoint = summarize(rows, prevMonthStart, new Date(prevSamePointEnd.getTime() + DAY));

  const yoyStart = etDayStartUtc(new Date(Date.UTC(yy - 1, mm - 1, 1, 12)));
  const yoyDays = new Date(Date.UTC(yy - 1, mm, 0)).getUTCDate();
  const yoyEnd = etDayStartUtc(new Date(Date.UTC(yy - 1, mm - 1, yoyDays, 12)));
  const yoyFull = yoyStart >= since ? summarize(rows, yoyStart, new Date(yoyEnd.getTime() + DAY)) : null;

  const rate = daysElapsed > 0 ? mtd.count / daysElapsed : 0;
  const revRate = daysElapsed > 0 ? mtd.revenue / daysElapsed : 0;

  return {
    windows,
    daily,
    monthly,
    leadTimeDays: { median: at(0.5), p75: at(0.75), p90: at(0.9) },
    busiestDow: DOW.map((d, i) => ({ dow: d, count: dowCount[i] })),
    avgPerWeek: { last4: avgWeeks(4), last12: avgWeeks(12), last52: avgWeeks(52) },
    projection: {
      monthLabel: new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      daysElapsed,
      daysInMonth,
      mtdCount: mtd.count,
      mtdRevenue: mtd.revenue,
      projectedCount: Math.round(rate * daysInMonth),
      projectedRevenue: Math.round(revRate * daysInMonth),
      lastMonthCount: prevFull.count,
      lastMonthRevenue: prevFull.revenue,
      lastMonthSamePoint: prevSamePoint.count,
      paceVsLastMonthPct: pct(mtd.count, prevSamePoint.count),
      yoyMonthCount: yoyFull ? yoyFull.count : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Services — what people actually order, ranked, with momentum.
// ---------------------------------------------------------------------------

export type ServiceRow = {
  type: string;
  label: string;
  orders: number; // projects containing at least one of this service
  units: number; // sum of quantity
  attachPct: number; // % of orders that include it
  last90: number;
  prev90: number;
  changePct: number | null;
  revenue: number; // attributed share of order value (see note)
};

// A package is what the client actually bought and what Jordan thinks in —
// "Premium Social Reel" vs "Social Reel" are different products at different
// prices that the coarse DeliverableType enum collapses into one line.
export type PackageRow = {
  label: string;
  type: string;
  orders: number;
  units: number;
  attachPct: number;
  last90: number;
  prev90: number;
  changePct: number | null;
  revenue: number; // EXACT when from OrderItem; estimated only on the fallback path
  estPrice: number | null; // typical price per order for this package
  exact: boolean; // true = real Aryeo line-item money, not an attribution guess
};

// ---------------------------------------------------------------------------
// Revenue by package — an ESTIMATE, and worth understanding before trusting.
//
// Aryeo prices ORDER ITEMS, but we only store the deliverables an item expands
// into, not the item's dollars. So an order's value has to be shared out across
// the packages on it. Splitting evenly would be badly wrong: a $50 "Travel" fee
// would book the same revenue as $250 of Photos on the same order.
//
// Instead we LEARN each package's standalone price from orders where it was the
// ONLY package bought (287 such orders since 2025 — Photos $250, Premium Social
// Reel $1,000, Social Reel $450 …), then split each multi-package order in
// proportion to those learned prices. Packages we never saw sold alone fall back
// to the median learned price, so they get a fair-but-generic share.
//
// Good enough to rank products and spot which ones carry the business. NOT
// accounting — the exact figure needs per-item amounts stored at sync time.
// ---------------------------------------------------------------------------
function learnPackagePrices(
  projects: { price: number | null; payableInvoice: number | null; deliverables: { label: string | null }[] }[],
): Map<string, number> {
  const solo = new Map<string, number[]>();
  for (const p of projects) {
    const labels = [...new Set(p.deliverables.map((d) => (d.label ?? "").trim()).filter(Boolean))];
    const v = p.payableInvoice ?? p.price ?? 0;
    if (labels.length === 1 && v > 0) {
      const arr = solo.get(labels[0]) ?? [];
      arr.push(v);
      solo.set(labels[0], arr);
    }
  }
  const out = new Map<string, number>();
  for (const [label, vals] of solo) {
    // Three or more observations before we trust a learned price.
    if (vals.length < 3) continue;
    const s = vals.sort((a, b) => a - b);
    out.set(label, s[Math.floor(s.length / 2)]);
  }
  return out;
}

// Packages straight from the Aryeo line items — real product names, real money.
// This is the truth; the deliverable-label path below is only a fallback for
// orders that predate the OrderItem backfill.
async function packagesFromOrderItems(yearStart: Date, totalYtdOrders: number): Promise<PackageRow[]> {
  const cut90 = new Date(Date.now() - 90 * DAY);
  const cut180 = new Date(Date.now() - 180 * DAY);
  const items = await prisma.orderItem.findMany({
    where: { isCanceled: false, project: { orderedAt: { gte: new Date(Date.now() - 800 * DAY) } } },
    select: { title: true, quantity: true, amount: true, projectId: true, project: { select: { orderedAt: true } } },
  });

  const acc = new Map<string, { orders: Set<string>; units: number; revenue: number; last90: number; prev90: number }>();
  for (const it of items) {
    const when = it.project?.orderedAt;
    // One product, many hand-typed spellings — group on the canonical name or
    // the monthly-session products fragment into six near-identical rows.
    const label = canonicalPackage(it.title);
    const e = acc.get(label) ?? { orders: new Set<string>(), units: 0, revenue: 0, last90: 0, prev90: 0 };
    if (when && when >= yearStart) {
      e.orders.add(it.projectId);
      e.units += it.quantity || 1;
      e.revenue += it.amount || 0;
    }
    if (when && when >= cut90) e.last90++;
    else if (when && when >= cut180) e.prev90++;
    acc.set(label, e);
  }

  return [...acc.entries()]
    .filter(([, v]) => v.orders.size > 0)
    .map(([label, v]) => ({
      label,
      type: "",
      orders: v.orders.size,
      units: v.units,
      attachPct: totalYtdOrders ? (v.orders.size / totalYtdOrders) * 100 : 0,
      last90: v.last90,
      prev90: v.prev90,
      changePct: pct(v.last90, v.prev90),
      revenue: v.revenue,
      estPrice: v.orders.size ? v.revenue / v.orders.size : null,
      exact: true,
    }))
    .sort((a, b) => b.orders - a.orders);
}

export async function serviceTrends(): Promise<{
  services: ServiceRow[];
  packages: PackageRow[];
  packageTail: { count: number; orders: number };
  totalOrders: number;
  exactRevenue: boolean;
}> {
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const projects = await prisma.project.findMany({
    where: { orderedAt: { gte: new Date(Date.now() - 800 * DAY) } },
    select: {
      id: true, orderedAt: true, price: true, payableInvoice: true,
      deliverables: { select: { type: true, label: true, quantity: true } },
    },
  });

  const cut90 = new Date(Date.now() - 90 * DAY);
  const cut180 = new Date(Date.now() - 180 * DAY);
  const ytd = projects.filter((p) => p.orderedAt && p.orderedAt >= yearStart);

  const acc = new Map<string, { orders: number; units: number; last90: number; prev90: number; revenue: number }>();
  // Same shape keyed on the PACKAGE NAME the client actually bought.
  const pkg = new Map<string, { type: string; orders: number; units: number; last90: number; prev90: number; revenue: number }>();

  const learned = learnPackagePrices(projects);
  const learnedVals = [...learned.values()].sort((a, b) => a - b);
  const fallbackPrice = learnedVals.length ? learnedVals[Math.floor(learnedVals.length / 2)] : 1;

  for (const p of projects) {
    const ytdRow = p.orderedAt && p.orderedAt >= yearStart;
    const types = [...new Set(p.deliverables.map((d) => d.type))];
    // Revenue attribution: split the order's value evenly across the DISTINCT
    // services on it. Deliverables carry no price of their own, so this is an
    // approximation — good for ranking, not for accounting.
    const share = types.length > 0 ? (p.payableInvoice ?? p.price ?? 0) / types.length : 0;

    const labels = [...new Set(p.deliverables.map((d) => (d.label ?? "").trim()).filter(Boolean))];
    // Share this order's value across its packages in proportion to what each
    // one sells for on its own.
    const orderValue = p.payableInvoice ?? p.price ?? 0;
    const weights = labels.map((l) => learned.get(l) ?? fallbackPrice);
    const weightSum = weights.reduce((s, w) => s + w, 0) || 1;

    labels.forEach((l, i) => {
      const e = pkg.get(l) ?? { type: p.deliverables.find((d) => (d.label ?? "").trim() === l)?.type ?? "", orders: 0, units: 0, last90: 0, prev90: 0, revenue: 0 };
      if (ytdRow) {
        e.orders++;
        e.units += p.deliverables.filter((d) => (d.label ?? "").trim() === l).reduce((s, d) => s + (d.quantity || 1), 0);
        e.revenue += orderValue * (weights[i] / weightSum);
      }
      if (p.orderedAt && p.orderedAt >= cut90) e.last90++;
      else if (p.orderedAt && p.orderedAt >= cut180) e.prev90++;
      pkg.set(l, e);
    });
    for (const t of types) {
      const e = acc.get(t) ?? { orders: 0, units: 0, last90: 0, prev90: 0, revenue: 0 };
      if (ytdRow) {
        e.orders++;
        e.units += p.deliverables.filter((d) => d.type === t).reduce((s, d) => s + (d.quantity || 1), 0);
        e.revenue += share;
      }
      if (p.orderedAt && p.orderedAt >= cut90) e.last90++;
      else if (p.orderedAt && p.orderedAt >= cut180) e.prev90++;
      acc.set(t, e);
    }
  }

  const services: ServiceRow[] = [...acc.entries()]
    .filter(([, v]) => v.orders > 0 || v.last90 > 0)
    .map(([type, v]) => ({
      type,
      label: DELIVERABLE_META[type as DeliverableType]?.label ?? type,
      orders: v.orders,
      units: v.units,
      attachPct: ytd.length ? (v.orders / ytd.length) * 100 : 0,
      last90: v.last90,
      prev90: v.prev90,
      changePct: pct(v.last90, v.prev90),
      revenue: v.revenue,
    }))
    .sort((a, b) => b.orders - a.orders);

  // PREFER the real Aryeo line items. They carry the product name as sold
  // ("Standard Reel with Agent Intro", "GOLD BUNDLE …") and the actual money,
  // so no attribution guessing is needed at all. Fall back to the derived
  // deliverable labels only if the OrderItem backfill hasn't run.
  // COVERAGE GATE: only trust the line-item view once it actually covers the
  // year. A half-finished backfill would otherwise report real-looking revenue
  // that is quietly missing half the orders — worse than an honest estimate.
  const ytdWithItems = await prisma.project.count({
    where: { orderedAt: { gte: yearStart }, orderItems: { some: {} } },
  });
  const coverage = ytd.length ? ytdWithItems / ytd.length : 0;
  const fromItems = coverage >= 0.9 ? await packagesFromOrderItems(yearStart, ytd.length) : [];
  if (fromItems.length > 0) {
    const keep = fromItems.filter((p) => p.orders >= 2);
    const tail = fromItems.filter((p) => p.orders < 2);
    return {
      services,
      packages: keep,
      packageTail: { count: tail.length, orders: tail.reduce((s, p) => s + p.orders, 0) },
      totalOrders: ytd.length,
      exactRevenue: true,
    };
  }

  // ---- fallback: derived labels + estimated revenue (pre-backfill only) ----
  const allPackages = [...pkg.entries()]
    .filter(([, v]) => v.orders > 0)
    .map(([label, v]) => ({
      label,
      type: v.type,
      orders: v.orders,
      units: v.units,
      attachPct: ytd.length ? (v.orders / ytd.length) * 100 : 0,
      last90: v.last90,
      prev90: v.prev90,
      changePct: pct(v.last90, v.prev90),
      revenue: v.revenue,
      estPrice: learned.get(label) ?? null,
      exact: false,
    }))
    .sort((a, b) => b.orders - a.orders);
  const packages = allPackages.filter((p) => p.orders >= 2);
  const tail = allPackages.filter((p) => p.orders < 2);

  return {
    services,
    packages,
    packageTail: { count: tail.length, orders: tail.reduce((s, p) => s + p.orders, 0) },
    totalOrders: ytd.length,
    exactRevenue: false,
  };
}

// ---------------------------------------------------------------------------
// Top spenders — and, more usefully, which of them are going quiet.
// ---------------------------------------------------------------------------

export type SpenderRow = {
  clientId: string;
  name: string;
  company: string | null;
  segment: string | null;
  ytdRevenue: number;
  ytdJobs: number;
  lifetimeRevenue: number;
  lifetimeJobs: number; // every order ever — a rhythm needs more than one
  trailing365Revenue: number; // actual dollars in the last 12 months
  tenureDays: number; // days since their first order
  avgTicket: number;
  last90: number;
  prev90: number;
  changePct: number | null;
  daysSinceLastOrder: number | null;
  medianGapDays: number | null;
  overdue: boolean; // past 1.5x their own normal booking gap = going quiet
};

export type QuietClients = {
  rows: SpenderRow[]; // every regular who has gone quiet, biggest spender first
  count: number;
  ytdRevenue: number; // what they have already spent this year
  lifetimeRevenue: number; // what they have spent with us ever
  annualValue: number; // actual dollars over the last 12 months, annualised for newer clients
};

/**
 * Everyone flagged `overdue`, computed across the WHOLE client base — not the
 * top-N slice — so the money attached to it is the real figure. A single order
 * is not a rhythm, so a client needs at least three before their silence counts
 * as "gone quiet"; without that floor a first-time buyer trips the flag two
 * weeks later and inflates the total.
 */
function summarizeQuiet(all: SpenderRow[]): QuietClients {
  const rows = all
    .filter((r) => r.overdue && r.lifetimeJobs >= 3 && r.ytdJobs > 0)
    .sort((a, b) => b.ytdRevenue - a.ytdRevenue);
  return {
    rows,
    count: rows.length,
    ytdRevenue: rows.reduce((s, r) => s + r.ytdRevenue, 0),
    lifetimeRevenue: rows.reduce((s, r) => s + r.lifetimeRevenue, 0),
    // What these relationships are worth in a year, measured in MONEY THEY
    // ACTUALLY PAID over the last twelve months — not modelled from cadence.
    //
    // The first version projected (365 ÷ median gap) × average ticket, and it
    // was badly wrong in a way that flattered the number: median gap is a biased
    // estimator when ordering is bursty, and this book is very bursty (an agent
    // lists three properties in one sitting). One same-day duplicate order could
    // swing a single client's contribution 12-fold, and the total came out ~2.2×
    // what those same clients had actually paid in a year. A projection that
    // exceeds every dollar the client has ever spent is not a projection.
    //
    // Clients newer than a year are annualised over their own tenure, floored at
    // 90 days so a three-week-old account cannot be multiplied by 12.
    annualValue: rows.reduce(
      // Clamped to [90, 365]: past a year the trailing figure already IS the
      // annual number (never scale it down), and under 90 days we refuse to
      // multiply a brand-new account up by 12.
      (s, r) => s + r.trailing365Revenue * (365 / Math.min(Math.max(r.tenureDays, 90), 365)),
      0,
    ),
  };
}

export async function topSpenders(limit = 20): Promise<{
  rows: SpenderRow[];
  quiet: QuietClients;
  concentrationTop5: number;
  concentrationTop10: number;
  ytdTotal: number;
}> {
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const projects = await prisma.project.findMany({
    where: { orderedAt: { not: null }, clientId: { not: undefined } },
    select: {
      clientId: true, orderedAt: true, price: true, payableInvoice: true,
      client: { select: { id: true, name: true, company: true, segment: true } },
    },
    orderBy: { orderedAt: "asc" },
  });

  const cut90 = new Date(Date.now() - 90 * DAY);
  const cut180 = new Date(Date.now() - 180 * DAY);
  const cut365 = new Date(Date.now() - 365 * DAY);
  const byClient = new Map<string, {
    name: string; company: string | null; segment: string | null;
    ytd: number; ytdJobs: number; lifetime: number; trailing365: number; last90: number; prev90: number; dates: Date[];
  }>();

  for (const p of projects) {
    if (!p.client || !p.orderedAt) continue;
    const e = byClient.get(p.client.id) ?? {
      name: p.client.name, company: p.client.company, segment: p.client.segment,
      ytd: 0, ytdJobs: 0, lifetime: 0, trailing365: 0, last90: 0, prev90: 0, dates: [],
    };
    const v = p.payableInvoice ?? p.price ?? 0;
    e.lifetime += v;
    e.dates.push(p.orderedAt);
    if (p.orderedAt >= yearStart) { e.ytd += v; e.ytdJobs++; }
    if (p.orderedAt >= cut365) e.trailing365 += v;
    if (p.orderedAt >= cut90) e.last90 += v;
    else if (p.orderedAt >= cut180) e.prev90 += v;
    byClient.set(p.client.id, e);
  }

  const now = Date.now();
  const all: SpenderRow[] = [...byClient.entries()].map(([clientId, e]) => {
    const sorted = e.dates.sort((a, b) => a.getTime() - b.getTime());
    // BOOKING EVENTS, not orders. Agents list several properties in one sitting,
    // so a single phone call can produce three orders seconds apart. Counting
    // those as three separate "bookings" injects near-zero gaps that drag the
    // median into the burst regime and make an occasional client look like a
    // daily one — 14% of all gaps in this book are under a day, and 40% of
    // repeat clients have at least one same-day pair. Collapse to one event per
    // ET day before measuring rhythm.
    const eventKeys = [...new Set(sorted.map((d) => etKey(d)))];
    const events = eventKeys.map((k) => new Date(`${k}T12:00:00Z`));
    const gaps: number[] = [];
    for (let i = 1; i < events.length; i++) gaps.push((events[i].getTime() - events[i - 1].getTime()) / DAY);
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    const last = sorted[sorted.length - 1];
    const daysSince = last ? Math.floor((now - last.getTime()) / DAY) : null;
    const first = sorted[0];
    const tenureDays = first ? (now - first.getTime()) / DAY : 0;
    return {
      clientId,
      name: e.name,
      company: e.company,
      segment: e.segment,
      ytdRevenue: e.ytd,
      ytdJobs: e.ytdJobs,
      lifetimeRevenue: e.lifetime,
      lifetimeJobs: sorted.length,
      trailing365Revenue: e.trailing365,
      tenureDays: Math.round(tenureDays),
      avgTicket: e.ytdJobs ? e.ytd / e.ytdJobs : 0,
      last90: e.last90,
      prev90: e.prev90,
      changePct: pct(e.last90, e.prev90),
      daysSinceLastOrder: daysSince,
      medianGapDays: medianGap != null ? Math.round(medianGap) : null,
      // "Going quiet" = past DOUBLE their OWN normal rhythm, with a 14-day floor.
      // The test is relative because a client who books weekly and hasn't in a
      // month matters more than a once-a-quarter client who is 3 weeks out. The
      // floor stops very frequent bookers tripping the flag over a single quiet
      // week — without it, a client up 66% on the quarter was being flagged.
      overdue: !!(
        medianGap && daysSince != null && e.ytd > 0 &&
        daysSince > Math.max(medianGap * 2, 14)
      ),
    };
  });

  const ranked = all.sort((a, b) => b.ytdRevenue - a.ytdRevenue);
  const ytdTotal = ranked.reduce((s, r) => s + r.ytdRevenue, 0);
  const sum = (n: number) => ranked.slice(0, n).reduce((s, r) => s + r.ytdRevenue, 0);
  return {
    rows: ranked.slice(0, limit),
    // Computed over EVERY client, not the returned slice — the going-quiet
    // total has to count the regular who spends $4k a year, not just the ones
    // big enough to make the top-20 table.
    quiet: summarizeQuiet(ranked),
    concentrationTop5: ytdTotal ? (sum(5) / ytdTotal) * 100 : 0,
    concentrationTop10: ytdTotal ? (sum(10) / ytdTotal) * 100 : 0,
    ytdTotal,
  };
}
