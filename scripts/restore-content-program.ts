// RECOVERY PATH for scripts/backup-content-program.ts — restores rows by id.
//
// Modes:
//   --dry-run (default): prove the file can be replayed against the CURRENT
//                        schema. Writes nothing.
//   --deep:              the same, but by actually performing every upsert
//                        inside a transaction that is ALWAYS rolled back. This
//                        is the only mode that proves fields, types,
//                        constraints and relationships — the real ability to
//                        insert. It takes write locks, so run it deliberately.
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
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { createHash } from "crypto";

const p = new PrismaClient();
const file = process.argv[2];
const apply = process.argv.includes("--apply");
const deep = process.argv.includes("--deep");
// Refuse rather than report when a plain ref points at nothing. The recovery
// drill runs with this; a live dry run reports and carries on, because existing
// data may already carry a dangling ref that is nobody's emergency today.
const strict = process.argv.includes("--strict");
if (!file) { console.error("usage: npx tsx scripts/restore-content-program.ts <backup.json> [--deep|--apply]"); process.exit(2); }

// Legacy files name the enrolled-client table differently; everything else is
// the model name, whose delegate is the same name with a lowercase first letter.
const ALIASES: Record<string, string> = { "Client(enrolled)": "client" };
const delegateFor = (table: string) => ALIASES[table] ?? table.charAt(0).toLowerCase() + table.slice(1);

type Delegate = {
  findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  upsert: (a: unknown) => Promise<unknown>;
};

const ROLLBACK = "__rehearsal_rollback__";

/**
 * THE REFERENCES POSTGRES DOES NOT ENFORCE.
 *
 * The Content Program is deliberately decoupled from the operational core: 177
 * of its columns are "plain refs" — an id in a String column with no foreign
 * key behind it. ContentEnrollment.clientId is the plainest example, and the
 * recovery drill caught what that means: restoring enrollments into a database
 * with no Client rows at all SUCCEEDED, writing 29 enrollments that belonged to
 * nobody. The database cannot object, so the restore has to.
 *
 * The map is read from the schema's own documented convention — `field String
 * // -> Model` — rather than hand-maintained here, so a new plain ref is
 * covered the day somebody writes that comment.
 */
function plainRefs(schemaText: string): Map<string, Map<string, string>> {
  const models = new Set([...schemaText.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  const byModel = new Map<string, Map<string, string>>();
  let current: string | null = null;
  for (const line of schemaText.split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) { current = open[1]; continue; }
    if (/^\}/.test(line)) { current = null; continue; }
    if (!current) continue;
    const m = /^\s*(\w+)\s+\S+.*\/\/\s*->\s*(\w+)/.exec(line);
    if (!m) continue;
    const [, field, target] = m;
    // "// -> the version Jordan approved" is prose, not a model name.
    if (!models.has(target)) continue;
    if (!byModel.has(current)) byModel.set(current, new Map());
    byModel.get(current)!.set(field, target);
  }
  return byModel;
}

/**
 * Every plain ref in the file that points at nothing — not in the file, and not
 * in the database being restored into. Returns one line per (model.field ->
 * target) that has misses, with a count and an example.
 */
async function danglingRefs(
  client: Record<string, Delegate | undefined>,
  tables: [string, Record<string, unknown>[]][],
  refs: Map<string, Map<string, string>>,
): Promise<string[]> {
  const inFile = new Map<string, Set<string>>();
  for (const [table, rows] of tables) {
    inFile.set(table, new Set(rows.map((r) => String(r.id))));
  }
  // What each target model is being asked for, gathered across the whole file.
  const wanted = new Map<string, Map<string, { from: string; field: string }>>();
  for (const [table, rows] of tables) {
    const fields = refs.get(table);
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
    const delegate = client[delegateFor(target)];
    if (!delegate?.findMany) continue; // a model this schema no longer has
    const idList = [...ids.keys()];
    const found = new Set<string>();
    // Chunked: an id list of thousands is not one query.
    for (let i = 0; i < idList.length; i += 500) {
      const chunk = idList.slice(i, i + 500);
      const rows = await delegate.findMany({ where: { id: { in: chunk } }, select: { id: true } }).catch(() => []);
      for (const r of rows) found.add(String((r as { id: string }).id));
    }
    const missing = idList.filter((id) => !found.has(id));
    if (!missing.length) continue;
    const byOrigin = new Map<string, number>();
    for (const id of missing) {
      const o = ids.get(id)!;
      const k = `${o.from}.${o.field} -> ${target}`;
      byOrigin.set(k, (byOrigin.get(k) ?? 0) + 1);
    }
    for (const [k, n] of byOrigin) report.push(`${k}: ${n} id${n === 1 ? "" : "s"} point at nothing (e.g. ${missing[0]})`);
  }
  return report;
}

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

function revive(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? new Date(v) : v;
  }
  return out;
}

async function main() {
  const dump = JSON.parse(readFileSync(file, "utf8")) as {
    takenAt: string; commit?: string; schemaHash?: string; tables: Record<string, Record<string, unknown>[]>;
  };
  const mode = apply ? "APPLY" : deep ? "DRY-RUN (deep, rolled back)" : "DRY-RUN (structural)";
  console.log(`backup taken ${dump.takenAt}${dump.commit ? ` at ${dump.commit.slice(0, 8)}` : ""}; mode ${mode}`);

  // Is this file even from this schema? Restoring across a migration can still
  // be right — additive changes keep old backups replayable — but it is never
  // something to discover silently.
  let current = "unknown";
  try { current = createHash("sha256").update(readFileSync("prisma/schema.prisma")).digest("hex").slice(0, 16); } catch { /* not in the repo root */ }
  if (dump.schemaHash && dump.schemaHash !== current) {
    console.log(`  ! schema has changed since this backup (file ${dump.schemaHash}, now ${current}) — replaying across a migration`);
  } else if (!dump.schemaHash) {
    console.log("  ! this file predates schema stamping — it cannot say which schema produced it");
  }

  const client = p as unknown as Record<string, Delegate | undefined>;
  const tables = Object.entries(dump.tables);
  let problems = 0;
  const missing: string[] = [];
  for (const [table] of tables) {
    const d = client[delegateFor(table)];
    if (!d?.upsert) missing.push(table);
  }
  if (missing.length) {
    console.error(`\nCANNOT RESTORE — ${missing.length} table(s) in this file have no model on the current schema:`);
    for (const m of missing) console.error(`  ${m}`);
    console.error("\nThese rows would be silently dropped by a restore. Resolve the rename before going further.");
    process.exit(1);
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
  const retry: { table: string; row: Record<string, unknown> }[] = [];

  const place = async (delegate: Delegate, row: Record<string, unknown>): Promise<void> => {
    const id = row.id as string;
    const data = revive(row);
    const { id: _id, ...rest } = data; void _id;
    await delegate.upsert({ where: { id }, create: data, update: rest });
  };

  // PRE-FLIGHT: the references Postgres cannot check for us.
  let schemaText = "";
  try { schemaText = readFileSync("prisma/schema.prisma", "utf8"); } catch { /* not in the repo root */ }
  if (schemaText) {
    const dangling = await danglingRefs(client, tables, plainRefs(schemaText));
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

  const run = async (tx: Record<string, Delegate | undefined>) => {
    let total = 0;
    for (const [table, rows] of tables) {
      const delegate = tx[delegateFor(table)]!;
      // What the live table actually looks like now — one row is enough to see
      // whether a backed-up column has been renamed or dropped.
      let liveKeys: Set<string> | null = null;
      if (!apply && !deep) {
        const sample = await delegate.findFirst({}).catch(() => null);
        liveKeys = sample ? new Set(Object.keys(sample)) : null;
      }
      let ok = 0;
      for (const row of rows) {
        const id = row.id as string;
        const data = revive(row);
        try {
          if (apply || deep) {
            await place(delegate, row);
          } else if (liveKeys) {
            const unknownKeys = Object.keys(data).filter((k) => !liveKeys!.has(k));
            if (unknownKeys.length) throw new Error(`columns not on the live model: ${unknownKeys.join(", ")}`);
          }
          ok++;
        } catch (e) {
          // Held for the retry pass rather than counted as a problem now — a
          // parent later in the file may be about to arrive.
          if (apply || deep) retry.push({ table, row });
          else { problems++; if (problems <= 40) console.log(`  ${table} ${id}: ${firstLine(e)}`); }
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
          await place(tx[delegateFor(item.table)]!, item.row);
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
        try { await place(tx[delegateFor(item.table)]!, item.row); } catch (e) { why = firstLine(e); }
        console.log(`  ${item.table} ${String(item.row.id)}: ${why}`);
      }
    }
    return total;
  };

  let total = 0;
  if (deep && !apply) {
    // THE REHEARSAL. Every write really happens, against the real schema, and
    // is then thrown away by throwing out of the transaction.
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
  if (problems) process.exit(1);
}
main().finally(() => p.$disconnect());
