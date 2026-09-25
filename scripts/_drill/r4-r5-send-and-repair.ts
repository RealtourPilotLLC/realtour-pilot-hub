// ---------------------------------------------------------------------------
// DRILL: R4 + R5 (follow-up audit, Sep 22 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/r4-r5-send-and-repair.ts
//
// R4. Manual texts called OpenPhone directly with nothing persisted first, so:
// only a 408 was ambiguous (a 5xx or a dropped connection read as an ordinary
// failure, which invites the press that sends it twice); there was no durable
// record of the attempt; and — the one I got wrong in writing — they bypassed
// the TEST-client floor, which is installed on outbox.enqueue, while a commit
// of mine called it "a floor under every send path".
//
// R5. markVideoSent could repair a half-finished settle on a repeat press, and
// nothing could reach that press: the action revalidated the viewed path on
// ok:true, so the row (now stamped sent) left the board under the operator's
// finger. The repair had to be durable too.
//
// ISOLATION: PGlite on its own DATABASE_URL pinned before any app module loads;
// outbound HTTP fenced to loopback and counted; the provider replaced.
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = Number(process.env.DRILL_PORT ?? 5495); // DRILL_PORT: run on an assigned port
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;
delete process.env.SLACK_ALERT_CHANNEL;

const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url)) return realFetch(input as string, init as RequestInit);
  outbound.push(url);
  throw new Error(`OUTBOUND BLOCKED BY DRILL: ${url}`);
}) as typeof fetch;

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const outbox = await import("@/lib/outbox");
  const op = await import("@/lib/integrations/openphone");

  // The provider, answered locally. `behaviour` is what the next send does.
  let behaviour: "ok" | "timeout" | "server-error" | "rejected" = "ok";
  const sends: { to: unknown; body: string; media?: string[] }[] = [];
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN", number: "+16105550100" }];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_f: string, to: unknown, body: string, media?: string[]) => {
    sends.push({ to, body, media });
    if (behaviour === "timeout") throw new op.OpenPhoneError("OpenPhone did not answer within 30s", 408);
    if (behaviour === "server-error") throw new op.OpenPhoneError("Bad gateway", 502);
    if (behaviour === "rejected") throw new op.OpenPhoneError("invalid destination", 400);
    return { data: { id: `op-${sends.length}` } };
  };

  const client = await prisma.client.create({ data: { name: "Renee Fairbank", phone: "+16105550143" }, select: { id: true } });

  // =====================================================================
  console.log("\n=== R4: a manual send is durable, and ambiguity is ambiguity ===\n");
  // =====================================================================
  const send = (intent: string, body: string, extra: string[] = [], media: string[] = []) =>
    outbox.sendThroughOutbox({
      channel: "sms", toRef: "6105550143", extraToRefs: extra, mediaUrls: media.length ? media : null,
      body, dedupeKey: outbox.manualKey(intent), clientId: client.id, requestedBy: "kyle@realtourpilot.com",
    });

  // 1. The happy path, and the row that proves it happened.
  {
    behaviour = "ok";
    const r = await send("intent-happy-0001", "Heading over at 2 — see you there.");
    ok("an ordinary send is accepted", r.outcome === "accepted", JSON.stringify(r));
    const row = await prisma.outboxMessage.findUnique({ where: { dedupeKey: "manual:intent-happy-0001" }, select: { state: true, providerId: true } });
    ok("  …and leaves a durable row carrying the provider's id", row?.state === "accepted" && !!row.providerId);
  }

  // 2. A GROUP and an ATTACHMENT — the two reasons this never used the outbox.
  {
    behaviour = "ok";
    const r = await send("intent-group-0002", "Both of you — 2pm.", ["6105550144"], ["https://dropbox.example/x.jpg"]);
    ok("a group text goes through the outbox", r.outcome === "accepted");
    const last = sends[sends.length - 1];
    ok("  …with BOTH recipients", Array.isArray(last.to) && (last.to as string[]).length === 2, JSON.stringify(last.to));
    ok("  …and the attachment preserved", (last.media ?? []).length === 1);
    const row = await prisma.outboxMessage.findUnique({ where: { dedupeKey: "manual:intent-group-0002" }, select: { extraToRefsJson: true, mediaUrlsJson: true } });
    ok("  …both recorded on the row, so a recovery can rebuild it", !!row?.extraToRefsJson && !!row?.mediaUrlsJson);
  }

  // 3. THE IDENTITY ITSELF, which is what makes a double submit one text.
  //
  // The DUPLICATE path cannot be exercised here and it is worth being plain
  // about why rather than quietly dropping it: the unique violation on
  // dedupeKey is caught by enqueue, which then RE-READS the row — and PGlite's
  // socket server closes the connection on a 23505, so the re-read fails with
  // "Server has closed the connection" and takes the rest of the drill with it.
  // The dedupe is a Postgres UNIQUE constraint either way; what is assertable
  // here is that one press yields one key and two presses yield two.
  {
    ok("one press is one identity", outbox.manualKey("intent-double-0003") === outbox.manualKey("intent-double-0003"));
    ok("  …and a second, deliberate press is a different one", outbox.manualKey("intent-double-0003") !== outbox.manualKey("intent-again-0004"));
    const unique = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'OutboxMessage' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%dedupeKey%'`,
    ).catch(() => []);
    ok("  …and the database, not the code, enforces one row per identity", unique.length > 0, JSON.stringify(unique));
  }

  // 4. A deliberate second message with the same words still goes.
  {
    behaviour = "ok";
    const before = sends.length;
    const r = await send("intent-again-0004", "Same press, twice.");
    ok("a NEW press with identical words still sends", r.outcome === "accepted" && sends.length - before === 1);
  }

  // 5. THE CLASSIFICATION. This is the half the manual path got wrong.
  {
    behaviour = "timeout";
    const t = await send("intent-timeout-0005", "did this go?");
    ok("a timeout is UNKNOWN, never a failure", t.outcome === "unknown", JSON.stringify(t));

    behaviour = "server-error";
    const e = await send("intent-500-0006", "did this go?");
    ok("BEFORE: a 5xx read as an ordinary failure. Now it is UNKNOWN too", e.outcome === "unknown", JSON.stringify(e));

    behaviour = "rejected";
    const r = await send("intent-400-0007", "bad number");
    ok("a 4xx that is not 408 IS a clean rejection", r.outcome === "failed", JSON.stringify(r));
  }

  // 6. The thread can show an unconfirmed send — it survives a refresh.
  {
    const pendingRows = await outbox.pendingManualSends(["+16105550143"]);
    ok("an unconfirmed send is readable back for the thread", pendingRows.length >= 2, `${pendingRows.length}`);
    ok("  …carrying the words, so the only copy is not the composer", pendingRows.every((p) => !!p.body));
  }

  // 7. LATER EVIDENCE settles it, without sending anything again.
  {
    const before = sends.length;
    const settled = await outbox.settleUnknownFromEcho({ toRef: "6105550143", body: "did this go?", providerId: "op-echo" });
    ok("OpenPhone's own echo settles an unconfirmed send", settled === true);
    ok("  …without touching the provider", sends.length === before);
    const rows = await prisma.outboxMessage.findMany({ where: { body: "did this go?" }, select: { state: true } });
    ok("  …one of the two is now accepted", rows.filter((r) => r.state === "accepted").length === 1, JSON.stringify(rows.map((r) => r.state)));
  }

  // 8. THE TEST-CLIENT FLOOR now covers this path. It did not before.
  {
    const test = await prisma.client.create({ data: { name: "Bobby TEST", phone: "+16105550199" }, select: { id: true } });
    let refused = false;
    try {
      await outbox.sendThroughOutbox({
        channel: "sms", toRef: "6105550199", body: "a test client's real phone",
        dedupeKey: outbox.manualKey("intent-floor-0008"), clientId: test.id, requestedBy: "kyle@realtourpilot.com",
      });
    } catch (e) {
      refused = (e as Error).name === "TestClientSendRefusedError";
    }
    ok("BEFORE: manual sends bypassed the TEST-client floor. Now they do not", refused);
  }

  // =====================================================================
  console.log("\n=== R5: a half-finished settle is visible and repairable ===\n");
  // =====================================================================
  const project = await prisma.project.create({ data: { clientId: client.id, title: "9 Larch Way", status: "DELIVERED" }, select: { id: true } });
  const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO", label: "Cinematic Video", quantity: 1 }, select: { id: true } });
  await prisma.deliverableOutput.create({ data: { deliverableId: deliverable.id, projectId: project.id, slot: 1, category: "VIDEO" } });
  const sub = await prisma.reviewSubmission.create({
    data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, round: 1, status: "APPROVED", fileName: "larch-v1.mp4", assetPath: "/cuts/larch.mp4", sizeBytes: 100, decidedAt: new Date(), decidedBy: "jordan" },
    select: { id: true },
  });
  const task = await prisma.smartTask.create({ data: { taskType: "todo", title: "Upload the 1080p file", status: "OPEN", projectId: project.id, dedupeKey: `topaz-upload-${sub.id}` }, select: { id: true } });
  const job = await prisma.topazJob.create({
    data: { submissionId: sub.id, projectId: project.id, state: "done", taskId: task.id, finalPath: "/Topaz/larch.mp4", savedAt: new Date(), finishedAt: new Date() },
    select: { id: true },
  });

  const rts = await import("@/lib/readyToSend");
  // Fail the task close after the cut is stamped — A04's exact injection.
  const realTaskUpdate = prisma.smartTask.updateMany.bind(prisma.smartTask) as (...a: unknown[]) => Promise<{ count: number }>;
  let throwOnce = true;
  (prisma.smartTask as unknown as { updateMany: unknown }).updateMany = async (...args: unknown[]) => {
    if (throwOnce) { throwOnce = false; throw new Error("deadlock detected"); }
    return realTaskUpdate(...args);
  };
  const first = await rts.markVideoSent(sub.id, "kyle@realtourpilot.com");
  (prisma.smartTask as unknown as { updateMany: unknown }).updateMany = realTaskUpdate;

  ok("the send stands", first.ok === true);
  ok("  …and `incomplete` is set, which the UI now reads", (first.incomplete?.length ?? 0) > 0, first.message);
  ok("  …the 1080p job IS stamped delivered (that write landed)", !!(await prisma.topazJob.findUnique({ where: { id: job.id }, select: { deliveredAt: true } }))?.deliveredAt);
  ok("  …and its upload card is the thing left open", (await prisma.smartTask.findUnique({ where: { id: task.id }, select: { status: true } }))?.status === "OPEN");

  // The row really does leave the board — which is why the action must not
  // revalidate, and why a durable repair is needed as well as a button.
  {
    const board = await rts.readyToSend({ projectId: project.id });
    ok("the cut is off the ready-to-send board once stamped", !board.ready.some((r) => r.submissionId === sub.id));
  }

  // THE DURABLE HALF.
  {
    const r = await rts.repairIncompleteDeliveries({ sinceDays: 30, max: 50 });
    ok("the sweep finds the delivered job with an open card", r.repaired === 1, JSON.stringify({ checked: r.checked, repaired: r.repaired, failed: r.failed }));
    ok("  …and closes it", (await prisma.smartTask.findUnique({ where: { id: task.id }, select: { status: true } }))?.status === "COMPLETED");
    const again = await rts.repairIncompleteDeliveries({ sinceDays: 30, max: 50 });
    ok("  …and repairs nothing the second time", again.repaired === 0);
  }

  // THE NARROWNESS, which is the whole design: an UNdelivered job with an open
  // card is Kyle's ordinary chase card and must never be closed by this.
  {
    const sub2 = await prisma.reviewSubmission.create({
      data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, round: 2, status: "APPROVED", fileName: "larch-v2.mp4", assetPath: "/cuts/larch2.mp4", sizeBytes: 100, decidedAt: new Date(), decidedBy: "jordan" },
      select: { id: true },
    });
    const chase = await prisma.smartTask.create({ data: { taskType: "internal_instruction", title: "Upload the 1080p video to Aryeo — 9 Larch Way", status: "OPEN", projectId: project.id, dedupeKey: "topaz-deliver-chase" }, select: { id: true } });
    await prisma.topazJob.create({ data: { submissionId: sub2.id, projectId: project.id, state: "done", taskId: chase.id, finalPath: "/Topaz/larch2.mp4" }, select: { id: true } });
    const r = await rts.repairIncompleteDeliveries({ sinceDays: 30, max: 50 });
    ok("a job Kyle still has to upload is NOT swept closed", r.repaired === 0, JSON.stringify(r));
    ok("  …its chase card is untouched", (await prisma.smartTask.findUnique({ where: { id: chase.id }, select: { status: true } }))?.status === "OPEN");
  }

  ok("nothing reached the network", outbound.length === 0, outbound.join(", "));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await server.stop();
  await db.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
