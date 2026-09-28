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
// drill loads it again through NODE_OPTIONS. It decides by WHICH SCRIPT IS
// RUNNING, never by whether the preload was loaded — six scripts/_live
// probes, scripts/_recon, create-test-client, restore-rehearsal and the demo
// load the same preload, and the live probes must keep working exactly as
// they did.
//
// WHO IS ISOLATED: a process whose entry script is under scripts/_drill/ (any
// depth; run-all.cjs excepted) or is one of ISOLATED_TOOLS — the ROOT — and
// every process started from one, which inherits RTP_DRILL_ISOLATION=1 — a
// DESCENDANT. Everything else is left exactly as it was: nothing installed.
//
// WHAT IT DOES, before the first app import:
//   a. DATABASE_URL / DIRECT_URL / SHADOW_DATABASE_URL become a loopback
//      SENTINEL that cannot connect (127.0.0.1:9), until bootDrillDb points
//      them at the drill's own 127.0.0.1 database. Every .env key and every
//      provider key the app reads is set to "" first (the root overwrites; a
//      descendant only fills what is missing, so a parent and its child still
//      agree on APP_SECRET). Prisma's .env self-load never overwrites a key
//      that is already set, even to "" (runtime/library.js dotenv populate;
//      the CLI has the same guard), so it can restore nothing.
//   b. A socket fence at net.Socket.prototype.connect — the one call every
//      TCP and TLS client reaches: net.connect, tls.connect (TLSSocket does
//      not override it), http(s) agents, undici/fetch, http2 and pg's
//      `new net.Socket().connect(port, host)`. A non-loopback host is refused
//      before any DNS lookup, and the refusal is fail-closed: an argument
//      shape it cannot read is treated as remote. globalThis.fetch is wrapped
//      too, only so the refusal reads well.
//   c. A Prisma ENGINE guard. The query engine library is wrapped as it is
//      dlopen'ed; an engine whose datasource is not 127.0.0.1 is built on the
//      sentinel instead and refuses every connect and query with a message
//      that says why. The check reads the same env object the engine
//      snapshots at construction, and the URL it approved is handed to the
//      engine as an explicit override, so nothing can change between check
//      and use. DATABASE_URL set late, new PrismaClient({ datasourceUrl }),
//      a dotenv override — all end here. Engines built earlier on loopback
//      keep working (cp15 changes the env var for a moment on purpose).
//   d. Children: spawn / exec / execFile / fork and the three *Sync calls all
//      hand on the marker, the sentinel for any empty database key, the .env
//      keys, and this file in NODE_OPTIONS — so a drill that REPLACES
//      NODE_OPTIONS (c1, c2, a02 do) still passes the boundary down. A
//      native database client (psql, pg_dump, the Prisma schema engine…),
//      or a `sh -c` command that runs one, handed a database URL that is not
//      loopback is refused: native code is invisible to (b) and (c).
//   e. The Prisma CLI, when a drill runs it (`npx prisma db push` from
//      bootDrillDb): refused outright against a non-loopback URL in its env
//      or its --url flags, before it can start its engine.
//
// WHAT IT DOES NOT COVER: dgram and DNS lookups, process.binding, other
// native addons, a shell SCRIPT file that runs a database client, deliberate
// evasion. It stops accidents — the Sep 28 kind, where a builder ran a file
// believing it was isolated — not an adversary. Node 16-safe syntax on
// purpose: a descendant may be any Node on the PATH.
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const Module = require("module");

const KEY = Symbol.for("rtp.drillIsolation");
const GUARDED = Symbol.for("rtp.drillIsolation.guardedEngine");
const MARKER = "RTP_DRILL_ISOLATION";
const SENTINEL_URL = "postgresql://drill-isolation:no-database@127.0.0.1:9/no_drill_database_booted?sslmode=disable&connect_timeout=1";
const DB_KEYS = ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"];
const BANNER = "[drill-isolation] on · database: sentinel until booted · outbound: 127.0.0.1 only · children inherit";
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
// Scripts outside scripts/_drill/ that exist only to boot a throwaway database
// (restore-rehearsal restores a backup FILE into one; it never reads the live
// database). They are isolated as roots, like a drill.
const ISOLATED_TOOLS = [path.join(REPO, "scripts", "restore-rehearsal.ts")];

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
const DELETE_AT_ROOT = ["AUTH_ENFORCE", "SLACK_ALERT_CHANNEL", "VERCEL"];
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

/** A database a drill may use: on 127.0.0.1, and not the sentinel. */
function isDrillDbUrl(url) {
  const u = parseUrl(url);
  return !!url && !!u && u.hostname === "127.0.0.1" && !isSentinelUrl(url);
}

/** The one check that stands between a schema push and production (moved
 *  here verbatim from _harness.ts, which re-exports it). */
function assertLoopbackDbUrl(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { /* stays empty, refused below */ }
  if (host !== "127.0.0.1") throw new Error(`refusing to push a schema to ${host || "an unparsable URL"}: a drill database must be 127.0.0.1`);
}

/** "host:port" for messages — the host only, never the credentials. */
function whereOf(url) {
  const u = parseUrl(url);
  if (!u) return "an unparsable URL";
  return `${u.hostname || "(no host)"}:${u.port || "5432"}`;
}

// ---- who is running ---------------------------------------------------------

/** Pure, so the self-test can walk the truth table. */
function decide(opts) {
  const o = opts || {};
  const entry = o.entry || null;
  const env = o.env || {};
  const dir = o.drillDir || DRILL_DIR;
  const tools = o.tools || ISOLATED_TOOLS;
  const inDrillDir = !!entry && entry.indexOf(dir + path.sep) === 0 && entry !== path.join(dir, "run-all.cjs");
  const drillEntry = inDrillDir || (!!entry && tools.indexOf(entry) !== -1);
  const inherited = env[MARKER] === "1";
  if (!drillEntry && !inherited) return { role: "inactive", drillEntry: false };
  return { role: drillEntry && !inherited ? "root" : "descendant", drillEntry };
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
    if (drillEntry) {
      // A drill keeps only a loopback database it was handed (runDrillChild's).
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

/** What Socket.prototype.connect was asked for, read the way Node reads it
 *  (net.js normalizeArgs): an options object or its normalized [options, cb]
 *  array, a pipe name, or (port[, host]). A truthy `path` is a unix socket —
 *  local by definition (http nulls the request path before it gets here). */
function connectTarget(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (a !== null && typeof a === "object") {
    if (a.path) return { local: true };
    const hosts = [a.host, a.hostname].filter((x) => x !== undefined && x !== null && x !== "");
    const remote = hosts.find((x) => !isLoopbackHost(x));
    return { host: remote !== undefined ? remote : hosts[0] || "localhost", port: a.port, options: a };
  }
  if (typeof a === "string" && !/^\d+$/.test(a)) return { local: true };
  return { host: typeof args[1] === "string" && args[1] ? args[1] : "localhost", port: a };
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
    const where = `${scheme}://${String(t.host).indexOf(":") !== -1 && String(t.host)[0] !== "[" ? `[${t.host}]` : t.host}:${t.port === undefined || t.port === null ? "" : t.port}`;
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
  const u = parseUrl(url);
  if (!u || u.hostname !== "127.0.0.1") {
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
  // 127.0.0.1 exactly, as for a schema push (assertLoopbackDbUrl).
  const bad = urls.find((u) => { const p = parseUrl(u); return !p || p.hostname !== "127.0.0.1"; });
  if (bad === undefined) return;
  const cmd = argv.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ") || "(no command)";
  process.stderr.write(`DRILL ISOLATION: refused prisma ${cmd} against ${whereOf(bad)} — a drill may only run the Prisma CLI on 127.0.0.1.\n`);
  process.exit(1);
}

// ---- (d) children -------------------------------------------------------------------------

const DB_CLIENT = /^(psql|pg_dump|pg_dumpall|pg_restore|pg_isready|pgbench|pg_basebackup|pg_receivewal|pg_recvlogical|pg_ctl|postgres|postmaster|initdb|createdb|dropdb|createuser|dropuser|vacuumdb|clusterdb|reindexdb|(schema|query|migration)-engine[\w.-]*)$/;
const DB_CLIENT_WORD = /(^|[\s;&|()`'"/])(psql|pg_dump|pg_dumpall|pg_restore|pg_isready|pgbench|pg_basebackup|createdb|dropdb|(schema|query|migration)-engine[\w.-]*)(?=$|[\s;&|()`'"])/;
const SHELL = /^(sh|bash|zsh|dash|ksh)$/;
const DB_URL = /postgres(?:ql)?:\/\/[^\s'"`]+/gi;

/** Database hosts in a child's env and argv that are not loopback. */
function remoteDbHosts(values, pghost) {
  const hosts = [];
  for (const v of values) {
    const s = typeof v === "string" ? v : "";
    const found = s.match(DB_URL) || [];
    for (const url of found) {
      const u = parseUrl(url);
      if (!u || !isLoopbackHost(u.hostname)) hosts.push(u ? u.hostname : "an unparsable URL");
    }
  }
  if (pghost && pghost[0] !== "/" && !pghost.split(",").every(isLoopbackHost)) hosts.push(pghost);
  return hosts;
}

/** Pure: may this program start with this env? Node programs always may —
 *  they load this file and fence themselves — as may any program not handed
 *  a remote database URL. A native database client handed one may not. */
function childVerdict(file, args, env) {
  const e = env || {};
  const list = (args || []).map(String);
  const hosts = remoteDbHosts(Object.keys(e).map((k) => e[k]).concat(list), e.PGHOST);
  if (!hosts.length) return { ok: true };
  const prog = path.basename(String(file || ""));
  let dbClient = DB_CLIENT.test(prog);
  if (!dbClient && SHELL.test(prog)) {
    const at = list.indexOf("-c");
    const cmd = at !== -1 ? String(list[at + 1] || "").replace(DB_URL, " ") : "";
    dbClient = DB_CLIENT_WORD.test(cmd);
  }
  if (!dbClient) return { ok: true };
  return {
    ok: false,
    message: `DRILL ISOLATION: refused to start ${prog} with a database URL for ${hosts[0]} (native programs are not fenced; only 127.0.0.1 is allowed)`,
  };
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
