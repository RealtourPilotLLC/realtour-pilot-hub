// ---------------------------------------------------------------------------
// WHICH BANK BALANCE IS "CASH" (Oct 25 2026, Jordan, on Connections → Banks:
// "I have a lot more cash in my bank than it says. It says the correct total
// 4k something but showing 799").
//
// Plaid gives two balances. `current` is the posted (ledger) balance; for a
// checking or savings account `available` is what the bank says can be spent
// now, after pending deposits and holds, and it is the number the bank's own
// app leads with. Jordan's ··0942 read $798.69 posted and $4,105.02 available,
// and every money screen counted the posted figure. For cash accounts the
// available balance leads; the posted one is said beside it when they differ.
// A card or loan keeps `current`: there it is what is owed.
//
// Pure and import-free, so the Connections card (a client component) and the
// server reads share it.
// ---------------------------------------------------------------------------

export type BankBalances = { type?: string | null; currentBalance: number | null; availableBalance?: number | null };

const isCash = (a: BankBalances) => (a.type ?? "depository") === "depository";

/** The balance to count as cash: available for checking/savings when the bank gives it, else posted. */
export function cashBalanceOf(a: BankBalances): number | null {
  if (isCash(a) && a.availableBalance != null) return a.availableBalance;
  return a.currentBalance;
}

/** The posted balance when it differs from the cash figure by a dollar or more (else null): said beside it. */
export function postedBesideCash(a: BankBalances): number | null {
  const cash = cashBalanceOf(a);
  if (!isCash(a) || cash == null || a.currentBalance == null) return null;
  return Math.abs(cash - a.currentBalance) >= 1 ? a.currentBalance : null;
}
