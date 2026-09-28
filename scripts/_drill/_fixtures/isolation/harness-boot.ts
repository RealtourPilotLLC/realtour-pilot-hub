// ---------------------------------------------------------------------------
// FIXTURE A8 (R06, Sep 28 2026): a drill run by hand WITHOUT the preload.
//
// `npm run drills:boundary` starts this with plain tsx, no --require. The
// boundary is therefore off, and the harness must refuse to boot a database
// into a process with no boundary under it — before PGlite starts, before the
// schema push — rather than run half-isolated. (Port 6272 is never bound.)
// ---------------------------------------------------------------------------
import { bootDrillDb, portFree } from "../../_harness";
import { state } from "../../_isolation.cjs";
import { check, settle } from "./_check";

const PORT = 6272;

async function main() {
  const c = check("A8 · bootDrillDb without the boundary");
  if (!c.ok("the boundary is off in this process (started without the preload)", !state().active, JSON.stringify(state()))) {
    c.done();
    return;
  }
  const r = await settle(async () => { const d = await bootDrillDb({ port: PORT }); await d.stop(); return "booted"; });
  c.ok("bootDrillDb refuses: 'DRILL ISOLATION is not active in this process (bootDrillDb)'", /DRILL ISOLATION is not active in this process \(bootDrillDb\)/.test(r.err), r.err.slice(0, 120));
  c.ok("…and it said how to run it", r.err.includes("npm run drills"));
  c.ok("…before PGlite started: the port was never bound", await portFree(PORT));
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
