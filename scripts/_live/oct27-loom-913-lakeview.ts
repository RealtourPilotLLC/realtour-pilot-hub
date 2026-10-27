import { APPLY, db } from "./_oct22-guard";

// ---------------------------------------------------------------------------
// 913 LAKEVIEW'S PHOTOS BACK TO DELIVERED (Oct 27 2026). Jordan, on the
// Photos board: "what is the request? Where is it? I don't see what the
// request is" and "if it's in regard to something other than photos, then it
// should not be reopened here. it should be made a task on Kyle's dashboard".
//
// Mike Flatley texted "Upload all 913 Lakeview deliverables to Showcase before
// tomorrow". The hub read it as a photo change and reopened the delivered
// photo job. The code now keeps such a request off the photo job
// (photoDelivery/afterDeliveryAsk); this puts 913 Lakeview right:
//   · the photo job back to Delivered (its first delivery date stays);
//   · the open request(s) since delivery closed with why, ONLY when the plain
//     words say office work (anything else: refused, left for a person);
//   · the photo revision to-do closed (closePhotoRevisionTask, the app's own way);
//   · Kyle's "Upload 913 Lakeview assets to Showcase" task is checked, never
//     made again (refused when it is not there).
// Nothing is sent to anyone.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-loom-913-lakeview.ts [--apply]
// ---------------------------------------------------------------------------

const BY = "office (Oct 27 2026 repair)";

async function main() {
  const prisma = await db();
  const { afterDeliveryByWords, OFFICE_ASK_ACTION } = await import("../../src/lib/photoDelivery/afterDeliveryAsk");
  const { photoRevisionTaskKey, closePhotoRevisionTask, revisionStartOf } = await import("../../src/lib/photoDelivery/clientAsked");
  const { setStage, logJobEvent } = await import("../../src/lib/photoDelivery/jobState");
  const { closeAskWithReason } = await import("../../src/lib/clientAsks");

  const projects = await prisma.project.findMany({ where: { title: { startsWith: "913 Lakeview" } }, select: { id: true, title: true } });
  if (projects.length !== 1) throw new Error(`expected one 913 Lakeview job, found ${projects.length}`);
  const project = projects[0];
  const job = await prisma.photoJob.findUnique({ where: { projectId: project.id }, select: { id: true, stage: true, deliveredAt: true } });
  if (!job) throw new Error("913 Lakeview has no photo job");
  console.log(`job "${project.title}" (${project.id}) · photo job ${job.id} · ${job.stage} · delivered ${job.deliveredAt?.toISOString() ?? "-"}`);
  if (job.stage !== "REVISION_REQUESTED") { console.log("the photo job is not reopened: nothing to do."); return; }

  const since = job.deliveredAt ?? (await revisionStartOf(job.id));
  const asks = await prisma.clientAsk.findMany({
    where: { projectId: project.id, state: "OPEN", kind: "SPECIAL_REQUEST", OR: [{ medium: { in: ["photo", "both", "unclear"] } }, { medium: null }], ...(since ? { askedAt: { gte: new Date(since.getTime() - 60_000) } } : {}) },
    select: { id: true, text: true, medium: true, askedBy: true, askedAt: true, source: true },
    orderBy: { askedAt: "asc" },
  });
  for (const a of asks) console.log(`  request ${a.id} · ${a.medium ?? "-"} · ${a.source} · ${a.askedBy ?? "-"} · ${a.askedAt.toISOString()} · words say: ${afterDeliveryByWords(a.text) ?? "unsure"}\n    "${a.text.slice(0, 200)}"`);
  const notOffice = asks.filter((a) => afterDeliveryByWords(a.text) !== "office");
  if (notOffice.length) { console.log(`REFUSED: ${notOffice.length} request(s) since delivery are not plainly office work. Leave the job for a person.`); return; }

  const kyle = await prisma.smartTask.findMany({
    where: { projectId: project.id, status: { notIn: ["COMPLETED", "CANCELLED"] }, OR: [{ title: { contains: "showcase", mode: "insensitive" } }, { summary: { contains: "showcase", mode: "insensitive" } }] },
    select: { id: true, title: true, status: true, taskType: true, assignedKey: true },
  });
  for (const t of kyle) console.log(`  Kyle's task ${t.id} · ${t.status} · ${t.taskType} · ${t.assignedKey ?? "unassigned"} · ${t.title}`);
  const task = kyle.find((t) => t.taskType !== "revision");
  if (!task) { console.log("REFUSED: no open Showcase task on the job. This repair never makes one: tell Jordan."); return; }

  const rev = await prisma.smartTask.findUnique({ where: { dedupeKey: photoRevisionTaskKey(project.id) }, select: { id: true, status: true, title: true } });
  console.log(`photo revision to-do: ${rev ? `${rev.id} · ${rev.status} · ${rev.title}` : "none"}`);
  console.log(`plan: photo job -> DELIVERED; ${asks.length} request(s) closed ("Not a change to the photos: on Kyle's list as a task"); revision to-do closed; Kyle's task ${task.id} left as it is.`);
  if (!APPLY) { console.log("dry run: nothing written. Re-run with --apply."); return; }

  const why = "Mike Flatley's request (upload the deliverables to Showcase) is not a change to the photos";
  const moved = await setStage(job.id, ["REVISION_REQUESTED"], "DELIVERED", BY, { why: `${why}: photos left as delivered`, extra: { nextCheckAt: new Date(Date.now() + 6 * 3_600_000) } });
  if (!moved) throw new Error("the photo job moved on in the meantime: nothing written");
  let closed = 0;
  for (const a of asks) if ((await closeAskWithReason(a.id, BY, `Not a change to the photos: on Kyle's list as a task (${task.title.slice(0, 120)})`)).ok) closed++;
  await logJobEvent(job.id, BY, OFFICE_ASK_ACTION, { taskId: task.id, reused: true, closed, repair: "oct27-loom-913-lakeview" });
  const revClosed = await closePhotoRevisionTask(project.id, "not a change to the photos: the Showcase upload is on Kyle's list");
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `Office correction: Mike Flatley's "Upload all 913 Lakeview deliverables to Showcase" is not a change to the photos, so the photos are back to Delivered. It stays on Kyle's list as a task.` },
  });
  console.log(`written: job DELIVERED, ${closed} request(s) closed, revision to-do ${revClosed ? "closed" : "left (already closed)"}.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
