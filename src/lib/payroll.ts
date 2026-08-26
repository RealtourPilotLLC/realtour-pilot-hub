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

// Statuses proving the shoot produced work (post-shoot pipeline stages). Aryeo
// retro-cancels an order's appointment rows when it's canceled AFTER the shoot
// (and delivered projects are deliberately never auto-cancelled), so all-rows-
// canceled on one of these jobs still means the visit happened and must pay.
// Mirrored in shootEarnings (src/lib/shoot.ts).
const SHOOT_HAPPENED_STATUSES = new Set(["SHOT", "EDITING", "REVIEW", "REVISION", "DELIVERED"]);

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

export type DayMiles = {
  miles: number; // the EFFECTIVE figure pay is computed from (override ?? computed)
  computedMiles: number; // what the router said (kept for reference under an override)
  overrideMiles: number | null; // owner correction, when set
  overrideNote: string | null;
};

// Cached daily miles (recomputes if the day's stop count changed). An owner
// override (MileageDay.overrideMiles) always wins over the computed figure;
// the computed value is still maintained alongside it so the payout UI can
// show "adjusted from X". With no home on file there's nothing to route, but
// an override still applies (e.g. a member whose address won't geocode).
async function dailyMiles(
  memberId: string,
  dayKey: string,
  home: { lat: number; lng: number } | null,
  stops: Stop[],
): Promise<DayMiles> {
  const cached = await prisma.mileageDay.findUnique({
    where: { teamMemberId_dayKey: { teamMemberId: memberId, dayKey } },
  });
  const withOverride = (computed: number): DayMiles => ({
    miles: cached?.overrideMiles ?? computed,
    computedMiles: computed,
    overrideMiles: cached?.overrideMiles ?? null,
    overrideNote: cached?.overrideNote ?? null,
  });
  if (!home) return withOverride(0);
  // Signature of the day's route (home + the stop coords, order-independent). ANY
  // change — a shoot reassigned to or from this person — invalidates the cache.
  // Keying on the stop COUNT alone missed reassignments that kept the count equal.
  const sig = [
    `h:${home.lat.toFixed(5)},${home.lng.toFixed(5)}`,
    ...stops.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).sort(),
  ].join("|");
  if (cached && cached.sig === sig) return withOverride(cached.miles);
  const miles = await routeMiles(home, stops);
  // The upsert never touches the override columns — a recompute (route change,
  // cache clear) must not eat an owner correction.
  await prisma.mileageDay.upsert({
    where: { teamMemberId_dayKey: { teamMemberId: memberId, dayKey } },
    create: { teamMemberId: memberId, dayKey, miles, stops: stops.length, sig },
    update: { miles, stops: stops.length, sig, computedAt: new Date() },
  });
  return withOverride(miles);
}

export type PayrollJob = {
  projectId: string;
  title: string;
  clientName: string | null; // the agent the shoot was for
  shootISO: string | null;
  dayKey: string;
  invoice: number; // eligible services invoice the % is applied to
  invoiceIsFallback: boolean; // true when we fell back to order total (no payableInvoice)
  invoiceOverridden: boolean; // true when the invoice was manually corrected
  invoiceOverTotal?: boolean; // pay basis exceeds the discounted order total — review
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
  miles: number; // effective (override ?? computed) — what pay is based on
  computedMiles: number; // the router's figure, for the "adjusted from" display
  overrideMiles: number | null; // owner correction, when set
  overrideNote: string | null;
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
      price: true, payableInvoice: true, photographerId: true, photographerManual: true,
      // The agent the shoot was for — shown beside the invoice on pay surfaces
      // so a row is reviewable without opening the job (Jordan, Aug 25).
      client: { select: { name: true } },
      // status: whether a post-shoot stage proves the shoot happened (see the
      // timeline fallback below).
      status: true,
      // ALL appointment rows regardless of status — distinguishes "never synced
      // any appointments" (shootDate fallback is legit) from "every appointment
      // was canceled" (the shoot never happened; the stale shootDate must not pay).
      _count: { select: { appointments: true } },
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
  // photographers, and anyone with a period adjustment). Every override holder
  // too — a reassigned shoot can leave an override keyed to a member with no pay
  // line, and the orphaned-override warning needs their name.
  const memberIds = new Set<string>(adjByMember.keys());
  for (const p of projects) {
    if (p.photographerId) memberIds.add(p.photographerId);
    for (const a of p.appointments) if (a.assignedToId) memberIds.add(a.assignedToId);
    for (const o of p.payOverrides) memberIds.add(o.teamMemberId);
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
  // Warnings minted during line construction (orphaned overrides), attached to
  // the right cards when the output is assembled below.
  const issuesByMember = new Map<string, PayrollIssue[]>();

  for (const p of projects) {
    coordsByProject.set(p.id, p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null);

    // Timeline of who shot when. Fall back to the project photographer on the
    // shootDate when the project has no appointment rows at all (unsynced or
    // manually created), OR when a post-shoot status proves the shoot produced
    // work — Aryeo retro-cancels the rows of an order canceled after the shoot,
    // and earned pay must survive that. A BOOKED/SCHEDULED job whose rows are
    // all CANCELED means the shoot was called off — the sync never clears the
    // stale shootDate, and paying off it would pay for a visit that never
    // happened.
    const timeline: { at: Date; memberId: string | null }[] = p.appointments.length
      ? p.appointments.map((a) => ({
          at: a.startAt!,
          // photographerManual = the owner explicitly took over who's paid on
          // this job — Aryeo's per-leg assignee is deliberately ignored.
          memberId: p.photographerManual ? p.photographerId : a.assignedToId ?? p.photographerId,
        }))
      : p.shootDate && (p._count.appointments === 0 || SHOOT_HAPPENED_STATUSES.has(p.status))
        ? [{ at: p.shootDate, memberId: p.photographerId }]
        : [];
    // No early-out on an empty timeline: a manualAdd override below is an
    // explicit owner decision and must still pay (off the shootDate).

    const paidHere = new Set<string>(); // members already paid on this project
    const linedHere = new Set<string>(); // members with an actual pay line here this period
    const paidDayByMember = new Map<string, string>(); // member → ET day of the leg we handled
    timeline.forEach((slot, idx) => {
      const memberId = slot.memberId;
      if (!memberId) return;
      const isPrimary = idx === 0;
      const slotDay = etDayKey(slot.at);
      // A later leg by an already-paid shooter: SAME ET day = the same visit
      // (multiple appointment rows for one trip — skip). A DIFFERENT day is a
      // real second trip to the property — pay it as a return trip (flat) and
      // count its mileage, instead of silently dropping it (audit crack #15;
      // Jordan was hand-patching these with manual adjustments).
      if (!isPrimary && paidHere.has(memberId) && paidDayByMember.get(memberId) === slotDay) return;
      const at = slot.at;
      const inRange = at.getTime() >= start.getTime() && at.getTime() <= end.getTime();
      // A leg outside this period is paid in its own period; mark the shooter so a
      // same-person same-day leg here isn't treated as new.
      if (!inRange) { paidHere.add(memberId); paidDayByMember.set(memberId, slotDay); return; }
      if (opts?.memberId && memberId !== opts.memberId) { paidHere.add(memberId); paidDayByMember.set(memberId, slotDay); return; }

      const ov = p.payOverrides.find((o) => o.teamMemberId === memberId) ?? null;
      if (ov?.excluded) { pushRemoved(memberId, p.id, p.title, at); paidHere.add(memberId); paidDayByMember.set(memberId, slotDay); return; }
      const m = memberMap.get(memberId);
      const returnTrip = !isPrimary; // a later trip (second shooter OR the same shooter on another day)
      const invoice = ov?.invoiceOverride != null ? ov.invoiceOverride : (p.payableInvoice ?? p.price ?? 0);
      // Primary shoot = full pay (% of invoice or floor). Return leg = flat rate
      // (their floor) — UNLESS the owner set an invoice override for this member
      // on this job, which means "pay the % of THIS amount" and must be honored
      // on return legs too (audit crack #5: the override badge showed but the
      // engine silently paid the floor). A manual flatAmount always wins.
      const base = returnTrip
        ? (ov?.invoiceOverride != null ? shootPay(ov.invoiceOverride, m?.payPercent, m?.payFloor) : r2(m?.payFloor ?? 0))
        : shootPay(invoice, m?.payPercent, m?.payFloor);
      const pay = ov?.flatAmount != null ? r2(ov.flatAmount) : base;
      const dayKey = slotDay;
      const line: Built = {
        projectId: p.id,
        title: p.title,
        clientName: p.client?.name ?? null,
        shootISO: at.toISOString(),
        dayKey,
        // Return legs aren't a % of invoice unless an override says so.
        invoice: r2(returnTrip ? (ov?.invoiceOverride ?? 0) : invoice),
        invoiceIsFallback: !returnTrip && ov?.invoiceOverride == null && p.payableInvoice == null,
        invoiceOverridden: ov?.invoiceOverride != null,
        // Discounted order: the pay basis exceeds what the client actually pays
        // (item list prices > discounted order total) — surfaced as a warning.
        invoiceOverTotal: !returnTrip && ov?.invoiceOverride == null && p.price != null && invoice > p.price + 0.005,
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
      linedHere.add(memberId);
      paidDayByMember.set(memberId, dayKey);
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
        projectId: p.id, title: p.title, clientName: p.client?.name ?? null,
        shootISO: primaryAt.toISOString(), dayKey: etDayKey(primaryAt),
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
      linedHere.add(o.teamMemberId);
    }

    // An override keyed to a member who earned nothing on this job while someone
    // else did means the shoot was reassigned after the override was set: the
    // flat/invoice intent silently stops applying and the new shooter collects
    // default pay. Surface it so the owner re-keys or clears it. (paidHere also
    // covers members whose leg fell outside this period — their override still
    // applies in its own period, so it isn't orphaned.)
    if (linedHere.size > 0) {
      // Blame deterministically: the primary shooter (their line here isn't a
      // return trip), not whatever Set-insertion order put first.
      const shooterId =
        [...linedHere].find((id) =>
          (linesByMember.get(id) ?? []).some((l) => l.projectId === p.id && !l.returnTrip),
        ) ?? [...linedHere][0];
      for (const o of p.payOverrides) {
        if (o.manualAdd || o.excluded || (o.invoiceOverride == null && o.flatAmount == null)) continue;
        if (linedHere.has(o.teamMemberId) || paidHere.has(o.teamMemberId)) continue;
        const street = p.title.split(",")[0];
        const setFor = memberMap.get(o.teamMemberId)?.name ?? "another photographer";
        const shotBy = memberMap.get(shooterId)?.name ?? "another photographer";
        const issue: PayrollIssue = {
          level: "warn",
          message: `Pay override on ${street} was set for ${setFor} but ${shotBy} shot it — re-apply it to ${shotBy} or clear it.`,
          projectId: p.id,
        };
        for (const id of new Set([shooterId, o.teamMemberId])) {
          if (!issuesByMember.has(id)) issuesByMember.set(id, []);
          issuesByMember.get(id)!.push(issue);
        }
      }
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
      const stops: Stop[] = home
        ? dayJobs
            .filter((b) => b.hasCoords)
            .map((b) => { const c = coordsByProject.get(b.projectId)!; return { lat: c!.lat, lng: c!.lng, at: b._at }; })
        : [];
      const dm = await dailyMiles(memberId, dayKey, home, stops);
      const payableMiles = Math.max(dm.miles - freeMiles, 0);
      const share = mileageJobs.length > 0 ? r2((payableMiles * (m?.mileageRate ?? 0.65)) / mileageJobs.length) : 0;
      for (const b of mileageJobs) { b.mileageShare = share; b.jobTotal = r2(b.shootPay + share); }
      days.push({
        dayKey,
        miles: dm.miles,
        computedMiles: dm.computedMiles,
        overrideMiles: dm.overrideMiles,
        overrideNote: dm.overrideNote,
        freeMiles,
        payableMiles: r2(payableMiles),
        // The day figure is exactly what the jobs receive — share × jobs, and $0
        // when no job takes mileage — so the row can never show unpaid dollars.
        mileagePay: r2(share * mileageJobs.length),
        jobs: mileageJobs.length,
      });
    }

    // Owner mileage corrections whose day has NO pay lines this period (shoot
    // rescheduled/reassigned/cancelled after the adjustment): surface them as
    // zero-job rows so they're visible and resettable — an invisible override
    // would silently re-apply if a shoot ever lands back on that day.
    const orphanOverrides = await prisma.mileageDay.findMany({
      where: {
        teamMemberId: memberId,
        overrideMiles: { not: null },
        dayKey: { gte: etDayKey(start), lte: etDayKey(end), notIn: dayKeys },
      },
      select: { dayKey: true, miles: true, overrideMiles: true, overrideNote: true },
    });
    for (const o of orphanOverrides) {
      days.push({
        dayKey: o.dayKey, miles: o.overrideMiles!, computedMiles: o.miles,
        overrideMiles: o.overrideMiles, overrideNote: o.overrideNote,
        freeMiles, payableMiles: 0, mileagePay: 0, jobs: 0,
      });
    }
    days.sort((a, b) => a.dayKey.localeCompare(b.dayKey));

    // ---- Discrepancy detection ------------------------------------------
    const issues: PayrollIssue[] = [];
    if (built.length > 0 && !(m?.payPercent != null && m?.payFloor != null)) {
      issues.push({ level: "warn", message: "Pay rates not set — shoot pay shows $0. Set them on the team page." });
    }
    if (built.length > 0 && m?.payPercent != null && !home) {
      // Downgrade when Jordan already hand-set every day's miles — the mileage
      // IS calculated (by him); a standing warn would nag about corrected days.
      const allDaysOverridden = days.length > 0 && days.every((d) => d.overrideMiles != null);
      issues.push(
        allDaysOverridden
          ? { level: "info", message: "No home address on file — mileage is running on your manual adjustments." }
          : { level: "warn", message: "No home address — mileage can't be calculated. Add it on the team page." },
      );
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
      const dayLabel = new Date(d.dayKey + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
      // A hand-adjusted day IS the verification — never nag about the owner's
      // own figure. Instead, surface adjustments stranded on shoot-less days.
      if (d.overrideMiles != null) {
        if (d.jobs === 0) {
          issues.push({
            level: "warn",
            message: `Mileage adjustment on ${dayLabel} (${d.overrideMiles} mi) has no shoots this period — it pays nothing. Reset it if the shoot moved.`,
          });
        }
        continue;
      }
      if (d.miles > 350 || (d.jobs > 0 && d.miles / d.jobs > 200)) {
        issues.push({
          level: "warn",
          message: `Unusually high mileage on ${dayLabel}: ${d.miles.toFixed(0)} mi for ${d.jobs} shoot${d.jobs === 1 ? "" : "s"} — verify the locations.`,
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
        message: `${returnLegs.length} return trip${returnLegs.length === 1 ? "" : "s"} paid at your flat rate — a second/later visit to the property (${returnLegs[0].title.split(",")[0]}${returnLegs.length > 1 ? ", …" : ""}). Set an invoice total on the row to pay a % instead.`,
        projectId: returnLegs[0].projectId,
      });
    }
    // Discounted orders: the item list prices sum above what the client actually
    // pays, so the % would be applied to money that never came in. Flag for a
    // per-job call (override the invoice or leave it as goodwill).
    const overTotal = built.filter((b) => b.invoiceOverTotal);
    if (overTotal.length > 0) {
      issues.push({
        level: "warn",
        message: `${overTotal.length} shoot${overTotal.length === 1 ? "" : "s"} pay on a basis HIGHER than the discounted order total (${overTotal[0].title.split(",")[0]}${overTotal.length > 1 ? ", …" : ""}) — review or set the invoice on the row.`,
        projectId: overTotal[0].projectId,
      });
    }
    const fallback = built.filter((b) => b.invoiceIsFallback);
    if (fallback.length > 0) {
      issues.push({
        level: "info",
        message: `${fallback.length} shoot${fallback.length === 1 ? "" : "s"} use the order total (no itemized invoice synced) — virtual/AI add-ons may not be excluded.`,
      });
    }
    issues.push(...(issuesByMember.get(memberId) ?? []));

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

// ---------------------------------------------------------------------------
// Payday pings (audit build #9): pay is the field crew's proven hook — on
// payout morning each paid creative gets "your $X lands today". Uses the same
// queued-SMS path as every other photographer ping (batching + quiet hours),
// deduped once per payout day.
// ---------------------------------------------------------------------------
export async function paydayPings(): Promise<{ pinged: number } | { skipped: string }> {
  const todayKey = etDayKey(new Date());
  // The most recent CLOSED period paying today.
  let period = payPeriodFor();
  period = shiftPeriod(period.startKey, -1);
  if (period.payoutKey !== todayKey) return { skipped: "not a payday" };
  try {
    await prisma.appSetting.create({ data: { key: `payday-ping-${period.payoutKey}`, value: "sent" } });
  } catch {
    return { skipped: "already pinged today" };
  }
  try {
    // periodBounds = the DST-correct ET window (review: hardcoded -04:00
    // offsets shifted the winter window an hour early and could disagree
    // with /my-pay's own figures).
    const { start, end } = periodBounds(period);
    const people = await computePayroll(start, end);
    let pinged = 0;
    for (const person of people) {
      if (person.total <= 0) continue;
      const jobs = person.jobs.length;
      const line = `💰 Payday: $${person.total.toFixed(2)} lands today (${jobs} shoot${jobs === 1 ? "" : "s"} + mileage, ${period.startKey.slice(5)}–${period.endKey.slice(5)}). Details: ${process.env.APP_URL ?? "https://realtour-pilot-hub.vercel.app"}/my-pay`;
      await prisma.pendingSms.create({ data: { teamMemberId: person.member.id, line } }).catch(() => {});
      pinged++;
    }
    return { pinged };
  } catch (e) {
    // A failure after the claim must RELEASE it, or that payday's pings are
    // permanently suppressed (review finding — same pattern as the digests).
    await prisma.appSetting.delete({ where: { key: `payday-ping-${period.payoutKey}` } }).catch(() => {});
    throw e;
  }
}
