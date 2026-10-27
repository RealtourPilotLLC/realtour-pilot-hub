// ---------------------------------------------------------------------------
// THE BOOKS AUDIT, PURE HALF (Oct 24 2026). The shapes the audit page and the
// task sync share, and how the ledger's categories fold into the groups Jordan
// asked for ("personal, business, investments, etc."). No prisma, no
// server-only. The server half is financeAudit.ts.
// ---------------------------------------------------------------------------

export type AuditStatus = "ok" | "flag" | "gap";
/** One tie-out: does a source reconcile to the next, is it current, is it sorted. */
export type AuditCheck = { key: string; title: string; status: AuditStatus; result: string; detail?: string | null; amount?: number | null; href?: string | null };
/** A fix the audit asks for. `key` is stable while the problem is the same one,
 *  so its task opens once and closes itself when the problem is gone. */
export type AuditAction = { key: string; title: string; why: string; how: string; when: "now" | "monthly"; dueDays: number; amount?: number | null; href?: string | null };

type Row = { category: string; sum: number; count: number };
export type MoneyGroup = { key: "business" | "living" | "debt" | "taxes" | "savings"; label: string; total: number; rows: Row[]; note: string };

/** Loan payments: money owed, not money spent (the car loans, buy-now-pay-later). */
export const DEBT_CATEGORIES = new Set(["Car payment", "Buy-now-pay-later"]);
export const TAX_CATEGORIES = new Set(["Personal taxes"]);

const sum = (rows: Row[]) => Math.round(rows.reduce((s, r) => s + r.sum, 0) * 100) / 100;
const sorted = (rows: Row[]) => [...rows].filter((r) => Math.abs(r.sum) >= 0.5).sort((a, b) => b.sum - a.sum);

export function groupTotals(
  cats: { business: Row[]; personal: Row[]; businessTotal: number },
  stripeCapitalWithheld: number,
  savingsRows: Row[] = [],
): MoneyGroup[] {
  const living = cats.personal.filter((r) => !DEBT_CATEGORIES.has(r.category) && !TAX_CATEGORIES.has(r.category));
  const debt: Row[] = [
    ...cats.personal.filter((r) => DEBT_CATEGORIES.has(r.category)),
    ...(stripeCapitalWithheld > 0 ? [{ category: "Stripe Capital loan (withheld from sales)", sum: stripeCapitalWithheld, count: 0 }] : []),
  ];
  const taxes = cats.personal.filter((r) => TAX_CATEGORIES.has(r.category));
  return [
    { key: "business", label: "Business costs", total: Math.round(cats.businessTotal * 100) / 100, rows: sorted(cats.business), note: "What it cost to run the business: editing, creative pay, software, fees." },
    { key: "living", label: "Personal living", total: sum(living), rows: sorted(living), note: "The household: rent, nanny, food, shopping, car, health." },
    { key: "debt", label: "Debt payments", total: sum(debt), rows: sorted(debt), note: "Loan repayments. Not a cost of the business, but cash that's gone." },
    { key: "taxes", label: "Taxes", total: sum(taxes), rows: sorted(taxes), note: "Income tax payments found in the accounts." },
    { key: "savings", label: "Savings & investments", total: sum(savingsRows), rows: sorted(savingsRows), note: "Money moved to savings, retirement or investment accounts." },
  ];
}

export const STATUS_WORDS: Record<AuditStatus, string> = { ok: "Ties out", flag: "Look at this", gap: "Missing" };

/**
 * QuickBooks Payments deposits the bank received that QuickBooks has no
 * record of. A deposit is recorded when one QuickBooks payment, sales receipt
 * or deposit of the same amount sits within a week of it, or when two to four
 * payments in that week add up to it: Intuit batches a day's charges into one
 * deposit, so $4,297 recorded as $2,798 + $1,499 is recorded. Deposits under
 * $100 (Intuit's account-verification pennies) are ignored. Bank amounts are
 * negative for money in (Plaid's sign).
 */
export function unrecordedDeposits<B extends { amount: number; date: Date }>(
  bank: B[],
  qbo: { amount: number; txnDate: Date; type: string }[],
  windowDays = 7,
): B[] {
  const W = windowDays * 86_400_000;
  const cents = (n: number) => Math.round(n * 100);
  return bank.filter((b) => {
    const want = cents(-b.amount);
    if (want < 10_000) return false;
    const near = qbo.filter((q) => Math.abs(q.txnDate.getTime() - b.date.getTime()) <= W);
    if (near.some((q) => cents(q.amount) === want)) return false;
    const parts = near.filter((q) => q.type !== "Deposit" && q.amount > 0 && cents(q.amount) < want).map((q) => cents(q.amount)).slice(0, 24);
    const hit = (from: number, left: number, depth: number): boolean => {
      if (left === 0) return depth >= 2;
      if (depth === 4) return false;
      for (let i = from; i < parts.length; i++) if (parts[i] <= left && hit(i + 1, left - parts[i], depth + 1)) return true;
      return false;
    };
    return !hit(0, want, 0);
  });
}

/**
 * How much of each unrecorded deposit QuickBooks has NOT counted (Oct 26
 * 2026). Jordan, of the Oct 3 deposit: "Include this the amount from this in
 * my QuickBooks revenue." A deposit unrecordedDeposits flags can still hold a
 * payment QuickBooks did record, batched by Intuit with charges QuickBooks
 * never saw. So the recorded payments the other deposits account for are set
 * aside first (one of the same amount, else two to four that add up), and any
 * recorded payment left over, dated on or before the flagged deposit and
 * within the window, is taken to be inside it and comes off: the deposit is
 * counted, that payment is not counted twice. October 2026: $4,297 arrived
 * Oct 3 and $1,499 Oct 6; QuickBooks recorded two $1,499 payments; one is the
 * Oct 6 deposit, the other sits in the $4,297, so $2,798 is new.
 */
export function uncountedDepositParts<B extends { amount: number; date: Date }>(
  bank: B[],
  qbo: { amount: number; txnDate: Date; type: string }[],
  windowDays = 7,
): { deposit: B; uncounted: number; alreadyRecorded: number }[] {
  const W = windowDays * 86_400_000;
  const cents = (n: number) => Math.round(n * 100);
  const missing = new Set(unrecordedDeposits(bank, qbo, windowDays));
  const pool = qbo
    .filter((q) => q.type !== "Deposit" && q.amount > 0)
    .sort((a, b) => a.txnDate.getTime() - b.txnDate.getTime());
  const used = new Set<number>();
  const open = (b: B, before = false) =>
    pool.map((q, i) => ({ q, i })).filter(({ q, i }) =>
      !used.has(i) && Math.abs(q.txnDate.getTime() - b.date.getTime()) <= W && (!before || q.txnDate.getTime() <= b.date.getTime() + 86_400_000));
  const byDate = [...bank].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const b of byDate) {
    if (missing.has(b)) continue;
    const want = cents(-b.amount);
    const near = open(b).slice(0, 24);
    const one = near.find(({ q }) => cents(q.amount) === want);
    if (one) { used.add(one.i); continue; }
    const pick: number[] = [];
    const hit = (from: number, left: number): boolean => {
      if (left === 0) return pick.length >= 2;
      if (pick.length === 4) return false;
      for (let k = from; k < near.length; k++) {
        const c = cents(near[k].q.amount);
        if (c > left) continue;
        pick.push(near[k].i);
        if (hit(k + 1, left - c)) return true;
        pick.pop();
      }
      return false;
    };
    if (hit(0, want)) for (const i of pick) used.add(i);
  }
  return byDate.filter((b) => missing.has(b)).map((b) => {
    const want = cents(-b.amount);
    let left = want;
    for (const { q, i } of open(b, true)) {
      const c = cents(q.amount);
      if (c <= left) { used.add(i); left -= c; }
    }
    return { deposit: b, uncounted: left / 100, alreadyRecorded: (want - left) / 100 };
  });
}
