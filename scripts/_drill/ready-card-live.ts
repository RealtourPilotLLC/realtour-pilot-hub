/**
 * READ-ONLY. What the Ready-to-send card actually renders on live data today,
 * and whether the download stamp has ever been written. SELECTs only — nothing
 * in this file writes, and it must stay that way.
 */
import { readyToSend } from "@/lib/readyToSend";
import { prisma } from "@/lib/prisma";

async function main() {
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
