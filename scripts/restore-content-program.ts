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
if (!file) { console.error("usage: npx tsx scripts/restore-content-program.ts <backup.json> [--deep|--apply]"); process.exit(2); }

// Legacy files name the enrolled-client table differently; everything else is
// the model name, whose delegate is the same name with a lowercase first letter.
const ALIASES: Record<string, string> = { "Client(enrolled)": "client" };
const delegateFor = (table: string) => ALIASES[table] ?? table.charAt(0).toLowerCase() + table.slice(1);

type Delegate = {
  findFirst: (a: unknown) => Promise<Record<string, unknown> | null>;
  upsert: (a: unknown) => Promise<unknown>;
};

const ROLLBACK = "__rehearsal_rollback__";

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
            const { id: _id, ...rest } = data; void _id;
            await delegate.upsert({ where: { id }, create: data, update: rest });
          } else if (liveKeys) {
            const unknownKeys = Object.keys(data).filter((k) => !liveKeys!.has(k));
            if (unknownKeys.length) throw new Error(`columns not on the live model: ${unknownKeys.join(", ")}`);
          }
          ok++;
        } catch (e) {
          problems++;
          if (problems <= 40) console.log(`  ${table} ${id}: ${(e as Error).message.split("\n")[0].slice(0, 140)}`);
        }
      }
      total += ok;
      console.log(`  ${table.padEnd(32)} ${String(ok).padStart(6)} / ${rows.length} ${apply ? "upserted" : deep ? "replayed" : "checked"}`);
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
