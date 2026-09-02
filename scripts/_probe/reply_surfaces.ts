// READ-ONLY probe: what every "who is waiting on a reply" surface reports now.
// All five read ONE walk (unansweredComms) — the counts must agree with the
// lists they link to.
//   npx tsx --conditions=react-server --env-file=.env scripts/_probe/reply_surfaces.ts
import { replyQueue, replyWaitingSummary } from "@/lib/replyQueue";
import { findUnansweredInbound } from "@/lib/commsSla";
import { unansweredCommsBoard } from "@/lib/commsBoard";
import { prisma } from "@/lib/prisma";

async function main() {
  const now = new Date();
  const [q, sum, sla, phone, email] = await Promise.all([
    replyQueue(),
    replyWaitingSummary(),
    findUnansweredInbound(now),
    unansweredCommsBoard("phone", now),
    unansweredCommsBoard("email", now),
  ]);

  console.log("=== Dashboard chip / Replies tab badge (replyWaitingSummary) ===");
  console.log(JSON.stringify(sum));
  console.log("\n=== Replies tab list (replyQueue().cards) ===", q.cards.length);
  for (const c of q.cards) {
    console.log(`  [${c.key}] ${c.displayName} | ${c.hoursWaiting}h | client=${c.isClient} team=${c.isTeam} | "${c.lastInbound.replace(/\s+/g, " ").slice(0, 90)}"`);
  }
  console.log(`  (collapsed 'likely handled': ${q.handled.length})`);
  for (const c of q.handled) {
    console.log(`   ~ [${c.key}] ${c.displayName} | "${c.lastInbound.replace(/\s+/g, " ").slice(0, 60)}"`);
  }

  console.log("\n=== Ops Day pill (findUnansweredInbound) ===", sla.length);
  for (const s of sla) console.log(`  ${s.clientName} | ${Math.round(s.ageMin / 60)}h | "${s.snippet}"`);

  console.log("\n=== /tasks?tab=comms PHONE board ===", phone.length);
  for (const g of phone) console.log(`  ${g.clientName} (${g.groupKey}) | ${g.oldestHours}h | ${g.items.length} msg | "${g.items[g.items.length - 1]?.snippet.slice(0, 70)}"`);

  console.log("\n=== /tasks?tab=comms EMAIL board ===", email.length);
  for (const g of email) console.log(`  ${g.clientName} (${g.groupKey}) | ${g.oldestHours}h | ${g.items.length} msg | "${(g.items[g.items.length - 1]?.subject ?? g.items[g.items.length - 1]?.snippet ?? "").slice(0, 70)}"`);

  // Raw evidence for the three suspect rows the audit named.
  console.log("\n=== raw: last 21d text rows per conversation key of each queue card ===");
  const since = new Date(now.getTime() - 21 * 86_400_000);
  for (const c of q.cards) {
    const rows = await prisma.commLog.findMany({
      where: {
        channel: "text",
        occurredAt: { gte: since },
        ...(c.clientId ? { clientId: c.clientId } : c.phone ? { fromPhone: c.phone } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: 8,
      select: { direction: true, contactName: true, clientName: true, source: true, fromPhone: true, body: true, occurredAt: true, minRole: true },
    });
    console.log(`\n  --- ${c.displayName} (${c.key}) ---`);
    for (const r of rows) {
      console.log(`    ${r.occurredAt.toISOString()} dir=${r.direction} contact=${JSON.stringify(r.contactName)} src=${r.source} phone=${r.fromPhone} :: ${r.body.replace(/\s+/g, " ").slice(0, 110)}`);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
