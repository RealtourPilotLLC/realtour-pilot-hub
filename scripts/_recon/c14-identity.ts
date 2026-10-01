// Read-only C14 phone-collision inventory. Never prints phone numbers or email.
import { PrismaClient } from "@prisma/client";
import { phoneKey } from "../../src/lib/integrations/openphone";
import { isSyntheticClientRow } from "../../src/lib/testClients";

const prisma = new PrismaClient();
async function main() {
try {
  const clients = await prisma.client.findMany({
    where: { OR: [{ name: { contains: "Jordan", mode: "insensitive" } }, { name: { contains: "TEST", mode: "insensitive" } }] },
    select: { id: true, name: true, phone: true },
  });
  const realJordan = clients.filter((c) => c.name?.toLowerCase().includes("jordan") && !isSyntheticClientRow(c));
  const syntheticJordan = clients.filter((c) => c.name?.toLowerCase().includes("jordan") && isSyntheticClientRow(c));
  const collisions = realJordan.flatMap((real) => syntheticJordan.filter((test) => phoneKey(real.phone).length === 10 && phoneKey(real.phone) === phoneKey(test.phone)).map((test) => ({ real: { id: real.id, name: real.name }, synthetic: { id: test.id, name: test.name } })));
  const testPhones = new Set(syntheticJordan.map((c) => phoneKey(c.phone)).filter((k) => k.length === 10));
  const [contacts, team] = await Promise.all([
    prisma.contact.findMany({ where: { phones: { not: null } }, select: { firstName: true, lastName: true, phones: true, clientId: true } }),
    prisma.teamMember.findMany({ where: { phone: { not: null } }, select: { name: true, phone: true } }),
  ]);
  const contactMatches = contacts.filter((c) => {
    try { return (JSON.parse(c.phones ?? "[]") as string[]).some((p) => testPhones.has(phoneKey(p))); } catch { return false; }
  }).map((c) => ({ name: [c.firstName, c.lastName].filter(Boolean).join(" "), clientId: c.clientId }));
  const teamMatches = team.filter((t) => testPhones.has(phoneKey(t.phone))).map((t) => t.name);
  const { resolveParticipants, getConversationContext } = await import("../../src/lib/queries");
  const identities = [];
  for (const c of [...syntheticJordan, ...realJordan.filter((r) => r.name?.toLowerCase().includes("spackman"))]) {
    if (phoneKey(c.phone).length !== 10) continue;
    const [member] = await resolveParticipants([c.phone!]);
    const context = await getConversationContext(c.phone!);
    identities.push({ rowId: c.id, synthetic: isSyntheticClientRow(c), displayedName: member?.name ?? null, displayedClientId: member?.clientId ?? null, contextClientId: context.client?.id ?? null });
  }
  console.log(JSON.stringify({ realJordan: realJordan.map(({ id, name }) => ({ id, name })), syntheticJordan: syntheticJordan.map(({ id, name }) => ({ id, name })), collisions, testPhoneContacts: contactMatches, testPhoneTeam: teamMatches, identities }, null, 2));
} finally {
  await prisma.$disconnect();
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
