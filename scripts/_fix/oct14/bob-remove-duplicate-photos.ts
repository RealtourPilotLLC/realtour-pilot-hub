// ---------------------------------------------------------------------------
// LIVE (Oct 14 2026): the hub's first real Aryeo push (Bob Kelley, 902 Valley
// Rd) added the 52 photos twice (Aryeo bounced the session after the add and
// the add was re-sent; aryeoWeb never re-sends a change now). Aryeo
// named the second copies "<name> (2).jpg". This removes exactly those: a
// photo whose name ends " (2).jpg" AND whose original name is also on the
// listing. The listing is undelivered. Dry run unless --apply.
// ---------------------------------------------------------------------------
export {};
const LISTING = "01a1228b-653d-71f0-b2a2-3d9eed77f21a";
async function main() {
  const W = await import("@/lib/integrations/aryeoWeb");
  const page = await W.listingPage(LISTING);
  if (page.delivered) throw new Error("the listing is delivered: stop");
  const names = new Set(page.images.map((i) => `${i.filename}.${i.filename_extension}`.toLowerCase()));
  const dupes = page.images.filter((i) => / \(2\)$/.test(i.filename) && names.has(`${i.filename.replace(/ \(2\)$/, "")}.${i.filename_extension}`.toLowerCase()));
  console.log(`listing has ${page.images.length} photos; duplicates to remove: ${dupes.length}`);
  console.log("sample:", dupes.slice(0, 3).map((d) => `${d.filename}.${d.filename_extension}`).join(" | "));
  if (dupes.length !== 52 || page.images.length !== 104) throw new Error("not the expected 52 duplicates of 104: stopping without changes");
  if (!process.argv.includes("--apply")) return;
  await W.deleteImages(LISTING, dupes.map((d) => d.id));
  const after = await W.listingPage(LISTING);
  console.log(`after: ${after.images.length} photos; any (2) left: ${after.images.some((i) => / \(2\)$/.test(i.filename))}`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
