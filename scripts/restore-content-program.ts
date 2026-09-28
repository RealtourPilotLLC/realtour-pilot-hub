// RECOVERY PATH for scripts/backup-content-program.ts — restores rows by id.
//
// Modes:
//   --dry-run (default): prove the file can be replayed against the CURRENT
//                        schema. Writes nothing, on a connection that CANNOT
//                        write (default_transaction_read_only, proven 25006).
//   --deep:              the same, but by actually performing every upsert
//                        inside a transaction that is ALWAYS rolled back. This
//                        is the only mode that proves fields, types,
//                        constraints and relationships — the real ability to
//                        insert. It takes write locks, so it runs ONLY against
//                        a database on this machine (see the guard below).
//   --apply:             upsert every row by id (create if missing, otherwise
//                        overwrite with the backed-up values). Never deletes.
//
// Jordan, Sep 16: "take a backup before schema changes … verify the recovery
// path."
//
// WHAT THE SEP 17 AUDIT FOUND. The dry run called findUnique({where:{id}}) and
// called that validation. Looking up an id proves the delegate exists and the
// id is a string; it says NOTHING about whether the backed-up payload's fields,
// types, constraints or relationships would survive an insert, which is the
// only question a recovery rehearsal is asking. A successful id lookup is not a
// restore test. Tables with no delegate were also printed as "SKIPPED" and
// still counted as a pass — so a backup could validate cleanly while silently
// restoring nothing. Both are fixed below: an unmapped table is a FAILURE, and
// --deep does the real thing and throws it away.
//
// WHAT THE SEP 28 VERIFICATION FOUND (A02-restore-guard). This opened a Prisma
// client on whatever DATABASE_URL said, and the local .env says PRODUCTION:
//   - `--apply` would overwrite live rows with the backed-up values, which may
//     be older than what the office has written since;
//   - `--deep` held a ten-minute interactive WRITE transaction, row locks on
//     every replayed row, in the live database;
//   - it read only `tables`, so a whole-hub backup-all file threw a TypeError;
//   - it upserted `where: { id }`, which AppSetting (keyed by `key`) fails;
//   - revive() turned ANY string shaped like an ISO timestamp into a Date,
//     whatever the column's type.
// Now: the guard (scripts/_lib/dbGuard.ts) decides before any connection is
// made — --deep refuses a hosted database outright (rehearse with
// scripts/restore-rehearsal.ts, which builds an isolated copy); --apply on a
// hosted database needs --target-production --incident "<what happened>",
// shows how many live rows are NEWER than the file, and then needs the
// database host typed back. The file is read through the shared reader
// (`data` or `tables`), keys and DateTime fields come from the datamodel.
//
// Usage: npx tsx scripts/restore-content-program.ts <backup.json> [--deep|--apply] [--strict]
//        [--target-production --incident "<reason>"]
import readline from "node:readline";
import {
  dateFieldsOf, delegateName, idFieldsOf, idKeyOf, plainRefs, readBackup, schemaHashOf,
  type DmmfModel, type Row,
} from "./_lib/backupFormat";
import { hostOf, proveReadOnly, readDatabaseUrl, readOnlyUrl, restoreGuard, type RestoreMode } from "./_lib/dbGuard";
import { readFileSync } from "fs";

const argv = process.argv.slice(2);
const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--incident");
const apply = argv.includes("--apply");
const deep = argv.includes("--deep");
const targetProduction = argv.includes("--target-production");
const incidentAt = argv.indexOf("--incident");
const incident = incidentAt > -1 ? argv[incidentAt + 1] ?? null : null;
// Refuse rather than report when a plain ref points at nothing. The recovery
// drill runs with this; a live dry run reports and carries on, because existing
// data may already carry a dangling ref that is nobody's emergency today.
const strict = argv.includes("--strict");

// Legacy files name the enrolled-client table differently; everything else is
// the model name.
const ALIASES: Record<string, string> = { "Client(enrolled)": "Client" };
const modelNameFor = (table: string) => ALIASES[table] ?? table;

type Delegate = {
  findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  upsert: (a: unknown) => Promise<unknown>;
};

const ROLLBACK = "__rehearsal_rollback__";

/** The restore prints "  <Model> <id>: <why>" per unplaced row. */

/**
 * The line of a Prisma error that actually says what went wrong. Its messages
 * open with "Invalid `x.upsert()` invocation in" and a stack, and the cause is
 * further down — reporting the first non-empty line told us nothing at all
 * during the recovery drill.
 */
function firstLine(e: unknown): string {
  const lines = ((e as Error).message || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // Stack frames and source paths say where WE were, not what went wrong.
    .filter((l) => !/^(at\s|\/|[A-Za-z]:\\)/.test(l) && !/\.(ts|js|mjs|cjs):\d+/.test(l));
  const cause = lines.find((l) =>
    /required but not found|Foreign key|Unique constraint|Argument|violates|does not exist|Inconsistent|Expected|Null constraint|Unknown field|Invalid value/i.test(l),
  );
  return (cause ?? lines.find((l) => !/^(Invalid|\d+ |→|\?|\+|-)/.test(l)) ?? lines[0] ?? "unknown error").slice(0, 200);
}

/** Dates back to Dates — only in the model's DateTime fields (Sep 28: the old
 *  regex revived any text that looked like a timestamp). */
function revive(row: Row, dates: Set<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = dates.has(k) && typeof v === "string" ? new Date(v) : v;
  return out;
}

async function askLine(question: string): Promise<string> {
  process.stderr.write(question);
  const rl = readline.createInterface({ input: process.stdin });
  try {
    for await (const line of rl) return line.trim();
    return "";
  } finally {
    rl.close();
  }
}

async function main() {
  if (!file) { console.error("usage: npx tsx scripts/restore-content-program.ts <backup.json> [--deep|--apply] [--strict] [--target-production --incident \"<reason>\"]"); process.exit(2); }
  if (apply && deep) { console.error("choose one of --deep and --apply"); process.exit(2); }

  // THE GUARD, before anything can open a connection. @prisma/client is not
  // even loaded until this has passed (the a02 drill counts it).
  const mode: RestoreMode = apply ? "apply" : deep ? "deep" : "dry-run";
  const url = readDatabaseUrl();
  const decision = restoreGuard({ mode, url, targetProduction, incident });
  if (!decision.ok) { console.error(`REFUSED: ${decision.reason}`); process.exit(1); }

  const dump = await readBackup(file);
  const label = apply ? "APPLY" : deep ? "DRY-RUN (deep, rolled back)" : "DRY-RUN (structural, read-only)";
  console.log(`backup taken ${dump.header.takenAt}${dump.header.commit ? ` at ${dump.header.commit.slice(0, 8)}` : ""}; mode ${label}; target ${decision.hosted ? `HOSTED ${decision.host}` : `this machine (${hostOf(url)})`}`);

  // Is this file even from this schema? Restoring across a migration can still
  // be right — additive changes keep old backups replayable — but it is never
  // something to discover silently.
  let current = "unknown";
  try { current = schemaHashOf(readFileSync("prisma/schema.prisma")); } catch { /* not in the repo root */ }
  if (dump.header.schemaHash && dump.header.schemaHash !== current) {
    console.log(`  ! schema has changed since this backup (file ${dump.header.schemaHash}, now ${current}) — replaying across a migration`);
  } else if (!dump.header.schemaHash) {
    console.log("  ! this file predates schema stamping — it cannot say which schema produced it");
  }

  const { Prisma, PrismaClient } = await import("@prisma/client");
  const models = new Map((Prisma.dmmf.datamodel.models as unknown as DmmfModel[]).map((m) => [m.name, m]));
  const tables = Object.entries(dump.data) as [string, Row[]][];
  const missing = tables.map(([t]) => t).filter((t) => !models.has(modelNameFor(t)));
  if (missing.length) {
    console.error(`\nCANNOT RESTORE — ${missing.length} table(s) in this file have no model on the current schema:`);
    for (const m of missing) console.error(`  ${m}`);
    console.error("\nThese rows would be silently dropped by a restore. Resolve the rename before going further.");
    process.exit(1);
  }
  const modelOf = (table: string) => models.get(modelNameFor(table))!;

  // The dry run can never write: its connection refuses writes, and says so
  // before it reads. --deep and --apply write, so they get the URL the guard
  // judged — named explicitly, never left to Prisma's own .env lookup.
  const p = new PrismaClient({ datasources: { db: { url: mode === "dry-run" ? readOnlyUrl(url) : url } } });
  try {
    if (mode === "dry-run") {
      await proveReadOnly(p);
      console.log("  read-only connection proven (25006)");
    }
    const client = p as unknown as Record<string, Delegate | undefined>;

    // PRODUCTION --apply: show what would be overwritten, then make a person
    // type the host. Counted on a read-only connection before any write.
    if (mode === "apply" && decision.ok && decision.needsTypedHost) {
      console.log(`\n  INCIDENT: ${incident}`);
      const ro = new PrismaClient({ datasources: { db: { url: readOnlyUrl(url) } } });
      try {
        await proveReadOnly(ro);
        const roClient = ro as unknown as Record<string, Delegate | undefined>;
        let newer = 0, absent = 0;
        for (const [table, rows] of tables) {
          const m = modelOf(table);
          const ids = idFieldsOf(m);
          const d = roClient[delegateName(m.name)]!;
          const hasUpdated = m.fields.some((f) => f.name === "updatedAt" && f.type === "DateTime");
          if (ids.length !== 1) continue;
          const id = ids[0];
          let tNewer = 0, tAbsent = 0;
          for (let i = 0; i < rows.length; i += 500) {
            const chunk = rows.slice(i, i + 500);
            const live = await d.findMany({ where: { [id]: { in: chunk.map((r) => r[id]) } }, select: { [id]: true, ...(hasUpdated ? { updatedAt: true } : {}) } });
            const byId = new Map(live.map((r) => [String(r[id]), r]));
            for (const r of chunk) {
              const l = byId.get(String(r[id]));
              if (!l) { tAbsent++; continue; }
              if (hasUpdated && l.updatedAt instanceof Date && typeof r.updatedAt === "string" && l.updatedAt.getTime() > Date.parse(r.updatedAt)) tNewer++;
            }
          }
          if (tNewer) console.log(`  ${table.padEnd(32)} ${String(tNewer).padStart(6)} live row(s) are NEWER than the file and would be overwritten with older values`);
          newer += tNewer; absent += tAbsent;
        }
        console.log(`  in total: ${newer} newer live row(s) would be overwritten; ${absent} row(s) would be created`);
      } finally {
        await ro.$disconnect();
      }
      const typed = await askLine(`\nType the database host "${decision.host}" to write to PRODUCTION, anything else to stop: `);
      if (typed !== decision.host) { console.error("REFUSED: the host was not typed back — nothing was written."); process.exit(1); }
      console.log("  host confirmed; writing");
    }

    // Rows that could not be placed on their first attempt, kept for a retry pass.
    // WHY RETRIES (recovery drill, Sep 18). Restoring into an EMPTY database
    // surfaced something replaying into a populated one never could: Client rows
    // reference OTHER Client rows (parentClientId — the Aryeo customer-team
    // folding, an assistant pointing at their agent). Insert a child before its
    // parent and it fails, and no ordering of TABLES can fix an ordering problem
    // INSIDE a table. So a failure is not final: the whole file is replayed,
    // then the failures are replayed again, until a pass places nothing new.
    // Self-references, imperfect table order and cycles all come out in the wash,
    // and anything genuinely unplaceable is still reported at the end.
    const retry: { table: string; row: Row }[] = [];

    const place = async (delegate: Delegate, table: string, row: Row): Promise<void> => {
      const m = modelOf(table);
      const ids = idFieldsOf(m);
      const data = revive(row, dateFieldsOf(m));
      // The key from the datamodel: AppSetting's is `key`, and a composite key
      // uses Prisma's compound selector (`a_b: { a, b }`).
      const where = ids.length === 1 ? { [ids[0]]: data[ids[0]] } : { [ids.join("_")]: Object.fromEntries(ids.map((f) => [f, data[f]])) };
      const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !ids.includes(k)));
      await delegate.upsert({ where, create: data, update: rest });
    };

    // PRE-FLIGHT: the references Postgres cannot check for us.
    let schemaText = "";
    try { schemaText = readFileSync("prisma/schema.prisma", "utf8"); } catch { /* not in the repo root */ }
    if (schemaText) {
      const dangling = await danglingRefs(client, tables, plainRefs(schemaText), models);
      if (dangling.length) {
        console.log(`\n  references that point at nothing (no foreign key enforces these):`);
        for (const d of dangling) console.log(`    ${d}`);
        if (strict) {
          console.error(`\nREFUSING — ${dangling.length} broken reference group(s). Restore the parents first, or drop --strict to write anyway.`);
          process.exit(1);
        }
        console.log(`    (reported, not refused — pass --strict to make this fatal)`);
      } else {
        console.log(`  every plain reference in this file resolves`);
      }
    }

    let problems = 0;
    const run = async (tx: Record<string, Delegate | undefined>) => {
      let total = 0;
      for (const [table, rows] of tables) {
        const m = modelOf(table);
        const delegate = tx[delegateName(m.name)]!;
        // What the live table actually looks like now — one row is enough to see
        // whether a backed-up column has been renamed or dropped.
        let liveKeys: Set<string> | null = null;
        if (!apply && !deep) {
          const sample = await delegate.findFirst({}).catch(() => null);
          liveKeys = sample ? new Set(Object.keys(sample)) : null;
        }
        let ok = 0;
        for (const row of rows) {
          try {
            if (apply || deep) {
              await place(delegate, table, row);
            } else if (liveKeys) {
              const unknownKeys = Object.keys(row).filter((k) => !liveKeys!.has(k));
              if (unknownKeys.length) throw new Error(`columns not on the live model: ${unknownKeys.join(", ")}`);
            }
            ok++;
          } catch (e) {
            // Held for the retry pass rather than counted as a problem now — a
            // parent later in the file may be about to arrive.
            if (apply || deep) retry.push({ table, row });
            else { problems++; if (problems <= 40) console.log(`  ${table} ${idKeyOf(row, idFieldsOf(m))}: ${firstLine(e)}`); }
          }
        }
        total += ok;
        console.log(`  ${table.padEnd(32)} ${String(ok).padStart(6)} / ${rows.length} ${apply ? "upserted" : deep ? "replayed" : "checked"}`);
      }
      // THE RETRY PASSES. Each one replays only what is still unplaced; the loop
      // stops as soon as a pass places nothing new, so a genuinely missing parent
      // costs one wasted pass rather than spinning.
      let pass = 0;
      while (retry.length > 0 && pass < 8) {
        pass++;
        const batch = retry.splice(0, retry.length);
        let placed = 0;
        for (const item of batch) {
          try {
            await place(tx[delegateName(modelOf(item.table).name)]!, item.table, item.row);
            placed++;
            total++;
          } catch {
            retry.push(item);
          }
        }
        console.log(`  retry pass ${pass}: placed ${placed}, still unplaced ${retry.length}`);
        if (placed === 0) break;
      }
      for (const item of retry) {
        problems++;
        if (problems <= 40) {
          let why = "could not be placed after retries";
          try { await place(tx[delegateName(modelOf(item.table).name)]!, item.table, item.row); } catch (e) { why = firstLine(e); }
          console.log(`  ${item.table} ${idKeyOf(item.row, idFieldsOf(modelOf(item.table)))}: ${why}`);
        }
      }
      return total;
    };

    let total = 0;
    if (deep && !apply) {
      // THE REHEARSAL. Every write really happens, against the real schema, and
      // is then thrown away by throwing out of the transaction. Loopback only.
      try {
        await p.$transaction(async (tx) => {
          total = await run(tx as unknown as Record<string, Delegate | undefined>);
          throw new Error(ROLLBACK);
        }, { timeout: 10 * 60_000, maxWait: 30_000 });
      } catch (e) {
        if ((e as Error).message !== ROLLBACK) { console.error(`\nrehearsal aborted: ${(e as Error).message}`); process.exit(1); }
        console.log("\n  (rolled back — nothing was written)");
      }
    } else {
      total = await run(client);
    }

    console.log(`\n${apply ? "restored" : deep ? "replayed and rolled back" : "checked"} ${total} rows; problems: ${problems}`);
    if (problems) process.exitCode = 1;
  } finally {
    await p.$disconnect();
  }
}

/**
 * Every plain ref in the file that points at nothing — not in the file, and not
 * in the database being restored into. Returns one line per (model.field ->
 * target) that has misses, with a count and an example.
 */
async function danglingRefs(
  client: Record<string, Delegate | undefined>,
  tables: [string, Row[]][],
  refs: Map<string, Map<string, string>>,
  models: Map<string, DmmfModel>,
): Promise<string[]> {
  const keyOf = (model: string) => { const m = models.get(model); return m ? idFieldsOf(m) : ["id"]; };
  const inFile = new Map<string, Set<string>>();
  for (const [table, rows] of tables) {
    const model = modelNameFor(table);
    inFile.set(model, new Set(rows.map((r) => idKeyOf(r, keyOf(model)))));
  }
  // What each target model is being asked for, gathered across the whole file.
  const wanted = new Map<string, Map<string, { from: string; field: string }>>();
  for (const [table, rows] of tables) {
    const fields = refs.get(modelNameFor(table));
    if (!fields) continue;
    for (const [field, target] of fields) {
      for (const row of rows) {
        const v = row[field];
        if (typeof v !== "string" || !v) continue;
        if (inFile.get(target)?.has(v)) continue; // satisfied by the file itself
        if (!wanted.has(target)) wanted.set(target, new Map());
        if (!wanted.get(target)!.has(v)) wanted.get(target)!.set(v, { from: table, field });
      }
    }
  }
  const report: string[] = [];
  for (const [target, ids] of wanted) {
    const delegate = client[delegateName(target)];
    const m = models.get(target);
    if (!delegate?.findMany || !m) continue; // a model this schema no longer has
    const [idField] = idFieldsOf(m);
    const idList = [...ids.keys()];
    const found = new Set<string>();
    // Chunked: an id list of thousands is not one query.
    for (let i = 0; i < idList.length; i += 500) {
      const chunk = idList.slice(i, i + 500);
      const rows = await delegate.findMany({ where: { [idField]: { in: chunk } }, select: { [idField]: true } }).catch(() => []);
      for (const r of rows) found.add(String(r[idField]));
    }
    const missingIds = idList.filter((id) => !found.has(id));
    if (!missingIds.length) continue;
    const byOrigin = new Map<string, number>();
    for (const id of missingIds) {
      const o = ids.get(id)!;
      const k = `${o.from}.${o.field} -> ${target}`;
      byOrigin.set(k, (byOrigin.get(k) ?? 0) + 1);
    }
    for (const [k, n] of byOrigin) report.push(`${k}: ${n} id${n === 1 ? "" : "s"} point at nothing (e.g. ${missingIds[0]})`);
  }
  return report;
}

main().catch((e) => { console.error(String((e as Error)?.message ?? e).split("\n")[0]); process.exit(1); });
