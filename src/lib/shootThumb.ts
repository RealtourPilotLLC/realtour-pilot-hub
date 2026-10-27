// ---------------------------------------------------------------------------
// THE MY SHOOTS CARD'S PICTURE (lifted out of lib/shoot, Oct 27 2026, so the
// drill and the live check can read it without the server-only module).
//
// Street View Static frame of the property: the "what am I walking into?"
// look for a shoot that hasn't been photographed yet. Needs GOOGLE_MAPS_API_KEY
// (Jordan adds it in Vercel; never in source). Once the listing has photos on
// Aryeo, its first photo (Project.coverImageUrl, kept fresh by the status
// sweep) replaces Street View (Jordan, Oct 27 2026: "once the photos are
// uploaded, the cover photo replaces it").
// Location: COORDS FIRST (radius=250): Google finds the nearest outdoor pano
// within 250m and auto-aims the camera at the point, i.e. at the house.
// outdoor-only skips inside-the-business panos; return_error_code turns a
// genuine miss into a 404 the card can step past, instead of a grey "no
// imagery" placeholder.
//
// WHY A LIST (Oct 27 2026: 2925 N 21st St showed no picture at all). The card
// used to get ONE url: the cover when the job had one, else Street View by
// the coordinates, else by the title; and the <img> hid itself on any miss. A
// dead cover link, coordinates with no outdoor pano near them (a bad geocode),
// or a title with no city each left the card blank. Now: the cover, then
// Street View by the coordinates, then by the full street address (street,
// city, state, zip), then by the title. The card moves to the next one on a
// miss and shows a plain house tile when all of them miss.
//
// Pure and client-safe (it reads the key from the server's environment only
// where it runs; on a client it finds none and offers the cover alone).
// ---------------------------------------------------------------------------

export type ShootThumb = { url: string; kind: "aryeo" | "street" };

export function streetViewSrc(location: string | null): string | null {
  const key = typeof process !== "undefined" ? process.env.GOOGLE_MAPS_API_KEY : undefined;
  if (!key || !location) return null;
  return `https://maps.googleapis.com/maps/api/streetview?size=320x200&location=${encodeURIComponent(location)}&fov=75&radius=250&source=outdoor&return_error_code=true&key=${key}`;
}

/** Every frame worth trying for a card, best first. */
export function shootThumbCandidates(p: {
  coverImageUrl: string | null; lat: number | null; lng: number | null;
  addressLine: string | null; city: string | null; state: string | null; zip: string | null; title: string | null;
}): ShootThumb[] {
  const out: ShootThumb[] = [];
  const add = (url: string | null, kind: ShootThumb["kind"]) => { if (url && !out.some((x) => x.url === url)) out.push({ url, kind }); };
  add(p.coverImageUrl?.trim() || null, "aryeo");
  // 0,0 is "no coordinates", never a place.
  if (p.lat != null && p.lng != null && !(p.lat === 0 && p.lng === 0)) add(streetViewSrc(`${p.lat},${p.lng}`), "street");
  const stateZip = [p.state, p.zip].map((x) => x?.trim()).filter(Boolean).join(" ");
  const full = [p.addressLine?.trim(), p.city?.trim(), stateZip].filter(Boolean).join(", ");
  if (p.addressLine?.trim() && (p.city?.trim() || stateZip)) add(streetViewSrc(full), "street");
  add(streetViewSrc(p.title?.trim() || null), "street");
  return out;
}
