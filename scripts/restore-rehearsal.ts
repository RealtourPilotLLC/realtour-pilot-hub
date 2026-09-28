// ---------------------------------------------------------------------------
// THE WHOLE-HUB RESTORE REHEARSAL (A02-restore-rehearsal, Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/restore-rehearsal.ts <backup.json> [--engine pglite|postgres] [--port 5610]
//     [--evidence <path>] [--no-smoke] [--now <iso>]
//
// No script could restore a backup-all file: backup-all writes `data`, and the
// restore and the recovery drill read `tables` (a TypeError on the first
// line). The recovery drill covered the program subset and checked three
// hand-picked joins. AUDIT-CHECKLIST called whole-hub recovery unproven. This
// rebuilds EVERY model of a backup in an isolated Postgres and checks it:
//
//   1. the header against the schema that produced it and the current one
//      (a model missing from the file, or unknown to the schema, is a FAIL);
//   2. the load: one session with session_replication_role = replica (so
//      self-references and pre-existing orphans load in any order), 2,000-row
//      chunks through json_populate_recordset, an explicit column list so a
//      column added since the backup takes its DEFAULT. A key the table does
//      not have is a FAIL before loading — json_populate_recordset would drop
//      it without a word. A rejected row (a duplicate on a unique key, a null
//      in a required column) is a FAIL naming the model and field;
//   3. counts: header = file = restored, per model;
//   4. the ROUND TRIP: the same exporter backup-all uses (scripts/_lib/
//      exportAll.ts) reads the restored database, and every row is compared
//      with the file in canonical form. Differences are reported by FIELD
//      NAME and count, never by value; the id hashes must equal the header's;
//   5. every foreign key (49 today): orphans in the file and orphans in the
//      restored database must be the same number, and a REQUIRED relation
//      must have none;
//   6. every plain ref (`field String // -> Model`, 170+): the restore may not
//      add a single dangling reference (the file may already carry some — the
//      Sep 25 backup had 3 — and those are reported, not failed);
//   7. the app reads it: month progress for every month, the Ready-to-send
//      board, cut entitlement on 50 videos and 50 cuts, and the TEST client's
//      portal plan, on the restored copy. None may throw.
//
// ISOLATED, NEVER PRODUCTION. The database is booted through the drill
// harness (bootDrillDb): 127.0.0.1 only, asserted before the schema push and
// again here, every .env secret blanked, fetch and raw sockets fenced. The
// only production data this touches is the FILE. Default engine: the
// embedded real Postgres when tools/realpg has it installed, else PGlite; the
// engine and server version are printed and recorded.
//
// OUTPUT carries model names, field names, constraint names and counts —
// never a row value. The verdict is written as evidence beside the backup
// (<backup>.rehearsal.json, mode 0600), where the config probe looks for it.
// The database is stopped and deleted at the end.
//
// DEVIATION FROM THE SEP 25 DESIGN, deliberately: the design pushed the
// backup commit's schema when it differed from HEAD's. A Prisma client can
// only read the schema it was generated from, so the round trip would need a
// second generated client. This restores into the CURRENT schema — the one a
// real recovery would run the app on — which additive changes survive (new
// columns take their defaults, new models restore empty); anything that is
// not additive fails loudly in steps 1-2, and the answer then is to run this
// from a checkout of the backup's commit.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import {
  REPO, canonical, columnOf, compareBackupToSchema, currentSchemaText, evidencePathFor, fkRelations, idFieldsOf, idKeyOf,
  jsonReplacer, plainRefs, readBackup, readBackupHeader, tableOf, type DmmfModel, type Row,
} from "./_lib/backupFormat";
import { isLoopbackUrl } from "./_lib/dbGuard";
import { bootDrillDb, fenceFetch, installNextStubs, quietPrismaErrors, type DrillEngine } from "./_drill/_harness";

type Level = "PASS" | "FAIL" | "WARN" | "INFO";
type Line = { level: Level; area: string; text: string };

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; };
const FLAGS_WITH_VALUES = new Set(["--engine", "--port", "--evidence", "--now"]);
const file = argv.find((a, i) => !a.startsWith("--") && !FLAGS_WITH_VALUES.has(argv[i - 1] ?? ""));

const lines: Line[] = [];
function say(level: Level, area: string, text: string) {
  lines.push({ level, area, text });
  console.log(`  ${level.padEnd(4)} ${area.padEnd(9)} ${text}`);
}
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * SQLSTATE and the constraint, key columns or column a database error names —
 * never its message text. Postgres puts the offending VALUE in a unique
 * violation's detail ("Key (email)=(…) already exists.", which is what
 * Prisma reports for a raw query), so only the column list before "=" is
 * read, and nothing after it is kept.
 */
function dbReason(e: unknown): { code: string; constraint: string | null; keyColumns: string[] | null; column: string | null } {
  const meta = (e as { meta?: { code?: unknown; message?: unknown } })?.meta;
  const msg = typeof meta?.message === "string" ? meta.message : String((e as Error)?.message ?? e);
  const code = (typeof meta?.code === "string" ? meta.code : null) ?? /Code: `?([0-9A-Z]{5})`?/.exec(msg)?.[1] ?? "?????";
  // The quotes may arrive escaped (\") inside Prisma's own message.
  return {
    code,
    constraint: /constraint \\?"([^"\\]+)\\?"/.exec(msg)?.[1] ?? null,
    keyColumns: /Key \(([^)]+)\)=/.exec(msg)?.[1]?.split(/,\s*/).map((c) => c.replace(/"/g, "")) ?? null,
    column: /column \\?"([^"\\]+)\\?"/.exec(msg)?.[1] ?? null,
  };
}

/** "TeamMember_email_key" -> "email"; "X_pkey" -> the model's id fields. */
function fieldsOfConstraint(m: DmmfModel, constraint: string | null): string {
  if (!constraint) return "?";
  const t = tableOf(m);
  if (constraint === `${t}_pkey`) return idFieldsOf(m).join("+");
  const inner = constraint.startsWith(`${t}_`) ? constraint.slice(t.length + 1).replace(/_(key|idx)$/, "") : constraint;
  const names = m.fields.map((f) => f.name).sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let rest = inner;
  while (rest) {
    const hit = names.find((n) => rest === n || rest.startsWith(`${n}_`));
    if (!hit) return inner;
    out.push(hit);
    rest = rest.slice(hit.length + 1);
  }
  return out.join("+");
}

/** The fields a unique violation is about, and the constraint's name (Prisma's
 *  naming: Model_field_key, Model_pkey) when the error did not say it. */
function uniqueViolation(m: DmmfModel, r: ReturnType<typeof dbReason>): { fields: string; constraint: string } {
  const t = tableOf(m);
  const byColumn = new Map(m.fields.map((f) => [f.dbName || f.name, f.name]));
  if (r.keyColumns?.length) {
    const fields = r.keyColumns.map((c) => byColumn.get(c) ?? c);
    const isPk = idFieldsOf(m).join() === fields.join();
    return { fields: fields.join("+"), constraint: r.constraint ?? (isPk ? `${t}_pkey` : `${t}_${r.keyColumns.join("_")}_key`) };
  }
  return { fields: fieldsOfConstraint(m, r.constraint), constraint: r.constraint ?? "?" };
}

async function main() {
  if (!file) {
    console.error("usage: npx tsx scripts/restore-rehearsal.ts <backup.json> [--engine pglite|postgres] [--port 5610] [--evidence <path>] [--no-smoke] [--now <iso>]");
    process.exit(2);
  }
  const startedAt = new Date();
  const now = flag("--now") ? new Date(flag("--now")!) : new Date();
  const port = Number(flag("--port") ?? process.env.DRILL_PORT ?? 5610);
  const realPgInstalled = fs.existsSync(path.join(REPO, "tools/realpg/node_modules/embedded-postgres/package.json"));
  const engineArg = flag("--engine");
  if (engineArg && engineArg !== "pglite" && engineArg !== "postgres") { console.error(`unknown engine "${engineArg}"`); process.exit(2); }
  const engine: DrillEngine = (engineArg as DrillEngine | undefined) ?? (realPgInstalled ? "postgres" : "pglite");
  const evidencePath = flag("--evidence") ?? evidencePathFor(path.resolve(file));
  const smoke = !argv.includes("--no-smoke");

  // Everything the app might reach for is fenced before anything is loaded.
  installNextStubs();
  const fence = fenceFetch();
  const quiet = quietPrismaErrors();

  console.log(`restore rehearsal · ${path.basename(file)} · engine ${engine}${engineArg ? "" : ` (default: embedded Postgres ${realPgInstalled ? "installed" : "not installed"})`}`);

  // ---- 1 · the header, before any database exists ----------------------
  console.log("\n1 · header against the schema");
  const { Prisma } = await import("@prisma/client");
  const models = Prisma.dmmf.datamodel.models as unknown as readonly DmmfModel[];
  const byName = new Map(models.map((m) => [m.name, m]));
  const head = readBackupHeader(file);
  const cmp = compareBackupToSchema(head, models.map((m) => m.name));
  say("INFO", "header", `${head.header.format ?? "legacy format"} · taken ${head.header.takenAt}${head.header.commit ? ` · commit ${head.header.commit.slice(0, 12)}` : ""}${head.header.serverVersion ? ` · from Postgres ${head.header.serverVersion}` : ""}`);
  if (cmp.sameSchema === false) say("WARN", "header", `the schema has changed since this backup (judged against the ${cmp.basis} schema); restoring into the current one`);
  if (cmp.sameSchema === null) say("WARN", "header", `the file does not stamp its schema; judged against the ${cmp.basis} schema`);
  for (const m of cmp.missing) say("FAIL", "header", `${m}: in the backup's schema, missing from the file`);
  for (const m of cmp.extra) say("FAIL", "header", `${m}: in the file, not a model of the current schema — its rows cannot be restored here`);
  if (cmp.addedSince.length) say("INFO", "header", `added to the schema after this backup (restored empty): ${cmp.addedSince.join(", ")}`);
  if (!cmp.missing.length && !cmp.extra.length) say("PASS", "header", `${head.modelNames?.length ?? "?"} models, all present`);

  const dump = await readBackup(file);
  const data = dump.data;
  const fileRows = Object.values(data).reduce((a, r) => a + r.length, 0);
  for (const [model, rows] of Object.entries(data)) {
    const declared = head.header.counts?.[model];
    if (declared !== undefined && declared !== rows.length) say("FAIL", "counts", `${model}: the header says ${declared} rows, the file holds ${rows.length}`);
  }
  for (const model of Object.keys(head.header.counts ?? {})) {
    if (!(model in data)) say("FAIL", "counts", `${model}: in the header, but the file has no rows section for it`);
  }

  // ---- 2 · boot the isolated database ------------------------------------
  const drill = await bootDrillDb({ port, engine });
  let verdict: "PASS" | "FAIL" = "FAIL";
  let serverVersion = "?";
  let restoredRows = 0;
  try {
    // Asserted again here, not only inside the harness: this is the line that
    // stands between a restore and production.
    if (!isLoopbackUrl(drill.url) || process.env.DATABASE_URL !== drill.url) throw new Error(`refusing: the rehearsal database is not loopback (${new URL(drill.url).hostname})`);
    serverVersion = await drill.serverVersion();
    say("INFO", "engine", `${drill.engine} · Postgres ${serverVersion} · 127.0.0.1:${port}`);

    const { PrismaClient } = await import("@prisma/client");
    // ONE connection, so session_replication_role holds for every insert.
    const u = new URL(drill.url);
    u.searchParams.set("connection_limit", "1");
    const db = new PrismaClient({ datasources: { db: { url: u.toString() } } });
    try {
      // ---- in-file relationship counts, before anything is loaded ----------
      const fks = fkRelations(models);
      const refs = plainRefs(currentSchemaText());
      const keySet = (model: string, fields: string[]) => new Set((data[model] ?? []).map((r) => idKeyOf(r, fields)));
      const fkBefore = new Map<string, number>();
      for (const rel of fks) {
        const parents = keySet(rel.parent, rel.parentKey);
        fkBefore.set(rel.name, (data[rel.child] ?? []).filter((r) => rel.fields.every((f) => r[f] !== null && r[f] !== undefined) && !parents.has(idKeyOf(r, rel.fields))).length);
      }
      type Ref = { model: string; field: string; target: string; name: string };
      const refList: Ref[] = [];
      for (const [model, fields] of refs) for (const [field, target] of fields) {
        if (byName.has(model) && byName.has(target)) refList.push({ model, field, target, name: `${model}.${field} -> ${target}` });
      }
      const plainBefore = new Map<string, number>();
      for (const r of refList) {
        const targets = keySet(r.target, idFieldsOf(byName.get(r.target)!));
        plainBefore.set(r.name, (data[r.model] ?? []).filter((row) => typeof row[r.field] === "string" && row[r.field] !== "" && !targets.has(String(row[r.field]))).length);
      }

      // ---- 3 · load ---------------------------------------------------------
      console.log("\n2 · load");
      const colRows = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
      );
      const columns = new Map<string, string[]>();
      for (const c of colRows) columns.set(c.table_name, [...(columns.get(c.table_name) ?? []), c.column_name]);

      await db.$executeRawUnsafe(`SET session_replication_role = replica`);
      const rejected = new Map<string, number>();
      let unknownCols = 0;
      for (const [model, rows] of Object.entries(data)) {
        const m = byName.get(model);
        if (!m || rows.length === 0) continue;
        const table = tableOf(m);
        const tableCols = new Set(columns.get(table) ?? []);
        const keys = new Set<string>();
        for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
        for (const k of keys) {
          if (!tableCols.has(columnOf(m, k))) { unknownCols++; say("FAIL", "columns", `${model}.${k}: in the backup, not a column of the restored table (a restore would drop it silently)`); }
        }
        const insertCols = (columns.get(table) ?? []).filter((c) => [...keys].some((k) => columnOf(m, k) === c));
        if (!insertCols.length) { say("FAIL", "load", `${model}: none of the file's fields is a column of the restored table`); continue; }
        const colList = insertCols.map(q).join(", ");
        const sql = `INSERT INTO ${q(table)} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::${q(table)}, $1::json)`;
        const asJson = (chunk: Row[]) => JSON.stringify(chunk, jsonReplacer);
        for (let i = 0; i < rows.length; i += 2000) {
          const chunk = rows.slice(i, i + 2000);
          try {
            await db.$executeRawUnsafe(sql, asJson(chunk));
          } catch {
            // One bad row fails the whole chunk: place the rest one at a time
            // and count what is refused, by constraint.
            for (const row of chunk) {
              try { await db.$executeRawUnsafe(sql, asJson([row])); } catch (e) {
                const r = dbReason(e);
                const u = r.code === "23505" ? uniqueViolation(m, r) : null;
                const what = u ? `${model}.${u.fields}: duplicate on unique ${u.constraint}`
                  : r.code === "23502" ? `${model}.${r.column ?? "?"}: null in a required column`
                  : r.code === "23514" ? `${model}: check constraint ${r.constraint ?? "?"}`
                  : /^22/.test(r.code) ? `${model}${r.column ? `.${r.column}` : ""}: a value does not fit its column type (SQLSTATE ${r.code})`
                  : `${model}: SQLSTATE ${r.code}`;
                rejected.set(what, (rejected.get(what) ?? 0) + 1);
              }
            }
          }
        }
      }
      await db.$executeRawUnsafe(`RESET session_replication_role`);
      for (const [what, n] of rejected) say("FAIL", "load", `${what} — ${n} row${n === 1 ? "" : "s"} rejected`);
      if (!rejected.size && !unknownCols) say("PASS", "load", `${Object.keys(data).length} models loaded with no row refused`);

      // ---- 4 · counts ---------------------------------------------------------
      console.log("\n3 · counts");
      let countFails = 0;
      for (const [model, rows] of Object.entries(data)) {
        const m = byName.get(model);
        if (!m) continue;
        const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(tableOf(m))}`);
        restoredRows += Number(n);
        if (Number(n) !== rows.length) { countFails++; say("FAIL", "counts", `${model}: file ${rows.length}, restored ${n}`); }
      }
      if (!countFails) say("PASS", "counts", `${restoredRows} of ${fileRows} rows restored across ${Object.keys(data).length} models`);

      // ---- 5 · the round trip ---------------------------------------------------
      console.log("\n4 · round trip (the backup's own exporter, row by row)");
      const { exportAll } = await import("./_lib/exportAll");
      const present = models.filter((m) => data[m.name]);
      const back = await exportAll(db, present);
      let rtFails = 0;
      for (const m of present) {
        const ids = idFieldsOf(m);
        const before = new Map((data[m.name] ?? []).map((r) => [idKeyOf(r, ids), r]));
        const after = new Map((back.data[m.name] ?? []).map((r) => [idKeyOf(r, ids), r]));
        let missing = 0, extra = 0;
        const fieldDiffs = new Map<string, number>();
        const added = new Set<string>();
        for (const [id, r] of before) {
          const got = after.get(id);
          if (!got) { missing++; continue; }
          for (const k of Object.keys(got)) if (!(k in r)) added.add(k);
          // Compare only what the file holds: a column added since has no
          // value in the file to compare against.
          const projected: Row = {};
          for (const k of Object.keys(r)) projected[k] = got[k];
          if (canonical(projected) === canonical(r)) continue;
          for (const k of Object.keys(r)) {
            if (canonical({ v: projected[k] }) !== canonical({ v: r[k] })) fieldDiffs.set(k, (fieldDiffs.get(k) ?? 0) + 1);
          }
        }
        for (const id of after.keys()) if (!before.has(id)) extra++;
        if (missing) { rtFails++; say("FAIL", "roundtrip", `${m.name}: ${missing} row${missing === 1 ? "" : "s"} in the file did not come back`); }
        if (extra) { rtFails++; say("FAIL", "roundtrip", `${m.name}: ${extra} row${extra === 1 ? "" : "s"} came back that the file does not hold`); }
        for (const [f, n] of fieldDiffs) { rtFails++; say("FAIL", "roundtrip", `${m.name}.${f}: ${n} row${n === 1 ? "" : "s"} read back different`); }
        if (added.size) say("INFO", "roundtrip", `${m.name}: ${[...added].join(", ")} added after this backup (default on restore)`);
        const hash = head.header.idHash?.[m.name];
        if (hash && hash !== back.idHash[m.name]) { rtFails++; say("FAIL", "roundtrip", `${m.name}: id hash differs from the header's`); }
      }
      if (!rtFails) say("PASS", "roundtrip", `every row of ${present.length} models reads back identical${head.header.idHash ? "; id hashes equal the header's" : ""}`);

      // ---- 6 · foreign keys -------------------------------------------------------
      console.log("\n5 · foreign keys");
      let fkFails = 0;
      for (const rel of fks) {
        const child = byName.get(rel.child)!, parent = byName.get(rel.parent)!;
        const notNull = rel.fields.map((f) => `c.${q(columnOf(child, f))} IS NOT NULL`).join(" AND ");
        const join = rel.fields.map((f, i) => `p.${q(columnOf(parent, rel.parentKey[i]))} = c.${q(columnOf(child, f))}`).join(" AND ");
        const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(tableOf(child))} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${q(tableOf(parent))} p WHERE ${join})`);
        const was = fkBefore.get(rel.name) ?? 0;
        if (Number(n) !== was) { fkFails++; say("FAIL", "fk", `${rel.name}: the file had ${was} orphan${was === 1 ? "" : "s"}, the restored database has ${n}`); }
        if (rel.required && Number(n) > 0) { fkFails++; say("FAIL", "fk", `${rel.name}: ${n} orphan row${Number(n) === 1 ? "" : "s"} on a REQUIRED relation`); }
        else if (Number(n) > 0) say("WARN", "fk", `${rel.name}: ${n} orphan row${Number(n) === 1 ? "" : "s"} (optional relation, already so in the file)`);
      }
      if (!fkFails) say("PASS", "fk", `${fks.length} foreign keys: no orphan introduced, none on a required relation`);

      // ---- 7 · plain refs -----------------------------------------------------------
      console.log("\n6 · plain references (no foreign key behind them)");
      let plainFails = 0, plainPre = 0;
      for (const r of refList) {
        const child = byName.get(r.model)!, target = byName.get(r.target)!;
        const col = `c.${q(columnOf(child, r.field))}`;
        const tid = `p.${q(columnOf(target, idFieldsOf(target)[0]))}`;
        const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${q(tableOf(child))} c WHERE ${col} IS NOT NULL AND ${col}::text <> '' AND NOT EXISTS (SELECT 1 FROM ${q(tableOf(target))} p WHERE ${tid}::text = ${col}::text)`);
        const was = plainBefore.get(r.name) ?? 0;
        if (Number(n) !== was) { plainFails++; say("FAIL", "plainref", `${r.name}: ${was} dangling in the file, ${n} after the restore`); }
        else if (was > 0) { plainPre += was; say("WARN", "plainref", `${r.name}: ${was} dangling, already so in the file`); }
      }
      if (!plainFails) say("PASS", "plainref", `${refList.length} plain references: the restore added no dangling reference${plainPre ? ` (${plainPre} pre-existing)` : ""}`);
    } finally {
      await db.$disconnect();
    }

    // ---- 8 · the app reads it -----------------------------------------------------
    if (smoke) {
      console.log("\n7 · the app on the restored copy");
      const { prisma } = await import("@/lib/prisma");
      const attempt = async (name: string, fn: () => Promise<string>) => {
        try { say("PASS", "smoke", `${name}: ${await fn()}`); } catch (e) {
          const err = e as { name?: string; code?: string; message?: string };
          if (/OUTBOUND BLOCKED BY DRILL/.test(String(err?.message ?? ""))) say("WARN", "smoke", `${name}: needs a provider (fenced here)`);
          else say("FAIL", "smoke", `${name}: threw ${err?.name ?? "an error"}${err?.code ? ` (${err.code})` : ""}`);
        }
      };
      await attempt("month progress for every month", async () => {
        const { monthProgressMany } = await import("@/lib/monthProgress");
        const months = await prisma.contentMonth.findMany({ select: { id: true, enrollmentId: true, monthKey: true } });
        const res = await monthProgressMany(months.map((m) => ({ enrollmentId: m.enrollmentId, monthId: m.id, monthKey: m.monthKey })), { now });
        return `${res.size} of ${months.length} months`;
      });
      await attempt("Ready-to-send board", async () => {
        const { readyToSend } = await import("@/lib/readyToSend");
        const b = await readyToSend();
        return `${b.ready.length} ready, ${b.rendering.length} rendering`;
      });
      await attempt("cut entitlement on 50 videos", async () => {
        const { entitlementsForVideos } = await import("@/lib/cutEntitlement");
        const videos = await prisma.contentVideo.findMany({ take: 50, orderBy: { id: "asc" }, select: { id: true, enrollmentId: true, clientId: true, monthId: true, currentSubmissionId: true, approvedSubmissionId: true, finalSubmissionId: true } });
        return `${(await entitlementsForVideos(videos)).size} of ${videos.length}`;
      });
      await attempt("cut chains of 50 cuts", async () => {
        const { cutChainOf } = await import("@/lib/cutEntitlement");
        const cuts = await prisma.reviewSubmission.findMany({ take: 50, orderBy: { id: "asc" }, select: { id: true } });
        let rounds = 0;
        for (const c of cuts) rounds += (await cutChainOf(c.id)).length;
        return `${cuts.length} cuts, ${rounds} rounds`;
      });
      await attempt("TEST client's portal plan", async () => {
        const { isTestClientName } = await import("@/lib/testClients");
        const clients = await prisma.client.findMany({ where: { name: { contains: "TEST" } }, select: { id: true, name: true } });
        const test = clients.filter((c) => isTestClientName(c.name));
        const enr = test.length ? await prisma.contentEnrollment.findFirst({ where: { clientId: { in: test.map((c) => c.id) } }, select: { id: true, clientId: true } }) : null;
        if (!enr) return "no TEST client with an enrollment in this backup (nothing to render)";
        const { portalTopics } = await import("@/lib/portal");
        const { planModel } = await import("@/lib/portalHome");
        const { etMonthKey } = await import("@/lib/contentProgram");
        planModel(await portalTopics(enr), etMonthKey(now), now);
        return "rendered";
      });
    }
    verdict = lines.some((l) => l.level === "FAIL") ? "FAIL" : "PASS";
  } finally {
    quiet.restore();
    await drill.stop();
  }

  // ---- 9 · evidence ------------------------------------------------------------------
  const failures = lines.filter((l) => l.level === "FAIL").length;
  const warnings = lines.filter((l) => l.level === "WARN").length;
  const evidence = {
    kind: "rtp-restore-rehearsal/1",
    backup: path.basename(file),
    backupBytes: fs.statSync(file).size,
    takenAt: head.header.takenAt,
    commit: head.header.commit ?? null,
    schemaHash: head.header.schemaHash ?? null,
    format: head.header.format ?? "legacy",
    engine: drill.engine,
    serverVersion,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    verdict,
    failures,
    warnings,
    models: Object.keys(data).length,
    rows: { file: fileRows, restored: restoredRows },
    fenceBlocked: fence.blocked.length,
    lines,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 1), { mode: 0o600 });
  fs.chmodSync(evidencePath, 0o600);
  console.log(`\n${verdict} · ${failures} failure line${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} · engine ${drill.engine} ${serverVersion} · ${fence.blocked.length} outbound call${fence.blocked.length === 1 ? "" : "s"} refused · the database was stopped and removed`);
  console.log(`evidence: ${evidencePath}`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => { console.error(`REHEARSAL ERROR: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300)}`); process.exit(1); },
);
