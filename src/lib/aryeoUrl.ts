// Deep links into the Aryeo web app.
//
// NOT app.aryeo.com — that host was wrong and every link in the hub 404'd
// (Jordan, Sep 1). Aryeo serves each company from its own subdomain behind an
// /admin prefix; Jordan's working listing link is:
//   https://realtourpilot.aryeo.com/admin/listings/<listingId>/edit
//
// One place to change if the tenant ever moves, and overridable without a
// deploy via ARYEO_ADMIN_BASE.
const BASE = (process.env.ARYEO_ADMIN_BASE || "https://realtourpilot.aryeo.com/admin").replace(/\/+$/, "");

export function aryeoListingUrl(listingId: string): string {
  return `${BASE}/listings/${listingId}/edit`;
}

// Orders take the same /edit tail: the bare /admin/orders/<id> does not open
// for Kyle, /admin/orders/<id>/edit does (Jordan, Sep 15 — "if he adds /edit
// at the end of the URL it works"). Listings already carried it since Sep 1.
export function aryeoOrderUrl(orderId: string): string {
  return `${BASE}/orders/${orderId}/edit`;
}
