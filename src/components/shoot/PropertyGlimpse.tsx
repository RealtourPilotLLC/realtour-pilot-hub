import { ExternalLink } from "lucide-react";

// "What am I walking into?" — a satellite look at the property so the
// photographer can scout the lot before arriving: tree cover, pool, driveway,
// which side the sun hits, where to park. Server component, zero client JS.
//
// Keyless by design: the stack has no Google Maps key (everything map-shaped
// here is OSM/Esri), so we pull a static frame from Esri World Imagery's
// public export endpoint — it returns raw image bytes, no token required.

// ONE place to swap the image source. When a GOOGLE_MAPS_API_KEY lands, point
// this at Google Street View Static (or Maps Static satellite) and nothing
// else on the page moves.
function glimpseSrc(lat: number, lng: number): string {
  // House-lot zoom: ~0.0009° of latitude ≈ 100m of ground height, which frames
  // a suburban house + yard with a little neighbor context. The export service
  // stretches the bbox to the pixel size, so the longitude span is widened by
  // the 16:9 aspect AND the latitude cosine to keep ground pixels square
  // (a degree of longitude shrinks toward the poles).
  const dLat = 0.00045;
  const dLng = (dLat * (640 / 360)) / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].join(",");
  return `https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&size=640,360&f=image`;
}

export function PropertyGlimpse({ lat, lng, address }: {
  lat: number | null;
  lng: number | null;
  address: string;
}) {
  // Not geocoded yet (coords come off the Aryeo listing) — skip quietly rather
  // than render a broken frame.
  if (lat == null || lng == null) return null;

  // Opens their real Maps app — Street View, 3D, live traffic all live there.
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

  return (
    <div className="overflow-hidden rounded-2xl border bg-surface panel-shadow">
      <img
        src={glimpseSrc(lat, lng)}
        alt={`Satellite view of ${address}`}
        width={640}
        height={360}
        loading="lazy"
        className="aspect-video w-full object-cover"
      />
      <div className="flex items-center gap-2 border-t bg-surface-2/40 px-4 py-2">
        <span className="text-xs text-muted">Satellite view · © Esri</span>
        <a
          href={mapsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          Open in Google Maps <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  );
}
