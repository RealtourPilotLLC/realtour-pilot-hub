// Read-only: why can't Erica Walker book October filming?
import { prisma } from "@/lib/prisma";
import { sessionGatesFor, portalScheduleMonths } from "@/lib/portal";
import { recalcProgramMonth } from "@/lib/programMonths";
(async () => {
  const E = "cmt7h6b0300059kcj990r34x7", OCT = "cmucv446y0046lc043pq9mitr";
  const g = await sessionGatesFor(E, OCT);
  console.log("GATE", JSON.stringify(g, null, 0).slice(0, 1800));
  const r = await recalcProgramMonth(OCT, { dryRun: true });
  const a = (r as { after?: Record<string, unknown> } | null)?.after ?? r;
  console.log("DERIVED", JSON.stringify(a, (k, v) => (["records", "scripts", "topics", "interviews"].includes(k) ? undefined : v)).slice(0, 2500));
  const sm = await portalScheduleMonths({ id: E, clientId: "cmqikslcr00999k9q5809i927" });
  console.log("SCHED", JSON.stringify(sm).slice(0, 1500));
  const sc = await prisma.contentScript.groupBy({ by: ["status"], where: { monthId: OCT }, _count: true }).catch((e) => String(e).slice(0, 200));
  console.log("SCRIPTS", JSON.stringify(sc));
  await prisma.$disconnect();
})();
