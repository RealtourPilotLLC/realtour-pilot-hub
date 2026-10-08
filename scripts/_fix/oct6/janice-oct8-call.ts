// Oct 7 2026: Janice Pigga's "Content Program - Strategy Call" on Oct 8 2 PM ET
// is her October planning call (Jordan: everyone but John/Joe still needs an
// October call; this is Janice's booking). Staff assign via assignStrategyCall.
import { prisma } from "../../../src/lib/prisma";
(async () => {
  const ids = (await prisma.client.findMany({ where: { name: "Janice Pigga" }, select: { id: true } })).map((x) => x.id); const e = await prisma.contentEnrollment.findFirst({ where: { status: "ACTIVE", clientId: { in: ids } }, select: { clientId: true } }); const c = e ? { id: e.clientId } : null;
  const rec = await prisma.programCallRecord.findFirst({ where: { scheduledStart: new Date("2026-10-08T18:00:00.000Z"), inviteeName: { contains: "Janice" }, status: "SCHEDULED" }, select: { id: true } });
  if (!c || !rec) throw new Error("not found");
  const { assignStrategyCall } = await import("../../../src/lib/contentCallRecords");
  console.log(JSON.stringify(await assignStrategyCall(rec.id, { clientId: c.id, monthKey: "2026-10" }, "info@realtourpilot.com")));
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
