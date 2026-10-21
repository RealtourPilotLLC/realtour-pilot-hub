export function usesPortalDelivery(row: { monthlyProgram?: boolean; deliveryDestination?: "client-portal" | "aryeo-listing" }) {
  return row.deliveryDestination ? row.deliveryDestination === "client-portal" : !!row.monthlyProgram;
}
