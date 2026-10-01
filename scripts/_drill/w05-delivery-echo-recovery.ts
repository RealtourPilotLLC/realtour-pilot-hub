// @drill-run: engine=postgres timeout=240
// W05: real held outbox rows + verified webhook transport + notice stamping.
// Disposable real Postgres, fake provider, no send/retry/activation authority.
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const c = makeChecker();
const LINE = "+16105550100", TO = "6105550143", TOKEN = "isolated-w05-webhook-proof";

async function main() {
  const db = await bootDrillDb({ port: 5972, engine: "postgres", pool: 5, env: { APP_SECRET: "isolated-w05-not-a-production-secret" } });
  const req = createRequire(__filename), saved = new Map<string, NodeModule | undefined>();
  const stub = (relative: string, exports: Record<string, unknown>) => {
    const file = req.resolve(relative); saved.set(file, req.cache[file]);
    req.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, ...exports } } as NodeModule;
  };
  try {
    const { prisma } = await import("@/lib/prisma");
    const outbox = await import("@/lib/outbox");
    const { stampNoticesFromDeliveryTexts } = await import("@/lib/readyToSend");
    const op = await import("@/lib/integrations/openphone");
    const { saveSecret } = await import("@/lib/integrations/connections");
    let liveSends = 0, fakeAttempts = 0;
    op.OpenPhone.phoneNumbers = async () => [{ id: "PN-W05", number: LINE }];
    op.OpenPhone.sendMessage = async () => { liveSends++; throw new Error("No production provider send is permitted in this fixture"); };
    // Other communication classification is outside this named proof. These
    // stubs prevent an unrelated incoming test variant from minting a lead.
    stub("../../src/lib/contacts.ts", { resolveClientByPhones: async () => null, resolveSenderName: async () => ({ name: "system notification" }), findActiveProjectByText: async () => null, findClientProjectByText: async () => null });
    const { POST } = await import("@/app/api/webhooks/openphone/route");
    const { NextRequest } = await import("next/server");
    await saveSecret("openphone_webhook", TOKEN);
    const client = await prisma.client.create({ data: { name: "W05 Exact Proof TEST" } });
    const mkJob = (label: string) => prisma.project.create({ data: { clientId: client.id, title: `W05 ${label} TEST`, status: "DELIVERED" } });
    const attempt = outbox.createOutbox({ store: outbox.prismaOutboxStore(), provider: { send: async () => { fakeAttempts++; throw new outbox.OutboxSendError("isolated provider accepted then timed out", true); } } });
    const job = await mkJob("exact timeout");
    const body = "Your media for 117 Acceptance Lane is ready.";
    const r = await attempt.sendThroughOutbox({ channel: "sms", toRef: TO, body, dedupeKey: outbox.deliveryKey(job.id), projectId: job.id, clientId: client.id });
    c.ok("real outbox attempt ends unknown with its identity held", r.outcome === "unknown" && (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: r.id } })).attempts === 1);
    const row = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: r.id } });
    const providerAt = new Date(row.createdAt.getTime() + 1000);
    const earlier = await prisma.reviewSubmission.create({ data: { projectId: job.id, fileName: "prior.mp4", status: "APPROVED", sentToClientAt: new Date(providerAt.getTime() - 500) } });
    const later = await prisma.reviewSubmission.create({ data: { projectId: job.id, fileName: "later.mp4", status: "APPROVED", sentToClientAt: new Date(providerAt.getTime() + 500) } });
    const event = (id: string, overrides: Record<string, unknown> = {}) => ({ id: `EVT-${id}`, type: "message.delivered", data: { object: { id, from: LINE, to: [`+1${TO}`], direction: "outgoing", text: body, createdAt: providerAt.toISOString(), ...overrides } } });
    const post = (payload: object, token = TOKEN) => POST(new NextRequest(`http://localhost/api/webhooks/openphone?t=${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify(payload) }));
    const isHeld = async () => (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: r.id } })).state === "unknown";
    c.ok("unknown delivery stamps no client notice", (await stampNoticesFromDeliveryTexts()).stamped === 0 && !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: earlier.id } })).clientNoticeAt);
    c.ok("bad webhook token cannot settle proof", (await post(event("bad-token"), "wrong")).status === 401 && await isHeld());
    await saveSecret("openphone_webhook", "");
    await post(event("unsigned"));
    c.ok("legacy unsigned acceptance cannot settle delivery", await isHeld());
    await saveSecret("openphone_webhook", TOKEN);
    for (const [label, overrides] of [
      ["missing provider message id", { id: null }], ["missing original time", { createdAt: null }], ["invalid original time", { createdAt: "not-a-date" }],
      ["non-delivery event", { eventType: "message.received" }], ["wrong recipient", { to: ["+16105550188"] }], ["different body", { text: `${body} Changed` }],
      ["group recipients", { to: [`+1${TO}`, "+16105550188"] }], ["attachment context", { media: [{ url: "https://isolated.invalid/attachment" }] }],
      ["unrecognized sender", { from: "+16105550188", direction: "incoming" }],
    ] as [string, Record<string, unknown>][]) {
      const payload = event(`held-${label}`, overrides);
      if (overrides.eventType) { payload.type = String(overrides.eventType); delete (payload.data.object as Record<string, unknown>).eventType; }
      await post(payload);
      c.ok(`${label} leaves exact delivery held`, await isHeld());
    }
    const beforeRecovery = fakeAttempts;
    c.ok("verified exact workspace delivery event processes", (await post(event("OP-W05-EXACT"))).status === 200);
    const accepted = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: r.id } });
    c.ok("existing row is accepted at original provider time, dedupe retained", accepted.state === "accepted" && accepted.providerId === "OP-W05-EXACT" && accepted.acceptedAt?.getTime() === providerAt.getTime() && accepted.dedupeKey === row.dedupeKey && accepted.attempts === 1 && accepted.providerError === null && accepted.leaseBy === null && accepted.leaseUntil === null);
    c.ok("recovery neither calls provider nor makes a replacement intent", fakeAttempts === beforeRecovery && liveSends === 0 && await prisma.outboxMessage.count({ where: { projectId: job.id } }) === 1);
    const stamped = await stampNoticesFromDeliveryTexts();
    const stampedEarlier = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: earlier.id } });
    c.ok("existing accepted-text sweep stamps only cuts sent before provider time", stamped.stamped === 1 && stampedEarlier.clientNoticeAt?.getTime() === providerAt.getTime() && stampedEarlier.clientNoticeRef === r.id && stampedEarlier.clientNoticeVia === "hub-text" && !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: later.id } })).clientNoticeAt);
    c.ok("echo and stamp replay is idempotent", (await post(event("OP-W05-EXACT"))).status === 200 && (await stampNoticesFromDeliveryTexts()).stamped === 0 && fakeAttempts === beforeRecovery);

    c.head("Ambiguous or changed evidence stays held");
    let seq = 0;
    const makeHeld = async (patch: Record<string, unknown> = {}) => {
      const p = await mkJob(`hold-${++seq}`);
      return prisma.outboxMessage.create({ data: { channel: "sms", toRef: TO, body: `Unique isolated proof ${seq}`, state: "unknown", attempts: 1, projectId: p.id, dedupeKey: outbox.deliveryKey(p.id), createdAt: new Date(Date.now() - 10_000), ...patch } });
    };
    const settle = (held: Awaited<ReturnType<typeof makeHeld>>, patch: Record<string, unknown> = {}) => outbox.settleUnknownDeliveryFromEcho({ toRef: TO, body: held.body, providerId: `OP-${held.id}`, at: new Date(held.createdAt.getTime() + 1000), ...patch });
    for (const [label, patch] of [
      ["never attempted", { attempts: 0 }], ["still pending", { state: "pending" }], ["failed", { state: "failed" }], ["released identity", { dedupeKey: null }],
      ["wrong delivery key", { dedupeKey: "delivery:unrelated-job" }], ["manual intent", { dedupeKey: "manual:isolated-hold" }],
      ["stored group context", { extraToRefsJson: '["6105550199"]' }], ["stored attachment context", { mediaUrlsJson: '["https://isolated.invalid/media"]' }],
      ["conflicting recorded provider id", { providerId: "OP-different" }],
    ] as [string, Record<string, unknown>][]) {
      const held = await makeHeld(patch);
      c.ok(`${label} cannot inherit delivery evidence`, !(await settle(held)) && (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: held.id } })).state === held.state);
    }
    const stale = await makeHeld({ createdAt: new Date(Date.now() - 7 * 3600_000) });
    c.ok("stale past-window or future proof remains held", !(await settle(stale, { at: new Date() })) && !(await settle(stale, { at: new Date(Date.now() + 10 * 60_000) })));
    const priorProof = await makeHeld();
    c.ok("provider message created before this intent cannot settle its later timeout", !(await settle(priorProof, { at: new Date(priorProof.createdAt.getTime() - 60_000) })) && (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: priorProof.id } })).state === "unknown");
    const ambiguous = await makeHeld();
    const other = await makeHeld({ body: ambiguous.body });
    c.ok("two matching jobs are ambiguous, neither is selected", !(await settle(ambiguous)) && (await prisma.outboxMessage.findMany({ where: { id: { in: [ambiguous.id, other.id] } } })).every((x) => x.state === "unknown"));
    const manualConflict = await makeHeld();
    await prisma.outboxMessage.create({ data: { channel: "sms", toRef: TO, body: manualConflict.body, state: "accepted", attempts: 1, dedupeKey: "manual:isolated-collision", createdAt: manualConflict.createdAt, providerId: "OP-manual" } });
    c.ok("matching manual history is a hold, not a newest-row guess", !(await settle(manualConflict)));
    const reused = await makeHeld();
    c.ok("provider id already claimed by another intent is refused", !(await settle(reused, { providerId: "OP-W05-EXACT" })));
    const concurrent = await makeHeld();
    const twins = await Promise.all([settle(concurrent), settle(concurrent)]);
    c.ok("concurrent exact echoes settle one row once", twins.filter(Boolean).length === 1 && (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: concurrent.id } })).state === "accepted");
    const idRaceA = await makeHeld(), idRaceB = await makeHeld();
    const idRace = await Promise.all([settle(idRaceA, { providerId: "OP-race-shared" }), settle(idRaceB, { providerId: "OP-race-shared" })]);
    c.ok("concurrent different intents cannot share one provider proof", idRace.filter(Boolean).length === 1 && await prisma.outboxMessage.count({ where: { providerId: "OP-race-shared", state: "accepted" } }) === 1);
    const manual = await makeHeld({ dedupeKey: "manual:isolated-existing-rule" });
    c.ok("existing manual echo matcher still settles its own held row", await outbox.settleUnknownFromEcho({ toRef: TO, body: manual.body, providerId: "OP-existing-manual", at: new Date(manual.createdAt.getTime() + 1000) }));
    c.ok("no new task, activation, or provider send was introduced", await prisma.smartTask.count() === 0 && await prisma.programAutomation.count() === 0 && liveSends === 0 && fence.blocked.length === 0);
    console.log(await db.evidence()); c.summary();
  } finally {
    for (const [file, original] of saved) {
      if (original) req.cache[file] = original;
      else delete req.cache[file];
    }
    fence.restore(); await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
