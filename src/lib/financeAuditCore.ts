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
