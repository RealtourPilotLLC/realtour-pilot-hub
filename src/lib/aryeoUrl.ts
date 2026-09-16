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

// ONE answer to "where does this job open in Aryeo": the listing editor when
// the job has a listing, the order editor otherwise, nothing when it has
// neither. The project page and Ask the Hub wrote this expression inline
// (f825f0c); the home tower and QC card only ever knew the listing, so an
// order-only job (39 Saratoga Ln, imported from a ghost order before its
// listing existed) had an Aryeo button on its project page and none on the
// home (Kyle call, Sep 16 — Item 8 residual). Every surface now asks here.
export function aryeoJobUrl(p: { aryeoListingId?: string | null; aryeoOrderId?: string | null }): string | null {
  if (p.aryeoListingId) return aryeoListingUrl(p.aryeoListingId);
  if (p.aryeoOrderId) return aryeoOrderUrl(p.aryeoOrderId);
  return null;
}

/** The button title that matches aryeoJobUrl's choice. */
export function aryeoJobTitle(p: { aryeoListingId?: string | null; aryeoOrderId?: string | null }): string {
  return p.aryeoListingId ? "Open the listing in Aryeo" : "Open the order in Aryeo";
}
