export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, content audit LOW): clear the stale
// `portal-publication-failure:<cut>` records, the ones whose cut is on its
// client's library now (contentVideos.clearStalePublicationFailures, which the
// hourly library repair runs from now on). A record whose cut is still not on
// the library is left. Nothing else is touched.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-publication-failures.ts           # dry run (read-only)
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-publication-failures.ts --apply   # deletes the stale records
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

async function main() {
  const prisma = await db();
  const { clearStalePublicationFailures } = await import("../../src/lib/contentVideos");
  const rows = await clearStalePublicationFailures({ dryRun: !APPLY });
  const subs = await prisma.reviewSubmission.findMany({ where: { id: { in: rows.map((r) => r.submissionId) } }, select: { id: true, fileName: true, project: { select: { title: true, client: { select: { name: true } } } } } });
  for (const r of rows) {
    const s = subs.find((x) => x.id === r.submissionId);
    console.log(`${r.inLibrary ? (APPLY ? (r.cleared ? "CLEARED" : "kept (changed since read)") : "STALE  ") : "OPEN   "} ${r.key} · ${s?.project.client?.name ?? "?"} · ${s?.project.title?.split(",")[0] ?? "?"} · ${s?.fileName ?? "cut not on file"} · recorded ${r.at ?? "?"}: ${r.why}`);
  }
  console.log(`${rows.length} records · ${rows.filter((r) => r.inLibrary).length} stale (the cut is on the library) · ${rows.filter((r) => !r.inLibrary).length} still open${APPLY ? ` · ${rows.filter((r) => r.cleared).length} cleared` : ""}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
