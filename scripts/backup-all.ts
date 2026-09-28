// ---------------------------------------------------------------------------
// READ-ONLY export of EVERY table to one JSON file (Sep 24 2026).
//
// backup-content-program.ts covers the program's own models. The completion
// audit's batch A changes review, revision and upload tables too, which that
// file never held — and there is no pg_dump on this machine. This walks the
// Prisma datamodel instead of a remembered list, so a model added tomorrow is
// in tomorrow's backup, and a model that cannot be read is a FAILURE.
//
// STRUCTURALLY READ-ONLY: the connection is opened with
// default_transaction_read_only=on and the script proves it with a refused
// UPDATE (SQLSTATE 25006) before it reads a single row.
//
// Sep 28 2026 (A02-backup-coverage), format rtp-backup-all/2:
//   - ONE SNAPSHOT. The whole export runs in a single repeatable-read
//     transaction (scripts/_lib/exportAll.ts), not minutes of separate reads.
//   - The file says what produced it: commit, schemaHash (same rule as the
//     program backup), Prisma and Postgres versions, and per-model id hashes
//     the restore rehearsal compares against.
//   - Mode 0600. The Sep 22-25 files were world-readable and hold client data.
//   - A table in the database that no model maps is listed in the header.
//   - Written one row per line, never as one giant string (the 213 MB file
//     was within 2.4x of V8's string ceiling), and only renamed into place
//     when complete: a failed backup leaves no file behind.
//
// Usage: npx tsx scripts/backup-all.ts <output.json>   (write it OUTSIDE the repo)
// Neon point-in-time restore remains the primary recovery path; this is the
// row-level copy that needs nothing but the Prisma client. Prove it restores
// with: npx tsx scripts/restore-rehearsal.ts <output.json>
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { pinReadOnlyDatabaseUrl, proveReadOnly } from "./_lib/dbGuard";
import { REPO, currentSchemaText, headCommit, schemaHashOf, writeBackupFile } from "./_lib/backupFormat";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: npx tsx scripts/backup-all.ts <output.json>"); process.exit(2); }
if (path.resolve(OUT).startsWith(REPO + path.sep)) { console.error("refusing to write a backup inside the repo"); process.exit(2); }
if (fs.existsSync(OUT)) { console.error(`refusing to overwrite ${OUT} — choose a new name`); process.exit(2); }

async function main() {
  // Before anything can construct a Prisma client (Prisma would load .env).
  pinReadOnlyDatabaseUrl();
  const { Prisma, PrismaClient } = await import("@prisma/client");
  const { allModels, snapshotExport } = await import("./_lib/exportAll");
  const prisma = new PrismaClient();
  try {
    await proveReadOnly(prisma);
    console.log("read-only connection proven (25006)");

    const models = allModels();
    const snap = await snapshotExport(prisma, models);
    let schemaHash = "unknown";
    try { schemaHash = schemaHashOf(currentSchemaText()); } catch { /* not in a checkout */ }
    const { bytes } = writeBackupFile(OUT, {
      takenAt: snap.takenAt,
      commit: headCommit() ?? "unknown",
      schemaHash,
      prismaVersion: Prisma.prismaVersion.client,
      serverVersion: snap.serverVersion,
      snapshot: "repeatable-read",
      models: models.length,
      counts: snap.counts,
      idHash: snap.idHash,
      unmappedTables: snap.unmappedTables,
    }, snap.data);

    const total = Object.values(snap.counts).reduce((a, b) => a + b, 0);
    console.log(`${Object.keys(snap.counts).length}/${models.length} models, ${total} rows, one snapshot at ${snap.takenAt} → ${OUT} (${(bytes / 1e6).toFixed(1)} MB, mode 600)`);
    console.log(`Postgres ${snap.serverVersion} · Prisma ${Prisma.prismaVersion.client} · schema ${schemaHash}`);
    if (snap.unmappedTables.length) {
      console.log(`WARN tables no Prisma model maps (NOT in this file): ${snap.unmappedTables.map((t) => `${t.table} (${t.rows ?? "?"} rows)`).join(", ")}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  // Nothing was written: writeBackupFile renames into place only on success.
  // Prisma's messages open with a blank line and an "Invalid … invocation"
  // banner; the cause is the first line after them.
  const lines = String((e as Error)?.message ?? e).split("\n").map((l) => l.trim()).filter(Boolean);
  const cause = lines.find((l) => !/^(Invalid|→|\d+ |at\s)/.test(l)) ?? lines[0] ?? "unknown error";
  console.error(`BACKUP FAILED — no file written: ${cause.slice(0, 300)}`);
  process.exit(1);
});
