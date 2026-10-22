// Read-only: what would the reminder engine send Kristen Pavillard (Oct + Nov months)?
import { prisma } from "@/lib/prisma";
import { previewReminders } from "@/lib/programReminders";
(async () => {
  const months = await prisma.contentMonth.findMany({ where: { clientId: "cmve60q3t0002jn07nk4vg9fw" }, select: { id: true, monthKey: true, status: true, remindersSnoozedUntil: true } });
  console.log(JSON.stringify(months));
  for (const m of months) {
    const pv = await previewReminders(m.id);
    for (const l of pv.lanes) console.log(m.monthKey, l.lane, JSON.stringify({ action: l.candidate.action, decision: l.candidate.decision, reason: l.candidate.reason, suppression: l.candidate.suppressionReason, when: (l.candidate as any).nextAt ?? (l.candidate as any).sendAt ?? null }), "\n  BODY:", (l.body ?? "").slice(0, 300).replace(/\n/g, " "));
    console.log(m.monthKey, "ADDRESS", JSON.stringify(pv.addressLane).slice(0, 300));
  }
  await prisma.$disconnect();
})();
