// ---------------------------------------------------------------------------
// LIVE (Oct 16 2026): the client change requests that were saved but never
// split into items (RevisionBrief.analyzedAt null). Until Oct 14 a brief was
// only read when the client's words ran to 240 characters, so most texts were
// saved whole and unread; the topics cron now reads any brief still unread ten
// minutes on (lib/revisionBriefSweep), so after the deploy it does this by
// itself within 15 minutes. This lists the backlog by the same rule:
//   READ    the job is still open, or the ask is under a week old and its
//           revision card is still open
//   REPORT  a finished job whose card a person closed (never re-read here:
//           it would put new open items on signed-off work), a refusal, or
//           three failed tries
// --apply reads the READ rows now (one model call each), the same way the
// sweep would. Dry run by default, on a read-only connection.
//
//   set -a && source .env && set +a
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct16/unanalyzed-briefs.ts [--apply]
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
if (!APPLY && process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { briefSweepVerdict, sweepUnanalyzedBriefs } = await import("@/lib/revisionBriefSweep");
  const now = new Date();
  const rows = await prisma.revisionBrief.findMany({
    where: { analyzedAt: null, source: { not: "office" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, source: true, createdAt: true, analyzedAt: true, analysisError: true, taskId: true, originalText: true, project: { select: { status: true, title: true } } },
  });
  const tasks = await prisma.smartTask.findMany({ where: { id: { in: rows.map((r) => r.taskId).filter((x): x is string => !!x) } }, select: { id: true, status: true } });
  const taskStatus = new Map(tasks.map((t) => [t.id, t.status as string]));
  let read = 0;
  console.log(`${rows.length} unread client briefs.${APPLY ? "" : " DRY RUN (nothing written)."}\n`);
  for (const r of rows) {
    const task = r.taskId ? taskStatus.get(r.taskId) ?? null : null;
    const v = briefSweepVerdict({ ...r, jobStatus: r.project?.status ?? null, taskStatus: task }, now);
    if (v.read) read++;
    console.log([
      v.read ? "READ  " : `REPORT (${v.why})`.padEnd(6),
      r.createdAt.toISOString().slice(0, 10),
      r.id,
      r.source,
      `job ${r.project?.status ?? "?"} · card ${task ?? "none"}`,
      (r.project?.title ?? "").split(",")[0],
      JSON.stringify(r.originalText.replace(/\s+/g, " ").slice(0, 80)),
    ].join(" | "));
  }
  console.log(`\n${read} to read, ${rows.length - read} reported only.`);
  if (!APPLY) return;
  const out = await sweepUnanalyzedBriefs({ now, max: 50 });
  console.log(JSON.stringify(out, null, 1));
}
main()
  .then(async () => { const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect(); })
  .catch((e) => { console.error(e); process.exit(1); });
