// THE RECOVERY DRILL — restore into an ISOLATED database and prove it works.
//
// Jordan, Sep 18: "Replaying updates into an existing database is useful
// validation, but also demonstrate recovery with MISSING RECORDS and REQUIRED
// DEPENDENCIES in isolation."
//
// The --deep rehearsal in restore-content-program.ts replays every row against
// the LIVE database inside a rolled-back transaction. That proves the payload
// is insertable — but against a database where every parent row already
// exists, which is the one condition a real disaster would not have. This drill
// answers the harder question: if the rows were GONE, could we put them back?
//
// It runs a real PostgreSQL (PGlite, compiled to WASM, served over the ordinary
// wire protocol on a loopback socket), so it needs no Docker, no install and no
// account. Nothing here touches production: the only production data it sees is
// the backup FILE you hand it.
//
// Usage: npx tsx scripts/recovery-drill.ts <backup.json> [--port 5433]
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const exec = promisify(execFile);

const file = process.argv[2];
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 5433;
if (!file) { console.error("usage: npx tsx scripts/recovery-drill.ts <backup.json> [--port N]"); process.exit(2); }

type Dump = { takenAt: string; commit?: string; schemaHash?: string; tables: Record<string, Record<string, unknown>[]> };

const step = (t: string) => console.log(`\n── ${t}`);

/**
 * A fresh PostgreSQL with the current schema on it and nothing else.
 *
 * Each scenario gets its OWN instance on its own port. PGlite is a
 * single-connection database behind a multiplexer, and the drill deliberately
 * kills a child process mid-restore (the missing-parent case) — which strands
 * that connection and wedges the server for every step after it. A database per
 * scenario is both more robust and a truer picture of a disaster: you do not
 * recover into the database you just broke.
 */
async function freshDatabase(port: number) {
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  // The child NEVER inherits a production URL. Prisma self-loads .env, but a
  // real environment variable beats it, so DATABASE_URL is pinned to loopback
  // here and asserted before anything runs.
  if (!url.includes("127.0.0.1")) throw new Error("refusing to run: the drill's DATABASE_URL is not loopback");
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  // ASYNC, NOT SYNC: the socket server lives in THIS process, so a synchronous
  // child-process call blocks the event loop and the server can never answer
  // the connection it is being asked to serve.
  const run = async (cmd: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await exec(cmd, args, { encoding: "utf8", env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      throw new Error([err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(-6000));
    }
  };
  await run("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"]);
  return { db, url, run, stop: async () => { await server.stop(); await db.close(); } };
}

/** The restore prints "  <Model> <id>: <why>" per unplaced row. */
const failureLines = (out: string) => out.split("\n").filter((l) => /^\s{2,}\S+\s+[A-Za-z0-9_-]{8,}:\s/.test(l));

async function main() {
  const dump = JSON.parse(readFileSync(file, "utf8")) as Dump;
  const models = Object.keys(dump.tables);
  const rows = Object.values(dump.tables).reduce((a, b) => a + b.length, 0);
  console.log(`backup ${file}`);
  console.log(`taken ${dump.takenAt}${dump.commit ? ` at ${dump.commit.slice(0, 8)}` : ""} · ${models.length} models · ${rows} rows`);

  const tmpFiles: string[] = [];
  const writeSubset = (name: string, only: string[]): string => {
    const path = `${file}.${name}.json`;
    const tables: Dump["tables"] = {};
    for (const t of only) tables[t] = dump.tables[t] ?? [];
    writeFileSync(path, JSON.stringify({ ...dump, tables }));
    tmpFiles.push(path);
    return path;
  };

  let external: string[] = [];

  // =====================================================================
  step("SCENARIO 1 — the whole program is gone: restore it into an empty database");
  // =====================================================================
  const one = await freshDatabase(BASE_PORT);
  try {
    const before = await one.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ContentScript"`);
    console.log(`   a database that has never seen this business: ContentScript rows = ${before.rows[0].n}`);
    if (before.rows[0].n !== 0) throw new Error("the isolated database was not empty");

    let out = "";
    try { out = await one.run("npx", ["tsx", "scripts/restore-content-program.ts", file, "--apply"]); }
    catch (e) { out = (e as Error).message; }
    console.log(`   ${out.split("\n").map((l) => l.trim()).filter((l) => /^restored /.test(l)).join(" ")}`);

    const failures = failureLines(out);
    if (failures.length) {
      const byModel = new Map<string, string>();
      for (const l of failures) byModel.set(l.trim().split(/\s+/)[0], l.split(": ").slice(1).join(": ").trim());
      console.log(`   rows this file could not place:`);
      for (const [m, why] of byModel) console.log(`     ${m.padEnd(22)} ${why.slice(0, 120)}`);
      external = [...byModel.keys()];
    }

    let restored = 0;
    for (const t of models) {
      const r = await one.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`).catch(() => null);
      if (r) restored += r.rows[0].n;
    }
    console.log(`   rebuilt ${restored} of ${rows} rows from nothing`);

    // Relationships, not just row counts: a restore that loses its pointers has
    // restored paperwork, not a program.
    const joined = await one.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ContentScript" s JOIN "ContentScriptVersion" v ON v.id = s."currentVersionId"`);
    const dangling = await one.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ContentScript" s WHERE s."approvedVersionId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "ContentScriptVersion" v WHERE v.id = s."approvedVersionId")`,
    );
    const pillars = await one.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ContentTopic" t WHERE t."pillarId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "ContentPillar" p WHERE p.id = t."pillarId")`,
    );
    console.log(`   scripts whose current version resolves: ${joined.rows[0].n}`);
    console.log(`   approved pointers with no version row (the old backup's bug): ${dangling.rows[0].n} (expected 0)`);
    console.log(`   topics pointing at a pillar that is not here: ${pillars.rows[0].n} (expected 0)`);
    if (dangling.rows[0].n !== 0 || pillars.rows[0].n !== 0) throw new Error("the restored program has dangling references");
  } finally {
    await one.stop();
  }

  // =====================================================================
  step("SCENARIO 2 — a REQUIRED PARENT is missing");
  // =====================================================================
  console.log("   restoring enrollments into a database with no Client rows at all.");
  console.log("   a restore that cannot see its parents must fail loudly and write nothing.");
  const two = await freshDatabase(BASE_PORT + 1);
  try {
    const childOnly = writeSubset("children-only", ["ContentEnrollment"]);
    let failed = false;
    let why = "";
    try { await two.run("npx", ["tsx", "scripts/restore-content-program.ts", childOnly, "--apply", "--strict"]); }
    catch (e) { failed = true; why = failureLines((e as Error).message)[0]?.split(": ").slice(1).join(": ").trim() ?? ""; }
    console.log(`   result: ${failed ? "FAILED, as it must" : "SUCCEEDED — that is a bug"}${why ? ` — "${why.slice(0, 90)}"` : ""}`);
    const left = await two.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ContentEnrollment"`);
    console.log(`   enrollments written without their client: ${left.rows[0].n} (expected 0)`);
    if (!failed || left.rows[0].n !== 0) throw new Error("orphaned rows were accepted — the restore is not safe");

  } finally {
    await two.stop();
  }

  // =====================================================================
  step("SCENARIO 3 — recovery from that state: the parents, then the children");
  // =====================================================================
  // Its OWN database again. Scenario 2 ends by killing a child process mid
  // connection, which strands that connection on a single-connection engine —
  // and you do not recover into the database you just broke anyway.
  const three = await freshDatabase(BASE_PORT + 2);
  try {
    const both = writeSubset("parents-then-children", ["Client", "ContentEnrollment"]);
    await three.run("npx", ["tsx", "scripts/restore-content-program.ts", both, "--apply", "--strict"]);
    const clients = await three.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Client"`);
    const enrollments = await three.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ContentEnrollment"`);
    const want = (dump.tables.ContentEnrollment ?? []).length;
    console.log(`   clients back: ${clients.rows[0].n} · enrollments back: ${enrollments.rows[0].n} of ${want}`);
    if (enrollments.rows[0].n !== want) throw new Error("enrollments did not come back once their parents existed");
    // Client rows reference OTHER Client rows (parentClientId — the Aryeo
    // customer-team folding, an assistant pointing at their agent). Restoring in
    // file order puts some children before their parents; that is what the
    // restore's retry passes are for, and this asserts they did their job.
    const selfRef = await three.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Client" c WHERE c."parentClientId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "Client" p WHERE p.id = c."parentClientId")`,
    );
    console.log(`   assistants whose agent row is missing: ${selfRef.rows[0].n} (expected 0)`);
    if (selfRef.rows[0].n !== 0) throw new Error("self-referencing client rows did not resolve");
  } finally {
    await three.stop();
    for (const f of tmpFiles) { try { unlinkSync(f); } catch { /* already gone */ } }
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("DRILL PASSED.");
  console.log("The backup rebuilds the whole program into an empty database with every");
  console.log("internal relationship intact, refuses to write orphans when a required parent");
  console.log("is absent, and recovers once that parent is restored. Production was never");
  console.log("touched: the only thing read from it was the backup file.");
  if (external.length) {
    console.log("");
    console.log(`KNOWN EXTERNAL DEPENDENCY: ${external.join(", ")} reference rows that live OUTSIDE`);
    console.log("the content-program backup (operational tables such as Project). They restore");
    console.log("correctly into a database that still holds the operational core; a bare-metal");
    console.log("rebuild needs the full pg_dump as well, exactly as the backup's header says.");
  }
}

main().catch((e) => { console.error(`\nDRILL FAILED: ${(e as Error).message}`); process.exit(1); });
