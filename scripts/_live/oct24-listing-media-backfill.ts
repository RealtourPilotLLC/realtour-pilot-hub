// ---------------------------------------------------------------------------
// LIVE (Oct 24 2026): THE MEDIA LIBRARY'S ONE-TIME INDEX OF THE OLDER ARYEO
// LISTINGS (lib/listingMediaIndex). Jordan: "we should have a lot more
// premium videos and monthly social content in the gallery."
//
// Run AFTER `npm run db:push` has created ListingMediaItem and the code is
// deployed. With no flag it only reports (read-only connection, a refused
// write proved first):
//
//   npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_live/oct24-listing-media-backfill.ts
//       → where the backfill is, how many jobs it covers, what the index holds
//   … --start      start it (or resume a paused one): the 15-minute Aryeo cron
//                  then reads 36 listings a tick (~1,550 jobs ≈ 11 hours).
//                  Writes ONE row: AppSetting `listing_media_backfill`.
//   … --pause      stop it where it is (the next --start resumes there).
//   … --restart    walk every listing again from the first (the cursor reset).
//   … --tick [N]   also run N ticks (default 1) from this machine, the same
//                  code the cron runs: Aryeo GETs, index rows written. Each
//                  tick takes the same lease, so it never reads beside the cron.
//
// Nothing here writes to Aryeo, contacts anyone or touches any other table.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { installNextStubs } from "../_drill/_harness";

const arg = (f: string) => process.argv.includes(f);
const WRITES = arg("--start") || arg("--pause") || arg("--restart") || arg("--tick");
if (!WRITES) {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const file = path.resolve(__dirname, "../../.env");
    const m = fs.existsSync(file) ? fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m) : null;
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found: the report refuses to run without the read-only guard.");
  const u = new URL(url);
  u.searchParams.set("options", [u.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}
installNextStubs();

const BY = "info@realtourpilot.com (via Claude)";

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  if (!WRITES) {
    let refused = false;
    try { await prisma.appSetting.updateMany({ where: { key: "__oct24_media_readonly_probe__" }, data: { value: "x" } }); } catch (e) { refused = /read-only|25006/.test(String(e)); }
    if (!refused) throw new Error("The read-only guard is NOT proven: refusing to continue.");
    console.log("report only (read-only connection). Flags: --start · --pause · --restart · --tick [N]");
  }
  const ix = await import("../../src/lib/listingMediaIndex");
  const { backfillLine } = await import("../../src/lib/listingMediaCore");

  if (arg("--restart")) console.log("restarted:", JSON.stringify(await ix.startListingMediaBackfill(BY, { restart: true })));
  else if (arg("--start")) console.log("started:", JSON.stringify(await ix.startListingMediaBackfill(BY)));
  if (arg("--pause")) console.log("paused:", JSON.stringify(await ix.pauseListingMediaBackfill(BY)));

  if (arg("--tick")) {
    const i = process.argv.indexOf("--tick");
    const n = Math.max(1, Math.min(100, Number(process.argv[i + 1]) || 1));
    for (let k = 0; k < n; k++) {
      const r = await ix.listingMediaBackfillTick({ max: 36, budgetMs: 60_000, gapMs: 400, by: BY });
      console.log(`tick ${k + 1}/${n}:`, JSON.stringify(r));
      if (r.finished || r.idle || r.waitingUntil) break;
    }
  }

  const s = await ix.listingMediaBackfillState();
  const jobs = await prisma.project.count({ where: ix.BACKFILL_WHERE });
  console.log(`\njobs to read: ${jobs}`);
  console.log(`backfill: ${s ? `${s.state} · ${s.done} read · cursor ${s.cursor ?? "-"} · ${s.videos} videos · ${s.covers} covers · ${s.skipped.length} skipped${s.backoffUntil ? ` · waiting until ${s.backoffUntil}` : ""}${s.lastError ? ` · last error: ${s.lastError}` : ""}` : "not started"}`);
  console.log(backfillLine(s) ?? "");
  const held = await prisma.listingMediaItem.groupBy({ by: ["kind"], where: { removedAt: null }, _count: true }).catch((e) => `the index table is not there yet (${String(e).slice(0, 80)})`);
  console.log("index holds:", JSON.stringify(held));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
