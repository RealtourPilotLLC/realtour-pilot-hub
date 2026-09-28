/**
 * READ-ONLY. What the Ready-to-send card actually renders on live data today,
 * and whether the download stamp has ever been written. SELECTs only — nothing
 * in this file writes, and it must stay that way.
 *
 * STRUCTURALLY read-only since Sep 28 2026 (A02): the connection is opened
 * with default_transaction_read_only=on and a refused UPDATE (SQLSTATE 25006)
 * is proven before anything is read, so "must stay that way" is enforced by
 * the database rather than by this comment.
 */
import { pinReadOnlyDatabaseUrl, proveReadOnly } from "../_lib/dbGuard";

// Before @/lib/prisma exists (hence the dynamic imports below).
pinReadOnlyDatabaseUrl();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  await proveReadOnly(prisma);
  console.log("read-only connection proven (25006)");
  const { readyToSend } = await import("@/lib/readyToSend");
  const board = await readyToSend();
  console.log(`Ready to send: ${board.ready.length} · still rendering: ${board.rendering.length}\n`);
  for (const v of board.ready) {
    console.log(`${v.street}  ·  ${v.cutLabel} v${v.round}  [${v.file.source}]  ready ${v.waitingHours}h`);
    console.log(`   file : ${v.file.fileName}`);
    console.log(`   path : ${v.file.dropboxPath ?? "(none on record)"}`);
    console.log(`   link : ${v.file.dropboxUrl ?? "(none)"}`);
    console.log(`   dl   : ${v.downloadedAtISO ? `${v.downloadedBy ?? "someone"} @ ${v.downloadedAtISO} (${v.downloadedHoursAgo}h ago)` : "nobody has pressed Download"}`);
  }
  const rows = board.ready.length;
  const linked = board.ready.filter((v) => v.file.dropboxUrl).length;
  const pathed = board.ready.filter((v) => v.file.dropboxPath).length;
  console.log(`\nrows=${rows}  with a dropbox path=${pathed}  with a link=${linked}  (link must equal path)`);
  const stamped = await prisma.reviewSubmission.count({ where: { downloadedAt: { not: null } } });
  const sent = await prisma.reviewSubmission.count({ where: { sentToClientAt: { not: null } } });
  console.log(`ReviewSubmission: downloadedAt set on ${stamped} rows; sentToClientAt set on ${sent} rows`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
