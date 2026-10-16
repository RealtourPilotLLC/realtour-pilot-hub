// ---------------------------------------------------------------------------
// LIVE (Oct 15 2026): Marcee McMullen's August videos in her portal library.
//
//   DRY RUN (default):  set -a; source .env; set +a; NODE_OPTIONS=--conditions=react-server \
//                         npx tsx scripts/_fix/oct15/marcee-august-library.ts
//   APPLY:              … --apply
//
// On the Oct 15 call Jordan noticed "two videos from August that aren't in
// there". Her August listing (Aryeo 019f6bb4…) holds SIX videos today: the
// four Fairy God Realtor tips (re-delivered as "… V2"), "Car Video" and "Why
// I Love Bow Tree" (the community video she liked). Her library has four
// rows, keyed the OLD way by position (aryeo:<listing>:0..3), still pointing
// at the first versions; the two later videos were added after the 3-day
// sweep window and never came in.
//
//   1. Each position-keyed row is re-pointed to the ONE listing video whose
//      title is the row's title plus a V2 suffix (same words otherwise) —
//      key, title and links; nothing is deleted.
//   2. The library sync then adds the two missing videos (id-keyed, idempotent).
//   3. The client video layer (ContentVideo) is rebuilt for her.
// ---------------------------------------------------------------------------
const ENROLLMENT = "cmt7h6azc00049kcj0b39k6si";
const CLIENT = "cmqiksjju007v9k9qtuql2n4e";
const LISTING = "019f6bb4-d910-7314-ab60-0529f726a4d3";
const APPLY = process.argv.includes("--apply");

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/\s*\(?\bv\s*\d+\)?\s*$/i, "").replace(/[–—-]/g, " ").replace(/#\s*/g, "#").replace(/\s+/g, " ").trim();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListingMedia } = await import("@/lib/integrations/aryeo");
  const media = await getListingMedia(LISTING);
  if (!media) throw new Error("Aryeo did not return the listing.");
  const vids = media.videos.filter((v) => v.id && (v.playback || v.download));
  console.log(`listing videos: ${vids.map((v) => v.title).join(" | ")}`);
  const rows = await prisma.portalVideo.findMany({ where: { enrollmentId: ENROLLMENT, externalKey: { startsWith: `aryeo:${LISTING}:` } } });
  for (const r of rows) {
    const idKeyed = vids.some((v) => r.externalKey === `aryeo:${LISTING}:${v.id}`);
    if (idKeyed) { console.log(`  ok (id-keyed): ${r.title}`); continue; }
    const hits = vids.filter((v) => norm(v.title) === norm(r.title));
    if (hits.length !== 1) { console.log(`  LEFT ALONE (${hits.length} matches): ${r.title}`); continue; }
    const v = hits[0];
    const to = `aryeo:${LISTING}:${v.id}`;
    const clash = await prisma.portalVideo.findUnique({ where: { externalKey: to }, select: { id: true } });
    console.log(`  ${clash ? "RETIRE (id row exists)" : "RE-POINT"}: ${r.title} → ${v.title}`);
    if (!APPLY) continue;
    if (clash) await prisma.portalVideo.update({ where: { id: r.id }, data: { externalKey: `retired:${r.externalKey}:${r.id}` } });
    else await prisma.portalVideo.update({ where: { id: r.id }, data: { externalKey: to, title: v.title, thumb: v.thumb, playback: v.playback, download: v.download } });
  }
  const missing = vids.filter((v) => !rows.some((r) => norm(r.title) === norm(v.title)));
  console.log(`not in the library yet: ${missing.map((v) => v.title).join(" | ") || "none"}`);
  if (!APPLY) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); await prisma.$disconnect(); return; }
  const { syncEnrollmentLibrary } = await import("@/lib/portalLibrary");
  console.log("library sync:", JSON.stringify(await syncEnrollmentLibrary(ENROLLMENT)));
  const cv = await import("@/lib/contentVideos");
  console.log("client videos:", JSON.stringify(await cv.syncEnrollmentLibrary({ id: ENROLLMENT, clientId: CLIENT }).catch((e: unknown) => String(e))));
  const after = await prisma.portalVideo.findMany({ where: { enrollmentId: ENROLLMENT, externalKey: { startsWith: `aryeo:${LISTING}:` } }, select: { title: true } });
  console.log(`August rows now: ${after.map((a) => a.title).join(" | ")}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
