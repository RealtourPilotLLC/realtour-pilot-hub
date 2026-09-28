// ---------------------------------------------------------------------------
// FIXTURE A4 (R06, Sep 28 2026): a PrismaClient given its URL in code.
//
// datasourceUrl and datasources.db.url never touch process.env, so no
// environment pin can see them. They reach the engine as datasourceOverrides,
// which is where the engine guard looks. Loopback still passes (the control:
// a dead 127.0.0.1 port answers P1001 from the engine itself).
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { SENTINEL_URL } from "../../_isolation.cjs";
import { check, DUMMY_DB, DUMMY_WHERE, settle } from "./_check";

async function main() {
  const c = check("A4 · explicit client URLs");
  const refusedFor = (where: string) => (e: string) => e.includes(`DRILL ISOLATION: refused a Prisma connection to ${where}`);

  const a = new PrismaClient({ datasourceUrl: DUMMY_DB });
  const ra = await settle(() => a.$queryRaw`SELECT 1`);
  c.ok("new PrismaClient({ datasourceUrl }) → refused", refusedFor(DUMMY_WHERE)(ra.err) && ra.ms < 1500, `${ra.ms} ms · ${ra.err.slice(0, 90)}`);

  const b = new PrismaClient({ datasources: { db: { url: DUMMY_DB } } });
  const rb = await settle(() => b.$queryRaw`SELECT 1`);
  c.ok("new PrismaClient({ datasources: { db: { url } } }) → refused", refusedFor(DUMMY_WHERE)(rb.err) && rb.ms < 1500, `${rb.ms} ms`);
  const rbTx = await settle(() => b.$transaction(async (tx) => tx.$queryRaw`SELECT 1`));
  c.ok("…an interactive transaction on it too", rbTx.err.includes("DRILL ISOLATION"), rbTx.err.slice(0, 80));

  const named = new PrismaClient({ datasourceUrl: "postgresql://nobody:x@db.boundary.invalid:6543/none" });
  const rn = await settle(() => named.$queryRaw`SELECT 1`);
  c.ok("a host NAME is refused by name, before any DNS lookup", refusedFor("db.boundary.invalid:6543")(rn.err) && rn.ms < 1500, `${rn.ms} ms`);

  const s = new PrismaClient({ datasourceUrl: SENTINEL_URL });
  const rs = await settle(() => s.$queryRaw`SELECT 1`);
  c.ok("the sentinel itself → 'this drill has no database'", /this drill has no database/.test(rs.err));

  const loop = new PrismaClient({ datasourceUrl: "postgresql://nobody:x@127.0.0.1:1/none?connect_timeout=2" });
  const rl = await settle(() => loop.$queryRaw`SELECT 1`);
  c.ok("control: 127.0.0.1 is let through — the engine itself answers (nothing listens on :1)", !rl.err.includes("DRILL ISOLATION") && /127\.0\.0\.1:1/.test(rl.err), rl.err.slice(0, 90));

  const d = await settle(async () => { await a.$disconnect(); await b.$disconnect(); await named.$disconnect(); await s.$disconnect(); await loop.$disconnect(); });
  c.ok("$disconnect() on a refused client is clean", d.err === "no error", d.err);
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
