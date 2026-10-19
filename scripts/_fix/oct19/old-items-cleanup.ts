// Oct 19 2026 (Jordan: "Things that are really old need to be followed up on,
// flagged for Kyle"). The one-time look at the backlog behind Home's "Old
// items to clear", and the shoot notes the daily cron now closes by itself
// (lib/taskAging.expireShootNotes).
//
//   DRY RUN (default):  what the shoot-note rule would close today, and every
//                       old item counted by type, by age and by person. The
//                       database connection is opened READ ONLY and the script
//                       proves it (Postgres 25006) before it reads anything.
//   --apply             closes those shoot notes (a dismissal with its reason,
//                       one AuditLog row each). Nothing else is written.
//   --undo [--apply]    lists (or, with --apply, reopens) every note the rule
//                       closed, exactly as it was. --since=YYYY-MM-DD narrows it.
//
// Run: set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct19/old-items-cleanup.ts
export {};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const undo = args.includes("--undo");
const since = args.find((a) => a.startsWith("--since="))?.slice("--since=".length);

if (!apply) {
  // A dry run cannot write: every transaction on this connection is read-only.
  const raw = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = raw + (raw.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const aging = await import("@/lib/taskAging");
  if (!apply) {
    try {
      await prisma.$executeRawUnsafe('UPDATE "AppSetting" SET "updatedBy" = "updatedBy" WHERE false');
      console.error("STOP: the dry-run connection accepted a write. Nothing was read.");
      process.exit(2);
    } catch (e) {
      if (!/25006/.test(String((e as Error).message))) throw e;
      console.log("Dry run: the connection is read-only (proved).\n");
    }
  }
  const now = new Date();

  if (undo) {
    const r = await aging.undoExpiredShootNotes({ since: since ? new Date(`${since}T00:00:00Z`) : undefined, apply, actor: "script:old-items-cleanup --undo" });
    console.log(`${r.eligible.length} shoot note(s) the rule closed that are still closed as it left them:`);
    for (const e of r.eligible) console.log(`  · ${e.title}  (${e.id})`);
    console.log(apply ? `\nReopened ${r.reopened}.` : "\nDry run: nothing reopened. Add --apply to reopen them.");
    return;
  }

  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const synthetic = (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const notes = await aging.findExpiringShootNotes(now);
  console.log(`SHOOT NOTES THE RULE CLOSES TODAY: ${notes.length}`);
  for (const n of notes) {
    console.log(`  · ${n.title}`);
    console.log(`      ${n.projectTitle} · ${n.projectStatus} · shot ${n.shootISO.slice(0, 10)} · created ${n.createdISO.slice(0, 10)} · ${n.personKey ? `on ${n.personKey}'s plate` : "nobody's name on it"}`);
  }

  const census = await aging.oldItemsCensus(now, { excludeClientIds: synthetic });
  console.log(`\nOLD ITEMS NOW (open, assigned, ${aging.OLD_AFTER_DAYS}+ days past their date, test clients out): ${census.total}`);
  console.log("  by type:   " + census.byType.map(([k, v]) => `${k} ${v}`).join(" · "));
  console.log("  by age:    " + census.byAge.map(([k, v]) => `${k} ${v}`).join(" · "));
  console.log("  by person: " + census.byPerson.map(([k, v]) => `${k} ${v}`).join(" · "));
  const noteIds = new Set(notes.map((n) => n.id));
  const after = (await aging.listOldItems(now, { excludeClientIds: synthetic })).items.filter((i) => !noteIds.has(i.id)).length;
  console.log(`  after the shoot notes close: ${after}`);

  if (!apply) {
    console.log("\nDry run: nothing written. Add --apply to close the shoot notes listed above.");
    return;
  }
  const r = await aging.expireShootNotes(now, { apply: true, actor: "script:old-items-cleanup" });
  console.log(`\nClosed ${r.closed} of ${r.candidates.length}. Undo: --undo --apply`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
