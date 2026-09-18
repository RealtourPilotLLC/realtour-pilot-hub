// READ-ONLY against production. Two questions the change must answer "no" to:
//   1. does the new due-filter hide anything that is queued right now?
//   2. is the live coverage rule sane, and is anybody on the rota today?
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const unsent = await prisma.pendingSms.count({ where: { sentAt: null, skippedAt: null } });
  const due = await prisma.pendingSms.count({
    where: { sentAt: null, skippedAt: null, OR: [{ deferUntil: null }, { deferUntil: { lte: now } }] },
  });
  const deferred = await prisma.pendingSms.count({ where: { deferUntil: { not: null } } });
  console.log(`PendingSms: ${unsent} unsent, ${due} due under the new filter, ${deferred} rows carry a deferUntil`);
  console.log(unsent === due ? "  OK — nothing queued today becomes newly held" : "  WARNING — the filter would hide a queued line");

  const row = await prisma.appSetting.findUnique({ where: { key: "internal_alerts" } });
  console.log(`\nAppSetting internal_alerts: ${row ? "present" : "MISSING (defaults apply)"}`);
  if (row) console.log(`  stored value: ${JSON.stringify(row.value)}`);

  const staff = await prisma.teamMember.findMany({
    where: { active: true, opsAlerts: true },
    select: { name: true, slackId: true, phone: true },
  });
  console.log(`\nwho photos-undelivered texts today (opsAlerts = true):`);
  for (const s of staff) console.log(`  ${s.name} — slack ${s.slackId ? "yes" : "no"}, phone ${s.phone ?? "none"}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
