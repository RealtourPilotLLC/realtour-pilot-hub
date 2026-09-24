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
// Usage: npx tsx scripts/backup-all.ts <output.json>   (write it OUTSIDE the repo)
// Neon point-in-time restore remains the primary recovery path; this is the
// row-level copy that needs nothing but the Prisma client.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: npx tsx scripts/backup-all.ts <output.json>"); process.exit(2); }
if (path.resolve(OUT).startsWith(path.resolve(__dirname, ".."))) { console.error("refusing to write a backup inside the repo"); process.exit(2); }

{
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const m = fs.readFileSync(path.resolve(__dirname, "../.env"), "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}

async function main() {
  const { Prisma, PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`UPDATE "Client" SET "name" = "name" WHERE false`);
    throw new Error("GUARD FAILED — the connection accepted a write");
  } catch (e) {
    if (!/25006|read-only/i.test(String(e))) throw e;
  }
  console.log("read-only connection proven (25006)");

  const models = Prisma.dmmf.datamodel.models;
  const out: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  let failures = 0;
  for (const m of models) {
    const delegate = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown[]> }>)[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
    try {
      const hasId = m.fields.some((f) => f.name === "id" && f.isId);
      const rows: unknown[] = [];
      if (hasId) {
        let cursor: string | undefined;
        for (;;) {
          const page = await delegate.findMany({ take: 2000, orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
          rows.push(...page);
          if (page.length < 2000) break;
          cursor = (page[page.length - 1] as { id: string }).id;
        }
      } else {
        rows.push(...(await delegate.findMany({})));
      }
      out[m.name] = rows;
      counts[m.name] = rows.length;
    } catch (e) {
      failures++;
      console.error(`FAILED ${m.name}: ${String(e).slice(0, 200)}`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ takenAt: new Date().toISOString(), models: models.length, counts, data: out }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${Object.keys(counts).length}/${models.length} models, ${total} rows → ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
  await prisma.$disconnect();
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
