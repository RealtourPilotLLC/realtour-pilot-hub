import { APPLY, db } from "./_oct22-guard";

// ---------------------------------------------------------------------------
// "PROMISES AT RISK" DRAFTS FOR PROMISES THAT HAVE NOT PASSED (Jordan, Oct 27
// 2026 Loom, 37:13: "Promises at Risk, William Hannum's photos, they're due
// tomorrow. Not today. So, it shouldn't be that it's at risk"; 40:34: "They
// should only be at risk if they're late, not if you think they're going to
// be late").
//
// The code fix (lib/atRiskUpdates, lib/programWatch) lists a promise only
// once it has passed and never drafts a "running behind" update before then.
// The drafts already written ahead of their promise are still open on Kyle's
// list. This lines them up:
//   · every OPEN at_risk_update task whose dedupe key carries a promise
//     (`at-risk:<output or job id>:<ISO>`) that is still ahead is CLOSED
//     (CANCELLED, never "sent"), with a plain note on its description;
//   · a draft whose promise has passed stays open: that one is late;
//   · a task with no readable promise in its key is printed and left alone.
// Never sends anything. Never deletes. Every row is printed.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-loom-late-promises.ts [--apply]
// ---------------------------------------------------------------------------

const NOTE = "it was drafted before the promise had passed; an update is only drafted once a promise is actually late (Jordan, Oct 27 2026). Nothing was sent";

async function main() {
  const prisma = await db();
  const { closingNote } = await import("../../src/lib/programTaskCloser");
  const now = new Date();
  const rows = await prisma.smartTask.findMany({
    where: { taskType: "at_risk_update", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, title: true, dedupeKey: true, reasonCreated: true, description: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`${rows.length} open at-risk update tasks`);
  let closed = 0, late = 0, unread = 0;
  for (const t of rows) {
    const iso = t.dedupeKey?.match(/^at-risk:[^:]+:(.+)$/)?.[1] ?? null;
    const promise = iso ? new Date(iso) : null;
    const head = `${t.id} · ${t.title} · ${t.reasonCreated ?? "?"} · promise ${promise && !Number.isNaN(promise.getTime()) ? promise.toISOString() : "unreadable"}`;
    if (!promise || Number.isNaN(promise.getTime())) {
      console.log(`${head}\n  left alone (no promise in its key: ${t.dedupeKey ?? "none"})`);
      unread++;
      continue;
    }
    if (promise.getTime() <= now.getTime()) {
      console.log(`${head}\n  stays open (the promise has passed: this one is late)`);
      late++;
      continue;
    }
    console.log(`${head}\n  ${APPLY ? "closed" : "would close"} (the promise is still ${Math.round((promise.getTime() - now.getTime()) / 3_600_000)}h ahead)`);
    if (APPLY) {
      const note = closingNote(NOTE, now);
      const r = await prisma.smartTask.updateMany({
        where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "CANCELLED", description: `${t.description ? `${t.description}\n\n` : ""}${note}`.slice(0, 20_000) },
      });
      closed += r.count;
    } else {
      closed++;
    }
  }
  console.log(`${APPLY ? "done" : "dry run"}: ${closed} ${APPLY ? "closed" : "would close"}, ${late} late and kept, ${unread} left alone${APPLY ? "" : " (nothing written)"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
