import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Bookkeeping engine — turn the raw QuickBooks ledger into a P&L you can trust.
//
// The problem this solves: QuickBooks reports income that isn't income. The same
// dollar arrives as an auto-generated SalesReceipt AND again as its bank-feed
// twin. Money moving between Jordan's personal ...0942 account and business
// checking gets coded to Media Services. Stripe payouts are recorded as deposits
// even though the underlying charges are already counted on the Stripe rail.
//
// Design rule: NEVER guess silently. A row we cannot classify with evidence gets
// needsReview = true and a plain-English reviewNote saying what we saw and what
// we could not tell. Filing something wrong quietly is worse than asking.
// ---------------------------------------------------------------------------

/** What a transaction actually is, once the noise is stripped out. */
export type Category =
  // Money in
  | "REVENUE"            // genuine customer money, counted once
  | "ALREADY_COUNTED"    // real revenue, but recognised on another rail (Stripe)
  | "DUPLICATE"          // the second copy of a dollar counted elsewhere
  // Not income at all
  | "TRANSFER"           // moving own money between own accounts
  | "OWNER_DRAW"         // business -> personal. A distribution, NOT an expense
  | "OWNER_CONTRIBUTION" // personal -> business. NOT income
  | "FEE_REFUND"         // bank fee reversals, ACH reversals
  // Money out
  | "COST_OF_SALES"      // contractors, editing, per-job costs
  | "OPERATING"          // software, office, professional services
  | "VEHICLE"            // auto, fuel, travel
  | "FINANCING"          // loan principal — NOT deductible, see reviewNote
  | "UNCATEGORISED";

export type Verdict = {
  category: Category;
  confidence: number;      // 0..1
  needsReview: boolean;
  reviewNote?: string;
  personal?: boolean;
  duplicateOf?: string;    // qboId of the row we keep
};

const PERSONAL_ACCT = /0942/;
const RX = {
  stripe: /\bSTRIPE\b/i,
  venmo: /\bVENMO\b/i,
  qbPay: /QUICKBOOKS PAYMENTS|INTUIT/i,
  autoGen: /AUTO-?GENERATED/i,
  feeish: /\b(NSF|OD FEE|OVERDRAFT|REFUND|REVERSE|REVERSAL)\b/i,
};

// Expense buckets keyed off QuickBooks' own account name. Deliberately small and
// explicit: an unknown account is UNCATEGORISED and gets reviewed, rather than
// being swept into a bucket that quietly distorts the P&L.
// Matched against the LINE-level account name first, and against the raw bank
// description as a fallback (which is how a vendor buried in an Owner Draw line
// still gets recognised). Vendor names are listed alongside the account names
// they should map to.
const EXPENSE_MAP: [RegExp, Category][] = [
  [/contract labor|contractor|1099/i, "COST_OF_SALES"],
  [/editing|editor/i, "COST_OF_SALES"],
  [/cost of goods|cogs|purchases/i, "COST_OF_SALES"],
  [/dues|subscription|software/i, "OPERATING"],
  // Vendors that are unambiguously business tooling.
  [/midjourney|adobe|dropbox|openai|anthropic|vercel|github|slack|zoom|canva|aryeo|frame\.?io/i, "OPERATING"],
  [/office|supplies|staples|amazon|best buy/i, "OPERATING"],
  [/professional|legal|account/i, "OPERATING"],
  [/bank charge|merchant|payments fee/i, "OPERATING"],
  [/auto|fuel|gas|mileage|shell|exxon|sunoco|mobil/i, "VEHICLE"],
  [/travel|meals|hotel|airbnb|uber|lyft/i, "VEHICLE"],
  [/loan|financing|capital/i, "FINANCING"],
];

type Row = {
  qboId: string; type: string; txnDate: Date; amount: number;
  memo: string | null; accountName: string | null; customerName: string | null;
  linkedCount: number;
};

/**
 * Classify one row. `peers` are same-period Payments/SalesReceipts used for
 * duplicate detection; `payouts` are Stripe payout amounts+dates used to prove a
 * personal-account deposit was really a payout that took a detour.
 */
export function classify(
  r: Row,
  peers: { qboId: string; amount: number; txnDate: Date }[],
  payouts: { amount: number; at: Date }[],
): Verdict {
  const memo = r.memo ?? "";
  const days = (a: Date, b: Date) => Math.abs(+a - +b) / 864e5;

  // ---- Expenses -----------------------------------------------------------
  if (r.type === "Purchase") {
    const acct = r.accountName ?? "";

    // "Owner Draw" is the biggest bucket in the file (1,031 lines) and it is NOT
    // trustworthy. Real business spend is sitting in it — a $10.60 Midjourney
    // subscription, for one. Because Owner Draw is an equity account it never
    // reaches the P&L, which is a large part of why 2026 expenses looked absent.
    // So: recognise the vendor from the bank text where we can and propose the
    // correct category, but ALWAYS flag it. A wrong draw understates expenses,
    // overstates profit, and inflates the tax bill.
    if (/owner\s*draw|retained earnings|opening balance/i.test(acct)) {
      const guess = EXPENSE_MAP.find(([rx]) => rx.test(memo));
      return {
        category: guess ? guess[1] : "UNCATEGORISED",
        confidence: guess ? 0.5 : 0.15,
        needsReview: true,
        reviewNote: guess
          ? `Coded to "${acct}" in QuickBooks, but the description looks like a real business expense. Owner Draw is an equity account, so this never reaches your P&L — if it is business spend it is silently inflating your profit and your tax.`
          : `Coded to "${acct}". If this is genuinely money you took out, it is correct. If it is business spend it is being hidden from the P&L entirely.`,
      };
    }

    if (PERSONAL_ACCT.test(memo) || PERSONAL_ACCT.test(acct)) {
      return {
        category: "OWNER_DRAW", confidence: 0.9, needsReview: false, personal: true,
        reviewNote: "Transfer to the personal ...0942 account. Recorded as an owner draw, not an expense — it must not reduce profit.",
      };
    }
    for (const [rx, cat] of EXPENSE_MAP) {
      if (rx.test(acct)) {
        // Loan principal is not deductible; only the financing fee is. Always ask.
        if (cat === "FINANCING") {
          return {
            category: "FINANCING", confidence: 0.6, needsReview: true,
            reviewNote: "Looks like loan repayment. Only the financing FEE is deductible — principal is not. Confirm the split with your accountant.",
          };
        }
        return { category: cat, confidence: 0.85, needsReview: false };
      }
    }
    return {
      category: "UNCATEGORISED", confidence: 0.2, needsReview: true,
      reviewNote: acct ? `No rule matches the account "${acct}".` : "No account on this expense.",
    };
  }

  // ---- Deposits: where every ambiguity lives ------------------------------
  if (r.type === "Deposit") {
    // Bank fee reversals are not sales.
    if (RX.feeish.test(memo) && !RX.stripe.test(memo)) {
      return { category: "FEE_REFUND", confidence: 0.85, needsReview: false,
        reviewNote: "Bank fee reversal or refund — not customer revenue." };
    }

    // Personal-account movement. Per Jordan: this is EITHER a payout that landed
    // in ...0942 and was forwarded, OR a round trip of his own money. Only an
    // exact amount+date tie to a Stripe payout settles it, and in practice that
    // matches a small minority — so everything else is flagged, never guessed.
    if (PERSONAL_ACCT.test(memo)) {
      const tie = payouts.find((p) => Math.abs(p.amount - r.amount) < 0.02 && days(p.at, r.txnDate) <= 6);
      if (tie) {
        return {
          category: "ALREADY_COUNTED", confidence: 0.9, needsReview: false,
          reviewNote: "Stripe payout that landed in ...0942 and was forwarded to business checking. The revenue is already counted on the Stripe rail — counting this deposit again would double it.",
        };
      }
      return {
        category: "TRANSFER", confidence: 0.35, needsReview: true, personal: true,
        reviewNote: "From the personal ...0942 account with no matching Stripe payout. Could be a forwarded payout (already counted), a round trip of your own money, or an owner contribution. Treated as NOT revenue until you confirm — the safe direction.",
      };
    }

    // A deposit that settles real customer Payments/SalesReceipts is revenue.
    if (r.linkedCount > 0) return { category: "REVENUE", confidence: 0.95, needsReview: false };

    // Unlinked + matches a receipt/payment nearby = the classic double count.
    const twin = peers.find((p) => Math.abs(p.amount - r.amount) < 0.005 && days(p.txnDate, r.txnDate) <= 4);
    if (twin) {
      return {
        category: "DUPLICATE", confidence: 0.8, needsReview: true, duplicateOf: twin.qboId,
        reviewNote: `Same amount as a sales receipt/payment ${days(twin.txnDate, r.txnDate).toFixed(0)} day(s) away, with nothing linking it to a customer. This looks like the same dollar counted twice.`,
      };
    }

    // Stripe payouts are the Stripe rail arriving in the bank — already counted.
    if (RX.stripe.test(memo)) {
      return { category: "ALREADY_COUNTED", confidence: 0.9, needsReview: false,
        reviewNote: "Stripe payout. The underlying charges are already counted on the Stripe rail." };
    }
    // Venmo (Stephen Kennedy) reaches no other rail, so it IS the revenue record.
    if (RX.venmo.test(memo)) {
      return { category: "REVENUE", confidence: 0.8, needsReview: false,
        reviewNote: "Venmo, via the personal Venmo account. Real revenue and counted nowhere else — but the commingling is worth raising with your accountant." };
    }
    if (RX.qbPay.test(memo) || RX.autoGen.test(memo)) {
      return { category: "REVENUE", confidence: 0.75, needsReview: false };
    }
    return {
      category: "UNCATEGORISED", confidence: 0.25, needsReview: true,
      reviewNote: memo ? `Unrecognised deposit: "${memo.slice(0, 90)}"` : "Deposit with no description and no customer link.",
    };
  }

  // Invoices / Payments / SalesReceipts are customer-facing by construction.
  return { category: "REVENUE", confidence: 0.9, needsReview: false };
}

/** Classify every stored transaction and persist the verdicts. */
export async function categoriseBooks(opts: { sinceKey?: string } = {}): Promise<{
  scanned: number; flagged: number; byCategory: Record<string, { n: number; amount: number }>;
}> {
  const since = new Date(`${opts.sinceKey ?? "2024-01-01"}T00:00:00Z`);
  const rows = await prisma.qboTransaction.findMany({ where: { txnDate: { gte: since } } });
  const peers = rows
    .filter((r) => r.type === "SalesReceipt" || r.type === "Payment")
    .map((r) => ({ qboId: r.qboId, amount: r.amount, txnDate: r.txnDate }));
  const payouts = (await prisma.stripeTransaction.findMany({ where: { type: "payout" } }))
    .map((p) => ({ amount: Math.abs(p.gross), at: p.createdAt }));

  const byCategory: Record<string, { n: number; amount: number }> = {};
  let flagged = 0;

  for (const r of rows) {
    const v = classify(r as Row, peers, payouts);
    byCategory[v.category] ||= { n: 0, amount: 0 };
    byCategory[v.category].n++;
    byCategory[v.category].amount += r.amount;
    if (v.needsReview) flagged++;
    await prisma.qboTransaction.update({
      where: { id: r.id },
      data: {
        category: v.category,
        confidence: v.confidence,
        // Never re-flag something already reviewed — an owner decision is final
        // until the underlying row changes.
        needsReview: r.reviewedAt ? false : v.needsReview,
        reviewNote: v.reviewNote ?? null,
        personal: v.personal ?? false,
        duplicateOf: v.duplicateOf ?? null,
      },
    });
  }
  return { scanned: rows.length, flagged, byCategory };
}

/** True revenue / expense / profit, with the noise removed. */
export async function trueProfitAndLoss(startKey: string, endKey: string) {
  const rows = await prisma.qboTransaction.findMany({
    where: { txnDate: { gte: new Date(`${startKey}T00:00:00Z`), lte: new Date(`${endKey}T23:59:59Z`) } },
  });
  const sum = (cats: Category[], types?: string[]) =>
    rows.filter((r) => cats.includes(r.category as Category) && (!types || types.includes(r.type)))
      .reduce((s, r) => s + r.amount, 0);

  // Revenue counts DEPOSITS + SalesReceipts only — never Invoice AND Payment for
  // the same sale, which would double the books all over again.
  //
  // Stripe deposits are classified ALREADY_COUNTED so they cannot double against
  // the Stripe rail — which means the Stripe rail has to be ADDED here or a third
  // of revenue silently disappears. Charges net of refunds, gross of fees: fees
  // are a real cost and belong in expenses, not netted out of the top line.
  const qboRevenue = sum(["REVENUE"], ["Deposit", "SalesReceipt"]);
  const stripeRows = await prisma.stripeTransaction.findMany({
    where: {
      createdAt: { gte: new Date(`${startKey}T00:00:00Z`), lte: new Date(`${endKey}T23:59:59Z`) },
      type: { in: ["charge", "payment", "refund"] },
    },
  });
  const stripeRevenue = stripeRows.reduce((s, r) => s + r.gross, 0);
  const stripeFees = stripeRows.reduce((s, r) => s + r.fee, 0);
  const revenue = qboRevenue + stripeRevenue;

  const qboExpenses = sum(["COST_OF_SALES", "OPERATING", "VEHICLE"], ["Purchase"]);
  const expenses = qboExpenses + stripeFees;
  const ownerDraws = sum(["OWNER_DRAW"], ["Purchase"]);
  const excluded = sum(["DUPLICATE", "TRANSFER", "FEE_REFUND"]);
  // What we genuinely cannot see yet — quoted so no one mistakes this for final.
  const unknown = sum(["UNCATEGORISED"], ["Purchase"]);
  const needsReview = rows.filter((r) => r.needsReview).length;

  return {
    start: startKey, end: endKey,
    revenue, qboRevenue, stripeRevenue,
    expenses, stripeFees, uncategorisedExpenses: unknown,
    profit: revenue - expenses,
    ownerDraws, excludedFromIncome: excluded, needsReview,
  };
}
