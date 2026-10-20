// ---------------------------------------------------------------------------
// Oct 20 2026 — one-time backfill of every job's current script from the
// scripting platform (Jordan, via the scripting platform session: "every job
// in the hub always shows its current script, kept current automatically").
// Until today the hub matched platform projects by its own id only, so the
// Aryeo bookings (81 of 83 platform projects) never synced: John Collins's 335
// Ridley Creek v10 ("swim spa", changed on site Oct 13) among them.
//
// GETs only against the platform (the list, then each matched project's
// detail); writes only to the hub's own job rows, through the same
// lib/scriptSync.applyStudioSnapshot the webhook and the 15-minute reconcile
// use (a photographer-confirmed filmed record is never overwritten).
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct20/scripting-backfill.ts           # dry run: matches only
//   ... --apply
// ---------------------------------------------------------------------------

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../../src/lib/prisma");
  const { scriptingListAll } = await import("../../../src/lib/integrations/scripting");
  const list = await scriptingListAll(200);
  const hub = await prisma.project.findMany({
    where: { OR: [{ aryeoOrderId: { in: list.map((x) => x.aryeo_order_id).filter((x): x is string => !!x) } }, { id: { in: list.map((x) => x.external_id).filter((x): x is string => !!x) } }] },
    select: { id: true, title: true, aryeoOrderId: true, reelScript: true, scriptConfirmedAt: true },
  });
  const matched = list.filter((s) => hub.some((h) => (s.aryeo_order_id && h.aryeoOrderId === s.aryeo_order_id) || h.id === s.external_id));
  console.log(`platform projects: ${list.length} · matched to a hub job: ${matched.length} · hub jobs with a script today: ${hub.filter((h) => h.reelScript).length}`);
  for (const s of list.filter((x) => !matched.includes(x))) console.log(`  no hub job: ${s.address ?? s.id} (${s.client_name ?? "?"}, ${s.status})`);
  if (!apply) { console.log("\nDRY RUN. --apply to read each matched project and mirror its current script."); await prisma.$disconnect(); return; }

  const before = new Map(hub.map((h) => [h.id, h.reelScript]));
  const { reconcileScripting } = await import("../../../src/lib/scriptSync");
  const r = await reconcileScripting({ all: true, max: 200, budgetMs: 15 * 60_000 });
  console.log("\nbackfill:", JSON.stringify(r));
  const after = await prisma.project.findMany({ where: { id: { in: hub.map((h) => h.id) } }, select: { id: true, title: true, reelScript: true, scriptingVersion: true, scriptingOnSiteBy: true, scriptingStatus: true, scriptConfirmedAt: true, scriptingScript: true } });
  for (const a of after) {
    const was = before.get(a.id);
    const tag = !was && a.reelScript ? "NEW" : was !== a.reelScript ? "UPDATED" : a.scriptConfirmedAt && a.scriptingScript && a.scriptingScript.trim() !== (a.reelScript ?? "").trim() ? "FILMED RECORD KEPT" : "";
    console.log(`  ${(a.title ?? "").split(",")[0].padEnd(34)} ${String(a.scriptingStatus ?? "").padEnd(18)} v${a.scriptingVersion ?? "-"}${a.scriptingOnSiteBy ? " (on site)" : ""} ${tag}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
