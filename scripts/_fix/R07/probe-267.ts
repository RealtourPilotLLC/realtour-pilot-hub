// READ-ONLY: the Replies tab shows "(267) 900-8794 waiting 1d" with no to-do,
// while an OPEN `lead-2679008794` task exists. Which rows make that thread?
import { prisma } from "@/lib/prisma";
import { unansweredComms } from "@/lib/replyQueue";

async function main() {
  const rows = await prisma.commLog.findMany({
    where: { OR: [{ fromPhone: "2679008794" }, { body: { contains: "900-8794" } }, { contactName: { contains: "900-8794" } }] },
    select: { id: true, channel: true, direction: true, clientId: true, contactName: true, fromPhone: true, body: true, occurredAt: true, source: true },
    orderBy: { occurredAt: "desc" },
    take: 20,
  });
  console.log(`\nCommLog rows touching 267-900-8794: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.occurredAt.toISOString()} ${r.channel}/${r.direction} clientId=${r.clientId ?? "null"} fromPhone=${r.fromPhone ?? "null"} source=${r.source}`);
    console.log(`     contactName=${JSON.stringify(r.contactName)} body=${JSON.stringify(r.body.slice(0, 100))}`);
  }

  const threads = await unansweredComms({ families: ["phone"], includeOwed: true });
  for (const t of threads.filter((x) => !x.clientId)) {
    console.log(`\nthread key=${t.key} groupKey=${JSON.stringify(t.groupKey)} phone=${t.phone} display=${JSON.stringify(t.displayName)} team=${t.isTeam} ledger=${!!t.fromLedger} task=${t.openTaskId}`);
    for (const p of t.pending) console.log(`   pending ${p.at.toISOString()} ${p.channel}: ${JSON.stringify(p.body.slice(0, 90))}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
