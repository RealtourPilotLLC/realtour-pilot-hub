// ---------------------------------------------------------------------------
// FIXTURE A3 (R06, Sep 28 2026): DATABASE_URL set LATE, after the preload.
//
// Pinning the environment at start is not enough on its own: a drill can set
// DATABASE_URL to anything afterwards (cp15 does, on purpose, for a moment).
// The Prisma engine guard judges the URL the engine is actually built with,
// and the src/lib/prisma.ts backstop refuses one step earlier. The URL is an
// unreachable TEST-NET-3 address: a failure here would be a 2 s P1001, never
// a connection anywhere.
//
// Second review (Sep 28 eve): a URL on 127.0.0.1 whose `?host=` parameter is
// 203.0.113.10 passed both, because they read only the authority — and the
// engine followed the parameter (SYN_SENT to 203.0.113.10). Both now read
// every host the URL can reach.
// ---------------------------------------------------------------------------
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { REPO, state } from "../../_isolation.cjs";
import { check, DUMMY_DB, DUMMY_WHERE, HOSTPARAM_DB, HOSTPARAM_WHERE, settle } from "./_check";

/** Load src/lib/prisma.ts afresh — its backstop runs at load, and a module
 *  that threw is not cached (the entry is dropped here as well, to be sure;
 *  a dynamic import() would replay the FIRST error instead). */
const loadPrismaModule = () => settle(async () => {
  const file = path.join(REPO, "src", "lib", "prisma.ts");
  delete require.cache[file];
  return require(file) as unknown; // eslint-disable-line @typescript-eslint/no-require-imports -- a fresh load, on purpose
});

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

  const imp = await loadPrismaModule();
  c.ok("importing @/lib/prisma now is refused at import by the backstop", imp.err.includes(`DRILL ISOLATION: refused a Prisma connection to ${DUMMY_WHERE}`), imp.err.slice(0, 120));

  // The second review's shape: 127.0.0.1 in the authority, 203.0.113.10 in ?host=.
  process.env.DATABASE_URL = HOSTPARAM_DB;
  process.env.DIRECT_URL = HOSTPARAM_DB;
  const h = new PrismaClient();
  const rh = await settle(() => h.$queryRaw`SELECT 1`);
  c.ok(`NEW: a 127.0.0.1 URL whose ?host= is 203.0.113.10 is refused by the engine guard, naming ${HOSTPARAM_WHERE}`, rh.err.includes(`DRILL ISOLATION: refused a Prisma connection to ${HOSTPARAM_WHERE}`), rh.err.slice(0, 120));
  c.ok("…within 1.5 s, with no P1001 (the engine never tried 203.0.113.10)", rh.ms < 1500 && !/P1001|Can't reach database server/.test(rh.err), `${rh.ms} ms`);
  await h.$disconnect();
  const imp2 = await loadPrismaModule();
  c.ok("NEW: …and the @/lib/prisma backstop refuses it at import (it read only the authority)", imp2.err.includes(`DRILL ISOLATION: refused a Prisma connection to ${HOSTPARAM_WHERE}`), imp2.err.slice(0, 120));

  const s = state();
  c.ok("both engine refusals are on record", s.blocked.includes(`prisma://${DUMMY_WHERE}`) && s.blocked.includes(`prisma://${HOSTPARAM_WHERE}`), JSON.stringify(s.blocked));
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
