// Currency with cents — payouts need the cents (mileage shares, $90.50, etc).
// (utils.formatMoney rounds to whole dollars for headline order totals.)
export function usd(value?: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

// Parse a user-typed money/number string tolerantly. People naturally type
// "$1,200", "1,200", or "725 " into a dollar field, and a bare Number() turns
// all of those into NaN — which the payout override code then read as "nothing
// set" and silently wiped the override. Strip currency symbols, thousands
// separators, and whitespace first; keep digits, one decimal, and a leading
// minus (adjustments can be negative). Returns null for blank/non-numeric input.
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const cleaned = input.replace(/[^0-9.-]/g, "");
  if (!cleaned || !/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
