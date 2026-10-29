// ---------------------------------------------------------------------------
// 4008 OAKLAND RD: NOT A REVISION (Oct 29 2026, Jordan on the two Creative
// review cards: "Why is this coming up? I don't think it's needed"), by
// "claude: for Jordan".
//
// Nehemiah Lindo's text ("4008 Oakland I need photos and reel" / "We did these
// already but we need better photos") and his call with Kyle ordering the
// package both matched the July photos-only job, because the new Aryeo order
// (Tue Nov 3, its own job) reached the hub a minute after the call. Each
// became a revision there with a creative review for Jordan. Kyle already
// dismissed the revision (21:31 ET); the two reviews stayed open.
//
//   (no flags)   dry run, read-only (the guard proves it)
//   --apply      resolve both reviews as "No change needed" through the hub's
//                own path (it messages nobody on NOT_NEEDED), and set aside
//                any photo-desk ask those messages left open on the July job
//   --undo [--apply]  put the two briefs' words, the two review tasks and the
//                asks back as they were (from the saved before-state)
//
// Run: npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct29-oakland-not-revision.ts
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { APPLY, db } from "./_oct22-guard";

const ACTOR = "claude: for Jordan";
const NOTE = "Not a revision: Nehemiah ordered a new shoot (photos, floor plans, standard reel with agent intro), booked for Tue Nov 3 as its own job.";
const OLD_JOB = "cmrkz1yoq00cii904950l7y82";
const NEW_JOB = "cmvu23mam000gjv089u0eliv2";
const BRIEFS = ["cmvty0dtv000sle0795dr3qmw", "cmvu22brn000kjq08z48herwk"];
const UNDO_FILE = path.resolve(__dirname, "oct29-oakland-not-revision.undo.json");

type Before = {
  at: string;
  briefs: { id: string; itemsJson: string | null }[];
  tasks: { id: string; status: string; completedAt: string | null }[];
  asks: { id: string; state: string; doneAt: string | null; doneBy: string | null; confirmNote: string | null; historyJson: string | null }[];
};

(async () => {
  const prisma = await db();
  const { creativeReviewOf } = await import("../../src/lib/creativeReviewCore");

  if (process.argv.includes("--undo")) {
    if (!fs.existsSync(UNDO_FILE)) { console.log("no saved before-state; nothing to undo"); return prisma.$disconnect(); }
    const before = JSON.parse(fs.readFileSync(UNDO_FILE, "utf8")) as Before;
    console.log(`before-state saved ${before.at}: ${before.briefs.length} briefs, ${before.tasks.length} tasks, ${before.asks.length} asks${APPLY ? "" : " (dry run: nothing written)"}`);
    if (APPLY) {
      for (const b of before.briefs) await prisma.revisionBrief.update({ where: { id: b.id }, data: { itemsJson: b.itemsJson } });
      for (const t of before.tasks) await prisma.smartTask.update({ where: { id: t.id }, data: { status: t.status as never, completedAt: t.completedAt ? new Date(t.completedAt) : null } });
      for (const a of before.asks) await prisma.clientAsk.update({ where: { id: a.id }, data: { state: a.state as never, doneAt: a.doneAt ? new Date(a.doneAt) : null, doneBy: a.doneBy, confirmNote: a.confirmNote, historyJson: a.historyJson } });
      await prisma.activity.create({ data: { projectId: OLD_JOB, type: "SYSTEM", body: `Undone by ${ACTOR}: the two creative reviews from Nehemiah's Oct 29 messages are open again.` } });
      console.log("restored");
    }
    return prisma.$disconnect();
  }

  const briefs = await prisma.revisionBrief.findMany({ where: { id: { in: BRIEFS } }, select: { id: true, projectId: true, taskId: true, itemsJson: true, createdAt: true } });
  const reviewTaskIds = briefs.map((b) => creativeReviewOf(b.itemsJson)?.taskId).filter((x): x is string => !!x);
  const tasks = await prisma.smartTask.findMany({ where: { id: { in: [...reviewTaskIds, ...briefs.map((b) => b.taskId).filter((x): x is string => !!x)] } }, select: { id: true, taskType: true, title: true, status: true, completedAt: true } });
  const asks = await prisma.clientAsk.findMany({ where: { projectId: OLD_JOB, createdAt: { gte: new Date("2026-10-29T00:00:00Z") } }, select: { id: true, kind: true, medium: true, state: true, summary: true, text: true, doneAt: true, doneBy: true, confirmNote: true, historyJson: true } });
  const openAsks = asks.filter((a) => a.state === "OPEN");
  const newJob = await prisma.project.findUnique({ where: { id: NEW_JOB }, select: { title: true, status: true, shootDate: true } });

  for (const b of briefs) {
    const cr = creativeReviewOf(b.itemsJson);
    console.log(`brief ${b.id} (${b.createdAt.toISOString()}): creative review ${cr?.state ?? "none"}${cr?.state === "OPEN" ? `, reasons ${cr.reasons.join("+")}, task ${cr.taskId}` : ""}`);
  }
  for (const t of tasks) console.log(`task ${t.id} ${t.taskType} "${t.title}": ${t.status}`);
  for (const a of asks) console.log(`ask ${a.id} ${a.kind}/${a.medium ?? "-"} ${a.state}: ${(a.summary || a.text).slice(0, 90)}`);
  console.log(`the new job: ${newJob?.title} ${newJob?.status}, shoot ${newJob?.shootDate?.toISOString()} (not touched)`);
  const toResolve = briefs.filter((b) => creativeReviewOf(b.itemsJson)?.state === "OPEN");
  console.log(`\nwould resolve ${toResolve.length} creative review(s) as No change needed, and set aside ${openAsks.length} open ask(s) on the July job`);
  console.log(`note: ${NOTE}`);

  if (!APPLY) return prisma.$disconnect();

  const before: Before = {
    at: new Date().toISOString(),
    briefs: briefs.map((b) => ({ id: b.id, itemsJson: b.itemsJson })),
    tasks: tasks.filter((t) => reviewTaskIds.includes(t.id)).map((t) => ({ id: t.id, status: t.status, completedAt: t.completedAt?.toISOString() ?? null })),
    asks: openAsks.map((a) => ({ id: a.id, state: a.state, doneAt: a.doneAt?.toISOString() ?? null, doneBy: a.doneBy, confirmNote: a.confirmNote, historyJson: a.historyJson })),
  };
  fs.writeFileSync(UNDO_FILE, JSON.stringify(before, null, 2));
  console.log(`before-state saved to ${UNDO_FILE}`);

  const { resolveCreativeReview } = await import("../../src/lib/creativeReview");
  for (const b of toResolve) {
    const r = await resolveCreativeReview({ briefId: b.id, mode: "NOT_NEEDED", note: NOTE, actor: { name: ACTOR } });
    console.log(`resolve ${b.id}: ${r.ok ? "ok" : "REFUSED"} — ${r.message}`);
  }
  const { markNotNeeded } = await import("../../src/lib/clientAsks");
  for (const a of openAsks) {
    const r = await markNotNeeded(a.id, ACTOR, NOTE);
    console.log(`ask ${a.id}: ${r.message}`);
  }
  return prisma.$disconnect();
})();
