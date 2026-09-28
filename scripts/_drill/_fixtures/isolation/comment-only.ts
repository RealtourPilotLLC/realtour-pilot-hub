// ---------------------------------------------------------------------------
// FIXTURE A1 (R06, Sep 28 2026): a drill that only MENTIONS isolation.
//
// The old lint (harness-selftest §H at 1075a5b) counted this file as booting
// its own database, because this comment says bootDrillDb( — and also
//   process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/x"
// — and neither of them runs. The file then imports Prisma STATICALLY and
// queries, which at 1075a5b reached whatever database Prisma's .env load
// named: production.
//
// `npm run drills:boundary` starts it as a ROOT with DATABASE_URL preset to an
// unreachable TEST-NET-3 host (so even a broken preload could only send a SYN
// there) and a dummy blob token. The boundary must refuse the query itself,
// fast, and the OS-level witness must see no socket. A9 runs this same query
// with the boundary taken away, to show the witness would have seen one.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { SENTINEL_URL, state } from "../../_isolation.cjs";
import { check, settle } from "./_check";

async function main() {
  const c = check("A1 · a comment is not isolation");
  const r = await settle(() => prisma.$queryRaw`SELECT 1`);
  c.ok("the query is refused by the boundary: 'this drill has no database'", /DRILL ISOLATION: this drill has no database/.test(r.err), r.err.slice(0, 110));
  c.ok("…within 1.5 s — a refusal, not a connect timeout", r.ms < 1500, `${r.ms} ms`);
  c.ok("DATABASE_URL is still the sentinel after the client was built (Prisma's .env load was a no-op)", process.env.DATABASE_URL === SENTINEL_URL);
  c.ok("DIRECT_URL too", process.env.DIRECT_URL === SENTINEL_URL);
  c.ok("BLOB_READ_WRITE_TOKEN, handed in with a value, is blank", process.env.BLOB_READ_WRITE_TOKEN === "");
  const s = state();
  c.ok("the boundary saw THIS file as its entry — argv[1] was absolute inside the preload", s.entry === fs.realpathSync(__filename), s.entry ?? "null");
  c.ok("…and ran as the root", s.role === "root" && s.drillEntry);
  c.ok("nothing was even attempted: the sentinel is refused before any connection, so no host is on record", s.blocked.length === 0, JSON.stringify(s.blocked));
  await prisma.$disconnect();
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
