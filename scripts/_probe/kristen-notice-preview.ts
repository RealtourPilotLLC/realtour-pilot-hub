// Read-only: will Kristen get the "you have a reply" email, and when?
import { prisma } from "@/lib/prisma";
import { sweepProgramMessageNotices } from "@/lib/programMessages";
(async () => {
  for (const at of [new Date(), new Date("2026-10-22T13:30:00Z")]) {
    const r = await sweepProgramMessageNotices({ now: at, enrollmentId: "cmve60q460003jn0702c8rfgd", dryRun: true });
    console.log(at.toISOString(), JSON.stringify({ skipped: r.skipped, considered: r.considered, notes: r.notes, preview: r.preview }).slice(0, 700));
  }
  await prisma.$disconnect();
})();
