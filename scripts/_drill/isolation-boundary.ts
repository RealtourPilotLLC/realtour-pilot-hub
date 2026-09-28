// ---------------------------------------------------------------------------
// DRILL: THE ISOLATION BOUNDARY, FROM INSIDE THE SUITE (R06, Sep 28 2026).
//
//   npm run drills -- scripts/_drill/isolation-boundary.ts
//   npm run drills:boundary      (the fixtures A1-A9 as roots, then this)
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
//   2. who is isolated: the decide() truth table — drills and their fixtures
//      are roots, scripts/_live, scripts/_recon, the demo and the runner are
//      left alone unless a drill started them.
//   3. the URL rules (sentinel, 127.0.0.1 only for a database).
//   4. the pure child and engine rules the boundary applies.
//   5. the harness fence is now a LAYER: its own catches keep their old
//      message, the pg shape it used to miss is caught underneath and still
//      listed in fence.blocked, and fence.restore() does not open the network.
//   6. a normal bootDrillDb drill still works on top of the sentinel; a NEW
//      client on a remote URL set late is refused while the booted one answers.
//   7. runDrillChild: the child is a descendant on the parent's loopback
//      database (not the sentinel), and its refusals — a fetch, a raw socket,
//      a Prisma engine — reach the parent's fence.
//
// ISOLATION: PGlite on 127.0.0.1:6270; the only "remote" destinations are
// 203.0.113.10 (TEST-NET-3) and *.invalid names, all refused before any byte
// leaves. Nothing reads or prints a .env value.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { attachDrillChild, assertLoopbackDbUrl as harnessAssert, bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import {
  assertLoopbackDbUrl, childVerdict, decide, DRILL_DIR, isDrillDbUrl, judgeEngineConfig, MARKER, REPO, repinChildEnv,
  secretKeyNames, SELF, SENTINEL_URL, state, withIsolationRequire,
} from "./_isolation.cjs";
import { drillSourceShape, stripComments } from "./_isolationLint";

const PORT = 6270;
const BASE = "1075a5b"; // the handoff HEAD the review read — never HEAD
const DUMMY = "postgresql://drill:dummy@203.0.113.10:5432/none?connect_timeout=2&sslmode=disable";
const STAND_IN_SECRET = "drill-app-secret-not-a-real-key-0123456789abcdef";
const c = makeChecker();
installNextStubs();

const threw = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const errOf = async (p: () => Promise<unknown>) => { try { await p(); return "no error"; } catch (e) { return String((e as Error).message).replace(/\s+/g, " "); } };
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
  {
    const on = { [MARKER]: "1" };
    const p = (...s: string[]) => path.join(REPO, ...s);
    const table: [string, string | null, Record<string, string>, string][] = [
      ["a drill", p("scripts/_drill/a01-digest-packing.ts"), {}, "root"],
      ["a drill started by a drill", p("scripts/_drill/a01-digest-packing.ts"), on, "descendant"],
      ["a boundary fixture (any depth under scripts/_drill)", p("scripts/_drill/_fixtures/isolation/comment-only.ts"), {}, "root"],
      ["a scratch copy of a drill", p("scripts/_drill/zz-scratch-r06-x.ts"), {}, "root"],
      ["restore-rehearsal (an isolated tool)", p("scripts/restore-rehearsal.ts"), {}, "root"],
      ["a scripts/_live probe", p("scripts/_live/f03-owed-now.ts"), {}, "inactive"],
      ["…the same probe started BY a drill", p("scripts/_live/f03-owed-now.ts"), on, "descendant"],
      ["a scripts/_recon probe", p("scripts/_recon/cp15-config-probe.ts"), {}, "inactive"],
      ["…started by a drill", p("scripts/_recon/cp15-config-probe.ts"), on, "descendant"],
      ["the isolated demo", p("scripts/demo/isolated-demo.ts"), {}, "inactive"],
      ["create-test-client", p("scripts/create-test-client.ts"), {}, "inactive"],
      ["the runner itself", p("scripts/_drill/run-all.cjs"), {}, "inactive"],
      ["node -e / a worker (no entry)", null, {}, "inactive"],
      ["…inside a drill's tree", null, on, "descendant"],
      ["the Prisma CLI a drill runs", p("node_modules/prisma/build/index.js"), on, "descendant"],
      ["a sibling folder sharing the prefix (scripts/_drill-old/)", p("scripts/_drill-old/x.ts"), {}, "inactive"],
    ];
    for (const [label, entry, env, want] of table) {
      const got = decide({ entry, env }).role;
      c.ok(`${label} → ${want}`, got === want, got === want ? "" : `got ${got}`);
    }
  }

  // =========================================================================
  c.head("3 · the URL rules");
  {
    const loop = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
    c.ok("a drill database is 127.0.0.1 and not the sentinel", isDrillDbUrl(loop) && !isDrillDbUrl(SENTINEL_URL));
    c.ok("…never localhost, [::1], Neon, TEST-NET, empty or unparsable", ["postgresql://p@localhost:5432/d", "postgresql://p@[::1]:5432/d", "postgresql://x@ep-fake.us-east-2.aws.neon.tech/db", DUMMY, "", "not a url"].every((u) => !isDrillDbUrl(u)));
    c.ok("assertLoopbackDbUrl (moved verbatim): 127.0.0.1 passes — the sentinel too, harmlessly (nothing listens on :9)", !threw(() => assertLoopbackDbUrl(loop)) && !threw(() => assertLoopbackDbUrl(SENTINEL_URL)));
    c.ok("…localhost, [::1], Neon and 203.0.113.10 are refused", ["postgresql://p@localhost:5432/d", "postgresql://p@[::1]:5432/d", "postgresql://x@ep-fake.us-east-2.aws.neon.tech/db", DUMMY].every((u) => threw(() => assertLoopbackDbUrl(u))));
    c.ok("…and the harness export IS that function (one check, not two)", harnessAssert === assertLoopbackDbUrl);
  }

  // =========================================================================
  c.head("4 · the rules the boundary applies to children and engines");
  {
    const bare = repinChildEnv({ PATH: "/usr/bin:/bin" });
    c.ok("a child handed only PATH gets the sentinel, the marker and the preload", bare.DATABASE_URL === SENTINEL_URL && bare.DIRECT_URL === SENTINEL_URL && bare[MARKER] === "1" && bare.NODE_OPTIONS === withIsolationRequire(undefined));
    c.ok("…and every .env / provider key, blank", secretKeyNames().every((k) => bare[k] === ""));
    const replaced = repinChildEnv({ NODE_OPTIONS: "--conditions=react-server", DATABASE_URL: DUMMY });
    c.ok("a REPLACED NODE_OPTIONS keeps its flags and gets the quoted preload appended", replaced.NODE_OPTIONS === `--conditions=react-server --require ${JSON.stringify(SELF)}`);
    c.ok("…a database URL the drill passed is kept — it is judged where it is used", replaced.DATABASE_URL === DUMMY);
    c.ok("withIsolationRequire is idempotent", withIsolationRequire(withIsolationRequire("--x")) === withIsolationRequire("--x"));
    c.ok("a parent's stand-in APP_SECRET is not overwritten in its child (they must agree)", repinChildEnv({ APP_SECRET: STAND_IN_SECRET }).APP_SECRET === STAND_IN_SECRET);

    const refused = (f: string, a: string[], e: Record<string, string>) => !childVerdict(f, a, e).ok;
    c.ok("native database clients handed a remote URL are refused: psql (argv), pg_dump (env), PGHOST, the Prisma schema engine",
      refused("psql", [DUMMY], {}) && refused("/opt/homebrew/bin/pg_dump", [], { DATABASE_URL: DUMMY }) && refused("psql", [], { PGHOST: "203.0.113.10" }) &&
      refused(path.join(REPO, "node_modules/@prisma/engines/schema-engine-darwin-arm64"), [], { DATABASE_URL: DUMMY }));
    c.ok("…and a shell told to run one", refused("/bin/sh", ["-c", 'pg_dump "$DATABASE_URL" > out.sql'], { DATABASE_URL: DUMMY }));
    c.ok("allowed: a database client on loopback; any program with no remote URL", !refused("psql", [], { DATABASE_URL: `postgresql://p@127.0.0.1:${PORT}/d` }) && !refused("git", ["show", "HEAD"], { DATABASE_URL: SENTINEL_URL }));
    c.ok("allowed: Node programs (they load the boundary and fence themselves) and a shell that runs none — a02 and demo-smoke hand those hosted-LOOKING URLs on purpose",
      !refused(process.execPath, ["-e", "1"], { DATABASE_URL: DUMMY }) && !refused("npx", ["tsx", "x.ts"], { DATABASE_URL: DUMMY }) &&
      !refused("/bin/bash", ["scripts/demo/run-demo-dev.sh", "--print-env"], { DATABASE_URL: DUMMY }) && !refused("/bin/sh", ["-c", `tsx --require x.cjs y.ts '${DUMMY}'`], { DATABASE_URL: DUMMY }));

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
