// ---------------------------------------------------------------------------
// LIVE (Oct 15 2026): the hub's old Aryeo push (before a922f9a) added a job's
// photos twice when Aryeo bounced the session after the add; Aryeo names the
// second copies "<name> (2).jpg". 1934 W Godfrey Ave (Stephen Kennedy) got 36
// of 36 twice, like Bob Kelley's 52 (oct14/bob-remove-duplicate-photos.ts).
// Removes exactly those: a photo whose name ends " (2)" AND whose original
// name is also on the listing, only on an undelivered listing, only when the
// counts are what the caller expects. Dry run unless --apply.
//   tsx scripts/_fix/oct15/remove-duplicate-listing-photos.ts <listingId> <expectedDupes> [--apply]
// ---------------------------------------------------------------------------
export {};
async function main() {
  const [listing, expected] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const want = Number(expected);
  if (!listing || !Number.isFinite(want) || want <= 0) throw new Error("usage: <listingId> <expectedDupes> [--apply]");
  const W = await import("@/lib/integrations/aryeoWeb");
  const page = await W.listingPage(listing);
  if (page.delivered) throw new Error("the listing is delivered: stop");
  const names = new Set(page.images.map((i) => `${i.filename}.${i.filename_extension}`.toLowerCase()));
  const dupes = page.images.filter((i) => / \(2\)$/.test(i.filename) && names.has(`${i.filename.replace(/ \(2\)$/, "")}.${i.filename_extension}`.toLowerCase()));
  console.log(`listing has ${page.images.length} photos; duplicates to remove: ${dupes.length}`);
  console.log("sample:", dupes.slice(0, 3).map((d) => `${d.filename}.${d.filename_extension}`).join(" | "));
  if (dupes.length !== want || page.images.length !== want * 2) throw new Error(`not the expected ${want} duplicates of ${want * 2}: stopping without changes`);
  if (!process.argv.includes("--apply")) return;
  await W.deleteImages(listing, dupes.map((d) => d.id));
  const after = await W.listingPage(listing);
  console.log(`after: ${after.images.length} photos; any (2) left: ${after.images.some((i) => / \(2\)$/.test(i.filename))}; first: ${after.images.slice(0, 3).map((i) => i.filename).join(", ")}`);
}
main().catch((e) => { console.log("ERR", e.message); process.exit(1); });
