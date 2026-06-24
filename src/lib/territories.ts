// Service territories — the real polygons drawn in Aryeo (Settings → Territories
// of Service). Aryeo only exposes these through its logged-in dashboard (the
// /admin/territories Inertia page), NOT the public API, so we capture them into
// a versioned JSON snapshot (`data/aryeoTerritories.json`) that mirrors Aryeo.
// Re-sync = re-pull that page and update the JSON (territories change rarely).
//
// IMPORTANT: a territory is the AREA WE SERVE — it is NOT the same as a
// creative's no-mileage radius. The radius is where a creative travels without
// travel pay; the territory is the whole region we cover (mileage applies past
// the radius but still inside the territory). See [[reference-payroll]] / the
// mileage tracker for the pay side.
import data from "@/lib/data/aryeoTerritories.json";

export type Territory = {
  uuid: string;
  name: string;
  color: string; // Aryeo's own territory color (hex)
  members: string[]; // creative names assigned to this territory in Aryeo
  rings: [number, number][][]; // polygon rings as [lat, lng] (Leaflet order)
};

// Aryeo stores GeoJSON coordinates as [lng, lat]; Leaflet + our point-in-polygon
// test both want [lat, lng], so flip once here.
export function getTerritories(): Territory[] {
  return data.territories.map((t) => ({
    uuid: t.uuid,
    name: t.name,
    color: t.color,
    members: t.members.map((m) => m.name),
    rings: t.coordinates.map((ring) => ring.map((c) => [c[1], c[0]] as [number, number])),
  }));
}

// Ray-casting point-in-polygon for a single ring. point + ring are [lat, lng].
export function pointInRing(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const latI = ring[i][0], lngI = ring[i][1];
    const latJ = ring[j][0], lngJ = ring[j][1];
    const crosses = latI > lat !== latJ > lat;
    if (crosses && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI) {
      inside = !inside;
    }
  }
  return inside;
}

// A point is in a territory if it falls in any of its rings (our data has one
// outer ring each; even-odd would also handle holes if Aryeo ever adds them).
export function pointInTerritory(lat: number, lng: number, t: Territory): boolean {
  return t.rings.some((ring) => pointInRing(lat, lng, ring));
}

export function territoriesContaining(lat: number, lng: number, all: Territory[]): Territory[] {
  return all.filter((t) => pointInTerritory(lat, lng, t));
}

// Does this creative (by name) cover this territory?
export function covers(territory: Territory, photographerName: string | null | undefined): boolean {
  if (!photographerName) return false;
  const n = photographerName.toLowerCase().trim();
  return territory.members.some((m) => m.toLowerCase().trim() === n);
}
