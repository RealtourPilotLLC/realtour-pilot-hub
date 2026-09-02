// READ-ONLY regression probe (throwaway). No writes.
import { prisma } from "../../src/lib/prisma";
import { unansweredComms } from "../../src/lib/replyQueue";
import { phoneKey } from "../../src/lib/integrations/openphone";

async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86_400_000);

  // --- NEW walk, no role gate, phone+email, everything included
  const nw = await unansweredComms({ now, includeCourtesy: true });
  console.log("NEW walk threads:", nw.length,
    "phone:", nw.filter(t => t.family === "phone").length,
    "email:", nw.filter(t => t.family === "email").length);
  for (const t of nw) {
    console.log(`  [${t.family}] ${t.displayName} cid=${t.clientId} pend=${t.pending.length} court=${t.courtesy.length} h=${t.hoursWaiting} :: ${(t.pending[0]?.body ?? t.courtesy[0]?.body ?? "").slice(0,70)}`);
  }

  // --- OLD rule (commsSla HEAD): per client, latest inbound text with no outbound after
  const rows = await prisma.commLog.findMany({
    where: { channel: { in: ["text", "call"] }, occurredAt: { gte: since }, clientId: { not: null } },
    orderBy: { occurredAt: "asc" },
    select: { clientId: true, clientName: true, channel: true, direction: true, body: true, occurredAt: true, contactName: true, fromPhone: true },
  });
  const pending = new Map<string, any>();
  const CALL_ART = /^(incoming|outgoing|missed) call\b|recording\.completed/i;
  for (const r of rows) {
    const cid = r.clientId as string;
    if (r.direction === "out") {
      if (r.channel === "call" && /missed|no answer|unanswered/i.test(r.body ?? "")) continue;
      pending.delete(cid);
    } else if (r.channel === "text" && !CALL_ART.test((r.body ?? "").trim())) {
      pending.set(cid, r);
    }
  }
  console.log("\nOLD-style raw pending clients (no ack/courtesy filtering):", pending.size);
  const newClientIds = new Set(nw.filter(t => t.clientId).map(t => t.clientId as string));
  const dropped = [...pending.entries()].filter(([cid]) => !newClientIds.has(cid));
  console.log("Clients present in OLD raw set but absent from NEW walk:", dropped.length);
  for (const [cid, r] of dropped) {
    console.log(`  DROPPED ${r.clientName ?? cid} (${cid}) @${r.occurredAt.toISOString()} :: ${JSON.stringify((r.body ?? "").slice(0,120))}`);
  }

  // --- team-handset inbound rows carrying a clientId in the window (the teammate-clear risk)
  const team = await prisma.teamMember.findMany({ select: { name: true, phone: true } });
  const tk = new Set(team.map(t => phoneKey(t.phone)).filter(k => k.length === 10));
  const teamInbound = rows.filter(r => r.direction === "in" && r.fromPhone && tk.has(r.fromPhone));
  console.log("\nTeam-handset rows (direction=in, with clientId) in window:", teamInbound.length);
  for (const r of teamInbound) {
    console.log(`  ${r.contactName} -> client ${r.clientName} @${r.occurredAt.toISOString()} :: ${JSON.stringify((r.body ?? "").slice(0,100))}`);
  }
}
main().finally(() => prisma.$disconnect());
