// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: A FILMING ADDRESS NO FREE MAP KNEW (Oct 29 2026). Joe Sutow saved
// 322 Morris St, Newtown Square (a new build): the Census and OpenStreetMap
// both missed it, the plan was saved off the map, and his portal offered no
// times. Jordan: "Can we have an auto address detection and a way to add it
// manually as well?" Now:
//   1  Google answers an exact address the free maps miss (ROOFTOP or on the
//      block, the house number asked for); a street, a town or another house
//      number is not an address; a refused key falls through to the free maps
//      and is written down without the key
//   2  suggestions as the client types: Google's (place id, filled from Place
//      Details) or OpenStreetMap's (filled at once), US only, house numbers only
//   3  a pasted Google Maps link or the right-click numbers place the plan by
//      hand; the wrong town is refused; the version stands
//   4  "Look it up again" and the hourly retry (12 hours apart, open months)
//   5  the staff panel shows Not on the map with both forms; Kyle's booking
//      task says why there were no times
//   6  the portal form carries the lookup above the boxes
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6996). Production is never opened; every outbound call is canned or fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const PORT = Number(process.env.DRILL_PORT ?? 6996);
const KEY = "AIzaDRILLdrillDRILLdrillDRILLdrill12345";
process.env.GOOGLE_MAPS_API_KEY = KEY;

// What the outside answers, switchable per section.
let google: "ok" | "denied" | "none" = "ok";
const seen: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const MORRIS = { lat: 39.968416, lng: -75.460974 };
const fence = fenceFetch(async (url, init) => {
  seen.push(url);
  if (url.startsWith("https://geocoding.geo.census.gov/")) {
    // The Census knows the town's main road, never the new build.
    return json({ result: { addressMatches: decodeURIComponent(url).includes("1 Main St") ? [{ coordinates: { x: -75.40, y: 39.98 }, matchedAddress: "1 MAIN ST, NEWTOWN SQUARE, PA, 19073" }] : [] } });
  }
  if (url.startsWith("https://nominatim.openstreetmap.org/search")) {
    const q = decodeURIComponent(url);
    if (/q=Newtown Square, PA 19073/.test(q)) return json([{ lat: "39.9868117", lon: "-75.4007633", display_name: "Newtown Square, Delaware County, Pennsylvania, 19073" }]);
    if (/q=Doylestown, PA 18901/.test(q)) return json([{ lat: "40.3101", lon: "-75.1299", display_name: "Doylestown" }]);
    return json([]);
  }
  if (url.startsWith("https://maps.googleapis.com/maps/api/geocode/json")) {
    if (google === "denied") return json({ status: "REQUEST_DENIED", error_message: "This API project is not authorized to use this API.", results: [] });
    const q = decodeURIComponent(new URL(url).searchParams.get("address") ?? "");
    if (/^322 Morris St/i.test(q)) return json({ status: "OK", results: [{ types: ["premise"], formatted_address: "322 Morris St, Newtown Square, PA 19073, USA", geometry: { location: MORRIS, location_type: "ROOFTOP" }, address_components: [{ long_name: "322", short_name: "322", types: ["street_number"] }] }] });
    if (/^9 Morris St/i.test(q)) return json({ status: "OK", results: [{ types: ["premise"], formatted_address: "322 Morris St", geometry: { location: MORRIS, location_type: "ROOFTOP" }, address_components: [{ long_name: "322", short_name: "322", types: ["street_number"] }] }] });
    if (/^Newtown Square/i.test(q)) return json({ status: "OK", results: [{ types: ["locality", "political"], geometry: { location: { lat: 39.98, lng: -75.40 }, location_type: "APPROXIMATE" } }] });
    return json({ status: "ZERO_RESULTS", results: [] });
  }
  if (url === "https://places.googleapis.com/v1/places:autocomplete") {
    if (google === "denied") return json({ error: { message: "Places API (New) has not been used in project 1 before or it is disabled." } }, 403);
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string; sessionToken?: string };
    if (!body.sessionToken) return json({ error: { message: "no session" } }, 400);
    return json({ suggestions: [
      { placePrediction: { placeId: "ChIJmorris322xxxxxxxx", text: { text: "322 Morris St, Newtown Square, PA, USA" } } },
      { placePrediction: { placeId: "ChIJtownxxxxxxxxxxxxx", text: { text: "Morristown, NJ, USA" } } },
    ] });
  }
  if (url.startsWith("https://places.googleapis.com/v1/places/ChIJmorris322")) {
    return json({ formattedAddress: "322 Morris St, Newtown Square, PA 19073, USA", addressComponents: [
      { longText: "322", shortText: "322", types: ["street_number"] },
      { longText: "Morris Street", shortText: "Morris St", types: ["route"] },
      { longText: "Newtown Square", shortText: "Newtown Square", types: ["locality", "political"] },
      { longText: "Pennsylvania", shortText: "PA", types: ["administrative_area_level_1", "political"] },
      { longText: "19073", shortText: "19073", types: ["postal_code"] },
    ] });
  }
  if (url.startsWith("https://photon.komoot.io/api/")) {
    return json({ features: [
      { properties: { housenumber: "117", street: "Kyle Lane", city: "Malvern", state: "Pennsylvania", postcode: "19355", countrycode: "US" } },
      { properties: { housenumber: "117", street: "Kyle Lane", city: "Malvern", state: "Pennsylvania", postcode: "19355", countrycode: "US" } },
      { properties: { street: "Kyle Lane", city: "Malvern", state: "Pennsylvania", countrycode: "US" } },
      { properties: { housenumber: "5", street: "Kyle Road", city: "Toronto", state: "Ontario", countrycode: "CA" } },
    ] });
  }
  if (url === "https://maps.app.goo.gl/MorrisDrill") return new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/place/322+Morris+St/@39.9690,-75.4620,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d39.968416!4d-75.460974" } });
  return null;
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  process.env.GOOGLE_MAPS_API_KEY = KEY; // after the boot, which clears the real environment's keys
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const travel = await import("@/lib/travel");
    const addr = await import("@/lib/sessionAddress");
    const { mapsStatus } = await import("@/lib/mapsStatus");

    // ======================================================================
    c.head("1 · Google finds what the free maps miss");
    // ======================================================================
    google = "ok";
    const hit = await travel.geocodeAddress("322 Morris St, Newtown Square, PA 19073");
    c.ok("Joe's new build is found, by Google, at the house", !!hit && hit.source === "google" && Math.abs(hit.lat - MORRIS.lat) < 1e-6 && Math.abs(hit.lng - MORRIS.lng) < 1e-6, JSON.stringify(hit));
    c.ok("…after the Census was asked first", seen.findIndex((u) => u.includes("census.gov")) < seen.findIndex((u) => u.includes("maps.googleapis.com")));
    const mark = seen.length;
    const census = await travel.geocodeAddress("1 Main St, Newtown Square, PA 19073");
    c.ok("an address the Census knows is still the Census's (Google is not asked)", census?.source === "census" && !seen.slice(mark).some((u) => u.includes("maps.googleapis.com")), JSON.stringify(census));
    c.ok("another house number is not this address", (await travel.geocodeAddress("9 Morris St, Newtown Square, PA 19073")) === null);
    const g = (o: Record<string, unknown>) => travel.googleExact({ types: ["street_address"], geometry: { location: MORRIS, location_type: "ROOFTOP" }, address_components: [{ long_name: "322", short_name: "322", types: ["street_number"] }], ...o } as never, "322 Morris St");
    c.ok("exact means: the house (ROOFTOP) or its place on the block", g({}) && g({ geometry: { location: MORRIS, location_type: "RANGE_INTERPOLATED" } }));
    c.ok("…never a town's middle or the street's", !g({ geometry: { location: MORRIS, location_type: "APPROXIMATE" } }) && !g({ geometry: { location: MORRIS, location_type: "GEOMETRIC_CENTER" } }) && !g({ types: ["route"] }) && !g({ types: ["locality", "political"] }));
    google = "denied";
    const before = seen.length;
    const denied = await travel.geocodeAddress("322 Morris St, Newtown Square, PA 19073");
    c.ok("a refused key falls through to the free maps (no crash, no answer invented)", denied === null && seen.slice(before).some((u) => u.includes("nominatim")));
    const st = await mapsStatus();
    c.ok("the refusal is written down in Google's words", st.geocode?.ok === false && /REQUEST_DENIED: This API project is not authorized/.test(st.geocode.detail), JSON.stringify(st));
    c.ok("…and the key itself never is", !JSON.stringify(st).includes(KEY));
    google = "ok";

    // ======================================================================
    c.head("2 · suggestions as the client types");
    // ======================================================================
    const sug = await travel.suggestFilmingAddresses("322 Morris", "sess-drill-0001");
    c.ok("Google's suggestions come back, addresses only (a town is dropped)", sug.length === 1 && sug[0].id === "g:ChIJmorris322xxxxxxxx" && sug[0].label === "322 Morris St, Newtown Square, PA" && sug[0].parts === null, JSON.stringify(sug));
    const parts = await travel.resolveFilmingAddress(sug[0].id, "sess-drill-0001");
    c.ok("a pick fills the five boxes from Place Details", JSON.stringify(parts) === JSON.stringify({ street: "322 Morris St", unit: "", city: "Newtown Square", state: "PA", zip: "19073" }), JSON.stringify(parts));
    c.ok("three letters ask nothing", (await travel.suggestFilmingAddresses("322", "sess-drill-0001")).length === 0);
    google = "denied";
    const osm = await travel.suggestFilmingAddresses("117 Kyle", "sess-drill-0002");
    c.ok("with Google refused, OpenStreetMap suggests (filled at once, state as two letters)", osm.length === 1 && osm[0].label === "117 Kyle Lane, Malvern, PA 19355" && osm[0].parts?.state === "PA" && osm[0].parts?.zip === "19355", JSON.stringify(osm));
    c.ok("…no duplicates, no street without a house number, nothing outside the US", osm.every((s) => /^\d/.test(s.label)) && !osm.some((s) => /Toronto/.test(s.label)));
    google = "ok";
    c.ok("state names read as codes", travel.stateCodeOf("Pennsylvania") === "PA" && travel.stateCodeOf("pa") === "PA" && travel.stateCodeOf("Narnia") === "");

    // ======================================================================
    c.head("3 · placed by hand");
    // ======================================================================
    c.ok("the right-click numbers", JSON.stringify(addr.parseMapPoint("39.96841, -75.46097")) === JSON.stringify({ lat: 39.96841, lng: -75.46097 }));
    const link = "https://www.google.com/maps/place/322+Morris+St/@39.9690,-75.4620,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d39.968416!4d-75.460974";
    c.ok("a place link: the pin, not the map's middle", JSON.stringify(addr.parseMapPoint(link)) === JSON.stringify({ lat: 39.968416, lng: -75.460974 }));
    c.ok("a view-only link: its middle", JSON.stringify(addr.parseMapPoint("https://www.google.com/maps/@39.9690,-75.4620,17z")) === JSON.stringify({ lat: 39.969, lng: -75.462 }));
    c.ok("a q= link", JSON.stringify(addr.parseMapPoint("https://maps.google.com/?q=39.9684,-75.4610")) === JSON.stringify({ lat: 39.9684, lng: -75.461 }));
    c.ok("not a point: words, a ZIP, a point off the US", addr.parseMapPoint("322 Morris St") === null && addr.parseMapPoint("19073") === null && addr.parseMapPoint("51.5072, -0.1276") === null && addr.parseMapPoint("") === null);

    const cl = await prisma.client.create({ data: { name: "Morris Agent" } as never });
    const en = await prisma.contentEnrollment.create({ data: { clientId: cl.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, startedAt: new Date("2026-09-01T04:00:00Z") } as never });
    const mo = await prisma.contentMonth.create({ data: { enrollmentId: en.id, clientId: cl.id, monthKey: "2026-11", videosOwed: 4 } });
    const old = await prisma.contentMonth.create({ data: { enrollmentId: en.id, clientId: cl.id, monthKey: "2026-06", videosOwed: 4, historical: true } });
    const plan = (monthId: string, n: number, street = "Morris St", num = "322") => prisma.programSessionPlan.create({ data: {
      enrollmentId: en.id, clientId: cl.id, monthId, sessionIndex: n, streetNumber: num, streetName: street, city: "Newtown Square", stateCode: "PA", postalCode: "19073",
      geocodeSource: "MISS", addressVersion: 1, lastStep: "ADDRESS",
    } });
    const P = await plan(mo.id, 1);
    c.ok("the plan starts off the map, so no times", !addr.planBookable(P));
    const far = await addr.pinSessionPlan(P.id, "40.3101, -75.1299", "kyle@realtourpilot.com");
    const farRow = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: P.id } });
    c.ok("a point in Doylestown for a Newtown Square house is refused as the wrong house", !far.ok && /miles from Newtown Square/.test(far.message) && farRow.latitude === null && /^Not placed: /.test(farRow.mapNote ?? ""), far.message);
    const junk = await addr.pinSessionPlan(P.id, "the grey house past the barn", "kyle@realtourpilot.com");
    c.ok("words with no point say how to copy one", !junk.ok && /right-click the house/.test(junk.message));
    const short = await addr.pinSessionPlan(P.id, "https://maps.app.goo.gl/MorrisDrill", "kyle@realtourpilot.com");
    const placed = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: P.id } });
    c.ok("a shared short link is followed to its pin and placed", short.ok && placed.latitude === 39.968416 && placed.longitude === -75.460974, short.message);
    c.ok("…marked placed by hand, by whom, with the version unchanged", placed.geocodeSource === "MANUAL" && placed.geocodeBy === "kyle@realtourpilot.com" && placed.addressVersion === 1 && /Placed by hand by kyle@/.test(placed.mapNote ?? ""));
    c.ok("…and the plan now offers times", addr.planBookable(placed));
    c.ok("only Google's own hosts are ever followed", !seen.some((u) => !/^https:\/\/(geocoding\.geo\.census\.gov|nominatim\.openstreetmap\.org|maps\.googleapis\.com|places\.googleapis\.com|photon\.komoot\.io|maps\.app\.goo\.gl|www\.google\.com)\//.test(u)), seen.filter((u) => !/googleapis|census|nominatim|photon|goo\.gl|google\.com/.test(u)).join());
    const evil = await addr.pinSessionPlan(P.id, "https://example.com/redirect?to=maps", "kyle@realtourpilot.com");
    c.ok("a link to anywhere else is not fetched", !evil.ok && !seen.some((u) => u.includes("example.com")));

    // ======================================================================
    c.head("4 · looked up again, and the hourly retry");
    // ======================================================================
    const Q = await plan(mo.id, 2);
    const again = await addr.relookupSessionPlan(Q.id);
    const qRow = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: Q.id } });
    c.ok("\"Look it up again\" places it once a map has it (Google here)", again.ok && qRow.geocodeSource === "GEOCODED" && qRow.latitude === MORRIS.lat && qRow.mapNote === "Found on Google Maps.", JSON.stringify({ again, note: qRow.mapNote }));
    const R = await plan(mo.id, 3, "Ventry Way", "14");
    const H = await plan(old.id, 1, "Ventry Way", "14");
    const t0 = new Date();
    const r1 = await addr.relookupUnplacedPlans({ now: t0 });
    const rRow = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: R.id } });
    c.ok("the retry tries an open month's miss and writes down the try", r1.tried === 1 && r1.placed === 0 && rRow.geocodeTriedAt?.getTime() === t0.getTime() && /^Not found on any map/.test(rRow.mapNote ?? ""), JSON.stringify(r1));
    c.ok("…never a past (historical) month's", (await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: H.id } })).geocodeTriedAt === null);
    c.ok("…waits 12 hours before trying it again", (await addr.relookupUnplacedPlans({ now: new Date(t0.getTime() + 11 * 3_600_000) })).tried === 0 && (await addr.relookupUnplacedPlans({ now: new Date(t0.getTime() + 13 * 3_600_000) })).tried === 1);
    c.ok("the hourly sync runs it", /step\("sessionPlanMaps"[\s\S]{0,200}relookupUnplacedPlans\(\{ max: 5 \}\)/.test(read("src/app/api/cron/sync/route.ts")));

    // ======================================================================
    c.head("5 · the staff panel and Kyle's task");
    // ======================================================================
    const { SessionsPanel } = await import("@/components/content/SessionsPanel");
    const tree = await SessionsPanel({ enrollmentId: en.id, monthId: mo.id });
    const ph = tree ? renderToStaticMarkup(tree) : "";
    c.ok("Not on the map lists the address still off it, and only that one", ph.includes("Not on the map") && ph.includes(`data-off-map="${R.id}"`) && !ph.includes(`data-off-map="${P.id}"`) && ph.includes("14 Ventry Way"), ph.slice(0, 200));
    c.ok("…with the paste box and Look it up again", /name="op" value="planPin"/.test(ph) && /name="point"/.test(ph) && /name="op" value="planRelookup"/.test(ph) && ph.includes("Look it up again"));
    c.ok("…and what the last try said", ph.includes("Not found on any map"));
    const { sessionPanelAction } = await import("@/app/content/[id]/workspaceActions");
    const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
    const cl2 = await prisma.client.create({ data: { name: "Other Agent" } as never });
    const other = await prisma.contentEnrollment.create({ data: { clientId: cl2.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4 } as never });
    await sessionPanelAction(form({ op: "planPin", enrollmentId: other.id, planId: R.id, point: "39.9684, -75.4610" }));
    c.ok("a form from another client's page cannot place this plan", (await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: R.id } })).latitude === null);
    await sessionPanelAction(form({ op: "planPin", enrollmentId: en.id, planId: R.id, point: "39.9684, -75.4610" }));
    c.ok("the form places it from this client's page", (await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: R.id } })).geocodeSource === "MANUAL");

    const S = await plan(mo.id, 4, "Cedar Ln", "8");
    google = "denied";
    const req = await prisma.programSessionRequest.create({ data: {
      enrollmentId: en.id, clientId: cl.id, monthId: mo.id, kind: "CONTENT_SESSION", timezone: "America/New_York", locationText: "8 Cedar Ln, Newtown Square, PA 19073",
      notes: "Preferred: M-W", status: "REQUESTED", bookingState: "NONE", dedupeKey: `${en.id}:${mo.id}:flex:4`, sessionIndex: 4, planId: S.id, planAddressVersion: 1,
    } as never });
    const { handToDesk } = await import("@/lib/sessionRequests");
    await handToDesk(req.id, "BOOK", "");
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${req.id}` }, select: { description: true } });
    c.ok("Kyle's booking task says no map found it, so no times, and where to place it", /No map could find this address when it was requested, so the client was offered no times\. On the client's Production tab, under Not on the map, paste the house's Google Maps link/.test(task?.description ?? ""), (task?.description ?? "").slice(0, 400));
    await prisma.programSessionPlan.update({ where: { id: S.id }, data: { latitude: 39.9, longitude: -75.4 } });
    await handToDesk(req.id, "BOOK", "");
    const task2 = await prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${req.id}` }, select: { description: true } });
    c.ok("…and stops saying it once the address is on the map", !/No map could find/.test(task2?.description ?? ""));
    google = "ok";

    // ======================================================================
    c.head("6 · the portal form");
    // ======================================================================
    const sched = read("src/components/portal/PortalScheduler.tsx");
    c.ok("both address forms carry the lookup above the boxes, and the boxes stay", (sched.match(/<AddressLookup className="sm:col-span-6"/g) ?? []).length === 2 && (sched.match(/Or type it in yourself:/g) ?? []).length === 2 && (sched.match(/aria-label="Street address"/g) ?? []).length === 2);
    const look = read("src/components/portal/AddressLookup.tsx");
    c.ok("the lookup is a combobox with a list, keys and the map's credit", /role="combobox"/.test(look) && /role="listbox"/.test(look) && /ArrowDown/.test(look) && /Google Maps/.test(look) && /OpenStreetMap contributors/.test(look));
    const acts = read("src/app/portal/actions.ts");
    c.ok("the portal's suggestions need a signed-in client and are capped per client", /export async function portalSuggestAddresses[\s\S]{0,300}viewerFor\(auth, "requestSession"\)[\s\S]{0,200}suggestAllowed\(v\.enrollment\.id\)/.test(acts));
    const DASH = /[–—]/;
    c.ok("no long dashes in what clients and staff read", !DASH.test(look) && !DASH.test(read("src/lib/mapsStatus.ts")) && !/[–—]/.test(addr.parseMapPoint.toString()));

    c.head("isolation");
    c.ok("nothing left the hub but the canned map answers", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
