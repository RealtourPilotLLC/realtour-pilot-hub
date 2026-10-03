export function usesPortalDelivery(row: { monthlyProgram?: boolean; deliveryDestination?: "client-portal" | "aryeo-listing" }) {
  return row.deliveryDestination ? row.deliveryDestination === "client-portal" : !!row.monthlyProgram;
}

export function destinationReceiptHeaders(submissionId: string, fingerprint: string) {
  return { "Cache-Control": "private, no-store", "X-RTP-Video-Destination": encodeURIComponent(JSON.stringify({ submissionId, fingerprint, destination: "aryeo-listing" })) };
}

export function confirmedAryeoDestination(response: Response, submissionId: string, fingerprint: string): boolean {
  if (!response.ok || response.redirected) return false;
  try {
    const data = JSON.parse(decodeURIComponent(response.headers.get("X-RTP-Video-Destination") ?? ""));
    return data.submissionId === submissionId && data.fingerprint === fingerprint && data.destination === "aryeo-listing";
  } catch { return false; }
}
