// ---------------------------------------------------------------------------
// THE SHARED DRILL HARNESS (batch A, Sep 24 2026).
//
// Every drill before this one copied the same forty lines — boot PGlite, serve
// it over a socket, push the schema, stub next/*, fence fetch, count passes —
// and every copy inherited the same hole: PGlite's socket server could not
// survive a SQL error. This file is the one copy, with the hole closed.
//
// USE:
//   import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
//   installNextStubs();
//   const fence = fenceFetch();
//   const { stop } = await bootDrillDb({ port: 55xx });   // YOUR assigned port
//   const { prisma } = await import("@/lib/prisma");      // only AFTER boot
//   const c = makeChecker();
//   c.head("1 · ..."); c.ok("label", cond, "detail");
//   c.summary(); await stop(); process.exit(process.exitCode ?? 0);
//
// App modules must be imported DYNAMICALLY and only after bootDrillDb: a static
// import of @/lib/prisma would bind the client before DATABASE_URL points here.
// bootDrillDb refuses to start if that has already happened.
//
// ---------------------------------------------------------------------------
// WHY THE SOCKET SERVER IS PATCHED, AND WHAT WAS ACTUALLY WRONG.
//
// The symptom (scheduled-journey.ts, Sep 23): after ANY unique violation every
// later query fails with "Server has closed the connection". The suspected
// cause was QueryQueueManager.processQueue — a rejected query `return`s
// without resetting `processing`, and the handler destroys the socket. That
// code IS broken (it would wedge the whole queue for every connection), but it
// is not what fires on a 23505: execProtocolRawStream does not throw on a SQL
// error. Traced with the server's debug log, the server never logs a failure
// and never closes the socket; the CLIENT does. What happens is on the wire:
//
//   Prisma sends  Bind · Execute · Sync   (extended protocol)
//   PGlite answers Execute with  ErrorResponse + ReadyForQuery   <- premature
//   and then answers Sync with   ReadyForQuery                   <- the real one
//
// Real Postgres never sends ReadyForQuery before the Sync after an extended-
// protocol error (postgres.c: "This also causes us not to issue ReadyForQuery
// (until we get Sync)"); PGlite's execProtocolRawSync always calls
// _PostgresSendReadyForQueryIfNecessary in a `finally`. Prisma's driver reads
// the second ReadyForQuery as a protocol violation and drops the connection.
//
// A latent one sits next to it: the queue serialises MESSAGES, not Sync-
// delimited sequences, and PGlite is ONE backend session shared by every
// socket. Outside an explicit transaction, nothing but timing stops another
// connection's Bind landing between this one's Bind and Execute on the shared
// unnamed portal. I could not make it happen with Prisma's traffic (a sequence
// arrives in one socket read and is processed without yielding to I/O — 80
// concurrent mixed queries on the stock server came back clean), so it is
// closed defensively, not because it was seen.
//
// So the harness replaces the queue's processQueue on its own server instance
// (never node_modules, never the shared prototype) with one that:
//   1. strips ReadyForQuery from the reply to any extended message but Sync,
//   2. discards a connection's extended messages after its error until its
//      Sync, as Postgres does (ignore_till_sync),
//   3. gives a connection the session from its first extended message to its
//      Sync, the way the stock code already does for an open transaction, and
//   4. keeps processing after a rejected query instead of wedging.
//
// What PGlite still cannot do: it is one session. An interactive transaction
// holds it until COMMIT, so code that queries OUTSIDE its own `tx` while one is
// open deadlocks against itself — measured: the outside query fails after ~5 s
// (P1001) and the transaction rolls back — where Postgres would simply run it.
//
// ---------------------------------------------------------------------------
// THE REAL-POSTGRES MODE (R04, Sep 28 2026).
//
// Because PGlite is one session, it can prove a single-statement race (a unique
// key, a compare-and-set UPDATE) but never two transactions overlapping: they
// take turns, so an advisory lock is never contended, a second insert never
// waits on the first's uncommitted row, and a pool never runs dry. The last
// real proof of a contended lock used PRODUCTION (scripts/_recon/budget-lock.ts),
// which the Sep 25 handoff now forbids. So:
//
//   const drill = await bootDrillDb({ port: 58xx, engine: "postgres", pool: 5 });
//   (or leave `engine` out and run with DRILL_ENGINE=postgres; PGlite stays the
//   default, and every existing drill runs exactly as it did)
//
// boots a disposable Postgres 18 (embedded-postgres, the major production runs)
// in a temp directory, listening on 127.0.0.1 only, with no unix socket, and
// pushes the schema into a database called `drill`. The package lives in
// tools/realpg with its own node_modules, loaded through createRequire, so the
// root package.json and Vercel's install never see it. What a drill gets on top
// of PGlite mode: backends it can count (distinctBackends, backendsDuring), lock
// waits the server itself logged (lockWaits), sessions stuck in a transaction
// (idleInTransaction), and runChild — a drill script started as a separate
// Node process on the same database behind the same fence, so a race can span
// processes and a process can be SIGKILLed mid-transaction.
//
// Providers stay FAKE in this mode: the fence is the same one. Report it with
// drill.evidence(), which prints the engine next to "providers=FAKE" so fake-
// provider evidence is never mistaken for a provider test.
//
// ---------------------------------------------------------------------------
// THE BOUNDARY UNDER ALL OF THIS (R06, Sep 28 2026).
//
// Isolation is no longer something a drill opts into by calling the right
// helper. _drill-preload.cjs loads _isolation.cjs before the drill: database
// keys on a sentinel, every .env key blank, every non-loopback socket and
// Prisma engine refused, and all of it handed to child processes. What this
// file adds sits ON TOP as a layer: fenceFetch()'s allow-fakers, its counts
// and its "OUTBOUND BLOCKED BY DRILL" messages, bootDrillDb's own database.
// bootDrillDb and attachDrillChild refuse to run without the boundary
// underneath (`npm run drills -- <file>` provides it).
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import Module from "node:module";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertActive, assertLoopbackDbUrl, onBlocked, secretKeyNames } from "./_isolation.cjs";

// The one check that stands between a schema push and production now lives
// with the boundary; re-exported so every existing import keeps working.
export { assertLoopbackDbUrl };

const exec = promisify(execFile);
const REPO = path.resolve(__dirname, "../..");
const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;
const LOOPBACK_URL = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i;

// ---- the socket server, made to behave like Postgres on errors ------------

type QueuedQuery = {
  handlerId: number;
  message: Uint8Array;
  resolve: (resultSize: number) => void;
  reject: (error: Error) => void;
  onData: (data: Uint8Array) => void;
};
/** QueryQueueManager's runtime shape (pglite-socket 0.2.x). It is not exported,
 *  so it is reached through the server instance and checked before use. */
type QueueInternals = {
  queue: QueuedQuery[];
  processing: boolean;
  db: PGlite;
  lastHandlerId: number | null;
  processQueue: () => Promise<void>;
  clearQueueForHandler: (handlerId: number) => void;
};

// Frontend extended-protocol messages other than Sync: Parse, Bind, Describe,
// Execute, Close, Flush. A startup packet begins with a zero length byte, so it
// never matches.
const EXTENDED = new Set(["P", "B", "D", "E", "C", "H"].map((c) => c.charCodeAt(0)));
const SYNC = "S".charCodeAt(0);
const QUERY = "Q".charCodeAt(0);
const READY = "Z".charCodeAt(0);
const ERROR = "E".charCodeAt(0);

/** Split a backend reply into whole messages, or null if it does not parse
 *  cleanly (then it is passed through untouched rather than guessed at). */
function backendMessages(buf: Uint8Array): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 0;
  while (at < buf.length) {
    if (at + 5 > buf.length) return null;
    const len = view.getInt32(at + 1);
    if (len < 4 || at + 1 + len > buf.length) return null;
    out.push(buf.subarray(at, at + 1 + len));
    at += 1 + len;
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Counters the self-test reads to show the patch did the work, not luck. */
export type SocketPatchStats = { strippedReady: number; discardedAfterError: number; rejected: number };

function hardenQueue(q: QueueInternals, stats: SocketPatchStats) {
  for (const k of ["queue", "processing", "db", "lastHandlerId", "processQueue", "clearQueueForHandler"] as const) {
    if (!(k in q)) throw new Error(`pglite-socket internals changed (no QueryQueueManager.${k}); the drill harness patch cannot apply`);
  }
  // The connection that owns the session between its first extended message
  // and its Sync, and the connections whose errored sequence is being skipped.
  let owner: number | null = null;
  const ignoring = new Set<number>();

  const clearForHandler = q.clearQueueForHandler.bind(q);
  q.clearQueueForHandler = (handlerId: number) => {
    clearForHandler(handlerId);
    ignoring.delete(handlerId);
    if (owner === handlerId) {
      // A connection that dies mid-sequence must not hold the session forever.
      owner = null;
      setImmediate(() => void q.processQueue());
    }
  };

  q.processQueue = async function processQueue() {
    if (q.processing || q.queue.length === 0) return;
    q.processing = true;
    try {
      while (q.queue.length > 0) {
        const pinned = owner ?? (q.db.isInTransaction() ? q.lastHandlerId : null);
        let i = 0;
        if (pinned !== null) {
          i = q.queue.findIndex((x) => x.handlerId === pinned);
          // Its next message has not arrived yet; enqueue() restarts the loop.
          if (i === -1) break;
        }
        const query = q.queue.splice(i, 1)[0];
        const kind = query.message[0];
        const extended = EXTENDED.has(kind);
        if (extended) {
          owner = query.handlerId;
          if (ignoring.has(query.handlerId)) {
            stats.discardedAfterError++;
            q.lastHandlerId = query.handlerId;
            query.resolve(0);
            continue;
          }
        }

        const chunks: Uint8Array[] = [];
        try {
          await q.db.runExclusive(() =>
            q.db.execProtocolRawStream(query.message, {
              // A view into WASM memory that the next write reuses — copy it.
              onRawData: (data: Uint8Array) => { chunks.push(new Uint8Array(data)); },
            }),
          );
        } catch (error) {
          // The stock loop `return`ed here with `processing` still true, which
          // left every later query on every connection waiting forever.
          stats.rejected++;
          if (owner === query.handlerId) owner = null;
          query.reject(error as Error);
          continue;
        }

        let reply = chunks.length ? concat(chunks) : new Uint8Array(0);
        if (extended && reply.length) {
          const msgs = backendMessages(reply);
          if (msgs) {
            if (msgs.some((m) => m[0] === ERROR)) ignoring.add(query.handlerId);
            const kept = msgs.filter((m) => m[0] !== READY);
            if (kept.length !== msgs.length) {
              stats.strippedReady += msgs.length - kept.length;
              reply = kept.length ? concat(kept) : new Uint8Array(0);
            }
          }
        }
        if (kind === SYNC || kind === QUERY) {
          ignoring.delete(query.handlerId);
          if (owner === query.handlerId) owner = null;
        }
        if (reply.length) query.onData(reply);
        q.lastHandlerId = query.handlerId;
        query.resolve(reply.length);
      }
    } finally {
      q.processing = false;
    }
  };
}

type ServerOptions = ConstructorParameters<typeof PGLiteSocketServer>[0];

/** PGLiteSocketServer with the queue above swapped in for this instance only. */
export class DrillSocketServer extends PGLiteSocketServer {
  readonly patchStats: SocketPatchStats = { strippedReady: 0, discardedAfterError: 0, rejected: 0 };
  constructor(options: ServerOptions) {
    super(options);
    hardenQueue((this as unknown as { queryQueue: QueueInternals }).queryQueue, this.patchStats);
  }
}

// ---- environment ----------------------------------------------------------

/** Every key the repo's .env defines. Prisma loads that file into process.env
 *  the moment the client is constructed (dotenv never overrides a key that is
 *  already set), so a drill that does nothing inherits real provider secrets —
 *  BLOB_READ_WRITE_TOKEN, the Script Studio key. Each one is pre-set here to an
 *  empty string so the load finds it taken and the drill sees "not configured".
 *  (Sep 28: the names now come from the boundary, which also reads the .env
 *  beside a symlinked node_modules — a worktree's Prisma client loads the MAIN
 *  tree's .env, which this used to miss — and the app's provider keys.) */
function neutraliseDotEnv(keep: Set<string>) {
  for (const k of secretKeyNames()) {
    if (!keep.has(k)) process.env[k] = "";
  }
}

function assertPrismaNotLoaded() {
  const loaded = Object.keys(require.cache).some((f) => /[\\/]src[\\/]lib[\\/]prisma\.(ts|js)$/.test(f));
  const g = globalThis as unknown as { prisma?: unknown };
  if (loaded || g.prisma) {
    throw new Error("@/lib/prisma was loaded before bootDrillDb — its client may already point at production. Import app modules dynamically, after boot.");
  }
}

/** Which database a drill runs on: PGlite (in-process, ONE session, the
 *  default) or a disposable real Postgres. See the header. */
export type DrillEngine = "pglite" | "postgres";

/** opts.engine, else DRILL_ENGINE, else PGlite. Anything else is a typo that
 *  would quietly run the wrong engine, so it throws. */
export function resolveDrillEngine(explicit?: DrillEngine, env: Record<string, string | undefined> = process.env): DrillEngine {
  const pick = explicit ?? (env.DRILL_ENGINE?.trim() || "pglite");
  if (pick !== "pglite" && pick !== "postgres") throw new Error(`unknown drill engine "${pick}" — use pglite or postgres`);
  return pick;
}

export type RunChildOptions = {
  /** argv after the script — how one drill file tells a child which part to play. */
  args?: string[];
  env?: Record<string, string>;
  /** Echo the child's output as it arrives (it is kept for failure messages either way). */
  echo?: boolean;
};

/** A drill script running as its own Node process on the drill's database. */
export type DrillChild = {
  pid: number;
  /** Everything the child sent with its context's send(), in order. */
  messages: unknown[];
  /** Non-loopback attempts the CHILD's fence stopped. Each is also pushed into
   *  the parent's fence: one fence, however many processes. */
  blocked: string[];
  /** The first message (already here or still to come) that satisfies pred.
   *  Rejects, with the child's output, on timeout or if the child exits first. */
  waitFor: <T = unknown>(pred: (msg: unknown) => boolean, timeoutMs?: number) => Promise<T>;
  send: (msg: unknown) => void;
  /** Default SIGKILL — the point of a separate process is that it can die mid-transaction. */
  kill: (signal?: NodeJS.Signals) => void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
};

/** What both engines answer. PGlite answers for the one session it has. */
type DrillDbCommon = {
  engine: DrillEngine;
  url: string;
  /** One statement on a connection of the harness's own, outside Prisma's pool.
   *  (Under PGlite that is the same single session Prisma is using.) */
  sql: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
  serverVersion: () => Promise<string>;
  /** Sessions on the drill database sitting idle inside an open transaction. */
  idleInTransaction: () => Promise<number>;
  /** Client backends connected to the drill database now (harness's own excluded). PGlite: 1. */
  distinctBackends: () => Promise<number>;
  /** Runs fn while sampling every 5 ms; counts the distinct backends seen doing
   *  something (running a statement or holding a transaction). PGlite: 1. */
  backendsDuring: <T>(fn: () => Promise<T>) => Promise<{ result: T; distinctBackends: number }>;
  /** Lock requests on the drill database waiting right now (pg_locks, not granted). PGlite: 0. */
  waitingLocks: () => Promise<number>;
  /** Lock waits the SERVER logged since boot (log_lock_waits after a 50 ms
   *  deadlock_timeout) — evidence from Postgres, not from the drill's clock. PGlite: 0. */
  lockWaits: () => number;
  runChild: (script: string, opts?: RunChildOptions) => DrillChild;
  /** The line every drill prints so fake-provider evidence is labelled as such. */
  evidence: () => Promise<string>;
  stop: () => Promise<void>;
};

/** What bootDrillDb returns unless engine:"postgres" is passed explicitly. `db`
 *  and `server` are PGlite's; under DRILL_ENGINE=postgres touching them throws
 *  by name, so guard PGlite-only checks with `drill.engine === "pglite"`. */
export type DrillDb = DrillDbCommon & { db: PGlite; server: DrillSocketServer };

export type RealPgDrillDb = DrillDbCommon & {
  engine: "postgres";
  port: number;
  /** Prisma's connection_limit in this process (and in each child). */
  pool: number;
  dataDir: string;
  postmasterPid: number;
};

/**
 * Point this process at 127.0.0.1:port and away from every real secret. Called
 * by bootDrillDb; call it yourself only if something must construct a Prisma
 * client before boot (Prisma's .env load would otherwise fill DATABASE_URL with
 * PRODUCTION the moment a client is constructed).
 */
export function pinDrillEnv(port: number, env: Record<string, string> = {}): string {
  return pinDrillUrl(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`, env);
}

function pinDrillUrl(url: string, env: Record<string, string> = {}): string {
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  neutraliseDotEnv(new Set(["DATABASE_URL", "DIRECT_URL"]));
  // Signing still has to round-trip inside the drill, so these get stand-ins
  // rather than blanks. None of them is a real value.
  process.env.APP_SECRET = "drill-app-secret-not-a-real-key-0123456789abcdef";
  process.env.NEXT_PUBLIC_APP_URL = "https://drill.invalid";
  process.env.CRON_SECRET = "drill-secret";
  delete process.env.AUTH_ENFORCE;
  delete process.env.SLACK_ALERT_CHANNEL;
  delete process.env.VERCEL;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return url;
}

export type BootDrillOptions = {
  port: number;
  /** Default: DRILL_ENGINE, else "pglite". */
  engine?: DrillEngine;
  /** Real Postgres only: Prisma's connection_limit, in this process and in
   *  each child. Default DRILL_POOL, else 5 — the pool of one Vercel function. */
  pool?: number;
  /** Extra env for the drill, applied after the .env keys are blanked. */
  env?: Record<string, string>;
  /** PGlite only. Default 64 — above Prisma's pool size on any machine here. */
  maxConnections?: number;
  /** pglite-socket's own debug log; under real Postgres, the server's log. */
  debug?: boolean;
};

/**
 * Boot an isolated Postgres for one drill: in-process PGlite on 127.0.0.1:port
 * (the default), or a disposable real Postgres there (engine "postgres"), with
 * DATABASE_URL/DIRECT_URL pointed at it and the schema pushed into it.
 * Production is never opened: the URL is asserted to be loopback before
 * `prisma db push` runs, and the push's child process is handed that URL
 * explicitly.
 */
export async function bootDrillDb(opts: BootDrillOptions & { engine: "postgres" }): Promise<RealPgDrillDb>;
export async function bootDrillDb(opts: BootDrillOptions): Promise<DrillDb>;
export async function bootDrillDb(opts: BootDrillOptions): Promise<DrillDb | RealPgDrillDb> {
  // Before anything boots: a drill run without the boundary (a hand-typed
  // `npx tsx` with no preload) is refused here rather than half-isolated.
  assertActive("bootDrillDb");
  assertPrismaNotLoaded();
  if (resolveDrillEngine(opts.engine) === "postgres") {
    const pool = opts.pool ?? Number(process.env.DRILL_POOL ?? 5);
    const url = pinDrillUrl(realPgUrl(opts.port, pool), opts.env);
    assertLoopbackDbUrl(process.env.DATABASE_URL ?? "");
    if (process.env.DIRECT_URL !== url || process.env.DATABASE_URL !== url) throw new Error("the drill URL did not stick; refusing to boot");
    const drill = await bootRealPostgres(opts.port, pool, { debug: opts.debug });
    if (opts.engine === "postgres") return drill;
    // Chosen by DRILL_ENGINE, so the drill was typed for PGlite and may reach
    // for its internals: make that fail by name, not as "undefined".
    return Object.assign(drill, { db: pgliteOnly<PGlite>("db"), server: pgliteOnly<DrillSocketServer>("server") });
  }

  const url = pinDrillEnv(opts.port, opts.env);
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "127.0.0.1" || process.env.DIRECT_URL !== url || process.env.DATABASE_URL !== url) {
    throw new Error(`refusing to push a schema to ${host}: a drill database must be 127.0.0.1`);
  }

  const db = await PGlite.create();
  const server = new DrillSocketServer({ db, port: opts.port, host: "127.0.0.1", maxConnections: opts.maxConnections ?? 64, debug: opts.debug });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  let stopped = false;
  const version = async () => (await db.query<{ server_version: string }>("SHOW server_version")).rows[0]?.server_version ?? "?";
  const drill: DrillDb = {
    engine: "pglite",
    url,
    db,
    server,
    // The helpers below answer truthfully for PGlite's single session. None
    // runs unless a drill calls it, so PGlite mode is exactly what it was.
    sql: async <R>(text: string, params?: unknown[]) => (await db.query<R>(text, params)).rows,
    serverVersion: version,
    idleInTransaction: async () => (db.isInTransaction() ? 1 : 0),
    distinctBackends: async () => 1,
    backendsDuring: async <T>(fn: () => Promise<T>) => ({ result: await fn(), distinctBackends: 1 }),
    waitingLocks: async () => 0,
    lockWaits: () => 0,
    runChild: (script, o) => runDrillChild(url, script, o),
    evidence: async () => `engine=pglite ${await version()} (in-process, ONE session) · providers=FAKE · processes=${1 + childrenStarted}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await killDrillChildren();
      const g = globalThis as unknown as { prisma?: { $disconnect: () => Promise<void> } };
      await g.prisma?.$disconnect().catch(() => {});
      await server.stop();
      await db.close();
    },
  };
  return drill;
}

/** A stand-in for a PGlite-only field under the real engine. */
function pgliteOnly<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_t, key) {
      // Let await, console.log and inspection pass without tripping it.
      if (typeof key === "symbol" || key === "then" || key === "toJSON") return undefined;
      throw new Error(`drill.${name}.${String(key)} is PGlite-only and this drill is running on real Postgres (DRILL_ENGINE=postgres). Guard it with drill.engine === "pglite".`);
    },
  });
}

// ---- the real-Postgres engine ---------------------------------------------

/** Production's major version (Neon: 18.6 at the Sep 25 probe). The pin in
 *  tools/realpg must be the same major, and boot refuses a server that is not. */
export const PRODUCTION_PG_MAJOR = 18;
const REALPG = path.join(REPO, "tools", "realpg");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `drill` database; connection_limit mirrors a Vercel function; no pool_timeout
 *  override, because production's URL sets none (Prisma's default, 10 s). */
function realPgUrl(port: number, pool: number): string {
  if (!Number.isInteger(pool) || pool < 1) throw new Error(`pool must be a positive integer, got ${pool}`);
  return `postgresql://postgres:postgres@127.0.0.1:${port}/drill?sslmode=disable&connection_limit=${pool}`;
}

// Just enough of pg and embedded-postgres to type the calls made here. Their
// own .d.ts files live in tools/realpg/node_modules, which the root tsconfig
// (and Vercel's type check) must never depend on.
type PgClient = {
  connect: () => Promise<void>;
  query: <R>(text: string, params?: unknown[]) => Promise<{ rows: R[] }>;
  end: () => Promise<void>;
  on: (event: "error", fn: (e: unknown) => void) => void;
};
type PgModule = { Client: new (cfg: { host: string; port: number; user: string; password: string; database: string }) => PgClient };
type EmbeddedCluster = { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  port: number;
  user: string;
  password: string;
  authMethod: "password";
  persistent: boolean;
  initdbFlags: string[];
  postgresFlags: string[];
  onLog: (m: unknown) => void;
  onError: (m: unknown) => void;
}) => EmbeddedCluster;
type ExitHook = { unhookEvent: (event: string) => void; hookedEvents: () => string[] };

let realPgModules: Promise<{ EmbeddedPostgres: EmbeddedPostgresCtor; pg: PgModule }> | null = null;

function loadRealPg() {
  realPgModules ??= (async () => {
    const req = Module.createRequire(path.join(REALPG, "package.json"));
    let entry: string;
    try {
      entry = req.resolve("embedded-postgres");
    } catch {
      throw new Error("embedded-postgres is not installed. Run: npm install --prefix tools/realpg (never with --ignore-scripts: the binary package's postinstall rebuilds its library links)");
    }
    const pinned = (JSON.parse(fs.readFileSync(path.join(REALPG, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["embedded-postgres"];
    const installed = (JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8")) as { version: string }).version;
    if (installed !== pinned) throw new Error(`tools/realpg pins embedded-postgres ${pinned} but ${installed} is installed. Run: npm install --prefix tools/realpg`);
    // The package is ESM-only ("type": "module"), so it is imported by path.
    const mod = (await import(pathToFileURL(entry).href)) as { default: EmbeddedPostgresCtor };
    // On import it registers async-exit-hook. Two of its handlers are wrong
    // for a drill: `beforeExit` stops every cluster and then calls
    // process.exit(0), which would turn a drill that failed (exitCode 1) and
    // simply ran out of work into a PASS; and `exit` runs its async shutdown
    // with no callback, so a drill that ends without process.exit() dies in
    // "done is not a function" (seen here). Both go; bootRealPostgres's own
    // exit handler stops the server instead. Its signal hooks, which stop a
    // cluster cleanly on Ctrl-C, stay.
    const hook = Module.createRequire(entry)("async-exit-hook") as ExitHook;
    for (const event of ["beforeExit", "exit", "message"]) hook.unhookEvent(event);
    return { EmbeddedPostgres: mod.default, pg: req("pg") as PgModule };
  })();
  return realPgModules;
}

/** True when nothing listens on 127.0.0.1:port. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

// A SIGKILLed drill cannot stop its cluster: the postmaster is a separate
// process and carries on holding the port and a temp directory. Each boot
// leaves a record here, and the next boot on that port reaps what it names.
const guardFile = (port: number) => path.join(os.tmpdir(), `rtp-realpg-${port}.json`);
type GuardRecord = { dir: string; ownerPid: number };

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The postmaster's pid as Postgres itself recorded it — and only if that pid
 *  is still a postgres process serving this directory (pids get reused). */
function postmasterOf(dir: string): number | null {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(dir, "postmaster.pid"), "utf8").split("\n")[0]); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
  let args = "";
  try { args = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }); } catch { return null; }
  return args.includes("postgres") && args.includes(dir) ? pid : null;
}

/** Only ever delete a directory this harness made, for this port. */
const isClusterDir = (dir: string, port: number) =>
  path.dirname(path.resolve(dir)) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith(`rtp-realpg-${port}-`);

/** Returns what it cleaned up, or null when there was nothing to do. */
export async function reapStaleCluster(port: number): Promise<string | null> {
  let rec: GuardRecord;
  try { rec = JSON.parse(fs.readFileSync(guardFile(port), "utf8")) as GuardRecord; } catch { return null; }
  const pm = rec.dir ? postmasterOf(rec.dir) : null;
  if (pm && pidAlive(rec.ownerPid)) {
    throw new Error(rec.ownerPid === process.pid
      ? `this drill already runs a cluster on 127.0.0.1:${port}; stop() it before booting there again`
      : `127.0.0.1:${port} belongs to a live drill (pid ${rec.ownerPid}); give this drill its own port`);
  }
  if (pm) {
    process.kill(pm, "SIGINT"); // fast shutdown: ends every session, then exits
    for (const until = Date.now() + 10_000; pidAlive(pm) && Date.now() < until; ) await sleep(50);
    if (pidAlive(pm)) process.kill(pm, "SIGKILL");
    for (const until = Date.now() + 5_000; !(await portFree(port)) && Date.now() < until; ) await sleep(50);
  }
  if (rec.dir && isClusterDir(rec.dir, port)) fs.rmSync(rec.dir, { recursive: true, force: true });
  fs.rmSync(guardFile(port), { force: true });
  return pm ? `stopped a leftover postmaster (pid ${pm}) of dead drill ${rec.ownerPid} and removed its directory` : `removed the record and directory of dead drill ${rec.ownerPid}`;
}

/**
 * A disposable Postgres (PRODUCTION_PG_MAJOR) on 127.0.0.1:port — temp data
 * directory, TCP on loopback only, no unix socket — with a `drill` database
 * and, unless pushSchema is false, the schema pushed into it. bootDrillDb calls
 * this after pinning the env; call it directly only to boot again on a port in
 * a process that is already pinned (the self-test's re-boot does).
 */
export async function bootRealPostgres(
  port: number,
  pool = Number(process.env.DRILL_POOL ?? 5),
  opts: { pushSchema?: boolean; debug?: boolean } = {},
): Promise<RealPgDrillDb> {
  // A process already pointed anywhere but loopback is one dynamic import away
  // from that database. Refuse to add a cluster to it.
  if (process.env.DATABASE_URL) assertLoopbackDbUrl(process.env.DATABASE_URL);
  const url = realPgUrl(port, pool);
  assertLoopbackDbUrl(url);
  const { EmbeddedPostgres, pg } = await loadRealPg();

  const reaped = await reapStaleCluster(port);
  if (reaped) console.log(`    [realpg:${port}] ${reaped}`);
  if (!(await portFree(port))) throw new Error(`127.0.0.1:${port} is already in use; give this drill its own port`);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `rtp-realpg-${port}-`));
  fs.writeFileSync(guardFile(port), JSON.stringify({ dir, ownerPid: process.pid } satisfies GuardRecord));

  // The server's log, kept for failures and for lockWaits(): with
  // log_lock_waits on, Postgres itself writes "still waiting for" whenever a
  // lock request outlasts deadlock_timeout.
  const tail: string[] = [];
  let partial = "";
  let lockWaitCount = 0;
  const sink = (m: unknown) => {
    const lines = (partial + (m instanceof Error ? m.message : String(m))).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.includes("still waiting for")) lockWaitCount++;
      tail.push(line);
      if (tail.length > 200) tail.shift();
      if (opts.debug) console.log(`    [pg:${port}] ${line}`);
    }
  };

  const cluster = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "postgres",
    password: "postgres",
    authMethod: "password",
    persistent: false, // stop() deletes the directory
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--no-sync"],
    postgresFlags: [
      "-c", "listen_addresses=127.0.0.1",
      "-c", "unix_socket_directories=", // TCP on loopback is the only way in
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", // disposable: speed over durability
      "-c", "log_lock_waits=on", "-c", "deadlock_timeout=50ms",
      "-c", "TimeZone=UTC",
    ],
    onLog: sink,
    onError: sink,
  });
  let admin: PgClient | null = null;
  const connect = async (database: string) => {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database });
    client.on("error", sink);
    await client.connect();
    return client;
  };
  const abandon = async (why: unknown): Promise<never> => {
    await admin?.end().catch(() => {});
    await cluster.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(guardFile(port), { force: true });
    throw new Error(`real Postgres on 127.0.0.1:${port} did not come up: ${why instanceof Error ? why.message : String(why ?? "the server exited")}\n${tail.slice(-15).join("\n")}`);
  };

  let version = "";
  let monitorPid = 0;
  let postmasterPid = 0;
  try {
    await cluster.initialise();
    await cluster.start();
    postmasterPid = postmasterOf(dir) ?? 0;
    if (!postmasterPid) throw new Error("no live postmaster recorded in the data directory");
    admin = await connect("postgres");
    version = (await admin.query<{ server_version: string }>("SHOW server_version")).rows[0].server_version;
    if (Number.parseInt(version, 10) !== PRODUCTION_PG_MAJOR) throw new Error(`server is ${version}; production is ${PRODUCTION_PG_MAJOR}.x — fix the pin in tools/realpg`);
    monitorPid = (await admin.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await admin.query("CREATE DATABASE drill");
    if (opts.pushSchema !== false) {
      assertLoopbackDbUrl(url);
      await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
        cwd: REPO,
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      });
    }
  } catch (e) {
    return abandon(e);
  }
  const monitor = admin as PgClient;

  // If the drill dies without stop(), end the server with it. (The directory
  // is left for the next boot's reaper: it cannot be removed synchronously
  // while the server is still shutting down.)
  const onExit = () => { if (pidAlive(postmasterPid)) { try { process.kill(postmasterPid, "SIGINT"); } catch { /* already gone */ } } };
  process.on("exit", onExit);

  // The harness's own sessions never count as the drill's backends.
  let sqlClient: Promise<{ client: PgClient; pid: number }> | null = null;
  let sqlPid = 0;
  const own = () => [monitorPid, sqlPid];
  const DRILL_BACKENDS = "FROM pg_stat_activity WHERE datname = 'drill' AND backend_type = 'client backend' AND pid <> ALL($1::int[])";
  const count = async (text: string) => (await monitor.query<{ n: number }>(text, [own()])).rows[0].n;
  let peakBackends = 0;
  const peak = (n: number) => { peakBackends = Math.max(peakBackends, n); return n; };

  let stopped = false;
  return {
    engine: "postgres",
    url,
    port,
    pool,
    dataDir: dir,
    postmasterPid,
    async sql<R>(text: string, params?: unknown[]) {
      sqlClient ??= connect("drill").then(async (client) => {
        sqlPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return { client, pid: sqlPid };
      });
      return (await (await sqlClient).client.query<R>(text, params)).rows;
    },
    serverVersion: async () => version,
    idleInTransaction: () => count(`SELECT count(*)::int AS n ${DRILL_BACKENDS} AND state LIKE 'idle in transaction%'`),
    distinctBackends: async () => peak(await count(`SELECT count(DISTINCT pid)::int AS n ${DRILL_BACKENDS}`)),
    async backendsDuring<T>(fn: () => Promise<T>) {
      const seen = new Set<number>();
      let running = true;
      const sampler = (async () => {
        while (running) {
          const rows = (await monitor.query<{ pid: number }>(`SELECT pid ${DRILL_BACKENDS} AND state <> 'idle'`, [own()])).rows;
          for (const r of rows) seen.add(r.pid);
          await sleep(5);
        }
      })();
      try {
        return { result: await fn(), distinctBackends: peak(seen.size) };
      } finally {
        running = false;
        await sampler.catch(() => {});
      }
    },
    waitingLocks: () => count("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = 'drill' AND l.pid <> ALL($1::int[])"),
    lockWaits: () => lockWaitCount,
    runChild: (script, o) => runDrillChild(url, script, o),
    evidence: async () =>
      `engine=postgres ${version} (embedded) · providers=FAKE · pool=${pool} · processes=${1 + childrenStarted} · distinct backends=${peakBackends} · lock waits=${lockWaitCount}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await killDrillChildren();
      const g = globalThis as unknown as { prisma?: { $disconnect: () => Promise<void> } };
      await g.prisma?.$disconnect().catch(() => {});
      if (sqlClient) await (await sqlClient.catch(() => null))?.client.end().catch(() => {});
      await monitor.end().catch(() => {});
      await cluster.stop(); // SIGINT (fast shutdown), waits for the exit, deletes the directory
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(guardFile(port), { force: true });
      process.removeListener("exit", onExit);
    },
  };
}

// ---- child processes: one drill, several Node processes -------------------

const liveChildren = new Set<ChildProcess>();
let childrenStarted = 0;

/**
 * Start `script` (a drill file, usually the caller's own __filename with an
 * argv role) as a separate Node process on the drill database, the way the
 * parent was started (same loader flags, same env — .env keys already blank).
 * The child calls attachDrillChild() and talks back over IPC; anything its
 * fence blocks lands in the parent's fence too. Spawned as node itself, not
 * through npx, so kill("SIGKILL") kills the process holding the connections.
 */
export function runDrillChild(url: string, script: string, opts: RunChildOptions = {}): DrillChild {
  assertLoopbackDbUrl(url);
  const proc = spawn(process.execPath, [...process.execArgv, path.resolve(script), ...(opts.args ?? [])], {
    cwd: process.cwd(), // execArgv may carry a relative --require
    env: { ...process.env, ...opts.env, DRILL_CHILD: "1", DRILL_CHILD_URL: url },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  childrenStarted++;
  liveChildren.add(proc);
  const pid = proc.pid ?? -1;
  let out = "";
  const keep = (d: Buffer) => {
    const s = d.toString();
    out = (out + s).slice(-64_000);
    if (opts.echo) process.stdout.write(s.replace(/^(?=.)/gm, `    [child ${pid}] `));
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  // A send to a child that has already gone surfaces here, not as a crash.
  proc.on("error", (e) => { out += `\n[child process error] ${e.message}`; });

  const messages: unknown[] = [];
  const blocked: string[] = [];
  const waiters = new Set<() => void>();
  const wake = () => { for (const w of [...waiters]) w(); };
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  proc.on("message", (raw: unknown) => {
    const m = raw as { drillFence?: unknown; drill?: unknown } | null;
    if (m && typeof m.drillFence === "string") {
      blocked.push(m.drillFence);
      activeFence?.blocked.push(m.drillFence);
    } else if (m && "drill" in m) {
      messages.push(m.drill);
    }
    wake();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("exit", (code, signal) => {
      liveChildren.delete(proc);
      exitInfo = { code, signal };
      resolve(exitInfo);
      wake();
    });
  });

  return {
    pid,
    messages,
    blocked,
    exited,
    output: () => out,
    send(msg) { if (proc.connected) proc.send({ drill: msg }); },
    kill(signal = "SIGKILL") { proc.kill(signal); },
    waitFor<T = unknown>(pred: (msg: unknown) => boolean, timeoutMs = 30_000) {
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          const i = messages.findIndex(pred);
          if (i >= 0) { finish(); resolve(messages[i] as T); return; }
          if (exitInfo) { finish(); reject(new Error(`child ${pid} exited ${JSON.stringify(exitInfo)} before sending what was waited for\n${out.slice(-2000)}`)); }
        };
        const timer = setTimeout(() => { finish(); reject(new Error(`child ${pid}: nothing matching within ${timeoutMs} ms\n${out.slice(-2000)}`)); }, timeoutMs);
        const finish = () => { clearTimeout(timer); waiters.delete(check); };
        waiters.add(check);
        check();
      });
    },
  };
}

async function killDrillChildren() {
  const waits = [...liveChildren].map((p) => new Promise<void>((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    p.once("exit", () => resolve());
    p.kill("SIGKILL");
    setTimeout(resolve, 3_000);
  }));
  await Promise.all(waits);
}

/** What a script started by runChild() gets from attachDrillChild(). */
export type DrillChildContext = {
  url: string;
  fence: Fence;
  /** To the parent; resolves once it is on the wire. */
  send: (msg: unknown) => Promise<void>;
  /** The first message from the parent (already here or still to come) that satisfies pred. */
  waitFor: <T = unknown>(pred: (msg: unknown) => boolean, timeoutMs?: number) => Promise<T>;
  /** Flush everything sent, then exit. */
  exit: (code?: number) => Promise<never>;
};

/**
 * Call first thing in a child started by runChild() — before any app import,
 * like bootDrillDb. Pins DATABASE_URL to the parent's loopback database (the
 * parent's env already has every .env key blanked; any key missing is blanked
 * here, none the parent set is touched), keeps the next/* stubs, and fences
 * the network with every blocked attempt reported to the parent. The child
 * exits by itself if the parent goes away.
 */
export function attachDrillChild(): DrillChildContext {
  const url = process.env.DRILL_CHILD_URL ?? "";
  if (!process.env.DRILL_CHILD || !url || !process.send) throw new Error("attachDrillChild() runs only inside a process started by drill.runChild()");
  assertActive("attachDrillChild");
  assertLoopbackDbUrl(url);
  assertPrismaNotLoaded();
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  // The boundary already filled these as a descendant; kept as a second pass.
  for (const k of secretKeyNames()) {
    if (process.env[k] === undefined) process.env[k] = "";
  }
  if (!replacements.has("next/cache")) installNextStubs();
  const fence = activeFence ?? fenceFetch();

  let last: Promise<void> = Promise.resolve();
  const send = (msg: unknown): Promise<void> => {
    last = new Promise<void>((resolve) => {
      try {
        process.send?.(msg, undefined, {}, () => resolve());
      } catch {
        resolve(); // the parent is gone; the disconnect handler exits
      }
    });
    return last;
  };
  fenceListeners.add((entry) => { void send({ drillFence: entry }); });
  process.on("disconnect", () => process.exit(0));

  const inbox: unknown[] = [];
  const waiters = new Set<() => void>();
  process.on("message", (raw: unknown) => {
    const m = raw as { drill?: unknown } | null;
    if (m && typeof m === "object" && "drill" in m) {
      inbox.push(m.drill);
      for (const w of [...waiters]) w();
    }
  });

  return {
    url,
    fence,
    send: (msg) => send({ drill: msg }),
    waitFor<T = unknown>(pred: (msg: unknown) => boolean, timeoutMs = 60_000) {
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          const i = inbox.findIndex(pred);
          if (i >= 0) { finish(); resolve(inbox[i] as T); }
        };
        const timer = setTimeout(() => { finish(); reject(new Error(`no matching message from the parent within ${timeoutMs} ms`)); }, timeoutMs);
        const finish = () => { clearTimeout(timer); waiters.delete(check); };
        waiters.add(check);
        check();
      });
    },
    async exit(code = 0) {
      await last;
      process.exit(code);
    },
  };
}

// ---- next/* stubs ---------------------------------------------------------

type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const loader = Module as unknown as Loader;
/** Whole-module replacements, by exact request string. */
const replacements = new Map<string, unknown>();
/** Wrappers applied to the real module after it loads. */
const interceptors: { match: (request: string) => boolean; wrap: (loaded: unknown) => unknown }[] = [];
let loaderInstalled = false;

function installLoader() {
  if (loaderInstalled) return;
  loaderInstalled = true;
  const realLoad = loader._load;
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (replacements.has(request)) return replacements.get(request);
    const loaded = realLoad.call(this, request, parent, isMain);
    return interceptors.reduce((mod, i) => (i.match(request) ? i.wrap(mod) : mod), loaded);
  };
}

/**
 * Wrap a module as the app loads it. `match` sees the request string as written
 * in the importing file ("@/lib/integrations/ai", "./ai"). Used for the model
 * boundary: stub ONE function and let everything around it — run ledger,
 * lease, dedupe, switches — be the shipped code.
 */
export function interceptModule(match: (request: string) => boolean, wrap: (loaded: unknown) => unknown) {
  installLoader();
  interceptors.push({ match, wrap });
}

/**
 * next/cache, next/navigation and next/headers for code running outside Next.
 * revalidate* are no-ops; redirect/notFound throw (a drill never renders);
 * headers()/cookies() answer from the maps given here, empty by default.
 * Replaced outright rather than wrapped: under react-server the real
 * next/navigation is a client module that cannot even be evaluated.
 */
export function installNextStubs(opts: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
  const nope = (name: string) => () => { throw new Error(`next/navigation.${name}() is not available in a drill`); };
  const cookieJar = new Map(Object.entries(opts.cookies ?? {}));
  const cookieStore = {
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) as string } : undefined),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
    has: (name: string) => cookieJar.has(name),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  };
  replacements.set("next/cache", {
    revalidatePath: () => {},
    revalidateTag: () => {},
    updateTag: () => {},
    refresh: () => {},
    unstable_noStore: () => {},
    unstable_cache: (f: unknown) => f,
  });
  replacements.set("next/navigation", {
    redirect: nope("redirect"),
    permanentRedirect: nope("permanentRedirect"),
    notFound: nope("notFound"),
    forbidden: nope("forbidden"),
    unauthorized: nope("unauthorized"),
    RedirectType: { push: "push", replace: "replace" },
    useRouter: nope("useRouter"),
    usePathname: nope("usePathname"),
    useSearchParams: nope("useSearchParams"),
    useParams: nope("useParams"),
  });
  replacements.set("next/headers", {
    headers: async () => new Headers(opts.headers ?? {}),
    cookies: async () => cookieStore,
    draftMode: async () => ({ isEnabled: false, enable: () => {}, disable: () => {} }),
  });
  installLoader();
}

// ---- the network fence ----------------------------------------------------

export type Fence = {
  /** Every non-loopback destination something tried to reach, in order. */
  blocked: string[];
  /** URLs answered by the `allow` faker instead of the network. */
  faked: string[];
  restore: () => void;
};

// The fence most recently put up in this process, and who else hears about a
// block: a child started by runChild() forwards each one to its parent, whose
// fence records it too.
let activeFence: Fence | null = null;
const fenceListeners = new Set<(entry: string) => void>();

function targetOf(args: unknown[]): string | null {
  const [a, b] = args;
  if (a && typeof a === "object") {
    const o = a as { host?: string; hostname?: string; port?: number | string; path?: string };
    if (o.path && !o.host && !o.hostname) return null; // a unix socket is local by definition
    return `${o.host ?? o.hostname ?? "localhost"}:${o.port ?? ""}`;
  }
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) return `${typeof b === "string" ? b : "localhost"}:${a}`;
  return null;
}

/**
 * Block every outbound call that is not to loopback, and count it. Two layers:
 * globalThis.fetch (where most provider code goes), and net/tls connect (where
 * EVERYTHING goes — Stripe's and Plaid's SDKs use node:https, @vercel/blob uses
 * its own undici — so a library that never touches global fetch still cannot
 * leave). A blocked fetch throws; a blocked socket errors asynchronously, the
 * way a refused connection does.
 *
 * `allow(url, init)` may answer a specific host with a canned Response (return
 * null to fall through to the block). Loopback fetches go to the real network.
 *
 * Since Sep 28 (R06) this is a layer OVER the runner boundary, not the fence
 * itself: the functions it wraps are the boundary's fenced ones, so whatever
 * slips past this layer (a `new net.Socket().connect()`, an argument shape it
 * cannot read) is refused underneath, and those refusals are listed in
 * `blocked` too. restore() takes away only this layer.
 */
export function fenceFetch(
  allow?: (url: string, init?: RequestInit) => Response | null | Promise<Response | null>,
): Fence {
  const blocked: string[] = [];
  const faked: string[] = [];
  const realFetch = globalThis.fetch;
  // Refusals made by the boundary underneath, while this layer is up.
  const unsubscribe = onBlocked((entry) => {
    blocked.push(entry);
    if (activeFence === fence) for (const tell of fenceListeners) tell(entry);
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (LOOPBACK_URL.test(url)) return realFetch(input, init);
    const canned = allow ? await allow(url, init) : null;
    if (canned) { faked.push(url); return canned; }
    blocked.push(url);
    for (const tell of fenceListeners) tell(url);
    throw new Error(`OUTBOUND BLOCKED BY DRILL: ${url}`);
  }) as typeof fetch;

  const netMod = net as unknown as Record<string, (...a: unknown[]) => net.Socket>;
  const tlsMod = tls as unknown as Record<string, (...a: unknown[]) => net.Socket>;
  const real = { netConnect: netMod.connect, netCreate: netMod.createConnection, tlsConnect: tlsMod.connect };
  const guard = (orig: (...a: unknown[]) => net.Socket, scheme: string) =>
    function (this: unknown, ...args: unknown[]) {
      const target = targetOf(args);
      const host = target ? target.slice(0, target.lastIndexOf(":")) : null;
      if (host === null || LOOPBACK_HOST.test(host)) return orig.apply(this, args);
      blocked.push(`${scheme}://${target}`);
      for (const tell of fenceListeners) tell(`${scheme}://${target}`);
      const s = new net.Socket();
      // Look like a connection still being made: http writes the request before
      // the error below lands, and on an idle socket that write fails first
      // with "Socket is closed", hiding what actually happened.
      (s as unknown as { connecting: boolean }).connecting = true;
      // A listener of our own so an SDK that never listens cannot crash the drill.
      s.on("error", () => {});
      setImmediate(() => s.destroy(new Error(`OUTBOUND BLOCKED BY DRILL: ${scheme}://${target}`)));
      return s;
    };
  netMod.connect = guard(real.netConnect, "tcp");
  netMod.createConnection = guard(real.netCreate, "tcp");
  tlsMod.connect = guard(real.tlsConnect, "tls");

  const fence: Fence = {
    blocked,
    faked,
    restore() {
      globalThis.fetch = realFetch;
      netMod.connect = real.netConnect;
      netMod.createConnection = real.netCreate;
      tlsMod.connect = real.tlsConnect;
      unsubscribe();
      if (activeFence === fence) activeFence = null;
    },
  };
  activeFence = fence;
  return fence;
}

/**
 * src/lib/prisma.ts logs at level "error", so every deliberate P2002 in a race
 * prints a multi-line stack between the PASS lines. This swallows Prisma's
 * error-log lines — only those — and counts them; the error itself still
 * reaches the caller. (A configured log level arrives as
 * console.log("prisma:error", message), not console.error.)
 */
export function quietPrismaErrors(): { readonly count: number; restore: () => void } {
  const real = { log: console.log, error: console.error };
  let count = 0;
  const filter = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].slice(0, 32).includes("prisma:error")) { count++; return; }
    orig(...args);
  };
  console.log = filter(real.log);
  console.error = filter(real.error);
  return {
    get count() { return count; },
    restore() { console.log = real.log; console.error = real.error; },
  };
}

// ---- pass/fail bookkeeping -----------------------------------------------

export type Checker = {
  ok: (label: string, cond: boolean, detail?: string) => boolean;
  head: (title: string) => void;
  /** Prints the tally and sets process.exitCode (1 on any failure). */
  summary: () => { pass: number; fail: number };
  readonly pass: number;
  readonly fail: number;
};

export function makeChecker(): Checker {
  let pass = 0, fail = 0;
  return {
    ok(label, cond, detail = "") {
      if (cond) pass++; else fail++;
      console.log(`  ${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
      return cond;
    },
    head(title) {
      console.log(`\n${title}\n${"─".repeat(title.length)}`);
    },
    summary() {
      console.log(`\n${pass} passed, ${fail} failed\n`);
      process.exitCode = fail ? 1 : 0;
      return { pass, fail };
    },
    get pass() { return pass; },
    get fail() { return fail; },
  };
}
