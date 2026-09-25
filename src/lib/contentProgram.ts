import "server-only";
import { prisma } from "@/lib/prisma";
import { MONTHLY_PLAN_RE } from "@/lib/pipeline";
import { turnaroundRules } from "@/lib/settings";
import {
  productionClockFor,
  type ProductionAnchorSource,
  type ProductionClock,
  type PromiseRules,
  type SessionLeg,
} from "@/lib/turnaround";
import type { MonthProgress } from "@/lib/monthProgress";

// ---------------------------------------------------------------------------
// Content Creator Program — domain layer (Phase 1).
//
// The enrollment SIGNAL is Client.socialClient/socialPlan, synced from Aryeo
// customer custom fields ("Social Client" = Yes, "Social Content Plan" =
// Starter/Accelerator/Pro). That is the stable identifier the spec asked for —
// NOT product-title parsing. ContentEnrollment is the program's operating row
// on top of it: package rules, per-client overrides, pause state.
//
// Content sessions ARE Aryeo appointments → Projects. attachMonthlyProjects
// links each monthly-plan shoot to its ContentMonth, so the existing
// shoot→edit→review pipeline IS the production side of a month workspace.
// ---------------------------------------------------------------------------

// Package rule table (spec §2). Configurable later via overridesJson / admin UI;
// these are today's real packages.
export const PACKAGE_RULES: Record<string, { videosPerMonth: number; sessionsPerMonth: number; sessionHours: number }> = {
  Starter: { videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 },
  Accelerator: { videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4 },
  Pro: { videosPerMonth: 8, sessionsPerMonth: 2, sessionHours: 4 },
};

export type ProgramPackage = "Starter" | "Accelerator" | "Pro";

/** Where a paused or ended client restarts the program (Jordan, CP-12). The
 *  portal links it from the read-only notice; it is our public sign-up page,
 *  and nothing here takes a payment. */
export const RESUBSCRIBE_URL = "https://realtourpilot.com/content-program";

// ---------------------------------------------------------------------------
// THE PROVIDER CATALOGUE (finding F01, Sep 21 2026).
//
// PACKAGE_RULES above says what a package OWES. Neither provider was written
// down anywhere, so availability had nothing to ask a duration for and the
// Stripe sweep had to read a product NAME to know what somebody bought. Both
// halves are recorded here, both verified read-only in Phase 0 against the
// live accounts — and the numbers in PACKAGE_RULES are untouched by this, on
// purpose: three ACTIVE Accelerator clients (Bernadette Rabel, Marcee
// McMullen, Erica Walker) carry a hand-set 5 videos/month with
// packageSource=manual, and §3 says a manual production override survives
// provider reconciliation. Nothing in this file writes an allowance from a
// catalogue row.
// ---------------------------------------------------------------------------

/** One Aryeo product, as the live catalogue returned it on Sep 21 2026. */
export type AryeoContentProduct = {
  productId: string;
  /** the title Aryeo shows, verbatim — including the misleading Pro one. */
  title: string;
  /** the single variant's duration, in minutes: ONE booked appointment. */
  durationMinutes: number;
  /** how many of those appointments the package buys per month. */
  sessionsPerMonth: number;
  /** CP-04: the product's one variant — what POST /orders' product_items takes.
   *  Read from the live catalogue on Sep 21 2026 (docs/content-program-checklist.md). */
  variantId: string;
};

/**
 * Verified Sep 21 2026 by read-only GET against the live Aryeo catalogue.
 *
 * "VIDEO PRO - 8HR Session" IS NOT AN EIGHT-HOUR APPOINTMENT. Its single
 * variant's duration is 240 minutes — one four-hour block — and §3 says Pro is
 * two four-hour sessions that a client may not merge into one booking. The
 * name is Aryeo's, the eight hours are the month's total, and anybody sending
 * 480 to the availability call because the title says 8HR would offer slots
 * that do not exist. There has never been a Pro order, so the first one will
 * be the first exercise of this row.
 */
export const ARYEO_CONTENT_PRODUCTS: Record<ProgramPackage, AryeoContentProduct> = {
  Starter: { productId: "019c343b-ebd6-7139-8509-130eb1f339a5", title: "Video Starter", durationMinutes: 120, sessionsPerMonth: 1, variantId: "019c343b-ebe2-711e-8b2a-58929768c1e2" },
  Accelerator: { productId: "019c343d-27b9-72db-90a8-e941aaed31df", title: "Video Accelerator", durationMinutes: 240, sessionsPerMonth: 1, variantId: "019c343d-27d4-7346-9c5c-7ccb53241fd2" },
  Pro: { productId: "019c343f-a23b-72b0-8dee-67514390b9b5", title: "VIDEO PRO - 8HR Session", durationMinutes: 240, sessionsPerMonth: 2, variantId: "019c343f-a25e-715f-93b4-2c54561c811b" },
};

const isProgramPackage = (p: string | null | undefined): p is ProgramPackage =>
  p === "Starter" || p === "Accelerator" || p === "Pro";

/** The Aryeo product a package books, or null for an unknown package name. */
export function aryeoProductFor(pkg: string | null | undefined): AryeoContentProduct | null {
  return isProgramPackage(pkg) ? ARYEO_CONTENT_PRODUCTS[pkg] : null;
}

/**
 * HOW LONG ONE SESSION WAS SOLD AS, in minutes.
 *
 * PACKAGE_RULES.sessionHours and the Aryeo variant durations agree on all
 * three packages today (2h/120, 4h/240, 4h/240), which is why this reads the
 * hub's own table and treats Aryeo as the corroboration rather than the
 * source. Used for the availability duration a later batch will send, and as
 * the LAST rung of the production anchor's fallback ladder — never as a
 * correction to an appointment somebody actually booked. Real bookings already
 * drift from it: Sarina Spinelli bought a 4-hour Accelerator and her
 * appointment is 120 minutes, with others at 180 and 210 (Phase 0, 33 live
 * content orders). Those are Kyle's bookings, not data errors to overwrite.
 */
export function sessionMinutesFor(pkg: string | null | undefined): number | null {
  const rules = isProgramPackage(pkg) ? PACKAGE_RULES[pkg] : null;
  return rules ? Math.round(rules.sessionHours * 60) : null;
}

/** What a verified Stripe price sells. */
export type StripeProgramPrice = {
  priceId: string;
  productId: string;
  /** the Stripe product name, verbatim — for the audit trail, not for parsing. */
  productName: string;
  package: ProgramPackage;
  billingType: "PAID_IN_FULL" | "MONTHLY_CONTRACT" | "MONTH_TO_MONTH" | "TRIAL";
  billingMonths: number | null;
  amountCents: number;
};

/**
 * THE VERIFIED STRIPE CATALOGUE, keyed on PRICE id (F01).
 *
 * Keyed on the price and not the product because the product is ambiguous:
 * prod_Uo3cd97rfqJbSC, "Video Accelerator — Month-to-Month", carries TWO
 * active prices — $1599 and $1699 — and a live enrollment sits on each. A
 * name- or product-keyed map cannot tell them apart, and stripeSignups
 * .parseProgramProduct reads the NAME, which is also how a typographic dash or
 * a renamed product quietly downgrades somebody's terms.
 *
 * Every row below was read from the live Stripe account in Phase 0 and is
 * recorded in docs/content-program-checklist.md (Sep 21 2026). Only three of
 * these prices have ever been bought — Mike Flatley (Accelerator 1-Year),
 * Kristin Ciarmella (Accelerator M2M $1599), Arielle Roemer (Starter M2M) — so
 * the Pro, Pay-in-Full and trial rows are first exercised by the test account,
 * not by history. The name parser stays as the fallback for an unrecognised
 * price, which still parks the signup NEEDS_REVIEW for a human.
 */
export const STRIPE_PROGRAM_PRICES: Record<string, StripeProgramPrice> = Object.fromEntries(
  ([
    ["price_1ToRRzRrlUAkQjeVchi3zx8W", "prod_Uo3ZTc1vJ6yPVL", "Video Starter — Month-to-Month", "Starter", "MONTH_TO_MONTH", null, 129900],
    ["price_1ToRTeRrlUAkQjeVRfr0qRRP", "prod_Uo3aI6oez5oALB", "Video Starter — 1-Year Commitment", "Starter", "MONTHLY_CONTRACT", 12, 119900],
    ["price_1ToRUYRrlUAkQjeVoYdQ9qOH", "prod_Uo3bEXrvXoIoJY", "Video Starter — Pay in Full", "Starter", "PAID_IN_FULL", 12, 1223000],
    ["price_1U2ue2RrlUAkQjeVSGwsZXpB", "prod_Uo3cd97rfqJbSC", "Video Accelerator — Month-to-Month", "Accelerator", "MONTH_TO_MONTH", null, 159900],
    ["price_1ToRVeRrlUAkQjeVGVfJSGkR", "prod_Uo3cd97rfqJbSC", "Video Accelerator — Month-to-Month", "Accelerator", "MONTH_TO_MONTH", null, 169900],
    ["price_1ToRWNRrlUAkQjeVnlqXzQZp", "prod_Uo3dmrwsPqyCVR", "Video Accelerator — 1-Year Commitment", "Accelerator", "MONTHLY_CONTRACT", 12, 149900],
    ["price_1ToRX1RrlUAkQjeV9rvA1022", "prod_Uo3elia44pf2bh", "Video Accelerator — Pay in Full", "Accelerator", "PAID_IN_FULL", 12, 1529000],
    ["price_1ToRY0RrlUAkQjeV3jXBZ0xX", "prod_Uo3fPtSRRQuBSQ", "Video Pro — Month-to-Month", "Pro", "MONTH_TO_MONTH", null, 350000],
    ["price_1ToRYmRrlUAkQjeVJ9knIJEp", "prod_Uo3g19F9RKbLsK", "Video Pro — 1-Year Commitment", "Pro", "MONTHLY_CONTRACT", 12, 309700],
    ["price_1ToRZSRrlUAkQjeV0ejRCNCB", "prod_Uo3gUkXW1IPXy2", "Video Pro — Pay in Full", "Pro", "PAID_IN_FULL", 12, 3084600],
    // The trial alias Jordan sells as "Give It a Try!" — an Accelerator month.
    ["price_1TysDTRrlUAkQjeV3D19DPFJ", "prod_UyZ1unQbiCOlhv", "Video Accelerator - 4 videos - Give It a Try!", "Accelerator", "TRIAL", 1, 99700],
  ] as const).map(([priceId, productId, productName, pkg, billingType, billingMonths, amountCents]) => [
    priceId,
    { priceId, productId, productName, package: pkg, billingType, billingMonths, amountCents } satisfies StripeProgramPrice,
  ]),
);

/** What this Stripe price sells, or null when it is not a program price. */
export function programPriceFor(priceId: string | null | undefined): StripeProgramPrice | null {
  return priceId ? STRIPE_PROGRAM_PRICES[priceId] ?? null : null;
}

// ET month key ("2026-08") for a date — months are ET like everything else.
export function etMonthKey(d: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = p.find((x) => x.type === "year")!.value;
  const m = p.find((x) => x.type === "month")!.value;
  return `${y}-${m}`;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Enrollment sync: every socialClient gets a ContentEnrollment; plan changes
// from Aryeo update the package (unless the row was set manually); clients no
// longer flagged get PAUSED, never deleted (history stays).
// ---------------------------------------------------------------------------
export async function syncEnrollments(): Promise<{ created: number; updated: number; paused: number }> {
  const social = (await prisma.client.findMany({
    where: { socialClient: true },
    select: { id: true, socialPlan: true, email: true, name: true },
  // Jordan's OWN client record carries the Aryeo Social Client flag (testing),
  // but the owner is not a program client — removed Aug 24 at his request and
  // excluded here so the sweep can never quietly re-enroll him.
  })).filter((c) => c.email?.toLowerCase() !== "info@realtourpilot.com" && c.name !== "Jordan Spackman");
  const existing = await prisma.contentEnrollment.findMany({
    select: { id: true, clientId: true, package: true, status: true, packageSource: true, statusManual: true },
  });
  const byClient = new Map(existing.map((e) => [e.clientId, e]));
  let created = 0, updated = 0, paused = 0;

  for (const c of social) {
    const plan = c.socialPlan && PACKAGE_RULES[c.socialPlan] ? c.socialPlan : "Accelerator";
    const rules = PACKAGE_RULES[plan];
    const cur = byClient.get(c.id);
    if (!cur) {
      await prisma.contentEnrollment.create({
        data: { clientId: c.id, package: plan, ...rules, startedAt: new Date(), packageSource: "aryeo" },
      });
      created++;
    } else if (!cur.statusManual && (cur.status === "PAUSED" || (cur.package !== plan && cur.packageSource === "aryeo"))) {
      // Re-flagged in Aryeo → reactivate; plan changed in Aryeo → follow it
      // (manual packages are the admin's override and are left alone).
      await prisma.contentEnrollment.update({
        where: { id: cur.id },
        data: { status: "ACTIVE", ...(cur.packageSource === "aryeo" ? { package: plan, ...PACKAGE_RULES[plan] } : {}) },
      });
      updated++;
    }
  }
  // No longer flagged in Aryeo → pause (subscription lapsed), never delete.
  const socialIds = new Set(social.map((c) => c.id));
  for (const e of existing) {
    if (e.statusManual) continue; // a human owns this status
    if (e.status === "ACTIVE" && !socialIds.has(e.clientId)) {
      await prisma.contentEnrollment.update({ where: { id: e.id }, data: { status: "PAUSED" } });
      paused++;
    }
  }
  return { created, updated, paused };
}

// ---------------------------------------------------------------------------
// Month creation: every ACTIVE enrollment gets the current month's workspace
// (spec §15 — staff never create months by hand). Idempotent.
// ---------------------------------------------------------------------------
export async function ensureCurrentMonths(): Promise<{ created: number }> {
  const key = etMonthKey();
  const active = await prisma.contentEnrollment.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true },
  });
  let created = 0;
  for (const e of active) {
    const exists = await prisma.contentMonth.findUnique({
      where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey: key } },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.contentMonth.create({
      data: {
        enrollmentId: e.id,
        clientId: e.clientId,
        monthKey: key,
        videosOwed: e.videosPerMonth,
        strategyCallStatus: e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
      },
    });
    created++;
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Attach monthly-plan shoots to their month workspace. A project belongs to a
// month when: its client is enrolled, its deliverables read as monthly content
// (MONTHLY_PLAN_RE — the same signal the whole pipeline uses), and its shoot
// date falls in that ET month. Only fills blanks — a manual attach is honored.
// ---------------------------------------------------------------------------
export async function attachMonthlyProjects(): Promise<{ attached: number }> {
  const enrollments = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true } });
  if (enrollments.length === 0) return { attached: 0 };
  const clientIds = enrollments.map((e) => e.clientId);
  const byClient = new Map(enrollments.map((e) => [e.clientId, e.id]));

  const candidates = await prisma.project.findMany({
    where: {
      clientId: { in: clientIds },
      contentMonthId: null,
      status: { not: "CANCELLED" },
      // Date floor: the program launched Aug 2026 — without it the sweep
      // re-examined ~305 unattachable historical shoots on every run (audit).
      shootDate: { gte: new Date("2026-06-01T00:00:00Z") },
    },
    select: { id: true, clientId: true, shootDate: true, deliverables: { where: { removedFromOrderAt: null }, select: { label: true } } },
  });
  let attached = 0;
  for (const p of candidates) {
    if (!p.deliverables.some((d) => d.label && MONTHLY_PLAN_RE.test(d.label))) continue;
    const monthKey = etMonthKey(p.shootDate!);
    const enrollmentId = byClient.get(p.clientId)!;
    // Find-or-create the month (a shoot may land in a future or past month).
    let month = await prisma.contentMonth.findUnique({
      where: { enrollmentId_monthKey: { enrollmentId, monthKey } },
      select: { id: true },
    });
    if (!month) {
      const e = await prisma.contentEnrollment.findUnique({
        where: { id: enrollmentId },
        select: { videosPerMonth: true, strategyCallRequired: true },
      });
      month = await prisma.contentMonth.create({
        data: {
          enrollmentId,
          clientId: p.clientId,
          monthKey,
          videosOwed: e?.videosPerMonth ?? 4,
          strategyCallStatus: e?.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
          // A month minted for a pre-launch shoot is history, not a live workflow.
          ...(monthKey < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}),
        },
        select: { id: true },
      });
    }
    await prisma.project.update({ where: { id: p.id }, data: { contentMonthId: month.id } });
    attached++;
  }
  return { attached };
}

// One sweep the cron (and the page's refresh action) calls.
export async function contentProgramSweep() {
  // Scheduled settings changes (a package effective next month) land BEFORE
  // the month is minted, so the 1st-of-month workspace carries the new
  // quantity. Dynamic import: enrollmentChanges imports this module.
  const { applyDueEnrollmentChanges } = await import("@/lib/enrollmentChanges");
  const changes = await applyDueEnrollmentChanges().catch(() => ({ applied: 0 }));
  const enr = await syncEnrollments();
  const months = await ensureCurrentMonths();
  const attach = await attachMonthlyProjects();
  return { ...enr, monthsCreated: months.created, projectsAttached: attach.attached, changesApplied: changes.applied };
}

// ---------------------------------------------------------------------------
// The roster read — one row per enrollment with this month's live state and
// the needs-attention flags (spec §42–43).
//
// CP-10 (Sep 24 2026): every number here now comes from lib/monthProgress —
// the one reader the overview, the client file, portal Home and the reminders
// share. It used to count attached PROJECTS as booked sessions, a project
// whose date had passed as filmed, and a DELIVERED project's reel quantity as
// delivered videos, so a Pro month booked the right way (two appointments on
// one order) read "Needs 1 more session" and a job shell read booked.
// ---------------------------------------------------------------------------
export type ProgramRow = {
  enrollmentId: string;
  clientId: string;
  clientName: string;
  pkg: string;
  status: string; // enrollment status
  monthId: string | null;
  monthKey: string;
  videosOwed: number;
  strategyCallStatus: string;
  sessionsScheduled: number; // DISTINCT confirmed sessions (monthProgress.sessions.confirmed) — never a project count
  sessionsRequired: number;
  sessionsMissing: number; // sessions still to book (the capacity check's and the chaser's number)
  shotCount: number; // sessions somebody CONFIRMED were filmed — never "the date has passed"
  delivered: number; // videos delivered, from the library (isDeliveredProgramVideo)
  clientApproved: number; // videos the client approved on their current version
  inReview: number; // cuts waiting in the Review Room
  topicsSelected: number;
  scriptsReady: number;
  scriptsAwaiting: number; // drafts sitting in INTERNAL_REVIEW/DRAFT — Jordan's approve queue
  openSuggestions: number; // OPEN portal suggestions from the client on this month's scripts
  strategyCallAt: string | null; // ISO, when booked — lets the UI say "call Fri 2 PM"
  nextShootDate: string | null; // ISO, the next upcoming session this month
  strategyCallRequired: boolean;
  clientSuppliesTopics: boolean;
  behind: { monthKey: string; delivered: number; owed: number } | null; // last month under-delivered
  attention: string[]; // human-readable exception flags, worst first
  trial: boolean; // hand-set ACTIVE on a one-month trial
  lastMonthKey: string | null; // latest month with any program content
  /** The reader's whole answer — the card's journey and meter draw from it. */
  progress: MonthProgress | null;
};

// UI-02 (Sep 24 2026): the /content page no longer reads this — its cards and
// its table both draw programOverview rows now, so the two views cannot differ.
// Kept because the CP-10 drill holds this roster to the same reader; no screen
// should start reading it again (a second engine is how the views drifted).
export async function getProgramRoster(opts: { now?: Date } = {}): Promise<ProgramRow[]> {
  const now = opts.now ?? new Date();
  const key = etMonthKey(now);
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    select: {
      id: true, clientId: true, package: true, status: true, statusManual: true, notes: true,
      sessionsPerMonth: true, strategyCallRequired: true, clientSuppliesTopics: true, billingType: true,
    },
  });
  // Last month that has ANY program content — the "when were they last active"
  // signal for the paused section.
  const lastMonths = await prisma.contentMonth.groupBy({
    by: ["enrollmentId"],
    where: { enrollmentId: { in: enrollments.map((e) => e.id) } },
    _max: { monthKey: true },
  });
  const lastMonthOf = new Map(lastMonths.map((l) => [l.enrollmentId, l._max.monthKey]));
  const clients = await prisma.client.findMany({
    where: { id: { in: enrollments.map((e) => e.clientId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: { in: enrollments.map((e) => e.id) }, monthKey: key },
    select: { id: true, enrollmentId: true },
  });
  const monthOf = new Map(months.map((m) => [m.enrollmentId, m]));

  // LAST month, for the behind-flag (Jordan, Aug 28: "sometimes clients get a
  // month behind or miss a month" — Marcee's July was filmed in August). A
  // month the owner marked SKIPPED, or an imported backfill month, never nags.
  const [y, mm] = key.split("-").map(Number);
  const prevKey = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  const prevMonths = await prisma.contentMonth.findMany({
    where: { enrollmentId: { in: enrollments.map((e) => e.id) }, monthKey: prevKey, historical: false, status: { notIn: ["SKIPPED", "IMPORTED"] } },
    select: { id: true, enrollmentId: true },
  });
  const prevOf = new Map(prevMonths.map((m) => [m.enrollmentId, m]));

  // ONE batched read for this month and last month, every client at once.
  // Dynamic import: monthProgress → programOwners → this module.
  const { monthProgressMany, progressKey, unknownLine } = await import("@/lib/monthProgress");
  const progress = await monthProgressMany([
    ...enrollments.map((e) => ({ enrollmentId: e.id, monthId: monthOf.get(e.id)?.id ?? null, monthKey: key })),
    ...prevMonths.map((pm) => ({ enrollmentId: pm.enrollmentId, monthId: pm.id, monthKey: prevKey })),
  ], { now });

  const rows: ProgramRow[] = [];
  for (const e of enrollments) {
    const m = monthOf.get(e.id) ?? null;
    const p = progress.get(progressKey(e.id, m?.id ?? null, key)) ?? null;
    const s = p?.sessions;
    const attention: string[] = [];
    let behind: { monthKey: string; delivered: number; owed: number } | null = null;
    if (e.status === "PAUSED") attention.push("Paused — no longer flagged in Aryeo");
    else if (m && p && s) {
      if (p.call.status === "NOT_SCHEDULED") attention.push("Strategy call not scheduled");
      // A project shell (no date, no appointment) is not a session, and a
      // dated job with no appointment is not "missing" — it is UNVERIFIED,
      // and says so below with Kyle's action.
      if (s.count.accountedFor === 0) attention.push("No content session on the calendar");
      else if (s.missing > 0) attention.push(`Needs ${s.missing} more session${s.missing === 1 ? "" : "s"}`);
      for (const u of p.unknowns) attention.push(unknownLine(u));
      if (p.topics.selected === 0 && !e.clientSuppliesTopics) attention.push("No topics selected");
      const inReview = p.production.awaitingInternalReview;
      if (inReview > 0) attention.push(`${inReview} video${inReview === 1 ? "" : "s"} awaiting review`);
      const prev = prevOf.get(e.id);
      const pp = prev ? progress.get(progressKey(e.id, prev.id, prevKey)) ?? null : null;
      if (pp && pp.videosOwed > 0) {
        const got = pp.production.delivered;
        // An understated library is an unknown, not a shortfall to accuse anyone of.
        if (!pp.production.known) attention.push(`Unknown: ${monthLabel(prevKey)} delivered count — the pipeline shows ${pp.production.pipelineDelivered}, the library ${got} — the hub: Sync now`);
        else if (got < pp.videosOwed) {
          attention.push(`Behind — ${monthLabel(prevKey)} delivered ${got}/${pp.videosOwed}`);
          behind = { monthKey: prevKey, delivered: got, owed: pp.videosOwed };
        }
      }
    }

    rows.push({
      enrollmentId: e.id,
      clientId: e.clientId,
      clientName: nameOf.get(e.clientId) ?? "Unknown",
      pkg: e.package,
      status: e.status,
      monthId: m?.id ?? null,
      monthKey: key,
      videosOwed: p?.videosOwed ?? 0,
      strategyCallStatus: p?.call.status ?? (e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED"),
      sessionsScheduled: s?.confirmed ?? 0,
      sessionsRequired: e.sessionsPerMonth,
      sessionsMissing: s?.missing ?? 0,
      shotCount: s?.filmedConfirmed ?? 0,
      delivered: p?.production.delivered ?? 0,
      clientApproved: p?.production.clientApproved ?? 0,
      inReview: p?.production.awaitingInternalReview ?? 0,
      topicsSelected: p?.topics.selected ?? 0,
      scriptsReady: p?.scripts.ready ?? 0,
      scriptsAwaiting: p ? p.scripts.drafting + p.scripts.needsJordan : 0,
      openSuggestions: p?.scripts.openSuggestions ?? 0,
      strategyCallAt: p?.call.atISO ?? null,
      nextShootDate: s?.nextAtISO ?? null,
      strategyCallRequired: e.strategyCallRequired,
      clientSuppliesTopics: e.clientSuppliesTopics,
      behind,
      attention,
      trial: e.status === "ACTIVE" && (e.billingType === "TRIAL" || (e.statusManual && /trial/i.test(e.notes ?? ""))),
      lastMonthKey: lastMonthOf.get(e.id) ?? null,
      progress: p,
    });
  }
  // Worst problems first, then by name.
  rows.sort((a, b) => b.attention.length - a.attention.length || a.clientName.localeCompare(b.clientName));
  return rows;
}

// ---------------------------------------------------------------------------
// Who owns which duty (spec §16/§17, Jordan D11): Jordan owns STRATEGY and
// SCRIPTS approval, Kyle owns SCHEDULING and DELIVERY — as ProgramOwnerAssignment
// DEFAULT rows, overridable per enrollment or per month. The defaults are
// minted on first read (a settings row, not client data) so the workspace can
// always show an owner; an override is a scope=ENROLLMENT/MONTH row.
// ---------------------------------------------------------------------------
// CP-13 (Sep 24 2026): MESSAGES — who answers the client's program
// conversation (src/lib/programMessages.ts). Kyle by default.
export type OwnerDuty = "STRATEGY" | "SCRIPTS" | "SCHEDULING" | "DELIVERY" | "ESCALATION" | "REMINDERS" | "MESSAGES";
export const OWNER_DUTIES: OwnerDuty[] = ["STRATEGY", "SCRIPTS", "SCHEDULING", "DELIVERY", "ESCALATION", "REMINDERS", "MESSAGES"];
export type DutyOwner = { duty: OwnerDuty; appUserId: string | null; email: string | null; label: string; scope: "DEFAULT" | "ENROLLMENT" | "MONTH" };

/** Who holds each duty until someone says otherwise (Jordan D11, + CP-13). */
const DEFAULT_HOLDER: Record<OwnerDuty, "jordan" | "kyle"> = {
  STRATEGY: "jordan", SCRIPTS: "jordan", ESCALATION: "jordan",
  SCHEDULING: "kyle", DELIVERY: "kyle", REMINDERS: "kyle", MESSAGES: "kyle",
};

async function ensureDefaultOwnerAssignments(): Promise<void> {
  // Mint any duty that has NO default row yet. This used to return as soon as
  // ANY default existed, which was fine while the duty list never changed —
  // and meant a duty added later (MESSAGES, CP-13) would never get its default
  // owner in production, where the first six were minted on Sep 17. A row a
  // person ended (endedAt) still counts as "has a default": that was a
  // decision, and minting over it would undo it.
  const have = new Set((await prisma.programOwnerAssignment.findMany({ where: { scope: "DEFAULT" }, select: { duty: true } })).map((r) => r.duty));
  const missing = OWNER_DUTIES.filter((d) => !have.has(d));
  if (missing.length === 0) return;
  const users = await prisma.appUser.findMany({ where: { status: "ACTIVE" }, select: { id: true, email: true, name: true, role: true } });
  // Jordan = the OWNER on the company address; Kyle = the ADMIN named Kyle.
  const jordan = users.find((u) => u.email === "info@realtourpilot.com") ?? users.find((u) => u.role === "OWNER") ?? null;
  const kyle = users.find((u) => u.role === "ADMIN" && /kyle/i.test(u.name ?? "")) ?? null;
  // createMany/skipDuplicates: two first reads racing both succeed (ON
  // CONFLICT DO NOTHING) instead of one of them throwing a unique violation.
  await prisma.programOwnerAssignment.createMany({
    data: missing.map((duty) => {
      const user = DEFAULT_HOLDER[duty] === "jordan" ? jordan : kyle;
      return { scope: "DEFAULT", scopeRef: "", duty, appUserId: user?.id ?? null, label: user?.name ?? (user?.email ?? "unassigned"), setBy: "defaults" };
    }),
    skipDuplicates: true,
  }).catch(() => {});
}

/** The owner of a duty for a month → enrollment → program default. */
export async function ownersFor(enrollmentId: string, monthId?: string | null): Promise<Record<OwnerDuty, DutyOwner>> {
  await ensureDefaultOwnerAssignments();
  const rows = await prisma.programOwnerAssignment.findMany({
    where: { endedAt: null, OR: [{ scope: "DEFAULT" }, { scope: "ENROLLMENT", scopeRef: enrollmentId }, ...(monthId ? [{ scope: "MONTH", scopeRef: monthId }] : [])] },
  });
  const userIds = [...new Set(rows.map((r) => r.appUserId).filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : [];
  const out = {} as Record<OwnerDuty, DutyOwner>;
  for (const duty of OWNER_DUTIES) {
    const pick = rows.find((r) => r.duty === duty && r.scope === "MONTH") ?? rows.find((r) => r.duty === duty && r.scope === "ENROLLMENT") ?? rows.find((r) => r.duty === duty && r.scope === "DEFAULT");
    const u = pick?.appUserId ? users.find((x) => x.id === pick.appUserId) : null;
    out[duty] = { duty, appUserId: pick?.appUserId ?? null, email: u?.email ?? null, label: u?.name ?? pick?.label ?? "unassigned", scope: (pick?.scope as DutyOwner["scope"]) ?? "DEFAULT" };
  }
  return out;
}

/** Override who owns a duty for one enrollment (or one month). appUserId null = remove the override. */
export async function setOwnerOverride(scope: "ENROLLMENT" | "MONTH", scopeRef: string, duty: OwnerDuty, appUserId: string | null, by: string): Promise<void> {
  if (!appUserId) {
    await prisma.programOwnerAssignment.updateMany({ where: { scope, scopeRef, duty, endedAt: null }, data: { endedAt: new Date() } });
    return;
  }
  const u = await prisma.appUser.findUnique({ where: { id: appUserId }, select: { name: true, email: true } });
  await prisma.programOwnerAssignment.upsert({
    where: { scope_scopeRef_duty: { scope, scopeRef, duty } },
    create: { scope, scopeRef, duty, appUserId, label: u?.name ?? u?.email ?? null, setBy: by },
    update: { appUserId, label: u?.name ?? u?.email ?? null, setBy: by, endedAt: null, effectiveAt: new Date() },
  });
}

/**
 * May this person perform a duty on this enrollment? The assigned owner may;
 * so may any OWNER-role login (Jordan can always act, and can hand a duty to
 * Kyle by setting an override). Everyone else gets the owner's name back.
 */
export async function assertDutyOwner(duty: OwnerDuty, enrollmentId: string, monthId: string | null | undefined, me: { id?: string | null; email: string; realRole?: string | null; role?: string | null }): Promise<void> {
  if ((me.realRole ?? me.role) === "OWNER") return;
  const owner = (await ownersFor(enrollmentId, monthId))[duty];
  if (owner.appUserId && me.id && owner.appUserId === me.id) return;
  if (owner.email && owner.email.toLowerCase() === me.email.toLowerCase()) return;
  throw new Error(`${duty.toLowerCase()} approval is assigned to ${owner.label} — ask them, or change the owner on the Client file.`);
}

// ---------------------------------------------------------------------------
// THE PRODUCTION CLOCK, PER SESSION (spec §8/§9, finding F27, Sep 21 2026).
//
// "Internal production — target business day 7, overdue after business day 10,
// anchored to that appointment's end", and "each Pro session has a separate end
// time and day-7/day-10 target". The arithmetic lives in turnaround.ts beside
// the rest of the promise table; this is the program's read of it — one row per
// BOOKED LEG, not per project, because a Pro month is two four-hour sessions
// that may hang off a single order.
//
// It reports three things every existing surface leaves implicit and F27 needs
// said out loud:
//   · WHICH rung of the anchor ladder answered, and whether it is estimated —
//     one live content order has no appointment at all and one appointment is
//     UNSCHEDULED with null start/end, so "the appointment's end" is sometimes
//     not a thing that exists;
//   · the drift between the minutes actually booked and the minutes the package
//     was sold as (Sarina Spinelli: 4-hour Accelerator, 120-minute appointment)
//     as a FLAG for Kyle, never as a correction to the booking;
//   · the production target kept apart from the client's review clock (§10:
//     "do not silently merge these measures"), which is why nothing here is
//     called simply `dueAt`.
// ---------------------------------------------------------------------------

export type ProgramSessionClock = {
  projectId: string;
  projectTitle: string;
  /** null when the job has no bookable appointment row at all. */
  appointmentId: string | null;
  /** 1-based, by start time, across the whole month — "session 2 of 2". */
  sessionIndex: number;
  sessionsInMonth: number;
  startAt: Date | null;
  anchorAt: Date | null;
  anchorSource: ProductionAnchorSource;
  anchorEstimated: boolean;
  anchorNote: string | null;
  productionTargetAt: Date | null;
  productionDueAt: Date | null;
  /** after the office override and the frozen promise — what we are held to. */
  effectiveDueAt: Date | null;
  effectiveSource: ProductionClock["effectiveSource"];
  packageMinutes: number | null;
  bookedMinutes: number | null;
  /** a sentence for Kyle when the booking is not the length it was sold as. */
  durationDrift: string | null;
};

/** A project row this module can clock — exactly the columns it reads. */
export type SessionProject = {
  id: string;
  title: string;
  shootDate: Date | null;
  promisedDueAt: Date | null;
  dueOverrideAt: Date | null;
  appointments: (SessionLeg & { id: string })[];
};

/** The Prisma select for SessionProject — spread it into any project read. */
export const SESSION_CLOCK_SELECT = {
  id: true,
  title: true,
  shootDate: true,
  promisedDueAt: true,
  dueOverrideAt: true,
  appointments: { select: { id: true, startAt: true, endAt: true, durationMin: true, status: true } },
} as const;

const bookable = (a: SessionLeg): boolean => {
  const s = (a.status || "").toUpperCase();
  return !s.startsWith("CANCEL") && s !== "UNSCHEDULED" && a.startAt !== null;
};

/**
 * Per-session clocks for a set of projects. Pure: no I/O, so the drill and the
 * page compute the same dates from the same rows.
 */
export function sessionClocksFor(
  projects: SessionProject[],
  pkg: string | null | undefined,
  rules?: PromiseRules | null,
  now: number = Date.now(),
): ProgramSessionClock[] {
  const packageMinutes = sessionMinutesFor(pkg);
  const rows: ProgramSessionClock[] = [];
  for (const p of projects) {
    const legs = p.appointments.filter(bookable);
    // No bookable leg: still emit ONE row, so a job with no appointment is a
    // visible exception on the board instead of a silently missing session.
    const targets: (string | null)[] = legs.length ? legs.map((a) => a.id) : [null];
    for (const legId of targets) {
      const clock = productionClockFor(p, { now, expectedSessionMinutes: packageMinutes, legId, rules });
      const leg = legId ? legs.find((a) => a.id === legId) ?? null : null;
      const booked = clock.anchor.bookedMinutes;
      rows.push({
        projectId: p.id,
        projectTitle: p.title,
        appointmentId: clock.anchor.legId,
        sessionIndex: 0, // filled after the month-wide sort below
        sessionsInMonth: 0,
        startAt: leg?.startAt ?? p.shootDate ?? null,
        anchorAt: clock.anchor.at,
        anchorSource: clock.anchor.source,
        anchorEstimated: clock.anchor.estimated,
        anchorNote: clock.anchor.note,
        productionTargetAt: clock.productionTargetAt,
        productionDueAt: clock.productionDueAt,
        effectiveDueAt: clock.effectiveDueAt,
        effectiveSource: clock.effectiveSource,
        packageMinutes,
        bookedMinutes: booked,
        durationDrift:
          booked !== null && packageMinutes !== null && booked !== packageMinutes
            ? `Booked for ${booked} minutes; the ${pkg ?? "package"} session is sold as ${packageMinutes}. The booking is what the clock uses.`
            : null,
      });
    }
  }
  // "Session 1 of 2" is a display ordinal over the month's real bookings, not a
  // database identity (§9.8) — a leg that moves gets a new position, not a new
  // identity, and the clock rides on appointmentId.
  rows.sort((a, b) => (a.startAt?.getTime() ?? Infinity) - (b.startAt?.getTime() ?? Infinity) || a.projectId.localeCompare(b.projectId));
  rows.forEach((r, i) => {
    r.sessionIndex = i + 1;
    r.sessionsInMonth = rows.length;
  });
  return rows;
}

/**
 * The production clocks for one ContentMonth's sessions, package-aware.
 * Read-only: one project read plus the office's turnaround settings.
 */
export async function monthSessionClocks(monthId: string, now: Date = new Date()): Promise<ProgramSessionClock[]> {
  // ContentMonth carries enrollmentId but no Prisma relation to it, so the
  // package is a second read rather than an include.
  const month = await prisma.contentMonth.findUnique({
    where: { id: monthId },
    select: { id: true, enrollmentId: true },
  });
  if (!month) return [];
  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { id: month.enrollmentId },
    select: { package: true },
  });
  const projects = await prisma.project.findMany({
    where: { contentMonthId: monthId, status: { not: "CANCELLED" } },
    select: SESSION_CLOCK_SELECT,
  });
  const rules = await turnaroundRules();
  return sessionClocksFor(projects, enrollment?.package ?? null, rules, now.getTime());
}
