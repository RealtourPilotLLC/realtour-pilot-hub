// Live one-off (Oct 21 2026, Jordan): Kristen Pavillard signed up but must have
// her brand discovery call (booked Thu Oct 29, 10 AM ET) before any email asks
// her to book a shoot or a strategy call. Snoozes the reminder engine on both
// of her open months (primary, brand kit and script lanes) until Mon Nov 9 ET.
// Reversible: unsnoozeMonthReminders(monthId). Dry run unless --apply.
import { prisma } from "@/lib/prisma";
import { snoozeMonthReminders } from "@/lib/programReminders";

const CLIENT = "cmve60q3t0002jn07nk4vg9fw";
const UNTIL = new Date("2026-11-09T05:00:00.000Z"); // Mon Nov 9, 00:00 ET
const REASON = "Jordan (Oct 21): discovery call first (booked Oct 29, 10 AM). No shoot or strategy-call emails until it is held.";
const apply = process.argv.includes("--apply");

(async () => {
  const months = await prisma.contentMonth.findMany({ where: { clientId: CLIENT, status: "OPEN" }, select: { id: true, monthKey: true, remindersSnoozedUntil: true } });
  for (const m of months) {
    console.log(m.monthKey, "now snoozed until", m.remindersSnoozedUntil?.toISOString() ?? "-", apply ? "→ applying" : "(dry run)");
    if (apply) await snoozeMonthReminders(m.id, UNTIL, REASON, "jordan via claude");
  }
  await prisma.$disconnect();
})();
