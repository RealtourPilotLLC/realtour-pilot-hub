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

export function aryeoOrderUrl(orderId: string): string {
  return `${BASE}/orders/${orderId}`;
}
