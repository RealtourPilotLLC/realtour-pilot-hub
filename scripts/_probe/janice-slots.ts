// Read-only (writes only the slot cache): Janice's offered filming starts, earliest and latest per day.
import { prisma } from "@/lib/prisma";
import { sessionSlotsFor } from "@/lib/sessionTravel";
(async () => {
  const E = "cmue43gsi0044k404p9zwxruh";
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: E, monthKey: { in: ["2026-10", "2026-11"] } }, select: { id: true, monthKey: true } });
  const t = (s: string) => new Date(s).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  for (const m of months) {
    const r = await sessionSlotsFor({ enrollmentId: E, monthId: m.id, sessionIndex: 1, package: "Accelerator" });
    console.log(m.monthKey, "ok", r.ok, r.message ?? "", r.needsAddress ? "needsAddress" : "");
    for (const d of r.days.slice(0, 8)) console.log("  ", d.date, d.slots.length, "starts", t(d.slots[0]), "→", t(d.slots[d.slots.length - 1]));
  }
  await prisma.$disconnect();
})();
