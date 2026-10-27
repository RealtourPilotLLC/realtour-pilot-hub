// ---------------------------------------------------------------------------
// WHY 2925 N 21ST ST HAS NO PICTURE ON MY SHOOTS (Oct 27 2026, Jordan's Loom:
// "it's supposed to show the Google street view ... and then once the photos
// are uploaded, the cover photo replaces it").
//
// Reads the job (every project whose title or street starts "2925 N 21st"),
// prints what the card is built from (the cover link, the coordinates, the
// address fields) and the frames the card now tries in order
// (lib/shootThumb shootThumbCandidates). Then checks each frame:
//   · the cover link: a HEAD request (a dead link left the card blank before)
//   · each Street View frame: Google's FREE metadata endpoint (status OK /
//     ZERO_RESULTS / NOT_FOUND), only when GOOGLE_MAPS_API_KEY is in the
//     environment (it is on Vercel, not in this checkout's .env: run with
//     `set -a && source <file with the key>; set +a` or prefix the variable)
//
// --apply: clears Project.coverImageUrl ONLY when that link is dead (not 2xx),
// with a timeline note (the hourly pass sets it again once the listing has
// photos: lib/projectStatus). Nothing else is written, nothing
// is sent.
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const STREET = "2925 N 21st";

async function head(url: string): Promise<string> {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    return `${r.status} ${r.statusText}`.trim();
  } catch (e) {
    return `fetch failed: ${(e as Error).message}`;
  }
}

async function svMeta(location: string, key: string): Promise<string> {
  const u = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(location)}&radius=250&source=outdoor&key=${key}`;
  try {
    const j = (await (await fetch(u)).json()) as { status?: string; location?: { lat: number; lng: number }; date?: string };
    return `${j.status ?? "?"}${j.location ? ` (pano at ${j.location.lat.toFixed(5)},${j.location.lng.toFixed(5)}${j.date ? `, ${j.date}` : ""})` : ""}`;
  } catch (e) {
    return `metadata failed: ${(e as Error).message}`;
  }
}

async function main() {
  const prisma = await db();
  const { shootThumbCandidates } = await import("../../src/lib/shootThumb");
  const jobs = await prisma.project.findMany({
    where: { OR: [{ title: { startsWith: STREET, mode: "insensitive" } }, { addressLine: { startsWith: STREET, mode: "insensitive" } }] },
    select: {
      id: true, title: true, status: true, shootDate: true, addressLine: true, city: true, state: true, zip: true, lat: true, lng: true,
      coverImageUrl: true, aryeoListingId: true,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!jobs.length) return console.log(`No job starts "${STREET}". Nothing to check.`);

  const key = process.env.GOOGLE_MAPS_API_KEY ?? "";
  if (!key) console.log("GOOGLE_MAPS_API_KEY is not set here: the Street View frames are listed but not checked.\n");

  for (const p of jobs) {
    console.log(`${p.title}  (${p.id}, ${p.status}, shoot ${p.shootDate?.toISOString() ?? "none"})`);
    console.log(`  address: ${[p.addressLine, p.city, p.state, p.zip].map((x) => x ?? "∅").join(" | ")}`);
    console.log(`  coords:  ${p.lat ?? "∅"}, ${p.lng ?? "∅"}${p.lat === 0 && p.lng === 0 ? "  (0,0: no coordinates)" : ""}`);
    console.log(`  cover:   ${p.coverImageUrl ?? "none"}`);
    console.log(`  Aryeo listing ${p.aryeoListingId ?? "none"}`);

    // The frames, with a placeholder key when none is set (the order is the point).
    const prev = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) process.env.GOOGLE_MAPS_API_KEY = "KEY";
    const frames = shootThumbCandidates(p);
    if (!key) process.env.GOOGLE_MAPS_API_KEY = prev;
    let coverDead = false;
    for (const [i, f] of frames.entries()) {
      const where = f.kind === "street" ? decodeURIComponent(new URL(f.url).searchParams.get("location") ?? "") : f.url;
      let verdict = "";
      if (f.kind === "aryeo") {
        verdict = await head(f.url);
        coverDead = !/^2\d\d/.test(verdict);
      } else if (key) {
        verdict = await svMeta(where, key);
      }
      console.log(`  frame ${i + 1}: ${f.kind === "aryeo" ? "cover" : "Street View"} ${f.kind === "street" ? `at "${where}"` : ""}${verdict ? `: ${verdict}` : ""}`);
    }
    const clear = !!p.coverImageUrl && coverDead;
    console.log(`  -> ${clear ? "clear the cover (dead link) so Street View shows until the hourly pass finds the listing's photos" : "nothing to write"}\n`);

    if (clear && APPLY) {
      await prisma.project.update({ where: { id: p.id }, data: { coverImageUrl: null } });
      await prisma.activity.create({ data: { projectId: p.id, type: "SYSTEM", body: "My Shoots picture: the cover link no longer loads, so it was cleared. The card shows Street View until the hourly pass finds the listing's photos." } });
      console.log("  cleared, timeline note written\n");
    }
  }
  if (!APPLY) console.log("Dry run: nothing written. Add --apply.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { const { prisma } = await import("../../src/lib/prisma"); await prisma.$disconnect(); });
