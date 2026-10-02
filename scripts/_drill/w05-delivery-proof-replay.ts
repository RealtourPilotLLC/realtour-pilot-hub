// @drill-run: engine=postgres timeout=240
// Actual authenticated POST and stored replay after transient failure/restart.
// Disposable Postgres, no provider send, activation or live database mutation.
import { createRequire } from "node:module";
import { attachDrillChild, bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const LINE = "+16105550100", TO = "6105550143", TOKEN = "isolated-w05-replay-proof";

async function prepareModules() {
  const req = createRequire(__filename);
  const file = req.resolve("../../src/lib/contacts.ts");
  req.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true,
    resolveClientByPhones: async () => null, resolveSenderName: async () => ({ name: "system notification" }),
    findActiveProjectByText: async () => null, findClientProjectByText: async () => null,
  } } as NodeModule;
  const op = await import("@/lib/integrations/openphone");
  op.OpenPhone.phoneNumbers = async () => [{ id: "PN-W05-REPLAY", number: LINE }];
  op.OpenPhone.sendMessage = async () => { throw new Error("Provider send forbidden in this fixture"); };
}

async function child() {
  const ctx = attachDrillChild();
  await prepareModules();
  let result;
  if (process.argv[2] === "cold-post") {
    const op = await import("@/lib/integrations/openphone");
    op.OpenPhone.phoneNumbers = async () => { throw new Error("isolated workspace-number lookup unavailable"); };
    const { POST } = await import("@/lib/webhooks/openphone");
    const { NextRequest } = await import("next/server");
    const response = await POST(new NextRequest(`http://localhost/api/webhooks/openphone?t=${TOKEN}`, { method: "POST", body: process.argv[3] }));
    result = { ok: response.status === 200 };
  } else {
    const { retryWebhookEventNow } = await import("@/lib/webhookRetry");
    result = await retryWebhookEventNow(process.argv[3]);
  }
  await ctx.send({ result, blocked: ctx.fence.blocked.length });
  await ctx.exit();
}

async function main() {
  const c = makeChecker(), fence = fenceFetch();
  const db = await bootDrillDb({ port: 5972, engine: "postgres", pool: 5, env: { APP_SECRET: "isolated-w05-replay-key" } });
  try {
    await prepareModules();
    const { prisma } = await import("@/lib/prisma");
    const outbox = await import("@/lib/outbox");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const proof = await import("@/lib/openPhoneDeliveryProof");
    const { POST } = await import("@/lib/webhooks/openphone");
    const { NextRequest } = await import("next/server");
    const { retryWebhookEventNow, retryFailedWebhooks } = await import("@/lib/webhookRetry");
    const { stampNoticesFromDeliveryTexts } = await import("@/lib/readyToSend");
    await saveSecret("openphone_webhook", TOKEN);
    const client = await prisma.client.create({ data: { name: "W05 Restart TEST" } });
    let sequence = 0;
    const held = async () => {
      const job = await prisma.project.create({ data: { clientId: client.id, title: `W05 Restart ${++sequence} TEST`, status: "DELIVERED" } });
      const row = await prisma.outboxMessage.create({ data: { channel: "sms", toRef: TO, body: `Exact isolated delivery ${sequence}`, state: "unknown", attempts: 1, projectId: job.id, dedupeKey: outbox.deliveryKey(job.id), createdAt: new Date(Date.now() - 10_000) } });
      const at = new Date(row.createdAt.getTime() + 1000);
      const payload = { id: `EVT-${row.id}`, type: "message.delivered", data: { object: { id: `OP-${row.id}`, from: LINE, to: [`+1${TO}`], direction: "outgoing", text: row.body, createdAt: at.toISOString() } } };
      return { row, job, at, payload };
    };
    const post = (payload: object) => POST(new NextRequest(`http://localhost/api/webhooks/openphone?t=${TOKEN}`, { method: "POST", body: JSON.stringify(payload) }));
    const eventRow = (x: Awaited<ReturnType<typeof held>>) => prisma.webhookEvent.findFirstOrThrow({ where: { externalId: x.payload.id }, orderBy: { createdAt: "desc" } });
    const state = async (x: Awaited<ReturnType<typeof held>>) => (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: x.row.id } })).state;
    const originalTransaction = prisma.$transaction;
    const withSettlementFailure = async (run: () => Promise<unknown>) => {
      prisma.$transaction = ((...args: unknown[]) => {
        const options = args[1] as { isolationLevel?: string } | undefined;
        if (options?.isolationLevel === "Serializable") throw new Error("isolated transient settlement database failure");
        return Reflect.apply(originalTransaction, prisma, args);
      }) as typeof prisma.$transaction;
      try { await run(); } finally { prisma.$transaction = originalTransaction; }
    };

    c.head("Authenticated proof survives operational failure and process restart");
    const first = await held();
    const prior = await prisma.reviewSubmission.create({ data: { projectId: first.job.id, fileName: "prior.mp4", status: "APPROVED", sentToClientAt: new Date(first.at.getTime() - 500) } });
    const later = await prisma.reviewSubmission.create({ data: { projectId: first.job.id, fileName: "later.mp4", status: "APPROVED", sentToClientAt: new Date(first.at.getTime() + 500) } });
    await withSettlementFailure(() => post(first.payload));
    const failed = await eventRow(first);
    c.ok("actual POST retains ERROR instead of consuming failed settlement", failed.status === "ERROR" && failed.error?.includes("transient settlement") === true && await state(first) === "unknown");
    c.ok("verified receipt binds the persisted event without credentials or body", await proof.hasVerifiedOpenPhoneDeliveryProof(failed) && (await prisma.auditLog.findUniqueOrThrow({ where: { id: `openphone-verified:${failed.id}` } })).detail.match(/^[a-f0-9]{64}$/) !== null);
    const restarted = db.runChild(__filename, { args: ["replay", failed.id] });
    const answer = await restarted.waitFor<{ result: { ok: boolean }; blocked: number }>((m) => Boolean(m && typeof m === "object" && "result" in m));
    const exit = await restarted.exited;
    const accepted = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: first.row.id } });
    c.ok("fresh process reconstructs trusted replay from durable proof", exit.code === 0 && answer.result.ok && answer.blocked === 0 && await state(first) === "accepted");
    c.ok("replay keeps exact identity, provider time, attempts and dedupe", accepted.providerId === first.payload.data.object.id && accepted.acceptedAt?.getTime() === first.at.getTime() && accepted.attempts === 1 && accepted.dedupeKey === first.row.dedupeKey);
    c.ok("recovery stamps only cuts preceding original provider delivery", (await stampNoticesFromDeliveryTexts()).stamped === 1 && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: prior.id } })).clientNoticeAt?.getTime() === first.at.getTime() && !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: later.id } })).clientNoticeAt);
    c.ok("authenticated redelivery is idempotent after successful replay", (await (await post(first.payload)).json()).deduped === true && await prisma.outboxMessage.count({ where: { projectId: first.job.id } }) === 1);

    const redelivered = await held();
    await withSettlementFailure(() => post(redelivered.payload));
    await post(redelivered.payload);
    c.ok("authenticated provider redelivery recovers the original held intent", await state(redelivered) === "accepted");
    const sweep = await retryFailedWebhooks();
    c.ok("automatic replay resolves its processed verified twin without repeating work", sweep.deduped === 1 && await state(redelivered) === "accepted");

    const readFailure = await held();
    await withSettlementFailure(() => post(readFailure.payload));
    const readEvent = await eventRow(readFailure);
    const originalRead = prisma.auditLog.findUnique;
    prisma.auditLog.findUnique = (() => { throw new Error("isolated proof read unavailable"); }) as typeof prisma.auditLog.findUnique;
    let readResult;
    try { readResult = await retryWebhookEventNow(readEvent.id); } finally { prisma.auditLog.findUnique = originalRead; }
    c.ok("receipt read failure keeps replay ERROR and delivery unknown", !readResult.ok && (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: readEvent.id } })).status === "ERROR" && await state(readFailure) === "unknown");
    c.ok("proof read recovery permits the same stored event to settle", (await retryWebhookEventNow(readEvent.id)).ok && await state(readFailure) === "accepted");

    const unavailable = await held(), independent = await held();
    await withSettlementFailure(() => post(unavailable.payload));
    await withSettlementFailure(() => post(independent.payload));
    const unavailableEvent = await eventRow(unavailable);
    prisma.auditLog.findUnique = ((...args: unknown[]) => {
      const query = args[0] as { where?: { id?: string } };
      if (query.where?.id === `openphone-verified:${unavailableEvent.id}`) throw new Error("isolated single receipt unavailable");
      return Reflect.apply(originalRead, prisma.auditLog, args);
    }) as typeof prisma.auditLog.findUnique;
    let independentSweep;
    try { independentSweep = await retryFailedWebhooks(); } finally { prisma.auditLog.findUnique = originalRead; }
    const stillRetryable = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: unavailableEvent.id } });
    c.ok("automatic receipt read failure backoffs only its row and continues unrelated recovery", independentSweep.failed === 1 && independentSweep.recovered === 1 && stillRetryable.status === "ERROR" && stillRetryable.error?.includes("retry n=1 next=") === true && await state(unavailable) === "unknown" && await state(independent) === "accepted");
    c.ok("the original failed receipt remains usable after its read recovers", (await retryWebhookEventNow(unavailableEvent.id)).ok && await state(unavailable) === "accepted");

    const cold = await held();
    const coldProcess = db.runChild(__filename, { args: ["cold-post", JSON.stringify(cold.payload)] });
    const coldAnswer = await coldProcess.waitFor<{ result: { ok: boolean }; blocked: number }>((m) => Boolean(m && typeof m === "object" && "result" in m));
    const coldExit = await coldProcess.exited;
    const coldEvent = await eventRow(cold);
    c.ok("cold workspace-number failure retains ERROR and authenticated receipt", coldExit.code === 0 && coldAnswer.result.ok && coldAnswer.blocked === 0 && coldEvent.status === "ERROR" && coldEvent.error?.includes("Cannot confirm the workspace line") === true && await state(cold) === "unknown" && await proof.hasVerifiedOpenPhoneDeliveryProof(coldEvent));
    c.ok("stored replay after workspace-number recovery settles once without resend", (await retryWebhookEventNow(coldEvent.id)).ok && await state(cold) === "accepted");

    c.head("Unproven or changed history never becomes delivery proof");
    for (const variant of ["missing receipt", "changed payload", "changed external identity", "wrong receipt actor", "wrong receipt target"] as const) {
      const x = await held();
      await withSettlementFailure(() => post(x.payload));
      const evt = await eventRow(x);
      const receipt = `openphone-verified:${evt.id}`;
      if (variant === "missing receipt") await prisma.auditLog.delete({ where: { id: receipt } });
      else if (variant === "changed payload") await prisma.webhookEvent.update({ where: { id: evt.id }, data: { payload: `${evt.payload} ` } });
      else if (variant === "changed external identity") await prisma.webhookEvent.update({ where: { id: evt.id }, data: { externalId: "changed-opaque-identity" } });
      else await prisma.auditLog.update({ where: { id: receipt }, data: variant === "wrong receipt actor" ? { actor: "unsigned" } : { target: "wrong-target" } });
      await retryWebhookEventNow(evt.id);
      c.ok(`${variant} leaves held delivery unknown`, await state(x) === "unknown" && !await proof.hasVerifiedOpenPhoneDeliveryProof(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: evt.id } })));
    }
    const unsigned = await held();
    await saveSecret("openphone_webhook", "");
    await post(unsigned.payload);
    const unsignedEvent = await eventRow(unsigned);
    c.ok("unsigned legacy POST receives no authentication receipt", await state(unsigned) === "unknown" && !await proof.hasVerifiedOpenPhoneDeliveryProof(unsignedEvent));
    await saveSecret("openphone_webhook", TOKEN);
    await post(unsigned.payload);
    c.ok("unsigned processed history cannot consume later authenticated redelivery", await state(unsigned) === "accepted");

    const unsignedTwin = await held();
    await withSettlementFailure(() => post(unsignedTwin.payload));
    await prisma.webhookEvent.create({ data: { provider: "openphone", eventType: "message.delivered", externalId: unsignedTwin.payload.id, payload: JSON.stringify(unsignedTwin.payload), status: "PROCESSED", error: "UNSIGNED: isolated legacy copy" } });
    const automatic = await retryFailedWebhooks();
    c.ok("unsigned processed twin cannot suppress proven automatic retry", automatic.recovered === 1 && await state(unsignedTwin) === "accepted");

    const atomic = await held();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_proof_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'openphone_verified_delivery' THEN RAISE EXCEPTION 'isolated receipt write failed'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_proof_fixture BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_proof_fixture()');
    let receiptFailed = false;
    try { await post(atomic.payload); } catch { receiptFailed = true; }
    await prisma.$executeRawUnsafe('DROP TRIGGER reject_proof_fixture ON "AuditLog"');
    await prisma.$executeRawUnsafe('DROP FUNCTION reject_proof_fixture()');
    c.ok("failed receipt write rolls back raw event atomically", receiptFailed && await prisma.webhookEvent.count({ where: { externalId: atomic.payload.id } }) === 0 && await state(atomic) === "unknown");
    await post(atomic.payload);
    c.ok("provider redelivery after atomic write failure can recover", await state(atomic) === "accepted");
    c.ok("fixture makes no replacement intent, activation, task or provider call", await prisma.outboxMessage.count() === sequence && await prisma.programAutomation.count() === 0 && await prisma.smartTask.count() === 0 && fence.blocked.length === 0 && fence.faked.length === 0);
    console.log(await db.evidence()); c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
(process.env.DRILL_CHILD ? child() : main()).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
