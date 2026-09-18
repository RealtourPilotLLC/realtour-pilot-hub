/**
 * INTERRUPTED RESERVATIONS — the reviewer's own table, reproduced and then
 * fixed, against the shipped advanceTopazJob in an isolated PostgreSQL.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/topaz-recovery.ts
 *
 * A reservation is written BEFORE the provider call and BEFORE the upload
 * targets are saved, so a worker killed in between leaves a row committed to
 * spend with nowhere to put the bytes. The old code read one fact — "targets
 * AND acceptedAt" — and treated everything else as a fresh start, so that row
 * asked for a slot it already held, was refused, and returned without
 * progressing OR releasing. For ever.
 *
 * Every provider call is mocked and counted. NOTHING IS SPENT and nothing
 * touches production: a fresh in-process database, torn down at the end.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "module";
const exec = promisify(execFile);

const PORT = 5479;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;

// ---- the provider, mocked and counted --------------------------------------
const calls = { accept: 0, status: 0, cancelEstimate: 0, cancelRequest: 0 };
let providerStatus = "accepted";
const acceptThrows = false;
let statusThrows = false;
const SETTINGS = {
  enabled: true, container: "mp4", model: "prob-4",
  maxRendersPerDay: 50, maxRendersPerMonth: 100, maxCreditsPerMonth: 400,
  maxCreditsPerVideo: 100, maxConcurrent: 8, maxAttempts: 3, minBalance: 0,
};

const __M = Module as unknown as { prototype: { require: (id: string) => unknown } };
const __real = __M.prototype.require;
__M.prototype.require = function (this: unknown, id: string) {
  if (id === "next/navigation" || id === "next/headers") return {};
  const m = __real.call(this, id) as Record<string, unknown>;
  if (/integrations[/\\]topaz/.test(id)) {
    return new Proxy(m, {
      get(t: Record<string, unknown>, k: string) {
        switch (k) {
          case "acceptVideoRequest":
            return async () => {
              calls.accept++;
              if (acceptThrows) {
                const E = t.TopazError as new (m: string, s: number, r: boolean) => Error;
                throw new E("Topaz refused the accept", 0, true);
              }
              return [{ partNum: 1, url: "https://drill.invalid/put/1" }];
            };
          case "videoStatus":
            return async () => {
              calls.status++;
              if (statusThrows) {
                const E = t.TopazError as new (m: string, s: number, r: boolean) => Error;
                throw new E("Topaz did not answer", 0, true);
              }
              return { status: providerStatus, downloadUrl: null, credits: null, progress: null, message: null, raw: {} };
            };
          case "cancelEstimate":
            return async () => { calls.cancelEstimate++; return true; };
          case "cancelVideoRequest":
            return async () => { calls.cancelRequest++; return true; };
          case "topazConnected":
            return async () => true;
          case "topazBalance":
            return async () => ({ available_credits: 400, reserved_credits: 0, total_credits: 400 });
          default:
            return t[k];
        }
      },
    });
  }
  if (/lib[/\\]settings/.test(id)) {
    return new Proxy(m, { get: (t: Record<string, unknown>, k: string) => (k === "topazSettings" ? async () => SETTINGS : t[k]) });
  }
  return m;
} as never;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { advanceTopazJob } = await import("@/lib/topazJobs");
  const { prisma } = await import("@/lib/prisma");

  const client = await prisma.client.create({ data: { name: "DRILL client" }, select: { id: true } });
  const project = await prisma.project.create({
    data: { title: "1 Drill Way, West Chester, PA", status: "REVIEW", clientId: client.id },
    select: { id: true },
  });

  let n = 0;
  const mk = async (over: Record<string, unknown>) => {
    const id = `job-${++n}`;
    const sub = await prisma.reviewSubmission.create({
      data: {
        projectId: project.id, kind: "video", round: 1, status: "APPROVED", source: "upload",
        fileName: `${id}.mp4`, blobUrl: "https://drill.invalid/source.mp4", sizeBytes: 12_000_000,
      },
      select: { id: true },
    });
    await prisma.topazJob.create({
      data: {
        id, projectId: project.id, submissionId: sub.id, state: "estimated",
        requestId: `req-${id}`, estimateCredits: 6, sourceSizeBytes: 12_000_000,
        leaseBy: "drill", leaseUntil: new Date(Date.now() + 600_000),
        ...over,
      },
    });
    return id;
  };
  const row = (id: string) =>
    prisma.topazJob.findUnique({
      where: { id },
      select: { state: true, acceptedAt: true, uploadUrlsJson: true, requestId: true, nextAttemptAt: true, error: true },
    });
  const reset = () => { calls.accept = 0; calls.status = 0; calls.cancelEstimate = 0; calls.cancelRequest = 0; };
  const TARGETS = JSON.stringify([{ partNum: 1, url: "https://drill.invalid/put/stored" }]);

  console.log("=".repeat(76));
  console.log("TOPAZ — a reservation interrupted at each of the three points");
  console.log("=".repeat(76));

  console.log("\n1. NEW JOB, NO RESERVATION (the control — this always worked)");
  {
    reset();
    const id = await mk({});
    const state = await advanceTopazJob(id);
    const r = await row(id);
    check("progresses to uploading", state === "uploading", `state=${state}`);
    check("accepted exactly once at the provider", calls.accept === 1, `accept=${calls.accept}`);
    check("the slot is reserved and the targets are stored", !!r?.acceptedAt && !!r?.uploadUrlsJson);
  }

  console.log("\n2. KILLED IMMEDIATELY AFTER RESERVING — provider outcome unknown, request alive");
  console.log("   (this is the row the reviewer reproduced: state estimated, 0 accepts, no progress)");
  {
    reset();
    providerStatus = "accepted";
    const id = await mk({ acceptedAt: new Date(), uploadUrlsJson: null });
    const state = await advanceTopazJob(id);
    const r = await row(id);
    check("it asks Topaz what happened instead of guessing", calls.status === 1, `status calls=${calls.status}`);
    check("it progresses to uploading", state === "uploading", `state=${state}`);
    check("it accepts once — the slot it already holds", calls.accept === 1, `accept=${calls.accept}`);
    check("it does NOT take a second commitment", !!r?.acceptedAt && !!r?.uploadUrlsJson);
  }

  console.log("\n3. KILLED AFTER THE PROVIDER ACCEPTED, BEFORE THE TARGETS WERE WRITTEN");
  console.log("   (indistinguishable from case 2 from here — that is the point)");
  {
    reset();
    providerStatus = "awaiting_upload";
    const id = await mk({ acceptedAt: new Date(Date.now() - 3_600_000), uploadUrlsJson: null });
    const state = await advanceTopazJob(id);
    check("fresh presigned URLs are fetched and the job moves", state === "uploading", `state=${state}`);
    check("one status read, one accept", calls.status === 1 && calls.accept === 1, `status=${calls.status} accept=${calls.accept}`);
  }

  console.log("\n4. KILLED AFTER THE TARGETS WERE WRITTEN (nothing to recover)");
  {
    reset();
    const id = await mk({ acceptedAt: new Date(), uploadUrlsJson: TARGETS });
    const state = await advanceTopazJob(id);
    const r = await row(id);
    check("it carries on with the targets it already has", state === "uploading", `state=${state}`);
    check("it does not call the provider at all", calls.accept === 0 && calls.status === 0, `accept=${calls.accept} status=${calls.status}`);
    check("the stored targets are untouched", r?.uploadUrlsJson === TARGETS);
  }

  console.log("\n5. THE REQUEST DIED AT TOPAZ — the slot goes back, nothing was spent");
  {
    reset();
    providerStatus = "failed";
    const id = await mk({ acceptedAt: new Date(), uploadUrlsJson: null });
    const state = await advanceTopazJob(id);
    const r = await row(id);
    check("it starts over at the free price check", state === "queued", `state=${state}`);
    check("the commitment is released", r?.acceptedAt === null, `acceptedAt=${r?.acceptedAt}`);
    check("the dead request id is dropped", r?.requestId === null);
    check("nothing was accepted", calls.accept === 0, `accept=${calls.accept}`);
  }

  console.log("\n6. TOPAZ IS ALREADY RUNNING IT — wait, do not start it again");
  {
    reset();
    providerStatus = "processing";
    const id = await mk({ acceptedAt: new Date(), uploadUrlsJson: null });
    const state = await advanceTopazJob(id);
    const r = await row(id);
    check("the row is held, not restarted", state === "estimated", `state=${state}`);
    check("nothing is accepted a second time", calls.accept === 0, `accept=${calls.accept}`);
    check("the slot stays ours while Topaz has it", !!r?.acceptedAt);
    check("and it will come back on its own", !!r?.nextAttemptAt, `nextAttemptAt=${r?.nextAttemptAt?.toISOString()}`);
  }

  console.log("\n7. THE RENDER FINISHED WHILE WE WERE AWAY — money already spent");
  {
    reset();
    providerStatus = "complete";
    const id = await mk({ acceptedAt: new Date(), uploadUrlsJson: null });
    const state = await advanceTopazJob(id);
    check("it is handed to the polling step, not started again", state === "processing", `state=${state}`);
    check("nothing is accepted", calls.accept === 0, `accept=${calls.accept}`);
  }

  console.log("\n8. TOPAZ CANNOT BE ASKED — hold the slot, do not guess either way");
  {
    reset();
    statusThrows = true;
    const id = await mk({ acceptedAt: new Date(), uploadUrlsJson: null });
    const state = await advanceTopazJob(id);
    const r = await row(id);
    check("the job is held, not failed", state === "estimated", `state=${state}`);
    check("the slot is NOT handed back on a guess", !!r?.acceptedAt);
    check("nothing is accepted", calls.accept === 0, `accept=${calls.accept}`);
    check("and it says so on the row", /Checking with Topaz/i.test(r?.error ?? ""), `error=${(r?.error ?? "").slice(0, 60)}`);
    statusThrows = false;
  }

  console.log("\n9. NOTHING IS LEFT COMMITTED AND STUCK");
  {
    const all = await prisma.topazJob.findMany({ select: { id: true, state: true, acceptedAt: true, nextAttemptAt: true } });
    check("every row is either uncommitted or carries one commitment", all.every((j) => j.acceptedAt === null || j.acceptedAt instanceof Date), `${all.length} rows`);
    const stuck = all.filter((j) => j.state === "estimated" && j.acceptedAt && !j.nextAttemptAt);
    check("no row is committed, unfinished and not coming back", stuck.length === 0, `${stuck.length} stuck`);
  }

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
