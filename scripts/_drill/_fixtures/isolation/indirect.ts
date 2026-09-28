// ---------------------------------------------------------------------------
// FIXTURE A2 (R06, Sep 28 2026): a drill that reaches the database INDIRECTLY.
//
// Nothing in this file names the ORM, its client or a database variable, so
// the old lint read it as database-free. It imports an app module
// (cronHealth, whose own import of the app's Prisma module builds a client at
// import) and calls it. Five real drills had this shape (a01-digest-packing,
// a07-appointment-evidence, the three r02-*); at 1075a5b they were safe only
// because the functions they called happened not to query. This one queries.
// ---------------------------------------------------------------------------
import { cronHealthByJob } from "@/lib/cronHealth";
import { state } from "../../_isolation.cjs";
import { check, settle } from "./_check";

async function main() {
  const c = check("A2 · reaching the database through an app import");
  const r = await settle(() => cronHealthByJob(10));
  c.ok("the app function's query is refused: 'this drill has no database' (it was on the sentinel)", /DRILL ISOLATION: this drill has no database/.test(r.err), r.err.slice(0, 110));
  c.ok("…within 1.5 s", r.ms < 1500, `${r.ms} ms`);
  c.ok("the boundary is the root here", state().role === "root");
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
