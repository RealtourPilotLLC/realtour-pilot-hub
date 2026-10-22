// ---------------------------------------------------------------------------
// THE DRY-RUN GUARD for the Oct 22 2026 content audit repairs (scripts/_live/
// oct22-audit-*.ts). Imported FIRST, before anything loads Prisma:
//   · without --apply it forces default_transaction_read_only=on on the
//     connection, and `ro()` proves it with a refused write before any read;
//   · with --apply it leaves the connection as it is (the script writes).
// The database URL comes from the environment, else this checkout's .env.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

export const APPLY = process.argv.includes("--apply");

if (!APPLY) {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const file = path.resolve(__dirname, "../../.env");
    const m = fs.existsSync(file) ? fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m) : null;
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found: the dry run refuses to run without the read-only guard.");
  const u = new URL(url);
  u.searchParams.set("options", [u.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}

/** The app's Prisma client. In a dry run, only after a refused write proves the connection is read-only. */
export async function db() {
  const { prisma } = await import("../../src/lib/prisma");
  if (!APPLY) {
    let refused = false;
    try {
      await prisma.appSetting.updateMany({ where: { key: "__oct22_audit_readonly_probe__" }, data: { value: "x" } });
    } catch (e) {
      refused = String(e).includes("read-only") || String(e).includes("25006");
    }
    if (!refused) throw new Error("The read-only guard is NOT proven: refusing to continue the dry run.");
    console.log("dry run: the connection is read-only (a write was refused). Add --apply to write.");
  }
  return prisma;
}
