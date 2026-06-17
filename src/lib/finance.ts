// Contractor payout rules. Today these are simple percentage-of-order splits;
// when Stripe is wired in, these become editable rules per contractor and drive
// real transfers. Centralized here so the logic has one home.

export const PAYOUT_RULES = {
  // Share of the order total paid to each role for their part of the job.
  photographerPct: 0.3,
  editorPct: 0.12,
};

export function photographerPayout(orderTotal: number | null | undefined) {
  return Math.round((orderTotal ?? 0) * PAYOUT_RULES.photographerPct);
}

export function editorPayout(orderTotal: number | null | undefined) {
  return Math.round((orderTotal ?? 0) * PAYOUT_RULES.editorPct);
}
