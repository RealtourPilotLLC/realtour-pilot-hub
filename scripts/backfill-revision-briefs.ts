/**
 * Backfill revision work orders for revisions raised BEFORE the brief existed.
 *
 * For every project with an open `revision` task and no brief yet, it recovers
 * the client's ask — preferring the full two-sided conversation from the comms
 * log over the clipped one-sided copy on the task — writes it whole, and runs
 * the analysis.
 *
 * Creates RevisionBrief rows only. It never edits a project, task, or comm.
 *
 *   npx tsx scripts/backfill-revision-briefs.ts          # dry run
 *   npx tsx scripts/backfill-revision-briefs.ts --write
 */
import { prisma } from "../src/lib/prisma";
import { createRevisionBrief } from "../src/lib/revisionBrief";

const WRITE = process.argv.includes("--write");
// A revision older than this is history, not live work.
const SINCE = new Date(Date.now() - 30 * 86_400_000);

async function main() {
  const tasks = await prisma.smartTask.findMany({
    where: {
      taskType: "revision",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      createdAt: { gte: SINCE },
      projectId: { not: null },
    },
    select: {
      id: true,
      projectId: true,
      description: true,
      summary: true,
      createdAt: true,
      source: true,
      sourceDetail: true,
      clientId: true,
      project: {
        select: {
          title: true,
          client: { select: { id: true, name: true } },
          deliverables: { select: { type: true, label: true } },
        },
      },
    },
  });

  console.log(`${tasks.length} open revision task(s) in the last 30 days.\n`);

  for (const t of tasks) {
    if (!t.projectId) continue;
    const existing = await prisma.revisionBrief.count({ where: { projectId: t.projectId } });
    if (existing > 0) {
      console.log(`SKIP  ${t.project?.title} — already has ${existing} brief(s)`);
      continue;
    }

    // Recover the fullest version of what the client said. The task carries a
    // clipped, one-sided copy; the comms log usually has the whole thing.
    const clientId = t.clientId ?? t.project?.client?.id ?? null;
    let best = (t.description ?? t.summary ?? "").trim();
    let twoSided = false;
    if (clientId) {
      const around = await prisma.commLog.findMany({
        where: {
          clientId,
          direction: "in",
          createdAt: { gte: new Date(t.createdAt.getTime() - 45 * 60_000), lte: new Date(t.createdAt.getTime() + 5 * 60_000) },
        },
        orderBy: { createdAt: "desc" },
        select: { channel: true, body: true, createdAt: true },
      });
      // Longest inbound record in the window wins — a call transcript beats the
      // clipped task copy of the same conversation.
      for (const c of around) {
        const body = (c.body ?? "").trim();
        if (body.length > best.length) {
          best = body;
          twoSided = c.channel === "call";
        }
      }
    }
    if (!best) {
      console.log(`SKIP  ${t.project?.title} — nothing recoverable`);
      continue;
    }

    console.log(
      `${WRITE ? "WRITE" : "DRY  "} ${t.project?.title}\n` +
        `      source=${t.source} twoSided=${twoSided} taskChars=${(t.description ?? "").length} → briefChars=${best.length}`,
    );
    if (!WRITE) continue;

    const id = await createRevisionBrief({
      projectId: t.projectId,
      taskId: t.id,
      source: t.source ?? "comms",
      sourceDetail: t.sourceDetail,
      text: best,
      twoSided,
      clientName: t.project?.client?.name ?? null,
      propertyAddress: t.project?.title ?? null,
      deliverables: (t.project?.deliverables ?? []).map((d) => d.label || d.type).filter(Boolean),
    });
    if (!id) {
      console.log("      → failed to create");
      continue;
    }
    const row = await prisma.revisionBrief.findUnique({
      where: { id },
      select: { headline: true, itemsJson: true, analysisError: true },
    });
    if (row?.analysisError) {
      console.log(`      → saved whole, analysis failed: ${row.analysisError}`);
    } else {
      const items = row?.itemsJson ? (JSON.parse(row.itemsJson).items as unknown[]).length : 0;
      console.log(`      → "${row?.headline}" (${items} items)`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
