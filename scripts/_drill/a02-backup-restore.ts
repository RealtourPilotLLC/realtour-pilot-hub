// ---------------------------------------------------------------------------
// DRILL: A02 — the backup covers the schema, a restore is rehearsed for real,
// and nothing destructive can aim at production (unified handoff §4/§12 A02,
// batch 6, Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/a02-backup-restore.ts
//
// What it proves, the OLD behaviour first (BASE pinned to 3de6023 — never HEAD):
//   0. OLD: backup-all read model by model with no snapshot and wrote 0644;
//      restore-content-program had no hosted-URL guard, upserted `where: {id}`
//      and revived any timestamp-shaped text; RUN on a backup-all file it
//      dies on `tables` before doing anything; the program backup's hand list
//      missed four program models.
//   1. exportAll on a seeded drill database: every model of the schema, the
//      real primary key (AppSetting pages on `key`), id hashes stable across
//      two exports, one snapshot; a model that throws stops the export by name.
//   2. backup-all, the real CLI: on a WRITABLE connection it refuses before
//      reading (PGlite ignores the read-only startup option; the 25006 proof
//      catches it). On a read-only session: a rtp-backup-all/2 file, mode
//      0600, header first (commit, schemaHash, serverVersion, snapshot,
//      counts, id hashes), an unmapped table listed, and the header readable
//      from the first few KB. A model that cannot be read: exit 1, NO file.
//      The line reader and the whole-file reader agree.
//   3. backup-content-program: every schema model is in exactly one list; a
//      new model in neither is refused by name.
//   4. The restore guard, as a real CLI with @prisma/client loads and
//      non-loopback sockets counted: --deep and --apply on a hosted URL exit 1
//      with neither; --apply --target-production without an incident too; with
//      one, it counts live rows NEWER than the file on a read-only connection,
//      asks for the host, and a wrong answer writes nothing. On loopback
//      --apply proceeds: a backup-all file restores (it used to TypeError),
//      AppSetting comes back by `key`, a text column holding a timestamp-shaped
//      string comes back as that string. The dry run refuses a writable
//      connection and runs on a read-only one.
//   5. restore-rehearsal, the real CLI, each run on its own isolated database:
//      the clean backup PASSes (counts, round trip, 49 FKs, plain refs, the app
//      smoke), a pre-existing dangling plain ref is a WARN, not a FAIL; a
//      legacy-format file PASSes too; the synthetic BAD backup (a required-FK
//      orphan, an unknown column, a duplicate unique, a model missing from the
//      header) FAILs with lines naming model and field. Evidence is written
//      0600. With the embedded Postgres installed, the same files on the real
//      engine give the same verdicts and the same lines.
//
// ISOLATION: PGlite on 127.0.0.1:5867 (DRILL_PORT overrides) through the
// shared harness, then the rehearsal children on the same port, one at a time,
// after this drill's database has stopped. Production is never opened: the
// only "hosted" URLs here are either refused before a client exists, or point
// at 127.0.0.1 with a hosted-looking password. Backups are written to a temp
// directory outside the repo and hold synthetic rows only. THE CLOCK IS PINNED.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5867);
const BASE = "3de6023"; // pinned: never HEAD
const REPO = path.resolve(__dirname, "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-a02-"));
const REALPG = fs.existsSync(path.join(REPO, "tools/realpg/node_modules/embedded-postgres/package.json"));

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 8, 28, 15, 0, 0); // Mon Sep 28 2026, 11:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

installNextStubs();
const fence = fenceFetch();
const c = makeChecker();
const show = (file: string) => execFileSync("git", ["show", `${BASE}:${file}`], { cwd: REPO, encoding: "utf8" });

// Counts what a child process tried: loads of @prisma/client and sockets to
// anything but loopback. Prisma's query engine is native and invisible to
// node:net, so "no client was ever loaded" is the proof it could not connect.
const FENCE_PRELOAD = path.join(TMP, "count-fence.cjs");
fs.writeFileSync(FENCE_PRELOAD, `
const Module = require("module"); const net = require("net"); const tls = require("tls");
let prismaLoads = 0, sockets = 0;
const load = Module._load;
Module._load = function (req, ...rest) { if (req === "@prisma/client" || req === ".prisma/client/default") prismaLoads++; return load.call(this, req, ...rest); };
for (const [m, k] of [[net, "connect"], [net, "createConnection"], [tls, "connect"]]) {
  const orig = m[k];
  m[k] = function (...a) {
    const t = a[0]; const host = t && typeof t === "object" ? (t.host || t.hostname) : typeof a[1] === "string" ? a[1] : null;
    if (host && !/^(127\\.|localhost$|::1$)/.test(host)) sockets++;
    return orig.apply(this, a);
  };
}
process.on("exit", () => process.stderr.write("\\nFENCE prismaLoads=" + prismaLoads + " sockets=" + sockets + "\\n"));
`);

type Cli = { code: number; out: string; prismaLoads: number; sockets: number };
/** A repo script as its own process (async: this process may be serving the
 *  PGlite socket the child connects to). */
function runCli(script: string, args: string[], opts: { env?: Record<string, string>; stdin?: string; drillPreload?: boolean } = {}): Promise<Cli> {
  return new Promise((resolve) => {
    const req = ["--require", FENCE_PRELOAD, ...(opts.drillPreload ? ["--require", "./scripts/_drill/_drill-preload.cjs"] : [])];
    const child = spawn("npx", ["tsx", ...req, script, ...args], {
      cwd: REPO,
      env: { ...process.env, ...(opts.drillPreload ? { NODE_OPTIONS: "--conditions=react-server" } : {}), ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.stdin.end(opts.stdin ?? "");
    child.on("close", (code) => {
      const m = /FENCE prismaLoads=(\d+) sockets=(\d+)/.exec(out);
      resolve({ code: code ?? -1, out, prismaLoads: m ? Number(m[1]) : -1, sockets: m ? Number(m[2]) : -1 });
    });
  });
}
const tail = (s: string, n = 400) => s.replace(/\s+/g, " ").slice(-n);

async function main() {
  // =========================================================================
  c.head("0 · the old code (3de6023)");
  const oldBackup = show("scripts/backup-all.ts");
  c.ok("OLD backup-all: separate findMany calls, no snapshot transaction", /for \(const m of models\)/.test(oldBackup) && !/\$transaction/.test(oldBackup));
  c.ok("…pages on a field called `id` whatever the key", /orderBy: \{ id: "asc" \}/.test(oldBackup));
  c.ok("…written with the default mode (0644 under a normal umask), as one JSON.stringify", /fs\.writeFileSync\(OUT, JSON\.stringify\(/.test(oldBackup) && !/0o600/.test(oldBackup));
  const oldRestore = show("scripts/restore-content-program.ts");
  c.ok("OLD restore: no hosted-URL guard; a bare new PrismaClient() on whatever .env says", /const p = new PrismaClient\(\);/.test(oldRestore) && !/neon\.tech|isHostedUrl|hosted/i.test(oldRestore));
  c.ok("…upserts where: { id } (AppSetting's key is `key`) and revives any ISO-shaped text", /upsert\(\{ where: \{ id \}/.test(oldRestore) && /\\d\{4\}-\\d\{2\}-\\d\{2\}T/.test(oldRestore));
  const oldProgram = show("scripts/backup-content-program.ts");
  c.ok("OLD program backup: a hand list without ContentReviewWindow, ContentRevisionRound, ContentFilmingReport, ContentTopicFolder",
    ["ContentReviewWindow", "ContentRevisionRound", "ContentFilmingReport", "ContentTopicFolder"].every((m) => !oldProgram.includes(`"${m}"`)));

  const drill = await bootDrillDb({ port: PORT });
  // Child processes share this ONE PGlite session. Prisma names its prepared
  // statements s0, s1, … per engine, so two engines collide (42P05); every
  // engine here, this one and each child's, runs unnamed statements instead
  // (pgbouncer=true), set before any Prisma client exists.
  const DB_URL = `${drill.url}&pgbouncer=true`;
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { Prisma } = await import("@prisma/client");
  const schemaModels = Prisma.dmmf.datamodel.models.map((m) => m.name);
  const bf = await import("../_lib/backupFormat");
  const ex = await import("../_lib/exportAll");

  // Seed: an assistant whose id sorts BEFORE its agent's (a self-reference in
  // the wrong order), a text column holding a timestamp-shaped string, an enum,
  // a Float, a keyed-by-`key` setting, and one enrollment whose client is not
  // there (a pre-existing dangling plain ref, as production has 3 of).
  await prisma.client.create({ data: { id: "c_2_agent", name: "Agent Alpha", aryeoCustomerId: "cust-1", company: "2026-09-25T18:07:22.477Z" } });
  await prisma.client.create({ data: { id: "c_1_assistant", name: "Assistant Beta", parentClientId: "c_2_agent" } });
  await prisma.project.createMany({ data: [{ id: "p_1", title: "12 Oak St", clientId: "c_2_agent" }, { id: "p_2", title: "9 Elm Ave", clientId: "c_1_assistant" }] });
  await prisma.checklistItem.createMany({ data: [{ id: "ci_1", projectId: "p_1", label: "Twilight" }, { id: "ci_2", projectId: "p_2", label: "Drone" }] });
  await prisma.teamMember.createMany({ data: [{ id: "tm_1", name: "Pat Shooter", email: "pat@drill.invalid", role: "PHOTOGRAPHER" }, { id: "tm_2", name: "Lee Editor", email: "lee@drill.invalid" }] });
  await prisma.appSetting.create({ data: { key: "drill_setting", value: JSON.stringify({ a: 1 }) } });
  await prisma.contentEnrollment.createMany({ data: [
    { id: "en_1", clientId: "c_2_agent", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, startedAt: new RealDate("2026-09-01T13:00:00.000Z") },
    { id: "en_2", clientId: "c_gone", package: "Pro", videosPerMonth: 8, sessionsPerMonth: 2, sessionHours: 4 },
  ] });

  // =========================================================================
  c.head("1 · exportAll: every model, its real key, stable hashes, one snapshot");
  const snap1 = await ex.snapshotExport(prisma);
  const snap2 = await ex.snapshotExport(prisma);
  c.ok("the export covers every model of the schema", schemaModels.every((m) => m in snap1.counts) && Object.keys(snap1.counts).length === schemaModels.length, `${Object.keys(snap1.counts).length}/${schemaModels.length}`);
  c.ok("AppSetting is read on its `key`", snap1.counts.AppSetting === 1 && snap1.data.AppSetting[0].key === "drill_setting");
  c.ok("id hashes are stable across two exports", schemaModels.every((m) => snap1.idHash[m] === snap2.idHash[m]));
  c.ok("…and differ when the rows do", snap1.idHash.Client !== snap1.idHash.Project);
  c.ok("the snapshot reports the server and its instant", /^\d+/.test(snap1.serverVersion) && !Number.isNaN(Date.parse(snap1.takenAt)) && snap1.unmappedTables.length === 0);
  const broken = new Proxy(prisma as unknown as Record<string, unknown>, {
    get(t, k) { return k === "contact" ? { findMany: async () => { throw new Error("relation \"Contact\" does not exist"); } } : Reflect.get(t, k); },
  });
  let threw = "";
  try { await ex.exportAll(broken); } catch (e) { threw = (e as Error).message; }
  c.ok("a model that cannot be read stops the export, by name", /^Contact: relation "Contact" does not exist/.test(threw), threw);

  // =========================================================================
  c.head("2 · backup-all, the real CLI");
  const out1 = path.join(TMP, "rtp-backup-drill-clean.json");
  let r = await runCli("scripts/backup-all.ts", [out1]);
  c.ok("on a WRITABLE connection it refuses before reading a row (PGlite ignores the read-only option; the 25006 proof catches it)", r.code === 1 && /GUARD FAILED/.test(r.out) && !fs.existsSync(out1), tail(r.out, 160));

  await drill.sql(`CREATE TABLE "_legacy_notes" (id text primary key)`);
  await drill.sql(`INSERT INTO "_legacy_notes" VALUES ('a'), ('b')`);
  await drill.sql(`SET default_transaction_read_only = on`);
  r = await runCli("scripts/backup-all.ts", [out1]);
  await drill.sql(`SET default_transaction_read_only = off`);
  c.ok("on a read-only session: exit 0, the 25006 proof printed", r.code === 0 && /read-only connection proven \(25006\)/.test(r.out), tail(r.out, 200));
  const st = fs.statSync(out1);
  c.ok("the file is mode 0600", (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
  const head = bf.readBackupHeader(out1);
  c.ok("format rtp-backup-all/2, header first, read from the first few KB", head.header.format === "rtp-backup-all/2" && head.dataKey === "data" && head.headerBytes < 64 * 1024, `${head.headerBytes} bytes`);
  c.ok("…stamped: commit, schemaHash, Prisma and server versions, repeatable-read snapshot",
    /^[0-9a-f]{40}$/.test(head.header.commit ?? "") && head.header.schemaHash === bf.schemaHashOf(bf.currentSchemaText()) && !!head.header.prismaVersion && !!head.header.serverVersion && head.header.snapshot === "repeatable-read");
  c.ok("…counts for every model, equal to the database's", schemaModels.every((m) => head.header.counts?.[m] === snap1.counts[m]));
  c.ok("…id hashes equal the in-process export's", schemaModels.every((m) => head.header.idHash?.[m] === snap1.idHash[m]));
  c.ok("the table no model maps is listed with its row count, and warned about", JSON.stringify(head.header.unmappedTables) === JSON.stringify([{ table: "_legacy_notes", rows: 2 }]) && /WARN tables no Prisma model maps/.test(r.out));
  await drill.sql(`DROP TABLE "_legacy_notes"`);
  const whole = await bf.readBackup(out1);
  const lined = await bf.readBackup(out1, { streamAboveBytes: 0 });
  c.ok("the line reader and the whole-file reader return the same rows", JSON.stringify(whole.data) === JSON.stringify(lined.data) && Object.keys(whole.data).length === schemaModels.length);
  c.ok("…and it is valid JSON as a whole", (() => { try { JSON.parse(fs.readFileSync(out1, "utf8")); return true; } catch { return false; } })());
  c.ok("backup-all refuses to overwrite an existing file", (await runCli("scripts/backup-all.ts", [out1])).code === 2);

  const out2 = path.join(TMP, "rtp-backup-drill-broken.json");
  await drill.sql(`ALTER TABLE "Contact" RENAME TO "Contact_gone"`);
  await drill.sql(`SET default_transaction_read_only = on`);
  r = await runCli("scripts/backup-all.ts", [out2]);
  await drill.sql(`SET default_transaction_read_only = off`);
  await drill.sql(`ALTER TABLE "Contact_gone" RENAME TO "Contact"`);
  c.ok("a model that cannot be read: exit 1, the model named, NO file and no partial left", r.code === 1 && /BACKUP FAILED — no file written: Contact:/.test(r.out) && !fs.existsSync(out2) && !fs.existsSync(`${out2}.partial`), tail(r.out, 200));

  // =========================================================================
  c.head("3 · backup-content-program: every model belongs to one list");
  const prog = await import("../backup-content-program");
  const cls = prog.unclassifiedModels(schemaModels);
  c.ok("today: no model unlisted, none unknown, none in both", !cls.unlisted.length && !cls.unknown.length && !cls.both.length, `${prog.MODELS.length} program + ${prog.OPERATIONAL_CORE.length} core = ${schemaModels.length}`);
  c.ok("the four models the old list missed are the program's now", ["ContentReviewWindow", "ContentRevisionRound", "ContentFilmingReport", "ContentTopicFolder"].every((m) => (prog.MODELS as readonly string[]).includes(m)));
  const future = prog.unclassifiedModels([...schemaModels, "ContentSomethingNew"]);
  c.ok("a model added tomorrow in neither list is refused by name", future.unlisted.join() === "ContentSomethingNew");
  c.ok("a listed model the schema dropped is refused by name", prog.unclassifiedModels(schemaModels.filter((m) => m !== "ProgramCallBooking")).unknown.join() === "ProgramCallBooking");

  // =========================================================================
  c.head("4 · the restore guard");
  const g = await import("../_lib/dbGuard");
  c.ok("hosted: a Neon URL, an AWS URL, any non-loopback host, an unparseable URL", ["postgresql://x@ep-fake.neon.tech/db", "postgresql://u@db.abc.us-east-1.rds.amazonaws.com/db", "postgresql://u@10.0.0.5/db", "not a url"].every(g.isHostedUrl));
  c.ok("not hosted: 127.0.0.1, localhost, ::1", ["postgresql://p@127.0.0.1:5432/d", "postgresql://p@localhost/d", "postgresql://p@[::1]:5432/d"].every((u) => !g.isHostedUrl(u)));
  const NEON = "postgresql://x@ep-fake.neon.tech/db";
  const decide = (mode: "dry-run" | "deep" | "apply", url: string, targetProduction = false, incident: string | null = null) => g.restoreGuard({ mode, url, targetProduction, incident });
  c.ok("pure: --deep on hosted refused; --apply on hosted refused without --target-production and without an incident", !decide("deep", NEON).ok && !decide("apply", NEON).ok && !decide("apply", NEON, true).ok);
  const withIncident = decide("apply", NEON, true, "restoring after the Sep 30 outage");
  c.ok("…with both, allowed only behind a typed host; loopback --apply needs none; a hosted dry run is allowed (it is read-only)", withIncident.ok && withIncident.needsTypedHost && withIncident.host === "ep-fake.neon.tech" && decide("apply", drill.url).ok && !(decide("apply", drill.url) as { needsTypedHost: boolean }).needsTypedHost && decide("dry-run", NEON).ok);

  const restore = (args: string[], env: Record<string, string>, stdin?: string) => runCli("scripts/restore-content-program.ts", [out1, ...args], { env, stdin });
  for (const [label, args] of [["--deep", ["--deep"]], ["--apply", ["--apply"]], ["--apply --target-production (no incident)", ["--apply", "--target-production"]]] as const) {
    r = await restore([...args], { DATABASE_URL: NEON });
    c.ok(`CLI ${label} on a hosted URL: exit 1 before any client exists (0 @prisma/client loads, 0 sockets)`, r.code === 1 && /REFUSED/.test(r.out) && r.prismaLoads === 0 && r.sockets === 0, `${tail(r.out, 120)} · loads=${r.prismaLoads} sockets=${r.sockets}`);
  }

  // A hosted-LOOKING url that actually points at this drill's database: the
  // password says neon.tech, the host is 127.0.0.1. It exercises the whole
  // production path without a byte leaving the machine.
  const HOSTED_LOOKING = DB_URL.replace("postgres:postgres@", "postgres:neon.tech@");
  c.ok("(the stand-in URL is judged hosted and names 127.0.0.1 as its host)", g.isHostedUrl(HOSTED_LOOKING) && g.hostOf(HOSTED_LOOKING) === "127.0.0.1");
  await prisma.client.update({ where: { id: "c_2_agent" }, data: { name: "Agent Alpha (renamed after the backup)" } });
  const before = JSON.stringify(await prisma.client.findMany({ orderBy: { id: "asc" } }));
  await drill.sql(`SET default_transaction_read_only = on`);
  r = await restore(["--apply", "--target-production", "--incident", "drill: a wrong host typed back"], { DATABASE_URL: HOSTED_LOOKING }, "ep-something-else.neon.tech\n");
  await drill.sql(`SET default_transaction_read_only = off`);
  c.ok("with an incident: it counts, on a read-only connection, the live rows NEWER than the file", /Client\s+1 live row\(s\) are NEWER than the file/.test(r.out) && /read-only connection proven|INCIDENT: drill/.test(r.out), tail(r.out, 300));
  c.ok("…asks for the host, and a wrong answer exits 1 having written nothing", r.code === 1 && /the host was not typed back — nothing was written/.test(r.out) && JSON.stringify(await prisma.client.findMany({ orderBy: { id: "asc" } })) === before);

  r = await restore([], { DATABASE_URL: DB_URL });
  c.ok("the dry run refuses a WRITABLE connection (it must be unable to write)", r.code === 1 && /GUARD FAILED/.test(r.out), tail(r.out, 160));
  await drill.sql(`SET default_transaction_read_only = on`);
  r = await restore([], { DATABASE_URL: DB_URL });
  await drill.sql(`SET default_transaction_read_only = off`);
  c.ok("…and runs on a read-only one, reading the backup-all file's `data`", r.code === 0 && /read-only connection proven \(25006\)/.test(r.out) && /checked \d+ rows; problems: 0/.test(r.out), tail(r.out, 200));
  c.ok("…reporting the pre-existing dangling plain ref by model and field", /ContentEnrollment\.clientId -> Client: 1 id point at nothing/.test(r.out));

  // Loopback --apply: take rows away, put them back from the file.
  await prisma.appSetting.deleteMany({});
  await prisma.checklistItem.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.client.deleteMany({});
  r = await restore(["--apply"], { DATABASE_URL: DB_URL });
  const back = await prisma.client.findMany({ orderBy: { id: "asc" } });
  c.ok("loopback --apply proceeds and restores a backup-all file (the old code threw on `tables`)", r.code === 0 && /restored \d+ rows; problems: 0/.test(r.out) && back.length === 2 && (await prisma.project.count()) === 2 && (await prisma.checklistItem.count()) === 2, tail(r.out, 200));
  c.ok("…the assistant listed before its agent is placed (retry pass)", back.find((x) => x.id === "c_1_assistant")?.parentClientId === "c_2_agent");
  c.ok("…AppSetting comes back by its `key`", (await prisma.appSetting.findUnique({ where: { key: "drill_setting" } }))?.value === JSON.stringify({ a: 1 }));
  c.ok("…a text column holding a timestamp-shaped string comes back as that exact string", back.find((x) => x.id === "c_2_agent")?.company === "2026-09-25T18:07:22.477Z");
  c.ok("…and the renamed row is back at its backed-up value (apply overwrites; that is why production needs the incident path)", back.find((x) => x.id === "c_2_agent")?.name === "Agent Alpha");

  // =========================================================================
  // The synthetic BAD backup, from the clean one: a required-FK orphan, an
  // unknown column, a duplicate unique, and a model dropped from the header.
  const clean = await bf.readBackup(out1);
  const bad: Record<string, Record<string, unknown>[]> = JSON.parse(JSON.stringify(clean.data));
  bad.ChecklistItem.push({ ...bad.ChecklistItem[0], id: "ci_orphan", projectId: "p_missing" });
  bad.Client[0] = { ...bad.Client[0], legacyNickname: "Al" };
  bad.TeamMember.push({ ...bad.TeamMember[0], id: "tm_dup" });
  delete bad.Contact;
  const badModels = (Prisma.dmmf.datamodel.models as unknown as import("../_lib/backupFormat").DmmfModel[]).filter((m) => bad[m.name]);
  const outBad = path.join(TMP, "rtp-backup-drill-bad.json");
  bf.writeBackupFile(outBad, {
    ...clean.header,
    counts: Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.length])),
    idHash: Object.fromEntries(badModels.map((m) => [m.name, ex.idHashOf(bad[m.name], bf.idFieldsOf(m))])),
  }, bad);
  // A legacy (v1) file: backup-all's old shape, no stamps.
  const outLegacy = path.join(TMP, "rtp-backup-drill-legacy.json");
  fs.writeFileSync(outLegacy, JSON.stringify({ takenAt: clean.header.takenAt, models: schemaModels.length, counts: clean.header.counts, data: clean.data }), { mode: 0o600 });

  // OLD restore, run for real on the backup-all file (drill database; it dies
  // before its first query).
  const oldDir = path.join(REPO, "node_modules/.cache/rtp-a02");
  fs.mkdirSync(oldDir, { recursive: true });
  const oldScript = path.join(oldDir, "restore-content-program.3de6023.ts");
  fs.writeFileSync(oldScript, oldRestore);
  r = await runCli(oldScript, [out1], { env: { DATABASE_URL: DB_URL } });
  c.ok("OLD restore, RUN on a backup-all file: TypeError on `tables`, nothing restored", r.code !== 0 && /Cannot convert undefined or null to object/.test(r.out), tail(r.out, 160));
  fs.rmSync(oldDir, { recursive: true, force: true });

  quiet.restore();
  await drill.stop();

  // =========================================================================
  c.head("5 · restore-rehearsal, the real CLI, on isolated databases");
  type Evidence = { verdict: string; engine: string; failures: number; lines: { level: string; area: string; text: string }[] };
  const rehearse = async (file: string, engine: "pglite" | "postgres") => {
    const ev = path.join(TMP, `${path.basename(file, ".json")}.${engine}.rehearsal.json`);
    const res = await runCli("scripts/restore-rehearsal.ts", [file, "--engine", engine, "--port", String(PORT), "--evidence", ev, "--now", new RealDate(PINNED).toISOString()], { drillPreload: true });
    const evidence = fs.existsSync(ev) ? (JSON.parse(fs.readFileSync(ev, "utf8")) as Evidence) : null;
    return { res, evidence, mode: fs.existsSync(ev) ? fs.statSync(ev).mode & 0o777 : null };
  };
  const has = (e: Evidence | null, level: string, area: string, re: RegExp) => !!e?.lines.some((l) => l.level === level && l.area === area && re.test(l.text));

  const good = await rehearse(out1, "pglite");
  c.ok("the clean backup: exit 0, verdict PASS, on PGlite", good.res.code === 0 && good.evidence?.verdict === "PASS" && good.evidence.engine === "pglite", tail(good.res.out, 300));
  for (const area of ["header", "load", "counts", "roundtrip", "fk", "plainref", "smoke"]) {
    c.ok(`…PASS ${area}`, has(good.evidence, "PASS", area, /./));
  }
  c.ok("…the round trip compared every row and the header's id hashes", has(good.evidence, "PASS", "roundtrip", /id hashes equal the header's/));
  c.ok("…the pre-existing dangling plain ref is a WARN, never a FAIL", has(good.evidence, "WARN", "plainref", /^ContentEnrollment\.clientId -> Client: 1 dangling, already so in the file/));
  c.ok("…49 foreign keys checked", has(good.evidence, "PASS", "fk", /^49 foreign keys/));
  c.ok("…the evidence file is 0600", good.mode === 0o600);
  c.ok("…no row value in the output (names and counts only)", !/Agent Alpha|pat@drill|12 Oak St|Twilight/.test(good.res.out + JSON.stringify(good.evidence)));

  const legacy = await rehearse(outLegacy, "pglite");
  c.ok("a legacy (unstamped) backup-all file: PASS, with the missing stamp said out loud", legacy.res.code === 0 && legacy.evidence?.verdict === "PASS" && has(legacy.evidence, "WARN", "header", /does not stamp its schema/), tail(legacy.res.out, 300));

  const worse = await rehearse(outBad, "pglite");
  c.ok("the BAD backup: exit 1, verdict FAIL", worse.res.code === 1 && worse.evidence?.verdict === "FAIL", tail(worse.res.out, 200));
  c.ok("…FAIL naming the model missing from the header", has(worse.evidence, "FAIL", "header", /^Contact: in the backup's schema, missing from the file/));
  c.ok("…FAIL naming the unknown column", has(worse.evidence, "FAIL", "columns", /^Client\.legacyNickname: in the backup, not a column/));
  c.ok("…FAIL naming the duplicate unique field and its constraint", has(worse.evidence, "FAIL", "load", /^TeamMember\.email: duplicate on unique TeamMember_email_key — 1 row rejected/), worse.evidence?.lines.filter((l) => l.area === "load").map((l) => l.text).join(" | "));
  c.ok("…FAIL naming the required-FK orphan", has(worse.evidence, "FAIL", "fk", /^ChecklistItem\.projectId -> Project: 1 orphan row on a REQUIRED relation/));
  c.ok("…and the counts say what did not load", has(worse.evidence, "FAIL", "counts", /^TeamMember: file 3, restored 2/));
  c.ok("…still no row value in the output", !/pat@drill|Agent Alpha|"Al"/.test(worse.res.out + JSON.stringify(worse.evidence)));

  if (REALPG) {
    const sig = (e: Evidence | null) => (e?.lines ?? []).filter((l) => l.level !== "INFO").map((l) => `${l.level} ${l.area} ${l.text}`).join("\n");
    const goodPg = await rehearse(out1, "postgres");
    c.ok("the clean backup on the embedded REAL Postgres: PASS", goodPg.res.code === 0 && goodPg.evidence?.verdict === "PASS" && goodPg.evidence.engine === "postgres", tail(goodPg.res.out, 300));
    c.ok("…the same lines as PGlite (engine lines aside)", sig(goodPg.evidence) === sig(good.evidence), sig(goodPg.evidence) === sig(good.evidence) ? "" : `pg:\n${sig(goodPg.evidence)}\npglite:\n${sig(good.evidence)}`);
    const worsePg = await rehearse(outBad, "postgres");
    c.ok("the BAD backup on real Postgres: FAIL, the same lines as PGlite", worsePg.res.code === 1 && worsePg.evidence?.verdict === "FAIL" && sig(worsePg.evidence) === sig(worse.evidence), sig(worsePg.evidence) === sig(worse.evidence) ? "" : `pg:\n${sig(worsePg.evidence)}\npglite:\n${sig(worse.evidence)}`);
  } else {
    console.log("  SKIP the real-Postgres engine: tools/realpg is not installed (npm install --prefix tools/realpg)");
  }

  // =========================================================================
  c.head("5b · recovery-drill leaves no production-row subset behind, even when it fails (review, Sep 28)");
  // A backup whose scenario 2 must FAIL (no enrollment rows: a restore of
  // nothing "succeeds", so the drill says the orphan check was not proven).
  // The old cleanup lived in scenario 3's finally, so this path left
  // <backup>.json.children-only.json beside the backup for good — where the
  // probe then read it as "the newest backup".
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-a02-recovery-"));
    const fake = path.join(dir, "rtp-backup-2026-09-28-fake.json");
    fs.writeFileSync(fake, JSON.stringify({ takenAt: new Date().toISOString(), tables: { Client: [], ContentEnrollment: [] } }), { mode: 0o600 });
    const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("rtp-recovery-drill-")));
    const run = await runCli("scripts/recovery-drill.ts", [fake, "--port", String(Number(process.env.RECOVERY_PORT ?? 5890))]);
    const left = fs.readdirSync(dir).filter((n) => n !== path.basename(fake));
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("rtp-recovery-drill-") && !tmpBefore.has(n));
    c.ok("the drill fails in scenario 2, as this backup must make it", run.code === 1 && /DRILL FAILED: orphaned rows were accepted/.test(run.out), tail(run.out, 200));
    c.ok("…and NOTHING is left beside the backup (no .children-only.json)", left.length === 0, left.join(", ") || "clean");
    c.ok("…nor in its private temporary directory, which is gone", tmpAfter.length === 0, tmpAfter.join(", ") || "clean");
    const src = fs.readFileSync(path.join(REPO, "scripts/recovery-drill.ts"), "utf8");
    c.ok("the subsets are written to a mkdtemp directory, removed on every exit (and on Ctrl+C)", /mkdtempSync\(join\(tmpdir\(\), "rtp-recovery-drill-"\)\)/.test(src) && /process\.on\("exit", removeSubsets\)/.test(src) && /"SIGINT", "SIGTERM"/.test(src));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // =========================================================================
  c.head("6 · nothing left the machine");
  c.ok("no outbound call from this process", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("the backups were written outside the repo, and are removed", !TMP.startsWith(REPO));
  fs.rmSync(TMP, { recursive: true, force: true });

  c.summary();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
