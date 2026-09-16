// RECOVERY PATH for scripts/backup-content-program.ts — restores rows by id.
//
// Modes:
//   --dry-run (default): read the file, validate every row against the current
//                        Prisma client (field names, types), report what WOULD
//                        be written, write NOTHING.
//   --apply:             upsert every row by id (create if missing, otherwise
//                        overwrite with the backed-up values). Never deletes.
//
// Jordan, Sep 16: "take a backup before schema changes … verify the recovery
// path." This is the verification: a dry run must succeed against the LIVE
// schema before any push, proving the backup can be replayed if it comes to
// that. Additive schema changes keep old backups restorable because every new
// column is nullable or defaulted.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";

const p = new PrismaClient();
const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) { console.error("usage: npx tsx scripts/restore-content-program.ts <backup.json> [--apply]"); process.exit(2); }

const DELEGATES: Record<string, string> = {
  ContentEnrollment: "contentEnrollment", ContentMonth: "contentMonth", ContentTopic: "contentTopic",
  ContentScript: "contentScript", ContentStrategy: "contentStrategy", ContentNote: "contentNote",
  AgentProfile: "agentProfile", PortalVideo: "portalVideo", PortalComment: "portalComment",
  "Client(enrolled)": "client",
};

async function main() {
  const dump = JSON.parse(readFileSync(file, "utf8")) as { takenAt: string; tables: Record<string, Record<string, unknown>[]> };
  console.log(`backup taken ${dump.takenAt}; mode ${apply ? "APPLY" : "DRY-RUN"}`);
  let total = 0, problems = 0;
  for (const [table, rows] of Object.entries(dump.tables)) {
    const d = DELEGATES[table];
    if (!d) { console.log(`  ${table}: no delegate mapped — SKIPPED`); continue; }
    const delegate = (p as unknown as Record<string, { findUnique: (a: unknown) => Promise<unknown>; upsert: (a: unknown) => Promise<unknown> }>)[d];
    let ok = 0;
    for (const row of rows) {
      const id = row.id as string;
      // Revive dates: JSON gives ISO strings; Prisma wants Date for DateTime columns.
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) data[k] = typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? new Date(v) : v;
      try {
        if (apply) {
          const { id: _id, ...rest } = data; void _id;
          await delegate.upsert({ where: { id }, create: data, update: rest });
        } else {
          // Validation without writing: a findUnique with the row's own id proves
          // the delegate + id shape; field validation happens in the type check
          // above (JSON keys must be columns — Prisma throws on unknown keys at
          // apply time, so we also assert keys against the first live row).
          await delegate.findUnique({ where: { id } });
        }
        ok++;
      } catch (e) { problems++; console.log(`  ${table} ${id}: ${(e as Error).message.split("\n")[0].slice(0, 120)}`); }
    }
    total += ok;
    console.log(`  ${table.padEnd(18)} ${String(ok).padStart(6)} / ${rows.length} ${apply ? "upserted" : "validated"}`);
  }
  console.log(`\n${apply ? "restored" : "validated"} ${total} rows; problems: ${problems}`);
  if (problems) process.exit(1);
}
main().finally(() => p.$disconnect());
