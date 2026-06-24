import "server-only";

// ---------------------------------------------------------------------------
// FAA UAS Facility Map (LAANC altitude grids) — free ArcGIS service, no key.
// For a property's lat/lng we look up the controlled-airspace cell:
//   • no cell        → Class G uncontrolled → Part 107 OK to 400 ft, no LAANC
//   • cell, ceiling>0 → controlled airspace, LAANC auto-auth up to that ceiling
//   • cell, ceiling 0 → controlled airspace with NO LAANC grid → manual FAA
//                       authorization required (effectively a no-fly for a
//                       same-day shoot) — a real warning for the creative.
// ---------------------------------------------------------------------------

const UASFM =
  "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query";

export type DroneAirspace = {
  status: "clear" | "laanc" | "restricted";
  ceiling: number | null; // LAANC auto-auth ceiling in feet (null = uncontrolled)
  airport: string | null; // controlling airport name
  airspaceClass: string | null; // B/C/D/E
  warning: boolean; // true when the creative should be alerted before flying
  summary: string; // human-readable one-liner
};

type Cell = {
  CEILING?: number;
  APT1_NAME?: string;
  APT1_ICAO?: string;
  AIRSPACE_1?: string;
};

export async function droneAirspace(lat: number, lng: number): Promise<DroneAirspace> {
  try {
    const params = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "CEILING,APT1_NAME,APT1_ICAO,AIRSPACE_1",
      returnGeometry: "false",
      f: "json",
    });
    const res = await fetch(`${UASFM}?${params}`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { features?: { attributes: Cell }[] };
    const cells = (j.features ?? []).map((f) => f.attributes);

    if (cells.length === 0) {
      return {
        status: "clear",
        ceiling: null,
        airport: null,
        airspaceClass: null,
        warning: false,
        summary: "Uncontrolled airspace (Class G) — Part 107 OK to 400 ft, no LAANC needed.",
      };
    }
    // Most restrictive (lowest ceiling) cell wins.
    const cell = cells.sort((a, b) => (a.CEILING ?? 999) - (b.CEILING ?? 999))[0];
    const ceiling = cell.CEILING ?? null;
    const airport = cell.APT1_NAME || cell.APT1_ICAO || null;
    const airspaceClass = cell.AIRSPACE_1 || null;

    if (ceiling === 0) {
      return {
        status: "restricted",
        ceiling: 0,
        airport,
        airspaceClass,
        warning: true,
        summary: `No-fly without authorization — Class ${airspaceClass ?? "?"} near ${airport ?? "an airport"} has a 0 ft LAANC ceiling. Manual FAA authorization required.`,
      };
    }
    return {
      status: "laanc",
      ceiling,
      airport,
      airspaceClass,
      warning: true,
      summary: `LAANC required — controlled (Class ${airspaceClass ?? "?"}) near ${airport ?? "an airport"}. Auto-authorization up to ${ceiling} ft. File LAANC before the shoot.`,
    };
  } catch {
    return {
      status: "clear",
      ceiling: null,
      airport: null,
      airspaceClass: null,
      warning: false,
      summary: "Airspace check unavailable right now.",
    };
  }
}
