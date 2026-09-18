/**
 * MERGING TWO JOBS' WORK — the shipped actions, against an isolated PostgreSQL.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/project-merge.ts
 *
 * This one moves deliverables and CUTS between jobs, so it gets proved before
 * it gets a button. What it has to show: the work lands, the money does not
 * move, the loser keeps its own order and history, the Editing Room shows one
 * row, and the whole thing reverses by id.
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
const PORT = 5491;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

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
  const { mergeProjectWork, unmergeProjectWork } = await import("@/app/editing/actions");
  const { mergeFrom, mergedInto } = await import("@/lib/projectMerge");
  const { buildEditorQueue } = await import("@/lib/editorQueue");

  const client = await prisma.client.create({ data: { name: "Mike Flatley" }, select: { id: true } });
  const other = await prisma.client.create({ data: { name: "Somebody Else" }, select: { id: true } });
  const shooter = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 }, select: { id: true } });

  const mk = async (title: string, clientId: string, invoice: number, order: string) =>
    prisma.project.create({
      data: {
        title, clientId, status: "EDITING", aryeoOrderId: order,
        payableInvoice: invoice, price: invoice,
        shootDate: new Date(Date.now() - 4 * 86_400_000), photographerId: shooter.id,
      },
      select: { id: true },
    });

  const A = await mk("204 Spring Ln, Royersford, PA", client.id, 450, "order-A");
  const B = await mk("204 Spring Ln, Royersford, PA", client.id, 200, "order-B");
  const X = await mk("9 Other Rd, Elsewhere, PA", other.id, 300, "order-X");

  const dA = await prisma.deliverable.create({ data: { projectId: A.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 1 }, select: { id: true } });
  const dB = await prisma.deliverable.create({ data: { projectId: B.id, type: "SOCIAL_REEL", label: "Second Reel", quantity: 1 }, select: { id: true } });
  const cutB = await prisma.reviewSubmission.create({
    data: { projectId: B.id, kind: "video", deliverableId: dB.id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "second-reel-v1.mp4" },
    select: { id: true },
  });
  await prisma.smartTask.create({
    data: { projectId: B.id, taskType: "edit_video", title: "Edit video — second reel", dedupeKey: `edit-video-${B.id}`, status: "OPEN", source: "hub", assignedKey: "kim", assignedManually: true },
  });
  await prisma.appointment.create({ data: { projectId: B.id, aryeoId: "appt-B", startAt: new Date(Date.now() - 4 * 86_400_000), status: "SCHEDULED", assignedToId: shooter.id } });
  await prisma.orderItem.create({ data: { projectId: B.id, title: "Second Reel", amount: 20000 } });

  const money = async (id: string) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id }, select: { payableInvoice: true, price: true, aryeoOrderId: true } });
    const appts = await prisma.appointment.count({ where: { projectId: id } });
    const items = await prisma.orderItem.count({ where: { projectId: id } });
    return JSON.stringify({ ...p, appts, items });
  };
  const moneyA0 = await money(A.id), moneyB0 = await money(B.id);
  const onBoard = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].some((r) => r.id === id);
  };

  console.log("=".repeat(74));
  console.log("Merging a second shoot's work into the original job");
  console.log("=".repeat(74));

  console.log("\n1. BEFORE — two jobs, two rows on the board");
  ok("both are on the Editing Room", (await onBoard(A.id)) && (await onBoard(B.id)));

  console.log("\n2. WHAT IT REFUSES");
  ok("merging a job into itself", !(await mergeProjectWork(A.id, A.id)).ok);
  const cross = await mergeProjectWork(X.id, A.id);
  ok("merging across clients", !cross.ok, cross.message);
  ok("…and says whose jobs they are", /Somebody Else|Mike Flatley/.test(cross.message));

  console.log("\n3. THE MERGE");
  const res = await mergeProjectWork(B.id, A.id, "second reel, same listing");
  ok("it is accepted", res.ok, res.message);
  ok("the deliverable moved", (await prisma.deliverable.findUniqueOrThrow({ where: { id: dB.id }, select: { projectId: true } })).projectId === A.id);
  ok("the cut moved with it", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB.id }, select: { projectId: true } })).projectId === A.id);
  ok("…and still points at its own deliverable", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB.id }, select: { deliverableId: true } })).deliverableId === dB.id);
  ok("the edit card moved", (await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `edit-video-${B.id}` }, select: { projectId: true } })).projectId === A.id);
  ok("the survivor now owes both reels", (await prisma.deliverable.count({ where: { projectId: A.id, removedFromOrderAt: null } })) === 2);

  console.log("\n4. MONEY, ORDERS AND THE SHOOT DID NOT MOVE");
  ok("the survivor's invoice and order are untouched", (await money(A.id)) === moneyA0, moneyA0);
  ok("the other job KEEPS its invoice, its order, its line item and its appointment", (await money(B.id)) === moneyB0, moneyB0);
  ok("…and its own shoot date and photographer", !!(await prisma.project.findUniqueOrThrow({ where: { id: B.id }, select: { shootDate: true } })).shootDate);

  console.log("\n5. ONE EDITING ROOM ROW");
  ok("the survivor is on the board", await onBoard(A.id));
  ok("the merged-away job is not — it owes no video now", !(await onBoard(B.id)));
  ok("it still EXISTS as a job", !!(await prisma.project.findUnique({ where: { id: B.id } })));

  console.log("\n6. THE RECORD");
  const m = await mergeFrom(B.id);
  ok("the merge is recorded on the job that lost its work", m?.intoId === A.id);
  ok("…with who and why", !!m?.by && m?.note === "second reel, same listing");
  ok("…and by ID, so the reverse is exact", (m?.moved.deliverableIds ?? []).includes(dB.id) && (m?.moved.submissionIds ?? []).includes(cutB.id));
  ok("the survivor's page can name what came in", (await mergedInto(A.id)).some((x) => x.fromId === B.id));
  ok("both timelines say so", (await prisma.activity.count({ where: { projectId: { in: [A.id, B.id] } } })) >= 2);
  ok("merging it a second time is refused", !(await mergeProjectWork(B.id, A.id)).ok);
  ok("and merging INTO a merged-away job is refused", !(await mergeProjectWork(X.id, B.id)).ok);

  console.log("\n7. PUT IT BACK");
  // Something created on the survivor AFTER the merge must stay there.
  const later = await prisma.deliverable.create({ data: { projectId: A.id, type: "PHOTOS", label: "Added later", quantity: 1 }, select: { id: true } });
  const undo = await unmergeProjectWork(B.id);
  ok("the unmerge is accepted", undo.ok, undo.message);
  ok("the deliverable went home", (await prisma.deliverable.findUniqueOrThrow({ where: { id: dB.id }, select: { projectId: true } })).projectId === B.id);
  ok("the cut went with it", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB.id }, select: { projectId: true } })).projectId === B.id);
  ok("what was added to the survivor AFTERWARDS stayed there", (await prisma.deliverable.findUniqueOrThrow({ where: { id: later.id }, select: { projectId: true } })).projectId === A.id);
  ok("both are back on the board", (await onBoard(A.id)) && (await onBoard(B.id)));
  ok("money still never moved", (await money(A.id)) === moneyA0 && (await money(B.id)) === moneyB0);
  ok("the record survives as history", !!(await prisma.appSetting.findUnique({ where: { key: `project-merge:${B.id}` } })));
  ok("unmerging twice is refused", !(await unmergeProjectWork(B.id)).ok);

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
