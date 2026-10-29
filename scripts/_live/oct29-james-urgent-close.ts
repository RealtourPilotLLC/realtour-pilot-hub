// ---------------------------------------------------------------------------
// JAMES'S "URGENT" TASKS THAT WERE ALREADY DONE (Oct 29 2026, James's call
// with Jordan: 15 urgent tasks, older brand updates and check-ins that looked
// finished), by "claude: for Jordan".
//
//   (no flags)          dry run, read-only (the guard proves it): each of his
//                       open tasks, close (with the evidence) or keep (with why)
//   --apply             close the ones with evidence: COMPLETED, the evidence
//                       written on the task, the row before it in the AuditLog
//   --undo [--apply]    put every task this script closed back as it was
//
// Only brand-update cards close here, on lib/brandAckEvidence's rule (the
// same one the hourly evidence pass now runs): nothing on the card is for an
// editor, or an editor has worked from the brief since the last change.
// Anything else is kept and listed. A card a person assigned, delegated or
// flagged is never touched.
//
// Run: npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct29-james-urgent-close.ts
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const ACTOR = "claude: for Jordan";
const CLOSED = "task_james_urgent_closed";
const RESTORED = "task_james_urgent_restored";

// What the record showed for the ones that are not brand cards (read Oct 29).
const KEEP_WHY: Record<string, string> = {
  cmv9jte1r010pkx06qbm5exit: "October still needs its content session booked (the program closer holds it; reminders snoozed to Nov 1)",
  cmvq4jps60009l80852tmhs6i: "658 W Ridge Pike shot today at 1 PM and its script is still awaiting review in Studio (the past-shoot sweep's ground, not this one)",
  cmvqqepsj0004l3074lr2kwui: "7287 PA-873 shoots Oct 30 at 3:30 PM: the script review is still ahead of it",
  cmvshdddg0102l908cfwuk42g: "no raws in the job's Dropbox yet (0 files at 9 PM): genuinely outstanding; it was the office's (minted to Kyle), moved to James by hand on Oct 28",
  cmvserrb20000jl080041a77d: "his own process improvement, put there by a person",
};

type Detail = { fromStatus: string; completedAt: string | null; descriptionBefore: string | null; summaryBefore: string | null; evidence: string };

(async () => {
  const prisma = await db();
  const { TASK_DONE_INCLUDING_LEGACY } = await import("../../src/lib/programDeskTasks");
  const OPEN = { notIn: TASK_DONE_INCLUDING_LEGACY };
  const etDay = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

  if (process.argv.includes("--undo")) {
    const logs = await prisma.auditLog.findMany({ where: { action: CLOSED, actor: ACTOR }, orderBy: { createdAt: "desc" } });
    const restored = new Set((await prisma.auditLog.findMany({ where: { action: RESTORED, actor: ACTOR }, select: { target: true, createdAt: true } })).map((r) => `${r.target}`));
    let reopened = 0;
    for (const log of logs) {
      if (restored.has(log.target)) continue;
      const d = JSON.parse(log.detail) as Detail;
      const t = await prisma.smartTask.findUnique({ where: { id: log.target }, select: { title: true, status: true } });
      console.log(`  ${log.target} | ${t?.title ?? "(gone)"} | now ${t?.status ?? "-"} -> back to ${d.fromStatus}`);
      if (!APPLY || !t || t.status !== "COMPLETED") continue;
      await prisma.$transaction([
        prisma.smartTask.update({ where: { id: log.target }, data: { status: d.fromStatus, completedAt: d.completedAt ? new Date(d.completedAt) : null, description: d.descriptionBefore, summary: d.summaryBefore } }),
        prisma.auditLog.create({ data: { actor: ACTOR, action: RESTORED, target: log.target, detail: JSON.stringify({ closedLogId: log.id }) } }),
      ]);
      reopened++;
    }
    console.log(APPLY ? `reopened ${reopened}` : "dry run: nothing written");
    return prisma.$disconnect();
  }

  const { brandAckVerdicts, BRAND_ACK_PREFIX } = await import("../../src/lib/brandAckEvidence");
  const james = await prisma.teamMember.findFirst({ where: { creativeManager: true, active: true }, select: { id: true, name: true } });
  if (!james) throw new Error("no creative manager on the team");
  const key = james.name.split(" ")[0].toLowerCase();
  const tasks = await prisma.smartTask.findMany({
    where: { OR: [{ assignedKey: key }, { assignedKey: null, ownerId: james.id }], status: OPEN },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, status: true, dueAt: true, dedupeKey: true, taskType: true, completedAt: true, description: true, summary: true, assignedManually: true, delegatedAt: true, flaggedAt: true },
  });
  const brandIds = tasks.filter((t) => t.dedupeKey?.startsWith(BRAND_ACK_PREFIX)).map((t) => t.id);
  const verdicts = new Map((await brandAckVerdicts({ taskIds: brandIds })).map((v) => [v.taskId, v]));
  const now = new Date();
  console.log(`${james.name}: ${tasks.length} open tasks (${tasks.filter((t) => t.dueAt && t.dueAt < now).length} past their due date)\n`);

  const close = tasks.filter((t) => verdicts.get(t.id)?.evidence);
  console.log(`CLOSE (${close.length})`);
  for (const t of close) console.log(`  ${t.id} | ${t.title}\n      evidence: ${verdicts.get(t.id)!.evidence}`);
  console.log(`\nKEEP (${tasks.length - close.length})`);
  for (const t of tasks.filter((x) => !close.includes(x))) console.log(`  ${t.id} | ${t.title}\n      why: ${verdicts.get(t.id)?.kept ?? KEEP_WHY[t.id] ?? "nothing on record proves it done"}`);

  if (!APPLY) { console.log("\ndry run: nothing written"); return prisma.$disconnect(); }
  let closed = 0;
  for (const t of close) {
    const evidence = verdicts.get(t.id)!.evidence!;
    const note = `Closed by ${ACTOR} on ${etDay(now)}: ${evidence}.`;
    const detail: Detail = { fromStatus: t.status, completedAt: t.completedAt?.toISOString() ?? null, descriptionBefore: t.description, summaryBefore: t.summary, evidence };
    await prisma.$transaction(async (tx) => {
      // Fenced: still open, still the hub's (never a person's hand-assigned, delegated or flagged card).
      const r = await tx.smartTask.updateMany({
        where: { id: t.id, status: OPEN, assignedManually: false, delegatedAt: null, flaggedAt: null },
        data: { status: "COMPLETED", completedAt: now, description: `${t.description ? `${t.description}\n\n` : ""}${note}`.slice(0, 20_000) },
      });
      if (!r.count) return;
      await tx.auditLog.create({ data: { actor: ACTOR, action: CLOSED, target: t.id, detail: JSON.stringify(detail) } });
      closed++;
    });
  }
  console.log(`\nclosed ${closed} of ${close.length}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
