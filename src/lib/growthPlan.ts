import "server-only";
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
import { aiJson } from "@/lib/integrations/ai";
import { bookingTrends, serviceTrends, topSpenders } from "@/lib/trends";
import { getPackageMargins } from "@/lib/packageMargin";
import { recurringRevenue } from "@/lib/recurring";
import { etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// THE GROWTH PLAN — the one card on /trends that tells Jordan what to DO.
//
// Everything else on the page reports. This reads the whole picture at once
// (booking pace, package mix, per-package margin, who's gone quiet, where the
// average ticket is drifting) and returns concrete moves: packages worth
// creating, promotions worth running, what to lean into, what to fix.
//
// It is cached against a hash of the BUSINESS SHAPE (see snapKey). The same
// numbers must never cost a second API call — and, more importantly, the advice
// must not reword itself every page load. It rebuilds when the business actually
// moves, or when the owner hits Refresh. (Same convention as
// rebuildShootFocusSummary.)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

export type PlanMove = { title: string; why: string; how: string; impact: string };
export type PlanPackage = { name: string; contents: string; price: string; why: string; targetClients: string };
export type PlanPromo = { name: string; offer: string; audience: string; timing: string; why: string };

export type GrowthPlanData = {
  headline: string;
  aovMoves: PlanMove[];
  newPackages: PlanPackage[];
  promotions: PlanPromo[];
  focus: { title: string; why: string }[];
  fix: { title: string; why: string }[];
};

export type GrowthPlanResult = { plan: GrowthPlanData | null; builtAt: Date | null; stale: boolean; error?: string };

/** The numbers the plan reasons over — small enough to hash, rich enough to advise on. */
export async function growthSnapshot() {
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const [bookings, services, spenders, storedMargins, recurring] = await Promise.all([
    bookingTrends(),
    serviceTrends(),
    topSpenders(25),
    getPackageMargins(),
    recurringRevenue().catch(() => null),
  ]);

  const margins = storedMargins?.data ?? null;
  const marginByLabel = new Map((margins?.rows ?? []).map((r) => [r.label, r]));
  const packages = services.packages.slice(0, 25).map((p) => {
    const m = marginByLabel.get(p.label);
    return {
      name: p.label,
      orders: p.orders,
      revenue: Math.round(p.revenue),
      perOrder: p.orders ? Math.round(p.revenue / p.orders) : 0,
      attachPct: Math.round(p.attachPct),
      change90dPct: p.changePct == null ? null : Math.round(p.changePct),
      marginPct: m?.marginPct == null ? null : Math.round(m.marginPct),
      marginPerOrder: m ? Math.round(m.perOrderMargin) : null,
    };
  });

  // Average ticket by month — the AOV story in one line.
  const aovByMonth = bookings.monthly.slice(-12).map((m) => ({
    month: m.key,
    orders: m.count,
    revenue: Math.round(m.revenue),
    avgTicket: m.count ? Math.round(m.revenue / m.count) : 0,
  }));

  return {
    today: etDayKey(new Date()),
    bookings: {
      windows: bookings.windows.map((w) => ({
        window: w.label,
        orders: w.count,
        revenue: Math.round(w.revenue),
        avgTicket: Math.round(w.avgTicket),
        vsPriorPct: w.countChangePct == null ? null : Math.round(w.countChangePct),
        yoyPct: w.yoyChangePct == null ? null : Math.round(w.yoyChangePct),
      })),
      avgPerWeek: bookings.avgPerWeek,
      projection: {
        month: bookings.projection.monthLabel,
        mtdOrders: bookings.projection.mtdCount,
        projectedOrders: bookings.projection.projectedCount,
        projectedRevenue: bookings.projection.projectedRevenue,
        lastMonthOrders: bookings.projection.lastMonthCount,
        paceVsLastMonthPct:
          bookings.projection.paceVsLastMonthPct == null ? null : Math.round(bookings.projection.paceVsLastMonthPct),
      },
      medianLeadTimeDays: bookings.leadTimeDays.median,
      aovByMonth,
    },
    packages,
    packagesSoldOnce: services.packageTail,
    margins: margins
      ? {
          // "exact" requires BOTH that nearly every job was costed AND that the
          // photo-editing line was actually known for them. Judging on job
          // coverage alone told the model the margins were exact while the
          // AutoHDR bill was silently booked as $0 on most jobs — and the system
          // prompt tells it to trust the numbers it is given.
          basis: margins.coverage >= 0.9 && margins.photoCostKnown >= 0.9 ? "exact" : "partial",
          photoEditingCostKnownPct: Math.round(margins.photoCostKnown * 100),
          jobsCosted: margins.jobs,
          revenue: Math.round(margins.revenue),
          cost: Math.round(margins.cost),
          margin: Math.round(margins.margin),
          marginPct: margins.marginPct == null ? null : Math.round(margins.marginPct),
        }
      : null,
    // The second rail. Absent from every other figure in this snapshot.
    recurring: recurring
      ? {
          monthlyRunRate: Math.round(recurring.monthlyRunRate),
          annualRunRate: Math.round(recurring.annualRunRate),
          ytdTotal: Math.round(recurring.ytdTotal),
          sessionsDelivered: recurring.sessionShoots,
          live: recurring.retainers.map((r) => ({ client: r.clientName ?? r.customer, monthly: r.monthlyAmount, tier: r.tier })),
          lapsed: recurring.lapsed.map((r) => ({
            client: r.clientName ?? r.customer,
            monthly: r.monthlyAmount,
            lastBilled: r.lastBilledISO,
            boughtPassSince: r.passSince ? r.passSince.amount : null,
          })),
        }
      : null,
    clients: {
      ytdTotal: Math.round(spenders.ytdTotal),
      concentrationTop5Pct: Math.round(spenders.concentrationTop5),
      concentrationTop10Pct: Math.round(spenders.concentrationTop10),
      top: spenders.rows.slice(0, 15).map((r) => ({
        name: r.name,
        ytd: Math.round(r.ytdRevenue),
        jobs: r.ytdJobs,
        avgTicket: Math.round(r.avgTicket),
        change90dPct: r.changePct == null ? null : Math.round(r.changePct),
        daysSinceLastOrder: r.daysSinceLastOrder,
        normalGapDays: r.medianGapDays,
      })),
      quiet: {
        count: spenders.quiet.count,
        ytdRevenue: Math.round(spenders.quiet.ytdRevenue),
        annualValue: Math.round(spenders.quiet.annualValue),
        names: spenders.quiet.rows.slice(0, 12).map((r) => ({
          name: r.name,
          ytd: Math.round(r.ytdRevenue),
          normalGapDays: r.medianGapDays,
          silentDays: r.daysSinceLastOrder,
        })),
      },
    },
  };
}

const SYSTEM = `You are a sharp growth strategist for RealTour Pilot LLC, a real-estate media agency in Lititz, Pennsylvania run by its owner Jordan Spackman. Photos, video, drone, floor plans and social reels for real-estate agents.

TWO GOALS, both first-class:
1. Raise the AVERAGE ORDER VALUE on per-listing work, month after month. Volume is not the problem — booking count is flat to up year over year. The ticket is what has been sliding.
2. Grow RECURRING REVENUE. Monthly social-content retainers ($1,099-$2,500 each) arrive whether or not anyone lists a house. They are the steadiest money in the business and do not depend on booking volume at all. Winning a new retainer, rescuing a lapsing one, and moving a high-frequency per-listing client onto one are among the highest-value moves available — treat them as seriously as any upsell.
Judge every recommendation against: "does this make the average order bigger, or add recurring revenue?"

WHAT YOU KNOW ABOUT THE BUSINESS:
- Clients are individual real-estate agents and small teams. They rebook on a personal rhythm (some weekly, some monthly). Relationships matter more than campaigns.
- Products are sold as bundles (BRONZE/SILVER/GOLD/PLATINUM/EVERYTHING) and à la carte add-ons (drone, floor plan, virtual staging, twilight, Zillow 3D).
- The expensive social-video products carry the revenue; the cheap photo bundles carry the volume.
- Delivery capacity is two photographers plus the owner, who is deliberately working himself out of the field. Anything that needs a lot more shoot days is expensive; anything that raises the ticket on shoots already happening is cheap.
- Editing is outsourced at known rates, so add-ons that need no extra shoot time (virtual staging, virtual twilight, floor plans) are high-margin.

HOW TO ADVISE:
- Be specific and concrete. "Bundle X and Y at $Z" beats "consider bundling". Name the actual packages and actual clients from the data.
- Every claim must trace to a number you were given. Quote the number inside the "why".
- Prices you propose must sit sensibly against the real per-order figures in the data.
- Prefer moves that raise the ticket on shoots that are ALREADY happening over moves that need more shoots.
- Say the uncomfortable thing when the data supports it — a shrinking flagship product or a client quietly leaving is worth more than a safe generality.
- Plain English. Jordan is not an analyst. No jargon, no filler, no hedging.
- NEVER guess a client's gender from their name. Always write about clients as "they"/"them" unless Jordan has told you otherwise. A wrong guess misgenders a real customer in Jordan's own tool, and the neutral wording reads perfectly well either way.`;

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One sentence: the single most important thing happening to the average order value right now." },
    aovMoves: {
      type: "array",
      description: "3-4 concrete moves that would raise average order value, most valuable first.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "The move, 3-8 words" },
          why: { type: "string", description: "The number that justifies it, one or two sentences" },
          how: { type: "string", description: "Exactly what to do, one or two sentences" },
          impact: { type: "string", description: "Rough dollar or percentage effect if it works" },
        },
        required: ["title", "why", "how", "impact"],
      },
    },
    newPackages: {
      type: "array",
      description: "2-4 packages worth creating that do not exist yet.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          contents: { type: "string", description: "What is in it" },
          price: { type: "string", description: "Proposed price, e.g. $895" },
          why: { type: "string", description: "The gap in the current mix it fills, with the number" },
          targetClients: { type: "string", description: "Who to offer it to first — name real clients where the data supports it" },
        },
        required: ["name", "contents", "price", "why", "targetClients"],
      },
    },
    promotions: {
      type: "array",
      description: "2-4 promotions worth running now.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          offer: { type: "string", description: "The actual offer" },
          audience: { type: "string", description: "Who gets it" },
          timing: { type: "string", description: "When to run it and why now" },
          why: { type: "string", description: "The number behind it" },
        },
        required: ["name", "offer", "audience", "timing", "why"],
      },
    },
    focus: {
      type: "array",
      description: "2-4 things already working that deserve more attention.",
      items: { type: "object", properties: { title: { type: "string" }, why: { type: "string" } }, required: ["title", "why"] },
    },
    fix: {
      type: "array",
      description: "2-4 things going wrong that need correcting.",
      items: { type: "object", properties: { title: { type: "string" }, why: { type: "string" } }, required: ["title", "why"] },
    },
  },
  required: ["headline", "aovMoves", "newPackages", "promotions", "focus", "fix"],
};

/**
 * The cache key hashes only the BUSINESS SHAPE, deliberately not the whole
 * snapshot. The snapshot carries the calendar with it — today's date, each
 * client's days-since-last-order, the month-to-date projection — all of which
 * tick over at midnight whether or not anything happened. Hashing those meant
 * the key changed every single night, so the plan was rebuilt (and paid for)
 * daily even on a day with no orders, and the "stale" flag could never fire.
 * Keyed on the figures that represent an actual change in the business, a quiet
 * day is now genuinely free.
 */
function snapKey(snap: Awaited<ReturnType<typeof growthSnapshot>>): string {
  const shape = {
    packages: snap.packages.map((p) => [p.name, p.orders, p.revenue, p.marginPct]),
    bookings: snap.bookings.windows.map((w) => [w.window, w.orders, w.revenue]),
    mtd: [snap.bookings.projection.mtdOrders, snap.bookings.projection.projectedRevenue],
    aov: snap.bookings.aovByMonth.map((m) => [m.month, m.orders, m.avgTicket]),
    margins: snap.margins ? [snap.margins.basis, snap.margins.revenue, snap.margins.margin] : [],
    clients: snap.clients.top.map((c) => [c.name, c.ytd, c.jobs]),
    quiet: [snap.clients.quiet.count, snap.clients.quiet.ytdRevenue, ...snap.clients.quiet.names.map((n) => n.name)],
  };
  return createHash("sha1").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/**
 * Build the plan if the inputs have moved (or `force`), otherwise return the
 * cached one. Never throws — the card renders whatever it has plus the reason.
 */
export async function rebuildGrowthPlan(force = false): Promise<GrowthPlanResult> {
  const snap = await growthSnapshot();
  const key = snapKey(snap);
  const existing = await prisma.growthPlan.findUnique({ where: { scope: "default" } }).catch(() => null);

  if (existing && existing.snapKey === key && !force) {
    return { plan: safeParse(existing.json), builtAt: existing.builtAt, stale: false };
  }

  try {
    const raw = await aiJson<GrowthPlanData>({
      system: SYSTEM,
      prompt: `Here is the live business data. Produce the growth plan.

${JSON.stringify(snap, null, 2)}

Notes on reading it: "change90dPct" compares the last 90 days to the 90 before. "attachPct" is the share of all orders this year containing that package. "marginPct" is after paying the photographer and the editors. "quiet" clients are regulars who have gone past double their own normal booking gap — annualValue is what they ACTUALLY paid over the last twelve months (measured money, not a projection).

KNOWN AND ALREADY EXPLAINED — do not spend a recommendation on these:
- Video Starter (2HR), Video Accelerator (4HR) and VIDEO PRO (8HR) are MONTHLY SOCIAL-CONTENT RETAINERS, not per-listing products. The client pays a recurring monthly invoice in QuickBooks (roughly $1,099-$1,999/month depending on tier), and the Aryeo order is deliberately priced at $0 so they can schedule the session they have already paid for without being charged twice. Their $0 Aryeo line is a design choice, not a pricing leak or a data error — never recommend "fixing" or repricing it. This is the highest-value RECURRING revenue in the business and roughly $40k/year of it does not appear in any Aryeo figure you have been given.
- Packages showing a null margin with real revenue (Virtual Staging, Virtual Twilight, Virtual Decluttering, AI renderings) are billed by an outside vendor whose per-job cost is not modelled. They are genuinely high margin, but "100%" would be wrong.
- Jordan's own shoots carry no shoot pay because he does not pay himself, so anything he personally shoots looks cheaper to deliver than it will be once he is fully out of the field.
- EVERY revenue figure you have been given is Aryeo (per-listing) money ONLY. Monthly retainers and prepaid content passes are billed in QuickBooks and are NOT in these numbers, so clients on a retainer (Erica Walker, Mike Ciunci, Alex Ercole Stackhouse, John Collins, Matthew Hutton, Jamie Achberger) are worth materially more than they look here. Do not tell Jordan a retainer client is small or declining based on their Aryeo total alone.
- margins.photoEditingCostKnownPct is the share of costed jobs where the photo-editing (AutoHDR) bill could be counted at all; on the rest it is booked as $0. When that number is well below 100, every photo-heavy package's margin is overstated. Treat photo-package margins as an upper bound and say so rather than recommending a push on a margin you cannot fully see.

The snapshot's "recurring" block is money billed in QuickBooks that appears NOWHERE else in this data — not in package revenue, not in client totals, not in the average ticket. A lapsed retainer is one of the most expensive things that can happen quietly, and a per-listing client who books often enough to be better off on a retainer is one of the cheapest wins. Use it.

Fill in EVERY section, including focus and fix. Keep each list to 3-4 entries and keep the prose tight so you have room to finish all six sections.`,
      schema: SCHEMA,
      // Generous, and deliberately so: the fields are emitted in schema order,
      // so a ceiling hit silently truncates the LAST sections. At 4k the focus
      // and fix lists came back empty every time while the earlier sections ran
      // long. Room to finish is cheaper than a half-written plan.
      maxTokens: 8000,
    });
    const plan = normalize(raw);
    const row = await prisma.growthPlan.upsert({
      where: { scope: "default" },
      create: { scope: "default", snapKey: key, json: JSON.stringify(plan), builtAt: new Date() },
      update: { snapKey: key, json: JSON.stringify(plan), builtAt: new Date() },
    });
    return { plan, builtAt: row.builtAt, stale: false };
  } catch (e) {
    // Keep showing the last good plan rather than an empty card.
    return {
      plan: existing ? safeParse(existing.json) : null,
      builtAt: existing?.builtAt ?? null,
      stale: !!existing,
      error: e instanceof Error ? e.message : "Could not rebuild the plan.",
    };
  }
}

/** Read-only: what the page renders. Never calls the model. */
export async function getGrowthPlan(): Promise<GrowthPlanResult> {
  const row = await prisma.growthPlan.findUnique({ where: { scope: "default" } }).catch(() => null);
  if (!row) return { plan: null, builtAt: null, stale: false };
  return {
    plan: safeParse(row.json),
    builtAt: row.builtAt,
    stale: row.builtAt.getTime() < Date.now() - 8 * DAY,
  };
}

/**
 * A schema-forced tool call still occasionally drops an optional-looking array
 * or hands back a single object where a list was asked for. Coerce every list
 * field to a real array so the card can render without defensive checks at
 * every level.
 */
function normalize(p: GrowthPlanData): GrowthPlanData {
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === "object" ? [v as T] : []);
  return {
    headline: typeof p.headline === "string" ? p.headline : "",
    aovMoves: arr<PlanMove>(p.aovMoves),
    newPackages: arr<PlanPackage>(p.newPackages),
    promotions: arr<PlanPromo>(p.promotions),
    focus: arr<{ title: string; why: string }>(p.focus),
    fix: arr<{ title: string; why: string }>(p.fix),
  };
}

function safeParse(json: string): GrowthPlanData | null {
  try {
    const p = JSON.parse(json) as GrowthPlanData;
    return p && typeof p.headline === "string" ? normalize(p) : null;
  } catch {
    return null;
  }
}
