// ---------------------------------------------------------------------------
// ALL REVENUE THIS MONTH, GROSS AND NET (Oct 24 2026, Jordan: "Add Stripe to
// the dashboard too and add MTD Revenue for all revenue gross and net").
//
// Gross = every dollar clients paid this ET month on the three rails money
// reaches the business on (QuickBooks Payments, Stripe, Venmo), before
// refunds and fees. Net = what the business keeps of it: after refunds and
// each rail's fee for taking the money (Stripe's card fees, QuickBooks
// Payments' transaction fees, Venmo's instant-transfer fees on client money).
// Stripe Capital's loan withholding and Stripe's own billing aren't the cost
// of a sale, so they stay out (the Stripe panel shows them beside it).
//
// Pure, so the drill can pin the arithmetic; ownerDashboard.financialPosition
// feeds it the processors' figures.
// ---------------------------------------------------------------------------

export type RailKey = "quickbooks" | "stripe" | "venmo";
export type RevenueRail = {
  key: RailKey;
  label: string;
  gross: number;
  refunds: number;
  /** null = the fee record didn't load, so this rail's net is unknown */
  fees: number | null;
  net: number | null;
  /** where the rail's figure stops short of today, in words; null = current */
  through: string | null;
  /** money the bank shows arriving on this rail that its records don't have yet, NOT in gross (a sentence) */
  missing: string | null;
};
export type RevenueMonth = {
  monthLabel: string;
  gross: number;
  refunds: number;
  fees: number | null;
  net: number | null;
  rails: RevenueRail[];
};

/** The ledger categories that hold each rail's fee (financeCategories). Stripe's come from Stripe itself. */
export const RAIL_FEE_CATEGORY = { quickbooks: "QuickBooks Payments fees", venmo: "Venmo transfer fees" } as const;

const RAIL_LABEL: Record<RailKey, string> = { quickbooks: "QuickBooks Payments", stripe: "Stripe", venmo: "Venmo" };
const c2 = (n: number) => Math.round(n * 100) / 100;

type RailIn = { gross: number; refunds?: number; fees: number | null; through?: string | null; missing?: string | null };

export function revenueMonth(monthLabel: string, rails: Record<RailKey, RailIn>): RevenueMonth {
  const out: RevenueRail[] = (Object.keys(RAIL_LABEL) as RailKey[]).map((key) => {
    const r = rails[key];
    const refunds = c2(r.refunds ?? 0);
    const fees = r.fees == null ? null : c2(r.fees);
    return { key, label: RAIL_LABEL[key], gross: c2(r.gross), refunds, fees, net: fees == null ? null : c2(r.gross - refunds - fees), through: r.through ?? null, missing: r.missing ?? null };
  });
  const sum = (f: (r: RevenueRail) => number) => c2(out.reduce((s, r) => s + f(r), 0));
  const feesKnown = out.every((r) => r.fees != null);
  const fees = feesKnown ? sum((r) => r.fees!) : null;
  return { monthLabel, gross: sum((r) => r.gross), refunds: sum((r) => r.refunds), fees, net: feesKnown ? sum((r) => r.net!) : null, rails: out };
}

/** A rail's fee total from the categorized ledger's business rows. */
export const feeFrom = (business: { category: string; sum: number }[] | null | undefined, category: string): number | null =>
  business == null ? null : c2(business.filter((r) => r.category === category).reduce((s, r) => s + r.sum, 0));
