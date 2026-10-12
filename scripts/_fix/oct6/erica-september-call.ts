// Oct 12 2026 (Jordan): "Erica's call, scripts, and topics were for last month's
// content (September). Can we please make sure the system reflects that? She
// still needs everything for this month." Her Sep 24 call was analysed today
// with no month filed, so its 4 PROPOSED topics landed on October. Here:
// 1) assign the call to September (contentCallRecords.assignStrategyCall);
// 2) move that call's selections October → September (same topic, same status);
// 3) recalc both months. Nothing client-facing is sent.
import { prisma } from "../../../src/lib/prisma";
const CID = "cmqikslcr00999k9q5809i927", CALL = "cmucv446a0045lc049eugnwvj";
const SEP = "cmti54uot0051ic04rtzwrgn6", OCT = "cmucv446y0046lc043pq9mitr";
(async () => {
  const { assignStrategyCall } = await import("../../../src/lib/contentCallRecords");
  console.log("assign:", JSON.stringify(await assignStrategyCall(CALL, { clientId: CID, monthKey: "2026-09" }, "info@realtourpilot.com")));
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: OCT }, select: { id: true, topicId: true, status: true, callRecordId: true, source: true } });
  console.log("October selections:", JSON.stringify(sels));
  let moved = 0;
  for (const s of sels) {
    if (s.callRecordId && s.callRecordId !== CALL) { console.log("skip (another call)", s.id); continue; }
    const clash = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: s.topicId, monthId: SEP } } });
    if (clash) { console.log("skip (already on September)", s.topicId); continue; }
    await prisma.contentTopicSelection.update({ where: { id: s.id }, data: { monthId: SEP } });
    await prisma.contentTopic.updateMany({ where: { id: s.topicId, monthId: OCT } as any, data: { monthId: SEP } as any }).catch(() => null);
    moved++;
  }
  const { recalcProgramMonth } = await import("../../../src/lib/programMonths");
  await recalcProgramMonth(SEP); await recalcProgramMonth(OCT);
  for (const id of [SEP, OCT]) {
    const m = await prisma.contentMonth.findUnique({ where: { id }, select: { monthKey: true, strategyCallStatus: true, strategyCallAt: true, planningMode: true, preparationStatus: true } });
    const n = await prisma.contentTopicSelection.count({ where: { monthId: id } });
    console.log(m, "selections:", n);
  }
  console.log("moved", moved);
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
