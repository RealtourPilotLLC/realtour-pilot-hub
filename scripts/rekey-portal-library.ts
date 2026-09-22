// ---------------------------------------------------------------------------
// F23 — RE-KEY THE CLIENT LIBRARY OFF ARRAY POSITIONS (Sep 22 2026).
//
//   npx tsx scripts/rekey-portal-library.ts --dry-run    → what it would do
//   npx tsx scripts/rekey-portal-library.ts              → do it
//
// PortalVideo rows were keyed `aryeo:<listingId>:<n>` where n was the index
// into a filtered array. Add a video, remove one, or have Aryeo return them in
// another order and the row keyed `:0` is UPDATED with a different video's
// title and URLs — the client's library relabels itself and the download under
// one name hands over another file.
//
// This re-keys each row onto Aryeo's own video id, and only where the row's
// existing URL matches exactly ONE video on the listing today. It never
// deletes, never rewrites a title or a URL, and never guesses: a row it cannot
// identify keeps its old key and is reported.
//
// --dry-run opens the database read-only and PROVES it with a refused write
// before reading anything, the same way the other drills do.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry-run");

if (DRY) {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const file = path.resolve(__dirname, "../.env");
    const m = fs.existsSync(file) ? fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m) : null;
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  if (DRY) {
    let guard = "NOT PROVEN";
    try {
      await prisma.appSetting.updateMany({ where: { key: "__rekey_readonly_probe__" }, data: { value: "x" } });
    } catch (e) {
      guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
    }
    console.log(`=== READ-ONLY GUARD: ${guard} ===\n`);
    if (guard !== "PROVEN") throw new Error("Refusing a dry run that cannot prove it is read-only.");
  }

  const { rekeyIndexedLibraryRows } = await import("../src/lib/portalLibrary");
  const r = await rekeyIndexedLibraryRows({ dryRun: DRY });

  console.log(`${DRY ? "WOULD re-key" : "Re-keyed"}      ${r.rekeyed}`);
  console.log(`already on an id  ${r.alreadyKeyed}`);
  console.log(`unmatched         ${r.unmatched}   (URL no longer on the listing — left alone)`);
  console.log(`unreadable        ${r.unreadable}   (Aryeo would not answer — next run)`);
  console.log(`collisions        ${r.collisions}`);
  console.log(`examined          ${r.examined}\n`);
  for (const d of r.detail.slice(0, 40)) console.log(`  ${d.externalKey}\n    -> ${d.to ?? "(unchanged)"}  · ${d.why}`);
  if (r.detail.length > 40) console.log(`  … and ${r.detail.length - 40} more`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
