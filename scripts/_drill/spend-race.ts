// TWO WORKERS, ONE SLOT — in an isolated PostgreSQL, against the shipped
// reserveSpendSlot. Nothing here touches production.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
const exec = promisify(execFile);

const PORT = 5455;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  // Import AFTER the URL is pinned, so the client connects to the drill db.
  const { reserveSpendSlot, releaseSpendSlot } = await import("@/lib/topazJobs");
  const { prisma } = await import("@/lib/prisma");

  const S = { maxRendersPerMonth: 100, maxRendersPerDay: 100, maxCreditsPerMonth: 400, maxConcurrent: 1 } as never;
  const client = await prisma.client.create({ data: { name: "DRILL client" }, select: { id: true } });
  const project = await prisma.project.create({ data: { title: "DRILL job", status: "REVIEW", clientId: client.id }, select: { id: true } });
  const mk = async (id: string, lease: string) => {
    const sub = await prisma.reviewSubmission.create({
      data: { projectId: project.id, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: `${id}.mp4` },
      select: { id: true },
    });
    await prisma.topazJob.create({
      data: { id, projectId: project.id, submissionId: sub.id, state: "estimated", estimateCredits: 10, leaseBy: lease },
    });
    return { id, leaseBy: lease, estimateCredits: 10 };
  };

  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); };

  console.log("\n1. TWO WORKERS CONTEST THE LAST SLOT (maxConcurrent 1)");
  const a = await mk("job-a", "worker-1");
  const b = await mk("job-b", "worker-2");
  const [ra, rb] = await Promise.all([reserveSpendSlot(a, S), reserveSpendSlot(b, S)]);
  check("exactly one worker wins", (ra ? 1 : 0) + (rb ? 1 : 0) === 1, `a=${ra} b=${rb}`);
  const accepted = await prisma.topazJob.count({ where: { acceptedAt: { not: null } } });
  check("exactly one commitment exists in the ledger", accepted === 1, `accepted=${accepted}`);

  console.log("\n2. THE CREDIT CAP IS NOT CROSSED");
  await db.query(`UPDATE "TopazJob" SET "acceptedAt"=NULL`);
  const S2 = { ...(S as object), maxConcurrent: 99, maxCreditsPerMonth: 15 } as never;
  const [c1, c2] = await Promise.all([reserveSpendSlot(a, S2), reserveSpendSlot(b, S2)]);
  const credits = await prisma.topazJob.aggregate({ where: { acceptedAt: { not: null } }, _sum: { estimateCredits: true } });
  check("one 10-credit job fits under a 15-credit cap, the second does not", (c1 ? 1 : 0) + (c2 ? 1 : 0) === 1, `sum=${credits._sum.estimateCredits}`);
  check("committed credits never exceed the cap", (credits._sum.estimateCredits ?? 0) <= 15);

  console.log("\n3. A LOST LEASE CANNOT RESERVE");
  await db.query(`UPDATE "TopazJob" SET "acceptedAt"=NULL, "leaseBy"='somebody-else' WHERE id='job-a'`);
  const stale = await reserveSpendSlot(a, S2);
  check("a worker whose lease was taken reserves nothing", stale === false);

  console.log("\n4. A RESERVATION CAN BE HANDED BACK (nothing spent)");
  // Clear the whole ledger first — step 2 left job-b holding credits, and the
  // point here is the hand-back, not the cap.
  await db.query(`UPDATE "TopazJob" SET "acceptedAt"=NULL`);
  await db.query(`UPDATE "TopazJob" SET "leaseBy"='worker-1' WHERE id='job-a'`);
  await reserveSpendSlot(a, S2);
  const before = await prisma.topazJob.findUnique({ where: { id: "job-a" }, select: { acceptedAt: true } });
  await releaseSpendSlot(a);
  const after = await prisma.topazJob.findUnique({ where: { id: "job-a" }, select: { acceptedAt: true } });
  check("the slot is reserved, then given back", !!before?.acceptedAt && after?.acceptedAt === null);

  console.log("\n5. RESERVING TWICE ON ONE JOB IS REFUSED (no double commitment)");
  await reserveSpendSlot(a, S2);
  const twice = await reserveSpendSlot(a, S2);
  check("a job that already holds a slot cannot take a second", twice === false);

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} FAILED`} (${pass} passed)`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
