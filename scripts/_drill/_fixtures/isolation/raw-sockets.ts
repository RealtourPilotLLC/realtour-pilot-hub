// ---------------------------------------------------------------------------
// FIXTURE A5 (R06, Sep 28 2026): every way JavaScript opens a socket.
//
// The harness fence patched net.connect, net.createConnection and tls.connect.
// pg opens `new net.Socket()` and calls .connect(port, host) on it
// (pg/lib/stream.js, connection.js), which none of those see; and an argument
// shape the harness could not parse fell through to the real connect. The
// boundary fences net.Socket.prototype.connect, which every one of these ends
// in, and fetch. Destinations are TEST-NET-3 and .invalid names only. The
// controls — a loopback server, a unix socket, a local fetch — must still work.
//
// Second review (Sep 28 eve): the fence read a string port that was not all
// digits as a unix pipe name and let it through, while Node reads "5432\n",
// " 5432", "0x1538" and "5432.0" as TCP port 5432 — four SYNs went out. The
// fence now reads the arguments with Node's own normalizer.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import Module from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { REPO, state } from "../../_isolation.cjs";
import { check } from "./_check";

const BLOCKED = /OUTBOUND BLOCKED BY DRILL ISOLATION/;

/** The first error (or "connected") a socket reports, and when. */
function outcome(open: () => net.Socket | http.ClientRequest): Promise<{ ms: number; msg: string }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (msg: string) => { if (!done) { done = true; resolve({ ms: Date.now() - t0, msg }); } };
    let s: net.Socket | http.ClientRequest;
    try { s = open(); } catch (e) { finish(`threw: ${(e as Error).message}`); return; }
    s.on("error", (e: Error) => finish(e.message));
    if (s instanceof net.Socket) s.on("connect", () => { finish("connected"); s.destroy(); });
    else s.on("response", (res) => { res.resume(); finish(`response ${res.statusCode}`); });
    setTimeout(() => { finish("no answer in 3 s"); (s as net.Socket).destroy?.(); }, 3000).unref();
  });
}

async function main() {
  const c = check("A5 · raw sockets, TLS, http(s), fetch");
  const cases: [string, () => net.Socket | http.ClientRequest][] = [
    ["net.connect(5432, '203.0.113.10')", () => net.connect(5432, "203.0.113.10")],
    ["net.createConnection({ port, host })", () => net.createConnection({ port: 5432, host: "203.0.113.10" })],
    ["new net.Socket().connect(5432, '203.0.113.10') — pg's shape", () => new net.Socket().connect(5432, "203.0.113.10")],
    ["new net.Socket().connect({ port, host })", () => new net.Socket().connect({ port: 5432, host: "203.0.113.10" })],
    ["tls.connect(443, 'db.boundary.invalid')", () => tls.connect(443, "db.boundary.invalid")],
    ["https.get('https://db.boundary.invalid/')", () => https.get("https://db.boundary.invalid/")],
    ["http.get('http://203.0.113.10:5432/')", () => http.get("http://203.0.113.10:5432/")],
    ["'localhost' with a lookup that answers 203.0.113.10", () => net.connect({ port: 5432, host: "localhost", lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, "203.0.113.10", 4) } as net.NetConnectOpts)],
    // NEW: string ports Node takes as numbers (a port read from a file or an env var).
    ...["5432\n", " 5432", "0x1538", "5432.0"].map((port): [string, () => net.Socket] => [
      `NEW: new net.Socket().connect(${JSON.stringify(port)}, '203.0.113.10') — Node reads that as port ${Number(port)}`,
      () => { const sock = new net.Socket(); return (sock.connect as unknown as (...a: unknown[]) => net.Socket).call(sock, port, "203.0.113.10"); },
    ]),
    ["NEW: net.connect('5432\\n', '203.0.113.10')", () => (net.connect as unknown as (...a: unknown[]) => net.Socket)("5432\n", "203.0.113.10")],
  ];
  for (const [label, open] of cases) {
    const r = await outcome(open);
    c.ok(`${label} → refused within 500 ms`, BLOCKED.test(r.msg) && r.ms < 500, `${r.ms} ms · ${r.msg.slice(0, 90)}`);
  }

  const f0 = Date.now();
  const viaFetch = await fetch("http://203.0.113.10:5432/").then(() => "answered", (e: Error) => e.message);
  c.ok("fetch('http://203.0.113.10:5432/') → refused", BLOCKED.test(viaFetch) && Date.now() - f0 < 500, viaFetch.slice(0, 90));

  // pg itself, when tools/realpg has it.
  const realpg = path.join(REPO, "tools", "realpg", "package.json");
  if (fs.existsSync(path.join(REPO, "tools", "realpg", "node_modules", "pg"))) {
    const pg = Module.createRequire(realpg)("pg") as { Client: new (o: object) => { connect: () => Promise<void>; end: () => Promise<void> } };
    const client = new pg.Client({ host: "203.0.113.10", port: 5432, user: "nobody", password: "x", database: "none", connectionTimeoutMillis: 2000 });
    const p0 = Date.now();
    const viaPg = await client.connect().then(() => "connected", (e: Error) => e.message);
    c.ok("pg.Client.connect() to 203.0.113.10 → refused", BLOCKED.test(viaPg) && Date.now() - p0 < 500, `${Date.now() - p0} ms · ${viaPg.slice(0, 80)}`);
    await client.end().catch(() => {});
  } else {
    console.log("    (tools/realpg not installed: the pg client case is covered by the new net.Socket() shape above)");
  }

  // Controls: loopback and unix sockets still connect.
  const server = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  const loop = await outcome(() => net.connect(port, "127.0.0.1"));
  c.ok("control: a loopback TCP connection still connects", loop.msg === "connected", loop.msg);
  const byName = await outcome(() => new net.Socket().connect(port, "localhost"));
  c.ok("control: 'localhost' still connects", byName.msg === "connected" || /ECONNREFUSED ::1/.test(byName.msg), byName.msg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-a5-"));
  const sock = path.join(dir, "s.sock");
  const unix = net.createServer((s) => s.end()).listen(sock);
  await new Promise((r) => unix.once("listening", r));
  const viaUnix = await outcome(() => net.connect(sock));
  c.ok("control: a unix socket still connects", viaUnix.msg === "connected", viaUnix.msg);
  const web = http.createServer((_q, res) => res.end("ok")).listen(0, "127.0.0.1");
  await new Promise((r) => web.once("listening", r));
  const local = await fetch(`http://127.0.0.1:${(web.address() as net.AddressInfo).port}/`).then((r) => r.text(), (e: Error) => e.message);
  c.ok("control: a loopback fetch still answers", local === "ok", local);
  server.close();
  unix.close();
  web.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const blocked = state().blocked;
  c.ok("every refusal is on record (tcp, tls, http, fetch)", ["tcp://203.0.113.10:5432", "tls://db.boundary.invalid:443", "http://203.0.113.10:5432/"].every((b) => blocked.includes(b)), `${blocked.length}: ${blocked.slice(0, 6).join(", ")}`);
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
