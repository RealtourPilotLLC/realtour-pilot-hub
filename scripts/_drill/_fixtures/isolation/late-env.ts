// ---------------------------------------------------------------------------
// FIXTURE A3 (R06, Sep 28 2026): DATABASE_URL set LATE, after the preload.
//
// Pinning the environment at start is not enough on its own: a drill can set
// DATABASE_URL to anything afterwards (cp15 does, on purpose, for a moment).
// The Prisma engine guard judges the URL the engine is actually built with,
// and the src/lib/prisma.ts backstop refuses one step earlier. The URL is an
// unreachable TEST-NET-3 address: a failure here would be a 2 s P1001, never
// a connection anywhere.
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { state } from "../../_isolation.cjs";
import { check, DUMMY_DB, DUMMY_WHERE, settle } from "./_check";

async function main() {
  const c = check("A3 · a non-loopback DATABASE_URL set after the preload");
  process.env.DATABASE_URL = DUMMY_DB;
  process.env.DIRECT_URL = DUMMY_DB;

  const p = new PrismaClient();
  const r = await settle(() => p.$queryRaw`SELECT 1`);
  c.ok(`a client built now is refused by the engine guard: 'refused a Prisma connection to ${DUMMY_WHERE}'`, r.err.includes(`DRILL ISOLATION: refused a Prisma connection to ${DUMMY_WHERE}`), r.err.slice(0, 120));
  c.ok("…within 1.5 s, with no P1001 (no connection was tried)", r.ms < 1500 && !/P1001|Can't reach database server/.test(r.err), `${r.ms} ms`);
  const again = await settle(() => p.programAiRun.count());
  c.ok("every later query on it is refused again", again.err.includes("DRILL ISOLATION: refused a Prisma connection"), again.err.slice(0, 80));
  await p.$disconnect();

  const imp = await settle(() => import("@/lib/prisma"));
  c.ok("importing @/lib/prisma now is refused at import by the backstop", imp.err.includes(`DRILL ISOLATION: refused a Prisma connection to ${DUMMY_WHERE}`), imp.err.slice(0, 120));

  const s = state();
  c.ok("the engine guard's refusal is on record", s.blocked.includes(`prisma://${DUMMY_WHERE}`), JSON.stringify(s.blocked));
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
