// ---------------------------------------------------------------------------
// THE DEMO'S SOCKET SERVER: the drill harness's, made safe for TWO PROCESSES.
//
// The harness's DrillSocketServer (scripts/_drill/_harness.ts) is built for a
// drill: one Node process, one Prisma, one PGlite session behind it. The demo
// has two processes on that one session — this one (seeding, sign-in links)
// and `next dev` — and the first click in the browser failed with
//
//   42P05  prepared statement "s46" already exists
//
// Prisma's driver names its prepared statements from a PROCESS-wide counter
// (s0, s1, …), which never repeats inside one process and is exactly why the
// drills never saw this. PGlite is ONE backend session, so a statement one
// process prepared is visible to — and collides with — the other process's
// statement of the same name; and the seeding had already left s0…s250 in the
// session before the dev server's counter started at s0.
//
// The fix is where the collision is: each connection's statement names are
// rewritten into its own namespace on the way in (Parse, Bind, and the
// statement forms of Describe and Close), and a connection's statements are
// deallocated when it goes away. The unnamed statement and all portals are
// untouched — the harness already gives a connection the session from its
// first extended message to its Sync, which is what protects those.
// ---------------------------------------------------------------------------
import { DrillSocketServer } from "../_drill/_harness";

type Queue = {
  enqueue: (handlerId: number, message: Uint8Array, onData: (data: Uint8Array) => void) => Promise<number>;
  clearQueueForHandler: (handlerId: number) => void;
};

const P = "P".charCodeAt(0);
const B = "B".charCodeAt(0);
const D = "D".charCodeAt(0);
const C = "C".charCodeAt(0);
const S = "S".charCodeAt(0);

const prefixFor = (handlerId: number) => `h${handlerId}_`;

function cstringEnd(buf: Uint8Array, from: number): number {
  const end = buf.indexOf(0, from);
  if (end < 0) throw new Error("malformed frontend message: unterminated string");
  return end;
}

function rebuild(type: number, parts: Uint8Array[]): Uint8Array {
  const bodyLen = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(1 + 4 + bodyLen);
  out[0] = type;
  new DataView(out.buffer).setInt32(1, 4 + bodyLen);
  let at = 5;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const enc = new TextEncoder();

/**
 * One frontend message with its prepared-statement name moved into the
 * connection's namespace, or the message unchanged. Pure — the smoke drill
 * checks it byte for byte. `seen` collects the namespaced names this
 * connection has prepared, so they can be deallocated when it closes.
 */
export function namespaceStatementNames(handlerId: number, message: Uint8Array, seen?: Set<string>): Uint8Array {
  const type = message[0];
  if (message.length < 6 || (type !== P && type !== B && type !== D && type !== C)) return message;
  const prefix = enc.encode(prefixFor(handlerId));
  const body = message.subarray(5);
  const renamed = (name: Uint8Array) => {
    const out = new Uint8Array(prefix.length + name.length);
    out.set(prefix, 0);
    out.set(name, prefix.length);
    return out;
  };
  if (type === P) {
    // Parse: statement name, then query text and parameter types.
    const end = cstringEnd(body, 0);
    if (end === 0) return message; // the unnamed statement
    const name = renamed(body.subarray(0, end));
    seen?.add(new TextDecoder().decode(name));
    return rebuild(type, [name, body.subarray(end)]);
  }
  if (type === B) {
    // Bind: portal name, then statement name, then the rest.
    const portalEnd = cstringEnd(body, 0);
    const stmtEnd = cstringEnd(body, portalEnd + 1);
    if (stmtEnd === portalEnd + 1) return message;
    return rebuild(type, [body.subarray(0, portalEnd + 1), renamed(body.subarray(portalEnd + 1, stmtEnd)), body.subarray(stmtEnd)]);
  }
  // Describe / Close: 'S' + statement name, or 'P' + portal name (left alone).
  if (body[0] !== S) return message;
  const end = cstringEnd(body, 1);
  if (end === 1) return message;
  const name = renamed(body.subarray(1, end));
  // Closed by the driver itself (its statement cache evicting): nothing left to free later.
  if (type === C) seen?.delete(new TextDecoder().decode(name));
  return rebuild(type, [body.subarray(0, 1), name, body.subarray(end)]);
}

/** A simple-query message ('Q'). */
function simpleQuery(sql: string): Uint8Array {
  return rebuild("Q".charCodeAt(0), [enc.encode(sql), new Uint8Array([0])]);
}

export class DemoSocketServer extends DrillSocketServer {
  /** Namespaced statements deallocated when their connection closed. */
  deallocated = 0;
  constructor(options: ConstructorParameters<typeof DrillSocketServer>[0]) {
    super(options);
    const q = (this as unknown as { queryQueue: Queue }).queryQueue;
    const prepared = new Map<number, Set<string>>();
    const enqueue = q.enqueue.bind(q);
    q.enqueue = (handlerId, message, onData) => {
      let seen = prepared.get(handlerId);
      if (!seen) prepared.set(handlerId, (seen = new Set()));
      return enqueue(handlerId, namespaceStatementNames(handlerId, message, seen), onData);
    };
    // A closed connection's statements would otherwise live as long as the
    // session: a restarted dev server leaves its whole cache behind each time.
    // Sent through the queue under a handler id no socket has, so it waits its
    // turn behind any open transaction like every other message.
    // One DEALLOCATE per message: in a multi-statement query the first error
    // (a statement whose Parse had failed) would skip every one after it.
    let sweeper = -1;
    const clear = q.clearQueueForHandler.bind(q);
    q.clearQueueForHandler = (handlerId) => {
      clear(handlerId);
      const names = prepared.get(handlerId);
      prepared.delete(handlerId);
      for (const n of names ?? []) {
        enqueue(sweeper--, simpleQuery(`DEALLOCATE "${n.replace(/"/g, '""')}"`), () => {})
          .then(() => { this.deallocated++; })
          .catch(() => { /* the session is closing: nothing to free */ });
      }
    };
  }
}
