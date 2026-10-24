import "server-only";

// ---------------------------------------------------------------------------
// ONE LISTING, AS ARYEO DELIVERED IT (Oct 23 2026, /listings/<job>). Jordan:
// "Create listing pages too so we can review the final listings sent out
// just like Aryeo has listings." The photos, videos, floor plans, 3D tours
// and files ON the Aryeo listing are what the client received, so the page
// reads that listing once per open (the same read the job page's Media panel
// makes) and nothing else. Never throws: null means Aryeo did not answer,
// which the page says in words. Only https addresses are kept; nothing is
// made up when a field is missing.
// ---------------------------------------------------------------------------

export type ListingPhoto = { thumb: string; large: string; original: string; caption: string | null; filename: string | null };
export type ListingVideo = { id: string | null; title: string | null; thumb: string | null; file: string | null; duration: number | null };
export type ListingTour = { title: string; url: string; thumb: string | null };
export type ListingFile = { title: string; url: string };

export type AryeoListingView = {
  delivered: boolean | null;
  cover: string | null;
  photos: ListingPhoto[];
  videos: ListingVideo[];
  floorPlans: ListingPhoto[];
  tours: ListingTour[];
  files: ListingFile[];
};

const https = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const pick = <T>(o: Record<string, unknown>, keys: string[], f: (v: unknown) => T | null): T | null => {
  for (const k of keys) {
    const v = f(o[k]);
    if (v != null) return v;
  }
  return null;
};
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** Map Aryeo's listing payload (images, videos, floor_plans, interactive_content, files). Pure, for the drill. */
export function listingViewOf(l: Record<string, unknown>): AryeoListingView {
  const image = (i: Record<string, unknown>): ListingPhoto | null => {
    const original = pick(i, ["original_url", "large_url", "thumbnail_url"], https);
    if (!original) return null;
    return {
      thumb: pick(i, ["thumbnail_url", "large_url", "original_url"], https) ?? original,
      large: pick(i, ["large_url", "original_url", "thumbnail_url"], https) ?? original,
      original,
      caption: text(i.caption),
      filename: text(i.filename),
    };
  };
  const photos = rows(l.images).filter((i) => i.display_in_gallery !== false).map(image).filter((x): x is ListingPhoto => !!x);
  const floorPlans = rows(l.floor_plans).map((f) => {
    const img = image(f);
    return img ? { ...img, caption: img.caption ?? text(f.title) } : null;
  }).filter((x): x is ListingPhoto => !!x);
  const videos = rows(l.videos).map((v) => ({
    id: text(v.id),
    title: text(v.title),
    thumb: https(v.thumbnail_url),
    file: https(v.download_url),
    duration: typeof v.duration === "number" && Number.isFinite(v.duration) ? v.duration : null,
  })).filter((v) => !!v.file || !!v.thumb);
  const tours = rows(l.interactive_content).map((t) => {
    const url = pick(t, ["url", "unbranded_url", "branded_url", "link"], https);
    if (!url) return null;
    const kind = text(t.content_type) ?? text(t.display_type);
    return { title: text(t.title) ?? (kind ? kind.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "3D tour"), url, thumb: https(t.thumbnail_url) };
  }).filter((x): x is ListingTour => !!x);
  const files = rows(l.files).map((f) => {
    const url = pick(f, ["download_url", "url", "original_url", "file_url"], https);
    if (!url) return null;
    return { title: pick(f, ["title", "filename", "name"], text) ?? "File", url };
  }).filter((x): x is ListingFile => !!x);
  const status = text(l.delivery_status);
  return {
    delivered: status ? status === "DELIVERED" : null,
    cover: https(l.large_thumbnail_url) ?? https(l.thumbnail_url) ?? photos[0]?.large ?? null,
    photos, videos, floorPlans, tours, files,
  };
}

export async function readAryeoListing(listingId: string): Promise<AryeoListingView | null> {
  try {
    const { Aryeo } = await import("@/lib/integrations/aryeo");
    const l = await Aryeo.listing(listingId);
    return listingViewOf(l as unknown as Record<string, unknown>);
  } catch (e) {
    console.warn("[listing page] Aryeo listing read failed", listingId, e instanceof Error ? e.message.slice(0, 160) : e);
    return null;
  }
}

/** The staff download proxy for a file on Aryeo's hosts (api/media/download), with a readable name. */
export function aryeoDownloadHref(url: string, name: string): string {
  return `/api/media/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
}
