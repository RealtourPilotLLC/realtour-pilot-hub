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
// Payroll is APPOINTMENT-centric: each appointment is paid to whoever actually
// shot it (Appointment.assignedTo), not the project's single photographer. The
// earliest appointment is the primary shoot (full pay); a later appointment by a
// DIFFERENT photographer is a second/return trip, paid at that person's flat rate.
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
  // Signature of the day's route (home + the stop coords, order-independent). ANY
  // change — a shoot reassigned to or from this person — invalidates the cache.
  // Keying on the stop COUNT alone missed reassignments that kept the count equal.
  const sig = [
    `h:${home.lat.toFixed(5)},${home.lng.toFixed(5)}`,
    ...stops.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).sort(),
  ].join("|");
  const cached = await prisma.mileageDay.findUnique({
    where: { teamMemberId_dayKey: { teamMemberId: memberId, dayKey } },
  });
  if (cached && cached.sig === sig) return cached.miles;
  const miles = await routeMiles(home, stops);
  await prisma.mileageDay.upsert({
    where: { teamMemberId_dayKey: { teamMemberId: memberId, dayKey } },
    create: { teamMemberId: memberId, dayKey, miles, stops: stops.length, sig },
    update: { miles, stops: stops.length, sig, computedAt: new Date() },
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
  returnTrip: boolean; // a later/second trip by a different shooter — paid at their flat rate
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
  removedJobs: { projectId: string; title: string; shootISO: string | null }[]; // excluded — restorable
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
  // Candidate projects: any non-cancelled project with a shoot (appointment or
  // shootDate) in range. We do NOT pre-filter by the project's photographer —
  // the payee is decided per appointment below. When scoped to one member (the
  // /shoot pay card), limit to projects that member could be paid on.
  const memberScope = opts?.memberId
    ? [
        { photographerId: opts.memberId },
        { appointments: { some: { assignedToId: opts.memberId } } },
        { payOverrides: { some: { teamMemberId: opts.memberId, manualAdd: true } } },
      ]
    : null;
  const projects = await prisma.project.findMany({
    where: {
      status: { not: "CANCELLED" },
      AND: [
        {
          OR: [
            { appointments: { some: { startAt: { gte: start, lte: end }, status: { not: "CANCELED" } } } },
            { shootDate: { gte: start, lte: end } },
          ],
        },
        ...(memberScope ? [{ OR: memberScope }] : []),
      ],
    },
    select: {
      id: true, title: true, shootDate: true, lat: true, lng: true,
      price: true, payableInvoice: true, photographerId: true,
      appointments: {
        where: { status: { not: "CANCELED" }, startAt: { not: null } },
        select: { startAt: true, assignedToId: true },
        orderBy: { startAt: "asc" },
      },
      payOverrides: { select: { teamMemberId: true, invoiceOverride: true, flatAmount: true, noMileage: true, excluded: true, manualAdd: true, note: true } },
    },
    orderBy: { shootDate: "asc" },
  });

  // Manual adjustments in the period, grouped by member.
  const adjustments = await prisma.payoutAdjustment.findMany({
    where: { date: { gte: start, lte: end }, ...(opts?.memberId ? { teamMemberId: opts.memberId } : {}) },
    orderBy: { date: "asc" },
  });
  const adjByMember = new Map<string, typeof adjustments>();
  for (const a of adjustments) {
    if (!adjByMember.has(a.teamMemberId)) adjByMember.set(a.teamMemberId, []);
    adjByMember.get(a.teamMemberId)!.push(a);
  }

  // Load pay settings for everyone who could be paid (appt assignees, project
  // photographers, and anyone with a period adjustment).
  const memberIds = new Set<string>(adjByMember.keys());
  for (const p of projects) {
    if (p.photographerId) memberIds.add(p.photographerId);
    for (const a of p.appointments) if (a.assignedToId) memberIds.add(a.assignedToId);
    for (const o of p.payOverrides) if (o.manualAdd) memberIds.add(o.teamMemberId);
  }
  const memberRows = memberIds.size
    ? await prisma.teamMember.findMany({
        where: { id: { in: [...memberIds] } },
        select: {
          id: true, name: true, avatarColor: true,
          payPercent: true, payFloor: true, mileageRate: true, homeRadiusMi: true,
          homeLat: true, homeLng: true,
        },
      })
    : [];
  const memberMap = new Map(memberRows.map((m) => [m.id, m]));

  // Build pay lines — one per paid appointment, grouped by the member who shot it.
  type Built = PayrollJob & { _at: number };
  const linesByMember = new Map<string, Built[]>();
  const removedByMember = new Map<string, { projectId: string; title: string; shootISO: string | null }[]>();
  const coordsByProject = new Map<string, { lat: number; lng: number } | null>();
  const pushRemoved = (memberId: string, projectId: string, title: string, at: Date | null) => {
    if (!removedByMember.has(memberId)) removedByMember.set(memberId, []);
    removedByMember.get(memberId)!.push({ projectId, title, shootISO: at ? at.toISOString() : null });
  };

  for (const p of projects) {
    coordsByProject.set(p.id, p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null);

    // Timeline of who shot when. Fall back to the project photographer on the
    // shootDate when a project has no per-appointment records.
    const timeline: { at: Date; memberId: string | null }[] = p.appointments.length
      ? p.appointments.map((a) => ({ at: a.startAt!, memberId: a.assignedToId ?? p.photographerId }))
      : p.shootDate
        ? [{ at: p.shootDate, memberId: p.photographerId }]
        : [];
    if (timeline.length === 0) continue;

    const paidHere = new Set<string>(); // members already paid on this project
    timeline.forEach((slot, idx) => {
      const memberId = slot.memberId;
      if (!memberId) return;
      const isPrimary = idx === 0;
      // A later trip by an already-paid member is that person's own reshoot — not re-paid.
      if (!isPrimary && paidHere.has(memberId)) return;
      const at = slot.at;
      const inRange = at.getTime() >= start.getTime() && at.getTime() <= end.getTime();
      // A leg outside this period is paid in its own period; mark the shooter so a
      // same-person later leg here isn't treated as new.
      if (!inRange) { paidHere.add(memberId); return; }
      if (opts?.memberId && memberId !== opts.memberId) { paidHere.add(memberId); return; }

      const ov = p.payOverrides.find((o) => o.teamMemberId === memberId) ?? null;
      if (ov?.excluded) { pushRemoved(memberId, p.id, p.title, at); paidHere.add(memberId); return; }
      const m = memberMap.get(memberId);
      const returnTrip = !isPrimary; // a later trip by a different (not-yet-paid) shooter
      const invoice = ov?.invoiceOverride != null ? ov.invoiceOverride : (p.payableInvoice ?? p.price ?? 0);
      // Primary shoot = full pay (% of invoice or floor). Return leg = flat rate
      // (their floor). A manual flatAmount override always wins.
      const base = returnTrip ? r2(m?.payFloor ?? 0) : shootPay(invoice, m?.payPercent, m?.payFloor);
      const pay = ov?.flatAmount != null ? r2(ov.flatAmount) : base;
      const dayKey = etDayKey(at);
      const line: Built = {
        projectId: p.id,
        title: p.title,
        shootISO: at.toISOString(),
        dayKey,
        invoice: r2(returnTrip ? 0 : invoice), // return legs aren't a % of invoice
        invoiceIsFallback: !returnTrip && ov?.invoiceOverride == null && p.payableInvoice == null,
        invoiceOverridden: ov?.invoiceOverride != null,
        shootPay: pay,
        baseShootPay: base,
        mileageShare: 0,
        jobTotal: pay,
        hasCoords: p.lat != null && p.lng != null,
        returnTrip,
        override: ov ? { invoiceOverride: ov.invoiceOverride ?? null, flatAmount: ov.flatAmount ?? null, noMileage: ov.noMileage, excluded: ov.excluded, note: ov.note ?? null } : null,
        _at: at.getTime(),
      };
      if (!linesByMember.has(memberId)) linesByMember.set(memberId, []);
      linesByMember.get(memberId)!.push(line);
      paidHere.add(memberId);
    });

    // Manually-added shoots: pay this member for the job even though they aren't
    // the appointment shooter (e.g. a shoot the sync missed). Full pay by default,
    // attributed to the project's shoot day.
    const primaryAt = timeline[0]?.at ?? p.shootDate ?? null;
    for (const o of p.payOverrides) {
      if (!o.manualAdd || paidHere.has(o.teamMemberId)) continue;
      if (opts?.memberId && o.teamMemberId !== opts.memberId) continue;
      if (!primaryAt) continue;
      if (o.excluded) { pushRemoved(o.teamMemberId, p.id, p.title, primaryAt); paidHere.add(o.teamMemberId); continue; }
      if (primaryAt.getTime() < start.getTime() || primaryAt.getTime() > end.getTime()) continue;
      const m = memberMap.get(o.teamMemberId);
      const invoice = o.invoiceOverride != null ? o.invoiceOverride : (p.payableInvoice ?? p.price ?? 0);
      const base = shootPay(invoice, m?.payPercent, m?.payFloor);
      const pay = o.flatAmount != null ? r2(o.flatAmount) : base;
      const line: Built = {
        projectId: p.id, title: p.title, shootISO: primaryAt.toISOString(), dayKey: etDayKey(primaryAt),
        invoice: r2(invoice),
        invoiceIsFallback: o.invoiceOverride == null && p.payableInvoice == null,
        invoiceOverridden: o.invoiceOverride != null,
        shootPay: pay, baseShootPay: base, mileageShare: 0, jobTotal: pay,
        hasCoords: p.lat != null && p.lng != null, returnTrip: false,
        override: { invoiceOverride: o.invoiceOverride ?? null, flatAmount: o.flatAmount ?? null, noMileage: o.noMileage, excluded: o.excluded, note: o.note ?? null },
        _at: primaryAt.getTime(),
      };
      if (!linesByMember.has(o.teamMemberId)) linesByMember.set(o.teamMemberId, []);
      linesByMember.get(o.teamMemberId)!.push(line);
      paidHere.add(o.teamMemberId);
    }
  }

  // Everyone with lines, a period adjustment, OR a removed job gets a card.
  const outMemberIds = new Set<string>([...linesByMember.keys(), ...adjByMember.keys(), ...removedByMember.keys()]);
  if (opts?.memberId) for (const id of [...outMemberIds]) if (id !== opts.memberId) outMemberIds.delete(id);

  const out: PayrollPerson[] = [];
  for (const memberId of outMemberIds) {
    const m = memberMap.get(memberId);
    const built = linesByMember.get(memberId) ?? [];
    const home = m && m.homeLat != null && m.homeLng != null ? { lat: m.homeLat, lng: m.homeLng } : null;

    // Mileage by day (both the primary shoot and any return legs count).
    const freeMiles = (m?.homeRadiusMi ?? 35) * 2;
    const days: PayrollDay[] = [];
    const dayKeys = Array.from(new Set(built.map((b) => b.dayKey))).filter((k) => k !== "unknown");
    for (const dayKey of dayKeys) {
      const dayJobs = built.filter((b) => b.dayKey === dayKey);
      const mileageJobs = dayJobs.filter((b) => !b.override?.noMileage);
      let miles = 0;
      if (home) {
        const stops: Stop[] = dayJobs
          .filter((b) => b.hasCoords)
          .map((b) => { const c = coordsByProject.get(b.projectId)!; return { lat: c!.lat, lng: c!.lng, at: b._at }; });
        miles = await dailyMiles(memberId, dayKey, home, stops);
      }
      const payableMiles = Math.max(miles - freeMiles, 0);
      const mileagePay = r2(payableMiles * (m?.mileageRate ?? 0.65));
      const share = mileageJobs.length > 0 ? r2(mileagePay / mileageJobs.length) : 0;
      for (const b of mileageJobs) { b.mileageShare = share; b.jobTotal = r2(b.shootPay + share); }
      days.push({ dayKey, miles, freeMiles, payableMiles: r2(payableMiles), mileagePay, jobs: mileageJobs.length });
    }

    // ---- Discrepancy detection ------------------------------------------
    const issues: PayrollIssue[] = [];
    if (built.length > 0 && !(m?.payPercent != null && m?.payFloor != null)) {
      issues.push({ level: "warn", message: "Pay rates not set — shoot pay shows $0. Set them on the team page." });
    }
    if (built.length > 0 && m?.payPercent != null && !home) {
      issues.push({ level: "warn", message: "No home address — mileage can't be calculated. Add it on the team page." });
    }
    const noCoords = built.filter((b) => !b.hasCoords);
    if (home && noCoords.length > 0) {
      issues.push({
        level: "warn",
        message: `${noCoords.length} shoot${noCoords.length === 1 ? "" : "s"} missing a map location — not counted in mileage (${noCoords[0].title.split(",")[0]}${noCoords.length > 1 ? ", …" : ""}).`,
        projectId: noCoords[0].projectId,
      });
    }
    for (const d of days) {
      if (d.miles > 350 || (d.jobs > 0 && d.miles / d.jobs > 200)) {
        issues.push({
          level: "warn",
          message: `Unusually high mileage on ${new Date(d.dayKey + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${d.miles.toFixed(0)} mi for ${d.jobs} shoot${d.jobs === 1 ? "" : "s"} — verify the locations.`,
        });
      }
    }
    const zeroInvoice = built.filter((b) => !b.returnTrip && b.invoice === 0 && !b.override);
    if (zeroInvoice.length > 0) {
      issues.push({
        level: "info",
        message: `${zeroInvoice.length} shoot${zeroInvoice.length === 1 ? "" : "s"} have a $0 eligible invoice (all add-ons virtual/AI, or pricing missing) — paid at the floor.`,
        projectId: zeroInvoice[0].projectId,
      });
    }
    const returnLegs = built.filter((b) => b.returnTrip);
    if (returnLegs.length > 0) {
      issues.push({
        level: "info",
        message: `${returnLegs.length} return trip${returnLegs.length === 1 ? "" : "s"} paid at your flat rate — a later visit you shot after the first photographer (${returnLegs[0].title.split(",")[0]}${returnLegs.length > 1 ? ", …" : ""}).`,
        projectId: returnLegs[0].projectId,
      });
    }
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
      member: { id: memberId, name: m?.name ?? "Unknown", avatarColor: m?.avatarColor ?? "#8b93a3" },
      configured: m?.payPercent != null && m?.payFloor != null,
      hasHome: !!home,
      payPercent: m?.payPercent ?? null,
      payFloor: m?.payFloor ?? null,
      mileageRate: m?.mileageRate ?? 0.65,
      homeRadiusMi: m?.homeRadiusMi ?? 35,
      // strip the internal _at field
      jobs: built.map(({ _at, ...j }) => { void _at; return j; }).sort((a, b) => (a.shootISO ?? "").localeCompare(b.shootISO ?? "")),
      removedJobs: removedByMember.get(memberId) ?? [],
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
