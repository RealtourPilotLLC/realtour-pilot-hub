export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 25 2026 audit, area E): script shares whose email reads
// "queued" for ever.
//
// A SHARE row's notificationState QUEUED means a SCRIPTS_READY notice holds it
// (reminderId) and the sender will say SENT or SUPPRESSED. Two of Kristin
// Ciarmella's shares from Oct 20 (her change requests, "used as written") read
// QUEUED with NO notice: the notice step never ran, nothing was ever going to
// send, and the ledger says otherwise. (She has since approved all four
// October scripts, so nothing is owed to her.)
//
// The dry run lists every SHARE row that is QUEUED, has no notice and is over
// a day old. --apply marks each SUPPRESSED with a plain note, the state the
// share would have had if the notice step had reported. It never sends, never
// re-shares and never touches a script or a version (Jordan's rule: a script
// pushed to a client is never edited or re-shared).
//
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct25-content-stuck-share-emails.ts           # dry run (read-only)
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct25-content-stuck-share-emails.ts --apply   # writes
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const NOTE = "No email went out for this share: the notice step never ran, so nothing was queued (found and closed out in the Oct 25 2026 audit). The script was on the portal.";

async function main() {
  const prisma = await db();
  const cutoff = new Date(Date.now() - 24 * 3600e3);
  const rows = await prisma.contentScriptRelease.findMany({
    where: { action: "SHARE", notificationState: "QUEUED", reminderId: null, createdAt: { lt: cutoff } },
    select: { id: true, scriptId: true, clientId: true, createdAt: true, note: true },
    orderBy: { createdAt: "asc" },
  });
  const names = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const titles = new Map((await prisma.contentScript.findMany({ where: { id: { in: rows.map((r) => r.scriptId) } }, select: { id: true, title: true } })).map((s) => [s.id, s.title]));
  console.log(`${rows.length} share(s) read "queued" with no notice behind them`);
  for (const r of rows) console.log(`  ${r.id} ${r.createdAt.toISOString().slice(0, 16)} ${names.get(r.clientId) ?? r.clientId} "${(titles.get(r.scriptId) ?? "?").slice(0, 60)}" note="${(r.note ?? "").slice(0, 90)}"`);
  if (!APPLY) { console.log("\nDry run: nothing written. --apply marks each one SUPPRESSED with the note above."); return; }
  let n = 0;
  for (const r of rows) {
    const u = await prisma.contentScriptRelease.updateMany({ where: { id: r.id, notificationState: "QUEUED", reminderId: null }, data: { notificationState: "SUPPRESSED", note: [r.note, NOTE].filter(Boolean).join(" ") } });
    n += u.count;
  }
  console.log(`\nMarked ${n} share(s) SUPPRESSED.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
