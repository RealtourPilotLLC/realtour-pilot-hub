// ---------------------------------------------------------------------------
// DRILL: A02 + A04 — DELIVERY TRUTH (Sep 22 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     npx tsx scripts/_drill/a02-a04-delivery-truth.ts
//
// A02. clientChangeRequestsFor used to `.catch(() => [])`, and its own comment
// said "no answer means no complaint, which only ever makes the matcher
// stricter." That was backwards: callers turn an empty map into
// `contested: false`, and the automatic matcher REFUSES a contested item — so a
// failed read removed a guard. The audit reproduced it by injecting a query
// failure and watching a contested cut become eligible.
//
// A04. markVideoSent stamps the cut row FIRST, then does four more writes, each
// swallowed. A failure in any of them left that state unreachable forever,
// because every retry hit `if (sub.sentToClientAt) return alreadySent(...)`.
// markTopazDelivered had the same shape: stamp, suppress the task failure,
// return early on the next call.
//
// ISOLATION. PGlite in-process Postgres on its own DATABASE_URL, pinned before
// any app module loads. Production Neon is never opened. Every outbound HTTP
// call is fenced to loopback and counted.
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
const PORT = 5489;
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
  const rts = await import("@/lib/readyToSend");
  const { markTopazDelivered } = await import("@/lib/topazJobs");

  // ---------------------------------------------------------------------
  // A02. The evidence reader reports, it does not guess.
  // ---------------------------------------------------------------------
  console.log("\n=== A02: an unreadable revision history is not an empty one ===\n");

  const client = await prisma.client.create({ data: { name: "Gary Smith" }, select: { id: true } });
  const project = await prisma.project.create({
    data: { clientId: client.id, title: "12 Oak St", status: "DELIVERED", aryeoListingId: "list-1" },
    select: { id: true },
  });

  {
    const clean = await rts.clientChangeRequestsFor([project.id]);
    ok("a genuinely empty history reports known:true", clean.known === true && clean.all.length === 0);
  }

  await prisma.revisionBrief.create({
    data: { projectId: project.id, source: "portal", headline: "the drone shot is too dark", originalText: "the drone shot is too dark" },
  });
  {
    const real = await rts.clientChangeRequestsFor([project.id]);
    ok("a real complaint is read and dated", real.known === true && real.all.length === 1);
    ok("  …and contestedSince finds it after the file was ready", !!rts.contestedSince(real.all, new Date(Date.now() - 3600_000)));
  }

  // The failure the audit injected: the query throws.
  {
    const realFind = prisma.revisionBrief.findMany;
    (prisma.revisionBrief as unknown as { findMany: unknown }).findMany = async () => {
      throw new Error("connection terminated unexpectedly");
    };
    const broken = await rts.clientChangeRequestsFor([project.id]);
    (prisma.revisionBrief as unknown as { findMany: unknown }).findMany = realFind;

    ok("a FAILED read reports known:false, not an empty list", broken.known === false);
    ok("  …and does not throw (the caller decides, not an exception)", Array.isArray(broken.all));
    ok("  …and carries the reason for the card's line", !!broken.error);
    // THE BUG, STATED AS AN ASSERTION. Before the fix this returned [] and a
    // caller asking "any complaints?" got the same answer as a clean read.
    ok("BEFORE: an empty list and a failed read were indistinguishable — now they are not", broken.known !== true && broken.all.length === 0);
  }

  // ---------------------------------------------------------------------
  // A04. An "already sent" call repairs what the first one left undone.
  // ---------------------------------------------------------------------
  console.log("\n=== A04: marking sent converges instead of reporting success ===\n");

  const deliverable = await prisma.deliverable.create({
    data: { projectId: project.id, type: "VIDEO", label: "Cinematic Video", quantity: 1 },
    select: { id: true },
  });
  await prisma.deliverableOutput.create({ data: { deliverableId: deliverable.id, projectId: project.id, slot: 1, category: "VIDEO" } });

  const sub = await prisma.reviewSubmission.create({
    data: {
      projectId: project.id, deliverableId: deliverable.id, slot: 1, round: 1, status: "APPROVED",
      fileName: "12-oak-st-v1.mp4", assetPath: "/cuts/12-oak.mp4", sizeBytes: 100, decidedAt: new Date(), decidedBy: "jordan",
    },
    select: { id: true },
  });

  // Kyle's upload task, and the 1080p job that owns it.
  const task = await prisma.smartTask.create({
    data: { taskType: "todo", title: "Upload the 1080p file", status: "OPEN", projectId: project.id, dedupeKey: `topaz-upload-${sub.id}` },
    select: { id: true },
  });
  const job = await prisma.topazJob.create({
    data: {
      submissionId: sub.id, projectId: project.id, state: "done", taskId: task.id,
      finalPath: "/Topaz/12-oak-1080p.mp4", savedAt: new Date(), finishedAt: new Date(),
    },
    select: { id: true },
  });

  // THE INJECTED FAILURE, exactly as the audit ran it: the Topaz
  // acknowledgement throws AFTER the cut row has been stamped.
  const realTaskUpdate = prisma.smartTask.updateMany;
  let throwOnce = true;
  (prisma.smartTask as unknown as { updateMany: unknown }).updateMany = async (...args: unknown[]) => {
    if (throwOnce) { throwOnce = false; throw new Error("deadlock detected"); }
    return (realTaskUpdate as unknown as (...a: unknown[]) => unknown).apply(prisma.smartTask, args);
  };

  const first = await rts.markVideoSent(sub.id, "kyle@realtourpilot.com");
  (prisma.smartTask as unknown as { updateMany: unknown }).updateMany = realTaskUpdate;

  ok("the send is still reported as done — it really happened", first.ok === true);
  ok("BUT the failure is NAMED, not swallowed", (first.incomplete?.length ?? 0) > 0, first.message);

  const stamped = await prisma.reviewSubmission.findUnique({ where: { id: sub.id }, select: { sentToClientAt: true } });
  ok("the cut row carries its immutable stamp", !!stamped?.sentToClientAt);

  const openTask = await prisma.smartTask.findUnique({ where: { id: task.id }, select: { status: true } });
  ok("Kyle's upload task is still OPEN — the mismatch A04 describes", openTask?.status === "OPEN");

  // THE FIX. Pressing again used to return "Already marked sent" and stop.
  const second = await rts.markVideoSent(sub.id, "kyle@realtourpilot.com");
  ok("a second press reports it repaired something", (second.repaired?.length ?? 0) > 0, second.message);

  const closedTask = await prisma.smartTask.findUnique({ where: { id: task.id }, select: { status: true } });
  ok("Kyle's upload task is now CLOSED", closedTask?.status === "COMPLETED");

  const firstStamp = stamped!.sentToClientAt!.getTime();
  const afterRepair = await prisma.reviewSubmission.findUnique({ where: { id: sub.id }, select: { sentToClientAt: true } });
  ok("the historical first-delivery timestamp was NOT rewritten", afterRepair?.sentToClientAt?.getTime() === firstStamp);

  const activities = await prisma.activity.count({ where: { projectId: project.id, body: { startsWith: "Video sent to the client" } } });
  ok("exactly ONE 'video sent' line on the timeline, not two", activities === 1, `found ${activities}`);

  const out = await prisma.deliverableOutput.findFirst({ where: { deliverableId: deliverable.id }, select: { deliveredAt: true, sentSubmissionId: true } });
  ok("the per-video delivery row landed on the first call", !!out?.deliveredAt && out.sentSubmissionId === sub.id);

  // markTopazDelivered on its own: an already-delivered job repairs its task.
  {
    const t2 = await prisma.smartTask.create({
      data: { taskType: "todo", title: "Upload another 1080p file", status: "OPEN", projectId: project.id, dedupeKey: "topaz-upload-2" },
      select: { id: true },
    });
    const j2 = await prisma.topazJob.create({
      data: { submissionId: sub.id, projectId: project.id, state: "done", taskId: t2.id, finalPath: "/Topaz/b.mp4", deliveredAt: new Date(), deliveredBy: "kyle" },
      select: { id: true },
    });
    const r = await markTopazDelivered(j2.id, "kyle");
    ok("markTopazDelivered on an already-delivered job repairs its open task", r.repaired === true, r.message);
    const t2after = await prisma.smartTask.findUnique({ where: { id: t2.id }, select: { status: true } });
    ok("  …and the task really closed", t2after?.status === "COMPLETED");
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
