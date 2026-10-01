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
  console.log(JSON.stringify({ realJordan: realJordan.map(({ id, name }) => ({ id, name })), syntheticJordan: syntheticJordan.map(({ id, name }) => ({ id, name })), collisions }, null, 2));
} finally {
  await prisma.$disconnect();
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
