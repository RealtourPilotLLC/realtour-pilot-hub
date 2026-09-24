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
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Module from "node:module";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";

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
 *  empty string so the load finds it taken and the drill sees "not configured". */
function neutraliseDotEnv(keep: Set<string>) {
  let text = "";
  try { text = fs.readFileSync(path.join(REPO, ".env"), "utf8"); } catch { return; }
  for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
    if (!keep.has(m[1])) process.env[m[1]] = "";
  }
}

function assertPrismaNotLoaded() {
  const loaded = Object.keys(require.cache).some((f) => /[\\/]src[\\/]lib[\\/]prisma\.(ts|js)$/.test(f));
  const g = globalThis as unknown as { prisma?: unknown };
  if (loaded || g.prisma) {
    throw new Error("@/lib/prisma was loaded before bootDrillDb — its client may already point at production. Import app modules dynamically, after boot.");
  }
}

export type DrillDb = {
  url: string;
  db: PGlite;
  server: DrillSocketServer;
  stop: () => Promise<void>;
};

/**
 * Point this process at 127.0.0.1:port and away from every real secret. Called
 * by bootDrillDb; call it yourself only if something must construct a Prisma
 * client before boot (Prisma's .env load would otherwise fill DATABASE_URL with
 * PRODUCTION the moment a client is constructed).
 */
export function pinDrillEnv(port: number, env: Record<string, string> = {}): string {
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
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

/**
 * Boot an isolated Postgres for one drill: in-process PGlite on 127.0.0.1:port,
 * DATABASE_URL/DIRECT_URL pointed at it, the schema pushed into it. Production
 * is never opened: the URL is asserted to be loopback before `prisma db push`
 * runs, and the push's child process is handed that URL explicitly.
 */
export async function bootDrillDb(opts: {
  port: number;
  /** Extra env for the drill, applied after the .env keys are blanked. */
  env?: Record<string, string>;
  /** Default 64 — above Prisma's pool size on any machine here. */
  maxConnections?: number;
  /** pglite-socket's own debug log. */
  debug?: boolean;
}): Promise<DrillDb> {
  assertPrismaNotLoaded();
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
  return {
    url,
    db,
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      const g = globalThis as unknown as { prisma?: { $disconnect: () => Promise<void> } };
      await g.prisma?.$disconnect().catch(() => {});
      await server.stop();
      await db.close();
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
 */
export function fenceFetch(
  allow?: (url: string, init?: RequestInit) => Response | null | Promise<Response | null>,
): Fence {
  const blocked: string[] = [];
  const faked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (LOOPBACK_URL.test(url)) return realFetch(input, init);
    const canned = allow ? await allow(url, init) : null;
    if (canned) { faked.push(url); return canned; }
    blocked.push(url);
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

  return {
    blocked,
    faked,
    restore() {
      globalThis.fetch = realFetch;
      netMod.connect = real.netConnect;
      netMod.createConnection = real.netCreate;
      tlsMod.connect = real.tlsConnect;
    },
  };
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
