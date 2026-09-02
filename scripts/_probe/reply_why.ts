// READ-ONLY: for each row that LEFT the Replies tab, which rule removed it —
// and would it still have gone if the other rules had not fired?
import { prisma } from "@/lib/prisma";
const NAMES = ["Sarina Spinelli", "Tabitha Heit", "Stephen Kennedy", "James Livingston", "Erica Walker"];
const TAPBACK = /^(loved|liked|laughed at|emphasi[sz]ed|disliked)\b/i;
async function main() {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const team = await prisma.teamMember.findMany({ select: { name: true, phone: true } });
  const teamPhones = new Set(team.map((t) => (t.phone ?? "").replace(/\D/g, "").slice(-10)).filter((k) => k.length === 10));
  for (const n of NAMES) {
    const c = await prisma.client.findFirst({ where: { name: n }, select: { id: true, name: true } });
    const where = c
      ? { clientId: c.id }
      : { fromPhone: (await prisma.commLog.findFirst({ where: { contactName: n, channel: "text" }, orderBy: { occurredAt: "desc" }, select: { fromPhone: true } }))?.fromPhone ?? "___" };
    const rows = await prisma.commLog.findMany({
      where: { channel: { in: ["text", "call"] }, occurredAt: { gte: since }, ...where },
      orderBy: { occurredAt: "asc" },
      select: { direction: true, contactName: true, fromPhone: true, source: true, body: true, occurredAt: true },
    });
    if (!rows.length) { console.log(`\n### ${n}: no rows in window`); continue; }
    const last = rows[rows.length - 1];
    const lastRealInboundIdx = [...rows].map((r, i) => ({ r, i }))
      .filter(({ r }) => r.direction === "in" && !TAPBACK.test(r.body.trim()))
      .filter(({ r }) => !(r.fromPhone && teamPhones.has(r.fromPhone) && !(c === null)))
      .map(({ i }) => i).pop() ?? -1;
    const anyOursAfter = lastRealInboundIdx >= 0 && rows.slice(lastRealInboundIdx + 1).some(
      (r) => r.direction === "out" || ["us", "realtour pilot"].includes((r.contactName ?? "").toLowerCase()) ||
             (r.fromPhone && teamPhones.has(r.fromPhone) && !!c),
    );
    const tasks = c ? await prisma.smartTask.findMany({
      where: { clientId: c.id, taskType: "client_reply", status: "COMPLETED", completedAt: { gte: since } },
      select: { completedAt: true, source: true }, orderBy: { completedAt: "desc" }, take: 1,
    }) : [];
    const lastMsgAt = rows[lastRealInboundIdx]?.occurredAt;
    console.log(`\n### ${n}`);
    console.log(`   newest row               : dir=${last.direction} contact=${JSON.stringify(last.contactName)} :: ${last.body.replace(/\s+/g, " ").slice(0, 60)}`);
    console.log(`   newest row is a TAPBACK  : ${TAPBACK.test(last.body.trim())}`);
    console.log(`   newest real inbound      : ${lastMsgAt?.toISOString() ?? "none"} :: ${(rows[lastRealInboundIdx]?.body ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
    console.log(`   OUR SIDE answered after  : ${anyOursAfter}`);
    console.log(`   handled tick (task)      : ${tasks[0] ? `${tasks[0].completedAt?.toISOString()} src=${tasks[0].source} → ${lastMsgAt && tasks[0].completedAt! > lastMsgAt ? "AFTER the message (clears)" : "before the message (does not clear)"}` : "none"}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
