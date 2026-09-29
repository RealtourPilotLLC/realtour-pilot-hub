// ---------------------------------------------------------------------------
// FIXTURE A10 (R06 second review, Sep 28 2026 eve): a drill COPIED OUT of
// scripts/_drill/ and run with the preload.
//
// `npm run drills:boundary` copies this file into a fresh temp folder (with
// node_modules linked, as a scratchpad copy would have it) and runs it there
// with _drill-preload.cjs, handing it a 127.0.0.1 DATABASE_URL. The boundary
// used to switch on only under THIS checkout's scripts/_drill/, so the copy
// ran with the preload and no boundary at all: a query then went to whatever
// Prisma's .env load gave it — in a worktree, the MAIN tree's .env,
// production. Now every process that loads the preload is a root unless it
// is one of the named live probes, and a root takes the sentinel whatever
// database it was handed. The boundary file's path is argv[2] (this copy
// cannot reach it relatively); nothing here imports app code by alias.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import net from "node:net";
import { PrismaClient } from "@prisma/client";

type Iso = { SENTINEL_URL: string; state: () => { active: boolean; role: string; entry: string | null; drillEntry: boolean; blocked: string[] } };

function check(title: string) {
  let pass = 0;
  let fail = 0;
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
  return {
    ok(label: string, cond: boolean, detail = "") {
      if (cond) pass++;
      else fail++;
      console.log(`  ${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
      return cond;
    },
    done() {
      console.log(`\n${pass} passed, ${fail} failed\n`);
      process.exitCode = fail ? 1 : 0;
    },
  };
}

async function main() {
  const c = check("A10 · a drill copied outside scripts/_drill/, run with the preload");
  const iso = require(process.argv[2] ?? "") as Iso; // eslint-disable-line @typescript-eslint/no-require-imports -- a path handed in at run time
  const s = iso.state();
  c.ok("this copy is NOT under a scripts/_drill/ folder", !/[\\/]scripts[\\/]_drill[\\/]/.test(fs.realpathSync(__filename)), fs.realpathSync(__filename));
  c.ok("NEW: the boundary is on anyway — the copy is a ROOT (it used to be left 'inactive')", s.active && s.role === "root", JSON.stringify({ role: s.role, drillEntry: s.drillEntry }));
  c.ok("…and it saw THIS file as its entry", s.entry === fs.realpathSync(__filename), s.entry ?? "null");
  c.ok("NEW: handed a 127.0.0.1 DATABASE_URL by its caller, a root still starts on the sentinel", process.env.DATABASE_URL === iso.SENTINEL_URL && process.env.DIRECT_URL === iso.SENTINEL_URL);

  const p = new PrismaClient();
  const t0 = Date.now();
  const q = await p.$queryRaw`SELECT 1`.then(() => "CONNECTED", (e: Error) => String(e.message).replace(/\s+/g, " "));
  c.ok("a query is refused by the engine guard: 'this drill has no database'", /DRILL ISOLATION: this drill has no database/.test(q) && Date.now() - t0 < 1500, `${Date.now() - t0} ms · ${q.slice(0, 90)}`);
  await p.$disconnect();

  const raw = await new Promise<string>((resolve) => {
    const sock = new net.Socket();
    sock.once("error", (e) => resolve(e.message));
    sock.once("connect", () => { sock.destroy(); resolve("connected"); });
    sock.connect(5432, "203.0.113.10");
  });
  c.ok("a raw socket to 203.0.113.10 is refused", /OUTBOUND BLOCKED BY DRILL ISOLATION/.test(raw), raw.slice(0, 80));
  c.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
