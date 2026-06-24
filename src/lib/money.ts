// Currency with cents — payouts need the cents (mileage shares, $90.50, etc).
// (utils.formatMoney rounds to whole dollars for headline order totals.)
export function usd(value?: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
