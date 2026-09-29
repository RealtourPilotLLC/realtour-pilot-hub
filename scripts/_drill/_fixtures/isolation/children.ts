// ---------------------------------------------------------------------------
// FIXTURE A6 (R06, Sep 28 2026): child processes and worker threads.
//
// A child starts from whatever environment its parent hands it — c1, c2 and
// a02 REPLACE NODE_OPTIONS for theirs — and native programs are invisible to
// every Node-level fence. So: a Node child must come up inside the boundary
// whatever env it was given (marker, sentinel, the isolation preload in
// NODE_OPTIONS, quoted for the spaces in the repo path); a native program
// handed a non-loopback host must not start at all; the Prisma CLI must
// refuse a remote --url before it can start its engine. Every host here is
// the unreachable TEST-NET-3 address 203.0.113.10.
//
// Second review (Sep 28 eve), all reproduced then, all refused now:
//   · native programs were checked against a list of database clients, and
//     only for a postgres:// URL — curl, `psql -h`, a conninfo string, a
//     `?host=` URL, PGHOSTADDR, `bash -lc`, `env psql …` and `env -i node`
//     (whose grandchild had no boundary) all got through;
//   · `prisma db execute --url` on 127.0.0.1 with `?host=203.0.113.10`: the
//     CLI guard passed it and the schema engine connected out;
//   · a worker thread given its OWN env ({} or { PATH }) came up with no
//     boundary: its raw socket went out, and with no DATABASE_URL Prisma's
//     .env load (in a worktree, the MAIN tree's .env) would be production.
//     The worker below therefore queries Prisma ONLY after it has seen the
//     boundary up and the sentinel in place.
// ---------------------------------------------------------------------------
import { exec, execFile, execSync, fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SHARE_ENV, Worker } from "node:worker_threads";
import { REPO, SELF, SENTINEL_URL } from "../../_isolation.cjs";
import { check, DUMMY_DB, DUMMY_WHERE, HOSTPARAM_DB, HOSTPARAM_WHERE } from "./_check";

const PATH = process.env.PATH ?? "/usr/bin:/bin";
const REFUSED_NATIVE = /DRILL ISOLATION: refused to start \S+ — it was handed .*203\.0\.113\.10/;
const threw = (f: () => unknown) => { try { f(); return "no error"; } catch (e) { return (e as Error).message; } };
/** A child environment of exactly these keys (Next's types insist on NODE_ENV). */
const only = (env: Record<string, string>) => env as unknown as NodeJS.ProcessEnv;

/** What a Node child reports about itself, from `node -e`. */
const REPORT = `const s = globalThis[Symbol.for("rtp.drillIsolation")];
process.stdout.write(JSON.stringify({ active: !!(s && s.active), role: s ? s.role : "none", sentinel: process.env.DATABASE_URL === ${JSON.stringify(SENTINEL_URL)}, marker: process.env.RTP_DRILL_ISOLATION || "", nodeOptions: process.env.NODE_OPTIONS || "" }));`;

/** A worker's report: the boundary, its database key, a raw socket to
 *  TEST-NET-3, and — only when the boundary is up and the key is the sentinel,
 *  so a broken boundary can never reach .env — two Prisma queries. */
const WORKER = `const { parentPort, workerData } = require("worker_threads");
const net = require("net");
const h = globalThis[Symbol.for("rtp.drillIsolation")];
const active = !!(h && h.active);
const db = process.env.DATABASE_URL === undefined ? "UNSET (Prisma would load .env)" : process.env.DATABASE_URL === workerData.sentinel ? "sentinel" : "other";
const s = new net.Socket();
let done = false;
const finish = async (raw) => {
  if (done) return;
  done = true;
  s.destroy();
  let explicit = "not run: boundary off or no sentinel";
  let byEnv = explicit;
  if (active && db === "sentinel") {
    const { PrismaClient } = require(require("module").createRequire(workerData.repo + "/package.json").resolve("@prisma/client"));
    const msg = (e) => String(e && e.message).replace(/\\s+/g, " ");
    const a = new PrismaClient({ datasourceUrl: workerData.dummy });
    explicit = await a.$queryRawUnsafe("SELECT 1").then(() => "CONNECTED", msg);
    const b = new PrismaClient();
    byEnv = await b.$queryRawUnsafe("SELECT 1").then(() => "CONNECTED", msg);
    await a.$disconnect().catch(() => {});
    await b.$disconnect().catch(() => {});
  }
  parentPort.postMessage({ active, role: h ? h.role : "none", db, raw, explicit, byEnv });
};
s.on("error", (e) => finish(e.message));
s.on("connect", () => finish("connected"));
s.setTimeout(2500, () => finish("still connecting after 2.5 s"));
s.connect(5432, "203.0.113.10");`;

type WorkerReport = { active: boolean; role: string; db: string; raw: string; explicit: string; byEnv: string };
function runWorker(opts: { env?: NodeJS.ProcessEnv | typeof SHARE_ENV; execArgv?: string[] }): Promise<WorkerReport> {
  return new Promise((resolve) => {
    const w = new Worker(WORKER, { eval: true, ...opts, workerData: { sentinel: SENTINEL_URL, dummy: DUMMY_DB, repo: REPO } } as ConstructorParameters<typeof Worker>[1]);
    w.on("message", (m) => { resolve(m as WorkerReport); void w.terminate(); });
    w.on("error", (e) => resolve({ active: false, role: "none", db: "?", raw: `worker error: ${e.message}`, explicit: "", byEnv: "" }));
  });
}

async function main() {
  const c = check("A6 · children and workers");

  // ---- native database clients -----------------------------------------------
  const a = threw(() => spawnSync("psql", [DUMMY_DB, "-c", "select 1"]));
  c.ok("spawnSync('psql', [remote URL]) throws before starting", REFUSED_NATIVE.test(a), a.slice(0, 110));
  const a2 = threw(() => spawnSync("/bin/sh", ["-c", `psql "$DATABASE_URL" -c 'select 1'`], { env: only({ PATH, DATABASE_URL: DUMMY_DB }) }));
  c.ok("sh -c 'psql \"$DATABASE_URL\"' with a remote URL in its env → refused", REFUSED_NATIVE.test(a2), a2.slice(0, 110));
  const a3 = threw(() => execSync(`pg_dump '${DUMMY_DB}'`, { stdio: "pipe" }));
  c.ok("execSync('pg_dump <remote URL>') → refused", REFUSED_NATIVE.test(a3), a3.slice(0, 110));
  // The async forms throw where spawn() is called, as Node does for any
  // argument it refuses; inside an async function that is a rejection.
  const a4 = await (async () => promisify(execFile)("pg_isready", ["-d", DUMMY_DB]))().then(() => "ran", (e: Error) => e.message);
  c.ok("execFile('pg_isready', ['-d', remote]) (async) → refused", REFUSED_NATIVE.test(a4), a4.slice(0, 110));
  const a5 = await (async () => promisify(exec)(`psql '${DUMMY_DB}'`))().then(() => "ran", (e: Error) => e.message);
  c.ok("exec('psql <remote URL>') (async, through a shell) → refused", REFUSED_NATIVE.test(a5), a5.slice(0, 110));

  // ---- the second review's shapes: judged by what they are HANDED ------------
  const handed: [string, () => unknown][] = [
    ["curl, a program that is no database client, handed http://203.0.113.10", () => spawnSync("/usr/bin/curl", ["-s", "-m", "2", "http://203.0.113.10:6281/"])],
    ["psql -h 203.0.113.10", () => spawnSync("psql", ["-h", "203.0.113.10", "-c", "select 1"])],
    ["psql 'host=203.0.113.10 dbname=none' (a conninfo string)", () => spawnSync("psql", ["host=203.0.113.10 dbname=none"])],
    ["psql with a 127.0.0.1 URL whose ?host= is 203.0.113.10", () => spawnSync("psql", [HOSTPARAM_DB])],
    ["pg_dump with PGHOSTADDR=203.0.113.10 in its env", () => spawnSync("pg_dump", ["none"], { env: only({ PATH, PGHOSTADDR: "203.0.113.10" }) })],
    ["bash -lc 'psql <remote URL>' (a flag cluster holding c)", () => spawnSync("/bin/bash", ["-lc", `psql '${DUMMY_DB}'`])],
    ["/usr/bin/env psql <remote URL> (a wrapper)", () => spawnSync("/usr/bin/env", ["psql", DUMMY_DB])],
  ];
  for (const [label, run] of handed) {
    const m = threw(run);
    c.ok(`NEW: ${label} → refused before it starts`, REFUSED_NATIVE.test(m), m.slice(0, 120));
  }
  const envI = threw(() => spawnSync("/usr/bin/env", ["-i", process.execPath, "-e", "const s = require('net').connect(5432, '203.0.113.10'); s.setTimeout(1500, () => process.exit(0)); s.on('error', () => process.exit(0));"], { timeout: 10_000 }));
  c.ok("NEW: env -i node … (a grandchild with none of the boundary's environment) → refused", /DRILL ISOLATION: refused to start env — `env -i`/.test(envI), envI.slice(0, 120));
  const unsetOpts = threw(() => spawnSync("/bin/sh", ["-c", "unset NODE_OPTIONS; node -e 1"]));
  c.ok("NEW: sh -c 'unset NODE_OPTIONS; node …' → refused", /DRILL ISOLATION: refused to start sh — `unset NODE_OPTIONS`/.test(unsetOpts), unsetOpts.slice(0, 120));

  // A native program that is handed nothing remote still starts — and hands
  // the boundary on to anything it starts.
  const sh = spawnSync("/bin/sh", ["-c", `printf '%s|%s' "$RTP_DRILL_ISOLATION" "$NODE_OPTIONS"`], { env: only({ PATH, DATABASE_URL: DUMMY_DB }), encoding: "utf8" });
  const [shMarker, shOpts] = String(sh.stdout).split("|");
  c.ok("control: sh -c (no database client) with a remote URL in its env still runs", sh.status === 0, `status ${sh.status}`);
  c.ok("…and its environment carries the marker and the isolation preload", shMarker === "1" && shOpts.includes(SELF), `marker=${shMarker}`);
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  c.ok("control: git, handed nothing remote, still runs", git.status === 0 && /^git version/.test(String(git.stdout)), String(git.stdout).trim());

  // ---- Node children ---------------------------------------------------------------
  const b = spawnSync(process.execPath, ["-e", REPORT], { env: only({ PATH }), encoding: "utf8", cwd: REPO });
  const rb = JSON.parse(b.stdout || "{}") as { active: boolean; role: string; sentinel: boolean; marker: string; nodeOptions: string };
  c.ok("a node child given ONLY {PATH} comes up inside the boundary, as a descendant", rb.active && rb.role === "descendant", JSON.stringify({ active: rb.active, role: rb.role }));
  c.ok("…its DATABASE_URL is the sentinel, not Prisma's .env", rb.sentinel);
  c.ok("…the marker is set and NODE_OPTIONS carries the QUOTED isolation require (spaces in the path)", rb.marker === "1" && rb.nodeOptions.includes(`--require ${JSON.stringify(SELF)}`), rb.nodeOptions.slice(-90));
  const g = spawnSync(process.execPath, ["-e", REPORT], { env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" }, encoding: "utf8", cwd: REPO });
  const rg = JSON.parse(g.stdout || "{}") as { active: boolean };
  c.ok("a child whose NODE_OPTIONS was REPLACED (as c1/c2/a02 do) is still inside it", rg.active === true);
  const viaEnv = spawnSync("/usr/bin/env", [process.execPath, "-e", REPORT], { env: only({ PATH }), encoding: "utf8", cwd: REPO });
  const re = JSON.parse(viaEnv.stdout || "{}") as { active: boolean; role: string };
  c.ok("control: node started through /usr/bin/env (no -i) runs, inside the boundary", re.active && re.role === "descendant", JSON.stringify(re));

  const q = spawnSync(process.execPath, ["-e", `const { PrismaClient } = require("@prisma/client");
new PrismaClient({ datasourceUrl: process.argv[1] }).$queryRaw\`SELECT 1\`.then(() => { console.log("CONNECTED"); process.exit(0); }, (e) => { console.error(String(e.message)); process.exit(3); });`, DUMMY_DB], { env: only({ PATH }), encoding: "utf8", cwd: REPO, timeout: 20_000 });
  c.ok(`a node child querying PrismaClient({ datasourceUrl: remote }) exits non-zero, refused`, q.status === 3 && String(q.stderr).includes(`DRILL ISOLATION: refused a Prisma connection to ${DUMMY_WHERE}`), `status ${q.status} · ${String(q.stderr).trim().slice(0, 90)}`);

  const t0 = Date.now();
  const cli = spawnSync("npx", ["prisma", "db", "execute", "--stdin", "--url", DUMMY_DB], { input: "SELECT 1;", encoding: "utf8", cwd: REPO, timeout: 60_000 });
  const cliOut = `${cli.stdout}${cli.stderr}`;
  const cliMs = Date.now() - t0;
  c.ok("npx prisma db execute --url <remote> exits non-zero with 'DRILL ISOLATION'", cli.status !== 0 && /DRILL ISOLATION: refused prisma db execute against 203\.0\.113\.10:5432/.test(cliOut), `status ${cli.status} · ${cliOut.trim().split("\n").pop()?.slice(0, 100)}`);
  c.ok("…within 10 s and without ever trying (no P1001)", cliMs < 10_000 && !/P1001|Can't reach database server/.test(cliOut), `${cliMs} ms`);
  const t1 = Date.now();
  const cli2 = spawnSync("npx", ["prisma", "db", "execute", "--stdin", "--url", HOSTPARAM_DB], { input: "SELECT 1;", encoding: "utf8", cwd: REPO, timeout: 60_000 });
  const cli2Out = `${cli2.stdout}${cli2.stderr}`;
  c.ok(`NEW: npx prisma db execute --url <127.0.0.1 with ?host=203.0.113.10> → refused, naming ${HOSTPARAM_WHERE}, without trying`,
    cli2.status !== 0 && new RegExp(`DRILL ISOLATION: refused prisma db execute against ${HOSTPARAM_WHERE.replace(/\./g, "\\.")}`).test(cli2Out) && !/P1001|Can't reach database server/.test(cli2Out) && Date.now() - t1 < 10_000,
    `status ${cli2.status} · ${Date.now() - t1} ms · ${cli2Out.trim().split("\n").pop()?.slice(0, 100)}`);

  // fork: the same execArgv (so the same preloads) plus NODE_OPTIONS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-a6-"));
  const forked = path.join(dir, "forked.cjs");
  fs.writeFileSync(forked, `const net = require("net");
const s = net.connect(5432, "203.0.113.10");
s.on("error", (e) => { process.send({ msg: e.message, active: !!(globalThis[Symbol.for("rtp.drillIsolation")] || {}).active }, () => process.exit(0)); });
s.on("connect", () => { process.send({ msg: "connected" }, () => process.exit(0)); });`);
  const fr = await new Promise<{ msg: string; active?: boolean }>((resolve) => {
    const child = fork(forked, [], { env: only({ PATH }) });
    child.on("message", (m) => resolve(m as { msg: string; active?: boolean }));
    child.on("exit", (code) => resolve({ msg: `exited ${code} without a message` }));
  });
  c.ok("a fork()ed child is fenced: its socket to 203.0.113.10 is refused", /OUTBOUND BLOCKED BY DRILL ISOLATION/.test(fr.msg) && fr.active === true, fr.msg.slice(0, 90));
  fs.rmSync(dir, { recursive: true, force: true });

  // ---- worker threads: a worker shares the process but not its patched modules
  const workers: [string, Parameters<typeof runWorker>[0]][] = [
    ["default options", {}],
    ["NEW: env: {} (nothing at all)", { env: only({}) }],
    ["NEW: env: { PATH }", { env: only({ PATH }) }],
    ["NEW: env: { PATH }, execArgv: [] (no inherited preloads either)", { env: only({ PATH }), execArgv: [] }],
    ["SHARE_ENV", { env: SHARE_ENV }],
  ];
  for (const [label, opts] of workers) {
    const w = await runWorker(opts);
    const ok = w.active && w.role === "descendant" && w.db === "sentinel" && /OUTBOUND BLOCKED BY DRILL ISOLATION/.test(w.raw) &&
      w.explicit.includes(`DRILL ISOLATION: refused a Prisma connection to ${DUMMY_WHERE}`) && /DRILL ISOLATION: this drill has no database/.test(w.byEnv);
    c.ok(`a worker (${label}) comes up inside the boundary: sentinel, raw socket refused, both Prisma queries refused by the engine guard`, ok,
      `${w.role} · db ${w.db} · ${w.raw.slice(0, 50)} · ${w.explicit.slice(0, 60)} · ${w.byEnv.slice(0, 50)}`);
  }
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
