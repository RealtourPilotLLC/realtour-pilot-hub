// Bounded read-only C14 OpenPhone group-label probe. No phone numbers, message
// bodies, or integration credentials are printed.
import { PrismaClient } from "@prisma/client";
import { phoneKey, recentOpenPhoneConversations } from "../../src/lib/integrations/openphone";
import { isSyntheticClientRow } from "../../src/lib/testClients";

const prisma = new PrismaClient();

async function main() {
  const clients = await prisma.client.findMany({
    where: { name: { contains: "Jordan", mode: "insensitive" }, phone: { not: null } },
    select: { id: true, name: true, phone: true },
  });
  const real = new Set(clients.filter((c) => c.name?.toLowerCase().includes("spackman") && !isSyntheticClientRow(c)).map((c) => phoneKey(c.phone)).filter((k) => k.length === 10));
  const test = new Set(clients.filter((c) => isSyntheticClientRow(c)).map((c) => phoneKey(c.phone)).filter((k) => k.length === 10));
  const convs = await recentOpenPhoneConversations(20);
  const rows = convs.map((conv) => {
    const participants = (conv.participants ?? []).map(phoneKey);
    return {
      label: conv.name ?? null,
      participants: participants.length,
      hasRealJordan: participants.some((k) => real.has(k)),
      hasTestJordan: participants.some((k) => test.has(k)),
      lastActivityAt: conv.lastActivityAt ?? null,
    };
  });
  const relevant = rows.filter((r) => /jordan|\btest\b/i.test(r.label ?? "") || r.hasRealJordan || r.hasTestJordan);
  console.log(JSON.stringify({ scanned: rows.length, relevant: relevant.length, rows: relevant.slice(0, 30) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
