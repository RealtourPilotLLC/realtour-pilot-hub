// Oct 12 2026 (Jordan: "I had a strategy call with Kristin, her social content
// scripts are written and her topics are chosen … make sure her scripts and
// session for this month show up"). Her Sep 25 "Content Program - Strategy
// Call" (unclassified, transcript confirmed) is her October planning call:
// staff assign via contentCallRecords.assignStrategyCall.
import { prisma } from "../../../src/lib/prisma";
(async () => {
  const rec = await prisma.programCallRecord.findFirst({ where: { clientId: "cmt7n3fw2006w9kg10ne5wwo7", scheduledStart: new Date("2026-09-25T18:30:00.000Z") }, select: { id: true } });
  if (!rec) throw new Error("call not found");
  const { assignStrategyCall } = await import("../../../src/lib/contentCallRecords");
  console.log(JSON.stringify(await assignStrategyCall(rec.id, { clientId: "cmt7n3fw2006w9kg10ne5wwo7", monthKey: "2026-10" }, "info@realtourpilot.com")));
  console.log(await prisma.contentMonth.findUnique({ where: { id: "cmuflppho00o6l604ts9h2swg" }, select: { planningMode: true, strategyCallStatus: true, strategyCallAt: true, callRecordId: true } }));
  const jobs = await prisma.programTranscriptJob?.findMany?.({ where: { callRecordId: rec.id }, select: { kind: true, state: true } }).catch(() => null);
  console.log("jobs", jobs, "rec", rec.id);
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
