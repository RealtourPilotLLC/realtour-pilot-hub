// ---------------------------------------------------------------------------
// FIXTURE A6 (R06, Sep 28 2026): child processes and worker threads.
//
// A child starts from whatever environment its parent hands it — c1, c2 and
// a02 REPLACE NODE_OPTIONS for theirs — and native programs are invisible to
// every Node-level fence. So: a Node child must come up inside the boundary
// whatever env it was given (marker, sentinel, the isolation preload in
// NODE_OPTIONS, quoted for the spaces in the repo path); a native database
// client handed a non-loopback URL must not start at all; the Prisma CLI must
// refuse a remote --url before it can start its engine. Every URL here is an
// unreachable TEST-NET-3 address.
// ---------------------------------------------------------------------------
import { exec, execFile, execSync, fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { REPO, SELF, SENTINEL_URL } from "../../_isolation.cjs";
import { check, DUMMY_DB, DUMMY_WHERE } from "./_check";

const PATH = process.env.PATH ?? "/usr/bin:/bin";
const REFUSED_NATIVE = /DRILL ISOLATION: refused to start \S+ with a database URL for 203\.0\.113\.10/;
const threw = (f: () => unknown) => { try { f(); return "no error"; } catch (e) { return (e as Error).message; } };
/** A child environment of exactly these keys (Next's types insist on NODE_ENV). */
const only = (env: Record<string, string>) => env as unknown as NodeJS.ProcessEnv;

/** What a Node child reports about itself, from `node -e`. */
const REPORT = `const s = globalThis[Symbol.for("rtp.drillIsolation")];
process.stdout.write(JSON.stringify({ active: !!(s && s.active), role: s ? s.role : "none", sentinel: process.env.DATABASE_URL === ${JSON.stringify(SENTINEL_URL)}, marker: process.env.RTP_DRILL_ISOLATION || "", nodeOptions: process.env.NODE_OPTIONS || "" }));`;

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

  // A native program that is not a database client still starts — and hands
  // the boundary on to anything it starts.
  const sh = spawnSync("/bin/sh", ["-c", `printf '%s|%s' "$RTP_DRILL_ISOLATION" "$NODE_OPTIONS"`], { env: only({ PATH, DATABASE_URL: DUMMY_DB }), encoding: "utf8" });
  const [shMarker, shOpts] = String(sh.stdout).split("|");
  c.ok("control: sh -c (no database client) with a remote URL still runs", sh.status === 0, `status ${sh.status}`);
  c.ok("…and its environment carries the marker and the isolation preload", shMarker === "1" && shOpts.includes(SELF), `marker=${shMarker}`);

  // ---- Node children ---------------------------------------------------------------
  const b = spawnSync(process.execPath, ["-e", REPORT], { env: only({ PATH }), encoding: "utf8", cwd: REPO });
  const rb = JSON.parse(b.stdout || "{}") as { active: boolean; role: string; sentinel: boolean; marker: string; nodeOptions: string };
  c.ok("a node child given ONLY {PATH} comes up inside the boundary, as a descendant", rb.active && rb.role === "descendant", JSON.stringify({ active: rb.active, role: rb.role }));
  c.ok("…its DATABASE_URL is the sentinel, not Prisma's .env", rb.sentinel);
  c.ok("…the marker is set and NODE_OPTIONS carries the QUOTED isolation require (spaces in the path)", rb.marker === "1" && rb.nodeOptions.includes(`--require ${JSON.stringify(SELF)}`), rb.nodeOptions.slice(-90));
  const g = spawnSync(process.execPath, ["-e", REPORT], { env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" }, encoding: "utf8", cwd: REPO });
  const rg = JSON.parse(g.stdout || "{}") as { active: boolean };
  c.ok("a child whose NODE_OPTIONS was REPLACED (as c1/c2/a02 do) is still inside it", rg.active === true);

  const q = spawnSync(process.execPath, ["-e", `const { PrismaClient } = require("@prisma/client");
new PrismaClient({ datasourceUrl: process.argv[1] }).$queryRaw\`SELECT 1\`.then(() => { console.log("CONNECTED"); process.exit(0); }, (e) => { console.error(String(e.message)); process.exit(3); });`, DUMMY_DB], { env: only({ PATH }), encoding: "utf8", cwd: REPO, timeout: 20_000 });
  c.ok(`a node child querying PrismaClient({ datasourceUrl: remote }) exits non-zero, refused`, q.status === 3 && String(q.stderr).includes(`DRILL ISOLATION: refused a Prisma connection to ${DUMMY_WHERE}`), `status ${q.status} · ${String(q.stderr).trim().slice(0, 90)}`);

  const t0 = Date.now();
  const cli = spawnSync("npx", ["prisma", "db", "execute", "--stdin", "--url", DUMMY_DB], { input: "SELECT 1;", encoding: "utf8", cwd: REPO, timeout: 60_000 });
  const cliOut = `${cli.stdout}${cli.stderr}`;
  const cliMs = Date.now() - t0;
  c.ok("npx prisma db execute --url <remote> exits non-zero with 'DRILL ISOLATION'", cli.status !== 0 && /DRILL ISOLATION: refused prisma db execute against 203\.0\.113\.10:5432/.test(cliOut), `status ${cli.status} · ${cliOut.trim().split("\n").pop()?.slice(0, 100)}`);
  c.ok("…within 10 s and without ever trying (no P1001)", cliMs < 10_000 && !/P1001|Can't reach database server/.test(cliOut), `${cliMs} ms`);

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

  // A worker thread shares the process but not its patched modules.
  const wr = await new Promise<{ msg: string; active: boolean }>((resolve) => {
    const w = new Worker(`const { parentPort } = require("worker_threads"); const net = require("net");
const active = !!(globalThis[Symbol.for("rtp.drillIsolation")] || {}).active;
const s = net.connect(5432, "203.0.113.10");
s.on("error", (e) => parentPort.postMessage({ msg: e.message, active }));
s.on("connect", () => { parentPort.postMessage({ msg: "connected", active }); s.destroy(); });`, { eval: true });
    w.on("message", (m) => { resolve(m as { msg: string; active: boolean }); void w.terminate(); });
    w.on("error", (e) => resolve({ msg: `worker error: ${e.message}`, active: false }));
  });
  c.ok("a worker thread comes up inside the boundary and its socket is refused", wr.active && /OUTBOUND BLOCKED BY DRILL ISOLATION/.test(wr.msg), `${wr.active} · ${wr.msg.slice(0, 80)}`);
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
