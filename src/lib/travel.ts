import "server-only";

// ---------------------------------------------------------------------------
// Free geo services — no API key required:
//   • OSRM public router → driving distance + (typical, non-traffic) duration
//   • Nominatim (OpenStreetMap) → geocode a free-text address to lat/lng
//   • Open-Meteo → weather for a lat/lng at a given time
// Live-traffic drive times would require a Google/Mapbox key (future upgrade).
// ---------------------------------------------------------------------------

export const MILEAGE_RATE = 0.65; // $/mile paid to creatives
export const HOME_RADIUS_MI = 35; // unpaid radius around home (each way)

const M_PER_MILE = 1609.344;

export type DriveInfo = { miles: number; minutes: number; cost: number };

// Straight-line miles (fallback when routing is unavailable).
export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.7613; // miles
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Driving distance + typical duration via the public OSRM server.
export async function driveBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): Promise<DriveInfo | null> {
  try {
    // Ask for alternatives and pick the SHORTEST-distance route — creatives are
    // paid per mile, so mileage uses the fewest-miles route, not the fastest
    // (which favors longer highway runs). OSRM always includes the fastest route
    // among the alternatives; we choose the minimum-distance one.
    const url = `https://router.project-osrm.org/route/v1/driving/${aLng},${aLat};${bLng},${bLat}?overview=false&alternatives=3`;
    // 5s timeout so a stalled OSRM never hangs payouts (mileage routes a leg per
    // stop, serially) — on timeout we fall through to the straight-line estimate.
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { routes?: { distance: number; duration: number }[] };
    const routes = j.routes ?? [];
    if (routes.length === 0) return null;
    const r = routes.reduce((best, cur) => (cur.distance < best.distance ? cur : best), routes[0]);
    const miles = r.distance / M_PER_MILE;
    return { miles, minutes: r.duration / 60, cost: miles * MILEAGE_RATE };
  } catch {
    // Fall back to straight-line distance with a rough road factor.
    const miles = haversineMiles(aLat, aLng, bLat, bLng) * 1.25;
    if (!isFinite(miles)) return null;
    return { miles, minutes: (miles / 35) * 60, cost: miles * MILEAGE_RATE };
  }
}

/**
 * DRIVE TIME FOR A SCHEDULING DECISION (§6.6 W02, Sep 25 2026) — strict.
 *
 * driveBetween above answers a PAY question, so when OSRM stalls it falls back
 * to a straight-line guess: a mileage line is better roughly right than
 * missing. A slot offered to a client is the opposite case. A guessed drive
 * that says "fits" is a creative sent across the county with no time to get
 * there, so this one never guesses: OSRM answers within 5 seconds, or the
 * answer is null and the caller labels the slot "travel not checked" (a
 * person confirms it; it is never auto-booked).
 *
 * The FASTEST route's duration, not the shortest distance — the question is
 * "can they be there by then", not "what do we owe per mile". No live traffic
 * (the public router has none); the 15-minute buffer the caller adds is what
 * absorbs that.
 */
export async function driveMinutesStrict(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): Promise<{ minutes: number; miles: number } | null> {
  if (![aLat, aLng, bLat, bLng].every((x) => typeof x === "number" && isFinite(x))) return null;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${aLng},${aLat};${bLng},${bLat}?overview=false&alternatives=false`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { code?: string; routes?: { distance: number; duration: number }[] };
    const r = j.routes?.[0];
    if (!r || !isFinite(r.duration)) return null;
    return { minutes: r.duration / 60, miles: r.distance / M_PER_MILE };
  } catch {
    return null;
  }
}

// The full driving-route geometry through an ordered list of waypoints (home →
// shoots → home), as [lat, lng] pairs for a Leaflet polyline. One OSRM call for
// the whole day. Returns null on failure so the caller can fall back to straight
// lines between the stops.
export async function dayRouteGeometry(points: { lat: number; lng: number }[]): Promise<[number, number][] | null> {
  if (points.length < 2) return null;
  // Hard timeout: the public OSRM server can stall, and this sits inside a
  // streamed Suspense boundary — we'd rather fall back to straight lines than
  // hang the map. 6s is plenty for a normal response.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { routes?: { geometry?: { coordinates?: [number, number][] } }[] };
    const g = j.routes?.[0]?.geometry?.coordinates;
    if (!g?.length) return null;
    return g.map(([lng, lat]) => [lat, lng] as [number, number]); // GeoJSON is [lng,lat]; Leaflet wants [lat,lng]
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Geocode a free-text US address. Tries the US Census geocoder FIRST (free, no
// key, excellent on exact street addresses — Nominatim often misses rural/exurban
// house numbers like "223 Ridge Rd, Spring City, PA"), then falls back to
// Nominatim for places/landmarks the Census set doesn't cover.
export async function geocodeAddress(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const query = q.trim();
  if (!query) return null;
  return (await censusGeocode(query)) ?? (await nominatimGeocode(query));
}

async function censusGeocode(query: string): Promise<{ lat: number; lng: number; label: string } | null> {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(query)}&benchmark=Public_AR_Current&format=json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: { addressMatches?: { coordinates?: { x: number; y: number }; matchedAddress?: string }[] } };
    const m = j?.result?.addressMatches?.[0];
    if (!m?.coordinates) return null;
    return { lat: m.coordinates.y, lng: m.coordinates.x, label: m.matchedAddress ?? query };
  } catch {
    return null;
  }
}

async function nominatimGeocode(query: string): Promise<{ lat: number; lng: number; label: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "RealTourPilot-OpsHub/1.0 (ops@realtourpilot.com)" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    const hit = j[0];
    if (!hit) return null;
    return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), label: hit.display_name };
  } catch {
    return null;
  }
}

// Address autocomplete (OpenStreetMap Nominatim). Returns up to `limit`
// candidates for a partial query — powers the "distance to an address" typeahead.
// US-only and short queries are skipped to stay within Nominatim's usage policy.
export async function suggestAddresses(
  q: string,
  limit = 5,
): Promise<{ lat: number; lng: number; label: string }[]> {
  const query = q.trim();
  if (query.length < 3) return [];
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&countrycodes=us&limit=${limit}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "RealTourPilot-OpsHub/1.0 (ops@realtourpilot.com)" },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    return j
      .map((h) => ({ lat: parseFloat(h.lat), lng: parseFloat(h.lon), label: h.display_name }))
      .filter((h) => isFinite(h.lat) && isFinite(h.lng));
  } catch {
    return [];
  }
}

// Mileage pay for ONE day: $0.65/mi for miles beyond the 35-mi home radius each
// way (i.e. subtract 70 mi/day). Zero if the day stays inside the radius.
export function dailyMileagePay(totalMilesForDay: number): { paidMiles: number; pay: number } {
  const paidMiles = Math.max(0, totalMilesForDay - HOME_RADIUS_MI * 2);
  return { paidMiles, pay: paidMiles * MILEAGE_RATE };
}

// ---- Weather (Open-Meteo, free) -------------------------------------------
const WEATHER_LABEL: Record<number, string> = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + hail",
};

export type Weather = { tempF: number; label: string; code: number; emoji: string };

function weatherEmoji(code: number): string {
  if (code === 0 || code === 1) return "☀️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code >= 45 && code <= 48) return "🌫️";
  if (code >= 51 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

// Weather at a lat/lng for a specific time. Open-Meteo covers ~16 days forward
// and recent past; returns null outside that window.
export async function weatherAt(lat: number, lng: number, iso: string): Promise<Weather | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America%2FNew_York&past_days=7&forecast_days=16`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { hourly?: { time: string[]; temperature_2m: number[]; weather_code: number[] } };
    const h = j.hourly;
    if (!h?.time?.length) return null;
    // Find the forecast hour closest to the target time.
    const target = new Date(iso).getTime();
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < h.time.length; i++) {
      const d = Math.abs(new Date(h.time[i]).getTime() - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    if (bestDiff > 1000 * 60 * 60 * 24) return null; // no data within a day
    const code = h.weather_code[best];
    return { tempF: Math.round(h.temperature_2m[best]), label: WEATHER_LABEL[code] ?? "—", code, emoji: weatherEmoji(code) };
  } catch {
    return null;
  }
}
