#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- a plain `node` script: CommonJS by definition */
// ---------------------------------------------------------------------------
// THE DRILL RUNNER (R06, Sep 28 2026).
//
//   npm run drills                              every isolated drill, one by one
//   npm run drills -- scripts/_drill/<f>.ts …   just those
//   npm run drills:boundary                     the isolation boundary's own proof
//   options: --list (the plan, nothing run) · --timeout <s> · --logs <dir>
//            --allow-skips (a SKIPPED run no longer fails the suite)
//
// WHY A COMMITTED RUNNER. What actually ran as "the suite" was a scratch
// script outside the repo. It picked drills by grepping for PGlite, so 11 of
// 113 never ran, and before every drill it ran `kill -9` on anything
// listening on ports 5480-5660 — the isolated demo's database and clip server
// among them. This one:
//   · runs EVERY top-level scripts/_drill/*.ts (not _* helpers, not
//     zz-scratch-* copies) and skips none silently: a drill that cannot run
//     here (tools/realpg not installed) is listed as SKIPPED and counted;
//   · starts each drill from an environment built from NOTHING — PATH, HOME,
//     TMPDIR, locale, the database keys on the isolation sentinel, every .env
//     key blank — with the isolation preload, and FAILS a drill whose output
//     lacks the boundary's banner ("ran without the isolation boundary");
//   · runs each in its own process group and, on timeout, kills that group —
//     the processes it started — never anything found by port;
//   · prints one row per run (verdict, seconds, the drill's own tally) and
//     exits 1 on any failure — and on any SKIPPED run (second review, Sep 28
//     eve: five realpg runs could skip on a machine without tools/realpg and
//     the suite still exited 0), unless --allow-skips says that is accepted;
//   · counts a drill that exits 0 but prints no pass/fail tally as RAN, not
//     PASS (r02-completion is a walkthrough with no assertions: it used to be
//     counted as a passing check), and fails a run if ANY tally line it
//     prints has failures, not just the last.
//
// A drill can ask for a different launch in its header, one line per run:
//   // @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//   // @drill-run: engine=postgres needs=tools/realpg timeout=900
// conditions=none drops --conditions=react-server; require= adds preloads
// after _drill-preload.cjs; needs=<dir> skips (visibly) unless <dir>/node_modules
// exists; engine= sets DRILL_ENGINE; timeout= is in seconds (default 600).
// DRILL_ENGINE, DRILL_POOL, DRILL_K and DRILL_N pass through from the caller.
//
// --boundary runs the fixtures in scripts/_drill/_fixtures/isolation/ as ROOT
// processes, exactly like a drill but with the database keys preset to an
// unreachable TEST-NET-3 address (203.0.113.10) instead of the sentinel — so
// even a broken preload could only ever send a SYN there — and a dummy blob
// token the boundary must blank. A10 runs a COPY of a fixture from a temp
// folder outside scripts/_drill/, handed a 127.0.0.1 database. While they run
// it polls lsof for any socket to 203.0.113.10 (the OS-level witness). It also
// runs the OLD shapes — the same query with no boundary (A9), the old harness
// fence (A9b), and the FIRST R06 boundary with the six holes the second
// review found (A9c) — to show the witness sees real attempts, then the
// in-suite drill isolation-boundary.ts.
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

// Required as a module (isolation-boundary.ts checks the verdict rules
// below), it runs nothing: no version hop, no marker check, no arguments.
const AS_MAIN = require.main === module;

const NODE20 = "/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin/node";
if (AS_MAIN && Number(process.versions.node.split(".")[0]) < 20) {
  // The system Node here is 16 (AGENTS.md). Re-run under 20 rather than fail.
  if (fs.existsSync(NODE20) && process.execPath !== NODE20) {
    const r = spawnSync(NODE20, [__filename].concat(process.argv.slice(2)), { stdio: "inherit" });
    process.exit(r.status === null ? 1 : r.status);
  }
  console.error(`run-all needs Node 20+ (this is ${process.version}); nvm use`);
  process.exit(1);
}

const DRILL_DIR = fs.realpathSync(__dirname);
const REPO = path.resolve(DRILL_DIR, "..", "..");
const FIXTURES = path.join(DRILL_DIR, "_fixtures", "isolation");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const PRELOAD = "./scripts/_drill/_drill-preload.cjs";
const iso = require("./_isolation.cjs");

if (AS_MAIN && process.env[iso.MARKER] === "1") {
  // Everything this process started would inherit the marker and run as a
  // descendant, not as the root a drill must be.
  console.error("run-all must be started from a normal shell, not from inside a drill (RTP_DRILL_ISOLATION is set).");
  process.exit(1);
}

// ---- arguments ---------------------------------------------------------------

const argv = AS_MAIN ? process.argv.slice(2) : [];
const opt = { boundary: false, list: false, timeout: 600, logs: null, allowSkips: false, files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--boundary") opt.boundary = true;
  else if (a === "--list") opt.list = true;
  else if (a === "--timeout") opt.timeout = Number(argv[++i]);
  else if (a === "--logs") opt.logs = argv[++i];
  else if (a === "--allow-skips") opt.allowSkips = true;
  else if (a.startsWith("-")) { console.error(`unknown option ${a}`); process.exit(2); }
  else opt.files.push(a);
}
if (AS_MAIN && (!Number.isFinite(opt.timeout) || opt.timeout <= 0)) { console.error("--timeout needs seconds"); process.exit(2); }

/** A drill file named on the command line, or a refusal. */
function drillFile(arg) {
  let real;
  try { real = fs.realpathSync(path.resolve(arg)); } catch { refuse(`${arg} does not exist`); }
  if (path.dirname(real) !== DRILL_DIR || !real.endsWith(".ts") || path.basename(real).startsWith("_")) {
    refuse(`${arg} is not an isolated drill (live probes live in scripts/_live — see its README)`);
  }
  return real;
}
function refuse(msg) {
  console.error(`refused: ${msg}`);
  process.exit(2);
}

// ---- the plan ------------------------------------------------------------------

/** One run per `// @drill-run:` line in the header, or one default run. */
function runsOf(file) {
  const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 40);
  const specs = [];
  for (const line of head) {
    const m = /^\s*\/\/\s*@drill-run:(.*)$/.exec(line);
    if (!m) continue;
    const spec = { conditions: "react-server", requires: [], needs: [], engine: null, timeout: null };
    for (const tok of m[1].trim().split(/\s+/).filter(Boolean)) {
      const [k, v] = [tok.slice(0, tok.indexOf("=")), tok.slice(tok.indexOf("=") + 1)];
      if (k === "conditions") spec.conditions = v;
      else if (k === "require") spec.requires.push(...v.split(",").filter(Boolean));
      else if (k === "needs") spec.needs.push(...v.split(",").filter(Boolean));
      else if (k === "engine") spec.engine = v;
      else if (k === "timeout") spec.timeout = Number(v);
      else throw new Error(`${path.basename(file)}: unknown @drill-run key "${k}"`);
    }
    specs.push(spec);
  }
  if (!specs.length) specs.push({ conditions: "react-server", requires: [], needs: [], engine: null, timeout: null });
  return specs.map((s) => ({ file, spec: s, label: path.basename(file) + (s.engine ? ` @${s.engine}` : "") }));
}

function allDrills() {
  return fs.readdirSync(DRILL_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !f.startsWith("zz-scratch-"))
    .sort()
    .map((f) => path.join(DRILL_DIR, f));
}

// ---- the launch -------------------------------------------------------------------

/** An environment built from nothing. The database keys are the sentinel — a
 *  second barrier should the preload ever fail to load — and every .env key
 *  is blank, so Prisma's .env load has nothing to fill. */
function cleanEnv(extra) {
  const env = { PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") };
  for (const k of ["HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "TERM"]) if (process.env[k]) env[k] = process.env[k];
  for (const k of iso.secretKeyNames()) env[k] = "";
  env.DATABASE_URL = iso.SENTINEL_URL;
  env.DIRECT_URL = iso.SENTINEL_URL;
  env.CHECKPOINT_DISABLE = "1";
  env.PRISMA_HIDE_UPDATE_MESSAGE = "1";
  env.npm_config_update_notifier = "false";
  for (const k of ["DRILL_ENGINE", "DRILL_POOL", "DRILL_K", "DRILL_N"]) if (process.env[k]) env[k] = process.env[k];
  return Object.assign(env, extra || {});
}

let current = null; // the process group now running, for Ctrl-C
if (AS_MAIN) {
  process.on("SIGINT", () => {
    if (current) { try { process.kill(-current.pid, "SIGKILL"); } catch { /* gone */ } }
    process.exit(130);
  });
}

/** Runs one process in its own group; resolves with its output and verdict inputs. */
function launch({ args, env, timeoutS, witness }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: REPO, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    current = child;
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutS * 1000);
    const seen = witness ? startWitness() : null;
    let exit = { code: null, signal: null };
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      clearTimeout(timer);
      // Anything the drill left running in ITS group (never anyone else's) —
      // a straggler holding the output pipe would otherwise hold the run open.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* nothing left */ }
    });
    child.on("close", () => {
      current = null;
      const sockets = seen ? seen.stop() : [];
      resolve({ code: exit.code, signal: exit.signal, timedOut, out, err, seconds: (Date.now() - started) / 1000, sockets });
    });
  });
}

/** The OS-level witness: every 100 ms, any socket of any process to 203.0.113.10. */
function startWitness() {
  const lines = new Set();
  let live = true;
  const poll = () => {
    if (!live) return;
    let text = "";
    try { text = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP@203.0.113.10"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { text = (e && e.stdout) || ""; }
    for (const l of text.split("\n").slice(1)) if (l.trim()) lines.add(l.replace(/\s+/g, " ").trim());
    setTimeout(poll, 100);
  };
  poll();
  return { stop() { live = false; return Array.from(lines); } };
}

/** Every "N passed, M failed" tally LINE a run printed — at the start of a
 *  line (or after "ALL PASS — " / "ALL GREEN — "), which is how every drill
 *  prints it. Anchored because a check's own detail may quote a tally
 *  ("… — 3 passed, 1 failed"), and that is not the run's verdict. */
function tallies(text) {
  return text.match(/^[ \t]*(?:ALL [A-Z ]+— )?\d+ passed, \d+ failed\b[^\n]*/gm) || [];
}

/** The run's own verdict line: its last tally, or a final ALL PASSED / ALL
 *  GREEN / "PASS — …" line (due-filter and r02-sentence end that way). "" when
 *  it printed none. */
function tally(text) {
  const all = tallies(text);
  if (all.length) return all[all.length - 1];
  const ok = text.match(/ALL (CHECKS )?PASS(ED)?[^\n]*|ALL GREEN[^\n]*|^PASS — [^\n]*/gm) || [];
  return ok.length ? ok[ok.length - 1] : "";
}

function drillArgs(file, spec, withPreload) {
  const pre = withPreload ? ["--require", PRELOAD] : [];
  for (const r of spec.requires) pre.push("--require", r);
  return [TSX].concat(pre, [file]);
}

async function runDrill(run, logDir) {
  const { file, spec, label } = run;
  const missing = spec.needs.filter((n) => !fs.existsSync(path.join(REPO, n, "node_modules")));
  if (missing.length) return { label, verdict: "SKIPPED", seconds: 0, note: `needs ${missing.join(", ")} (npm install --prefix ${missing[0]})` };
  const env = cleanEnv({ NODE_OPTIONS: spec.conditions === "none" ? "" : `--conditions=${spec.conditions}` });
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  if (spec.engine) env.DRILL_ENGINE = spec.engine;
  const r = await launch({ args: drillArgs(file, spec, true), env, timeoutS: spec.timeout || opt.timeout });
  const text = r.out + r.err;
  const log = path.join(logDir, label.replace(/[^\w.-]+/g, "_") + ".log");
  fs.writeFileSync(log, text);
  const v = drillVerdict({ bannerSeen: r.err.includes(iso.BANNER), timedOut: r.timedOut, code: r.code, signal: r.signal, text, timeoutS: spec.timeout || opt.timeout });
  return { label, verdict: v.verdict, seconds: r.seconds, note: v.note, log };
}

/** Pure: one drill run's verdict from how it ended and what it printed. */
function drillVerdict({ bannerSeen, timedOut, code, signal, text, timeoutS }) {
  const t = tally(text);
  // ANY tally with failures, not just the last one printed.
  const failing = tallies(text).find((x) => /\b[1-9]\d* failed\b/.test(x));
  if (!bannerSeen) return { verdict: "FAIL", note: "ran without the isolation boundary" };
  if (timedOut) return { verdict: "FAIL", note: `timed out after ${timeoutS}s — its process group was killed` };
  if (code !== 0 || failing) return { verdict: "FAIL", note: `exit ${code === null ? signal : code} · ${failing || t || lastLines(text)}` };
  if (!t) return { verdict: "RAN", note: "exit 0, but it printed no pass/fail tally — a walkthrough, not a check" };
  return { verdict: "PASS", note: t };
}

/** Pure: the suite's exit code — 1 on any FAIL, and on any SKIPPED run unless
 *  skips were accepted. RAN is neither a pass nor a failure. */
function suiteExitCode(rows, allowSkips) {
  const has = (v) => rows.some((r) => r.verdict === v);
  return has("FAIL") || (has("SKIPPED") && !allowSkips) ? 1 : 0;
}

function lastLines(text) {
  return text.trim().split("\n").slice(-3).join(" ⏎ ").replace(/\s+/g, " ").slice(0, 240);
}

function printRow(row) {
  const secs = row.seconds ? `${row.seconds.toFixed(1)}s` : "";
  console.log(`${row.verdict.padEnd(7)} ${secs.padStart(7)}  ${row.label.padEnd(38)} ${row.note}`);
}

// ---- the boundary proof --------------------------------------------------------------------

const DUMMY_DB = "postgresql://drill:dummy@203.0.113.10:5432/none?connect_timeout=2&sslmode=disable";
// The first R06 boundary, the one the second review (Sep 28 eve) tested.
const FIRST_BUILD = "c52d4a2";
// A9c's control, run under that boundary. Every destination is TEST-NET-3.
// It never builds a Prisma client where the boundary might be off (a worker,
// env -i): with no boundary, Prisma's .env load would be production.
const FIRST_BUILD_CONTROL = `// Generated by run-all --boundary (A9c): the ${FIRST_BUILD} boundary and six of its holes.
const net = require("net");
const path = require("path");
const { Worker } = require("worker_threads");
const { spawnSync } = require("child_process");
const REPO = process.argv[2];
const h = globalThis[Symbol.for("rtp.drillIsolation")];
const out = (k, v) => console.log("OLD-BOUNDARY " + k + ": " + v);
const RAW = 'const net = require("net"); const h = globalThis[Symbol.for("rtp.drillIsolation")]; const s = new net.Socket(); let d = false;' +
  ' const fin = (m) => { if (!d) { d = true; s.destroy(); REPORT((h && h.active ? "active" : "NO BOUNDARY") + " · " + m); } };' +
  ' s.on("error", (e) => fin(e.message)); s.on("connect", () => fin("connected")); s.setTimeout(2500, () => fin("still connecting after 2.5 s")); s.connect(PORT, "203.0.113.10");';
const sock = (port) => new Promise((resolve) => {
  const s = new net.Socket();
  let done = false;
  const fin = (m) => { if (!done) { done = true; s.destroy(); resolve(m); } };
  s.on("error", (e) => fin(e.message));
  s.on("connect", () => fin("connected"));
  s.setTimeout(2500, () => fin("still connecting after 2.5 s"));
  s.connect(port, "203.0.113.10");
});
(async () => {
  out("active", String(!!(h && h.active)) + " role=" + (h ? h.role : "none"));
  // 1. string ports Node reads as 6282 (0x188a is 6282 too)
  const ports = ["6282\\n", " 6282", "0x188a", "6282.0"];
  const got = await Promise.all(ports.map(sock));
  ports.forEach((p, i) => out("port#" + i, JSON.stringify(p) + " · " + got[i]));
  // 2. ?host= past the engine guard
  const { PrismaClient } = require(require("module").createRequire(path.join(REPO, "package.json")).resolve("@prisma/client"));
  const p = new PrismaClient({ datasourceUrl: "postgresql://drill:dummy@127.0.0.1:6283/none?host=203.0.113.10&connect_timeout=2&sslmode=disable" });
  out("prisma ?host=", await p.$queryRawUnsafe("SELECT 1").then(() => "CONNECTED", (e) => String(e.message).replace(/\\s+/g, " ").slice(0, 160)));
  await p.$disconnect().catch(() => {});
  // 3. a worker given its own env: a raw socket only
  out("worker env {PATH}", await new Promise((resolve) => {
    const w = new Worker(RAW.replace("REPORT(", "require('worker_threads').parentPort.postMessage(").replace("PORT", "6284"), { eval: true, env: { PATH: process.env.PATH } });
    w.on("message", (m) => { resolve(m); w.terminate(); });
    w.on("error", (e) => resolve("worker error " + e.message));
  }));
  // 4. curl, a native program that is not a database client, handed a URL
  try { const r = spawnSync("/usr/bin/curl", ["-s", "-m", "2", "http://203.0.113.10:6285/"]); out("curl", "started, exit " + r.status); } catch (e) { out("curl", "refused: " + e.message.slice(0, 100)); }
  // 5. env -i node: a grandchild with none of the boundary's environment
  try {
    const r = spawnSync("/usr/bin/env", ["-i", process.execPath, "-e", RAW.replace("REPORT(", "console.log(").replace("PORT", "6286")], { encoding: "utf8" });
    out("env -i node", String(r.stdout).trim() || "exit " + r.status);
  } catch (e) { out("env -i node", "refused: " + e.message.slice(0, 100)); }
  // 6. the Prisma CLI, --url on 127.0.0.1 with ?host=
  const t0 = Date.now();
  const cli = spawnSync(process.execPath, [path.join(REPO, "node_modules", "prisma", "build", "index.js"), "db", "execute", "--stdin", "--url", "postgresql://drill:dummy@127.0.0.1:6287/none?host=203.0.113.10&connect_timeout=2&sslmode=disable"], { input: "SELECT 1;", encoding: "utf8", cwd: REPO, timeout: 60000 });
  out("prisma cli ?host=", "exit " + cli.status + " after " + (Date.now() - t0) + " ms · " + (String(cli.stdout) + String(cli.stderr)).replace(/\\s+/g, " ").trim().slice(-200));
  process.exit(0);
})();
`;
// Built at run time: a token-shaped literal trips secret scanners (Sep 26).
const DUMMY_BLOB = [["vercel", "blob", "rw"].join("_"), "boundarydummy"].join("_");

async function runBoundary(logDir) {
  const rows = [];
  const env = (extra) => cleanEnv(Object.assign({ NODE_OPTIONS: "--conditions=react-server", DATABASE_URL: DUMMY_DB, DIRECT_URL: DUMMY_DB, BLOB_READ_WRITE_TOKEN: DUMMY_BLOB }, extra || {}));
  // For the fixtures that run WITH the boundary, the .env keys are NOT pre-
  // blanked by the runner: blanking them (and the dummy blob token) is the
  // boundary's job, and A1/A7 check it did. The database keys stay on the
  // TEST-NET dummy, so a broken boundary could still only ever send a SYN.
  const bareEnv = () => {
    const e = env();
    for (const k of iso.secretKeyNames()) if (k !== "BLOB_READ_WRITE_TOKEN") delete e[k];
    return e;
  };
  const save = (name, r) => { const log = path.join(logDir, `boundary-${name}.log`); fs.writeFileSync(log, `${r.out}${r.err}\n--- lsof witness ---\n${r.sockets.join("\n")}\n`); return log; };

  /** A fixture run as a root: banner, a clean tally, and no socket seen. */
  const rootRun = async (label, name, args, e) => {
    const r = await launch({ args, env: e, timeoutS: 180, witness: true });
    const text = r.out + r.err;
    const t = tally(text);
    let verdict = "PASS";
    let note = t;
    if (!r.err.includes(iso.BANNER)) { verdict = "FAIL"; note = "ran without the isolation boundary"; }
    else if (r.code !== 0 || !/\b0 failed\b/.test(t)) { verdict = "FAIL"; note = `exit ${r.code} · ${t || lastLines(text)}`; }
    else if (r.sockets.length) { verdict = "FAIL"; note = `lsof saw a socket to 203.0.113.10: ${r.sockets[0]}`; }
    else note += " · lsof: no socket to 203.0.113.10";
    rows.push({ label, verdict, seconds: r.seconds, note, log: save(name, r) });
    printRow(rows[rows.length - 1]);
  };

  const fixtures = ["comment-only", "indirect", "late-env", "explicit-client", "raw-sockets", "children", "dotenv"];
  const ids = { "comment-only": "A1", indirect: "A2", "late-env": "A3", "explicit-client": "A4", "raw-sockets": "A5", children: "A6", dotenv: "A7" };
  for (const name of fixtures) {
    await rootRun(`${ids[name]} ${name}.ts (root)`, name, [TSX, "--require", PRELOAD, path.join(FIXTURES, `${name}.ts`)], bareEnv());
  }

  // A10: a drill COPIED OUT of scripts/_drill/ (second review, Sep 28 eve).
  // A fresh temp folder with node_modules linked in, as a scratchpad copy
  // would have it, run with the preload and handed a 127.0.0.1 database on
  // port 1 (nothing listens there, so even a broken boundary could reach no
  // one's database). The first build left it inactive.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-isolation-outside-"));
    try {
      fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"), "dir");
      const copy = path.join(tmp, "outside-copy.ts");
      fs.copyFileSync(path.join(FIXTURES, "outside-copy.ts"), copy);
      const handed = "postgresql://postgres:postgres@127.0.0.1:1/handed_by_the_caller?sslmode=disable&connect_timeout=2";
      const e = bareEnv();
      e.DATABASE_URL = handed;
      e.DIRECT_URL = handed;
      await rootRun("A10 outside-copy.ts (a copy in a temp folder)", "outside-copy", [TSX, "--require", PRELOAD, copy, path.join(DRILL_DIR, "_isolation.cjs")], e);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // A8: a drill that boots a database, run WITHOUT the preload — refused
  // before PGlite starts.
  {
    const r = await launch({ args: [TSX, path.join(FIXTURES, "harness-boot.ts")], env: env(), timeoutS: 120, witness: true });
    const text = r.out + r.err;
    const t = tally(text);
    const ok = r.code === 0 && /\b0 failed\b/.test(t) && !r.err.includes(iso.BANNER) && !r.sockets.length;
    rows.push({ label: "A8 harness-boot.ts (no preload)", verdict: ok ? "PASS" : "FAIL", seconds: r.seconds, note: ok ? `${t} · refused before boot` : `exit ${r.code} · ${t || lastLines(text)}`, log: save("harness-boot", r) });
    printRow(rows[rows.length - 1]);
  }

  // A8b: A1 run WITHOUT the preload — the src/lib/prisma.ts backstop refuses
  // at import, and nothing reaches the network.
  {
    const r = await launch({ args: [TSX, path.join(FIXTURES, "comment-only.ts")], env: env(), timeoutS: 120, witness: true });
    const text = r.out + r.err;
    const ok = r.code !== 0 && /DRILL ISOLATION: this is a drill process without the isolation boundary/.test(text) && !r.sockets.length;
    rows.push({ label: "A8b comment-only.ts (no preload)", verdict: ok ? "PASS" : "FAIL", seconds: r.seconds, note: ok ? "backstop refused at import · lsof: no socket" : `exit ${r.code} · ${lastLines(text)}`, log: save("comment-only-no-preload", r) });
    printRow(rows[rows.length - 1]);
  }

  // A9: the OLD shape, the control that makes A1 mean something. A1's own
  // code (static @/lib/prisma, SELECT 1), with the boundary taken away the way
  // HEAD 1075a5b had it: HEAD's _drill-preload.cjs (no isolation) and the file
  // outside scripts/_drill/ (so the new prisma.ts backstop does not apply).
  // It must really try the database its environment names — P1001 on
  // 203.0.113.10:5432 — and the witness must see that attempt.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-isolation-old-"));
    try {
      const oldPreload = path.join(tmp, "_drill-preload.1075a5b.cjs");
      fs.writeFileSync(oldPreload, execFileSync("git", ["show", "1075a5b:scripts/_drill/_drill-preload.cjs"], { cwd: REPO, encoding: "utf8" }));
      const src = fs.readFileSync(path.join(FIXTURES, "comment-only.ts"), "utf8");
      const control = path.join(tmp, "comment-only.old.ts");
      fs.writeFileSync(control, [
        "// Generated by run-all --boundary: A1's query with the boundary taken away.",
        `import { prisma } from ${JSON.stringify(path.join(REPO, "src", "lib", "prisma.ts"))};`,
        "async function main() {",
        "  const t0 = Date.now();",
        "  const e = await prisma.$queryRaw`SELECT 1`.then(() => \"no error\", (x: Error) => x.message);",
        "  console.log(`OLD-SHAPE after ${Date.now() - t0} ms: ${e.replace(/\\s+/g, \" \").trim()}`);",
        "  await prisma.$disconnect();",
        "}",
        "main();",
        "",
      ].join("\n"));
      if (!/import \{ prisma \} from "@\/lib\/prisma"/.test(src)) throw new Error("comment-only.ts no longer imports @/lib/prisma statically; update the A9 control");
      const r = await launch({ args: [TSX, "--require", oldPreload, control], env: env(), timeoutS: 120, witness: true });
      const text = r.out + r.err;
      const m = /OLD-SHAPE after (\d+) ms: (.*)/.exec(text);
      const ms = m ? Number(m[1]) : -1;
      const reached = !!m && /Can't reach database server at `?203\.0\.113\.10:5432/.test(m[2]);
      const ok = reached && ms >= 1000 && r.sockets.length > 0 && !r.err.includes(iso.BANNER);
      rows.push({
        label: "A9 OLD shape (no boundary)",
        verdict: ok ? "PASS" : "FAIL",
        seconds: r.seconds,
        note: ok ? `really tried: P1001 on 203.0.113.10:5432 after ${ms} ms · lsof saw ${r.sockets.length} socket line(s)` : `expected a real attempt: ${m ? m[2].slice(0, 160) : lastLines(text)} · lsof lines ${r.sockets.length}`,
        log: save("old-shape", r),
      });
      printRow(rows[rows.length - 1]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // A9b: the OLD harness fence against pg's socket shape. HEAD's _harness.ts
  // (git show), its fenceFetch() up, no boundary: net.connect is caught, but
  // `new net.Socket().connect(port, host)` — what pg does — goes straight out
  // (the witness sees the SYN to TEST-NET-3), and the fence never knew.
  {
    const dir = fs.mkdtempSync(path.join(REPO, "node_modules", ".cache", "rtp-isolation-old-"));
    try {
      fs.writeFileSync(path.join(dir, "_harness.1075a5b.ts"), execFileSync("git", ["show", "1075a5b:scripts/_drill/_harness.ts"], { cwd: REPO, encoding: "utf8" }));
      const control = path.join(dir, "old-fence.ts");
      fs.writeFileSync(control, [
        "// Generated by run-all --boundary: the 1075a5b harness fence, and pg's socket shape.",
        'import net from "node:net";',
        'import { fenceFetch } from "./_harness.1075a5b";',
        "const fence = fenceFetch();",
        "const viaConnect = net.connect(5432, \"203.0.113.10\");",
        "viaConnect.on(\"error\", (e) => console.log(`OLD-FENCE net.connect: ${e.message}`));",
        "const s = new net.Socket();",
        "s.on(\"error\", (e) => { console.log(`OLD-FENCE pg-shape: error ${e.message} · blocked=${fence.blocked.length}`); process.exit(0); });",
        "s.setTimeout(2500, () => { console.log(`OLD-FENCE pg-shape: still connecting after 2.5 s — it went out · blocked=${fence.blocked.length}`); s.destroy(); process.exit(0); });",
        "s.connect(5432, \"203.0.113.10\");",
        "",
      ].join("\n"));
      const r = await launch({ args: [TSX, control], env: env(), timeoutS: 60, witness: true });
      const text = r.out + r.err;
      const caught = /OLD-FENCE net\.connect: OUTBOUND BLOCKED BY DRILL: tcp:\/\/203\.0\.113\.10:5432/.test(text);
      const m = /OLD-FENCE pg-shape: (.*) · blocked=(\d+)/.exec(text);
      // Not refused by the fence, and the fence counted only net.connect. (A
      // network that answers "no route" at once is still the socket going out.)
      const wentOut = !!m && !/OUTBOUND BLOCKED/.test(m[1]) && m[2] === "1" && (r.sockets.length > 0 || /EHOSTUNREACH|ENETUNREACH/.test(m[1]));
      rows.push({
        label: "A9b OLD harness fence (no boundary)",
        verdict: caught && wentOut ? "PASS" : "FAIL",
        seconds: r.seconds,
        note: caught && wentOut ? `net.connect caught, pg's new Socket().connect NOT: it went out (lsof ${r.sockets.length} line(s)) and the fence counted only the first` : `expected the old hole: ${lastLines(text)} · lsof ${r.sockets.length}`,
        log: save("old-fence", r),
      });
      printRow(rows[rows.length - 1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // A9c: the FIRST R06 boundary (c52d4a2), the one the second review tested,
  // and the six holes it found — each really going out to TEST-NET-3 with the
  // old boundary up (banner printed, role root). The witness must see a SYN
  // on every one of the six ports. The same shapes are refused, with no
  // socket seen, by A3 (late ?host=), A4 (datasourceUrl ?host=), A5 (string
  // ports), A6 (curl, env -i, the CLI --url ?host=, workers) and A10 above.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-isolation-first-"));
    try {
      fs.writeFileSync(path.join(tmp, "_isolation.cjs"), execFileSync("git", ["show", `${FIRST_BUILD}:scripts/_drill/_isolation.cjs`], { cwd: REPO, encoding: "utf8" }));
      fs.writeFileSync(path.join(tmp, "preload.cjs"), 'require("./_isolation.cjs").activate();\n');
      const control = path.join(tmp, "control.cjs");
      fs.writeFileSync(control, FIRST_BUILD_CONTROL);
      const r = await launch({ args: ["--require", path.join(tmp, "preload.cjs"), control, REPO], env: env(), timeoutS: 120, witness: true });
      const text = r.out + r.err;
      const said = (k) => { const m = new RegExp(`^OLD-BOUNDARY ${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m").exec(text); return m ? m[1] : "(missing)"; };
      const notRefused = (v) => v !== "(missing)" && !/DRILL ISOLATION|OUTBOUND BLOCKED/.test(v);
      const holes = [
        ["string ports", 6282, [0, 1, 2, 3].every((i) => notRefused(said(`port#${i}`)))],
        ["?host= through the engine guard", 6283, /Can't reach database server at `?203\.0\.113\.10:6283/.test(said("prisma ?host="))],
        ["a worker given { PATH }", 6284, /^NO BOUNDARY/.test(said("worker env {PATH}")) && notRefused(said("worker env {PATH}"))],
        ["curl handed a URL", 6285, /^started/.test(said("curl"))],
        ["env -i node", 6286, /^NO BOUNDARY/.test(said("env -i node")) && notRefused(said("env -i node"))],
        ["the Prisma CLI --url ?host=", 6287, notRefused(said("prisma cli ?host=")) && /203\.0\.113\.10:6287|P1001/.test(said("prisma cli ?host="))],
      ];
      const seen = (port) => r.sockets.some((l) => l.includes(`203.0.113.10:${port}`));
      const active = /^true role=root/.test(said("active")) && r.err.includes("[drill-isolation] on");
      const missed = holes.filter(([, port, reproduced]) => !reproduced || !seen(port)).map(([name, port, reproduced]) => `${name} (${reproduced ? "" : "not reproduced, "}${seen(port) ? "" : `no SYN on :${port}`})`);
      rows.push({
        label: `A9c FIRST boundary ${FIRST_BUILD} (six holes)`,
        verdict: active && !missed.length ? "PASS" : "FAIL",
        seconds: r.seconds,
        note: active && !missed.length ? `old boundary up, and all six went out: lsof saw a SYN on each of :6282-:6287 (${r.sockets.length} line(s))` : `${active ? "" : "old boundary not up · "}expected every hole to go out: ${missed.join("; ")}`,
        log: save("first-build-holes", r),
      });
      printRow(rows[rows.length - 1]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // B: the in-suite drill (unit rules, layering, a real boot, a child).
  for (const run of runsOf(path.join(DRILL_DIR, "isolation-boundary.ts"))) {
    const row = await runDrill(run, logDir);
    rows.push(row);
    printRow(row);
  }
  return rows;
}

// ---- main ------------------------------------------------------------------------------

async function main() {
  const logDir = opt.logs ? path.resolve(opt.logs) : fs.mkdtempSync(path.join(os.tmpdir(), "rtp-drills-"));
  fs.mkdirSync(logDir, { recursive: true });

  if (opt.boundary) {
    if (opt.list) { console.log("boundary: A1-A7 fixtures as roots, A10 a fixture copied outside scripts/_drill, A8/A8b without the preload, A9/A9b/A9c the old shapes (no boundary, the old harness fence, the first R06 boundary), then isolation-boundary.ts"); return; }
    console.log(`drill isolation boundary · logs in ${logDir}\n`);
    const rows = await runBoundary(logDir);
    return finish(rows, logDir);
  }

  const files = opt.files.length ? opt.files.map(drillFile) : allDrills();
  const runs = [];
  for (const f of files) runs.push(...runsOf(f));
  if (opt.list) {
    for (const r of runs) console.log(`${r.label.padEnd(40)} ${JSON.stringify(r.spec)}`);
    console.log(`${runs.length} runs from ${files.length} drills`);
    return;
  }
  console.log(`${runs.length} runs from ${files.length} drills · one at a time · logs in ${logDir}\n`);
  const rows = [];
  for (const run of runs) {
    const row = await runDrill(run, logDir);
    rows.push(row);
    printRow(row);
  }
  finish(rows, logDir);
}

function finish(rows, logDir) {
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${n("PASS")} passed · ${n("FAIL")} failed · ${n("SKIPPED")} skipped · ${n("RAN")} ran with no checks · logs in ${logDir}`);
  const failed = rows.filter((r) => r.verdict === "FAIL");
  for (const r of failed) console.log(`  FAIL ${r.label} — ${r.log || ""}`);
  const skipped = rows.filter((r) => r.verdict === "SKIPPED");
  for (const r of skipped) console.log(`  SKIPPED ${r.label} — ${r.note}`);
  if (skipped.length && !opt.allowSkips) console.log(`  ${skipped.length} run(s) did not run, so this is not a passing suite (--allow-skips accepts that).`);
  process.exitCode = suiteExitCode(rows, opt.allowSkips);
}

module.exports = { tally, tallies, drillVerdict, suiteExitCode };

if (AS_MAIN) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
