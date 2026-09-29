/* eslint-disable @typescript-eslint/no-require-imports -- loaded by `node --require` and NODE_OPTIONS: CommonJS by definition */
// ---------------------------------------------------------------------------
// THE DRILL ISOLATION BOUNDARY (R06, Sep 28 2026).
//
// WHY THIS FILE EXISTS. Until today "a drill cannot reach production" rested
// on three things, and none of them was a control:
//   · harness-selftest §H, a TEXT SCAN. A comment that said `bootDrillDb(`
//     passed it, and a drill that reached Prisma through an app import
//     (notify → @/lib/prisma) was not even counted as touching a database;
//   · the harness fence, which only drills that call fenceFetch() get. It
//     patched net.connect / createConnection / tls.connect but not the
//     `new net.Socket().connect()` pg uses, and let through any argument
//     shape it could not parse;
//   · nothing at all in front of Prisma's query engine. It is a native library
//     (process.dlopen) that opens its sockets in Rust, where no node:net fence
//     can see them, on whatever DATABASE_URL Prisma's own .env load gave it —
//     PRODUCTION, for a drill that never booted a database. Five pure drills
//     already built a client on it and were safe only because they happened
//     not to query.
//
// So the boundary moves to the RUNNER: _drill-preload.cjs loads this file
// before the drill or any app module, and every process descended from a
// drill loads it again through NODE_OPTIONS.
//
// WHO IS ISOLATED (second review, Sep 28 2026 eve): EVERY process that loads
// the preload — the ROOT — unless its entry script is one of the few that
// load it on purpose without being drills (EXEMPT: scripts/_live, _recon,
// _probe, _fix and demo, in any checkout, and create-test-client), and every
// process started from a root, which inherits RTP_DRILL_ISOLATION=1 — a
// DESCENDANT. It used to be the other way round (isolated only under THIS
// checkout's scripts/_drill/), so a drill copied anywhere else — a scratchpad,
// scripts/_drill_head/, another worktree's preload — ran with the preload and
// no boundary, and Prisma's .env load gave it production. The live probes
// still run exactly as they did.
//
// WHAT IT DOES, before the first app import:
//   a. DATABASE_URL / DIRECT_URL / SHADOW_DATABASE_URL become a loopback
//      SENTINEL that cannot connect (127.0.0.1:9), until bootDrillDb points
//      them at the drill's own 127.0.0.1 database. A root takes the sentinel
//      whatever it was handed (a caller's shell cannot lend it a database);
//      only a descendant drill keeps the 127.0.0.1 database its parent booted.
//      Every .env key and every provider key the app reads is set to "" first
//      (the root overwrites; a descendant only fills what is missing, so a
//      parent and its child still agree on APP_SECRET). Prisma's .env
//      self-load never overwrites a key that is already set, even to ""
//      (runtime/library.js dotenv populate; the CLI has the same guard), so it
//      can restore nothing.
//   b. A socket fence at net.Socket.prototype.connect — the one call every
//      TCP and TLS client reaches: net.connect, tls.connect (TLSSocket does
//      not override it), http(s) agents, undici/fetch, http2 and pg's
//      `new net.Socket().connect(port, host)`. It reads the arguments with
//      Node's OWN normalizer (net._normalizeArgs), so a port string Node takes
//      as a number ("5432\n", " 5432", "0x1538", "5432.0") is a TCP port here
//      too, not a pipe name. A non-loopback host is refused before any DNS
//      lookup. globalThis.fetch is wrapped too, only so the refusal reads well.
//   c. A Prisma ENGINE guard. The query engine library is wrapped as it is
//      dlopen'ed; an engine whose datasource is not 127.0.0.1 is built on the
//      sentinel instead and refuses every connect and query with a message
//      that says why. "Is 127.0.0.1" means EVERY host the URL can reach: the
//      authority AND each `host` / `hostaddr` query value, which Prisma and
//      libpq let override it (`@127.0.0.1:6301/db?host=203.0.113.10` goes to
//      203.0.113.10 — the second review reproduced exactly that). The check
//      reads the same env object the engine snapshots at construction, and
//      the URL it approved is handed to the engine as an explicit override, so
//      nothing can change between check and use. DATABASE_URL set late,
//      new PrismaClient({ datasourceUrl }), a dotenv override — all end here.
//      Engines built earlier on loopback keep working (cp15 changes the env
//      var for a moment on purpose).
//   d. Children and workers: spawn / exec / execFile / fork, the three *Sync
//      calls and worker_threads.Worker all hand on the marker, the sentinel
//      for any empty database key, the .env keys, and this file in
//      NODE_OPTIONS (and in a worker's own execArgv) — so a drill that
//      REPLACES NODE_OPTIONS (c1, c2, a02 do), or gives a worker `env: {}`,
//      still passes the boundary down. Node programs fence themselves. Any
//      OTHER program is native code (b) and (c) cannot see, so it is judged
//      on what it is HANDED: refused if its arguments carry a URL, a
//      --host / -h value, or a host= / hostaddr= conninfo for a host that is
//      not loopback, or its environment a PGHOST / PGHOSTADDR / PGSERVICE
//      that could route it anywhere (a database client, also any database URL
//      in its environment). A shell's -c string (-lc, -ec… too) and an `env`
//      or `nohup`-style wrapper are judged by the commands they run; `env -i`,
//      or unsetting the marker or NODE_OPTIONS, is refused.
//   e. The Prisma CLI, when a drill runs it (`npx prisma db push` from
//      bootDrillDb): refused outright against a non-loopback URL in its env
//      or its --url flags, before it can start its engine.
//
// WHAT IT DOES NOT COVER: dgram and DNS lookups, process.binding, other
// native addons, a native program that finds a host on its own (a config
// file, a shell SCRIPT file that runs a database client), deliberate evasion.
// Native programs are only checked for the hosts they are handed. It stops
// accidents — the Sep 28 kind, where a builder ran a file believing it was
// isolated — not an adversary. Node 16-safe syntax on purpose: a descendant
// may be any Node on the PATH.
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const Module = require("module");

const KEY = Symbol.for("rtp.drillIsolation");
const GUARDED = Symbol.for("rtp.drillIsolation.guardedEngine");
const GUARDED_WORKER = Symbol.for("rtp.drillIsolation.guardedWorker");
const MARKER = "RTP_DRILL_ISOLATION";
const SENTINEL_URL = "postgresql://drill-isolation:no-database@127.0.0.1:9/no_drill_database_booted?sslmode=disable&connect_timeout=1";
const DB_KEYS = ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"];
const BANNER = "[drill-isolation] on · database: sentinel until booted · sockets + Prisma: 127.0.0.1 only · Node children and workers inherit · native programs: checked only for the hosts they are handed";
const NO_DATABASE =
  "DRILL ISOLATION: this drill has no database — DATABASE_URL is still the isolation sentinel. Call bootDrillDb() (or pin a 127.0.0.1 URL) before the first query.";

function realpathOr(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const SELF = __filename;
const DRILL_DIR = realpathOr(__dirname);
const REPO = realpathOr(path.resolve(__dirname, "..", ".."));
const RUNNER = path.join(DRILL_DIR, "run-all.cjs");
// What counts as a DRILL (drillEntry): anything under a scripts/_drill/ folder
// of ANY checkout, and the tools that exist only to boot a throwaway database
// (restore-rehearsal restores a backup FILE into one). A drill descendant
// keeps only a 127.0.0.1 database; any other descendant keeps what it was
// passed and is judged where it uses it.
const DRILL_PATH = /[\\/]scripts[\\/]_drill[\\/]/;
const ISOLATED_TOOLS = /[\\/]scripts[\\/]restore-rehearsal\.ts$/;
// The scripts that load _drill-preload.cjs ON PURPOSE without being drills
// (grep, Sep 28 eve): the scripts/_live, _recon, _probe and _fix probes that
// must reach production, the demo (its own 127.0.0.1 database, its own
// fence) and create-test-client. A path SEGMENT in any checkout — a
// worktree's scripts/_live is as live as the main tree's. Nothing else is
// exempt: a script that loads the preload and is not on this list is a root.
const EXEMPT = [/[\\/]scripts[\\/](_live|_recon|_probe|_fix|demo)[\\/]/, /[\\/]scripts[\\/]create-test-client\.ts$/];
// Launchers that load the preload only because it is in NODE_OPTIONS
// (scripts/_fix/R07/probe-ledger.ts runs that way): npx, npm and tsx's own CLI
// start the real script, which is judged on its own entry. Exactly these —
// not "anything in node_modules", where a copied drill could hide.
const LAUNCHERS = /[\\/]node_modules[\\/](npm[\\/]bin[\\/](npx|npm)-cli\.js|tsx[\\/]dist[\\/]cli\.m?js)$/;

// Provider keys the app reads (grep of src/ for process.env, Sep 28), blanked
// with the .env keys: a key missing from a checkout's .env is still a key a
// caller's shell may export.
const PROVIDER_KEYS = [
  "BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN_LEGACY", "REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN",
  "DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_MAPS_API_KEY",
  "SLACK_SIGNING_SECRET", "STRIPE_WEBHOOK_SECRET", "SCRIPTING_BASE_URL", "SCRIPTING_API_KEY", "SCRIPTING_WEBHOOK_SECRET",
  "QBO_ENV", "QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_SANDBOX_CLIENT_ID", "QBO_SANDBOX_CLIENT_SECRET",
  "META_APP_ID", "META_APP_SECRET", "FRAMEIO_CLIENT_ID",
];
// The same stand-ins pinDrillUrl has always set: signing still has to round-trip.
const STAND_INS = {
  APP_SECRET: "drill-app-secret-not-a-real-key-0123456789abcdef",
  NEXT_PUBLIC_APP_URL: "https://drill.invalid",
  CRON_SECRET: "drill-secret",
};
// libpq's own routing and credentials: a caller's shell must not lend a
// native child of the drill a host or a password (see (d)).
const PG_ENV = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"];
const DELETE_AT_ROOT = ["AUTH_ENFORCE", "SLACK_ALERT_CHANNEL", "VERCEL"].concat(PG_ENV);
// Would move Prisma off the dlopen'ed library engine the guard wraps.
const ENGINE_OVERRIDES = ["PRISMA_CLIENT_ENGINE_TYPE", "PRISMA_QUERY_ENGINE_LIBRARY", "PRISMA_QUERY_ENGINE_BINARY"];

// ---- names, hosts and URLs --------------------------------------------------

let keyCache = null;
/** Names (never values) of every key in the .env files Prisma or Next could
 *  load for this checkout: the repo's, prisma/'s, and the one the GENERATED
 *  CLIENT loads — it resolves "../../../.env" from its own REAL location
 *  (node_modules/.prisma/client/index.js, relativeEnvPaths), so in a git
 *  worktree whose node_modules (or .prisma) is a symlink that is the MAIN
 *  tree's .env, not this checkout's. */
function dotEnvKeyNames() {
  if (keyCache) return keyCache.slice();
  const client = realpathOr(path.join(REPO, "node_modules", ".prisma", "client"));
  const dirs = [REPO, path.join(REPO, "prisma"), path.resolve(client, "..", "..", ".."), path.dirname(realpathOr(path.join(REPO, "node_modules")))];
  const names = new Set();
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    let list = [];
    try { list = fs.readdirSync(dir); } catch { continue; }
    for (const f of list) {
      if (!/^\.env(\..+)?$/.test(f)) continue;
      let text = "";
      try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
      const re = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
      let m;
      while ((m = re.exec(text))) names.add(m[1]);
    }
  }
  keyCache = Array.from(names);
  return keyCache.slice();
}

/** Every key a drill must not inherit a real value for, database keys aside. */
function secretKeyNames() {
  const out = new Set(dotEnvKeyNames().concat(PROVIDER_KEYS));
  for (const k of DB_KEYS) out.delete(k);
  return Array.from(out);
}

function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true; // Node's default host is localhost
  const h = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function parseUrl(url) {
  try { return new URL(String(url)); } catch { return null; }
}

function isSentinelUrl(url) {
  const u = parseUrl(url);
  return !!u && u.hostname === "127.0.0.1" && u.port === "9" && u.pathname === "/no_drill_database_booted";
}

/** Every host a database URL can connect to, or null when it does not parse:
 *  the authority's, then each value of a `host` or `hostaddr` query parameter
 *  (any case, comma lists split). Prisma's engine (tokio-postgres) and libpq
 *  both let those OVERRIDE the authority for the TCP connection, so reading
 *  only `new URL(u).hostname` let
 *  `postgresql://u@127.0.0.1:6301/db?host=203.0.113.10` past every check here
 *  while the engine and the schema engine connected to 203.0.113.10 (second
 *  review, Sep 28 eve: SYN_SENT seen by lsof, three ways). */
function dbHostsOf(url) {
  const u = parseUrl(url);
  if (!u) return null;
  const hosts = [u.hostname];
  u.searchParams.forEach((value, key) => {
    if (/^host(addr)?$/i.test(key)) for (const h of String(value).split(",")) hosts.push(h.trim());
  });
  return hosts;
}

/** True when every host the URL can reach is exactly 127.0.0.1 — the rule
 *  for a drill's database (not localhost by name, not a unix socket). */
function onlyLoopbackIp(url) {
  const hosts = dbHostsOf(url);
  return !!hosts && hosts.every((h) => h === "127.0.0.1");
}

/** A database a drill may use: on 127.0.0.1, and not the sentinel. */
function isDrillDbUrl(url) {
  return !!url && onlyLoopbackIp(url) && !isSentinelUrl(url);
}

/** The one check that stands between a schema push and production (moved
 *  here from _harness.ts, which re-exports it; since Sep 28 eve it reads the
 *  host / hostaddr parameters too). */
function assertLoopbackDbUrl(url) {
  const hosts = dbHostsOf(url);
  const bad = hosts ? hosts.find((h) => h !== "127.0.0.1") : undefined;
  if (!hosts || bad !== undefined) {
    throw new Error(`refusing to push a schema to ${!hosts ? "an unparsable URL" : bad || "an empty host"}: a drill database must be 127.0.0.1`);
  }
}

/** "host:port" for messages — the first host that is not 127.0.0.1 (the one
 *  a refusal is about), never the credentials. */
function whereOf(url) {
  const u = parseUrl(url);
  if (!u) return "an unparsable URL";
  const bad = (dbHostsOf(url) || []).find((h) => h !== "127.0.0.1");
  const host = bad === undefined ? u.hostname : bad;
  const port = String(u.searchParams.get("port") || "").split(",")[0].trim() || u.port || "5432";
  return `${host || "(no host)"}:${port}`;
}

// ---- who is running ---------------------------------------------------------

function isRunner(entry) {
  return DRILL_PATH.test(entry) && path.basename(entry) === "run-all.cjs";
}

/** The entry is a drill (see DRILL_PATH). */
function isDrillPath(entry) {
  return !!entry && !isRunner(entry) && (DRILL_PATH.test(entry) || ISOLATED_TOOLS.test(entry));
}

/** Loads the preload on purpose and must be left alone (see EXEMPT, LAUNCHERS). */
function isExempt(entry) {
  return EXEMPT.some((re) => re.test(entry)) || LAUNCHERS.test(entry) || isRunner(entry);
}

/** Pure, so the self-test can walk the truth table. Called only in a process
 *  that loaded the preload (or inherited the marker). */
function decide(opts) {
  const o = opts || {};
  const entry = o.entry || null;
  const env = o.env || {};
  const drillEntry = isDrillPath(entry);
  if (env[MARKER] === "1") return { role: "descendant", drillEntry };
  // No script (node -e, stdin, a worker) and no marker: nothing to judge by.
  if (!entry || isExempt(entry)) return { role: "inactive", drillEntry: false };
  return { role: "root", drillEntry };
}

/** The script this process runs, as a real path; null for `node -e/-p`, stdin
 *  and worker threads (argv[1] there is not a script). Node has already made
 *  argv[1] absolute by the time --require preloads run. */
function entryOf() {
  let isMain = true;
  try { isMain = require("worker_threads").isMainThread; } catch { /* no workers: main */ }
  if (!isMain) return null;
  const ea = process.execArgv || [];
  if (ea.some((a) => /^(-e|--eval|-p|--print|-pe|-ep)$/.test(a) || /^--(eval|print)=/.test(a))) return null;
  const a1 = process.argv[1];
  if (!a1 || a1 === "-") return null;
  return realpathOr(path.resolve(a1));
}

// ---- the environment ---------------------------------------------------------

function withIsolationRequire(nodeOptions) {
  const cur = nodeOptions || "";
  if (cur.indexOf(SELF) !== -1) return cur;
  // Quoted: the repo folder has spaces, and NODE_OPTIONS splits on them.
  return (cur ? cur + " " : "") + "--require " + JSON.stringify(SELF);
}

function markDescendants(env) {
  for (const k of ENGINE_OVERRIDES) delete env[k];
  env.CHECKPOINT_DISABLE = "1"; // Prisma CLI telemetry: an unfenced call until now
  env.PRISMA_HIDE_UPDATE_MESSAGE = "1";
  env.npm_config_update_notifier = "false";
  // @vercel/blob retries a failed request 10 times with exponential backoff
  // (~17 minutes a call). A refused connection must fail fast, not look like
  // a flaky network: cut-store-prune, whose del() calls used to reach the real
  // Vercel Blob API with a fake token and get a quick 4xx, hung for 10
  // minutes the first time it ran inside the boundary.
  if (env.VERCEL_BLOB_RETRIES === undefined) env.VERCEL_BLOB_RETRIES = "0";
  env[MARKER] = "1";
  env.NODE_OPTIONS = withIsolationRequire(env.NODE_OPTIONS);
}

function pinOwnEnv(env, role, drillEntry) {
  for (const k of DB_KEYS) {
    if (role === "root") {
      // A root is handed NO database, not even a 127.0.0.1 one from the
      // caller's shell (a local tunnel or proxy to Neon would sit on
      // 127.0.0.1 too). runDrillChild's children are descendants, so nothing
      // legitimate arrives here; bootDrillDb sets its own.
      env[k] = SENTINEL_URL;
    } else if (drillEntry) {
      // A drill descendant keeps only the loopback database its parent booted.
      if (!isDrillDbUrl(env[k])) env[k] = SENTINEL_URL;
    } else if (!env[k]) {
      // Anything else started by a drill keeps what the drill passed — it is
      // judged where it is used (c, d, e) — and gets the sentinel, never
      // Prisma's .env, when it was passed nothing.
      env[k] = SENTINEL_URL;
    }
  }
  const names = secretKeyNames();
  if (role === "root") {
    for (const k of names) env[k] = "";
    for (const k of Object.keys(STAND_INS)) env[k] = STAND_INS[k];
    for (const k of DELETE_AT_ROOT) delete env[k];
  } else {
    for (const k of names) if (env[k] === undefined) env[k] = "";
  }
  markDescendants(env);
}

/** The environment a child of an isolated process starts with. */
function repinChildEnv(env) {
  const out = Object.assign({}, env || {});
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  for (const k of DB_KEYS) if (!out[k]) out[k] = SENTINEL_URL;
  for (const k of secretKeyNames()) if (out[k] === undefined) out[k] = "";
  markDescendants(out);
  return out;
}

// ---- bookkeeping ---------------------------------------------------------------

function holder() {
  return globalThis[KEY] || null;
}

function record(h, entry) {
  h.blocked.push(entry);
  for (const fn of Array.from(h.listeners)) {
    try { fn(entry); } catch { /* a listener's fault is not the fence's */ }
  }
}

function publicState(h) {
  if (!h) return { active: false, role: "inactive", entry: null, drillEntry: false, blocked: [] };
  return { active: true, role: h.role, entry: h.entry, drillEntry: h.drillEntry, blocked: h.blocked.slice() };
}

// ---- (b) the socket fence -----------------------------------------------------------

// net.js tags the [options, cb] pair it has already normalized with a private
// symbol; the only way to see it is on a pair it made.
const NORMALIZED = (() => {
  try { return Object.getOwnPropertySymbols(net._normalizeArgs([]))[0] || null; } catch { return null; }
})();

/** The arguments exactly as Socket.prototype.connect will read them: Node's
 *  own normalizer, so the fence and the connect can never disagree. The old
 *  hand-written reading took any string port that was not all digits for a
 *  pipe name, while Node takes a string as a pipe only when
 *  `!(Number(s) >= 0)` — so "6302\n", " 6302", "0x18be" and "6302.0" (a port
 *  read from a file or an env var with a trailing newline is enough) went
 *  straight out as TCP (second review, Sep 28 eve: 4 SYN_SENT, blocked=0). */
function normalizeConnectArgs(args) {
  if (Array.isArray(args[0]) && NORMALIZED && args[0][NORMALIZED]) return args[0];
  if (typeof net._normalizeArgs === "function") return net._normalizeArgs(args);
  // A Node without the export: the same rule, spelled out (net.js).
  const a = args[0];
  if (a !== null && typeof a === "object") return [a, null];
  if (typeof a === "string" && !(Number(a) >= 0)) return [{ path: a }, null];
  const o = { port: a };
  if (args.length > 1 && typeof args[1] === "string") o.host = args[1];
  return [o, null];
}

/** What Socket.prototype.connect was asked for. A truthy `path` is a unix
 *  socket — local by definition (http nulls the request path before it gets
 *  here). Node connects to `options.host || "localhost"`; `hostname` is read
 *  too, and a remote one refused, to be safe. */
function connectTarget(args) {
  const o = (normalizeConnectArgs(args) || [])[0] || {};
  if (o.path) return { local: true };
  const hosts = [o.host, o.hostname].filter((x) => x !== undefined && x !== null && x !== "");
  const remote = hosts.find((x) => !isLoopbackHost(x));
  return { host: remote !== undefined ? remote : hosts[0] || "localhost", port: o.port, options: o };
}

function noop() {}

function installSocketFence(h) {
  const tls = require("tls");
  const proto = net.Socket.prototype;
  const realConnect = proto.connect;
  proto.connect = function isolatedConnect() {
    const args = Array.prototype.slice.call(arguments);
    const t = connectTarget(args);
    if (t.local) return realConnect.apply(this, args);
    if (isLoopbackHost(t.host)) {
      // "localhost" with a caller's own lookup could resolve anywhere: the
      // answer must be loopback too.
      const o = t.options;
      if (o && typeof o.lookup === "function" && !net.isIP(String(t.host).replace(/^\[|\]$/g, ""))) {
        const lookup = o.lookup;
        o.lookup = function (hostname, lo, cb) {
          const done = typeof lo === "function" ? lo : cb;
          const opts = typeof lo === "function" ? {} : lo;
          return lookup.call(this, hostname, opts, function (err, address) {
            const list = Array.isArray(address) ? address.map((x) => x.address) : [address];
            if (!err && list.some((x) => !isLoopbackHost(x))) {
              const where = `tcp://${hostname}->${list.join(",")}`;
              record(h, where);
              return done(new Error(`OUTBOUND BLOCKED BY DRILL ISOLATION: ${where}`));
            }
            return done.apply(this, arguments);
          });
        };
      }
      return realConnect.apply(this, args);
    }
    const scheme = this instanceof tls.TLSSocket ? "tls" : "tcp";
    const where = `${scheme}://${String(t.host).indexOf(":") !== -1 && String(t.host)[0] !== "[" ? `[${t.host}]` : t.host}:${t.port === undefined || t.port === null ? "" : String(t.port).trim()}`;
    record(h, where);
    // Look like a connection still being made: http writes its request
    // before the error lands, and on an idle socket that write would fail
    // first with "Socket is closed", hiding the reason (as _harness.ts does).
    this.connecting = true;
    // Our own listener, so a library that never listens cannot crash the drill.
    this.on("error", noop);
    const err = new Error(`OUTBOUND BLOCKED BY DRILL ISOLATION: ${where}`);
    err.code = "EDRILLISOLATION";
    setImmediate(() => this.destroy(err));
    return this;
  };
}

function installFetchFence(h) {
  const prev = globalThis.fetch;
  if (typeof prev !== "function") return;
  globalThis.fetch = function isolatedFetch(input, init) {
    let href = "";
    try { href = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url; } catch { href = ""; }
    const u = parseUrl(href);
    // Unparsable: fetch throws its own TypeError before any network, and the
    // socket fence is underneath either way.
    if (!u || u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "file:" || isLoopbackHost(u.hostname)) {
      return prev.call(this, input, init);
    }
    const where = `${u.protocol}//${u.host}${u.pathname}`; // never the query string: tokens live there
    record(h, where);
    return Promise.reject(new Error(`OUTBOUND BLOCKED BY DRILL ISOLATION: ${where}`));
  };
}

// ---- (c) the Prisma engine guard -----------------------------------------------------

/** The datasource block of the schema the engine is built from. */
function datasourceOf(datamodel) {
  const m = /datasource\s+(\w+)\s*\{([^}]*)\}/.exec(String(datamodel || ""));
  const body = m ? m[2] : "";
  const u = /(^|\s)url\s*=\s*(?:env\(\s*"([^"]+)"\s*\)|"([^"]*)")/.exec(body);
  return {
    name: m ? m[1] : "db",
    envVar: u ? u[2] || null : "DATABASE_URL",
    literal: u && u[3] !== undefined ? u[3] : null,
  };
}

/** Pure: may an engine with this config open its datasource? */
function judgeEngineConfig(config, adapter) {
  // A driver adapter connects through JavaScript sockets, which (b) fences.
  if (adapter) return { ok: true, config };
  const c = config || {};
  const ds = datasourceOf(c.datamodel);
  const overrides = c.datasourceOverrides || {};
  const url = overrides[ds.name] ? overrides[ds.name] : ds.envVar ? (c.env || {})[ds.envVar] : ds.literal;
  if (!url || isSentinelUrl(url)) return { ok: false, name: ds.name, message: NO_DATABASE };
  // Every host the engine could reach, `?host=` / `?hostaddr=` included.
  if (!onlyLoopbackIp(url)) {
    const where = whereOf(url);
    return {
      ok: false,
      name: ds.name,
      blocked: `prisma://${where}`,
      message: `DRILL ISOLATION: refused a Prisma connection to ${where} — a drill may only open a database on 127.0.0.1 that it booted itself.`,
    };
  }
  const pinned = {};
  pinned[ds.name] = url;
  return { ok: true, config: Object.assign({}, c, { env: Object.assign({}, c.env), datasourceOverrides: Object.assign({}, overrides, pinned) }) };
}

// Everything that would open or use a connection. disconnect, free, trace,
// metrics and sdlSchema still work, so $disconnect() is clean.
const REFUSED_ENGINE_CALLS = new Set(["connect", "query", "startTransaction", "commitTransaction", "rollbackTransaction", "applyPendingMigrations"]);

function refusingEngine(inner, message) {
  const refuse = function () { return Promise.reject(new Error(message)); };
  return new Proxy(inner, {
    get(t, k) {
      if (REFUSED_ENGINE_CALLS.has(k)) return refuse;
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

function guardQueryEngineLibrary(lib, h) {
  const RealQueryEngine = lib.QueryEngine;
  function QueryEngine(config, logger, adapter) {
    const v = judgeEngineConfig(config, adapter);
    if (v.ok) return new RealQueryEngine(v.config, logger, adapter);
    if (v.blocked) record(h, v.blocked);
    // NOT a throw: Prisma builds the engine inside the PrismaClient
    // constructor's un-awaited instantiateLibrary(), so a throw there is an
    // unhandled rejection that kills a drill that never queried (every pure
    // drill importing app code). A real engine on the sentinel, refusing
    // every connection with the reason, fails where a connection would.
    const onSentinel = {};
    onSentinel[v.name] = SENTINEL_URL;
    const inner = new RealQueryEngine(Object.assign({}, config, { env: Object.assign({}, config && config.env), datasourceOverrides: onSentinel }), logger, adapter);
    return refusingEngine(inner, v.message);
  }
  QueryEngine.prototype = RealQueryEngine.prototype;
  // Prisma loads the library into its own writable { exports: {} } and reads
  // QueryEngine off it; N-API exports themselves may not be writable, so the
  // whole exports object is replaced rather than one property assigned.
  return new Proxy(lib, {
    get(t, k) {
      if (k === "QueryEngine") return QueryEngine;
      if (k === GUARDED) return true;
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

function installEngineGuard(h) {
  const realDlopen = process.dlopen;
  process.dlopen = function isolatedDlopen(mod) {
    const out = realDlopen.apply(process, arguments);
    const lib = mod && mod.exports;
    if (lib && typeof lib.QueryEngine === "function" && !lib[GUARDED]) mod.exports = guardQueryEngineLibrary(lib, h);
    return out;
  };
}

/** (e) `prisma db push/execute/migrate …` started by a drill. */
function guardPrismaCli(entry) {
  if (!entry || !/[\\/]node_modules[\\/]prisma[\\/]build[\\/]index\.js$/.test(entry)) return;
  const urls = [];
  for (const k of DB_KEYS) if (process.env[k]) urls.push(process.env[k]);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(url|from-url|to-url|shadow-database-url)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (m) urls.push(m[2] !== undefined ? m[2] : argv[i + 1] || "");
    else if (/^postgres(ql)?:\/\//i.test(argv[i])) urls.push(argv[i]);
  }
  // 127.0.0.1 exactly, as for a schema push (assertLoopbackDbUrl) — every
  // host, so `--url 'postgresql://u@127.0.0.1:6305/db?host=…'` is refused
  // (the schema engine followed the parameter to 203.0.113.10 before).
  const bad = urls.find((u) => !onlyLoopbackIp(u));
  if (bad === undefined) return;
  const cmd = argv.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ") || "(no command)";
  process.stderr.write(`DRILL ISOLATION: refused prisma ${cmd} against ${whereOf(bad)} — a drill may only run the Prisma CLI on 127.0.0.1.\n`);
  process.exit(1);
}

// ---- (d) children -------------------------------------------------------------------------

// WHY AN ALLOWLIST (second review, Sep 28 eve). The first version refused a
// child only when its NAME was on a list of database clients and a
// postgres:// URL for a remote host was in its argv or env. `psql -h host`, a
// `host=… dbname=…` conninfo, a `?host=` URL, PGHOSTADDR, `bash -lc`, an
// `env psql …` wrapper, curl, and `env -i node` (whose Node grandchild then
// ran with no boundary at all) all got through. Now:
//   · a NODE program may start with anything — it loads this file through
//     NODE_OPTIONS and fences its own sockets and Prisma engines;
//   · every OTHER program is native code the fence cannot see, and is judged
//     on what it is HANDED: refused if its arguments carry a URL, a
//     --host / -h value or a host= / hostaddr= conninfo for a host that is not
//     loopback, or its environment a remote PGHOST / PGHOSTADDR or any
//     PGSERVICE — a database client also for any database URL in its
//     environment (demo-smoke hands `bash run-demo-dev.sh` a hosted-LOOKING
//     DATABASE_URL on purpose; the script replaces it);
//   · a shell's -c string (any flag cluster with a c: -lc, -ec, -xc) and a
//     wrapper (env, nohup, nice, time, timeout, caffeinate, command, exec) are
//     judged by the commands they run, and `env -i`, `env -u` / `unset` of the
//     marker or NODE_OPTIONS, or a NODE_OPTIONS without this file, is refused:
//     it would start a Node program outside the boundary.
// The realpg server binaries (initdb, postgres) pass: they are handed only
// 127.0.0.1. A shell SCRIPT file is not read, only what it is handed.

const NODE_NAMES = /^(node|nodejs|npx|npm|tsx)$/;
const SHELL = /^(sh|bash|zsh|dash|ksh)$/;
const DB_CLIENT = /^(psql|pg_dump|pg_dumpall|pg_restore|pg_isready|pgbench|pg_basebackup|pg_receivewal|pg_recvlogical|pg_ctl|postgres|postmaster|initdb|createdb|dropdb|createuser|dropuser|vacuumdb|clusterdb|reindexdb|pgcli|(schema|query|migration)-engine[\w.-]*)$/;
// Programs whose `-h` names a HOST. Elsewhere `-h` is usually help or
// "human-readable" (du -h, sort -h), so it is read only for these.
const H_IS_HOST = /^(psql|pg_dump|pg_dumpall|pg_restore|pg_isready|pgbench|pg_basebackup|pg_receivewal|pg_recvlogical|createdb|dropdb|createuser|dropuser|vacuumdb|clusterdb|reindexdb|pgcli|mysql|mysqldump|mariadb|redis-cli|mongo|mongosh|mongodump|mongorestore)$/;
const ANY_URL = /\b([a-z][a-z0-9+.-]*):\/\/[^\s'"`<>]*/gi;
const DB_URL = /\bpostgres(?:ql)?:\/\/[^\s'"`<>]*/gi;
const CONNINFO_HOST = /(?:^|\s)(host|hostaddr)\s*=\s*(?:'((?:\\.|[^'\\])*)'|([^\s']*))/gi;
// Wrappers that run the program after their own options, and which of those
// options take a value.
const WRAPPERS = { nohup: [], nice: ["-n", "--adjustment"], time: [], timeout: ["-s", "-k", "--signal", "--kill-after"], caffeinate: ["-t", "-w"], command: [], exec: ["-a"], stdbuf: ["-i", "-o", "-e"] };
const SHELL_KEYWORDS = /^(if|then|else|elif|fi|do|done|while|until|for|in|case|esac|select|function|!|\{|\}|\[\[|\]\])$/;
// Builtins that start nothing and open nothing.
const INERT_BUILTINS = /^(echo|printf|test|\[|cd|pwd|true|false|:|set|shift|wait|trap|read|exit|return|umask|type|hash|alias|unalias|jobs|let|getopts|shopt|break|continue)$/;
const MAX_DEPTH = 8;
const OK = { ok: true };

function refuseChild(prog, why) {
  return { ok: false, message: `DRILL ISOLATION: refused to start ${prog} — ${why}. Native programs are not fenced: a drill may hand them only a loopback host, and never a way out of the boundary.` };
}

let execReal = null;
/** Node itself, or a script Node runs (its #! line names node). A bare name
 *  is looked up on the PATH the program will get: `npx prisma …` runs
 *  `sh -c "prisma …"` with node_modules/.bin on it, and that prisma is Node
 *  (which then refuses a remote --url itself, (e)). */
function isNodeProgram(file, env) {
  const f = String(file || "");
  if (NODE_NAMES.test(path.basename(f))) return true;
  if (f.indexOf("/") === -1 && f.indexOf("\\") === -1) {
    const dirs = String((env && env.PATH) || process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, f);
      try { if (fs.statSync(candidate).isFile()) return isNodeProgram(candidate, env); } catch { /* not in this directory */ }
    }
    return false;
  }
  const real = realpathOr(f);
  if (execReal === null) execReal = realpathOr(process.execPath);
  if (real === execReal) return true;
  let head = "";
  try {
    const fd = fs.openSync(real, "r");
    try {
      const buf = Buffer.alloc(256);
      head = buf.slice(0, fs.readSync(fd, buf, 0, 256, 0)).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  return /^#![^\n]*\bnode(js)?\b/.test(head);
}

/** "a, b" host lists: blanks and unix-socket directories ("/tmp") dropped. */
function hostList(value) {
  return String(value === undefined || value === null ? "" : value).split(",").map((h) => h.trim()).filter((h) => h && h[0] !== "/");
}

/** The non-loopback hosts a URL can reach (authority and host / hostaddr). */
function remoteHostsOfUrl(url) {
  const u = parseUrl(url);
  if (!u) return ["an unparsable URL"];
  if (u.protocol === "file:") return [];
  const hosts = dbHostsOf(url);
  return [hosts[0]].concat(hostList(hosts.slice(1).join(","))).filter((h) => !isLoopbackHost(h));
}

/** What a native program is handed that points it at a host that is not
 *  loopback, as phrases for the refusal (empty = nothing). */
function handedHosts(prog, args, env) {
  const out = [];
  const remote = (h) => `${h}, which is not loopback`;
  const add = (how, hosts) => { for (const h of hosts) if (!isLoopbackHost(h)) out.push(`${how}${remote(h)}`); };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    for (const url of a.match(ANY_URL) || []) for (const h of remoteHostsOfUrl(url)) out.push(`a URL for ${remote(h)}`);
    CONNINFO_HOST.lastIndex = 0;
    let m;
    while ((m = CONNINFO_HOST.exec(a))) add(`${m[1].toLowerCase()}=`, hostList(m[2] !== undefined ? m[2] : m[3]));
    const long = /^--(host|hostaddr)(?:=([\s\S]*))?$/.exec(a);
    if (long) add(`--${long[1]} `, hostList(long[2] !== undefined ? long[2] : args[i + 1]));
    const short = H_IS_HOST.test(prog) ? /^-h([\s\S]*)$/.exec(a) : null;
    if (short) add("-h ", hostList(short[1] || args[i + 1]));
  }
  const e = env || {};
  for (const k of ["PGHOST", "PGHOSTADDR"]) add(`${k}=`, hostList(e[k]));
  for (const k of ["PGSERVICE", "PGSERVICEFILE"]) if (e[k]) out.push(`${k} — a service definition can name any host`);
  if (DB_CLIENT.test(prog)) {
    for (const k of Object.keys(e)) {
      for (const url of String(e[k] || "").match(DB_URL) || []) for (const h of remoteHostsOfUrl(url)) out.push(`${k}, a database URL for ${remote(h)}`);
    }
  }
  return out;
}

/** Would setting (value) or unsetting (undefined) this variable start Node
 *  outside the boundary? The reason, or null. */
function protectionBreach(name, value) {
  if (name === MARKER && value !== "1") return `would ${value === undefined ? "unset" : "change"} ${MARKER}, so a Node program it starts would run outside the boundary`;
  if (name === "NODE_OPTIONS" && (value === undefined || String(value).indexOf(SELF) === -1)) {
    return "would start Node with a NODE_OPTIONS that does not load the isolation boundary (set NODE_OPTIONS in spawn's env option instead: the boundary appends itself there)";
  }
  return null;
}

// ---- a shell -c string, read well enough to see which program runs --------

function matchParen(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "'") { const k = s.indexOf("'", j + 1); if (k === -1) return s.length; j = k; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return s.length;
}

/** A command string split the way sh would into simple commands of words —
 *  quotes removed, each word a list of literal strings and { v, d } variable
 *  references ($NAME, ${NAME:-d}, $0…$9, $@) expanded later against the
 *  environment in force. $( ) and ` ` are commands of their own; a
 *  redirection's target is dropped. Not a shell: enough to judge. */
function shellCommands(src) {
  const s = String(src || "");
  const cmds = [];
  let words = [];
  let word = null;
  let dropNext = false;
  const lit = (t) => { if (word === null) word = []; word.push(t); };
  const endWord = () => {
    if (word !== null) { if (!dropNext) words.push(word); else dropNext = false; word = null; }
  };
  const endCmd = () => { endWord(); dropNext = false; if (words.length) cmds.push(words); words = []; };
  const sub = (text) => { for (const c of shellCommands(text)) cmds.push(c); if (word === null) word = []; };
  const dollar = (i) => {
    const n = s[i + 1];
    if (n === "(") { const close = matchParen(s, i + 1); sub(s.slice(i + 2, close)); return close + 1; }
    if (n === "{") {
      const j = s.indexOf("}", i + 2);
      const m = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])(?::?[-=+?]([\s\S]*))?/.exec(s.slice(i + 2, j === -1 ? s.length : j));
      if (word === null) word = [];
      word.push(m ? { v: m[1], d: m[2] } : "");
      return j === -1 ? s.length : j + 1;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|\d|[@*#?$!-])/.exec(s.slice(i + 1));
    if (!m) { lit("$"); return i + 1; }
    if (word === null) word = [];
    word.push({ v: m[1] });
    return i + 1 + m[1].length;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") { if (s[i + 1] !== "\n") lit(s[i + 1] || ""); i += 2; continue; }
    if (ch === "'") { const j = s.indexOf("'", i + 1); lit(s.slice(i + 1, j === -1 ? s.length : j)); i = j === -1 ? s.length : j + 1; continue; }
    if (ch === '"') {
      if (word === null) word = [];
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && '"\\$`\n'.indexOf(s[i + 1]) !== -1) { lit(s[i + 1]); i += 2; }
        else if (s[i] === "$") i = dollar(i);
        else if (s[i] === "`") { const j = s.indexOf("`", i + 1); sub(s.slice(i + 1, j === -1 ? s.length : j)); i = j === -1 ? s.length : j + 1; }
        else { lit(s[i]); i++; }
      }
      i++;
      continue;
    }
    if (ch === "$") { i = dollar(i); continue; }
    if (ch === "`") { const j = s.indexOf("`", i + 1); sub(s.slice(i + 1, j === -1 ? s.length : j)); i = j === -1 ? s.length : j + 1; continue; }
    if (ch === "#" && word === null) { const j = s.indexOf("\n", i); i = j === -1 ? s.length : j; continue; }
    if (ch === "<" || ch === ">") {
      // 2>&1, >>out, <<EOF, <in: the operator, then (unless it is &N) a target.
      if (word !== null && word.every((p) => typeof p === "string" && /^\d*$/.test(p))) word = null; // the fd number
      endWord();
      let j = i;
      while (j < s.length && "<>|".indexOf(s[j]) !== -1) j++;
      if (s[j] === "&") { j++; while (j < s.length && /[\d-]/.test(s[j])) j++; }
      else dropNext = true;
      i = j;
      continue;
    }
    if (";&|()\n".indexOf(ch) !== -1) { endCmd(); i++; continue; }
    if (/\s/.test(ch)) { endWord(); i++; continue; }
    lit(ch);
    i++;
  }
  endCmd();
  return cmds;
}

function expandWord(parts, env, positional) {
  return parts.map((p) => {
    if (typeof p === "string") return p;
    let v;
    if (/^\d+$/.test(p.v)) v = positional[Number(p.v)];
    else if (p.v === "@" || p.v === "*") v = positional.slice(1).join(" ");
    else if (/^[A-Za-z_]/.test(p.v)) v = env[p.v];
    if ((v === undefined || v === "") && p.d !== undefined) v = p.d;
    return v === undefined || v === null ? "" : String(v);
  }).join("");
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

function judgeCommandString(shell, cmd, env, positional, depth) {
  if (depth > MAX_DEPTH) return refuseChild(shell, "its command nests too deeply to judge");
  const shellEnv = Object.assign({}, env);
  for (const parts of shellCommands(cmd)) {
    const words = parts.map((w) => expandWord(w, shellEnv, positional));
    const v = judgeSimpleCommand(shell, words, shellEnv, positional, depth);
    if (!v.ok) return v;
  }
  return OK;
}

function judgeSimpleCommand(shell, words, shellEnv, positional, depth) {
  const local = {};
  let i = 0;
  for (; i < words.length; i++) {
    if (SHELL_KEYWORDS.test(words[i])) continue;
    const m = ASSIGNMENT.exec(words[i]);
    if (!m) break;
    const breach = protectionBreach(m[1], m[2]);
    if (breach) return refuseChild(shell, `\`${m[1]}=…\` ${breach}`);
    local[m[1]] = m[2];
  }
  if (i >= words.length) { Object.assign(shellEnv, local); return OK; }
  const prog = words[i];
  const rest = words.slice(i + 1);
  const env = Object.assign({}, shellEnv, local);
  if (/^(export|readonly|declare|typeset|local)$/.test(prog)) {
    const unexport = rest.indexOf("-n") !== -1;
    for (const w of rest) {
      if (w[0] === "-") continue;
      const m = ASSIGNMENT.exec(w);
      const name = m ? m[1] : w;
      const breach = protectionBreach(name, unexport ? undefined : m ? m[2] : shellEnv[name]);
      if (breach) return refuseChild(shell, `\`${prog} ${name}\` ${breach}`);
      if (m && !unexport) shellEnv[name] = m[2];
    }
    return OK;
  }
  if (prog === "unset") {
    for (const w of rest) {
      if (w[0] === "-") continue;
      const breach = protectionBreach(w, undefined);
      if (breach) return refuseChild(shell, `\`unset ${w}\` ${breach}`);
      delete shellEnv[w];
    }
    return OK;
  }
  if (prog === "eval") return judgeCommandString(shell, rest.join(" "), env, positional, depth + 1);
  if (INERT_BUILTINS.test(prog)) return OK;
  if (prog === "source" || prog === ".") {
    const hosts = handedHosts(prog, rest, env);
    return hosts.length ? refuseChild(`${shell} ${prog}`, `it was handed ${hosts[0]}`) : OK;
  }
  return judgeProgram(prog, rest, env, depth + 1);
}

function judgeShell(prog, args, env, depth) {
  let i = 0;
  let command = false;
  while (i < args.length) {
    const a = args[i];
    if (a === "--" || a === "-") { i++; break; }
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === "-" && a.indexOf("c") !== -1) command = true;
      if (/[oO]/.test(a)) i++; // -o option / -O shopt: takes a name
      i++;
      continue;
    }
    if (/^--[A-Za-z]/.test(a)) { if (/^--(rcfile|init-file)$/.test(a)) i++; i++; continue; }
    break;
  }
  if (command) return i < args.length ? judgeCommandString(prog, args[i], env, args.slice(i + 1), depth + 1) : OK;
  // A script file, or commands on stdin: not read. What it is handed counts.
  const hosts = handedHosts(prog, args.slice(i), env);
  return hosts.length ? refuseChild(prog, `it was handed ${hosts[0]}`) : OK;
}

function judgeEnvWrapper(args, env, depth) {
  const e = Object.assign({}, env);
  let list = args.slice();
  let i = 0;
  const clearing = refuseChild("env", "`env -i` (or `env -`) would start the program with none of the boundary's environment: no marker, no NODE_OPTIONS");
  while (i < list.length) {
    const a = list[i];
    if (a === "--") { i++; break; }
    if (a === "-") return clearing;
    let value;
    let flag = null;
    if (/^--/.test(a)) {
      const m = /^--([A-Za-z-]+)(?:=([\s\S]*))?$/.exec(a) || [];
      if (m[1] === "ignore-environment") return clearing;
      if (/^(unset|chdir|split-string)$/.test(m[1] || "")) { flag = m[1]; value = m[2] !== undefined ? m[2] : list[++i]; }
    } else if (/^-[A-Za-z0-9]+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === "i") return clearing;
        if ("uPSCLU".indexOf(a[j]) !== -1) {
          flag = { u: "unset", S: "split-string" }[a[j]] || "other";
          value = a.slice(j + 1) || list[++i];
          break;
        }
      }
    } else {
      const m = ASSIGNMENT.exec(a);
      if (!m) break;
      const breach = protectionBreach(m[1], m[2]);
      if (breach) return refuseChild("env", `\`${m[1]}=…\` ${breach}`);
      e[m[1]] = m[2];
      i++;
      continue;
    }
    if (flag === "unset") {
      const breach = protectionBreach(String(value), undefined);
      if (breach) return refuseChild("env", `\`-u ${value}\` ${breach}`);
      delete e[String(value)];
    }
    if (flag === "split-string") {
      const first = shellCommands(String(value || ""))[0] || [];
      list = first.map((w) => expandWord(w, e, [])).concat(list.slice(i + 1));
      i = 0;
      continue;
    }
    i++;
  }
  return i < list.length ? judgeProgram(list[i], list.slice(i + 1), e, depth + 1) : OK;
}

function judgeWrapper(prog, args, env, depth) {
  const takesValue = WRAPPERS[prog];
  let i = 0;
  let lookupOnly = false;
  while (i < args.length && args[i][0] === "-" && args[i] !== "-") {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (prog === "command" && /^-[vV]$/.test(a)) lookupOnly = true;
    i += takesValue.indexOf(a) !== -1 ? 2 : 1;
  }
  if (prog === "timeout") i++; // the duration
  if (lookupOnly || i >= args.length) return OK;
  return judgeProgram(args[i], args.slice(i + 1), env, depth + 1);
}

function judgeProgram(file, args, env, depth) {
  const prog = path.basename(String(file || ""));
  if (depth > MAX_DEPTH) return refuseChild(prog, "it nests too deeply to judge");
  if (isNodeProgram(file, env)) return OK;
  if (prog === "env") return judgeEnvWrapper(args, env, depth);
  if (Object.prototype.hasOwnProperty.call(WRAPPERS, prog)) return judgeWrapper(prog, args, env, depth);
  if (SHELL.test(prog)) return judgeShell(prog, args, env, depth);
  const hosts = handedHosts(prog, args, env);
  return hosts.length ? refuseChild(prog, `it was handed ${hosts[0]}`) : OK;
}

/** Pure: may this program start with these arguments and this env (already
 *  re-pinned)? { ok: true } or { ok: false, message }. */
function childVerdict(file, args, env) {
  return judgeProgram(file, (args || []).map(String), env || {}, 0);
}

function pairsToEnv(pairs) {
  if (!Array.isArray(pairs)) return Object.assign({}, process.env);
  const env = {};
  for (const p of pairs) {
    const s = String(p);
    const i = s.indexOf("=");
    if (i > 0) env[s.slice(0, i)] = s.slice(i + 1);
  }
  return env;
}

function envToPairs(env) {
  return Object.keys(env).map((k) => `${k}=${env[k]}`);
}

function installChildGuard(h) {
  const cp = require("child_process");
  // Every async start (spawn, exec, execFile, fork) passes through here with
  // file, args and envPairs already normalised.
  const proto = cp.ChildProcess.prototype;
  const realSpawn = proto.spawn;
  proto.spawn = function isolatedSpawn(options) {
    if (options && typeof options === "object") {
      const env = repinChildEnv(pairsToEnv(options.envPairs));
      const v = childVerdict(options.file, (options.args || []).slice(1), env);
      if (!v.ok) {
        record(h, `exec://${path.basename(String(options.file))}`);
        throw new Error(v.message);
      }
      options.envPairs = envToPairs(env);
    }
    return realSpawn.call(this, options);
  };
  // The sync calls go straight to the native binding, so each is wrapped at
  // its export (execSync and execFileSync call the module's own spawnSync,
  // not this export, so nothing is judged twice).
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const real = cp[name];
    if (typeof real !== "function") continue;
    cp[name] = function isolatedSync() {
      const args = Array.prototype.slice.call(arguments);
      let file;
      let list;
      let optsAt;
      if (name === "execSync") {
        file = "/bin/sh";
        list = ["-c", String(args[0])];
        optsAt = 1;
      } else if (Array.isArray(args[1]) || args[1] === undefined || args[1] === null) {
        file = args[0];
        list = Array.isArray(args[1]) ? args[1] : [];
        optsAt = 2;
      } else {
        file = args[0];
        list = [];
        optsAt = 1;
      }
      const opts = Object.assign({}, args[optsAt] && typeof args[optsAt] === "object" ? args[optsAt] : {});
      if (opts.shell && name !== "execSync") {
        list = ["-c", [String(file)].concat(list.map(String)).join(" ")];
        file = typeof opts.shell === "string" ? opts.shell : "/bin/sh";
      }
      const env = repinChildEnv(opts.env || process.env);
      const v = childVerdict(file, list, env);
      if (!v.ok) {
        record(h, `exec://${path.basename(String(file))}`);
        throw new Error(v.message);
      }
      opts.env = env;
      if (optsAt === 2 && args.length < 2) args[1] = [];
      args[optsAt] = opts;
      return real.apply(this, args);
    };
  }
  try { Module.syncBuiltinESMExports(); } catch { /* older Node: CJS callers are covered */ }
}

/** Worker threads (second review, Sep 28 eve). A worker is its own isolate: it
 *  gets this file only through the preloads it is started with (execArgv,
 *  inherited by default) and NODE_OPTIONS in ITS env, and decides by the
 *  marker in ITS env — a worker has no entry script. `new Worker(code, { env:
 *  { PATH } })` therefore came up with no boundary: its raw socket went out,
 *  its Prisma engine was unguarded, and with no DATABASE_URL at all Prisma's
 *  .env load (in a worktree, the MAIN tree's .env) was production. So every
 *  worker gets the child environment (marker, sentinel, blank keys, this file
 *  in NODE_OPTIONS), and an explicit execArgv gets `--require` this file.
 *  SHARE_ENV shares this process's env, which is already pinned. */
function installWorkerGuard() {
  let wt;
  try { wt = require("worker_threads"); } catch { return; }
  const Real = wt.Worker;
  if (typeof Real !== "function" || Real[GUARDED_WORKER]) return;
  class IsolatedWorker extends Real {
    constructor(filename, options) {
      const o = Object.assign({}, options || {});
      if (o.env !== wt.SHARE_ENV) o.env = repinChildEnv(o.env && typeof o.env === "object" ? o.env : process.env);
      if (Array.isArray(o.execArgv) && o.execArgv.indexOf(SELF) === -1) o.execArgv = o.execArgv.concat(["--require", SELF]);
      super(filename, o);
    }
  }
  Object.defineProperty(IsolatedWorker, GUARDED_WORKER, { value: true });
  wt.Worker = IsolatedWorker;
  try { Module.syncBuiltinESMExports(); } catch { /* older Node: CJS callers are covered */ }
}

// ---- activation -----------------------------------------------------------------------

function activate() {
  const existing = holder();
  if (existing) return publicState(existing);
  const entry = entryOf();
  const d = decide({ entry, env: process.env });
  if (d.role === "inactive") return publicState(null);
  const h = { active: true, role: d.role, entry, drillEntry: d.drillEntry, blocked: [], listeners: new Set(), file: SELF, pid: process.pid };
  // Not writable, not deletable: a drill cannot switch the boundary off.
  Object.defineProperty(globalThis, KEY, { value: h, enumerable: false, configurable: false, writable: false });
  pinOwnEnv(process.env, d.role, d.drillEntry);
  guardPrismaCli(entry);
  installSocketFence(h);
  installFetchFence(h);
  installEngineGuard(h);
  installChildGuard(h);
  installWorkerGuard();
  // stderr only: c1 parses a child's stdout as JSON, and only the root speaks.
  if (d.role === "root") process.stderr.write(BANNER + "\n");
  return publicState(h);
}

function state() {
  return publicState(holder());
}

function assertActive(caller) {
  if (holder()) return;
  throw new Error(
    `DRILL ISOLATION is not active in this process${caller ? ` (${caller})` : ""}: run drills with \`npm run drills -- <file>\` (or npx tsx --require ./scripts/_drill/_drill-preload.cjs <file>)`,
  );
}

/** Hear about every refusal the boundary makes in this process. */
function onBlocked(fn) {
  const h = holder();
  if (!h) return noop;
  h.listeners.add(fn);
  return () => { h.listeners.delete(fn); };
}

module.exports = {
  SENTINEL_URL,
  MARKER,
  BANNER,
  DB_KEYS,
  NO_DATABASE,
  SELF,
  DRILL_DIR,
  REPO,
  RUNNER,
  activate,
  state,
  assertActive,
  onBlocked,
  decide,
  dbHostsOf,
  connectTarget,
  pinOwnEnv,
  shellCommands,
  isDrillDbUrl,
  isSentinelUrl,
  assertLoopbackDbUrl,
  isLoopbackHost,
  dotEnvKeyNames,
  secretKeyNames,
  repinChildEnv,
  childVerdict,
  judgeEngineConfig,
  withIsolationRequire,
};

// A descendant loads this file through NODE_OPTIONS; nothing else calls
// activate() there, so the marker does it. A root is activated by
// _drill-preload.cjs.
if (process.env[MARKER] === "1") activate();
