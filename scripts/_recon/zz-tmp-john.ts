import { prisma } from "@/lib/prisma";
async function main() {
  const c = await prisma.client.findFirst({ where: { name: "John Collins" }, select: { id: true } });
  const e = await prisma.contentEnrollment.findFirst({ where: { clientId: c!.id, status: "ACTIVE" }, select: { id: true, package: true, videosPerMonth: true, sessionsPerMonth: true, overridesJson: true } });
  console.log("enrollment", JSON.stringify({ ...e, overridesJson: (e?.overridesJson ?? "").slice(0, 300) }));
  const m = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId: e!.id, monthKey: "2026-10" } }, select: { id: true, videosOwed: true, status: true, strategyCallStatus: true, planningMode: true, preparationStatus: true } });
  console.log("october", JSON.stringify(m));
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: m!.id }, orderBy: [{ rank: "asc" }, { createdAt: "asc" }], select: { topicId: true, status: true, source: true, rank: true, callRecordId: true, createdAt: true } });
  for (const s of sels) {
    const t = await prisma.contentTopic.findUnique({ where: { id: s.topicId }, select: { title: true, status: true } });
    const sc = await prisma.contentScript.findFirst({ where: { topicId: s.topicId, monthId: m!.id }, select: { status: true, source: true } });
    console.log(`  ${s.status.padEnd(10)} ${s.source.padEnd(7)} rank=${s.rank ?? "-"} script=${sc ? `${sc.source}/${sc.status}` : "none"} · ${t?.title?.slice(0, 70)}`);
  }
  const calls = await prisma.programCallRecord.findMany({ where: { enrollmentId: e!.id, scheduledStart: { gte: new Date("2026-09-15") } }, select: { id: true, status: true, monthId: true, scheduledStart: true, transcriptState: true } });
  console.log("calls", JSON.stringify(calls));
  const jobs = await prisma.project.findMany({ where: { contentMonthId: m!.id }, select: { title: true, status: true, shootDate: true } });
  console.log("jobs", JSON.stringify(jobs));
}
main().then(() => prisma.$disconnect());
