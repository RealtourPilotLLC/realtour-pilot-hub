// ---------------------------------------------------------------------------
// LISTING-SCRIPT TASKS, FROM JORDAN TO THE CREATIVE MANAGER (Oct 27 2026).
//
// Jordan's Loom, 3:51: "I don't need to approve the scripts, James can
// approve them ... he's the content manager." The engines route at the source
// now (taskRouting.listingScriptsDesk, and the brain's "...script package"
// to-dos through taskRouting.isListingScriptTask); this moves the open rows
// already on Jordan's desk, once:
//   · Script Studio nudges (dedupeKey scripting-script-<id>, scripting-client-<id>);
//   · the brain's to-dos about a listing script ("Review and action Premium
//     Reel script package": Mike Flatley, 658 W Ridge Pike; Sarina Spinelli,
//     7287 PA-873, as the Loom shows them).
//
// A task a person assigned or delegated on purpose is printed and left. Never
// deletes, never closes, never sends. Every row is printed: id, title,
// client, from, to.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-loom-listing-scripts-to-james.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const DONE = ["COMPLETED", "CANCELLED", "DONE", "CLOSED"];

async function main() {
  const prisma = await db();
  const { creativeManagerDesk, ownerDesk, isListingScriptTask } = await import("../../src/lib/taskRouting");
  const cm = await creativeManagerDesk();
  const owner = await ownerDesk();
  if (!cm) throw new Error("Nobody carries the creative-manager flag: nothing to move to. Stopping.");
  if (!owner) throw new Error("No owner roster row: can't tell which tasks are Jordan's. Stopping.");
  console.log(`from ${owner.name} (${owner.key}) → ${cm.name} (${cm.key})\n`);

  const open = await prisma.smartTask.findMany({
    where: {
      status: { notIn: DONE },
      OR: [{ assignedKey: owner.key }, { assignedKey: null, ownerId: owner.id }],
      AND: [{ OR: [{ dedupeKey: { startsWith: "scripting-script-" } }, { dedupeKey: { startsWith: "scripting-client-" } }, { title: { contains: "script", mode: "insensitive" } }] }],
    },
    select: { id: true, title: true, dedupeKey: true, assignedKey: true, assignedManually: true, delegatedAt: true, taskType: true, client: { select: { name: true } }, project: { select: { title: true } } },
    orderBy: { createdAt: "asc" },
  });
  const move: typeof open = [];
  const leave: { t: (typeof open)[number]; why: string }[] = [];
  for (const t of open) {
    const studio = (t.dedupeKey ?? "").startsWith("scripting-");
    if (!studio && !isListingScriptTask(t.title)) continue; // a monthly content script or anything else: not this repair
    if (t.assignedManually || t.delegatedAt) { leave.push({ t, why: t.delegatedAt ? "delegated by a person" : "assigned by hand" }); continue; }
    move.push(t);
  }
  const line = (t: (typeof open)[number]) => `${t.id}  ${t.title.slice(0, 80)}  [${t.client?.name ?? "-"} · ${(t.project?.title ?? "-").split(",")[0]}]  ${t.dedupeKey ?? ""}`;
  console.log(`=== MOVE to ${cm.key} (${move.length}) ===`);
  for (const t of move) console.log(line(t));
  console.log(`\n=== LEAVE (${leave.length}) ===`);
  for (const { t, why } of leave) console.log(`${line(t)}\n    ${why}`);
  const named = ["658 W Ridge Pike", "7287 PA-873"];
  for (const n of named) console.log(`\n${n}: ${move.some((t) => (t.project?.title ?? t.title).includes(n)) ? "in the move list" : "NOT found among Jordan's open script tasks (check by hand)"}`);

  if (!APPLY) { console.log("\ndry run: nothing written. Re-run with --apply."); return; }
  let moved = 0;
  for (const t of move) {
    const u = await prisma.smartTask.updateMany({
      where: { id: t.id, status: { notIn: DONE }, assignedManually: false, delegatedAt: null, assignedKey: t.assignedKey },
      data: { assignedKey: cm.key, ownerId: cm.id },
    });
    moved += u.count;
  }
  console.log(`\nwritten: ${moved} moved to ${cm.name}. Nothing closed, deleted or sent.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
