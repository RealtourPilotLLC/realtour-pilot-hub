// ---------------------------------------------------------------------------
// FIXTURE A4 (R06, Sep 28 2026): a PrismaClient given its URL in code.
//
// datasourceUrl and datasources.db.url never touch process.env, so no
// environment pin can see them. They reach the engine as datasourceOverrides,
// which is where the engine guard looks. Loopback still passes (the control:
// a dead 127.0.0.1 port answers P1001 from the engine itself).
//
// Second review (Sep 28 eve): the guard read only the URL's authority, and
// the engine lets a `host` / `hostaddr` query parameter override it. Each
// spelling below reached 203.0.113.10 before; each is refused now.
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { SENTINEL_URL } from "../../_isolation.cjs";
import { check, DUMMY_DB, DUMMY_WHERE, HOSTPARAM_DB, HOSTPARAM_WHERE, settle } from "./_check";

async function main() {
  const c = check("A4 · explicit client URLs");
  const refusedFor = (where: string) => (e: string) => e.includes(`DRILL ISOLATION: refused a Prisma connection to ${where}`);
  const clients: PrismaClient[] = [];
  const client = (o: ConstructorParameters<typeof PrismaClient>[0]) => { const p = new PrismaClient(o); clients.push(p); return p; };

  const a = client({ datasourceUrl: DUMMY_DB });
  const ra = await settle(() => a.$queryRaw`SELECT 1`);
  c.ok("new PrismaClient({ datasourceUrl }) → refused", refusedFor(DUMMY_WHERE)(ra.err) && ra.ms < 1500, `${ra.ms} ms · ${ra.err.slice(0, 90)}`);

  const b = client({ datasources: { db: { url: DUMMY_DB } } });
  const rb = await settle(() => b.$queryRaw`SELECT 1`);
  c.ok("new PrismaClient({ datasources: { db: { url } } }) → refused", refusedFor(DUMMY_WHERE)(rb.err) && rb.ms < 1500, `${rb.ms} ms`);
  const rbTx = await settle(() => b.$transaction(async (tx) => tx.$queryRaw`SELECT 1`));
  c.ok("…an interactive transaction on it too", rbTx.err.includes("DRILL ISOLATION"), rbTx.err.slice(0, 80));

  const named = client({ datasourceUrl: "postgresql://nobody:x@db.boundary.invalid:6543/none" });
  const rn = await settle(() => named.$queryRaw`SELECT 1`);
  c.ok("a host NAME is refused by name, before any DNS lookup", refusedFor("db.boundary.invalid:6543")(rn.err) && rn.ms < 1500, `${rn.ms} ms`);

  // ---- the query-parameter hosts (second review) ------------------------------
  // The other spellings sit on 127.0.0.1:1, where nothing listens: an engine
  // that ignored the parameter (Prisma may not read HOST= or hostaddr=) would
  // meet a closed port, never another builder's drill database.
  const loopbackAt = "postgresql://nobody:x@127.0.0.1:1/none";
  const spellings: [string, string, string][] = [
    ["?host=203.0.113.10 (the review's reproduction)", HOSTPARAM_DB, HOSTPARAM_WHERE],
    ["?HOST= in capitals", `${loopbackAt}?HOST=203.0.113.10&connect_timeout=2`, "203.0.113.10:1"],
    ["?hostaddr=", `${loopbackAt}?hostaddr=203.0.113.10&connect_timeout=2`, "203.0.113.10:1"],
    ["a host LIST that starts on loopback: ?host=127.0.0.1,203.0.113.10", `${loopbackAt}?host=127.0.0.1,203.0.113.10&connect_timeout=2`, "203.0.113.10:1"],
  ];
  for (const [label, url, where] of spellings) {
    const p = client({ datasourceUrl: url });
    const r = await settle(() => p.$queryRaw`SELECT 1`);
    c.ok(`NEW: datasourceUrl on 127.0.0.1 with ${label} → refused, naming ${where}, within 1.5 s`, refusedFor(where)(r.err) && r.ms < 1500 && !/P1001/.test(r.err), `${r.ms} ms · ${r.err.slice(0, 90)}`);
  }
  const viaDatasources = client({ datasources: { db: { url: HOSTPARAM_DB } } });
  const rv = await settle(() => viaDatasources.$queryRaw`SELECT 1`);
  c.ok("NEW: …and through datasources: { db: { url } }", refusedFor(HOSTPARAM_WHERE)(rv.err) && rv.ms < 1500, `${rv.ms} ms`);

  const s = client({ datasourceUrl: SENTINEL_URL });
  const rs = await settle(() => s.$queryRaw`SELECT 1`);
  c.ok("the sentinel itself → 'this drill has no database'", /this drill has no database/.test(rs.err));

  const loop = client({ datasourceUrl: "postgresql://nobody:x@127.0.0.1:1/none?connect_timeout=2" });
  const rl = await settle(() => loop.$queryRaw`SELECT 1`);
  c.ok("control: 127.0.0.1 is let through — the engine itself answers (nothing listens on :1)", !rl.err.includes("DRILL ISOLATION") && /127\.0\.0\.1:1/.test(rl.err), rl.err.slice(0, 90));
  const loopParam = client({ datasourceUrl: "postgresql://nobody:x@127.0.0.1:1/none?host=127.0.0.1&connect_timeout=2" });
  const rlp = await settle(() => loopParam.$queryRaw`SELECT 1`);
  c.ok("control: ?host=127.0.0.1 is let through too — the rule is every host, not 'no parameter'", !rlp.err.includes("DRILL ISOLATION") && /127\.0\.0\.1:1/.test(rlp.err), rlp.err.slice(0, 90));

  const d = await settle(async () => { for (const p of clients) await p.$disconnect(); });
  c.ok("$disconnect() on a refused client is clean", d.err === "no error", d.err);
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
