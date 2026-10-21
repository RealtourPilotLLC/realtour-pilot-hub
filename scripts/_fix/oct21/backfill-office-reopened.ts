// ---------------------------------------------------------------------------
// Oct 21 2026 (audit B11): Project.officeReopenedAt from the timeline.
//
// The board's move (moveProjectStatus) and the Editing Room's "Add a job" on a
// finished job now stamp Project.officeReopenedAt, and the Editing Room queue
// and the reopened-clock net read it. A job the office put back BEFORE the
// stamp existed has none; the readers fall back to the timeline wording for
// those (LEGACY). This fills the stamp from the NEWEST timeline line that the
// same rule counts as a put-back (lib/officeReopen.isOfficeReopenLine):
//   · "Moved from <any stage> to Revisions." (with or without its "still
//     missing" clause);
//   · "Moved from Delivered to Shot / Uploaded | In Editing | Review / QC.";
//   · "Queued a new cut (as a revision) …".
// Only a NULL stamp is written (a live stamp is always newer), each one under
// `officeReopenedAt: null` so a reopen landing mid-run is never overwritten.
// Nothing else on the job changes and nothing is sent.
//
//   set -a && source .env && set +a && npx tsx scripts/_fix/oct21/backfill-office-reopened.ts            # dry run
//   ... --apply    (writes)
//
// Proven on a drill database by scripts/_drill/oct21-office-reopened.ts.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";

export type BackfillResult = { lines: number; jobs: number; alreadyStamped: number; wrote: number; plan: { projectId: string; at: Date; line: string }[] };

export async function backfillOfficeReopened(prisma: PrismaClient, opts: { apply: boolean }): Promise<BackfillResult> {
  const { OFFICE_NEW_CUT_LINE, isOfficeReopenLine } = await import("../../../src/lib/officeReopen");
  const rows = await prisma.activity.findMany({
    where: { OR: [{ body: { startsWith: "Moved from " } }, { body: { startsWith: OFFICE_NEW_CUT_LINE } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { projectId: true, body: true, createdAt: true },
  });
  const newest = new Map<string, { at: Date; line: string }>();
  for (const r of rows) {
    if (newest.has(r.projectId) || !isOfficeReopenLine(r.body)) continue;
    newest.set(r.projectId, { at: r.createdAt, line: r.body });
  }
  const unstamped = new Set(
    (await prisma.project.findMany({ where: { id: { in: [...newest.keys()] }, officeReopenedAt: null }, select: { id: true } })).map((p) => p.id),
  );
  const plan = [...newest].filter(([id]) => unstamped.has(id)).map(([projectId, v]) => ({ projectId, ...v }));
  let wrote = 0;
  if (opts.apply) {
    for (const p of plan) {
      const r = await prisma.project.updateMany({ where: { id: p.projectId, officeReopenedAt: null }, data: { officeReopenedAt: p.at } });
      wrote += r.count;
    }
  }
  return { lines: rows.length, jobs: newest.size, alreadyStamped: newest.size - plan.length, wrote, plan };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../../src/lib/prisma");
  const titles = new Map<string, string>();
  const r = await backfillOfficeReopened(prisma as unknown as PrismaClient, { apply });
  for (const p of (await prisma.project.findMany({ where: { id: { in: r.plan.map((x) => x.projectId) } }, select: { id: true, title: true } }))) titles.set(p.id, p.title);
  for (const p of r.plan) console.log(`${p.at.toISOString()}  ${titles.get(p.projectId) ?? p.projectId}  ·  ${p.line.slice(0, 90)}`);
  console.log(`\n${r.lines} timeline lines read · ${r.jobs} jobs put back by the office · ${r.alreadyStamped} already stamped · ${r.plan.length} to stamp`);
  console.log(apply ? `WROTE ${r.wrote} stamps.` : "DRY RUN: nothing written. Re-run with --apply.");
  await prisma.$disconnect();
}

// Run only when started as the script itself (the drill imports the function).
if (process.argv[1]?.endsWith("backfill-office-reopened.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
