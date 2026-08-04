import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey } from "@/lib/datetime";
import { isRetainerSession } from "@/lib/packageNames";

// ---------------------------------------------------------------------------
// RECURRING REVENUE — the rail that does not appear anywhere in Aryeo.
//
// Monthly social-content clients (Video Starter 2HR, Video Accelerator 4HR,
// VIDEO PRO 8HR) pay a recurring QuickBooks invoice, roughly $1,099-$2,500 a
// month. Their Aryeo order is deliberately priced at $0 so they can schedule the
// session they have already paid for without being charged twice. That design
// choice means every Aryeo-based figure on the Trends page — booked revenue,
// average ticket, top spenders — silently omits them, and the clients on it look
// far smaller than they are.
//
// This module reads the OTHER rail straight from the synced QuickBooks ledger,
// so the page can show both without mixing them: per-listing money stays
// per-listing money, and recurring money is counted as recurring money.
//
// A retainer is DETECTED, not hard-coded: the same customer billed the same
// amount in three or more distinct months. Hard-coding names would silently drop
// the next client Jordan signs.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
// Below this, a repeated same-amount invoice is far more likely to be a client
// who happened to buy the same package three times than a retainer. The cheapest
// real tier is $1,099.
const MIN_MONTHLY = 900;
// Billed within this window = still a live retainer. Two missed cycles is the
// signal that one has quietly lapsed, which is worth more than the total.
const ACTIVE_DAYS = 70;

export type RetainerRow = {
  customer: string; // the QuickBooks customer name
  clientId: string | null; // matched hub client, when we can be sure
  clientName: string | null;
  monthlyAmount: number;
  monthsBilled: number;
  lastBilledISO: string | null;
  active: boolean;
  status: "active" | "lapsed";
  // A pass bought since the monthly stopped, reported as CONTEXT next to the
  // lapse — never as a reason to reclassify it. An earlier version treated
  // "bought a pass afterwards" as an upgrade and quietly hid a real churn.
  passSince: { dateISO: string; amount: number } | null;
  ytdRevenue: number;
  lifetimeRevenue: number;
  tier: string | null; // which session product they book, when known
};

export type PassRow = { customer: string; clientId: string | null; dateISO: string; amount: number; memo: string };

export type RecurringRevenue = {
  retainers: RetainerRow[]; // active first
  lapsed: RetainerRow[]; // stopped billing — every one of them counts as churn
  passes: PassRow[]; // one-off content passes / prepays this year
  monthlyRunRate: number; // active retainers only
  annualRunRate: number;
  ytdRetainer: number;
  ytdPasses: number;
  ytdTotal: number;
  clientIds: string[]; // hub clients on a live retainer — for flagging elsewhere
  sessionShoots: number; // $0 Aryeo bookings these retainers scheduled this year
  unmatched: string[]; // QBO customers we could not tie to a hub client
};

const SUFFIX = /\b(jr|sr|ii|iii|iv)\.?\b/gi;
const norm = (s: string) =>
  s.toLowerCase().replace(SUFFIX, " ").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Match a QuickBooks customer to a hub client. Deliberately strict: it requires
 * the FIRST and LAST name to agree, not just a surname, because "Gary Mercer Jr"
 * and "Gary Mercer, Sr" are two different people who both book with us. A missed
 * match shows up as an unmatched name we can report; a wrong match silently
 * attributes someone else's money.
 */
function matchClient(qboName: string, clients: { id: string; name: string }[]): { id: string; name: string } | null {
  const q = norm(qboName);
  if (!q) return null;
  const exact = clients.find((c) => norm(c.name) === q);
  if (exact) return exact;
  const qp = q.split(" ");
  const qFirst = qp[0];
  const qLast = qp[qp.length - 1];
  if (!qFirst || !qLast || qp.length < 2) return null;
  const hits = clients.filter((c) => {
    const p = norm(c.name).split(" ");
    return p.length >= 2 && p[0] === qFirst && p[p.length - 1] === qLast;
  });
  // Only accept an unambiguous match.
  return hits.length === 1 ? hits[0] : null;
}

export async function recurringRevenue(): Promise<RecurringRevenue> {
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const since = new Date(Date.now() - 800 * DAY);

  const [txns, clients] = await Promise.all([
    prisma.qboTransaction.findMany({
      where: { type: { in: ["Invoice", "SalesReceipt"] }, txnDate: { gte: since }, customerName: { not: null } },
      select: { txnDate: true, amount: true, customerName: true, memo: true },
      orderBy: { txnDate: "asc" },
    }),
    prisma.client.findMany({ select: { id: true, name: true } }),
  ]);

  // Group by customer, then by exact amount — a retainer is the same customer
  // billed the same figure in three or more distinct months.
  const byCustomer = new Map<string, { d: Date; amt: number; memo: string }[]>();
  for (const t of txns) {
    const a = byCustomer.get(t.customerName!) ?? [];
    a.push({ d: t.txnDate, amt: t.amount, memo: t.memo ?? "" });
    byCustomer.set(t.customerName!, a);
  }

  const activeCut = new Date(Date.now() - ACTIVE_DAYS * DAY);
  const all: RetainerRow[] = [];
  const unmatched: string[] = [];

  for (const [customer, rows] of byCustomer) {
    const byAmount = new Map<number, Date[]>();
    for (const r of rows) {
      if (r.amt < MIN_MONTHLY) continue;
      const a = byAmount.get(r.amt) ?? [];
      a.push(r.d);
      byAmount.set(r.amt, a);
    }
    for (const [amount, dates] of byAmount) {
      const months = new Set(dates.map((d) => etDayKey(d).slice(0, 7)));
      if (months.size < 3) continue;
      const sorted = dates.sort((a, b) => a.getTime() - b.getTime());
      const last = sorted[sorted.length - 1];
      const m = matchClient(customer, clients);
      if (!m && !unmatched.includes(customer)) unmatched.push(customer);
      all.push({
        customer,
        clientId: m?.id ?? null,
        clientName: m?.name ?? null,
        monthlyAmount: amount,
        monthsBilled: months.size,
        lastBilledISO: last ? etDayKey(last) : null,
        active: last >= activeCut,
        status: "active",
        passSince: null,
        ytdRevenue: dates.filter((d) => d >= yearStart).length * amount,
        lifetimeRevenue: dates.length * amount,
        tier: null,
      });
    }
  }

  // Which session product each retainer client actually books, so the card can
  // name the tier rather than just the dollar figure.
  const ids = all.map((r) => r.clientId).filter((x): x is string => !!x);
  const sessions = ids.length
    ? await prisma.orderItem.findMany({
        where: { isCanceled: false, project: { clientId: { in: ids }, orderedAt: { gte: yearStart } } },
        select: { title: true, project: { select: { clientId: true } } },
      })
    : [];
  const tierByClient = new Map<string, string>();
  let sessionShoots = 0;
  for (const s of sessions) {
    if (!isRetainerSession(s.title)) continue;
    sessionShoots++;
    const cid = s.project?.clientId;
    if (cid && !tierByClient.has(cid)) {
      tierByClient.set(cid, /pro\b/i.test(s.title) ? "Video Pro" : /accelerator/i.test(s.title) ? "Video Accelerator" : "Video Starter");
    }
  }
  for (const r of all) if (r.clientId) r.tier = tierByClient.get(r.clientId) ?? null;

  // One-off content passes and prepays — real recurring-adjacent money that is
  // not a monthly invoice, so it is counted separately rather than annualised.
  const PASS_RE = /access pass|accelerator|video pro|video starter|social media content|content creation/i;
  const passes: PassRow[] = txns
    .filter((t) => t.txnDate >= yearStart && t.amount >= 2500 && PASS_RE.test(t.memo ?? ""))
    .map((t) => {
      const m = matchClient(t.customerName!, clients);
      return {
        customer: t.customerName!,
        clientId: m?.id ?? null,
        dateISO: etDayKey(t.txnDate),
        amount: t.amount,
        memo: (t.memo ?? "").slice(0, 140),
      };
    })
    .sort((a, b) => b.amount - a.amount);

  // A STOPPED RETAINER IS A STOPPED RETAINER. An earlier version reclassified it
  // as an "upgrade" whenever the client later bought a content pass — which hid
  // a genuine churn behind a purchase made four months afterwards. The premise
  // was wrong anyway: Erica Walker holds a live monthly retainer AND has bought
  // two passes, so a pass plainly does not replace the monthly service. Any pass
  // bought since is recorded alongside the lapse as context, and nothing more.
  for (const r of all) {
    if (r.active) continue;
    r.status = "lapsed";
    const after = passes.find((p) => p.customer === r.customer && (!r.lastBilledISO || p.dateISO > r.lastBilledISO));
    r.passSince = after ? { dateISO: after.dateISO, amount: after.amount } : null;
  }

  const retainers = all.filter((r) => r.active).sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  const lapsed = all.filter((r) => r.status === "lapsed").sort((a, b) => b.monthlyAmount - a.monthlyAmount);

  const monthlyRunRate = retainers.reduce((s, r) => s + r.monthlyAmount, 0);
  const ytdRetainer = all.reduce((s, r) => s + r.ytdRevenue, 0);
  const ytdPasses = passes.reduce((s, p) => s + p.amount, 0);

  return {
    retainers,
    lapsed,
    passes,
    monthlyRunRate,
    annualRunRate: monthlyRunRate * 12,
    ytdRetainer,
    ytdPasses,
    ytdTotal: ytdRetainer + ytdPasses,
    clientIds: retainers.map((r) => r.clientId).filter((x): x is string => !!x),
    sessionShoots,
    unmatched,
  };
}
