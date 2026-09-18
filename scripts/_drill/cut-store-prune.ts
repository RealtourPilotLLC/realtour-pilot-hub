// THE PRUNE DRILL — prove the 08:40 window is shut, in a real database.
//
// R05 / RTP-01, Sep 18. docs/REVIEW-CUT-STORE-HANDOVER.md §3 measured what the
// old store-cutover order destroyed: pruneReviewUploads' release() cleared a
// row's blobUrl — the ONLY record of which object held that cut — and then
// called del(), which deletes from the store the TOKEN names rather than the
// store the URL names. During any window where the token had moved and the rows
// had not, that is: pointer gone, bytes orphaned in the old store, counted as
// `pruned`, silent. The old answer was a runbook step (pull the cron from
// vercel.json first, put it back after). The new answer is in the code: a
// pointer is only cleared once the object has been matched to a token we hold.
//
// This runs a REAL PostgreSQL — PGlite, compiled to WASM, served over the
// ordinary wire protocol on a loopback socket — with the current schema pushed
// onto it. It never touches production: DATABASE_URL is pinned to 127.0.0.1
// before the first app import and asserted, and BLOB_READ_WRITE_TOKEN is
// replaced with a token for a store that does not exist, so no real object can
// be read or deleted whatever happens.
//
// Usage, from the repo root:
//   npx tsx scripts/_drill/cut-store-prune.ts [--port 5441]
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 5441;

// The store we pretend to own, and one we do not. Neither exists, so every
// del() that gets as far as the network fails — which is itself the point:
// the drill is about WHICH rows we are willing to clear, not about deleting.
const OURS = "drillstore000001";
const FAKE_TOKEN = `vercel_blob_rw_${OURS}_drillsecret`;
const url = (store: string, access: string, path: string) =>
  `https://${store}.${access}.blob.vercel-storage.com/${path}`;

const step = (t: string) => console.log(`\n── ${t}`);
const tick = (b: boolean) => (b ? "PASS" : "FAIL");
let failures = 0;
function expect(what: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`   [${tick(ok)}] ${what}  got ${JSON.stringify(got)}${ok ? "" : ` · wanted ${JSON.stringify(want)}`}`);
}

async function main() {
  const dbUrl = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
  if (!dbUrl.includes("127.0.0.1")) throw new Error("refusing to run: the drill's DATABASE_URL is not loopback");
  // PINNED BEFORE THE FIRST APP IMPORT. Prisma self-loads .env, but a real
  // environment variable beats it — and every import below is dynamic so that
  // this line has already run when the client is constructed.
  process.env.DATABASE_URL = dbUrl;
  process.env.DIRECT_URL = dbUrl;
  process.env.BLOB_READ_WRITE_TOKEN = FAKE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN_LEGACY;

  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  try {
    await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
      maxBuffer: 64 * 1024 * 1024,
    });

    const { prisma } = await import("../../src/lib/prisma");
    const { pruneReviewUploads } = await import("../../src/lib/reviewCuts");
    if (!(await prisma.$queryRaw<{ n: number }[]>`SELECT 1::int AS n`)[0]) throw new Error("no database");

    const project = await prisma.project.create({
      data: { title: "1 Drill Lane, Nowhere", client: { create: { name: "Drill Client" } } },
      select: { id: true },
    });

    // Three failed uploads whose bytes landed, all a fortnight old — step 2 of
    // the prune ("UPLOAD_FAILED, bytes landed, >7d"), the pass keepUploadsDays
    // does NOT gate.
    const fixtures = [
      ["ours", url(OURS, "public", "review-cuts/p/a/a.mp4")],
      ["foreign store", url("someoneelse99999", "public", "review-cuts/p/b/b.mp4")],
      ["ours, not a cut path", url(OURS, "public", "other/c.mp4")],
    ] as const;

    const seed = async () => {
      await prisma.reviewSubmission.deleteMany({ where: { projectId: project.id } });
      const ids: Record<string, string> = {};
      for (const [name, u] of fixtures) {
        const r = await prisma.reviewSubmission.create({
          data: { projectId: project.id, kind: "video", status: "UPLOAD_FAILED", blobUrl: u, blobPathname: new URL(u).pathname.slice(1), fileName: `${name}.mp4` },
          select: { id: true },
        });
        ids[name] = r.id;
      }
      // updatedAt is @updatedAt, so Prisma owns it — age the rows in SQL.
      await prisma.$executeRawUnsafe(
        `UPDATE "ReviewSubmission" SET "updatedAt" = now() - interval '14 days' WHERE "projectId" = $1`,
        project.id,
      );
      return ids;
    };

    // =====================================================================
    step("THE OLD release() — a faithful copy of the pre-Sep-18 lines");
    // =====================================================================
    // Clear the pointer, then call del() with whatever token is primary. The
    // delete is NOT performed here (it would only hit the network and fail);
    // what is reproduced is the destructive half — the pointer.
    let ids = await seed();
    for (const [, u] of fixtures) {
      const row = await prisma.reviewSubmission.findFirst({ where: { projectId: project.id, blobUrl: u }, select: { id: true } });
      if (row) await prisma.reviewSubmission.update({ where: { id: row.id }, data: { blobUrl: null, blobPathname: null } });
    }
    for (const [name] of fixtures) {
      const after = await prisma.reviewSubmission.findUnique({ where: { id: ids[name] }, select: { blobUrl: true } });
      console.log(`   ${name.padEnd(22)} blobUrl after: ${after?.blobUrl ?? "null  <-- the only record of where those bytes are, gone"}`);
    }

    // =====================================================================
    step("THE SHIPPED release() — pruneReviewUploads(90) against the same rows");
    // =====================================================================
    ids = await seed();
    const t0 = Date.now();
    const result = await pruneReviewUploads(90);
    console.log(`   pruneReviewUploads returned ${JSON.stringify(result)} in ${Date.now() - t0}ms`);
    const after = Object.fromEntries(
      await Promise.all(
        fixtures.map(async ([name]) => [
          name,
          (await prisma.reviewSubmission.findUnique({ where: { id: ids[name] }, select: { blobUrl: true } }))?.blobUrl ?? null,
        ]),
      ),
    ) as Record<string, string | null>;

    console.log("");
    // Ours: the pointer IS cleared and a delete IS aimed at our store. The
    // delete then fails, because the store is invented — that failure is the
    // network confirming the aim, not a defect of the rule.
    expect("ours — pointer cleared, delete aimed", after["ours"], null);
    // The two the old code would have wrecked.
    expect("foreign store — row left whole", after["foreign store"], fixtures[1][1]);
    expect("ours, not a cut path — row left whole", after["ours, not a cut path"], fixtures[2][1]);
    expect("nothing was counted as pruned", result.pruned, 0);
    expect("all three accounted for as failed", result.failed, 3);

    // =====================================================================
    step("WITH THE LEGACY TOKEN SET — the cutover state the new order creates");
    // =====================================================================
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_newprivatestore99_secret";
    process.env.BLOB_READ_WRITE_TOKEN_LEGACY = FAKE_TOKEN;
    ids = await seed();
    await pruneReviewUploads(90);
    const withLegacy = (await prisma.reviewSubmission.findUnique({ where: { id: ids["ours"] }, select: { blobUrl: true } }))?.blobUrl ?? null;
    expect("a row still in the OLD store is still prunable", withLegacy, null);
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_newprivatestore99_secret";
    delete process.env.BLOB_READ_WRITE_TOKEN_LEGACY;
    ids = await seed();
    await pruneReviewUploads(90);
    const withoutLegacy = (await prisma.reviewSubmission.findUnique({ where: { id: ids["ours"] }, select: { blobUrl: true } }))?.blobUrl ?? null;
    expect("…and WITHOUT the legacy token it is left whole, not stranded", withoutLegacy, fixtures[0][1]);

    await prisma.$disconnect();
  } finally {
    await server.stop();
    await db.close();
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
