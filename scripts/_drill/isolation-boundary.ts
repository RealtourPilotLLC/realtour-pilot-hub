// ---------------------------------------------------------------------------
// DRILL: THE ISOLATION BOUNDARY, FROM INSIDE THE SUITE (R06, Sep 28 2026).
//
//   npm run drills -- scripts/_drill/isolation-boundary.ts
//   npm run drills:boundary      (the fixtures A1-A10 as roots, the OLD
//                                 shapes A9-A9c, then this)
//
// The external review (Sep 28) found that "a drill cannot reach production"
// was a text scan (harness-selftest §H) presented as proof, over a preload
// with no isolation in it, a fence that missed pg's socket shape, and nothing
// at all in front of Prisma's native engine. The control is now
// scripts/_drill/_isolation.cjs, loaded before every drill and every process a
// drill starts. `npm run drills:boundary` proves it the way it is used — the
// fixtures in _fixtures/isolation/ started as ROOT processes against an
// unreachable TEST-NET-3 database, with an lsof witness — and this drill
// proves the rest from inside a normal run:
//
//   1. OLD vs NEW lint: the §H scan at 1075a5b (git show, run as it was)
//      passes a comment-only file, a production-shaped file that mentions
//      bootDrillDb in a comment, and never sees an indirect Prisma import; the
//      new lint strips comments, FAILS the production shape, REPORTS the rest.
//   2. who is isolated: the decide() truth table — every process that loads
//      the preload is a root (a drill copied anywhere, another checkout's),
//      except the named live probes, the demo, the launchers and the runner,
//      which are left alone unless a drill started them.
//   3. the URL rules (sentinel, 127.0.0.1 only for a database — EVERY host
//      the URL can reach, ?host= / ?hostaddr= included), and a root's env.
//   4. the pure child and engine rules the boundary applies, and the socket
//      fence's reading of a string port.
// Sections 2-4 run the same inputs through the FIRST R06 build (c52d4a2, git
// show) to show each hole the second review found (Sep 28 eve) was real
// there; run-all's A9c shows the same holes really sending SYNs.
//   5. the harness fence is now a LAYER: its own catches keep their old
//      message, the pg shape it used to miss is caught underneath and still
//      listed in fence.blocked, and fence.restore() does not open the network.
//   6. a normal bootDrillDb drill still works on top of the sentinel; a NEW
//      client on a remote URL set late is refused while the booted one answers.
//   7. runDrillChild: the child is a descendant on the parent's loopback
//      database (not the sentinel), and its refusals — a fetch, a raw socket,
//      a Prisma engine — reach the parent's fence.
//   8. the runner's verdicts: a SKIPPED run fails the suite unless skips are
//      accepted, a drill with no tally is RAN (not PASS), and any failing
//      tally line fails the run — each against the first build's runner.
//
// ISOLATION: PGlite on 127.0.0.1:6270; the only "remote" destinations are
// 203.0.113.10 (TEST-NET-3) and *.invalid names, all refused before any byte
// leaves. Nothing reads or prints a .env value.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { attachDrillChild, assertLoopbackDbUrl as harnessAssert, bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import {
  assertLoopbackDbUrl, childVerdict, connectTarget, dbHostsOf, decide, DRILL_DIR, isDrillDbUrl, judgeEngineConfig, MARKER, pinOwnEnv, REPO,
  repinChildEnv, secretKeyNames, SELF, SENTINEL_URL, state, withIsolationRequire,
} from "./_isolation.cjs";
import type * as Isolation from "./_isolation.cjs";
import { drillSourceShape, stripComments } from "./_isolationLint";
import { drillVerdict, suiteExitCode } from "./run-all.cjs";

const PORT = 6270;
const BASE = "1075a5b"; // the handoff HEAD the review read — never HEAD
const FIRST_BUILD = "c52d4a2"; // the first R06 boundary, the one the second review (Sep 28 eve) tested
const DUMMY = "postgresql://drill:dummy@203.0.113.10:5432/none?connect_timeout=2&sslmode=disable";
const HOSTPARAM = "postgresql://drill:dummy@127.0.0.1:6279/none?host=203.0.113.10&connect_timeout=2&sslmode=disable";
const STAND_IN_SECRET = "drill-app-secret-not-a-real-key-0123456789abcdef";
const c = makeChecker();
installNextStubs();

const threw = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const errOf = async (p: () => Promise<unknown>) => { try { await p(); return "no error"; } catch (e) { return String((e as Error).message).replace(/\s+/g, " "); } };
/** The FIRST R06 boundary (c52d4a2) as a module, for its pure rules only. It
 *  is required from a temp copy; its bottom line would activate() in a marked
 *  process, but this process's boundary already holds the global key, so it
 *  installs nothing. */
function firstBuild(): { mod: typeof Isolation; src: string } {
  const src = execFileSync("git", ["show", `${FIRST_BUILD}:scripts/_drill/_isolation.cjs`], { cwd: REPO, encoding: "utf8" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-iso-first-"));
  try {
    const file = path.join(dir, `_isolation.${FIRST_BUILD}.cjs`);
    fs.writeFileSync(file, src);
    return { mod: createRequire(__filename)(file) as typeof Isolation, src };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
/** The first error (or "connected") a socket reports. */
const sock = (open: () => net.Socket) => new Promise<string>((resolve) => {
  const s = open();
  s.once("error", (e) => resolve(e.message));
  s.once("connect", () => { s.destroy(); resolve("connected"); });
});

async function main() {
  c.head("0 · this process");
  const me = state();
  c.ok("the boundary is on, and this drill is its root", me.active && me.role === "root" && me.drillEntry, JSON.stringify({ role: me.role }));
  c.ok("DATABASE_URL starts as the sentinel", process.env.DATABASE_URL === SENTINEL_URL);
  c.ok("children inherit it: the marker is set and NODE_OPTIONS carries the isolation preload", process.env[MARKER] === "1" && (process.env.NODE_OPTIONS ?? "").includes(SELF));
  c.ok("no provider key has a value here", secretKeyNames().every((k) => !process.env[k] || ["APP_SECRET", "NEXT_PUBLIC_APP_URL", "CRON_SECRET"].includes(k)), `${secretKeyNames().length} keys`);

  // =========================================================================
  c.head("1 · OLD vs NEW: the §H text scan, and the lint that replaces it");
  {
    const head = execFileSync("git", ["show", `${BASE}:scripts/_drill/harness-selftest.ts`], { cwd: REPO, encoding: "utf8" });
    const m = /const shape = \(src: string\) => \{([\s\S]*?)\n {4}\};/.exec(head);
    c.ok(`OLD: §H's shape() read out of ${BASE} as it was`, !!m, m ? `${m[1].trim().split("\n").length} lines` : "not found");
    const oldShape = new Function("src", m ? m[1] : "return null;") as (src: string) => boolean;
    const fixture = (f: string) => fs.readFileSync(path.join(DRILL_DIR, "_fixtures", "isolation", f), "utf8");
    const commentOnly = fixture("comment-only.ts");
    const indirect = fixture("indirect.ts");
    const productionShape = [
      "// This drill boots its own database: bootDrillDb( is called below. (It is not.)",
      'import { pinReadOnlyDatabaseUrl } from "../_lib/dbGuard";',
      "pinReadOnlyDatabaseUrl();",
      'const { prisma } = await import("@/lib/prisma");',
    ].join("\n");
    const liveImport = 'import { owedNow } from "../_live/f03-owed-now";\nconsole.log(owedNow);';
    const realDrill = fs.readFileSync(path.join(DRILL_DIR, "harness-selftest.ts"), "utf8");

    c.ok("OLD: a file whose only 'isolation' is a COMMENT passes the scan (A1)", oldShape(commentOnly) === false);
    c.ok("OLD: a production-shaped file (.env DATABASE_URL, read-only) passes it too, because a comment says bootDrillDb(", oldShape(productionShape) === false);
    c.ok("OLD: a drill reaching Prisma through an app import is not even counted as touching a database (A2)", !/@\/lib\/prisma|@prisma\/client|PrismaClient|DATABASE_URL/.test(indirect) && oldShape(indirect) === false);
    const realIndirect = execFileSync("git", ["show", `${BASE}:scripts/_drill/a01-digest-packing.ts`], { cwd: REPO, encoding: "utf8" });
    const notify = execFileSync("git", ["show", `${BASE}:src/lib/notify.ts`], { cwd: REPO, encoding: "utf8" });
    c.ok(`OLD: the same for a real drill — a01-digest-packing at ${BASE} imports src/lib/notify, which imports @/lib/prisma, and the scan passed it`,
      /from "\.\.\/\.\.\/src\/lib\/notify"/.test(realIndirect) && /from "@\/lib\/prisma"/.test(notify) && oldShape(realIndirect) === false);

    const n1 = drillSourceShape(commentOnly);
    c.ok("NEW: comments are stripped, so A1 is seen for what it is — app code, no database booted — and REPORTED", n1.production.length === 0 && n1.notes.some((x) => /without booting a database/.test(x)), n1.notes.join("; "));
    const n2 = drillSourceShape(productionShape);
    c.ok("NEW: the production shape FAILS the lint", n2.production.some((x) => /readDatabaseUrl\/pinReadOnlyDatabaseUrl/.test(x)), n2.production.join("; "));
    c.ok("NEW: an import from scripts/_live FAILS it", drillSourceShape(liveImport).production.some((x) => /_live/.test(x)));
    const n3 = drillSourceShape(indirect);
    c.ok("NEW: the indirect import is reported (it runs on the sentinel)", n3.production.length === 0 && n3.notes.length === 1);
    const n4 = drillSourceShape(realDrill);
    c.ok("NEW: a real booting drill (harness-selftest) is clean", n4.production.length === 0 && n4.notes.length === 0, [...n4.production, ...n4.notes].join("; ") || "clean");
    const stripped = stripComments('const a = "http://x.invalid//p"; // bootDrillDb(\nconst r = /["\']\\/\\//; /* PGlite.create( */ const b = 1;');
    c.ok("the comment stripper keeps strings and regexes (a URL's // is not a comment) and drops comments", stripped.includes('"http://x.invalid//p"') && stripped.includes("/[\"']\\/\\//") && !stripped.includes("bootDrillDb") && !stripped.includes("PGlite"), stripped.replace(/\s+/g, " "));
    const cp15 = drillSourceShape(fs.readFileSync(path.join(DRILL_DIR, "cp15-seed-and-probe.ts"), "utf8"));
    c.ok("cp15's deliberate hosted-looking DATABASE_URL is reported, not failed (the engine guard refuses it at runtime)", cp15.production.length === 0 && cp15.notes.some((x) => /non-loopback literal/.test(x)), cp15.notes.join("; "));
  }

  // =========================================================================
  c.head("2 · who is isolated: decide()");
  const first = firstBuild();
  const old = first.mod;
  c.ok(`the first R06 build (${FIRST_BUILD}) loads beside this one, for comparison only (its activate() finds this boundary and installs nothing)`, typeof old.decide === "function" && old.decide !== decide && old.childVerdict !== childVerdict);
  {
    const on = { [MARKER]: "1" };
    const p = (...s: string[]) => path.join(REPO, ...s);
    const scratch = path.join(os.tmpdir(), "claude-scratchpad", "copy-of-a01-digest-packing.ts");
    const otherCheckout = "/Users/someone/other-checkout/scripts/_drill/a01-digest-packing.ts";
    const table: [string, string | null, Record<string, string>, string, boolean?][] = [
      ["a drill", p("scripts/_drill/a01-digest-packing.ts"), {}, "root", true],
      ["a drill started by a drill", p("scripts/_drill/a01-digest-packing.ts"), on, "descendant", true],
      ["a boundary fixture (any depth under scripts/_drill)", p("scripts/_drill/_fixtures/isolation/comment-only.ts"), {}, "root", true],
      ["a scratch copy of a drill", p("scripts/_drill/zz-scratch-r06-x.ts"), {}, "root", true],
      ["restore-rehearsal (an isolated tool)", p("scripts/restore-rehearsal.ts"), {}, "root", true],
      ["NEW: a drill COPIED OUTSIDE scripts/_drill (a scratchpad) — was inactive", scratch, {}, "root", false],
      ["NEW: another checkout's drill (any scripts/_drill/ folder) — was inactive", otherCheckout, {}, "root", true],
      ["NEW: a sibling folder sharing the prefix (scripts/_drill-old/) — was inactive", p("scripts/_drill-old/x.ts"), {}, "root", false],
      ["NEW: any other script run with the preload (scripts/backup-all.ts) — was inactive", p("scripts/backup-all.ts"), {}, "root", false],
      ["NEW: a copy hidden under node_modules/.cache — was inactive", p("node_modules/.cache/x/drill.ts"), {}, "root", false],
      ["a scripts/_live probe", p("scripts/_live/f03-owed-now.ts"), {}, "inactive"],
      ["…the same probe started BY a drill", p("scripts/_live/f03-owed-now.ts"), on, "descendant", false],
      ["a scripts/_recon probe", p("scripts/_recon/cp15-config-probe.ts"), {}, "inactive"],
      ["…started by a drill", p("scripts/_recon/cp15-config-probe.ts"), on, "descendant", false],
      ["a scripts/_probe probe", p("scripts/_probe/aryeo-webhook-health.ts"), {}, "inactive"],
      ["a scripts/_fix probe", p("scripts/_fix/R07/probe-ledger.ts"), {}, "inactive"],
      ["another worktree's scripts/_live probe", "/Users/someone/other-checkout/scripts/_live/f27-anchor.ts", {}, "inactive"],
      ["the isolated demo", p("scripts/demo/isolated-demo.ts"), {}, "inactive"],
      ["create-test-client", p("scripts/create-test-client.ts"), {}, "inactive"],
      ["the runner itself", p("scripts/_drill/run-all.cjs"), {}, "inactive"],
      ["npx, when the preload is in NODE_OPTIONS (probe-ledger's shape)", "/Users/x/.nvm/versions/node/v20.20.2/lib/node_modules/npm/bin/npx-cli.js", {}, "inactive"],
      ["tsx's CLI, likewise", p("node_modules/tsx/dist/cli.mjs"), {}, "inactive"],
      ["node -e / a worker (no entry)", null, {}, "inactive"],
      ["…inside a drill's tree", null, on, "descendant", false],
      ["the Prisma CLI a drill runs", p("node_modules/prisma/build/index.js"), on, "descendant", false],
    ];
    for (const [label, entry, env, want, drillEntry] of table) {
      const got = decide({ entry, env });
      const ok = got.role === want && (drillEntry === undefined || got.drillEntry === drillEntry);
      c.ok(`${label} → ${want}${drillEntry === undefined ? "" : drillEntry ? " (a drill)" : " (not a drill)"}`, ok, ok ? "" : `got ${JSON.stringify(got)}`);
    }
    const oldDecide = (entry: string) => old.decide({ entry, env: {}, drillDir: DRILL_DIR } as unknown as Parameters<typeof decide>[0]).role;
    c.ok(`OLD (${FIRST_BUILD}): the scratchpad copy, another checkout's drill and a node_modules copy were all 'inactive' — the preload loaded, no boundary`,
      [scratch, otherCheckout, p("node_modules/.cache/x/drill.ts")].every((e) => oldDecide(e) === "inactive"));
  }

  // =========================================================================
  c.head("3 · the URL rules");
  {
    const loop = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
    c.ok("a drill database is 127.0.0.1 and not the sentinel", isDrillDbUrl(loop) && !isDrillDbUrl(SENTINEL_URL));
    c.ok("…never localhost, [::1], Neon, TEST-NET, empty or unparsable", ["postgresql://p@localhost:5432/d", "postgresql://p@[::1]:5432/d", "postgresql://x@ep-fake.us-east-2.aws.neon.tech/db", DUMMY, "", "not a url"].every((u) => !isDrillDbUrl(u)));
    c.ok("assertLoopbackDbUrl: 127.0.0.1 passes — the sentinel too, harmlessly (nothing listens on :9)", !threw(() => assertLoopbackDbUrl(loop)) && !threw(() => assertLoopbackDbUrl(SENTINEL_URL)));
    c.ok("…localhost, [::1], Neon and 203.0.113.10 are refused", ["postgresql://p@localhost:5432/d", "postgresql://p@[::1]:5432/d", "postgresql://x@ep-fake.us-east-2.aws.neon.tech/db", DUMMY].every((u) => threw(() => assertLoopbackDbUrl(u))));
    c.ok("…and the harness export IS that function (one check, not two)", harnessAssert === assertLoopbackDbUrl);

    // The second review: a query parameter overrides the authority.
    const at = `postgresql://p:x@127.0.0.1:${PORT}/d`;
    const paramUrls = [HOSTPARAM, `${at}?HOST=203.0.113.10`, `${at}?hostaddr=203.0.113.10`, `${at}?host=127.0.0.1,203.0.113.10`, `${at}?sslmode=disable&host=ep-fake.us-east-2.aws.neon.tech`, `${at}?h%6Fst=203.0.113.10`];
    c.ok("dbHostsOf reads the authority AND every host / hostaddr value", JSON.stringify(dbHostsOf(`${at}?host=127.0.0.1,203.0.113.10&hostaddr=198.51.100.7`)) === JSON.stringify(["127.0.0.1", "127.0.0.1", "203.0.113.10", "198.51.100.7"]));
    c.ok("NEW: isDrillDbUrl refuses a 127.0.0.1 URL whose ?host= / ?HOST= / ?hostaddr= / host list / encoded key leaves loopback", paramUrls.every((u) => !isDrillDbUrl(u)));
    c.ok("NEW: …and so does assertLoopbackDbUrl, naming the parameter's host", paramUrls.every((u) => threw(() => assertLoopbackDbUrl(u))) && (() => { try { assertLoopbackDbUrl(HOSTPARAM); return false; } catch (e) { return /refusing to push a schema to 203\.0\.113\.10:/.test((e as Error).message); } })());
    c.ok("…while ?host=127.0.0.1 is still a drill database (the rule is every host, not 'no parameter')", isDrillDbUrl(`${at}?host=127.0.0.1`) && !threw(() => assertLoopbackDbUrl(`${at}?host=127.0.0.1`)));
    c.ok(`OLD (${FIRST_BUILD}): every one of those passed as a drill database, and the schema-push check let them through`,
      paramUrls.every((u) => old.isDrillDbUrl(u) && !threw(() => old.assertLoopbackDbUrl(u))));

    // A root's own environment.
    const handed = { DATABASE_URL: loop, DIRECT_URL: loop, PGHOST: "203.0.113.10", PGPASSWORD: "x" } as Record<string, string | undefined>;
    pinOwnEnv(handed, "root", true);
    c.ok("NEW: a ROOT handed a 127.0.0.1 DATABASE_URL by its caller takes the sentinel anyway (a local tunnel to Neon sits on 127.0.0.1 too)", handed.DATABASE_URL === SENTINEL_URL && handed.DIRECT_URL === SENTINEL_URL);
    c.ok("NEW: …and loses libpq's routing and credentials (PGHOST, PGPASSWORD…)", handed.PGHOST === undefined && handed.PGPASSWORD === undefined);
    const child = { DATABASE_URL: loop } as Record<string, string | undefined>;
    pinOwnEnv(child, "descendant", true);
    const childParam = { DATABASE_URL: HOSTPARAM } as Record<string, string | undefined>;
    pinOwnEnv(childParam, "descendant", true);
    c.ok("a DRILL DESCENDANT keeps the loopback database its parent booted — but not one whose ?host= leaves loopback", child.DATABASE_URL === loop && childParam.DATABASE_URL === SENTINEL_URL);
    c.ok(`OLD (${FIRST_BUILD}): a root kept a 127.0.0.1 URL from the caller's shell`, /if \(drillEntry\) \{\s*\/\/ A drill keeps only a loopback database it was handed/.test(first.src) && !/role === "root"\) \{\s*\/\/ A root is handed NO database/.test(first.src));
  }

  // =========================================================================
  c.head("4 · the rules the boundary applies to children, engines and sockets");
  {
    const bare = repinChildEnv({ PATH: "/usr/bin:/bin" });
    c.ok("a child handed only PATH gets the sentinel, the marker and the preload", bare.DATABASE_URL === SENTINEL_URL && bare.DIRECT_URL === SENTINEL_URL && bare[MARKER] === "1" && bare.NODE_OPTIONS === withIsolationRequire(undefined));
    c.ok("…and every .env / provider key, blank", secretKeyNames().every((k) => bare[k] === ""));
    const replaced = repinChildEnv({ NODE_OPTIONS: "--conditions=react-server", DATABASE_URL: DUMMY });
    c.ok("a REPLACED NODE_OPTIONS keeps its flags and gets the quoted preload appended", replaced.NODE_OPTIONS === `--conditions=react-server --require ${JSON.stringify(SELF)}`);
    c.ok("…a database URL the drill passed is kept — it is judged where it is used", replaced.DATABASE_URL === DUMMY);
    c.ok("withIsolationRequire is idempotent", withIsolationRequire(withIsolationRequire("--x")) === withIsolationRequire("--x"));
    c.ok("a parent's stand-in APP_SECRET is not overwritten in its child (they must agree)", repinChildEnv({ APP_SECRET: STAND_IN_SECRET }).APP_SECRET === STAND_IN_SECRET);

    const env = repinChildEnv({ PATH: "/usr/bin:/bin" });
    const refusedBy = (v: { ok: boolean }) => !v.ok;
    const refused = (f: string, a: string[], e: Record<string, string>) => refusedBy(childVerdict(f, a, { ...env, ...e }));
    c.ok("native database clients handed a remote URL are refused: psql (argv), pg_dump (env), PGHOST, the Prisma schema engine",
      refused("psql", [DUMMY], {}) && refused("/opt/homebrew/bin/pg_dump", [], { DATABASE_URL: DUMMY }) && refused("psql", [], { PGHOST: "203.0.113.10" }) &&
      refused(path.join(REPO, "node_modules/@prisma/engines/schema-engine-darwin-arm64"), [], { DATABASE_URL: DUMMY }));
    c.ok("…and a shell told to run one", refused("/bin/sh", ["-c", 'pg_dump "$DATABASE_URL" > out.sql'], { DATABASE_URL: DUMMY }));

    // The second review's list — each one was allowed by the first build.
    const neon = "ep-fake.us-east-2.aws.neon.tech";
    const holes: [string, string, string[], Record<string, string>][] = [
      ["psql -h <remote>", "psql", ["-h", neon], {}],
      ["psql 'host=<remote> dbname=…' (conninfo)", "psql", [`host=${neon} dbname=neondb`], {}],
      ["psql with a 127.0.0.1 URL whose ?host= is remote", "psql", [`postgresql://u:p@127.0.0.1/db?host=${neon}`], {}],
      ["pg_dump with PGHOSTADDR=<remote>", "pg_dump", [], { PGHOSTADDR: "203.0.113.10" }],
      ["psql with PGSERVICE set", "psql", [], { PGSERVICE: "production" }],
      ["bash -lc 'psql <remote URL>' (a flag CLUSTER with c)", "/bin/bash", ["-lc", `psql postgresql://u:p@${neon}/db`], {}],
      ["sh -euo pipefail -c 'curl …'", "/bin/sh", ["-euo", "pipefail", "-c", "curl -s http://203.0.113.10:6281/"], {}],
      ["/usr/bin/env psql <remote URL> (a wrapper)", "/usr/bin/env", ["psql", DUMMY], {}],
      ["env -S 'psql <remote URL>'", "/usr/bin/env", ["-S", `psql ${DUMMY}`], {}],
      ["nohup / timeout psql -h <remote>", "timeout", ["5", "nohup", "psql", "-h", "203.0.113.10"], {}],
      ["curl http://203.0.113.10/ (no database client at all)", "/usr/bin/curl", ["-m", "3", "http://203.0.113.10:6281/"], {}],
      ["env -i node … (the grandchild ran with no boundary)", "/usr/bin/env", ["-i", process.execPath, "-e", "1"], {}],
      ["sh -c 'unset NODE_OPTIONS; node …'", "/bin/sh", ["-c", "unset NODE_OPTIONS; node x.js"], {}],
      ["sh -c 'NODE_OPTIONS= node …'", "/bin/sh", ["-c", "NODE_OPTIONS= node x.js"], {}],
      ["env -u RTP_DRILL_ISOLATION node …", "/usr/bin/env", ["-u", MARKER, "node", "x.js"], {}],
    ];
    for (const [label, file, args, e] of holes) {
      const now = childVerdict(file, args, { ...env, ...e });
      const before = old.childVerdict(file, args, { ...env, ...e });
      c.ok(`NEW: ${label} → refused (${FIRST_BUILD}: ${before.ok ? "allowed" : "refused"})`, !now.ok && before.ok, now.ok ? "allowed" : now.message.replace(/^DRILL ISOLATION: /, "").slice(0, 110));
    }
    c.ok("still refused, now by reading the shell: a URL assigned then used (X=<remote>; psql \"$X\"), and one inside $( )",
      refused("/bin/sh", ["-c", `X=${DUMMY}; psql "$X"`], {}) && refused("/bin/sh", ["-c", `echo "$(psql ${DUMMY})"`], {}) && refused("/bin/sh", ["-c", 'psql "host=$H"'], { H: "203.0.113.10" }));
    const allowed: [string, string, string[], Record<string, string>][] = [
      ["a database client on loopback", "psql", [], { DATABASE_URL: `postgresql://p@127.0.0.1:${PORT}/d` }],
      ["git show, handed nothing remote", "git", ["show", "HEAD"], { DATABASE_URL: SENTINEL_URL }],
      ["Node itself, handed a hosted-LOOKING URL (it fences itself)", process.execPath, ["-e", "1"], { DATABASE_URL: DUMMY }],
      ["npx tsx (a02's children)", "npx", ["tsx", "x.ts", DUMMY], { DATABASE_URL: DUMMY }],
      ["node_modules/.bin/tsx (a Node script by its #! line)", path.join(REPO, "node_modules/.bin/tsx"), ["x.ts", DUMMY], {}],
      ["bash run-demo-dev.sh with a poisoned DATABASE_URL (demo-smoke: the script replaces it)", "/bin/bash", ["scripts/demo/run-demo-dev.sh", "--print-env"], { DATABASE_URL: DUMMY }],
      ["sh -c 'tsx … <remote URL>' (the URL goes to Node)", "/bin/sh", ["-c", `tsx --require x.cjs y.ts '${DUMMY}'`], { DATABASE_URL: DUMMY }],
      ["sh -c 'git archive … | tar -x -C \"$0\"' (test-inboxes)", "/bin/sh", ["-c", 'git archive abc src | tar -x -C "$0"', "/tmp/base"], {}],
      ["/usr/bin/env node … (no -i)", "/usr/bin/env", [process.execPath, "-e", "1"], {}],
      ["sh -c 'NODE_OPTIONS=\"$NODE_OPTIONS --x\" node …' (keeps the preload)", "/bin/sh", ["-c", 'NODE_OPTIONS="$NODE_OPTIONS --x" node y.js 2>&1'], {}],
      ["du -h src (-h is a host only for database clients)", "du", ["-h", "src"], {}],
      ["the realpg server: postgres -c listen_addresses=127.0.0.1", "/x/native/bin/postgres", ["-D", "/tmp/d", "-p", String(PORT), "-c", "listen_addresses=127.0.0.1"], {}],
      ["ps / lsof / grep as the harness and drills use them", "ps", ["-p", "1", "-o", "args="], {}],
    ];
    for (const [label, file, args, e] of allowed) {
      const v = childVerdict(file, args, { ...env, ...e });
      c.ok(`allowed: ${label}`, v.ok, v.ok ? "" : (v as { message: string }).message.slice(0, 110));
    }

    const dm = (url: string) => `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = ${url}\n}\n`;
    const judge = (datamodel: string, env: Record<string, string>, over?: Record<string, string>, adapter?: unknown) => judgeEngineConfig({ datamodel, env, datasourceOverrides: over }, adapter);
    const says = (v: ReturnType<typeof judge>, re: RegExp) => !v.ok && re.test(v.message);
    c.ok("engine: env(DATABASE_URL) remote → refused, naming host:port only", says(judge(dm('env("DATABASE_URL")'), { DATABASE_URL: DUMMY }), /refused a Prisma connection to 203\.0\.113\.10:5432 —/));
    c.ok("engine: loopback → allowed", judge(dm('env("DATABASE_URL")'), { DATABASE_URL: `postgresql://p@127.0.0.1:${PORT}/d` }).ok);
    c.ok("engine: an override wins over a loopback env, as in Prisma — refused", says(judge(dm('env("DATABASE_URL")'), { DATABASE_URL: `postgresql://p@127.0.0.1:${PORT}/d` }, { db: DUMMY }), /203\.0\.113\.10/));
    c.ok("engine: the sentinel, or no URL at all → 'this drill has no database'", says(judge(dm('env("DATABASE_URL")'), { DATABASE_URL: SENTINEL_URL }), /no database/) && says(judge(dm('env("DATABASE_URL")'), {}), /no database/));
    c.ok("engine: a literal URL in the schema, and a datasource with another name and variable", says(judge(dm('"postgresql://x@db.boundary.invalid/y"'), {}), /db\.boundary\.invalid:5432/) &&
      says(judge('datasource main {\n  provider = "postgresql"\n  url = env("MAIN_URL")\n}', { MAIN_URL: DUMMY }), /203\.0\.113\.10/));
    c.ok("engine: a driver adapter is left to the socket fence", judge(dm('env("DATABASE_URL")'), { DATABASE_URL: DUMMY }, undefined, {}).ok);
    c.ok("NEW: engine: 127.0.0.1 with ?host=203.0.113.10 (env, then override) → refused, naming 203.0.113.10:6279",
      says(judge(dm('env("DATABASE_URL")'), { DATABASE_URL: HOSTPARAM }), /refused a Prisma connection to 203\.0\.113\.10:6279 —/) &&
      says(judge(dm('env("DATABASE_URL")'), { DATABASE_URL: SENTINEL_URL }, { db: HOSTPARAM }), /203\.0\.113\.10:6279/));
    c.ok(`OLD (${FIRST_BUILD}): the engine guard approved both`,
      old.judgeEngineConfig({ datamodel: dm('env("DATABASE_URL")'), env: { DATABASE_URL: HOSTPARAM } }).ok && old.judgeEngineConfig({ datamodel: dm('env("DATABASE_URL")'), env: {}, datasourceOverrides: { db: HOSTPARAM } }).ok);

    // The socket fence reads a string port the way Node does.
    const ports = ["5432\n", " 5432", "0x1538", "5432.0"];
    const target = (a: unknown[]) => connectTarget(a) as { local?: boolean; host?: string };
    c.ok("NEW: new Socket().connect('5432\\n' | ' 5432' | '0x1538' | '5432.0', '203.0.113.10') is read as TCP to 203.0.113.10 — as Node reads it",
      ports.every((p) => !target([p, "203.0.113.10"]).local && target([p, "203.0.113.10"]).host === "203.0.113.10") &&
      ports.every((p) => (net as unknown as { _normalizeArgs: (a: unknown[]) => [{ path?: string; port?: unknown }] })._normalizeArgs([p, "203.0.113.10"])[0].port === p));
    c.ok("…a real pipe name and a unix path are still local; a plain number and an options object still read right",
      !!target(["/tmp/x.sock"]).local && !!target(["not-a-port"]).local && target([5432, "203.0.113.10"]).host === "203.0.113.10" && target([{ port: 5432, host: "203.0.113.10" }]).host === "203.0.113.10" && target([{ path: "/tmp/s" }]).local === true);
    const oldRule = /if \(typeof a === "string" && !\/\^\\d\+\$\/\.test\(a\)\) return \{ local: true \};/.test(first.src);
    c.ok(`OLD (${FIRST_BUILD}): the fence called any string port that was not all digits a pipe — local — so all four went out`, oldRule && ports.every((p) => !/^\d+$/.test(p)));
  }

  // =========================================================================
  c.head("5 · the harness fence is a layer over the boundary");
  {
    const fence = fenceFetch();
    const f1 = await errOf(() => fetch("https://api.boundary.invalid/x"));
    c.ok("its own fetch catch keeps the old message and its record", f1.startsWith("OUTBOUND BLOCKED BY DRILL: https://api.boundary.invalid/x") && fence.blocked.includes("https://api.boundary.invalid/x"), f1.slice(0, 70));
    const n1 = await sock(() => net.connect(5432, "203.0.113.10"));
    c.ok("its own net.connect catch too — recorded once", n1.startsWith("OUTBOUND BLOCKED BY DRILL: tcp://203.0.113.10:5432") && fence.blocked.filter((x) => x === "tcp://203.0.113.10:5432").length === 1, n1);
    const n2 = await sock(() => new net.Socket().connect(5432, "203.0.113.10"));
    c.ok("NEW: pg's shape, which this layer never saw, is refused underneath…", n2.startsWith("OUTBOUND BLOCKED BY DRILL ISOLATION: tcp://203.0.113.10:5432"), n2);
    c.ok("…and still listed in fence.blocked", fence.blocked.filter((x) => x === "tcp://203.0.113.10:5432").length === 2, JSON.stringify(fence.blocked));
    const oldHarness = execFileSync("git", ["show", `${BASE}:scripts/_drill/_harness.ts`], { cwd: REPO, encoding: "utf8" });
    c.ok(`OLD (${BASE}): the harness patched only net.connect, createConnection and tls.connect, and fell through on what it could not parse`,
      /netMod\.connect = guard/.test(oldHarness) && !/Socket\.prototype/.test(oldHarness) && /if \(host === null \|\| LOOPBACK_HOST\.test\(host\)\) return orig\.apply\(this, args\);/.test(oldHarness));
    const before = fence.blocked.length;
    fence.restore();
    const n3 = await sock(() => net.connect(5432, "203.0.113.10"));
    const f3 = await errOf(() => fetch("https://api.boundary.invalid/after"));
    c.ok("fence.restore() takes away only its layer: sockets and fetch are still refused", n3.startsWith("OUTBOUND BLOCKED BY DRILL ISOLATION") && f3.startsWith("OUTBOUND BLOCKED BY DRILL ISOLATION"), `${n3} · ${f3.slice(0, 60)}`);
    c.ok("…and the restored fence stops listening", fence.blocked.length === before);
  }

  // =========================================================================
  c.head("6 · a normal bootDrillDb drill still works on top of the sentinel");
  const drill = await bootDrillDb({ port: PORT });
  const fence = fenceFetch();
  // The child below shares PGlite's ONE session; unnamed statements on both
  // sides so two engines' s0, s1 … cannot collide (42P05, see a02).
  const DB_URL = `${drill.url}&pgbouncer=true`;
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  {
    const one = await prisma.$queryRaw<{ n: number }[]>`SELECT 1::int AS n`;
    c.ok("boot, schema push, query: the drill's own database answers", one[0]?.n === 1 && (await prisma.programAiRun.count()) === 0);
    process.env.DATABASE_URL = DUMMY;
    const fresh = new PrismaClient();
    const late = await errOf(() => fresh.$queryRaw`SELECT 1`);
    c.ok("DATABASE_URL set to a remote URL now: a NEW client is refused", late.includes("DRILL ISOLATION: refused a Prisma connection to 203.0.113.10:5432"), late.slice(0, 90));
    const still = await prisma.$queryRaw<{ n: number }[]>`SELECT 2::int AS n`;
    c.ok("…while the booted client, built on loopback, still answers (its engine snapshot)", still[0]?.n === 2);
    await fresh.$disconnect();
    process.env.DATABASE_URL = DB_URL;
  }

  // =========================================================================
  c.head("7 · runDrillChild: a descendant, on the parent's database, reporting its refusals");
  {
    const child = drill.runChild(__filename, { args: ["child"] });
    const r = await child.waitFor<{ result: Record<string, unknown> }>((m) => !!m && typeof m === "object" && "result" in m, 90_000);
    const x = r.result as { role: string; drillEntry: boolean; dbBeforeAttach: string; dbIsChildUrl: boolean; appSecretStandIn: boolean; n: number; fetch: string; raw: string; engine: string };
    await child.exited;
    c.ok("the child is a DESCENDANT drill (marker inherited), not a second root", x.role === "descendant" && x.drillEntry, JSON.stringify({ role: x.role }));
    c.ok("it started on the parent's loopback database, not the sentinel", x.dbBeforeAttach === "loopback", x.dbBeforeAttach);
    c.ok("attachDrillChild pinned DRILL_CHILD_URL, and a query answered there", x.dbIsChildUrl && x.n === 1);
    c.ok("the stand-in APP_SECRET came down unchanged (parent and child agree)", x.appSecretStandIn);
    c.ok("its fetch, raw socket and Prisma engine were refused in the child", /OUTBOUND BLOCKED BY DRILL/.test(x.fetch) && /OUTBOUND BLOCKED BY DRILL ISOLATION/.test(x.raw) && /DRILL ISOLATION: refused a Prisma connection/.test(x.engine), `${x.fetch.slice(0, 40)} · ${x.raw.slice(0, 50)} · ${x.engine.slice(0, 50)}`);
    const want = ["https://probe.boundary.invalid/child", "tcp://203.0.113.10:5432", "prisma://203.0.113.10:5432"];
    c.ok("…and all three reached the parent's fence", want.every((w) => child.blocked.includes(w) && fence.blocked.includes(w)), JSON.stringify(child.blocked));
  }

  // =========================================================================
  c.head("8 · the runner's verdicts (run-all.cjs)");
  {
    const oldRunner = execFileSync("git", ["show", `${FIRST_BUILD}:scripts/_drill/run-all.cjs`], { cwd: REPO, encoding: "utf8" });
    const run = (text: string, code = 0) => drillVerdict({ bannerSeen: true, timedOut: false, code, signal: null, text, timeoutS: 600 });
    const walkthrough = run("reason: All ordered deliverables confirmed live on Aryeo.\nmissing: []\n");
    c.ok("NEW: a drill that exits 0 but prints no pass/fail tally (r02-completion) is RAN, not PASS", walkthrough.verdict === "RAN", walkthrough.note);
    c.ok(`OLD (${FIRST_BUILD}): it was a PASS, noted '(no tally line)'`, /let verdict = "PASS";\s*let note = t \|\| "\(no tally line\)";/.test(oldRunner));
    const twoTallies = run("section A\n3 passed, 1 failed\nsection B\n10 passed, 0 failed\n");
    c.ok("NEW: a failing tally anywhere fails the run, even when the LAST one is clean", twoTallies.verdict === "FAIL" && /3 passed, 1 failed/.test(twoTallies.note), twoTallies.note);
    c.ok(`OLD (${FIRST_BUILD}): only the last tally was read`, /const failedTally = \/\\b\[1-9\]\\d\* failed\\b\/\.test\(t\);/.test(oldRunner));
    c.ok("…but a check's DETAIL that quotes a tally is not one (only a line that starts with it, or ALL PASS — / ALL GREEN —)",
      run("  PASS an example — 3 passed, 1 failed\n10 passed, 0 failed\n").verdict === "PASS" && run("ALL GREEN — 7 passed, 0 failed").verdict === "PASS");
    c.ok("a final 'PASS — …' verdict line (due-filter, r02-sentence) is a tally; ALL CHECKS PASSED too; a real failure still fails",
      run("\nPASS — the dates are Eastern\n").verdict === "PASS" && run("ALL CHECKS PASSED (12 passed)").verdict === "PASS" && run("2 FAILED", 1).verdict === "FAIL");
    c.ok("no banner is a FAIL whatever the drill printed", drillVerdict({ bannerSeen: false, timedOut: false, code: 0, signal: null, text: "9 passed, 0 failed", timeoutS: 600 }).verdict === "FAIL");
    const withSkip = [{ verdict: "PASS" as const }, { verdict: "SKIPPED" as const }, { verdict: "RAN" as const }];
    c.ok("NEW: a SKIPPED run (no tools/realpg here) fails the suite — exit 1 — unless --allow-skips", suiteExitCode(withSkip, false) === 1 && suiteExitCode(withSkip, true) === 0);
    c.ok("…a RAN row alone does not fail it, a FAIL always does", suiteExitCode([{ verdict: "PASS" }, { verdict: "RAN" }], false) === 0 && suiteExitCode([{ verdict: "FAIL" }], true) === 1);
    c.ok(`OLD (${FIRST_BUILD}): the exit code counted failures only`, /process\.exitCode = failed\.length \? 1 : 0;/.test(oldRunner));
  }

  quiet.restore();
  c.summary();
  await drill.stop();
  process.exit(process.exitCode ?? 0);
}

/** The child's part: everything it can see about itself, then three refused probes. */
async function childMain() {
  const before = process.env.DATABASE_URL ?? "";
  const dbBeforeAttach = before === SENTINEL_URL ? "sentinel" : isDrillDbUrl(before) ? "loopback" : "other";
  const ctx = attachDrillChild();
  const dbIsChildUrl = process.env.DATABASE_URL === ctx.url;
  process.env.DATABASE_URL = `${ctx.url}&pgbouncer=true`;
  const { prisma } = await import("@/lib/prisma");
  const n = (await prisma.$queryRaw<{ n: number }[]>`SELECT 1::int AS n`)[0]?.n;
  const fetchErr = await errOf(() => fetch("https://probe.boundary.invalid/child"));
  const raw = await sock(() => new net.Socket().connect(5432, "203.0.113.10"));
  const engine = await errOf(() => new PrismaClient({ datasourceUrl: DUMMY }).$queryRaw`SELECT 1`);
  const s = state();
  await ctx.send({ result: { role: s.role, drillEntry: s.drillEntry, dbBeforeAttach, dbIsChildUrl, appSecretStandIn: process.env.APP_SECRET === STAND_IN_SECRET, n, fetch: fetchErr, raw, engine } });
  await prisma.$disconnect();
  await ctx.exit(0);
}

(process.env.DRILL_CHILD && process.argv[2] === "child" ? childMain() : main()).catch((e) => { console.error(e); process.exit(1); });
