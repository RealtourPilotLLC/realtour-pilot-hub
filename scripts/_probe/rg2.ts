import { prisma } from "../../src/lib/prisma";
async function main() {
  const cid = "cmqiksj94007m9k9qy8f4l51n"; // Sarina Spinelli
  const since = new Date(Date.now() - 14 * 86400000);
  const logs = await prisma.commLog.findMany({
    where: { clientId: cid, occurredAt: { gte: since } },
    orderBy: { occurredAt: "asc" },
    select: { channel: true, direction: true, contactName: true, fromPhone: true, source: true, body: true, occurredAt: true },
  });
  console.log("--- Sarina CommLog ---");
  for (const l of logs) console.log(`${l.occurredAt.toISOString()} ${l.channel}/${l.direction} src=${l.source} from=${l.contactName}/${l.fromPhone} :: ${JSON.stringify((l.body??"").slice(0,90))}`);
  const tasks = await prisma.smartTask.findMany({
    where: { clientId: cid, taskType: "client_reply" },
    orderBy: { createdAt: "desc" }, take: 6,
    select: { id: true, status: true, source: true, sourceDetail: true, createdAt: true, completedAt: true, title: true, summary: true, reasonCreated: true },
  });
  console.log("--- Sarina client_reply tasks ---");
  for (const t of tasks) console.log(JSON.stringify(t));
}
main().finally(() => prisma.$disconnect());
