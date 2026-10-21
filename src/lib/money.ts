// Currency with cents — payouts need the cents (mileage shares, $90.50, etc).
// (utils.formatMoney rounds to whole dollars for headline order totals.)
export function usd(value?: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

// ---------------------------------------------------------------------------
// THE OTHER SHAPES, NAMED ONCE (Oct 21 2026, audit H16). About twenty screens
// kept a private copy of one of the three below. None prints exactly what
// usd() or utils.formatMoney prints, and a screen must keep printing what it
// printed, so each shape lives here under its own name instead of being folded
// into those two:
//   usd(-1234.5)          "-$1,234.50"  Intl currency, cents
//   formatMoney(-1234.5)  "-$1,235"     Intl currency, whole dollars (half away from zero)
//   usd2(-1234.5)         "$-1,234.50"  the "$" glued to the front of the number
//   usd0(-1234.5)         "$-1,234"     Math.round (half up), "$" glued to the front
//   usd0Signed(-1234.5)   "-$1,234"     Math.round, the sign before the "$"
// ---------------------------------------------------------------------------

/** Two decimals, "$" glued to the front: "$1,234.50", "$-12.00". Payouts, bonuses, shoot pay, photo-fix costs. */
export const usd2 = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whole dollars by Math.round, "$" glued to the front: "$1,995", "$-1,995". The finance and trends cards. */
export const usd0 = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

/** Whole dollars by Math.round, the sign before the "$": "-$1,995". The dashboard's rule for an overdrawn figure read at a glance. */
export const usd0Signed = (n: number): string => {
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US")}`;
};

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
