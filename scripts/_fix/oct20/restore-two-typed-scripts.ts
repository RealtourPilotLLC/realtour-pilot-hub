// ---------------------------------------------------------------------------
// Oct 20 2026 — the first scripting backfill (scripts/_fix/oct20/
// scripting-backfill.ts) treated two photographers' REAL typed scripts as
// placeholder notes ("everything you've been waiting for" read as a "waiting
// for …" note) and put the platform's script in their place. The rule is fixed
// (scriptSync.looksLikeScript judges note phrases only on short texts); this
// puts back each job's typed script, hook, note and timestamp exactly as the
// full backup taken before the backfill holds them.
//
//   set -a && source .env && set +a && NODE_OPTIONS="--conditions=react-server --max-old-space-size=6144" npx tsx scripts/_fix/oct20/restore-two-typed-scripts.ts [--apply]
// ---------------------------------------------------------------------------
import fs from "node:fs";

const BACKUP = "/Users/jordanspackman/RTP-backups/full-2026-10-20-before-scripting-fields.json";
const TITLES = ["617 Westbourne Rd", "2236 Gregory Dr"];

async function main() {
  const apply = process.argv.includes("--apply");
  const j = JSON.parse(fs.readFileSync(BACKUP, "utf8")) as Record<string, unknown>;
  const holder = (j.data ?? j.rows ?? j.tables ?? j) as Record<string, unknown>;
  const projects = (holder.Project ?? holder.project) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(projects)) throw new Error(`No Project rows in the backup (keys: ${Object.keys(j).join(", ")})`);
  const { prisma } = await import("../../../src/lib/prisma");
  for (const t of TITLES) {
    const old = projects.filter((p) => String(p.title ?? "").startsWith(t));
    if (old.length !== 1) throw new Error(`${t}: ${old.length} rows in the backup`);
    const o = old[0];
    if (!String(o.scriptConfirmNote ?? "").startsWith("Provided on site")) throw new Error(`${t}: the backup's note is not a typed script`);
    const now = await prisma.project.findUniqueOrThrow({ where: { id: String(o.id) }, select: { reelScript: true, scriptConfirmNote: true } });
    console.log(`${t}\n  backup: ${String(o.reelScript).slice(0, 90)}…\n  now:    ${String(now.reelScript).slice(0, 90)}…`);
    if (!String(now.scriptConfirmNote ?? "").startsWith("Script from Script Writing")) { console.log("  not the backfill's change; left alone"); continue; }
    if (apply) {
      await prisma.project.update({ where: { id: String(o.id) }, data: {
        reelScript: (o.reelScript as string | null) ?? null, reelHook: (o.reelHook as string | null) ?? null,
        scriptConfirmNote: (o.scriptConfirmNote as string | null) ?? null,
        reelRecipeUpdatedAt: o.reelRecipeUpdatedAt ? new Date(String(o.reelRecipeUpdatedAt)) : null,
      } });
      console.log("  restored");
    }
  }
  if (!apply) console.log("\nDRY RUN. --apply to restore.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
