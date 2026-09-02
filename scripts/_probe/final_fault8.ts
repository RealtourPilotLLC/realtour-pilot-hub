// READ-ONLY. Runs the SHIPPED helpers; renders the exact close text (no writes).
import { PrismaClient } from "@prisma/client";
import { deliveryTextDueAt, deliveryTextSendProof } from "../../src/lib/tasks";
import { clip } from "../../src/lib/text";
import { etDateTime } from "../../src/lib/datetime";
const prisma = new PrismaClient();
const DAY = 86_400_000;
const et = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function reason(days: number, who: string, job: string, clientTextedAt: Date | null) {
  return clip(
    `Closed unsent after ${days} days. No delivery text ever reached ${who} about ${job} — nothing went out from the hub, and no outbound text to them is filed against this job. ` +
      (clientTextedAt ? `We did text ${who} on ${etDateTime(clientTextedAt)} ET, but about another job. ` : `${who} was not texted at all in that window. `) +
      `It is NOT counted as done. Text them by hand if it still helps.`,
    500,
  );
}

(async () => {
  const comp = await prisma.smartTask.findMany({
    where: { taskType: "delivery_text", status: "COMPLETED", createdAt: { gte: new Date(Date.now() - 61 * DAY) } },
    select: { id: true, title: true, createdAt: true, completedAt: true, clientId: true, projectId: true, propertyAddress: true, client: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const swept = comp.filter((t) => t.completedAt!.getTime() - t.createdAt.getTime() >= 7 * DAY);
  console.log(`THE ${swept.length} TASKS THE 7-DAY SWEEPER CREDITED AS "DONE" (60d)\n`);
  let cx = 0;
  for (const t of swept) {
    const p = await deliveryTextSendProof(t, t.completedAt!);
    const who = t.client?.name ?? "the client";
    const job = t.propertyAddress ?? "this job";
    console.log(`${t.id}  ${job.slice(0, 46)}`);
    console.log(`   minted ${et(t.createdAt)} ET | old dueAt = minted-instant (overdue at birth) | NEW dueAt ${et(deliveryTextDueAt(t.createdAt, 16))} ET`);
    console.log(`   was: COMPLETED ${et(t.completedAt!)} ET`);
    if (p.how) { console.log(`   now: COMPLETED — proof: ${p.how} @ ${et(p.at!)} ET`); }
    else { cx++; console.log(`   now: CANCELLED — "${reason(7, who, job, p.clientTextedAt)}"`); }
    console.log("");
  }
  console.log(`BEFORE  ${swept.length} COMPLETED / 0 CANCELLED`);
  console.log(`AFTER   ${swept.length - cx} COMPLETED / ${cx} CANCELLED\n`);

  // Feedback-link reach — what is actually being lost.
  const d30 = new Date(Date.now() - 30 * DAY);
  const reached = await prisma.commLog.findMany({ where: { channel: "text", direction: "out", source: "auto-delivery", occurredAt: { gte: d30 } }, select: { clientId: true } });
  console.log(`feedback ask actually sent in 30d: ${reached.length} texts to ${new Set(reached.map(r => r.clientId)).size} clients`);
  const minted = await prisma.smartTask.count({ where: { taskType: "delivery_text", createdAt: { gte: d30 } } });
  console.log(`delivery-text tasks minted in the same 30d: ${minted}`);
})().finally(() => prisma.$disconnect());
