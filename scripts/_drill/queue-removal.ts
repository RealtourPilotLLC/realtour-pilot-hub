/**
 * REMOVING A JOB FROM THE EDITING ROOM, and putting it back exactly as it was.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/queue-removal.ts
 *
 * The round trip was walked in a browser against the live database on the Cara
 * test jobs — but NONE of them carries an edit_video task, so the one branch
 * that could quietly hand a job to a different editor than it was taken from
 * (`assignedManually`, the invariant every engine respects) had no coverage.
 * This runs the SHIPPED actions against an isolated loopback PostgreSQL.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5487;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE; // the office actions run as the office

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { removeFromEditorQueue, restoreToEditorQueue, recentlyRemovedFromQueue } = await import("@/app/editing/actions");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { removalFor, restorable, RESTORE_WINDOW_DAYS } = await import("@/lib/queueRemoved");

  const client = await prisma.client.create({ data: { name: "DRILL client" }, select: { id: true } });
  const shot = new Date(Date.now() - 3 * 86_400_000);
  const project = await prisma.project.create({
    data: { title: "9 Removal Rd, West Chester, PA", status: "EDITING", clientId: client.id, shootDate: shot },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 } });
  // The edit card, assigned BY HAND to Kim — the state a restore has to return.
  await prisma.smartTask.create({
    data: {
      projectId: project.id, taskType: "edit_video", title: "Edit video — 9 Removal Rd",
      dedupeKey: `edit-video-${project.id}`, status: "IN_PROGRESS", source: "hub",
      assignedKey: "kim", assignedManually: true, priority: "HIGH",
    },
  });
  const sub = await prisma.reviewSubmission.create({
    data: { projectId: project.id, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: "reel-v1.mp4" },
    select: { id: true },
  });

  const onBoard = async () => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].some((r) => r.id === project.id);
  };
  const snapshot = async () => {
    const p = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { status: true, shootDate: true, deliveredAt: true, editorId: true, videosOwedOverride: true, statusPinnedAt: true },
    });
    const d = await prisma.deliverable.count({ where: { projectId: project.id, removedFromOrderAt: null } });
    const c = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: sub.id }, select: { status: true, round: true } });
    return JSON.stringify({ ...p, deliverables: d, cut: c });
  };

  console.log("=".repeat(72));
  console.log("Taking a job off the Editing Room, and putting it back");
  console.log("=".repeat(72));

  console.log("\n1. BEFORE");
  ok("the job is on the board", await onBoard());
  const before = await snapshot();

  console.log("\n2. REMOVED");
  const r1 = await removeFromEditorQueue(project.id, "duplicate of the other listing");
  ok("the office's remove is accepted", r1.ok, r1.message);
  ok("it is off the board", !(await onBoard()));
  const task1 = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `edit-video-${project.id}` }, select: { status: true, assignedKey: true, assignedManually: true } });
  ok("the edit card is CANCELLED, not deleted", task1.status === "CANCELLED", `status=${task1.status}`);
  ok("…and it still exists, with its assignee", task1.assignedKey === "kim", `assignedKey=${task1.assignedKey}`);
  ok("NOTHING ELSE about the job moved", (await snapshot()) === before, "status · shoot · delivery · editor · override · deliverables · the approved cut");
  const rec = await removalFor(project.id);
  ok("the marker records who, when and why", !!rec && rec.by != null && rec.note === "duplicate of the other listing");
  ok("…and what the task was, so the restore is not a guess",
    rec?.task?.status === "IN_PROGRESS" && rec?.task?.assignedKey === "kim" && rec?.task?.assignedManually === true,
    JSON.stringify(rec?.task));
  const list = await recentlyRemovedFromQueue();
  ok("it shows in the undo window", list.some((x) => x.projectId === project.id), `${list.length} row(s)`);
  ok("removing twice is a no-op, not a second marker", (await removeFromEditorQueue(project.id)).ok);

  console.log("\n3. BROUGHT BACK");
  const r2 = await restoreToEditorQueue(project.id);
  ok("the restore is accepted", r2.ok, r2.message);
  ok("it is back on the board", await onBoard());
  const task2 = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `edit-video-${project.id}` }, select: { status: true, assignedKey: true, assignedManually: true, completedAt: true } });
  ok("the card is back in the state it was taken in", task2.status === "IN_PROGRESS" && task2.completedAt === null, `status=${task2.status}`);
  ok("…still Kim's, and still a HUMAN's choice", task2.assignedKey === "kim" && task2.assignedManually === true,
    `assignedKey=${task2.assignedKey} manual=${task2.assignedManually}`);
  ok("…and everything else is untouched, again", (await snapshot()) === before);
  ok("the marker SURVIVES as the record", !!(await removalFor(project.id))?.restoredAt);
  ok("the undo window is empty again", (await recentlyRemovedFromQueue()).every((x) => x.projectId !== project.id));
  ok("restoring twice is refused, not silently repeated", !(await restoreToEditorQueue(project.id)).ok);

  console.log(`\n4. THE ${RESTORE_WINDOW_DAYS}-DAY WINDOW`);
  await removeFromEditorQueue(project.id, "second time");
  const fresh = await removalFor(project.id);
  ok("a fresh removal is restorable", !!fresh && restorable(fresh));
  const old = new Date(Date.now() - (RESTORE_WINDOW_DAYS + 1) * 86_400_000);
  ok("one older than the window is not", !!fresh && !restorable({ ...fresh, at: old }));
  await prisma.appSetting.update({
    where: { key: `editing-removed:${project.id}` },
    data: { value: JSON.stringify({ by: "Jordan", at: old.toISOString(), note: "second time", task: fresh?.task ?? null }) },
  });
  const late = await restoreToEditorQueue(project.id);
  ok("an expired removal refuses, and says what to do instead", !late.ok && /Add a job to the queue/.test(late.message), late.message);
  ok("…and the job stays off the board", !(await onBoard()));

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
