// Oct 7 2026 (Jordan: "Deploy it", after the strategy-calls desk shipped):
// read "30 Minute Strategy Call" as a possible strategy call (same writes as
// settings/calendlyActions.saveCalendlyMapping), re-read Calendly 30 days back /
// 14 ahead, then file John Collins' Oct 6 call and Joe Sutow's Sep 24 call on
// their October months (assignStrategyCall). No Calendly writes, no messages.
import { prisma } from "../../../src/lib/prisma";
const URI = "https://api.calendly.com/event_types/521830b5-64f2-4450-b079-2265acfcd8b2";
const BY = "info@realtourpilot.com";
(async () => {
  const { listEventTypes } = await import("../../../src/lib/integrations/calendly");
  const live = (await listEventTypes()).find((t) => t.uri === URI);
  if (!live) throw new Error("event type not on the account");
  const now = new Date();
  await prisma.programCalendlyEventMapping.upsert({
    where: { eventTypeUri: URI },
    create: { eventTypeUri: URI, eventName: live.name, publicUrl: live.schedulingUrl, purpose: "STRATEGY_CANDIDATE", enabled: true, hostUri: live.ownerUri, validationStatus: live.active ? "VALID" : "MISSING", validatedAt: now, createdBy: BY },
    update: { eventName: live.name, publicUrl: live.schedulingUrl, purpose: "STRATEGY_CANDIDATE", enabled: true, hostUri: live.ownerUri, validationStatus: live.active ? "VALID" : "MISSING", validatedAt: now, lastError: null },
  });
  console.log("mapped", live.name);
  const cr = await import("../../../src/lib/contentCallRecords");
  const sync = await cr.syncCallRecordsFromCalendly({ lookBackDays: 30, lookAheadDays: 14 });
  console.log("sync", JSON.stringify(sync));
  const targets = [
    { who: "John Collins", clientId: "cmqikscae00729k9qhgyg0w39", at: "2026-10-06T20:00:00.000Z" },
    { who: "Joseph Sutow", clientId: "cmud1igk900qbjs04jlnxa1l6", at: "2026-09-24T14:00:00.000Z" },
  ];
  for (const t of targets) {
    const rec = await prisma.programCallRecord.findFirst({ where: { scheduledStart: new Date(t.at), status: { notIn: ["CANCELLED"] } }, select: { id: true, matchState: true, monthId: true, inviteeName: true, clientId: true } });
    console.log(t.who, "record", rec);
    if (!rec) continue;
    const r = await cr.assignStrategyCall(rec.id, { clientId: t.clientId, monthKey: "2026-10" }, BY);
    console.log(t.who, "assign", JSON.stringify(r));
  }
  for (const id of ["cmup0bq5000qkjg04vm4tgnrp", "cmup0bq4q00qjjg04tb2fqhri"]) {
    const m = await prisma.contentMonth.findUnique({ where: { id }, select: { monthKey: true, planningMode: true, strategyCallStatus: true, strategyCallAt: true, callRecordId: true, preparationStatus: true } });
    console.log(id, m);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
