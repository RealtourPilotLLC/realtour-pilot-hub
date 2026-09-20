/**
 * CLOSING ONE REVISION MUST NOT CLOSE THE OTHER — the shipped hand paths,
 * against an isolated PostgreSQL.
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *   && NODE_OPTIONS=--conditions=react-server \
 *      npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/revision-lanes.ts
 *
 * A mixed photo+video job can carry TWO open revision asks at once — that is
 * what raiseRevision's photo lane is for (Gary Mercer, Sep 7). Until Sep 20 the
 * task card's Complete button and the last tick of the revision checklist each
 * authorised ONE task and then closed every ask on the job: the sibling went
 * COMPLETED with no actor and no timeline line, the job left Revisions, and the
 * delivered close-out retired the re-QC card and marked every open image flag
 * FIXED. What this has to show, on the real actions:
 *   · one lane closing leaves the other lane, the job and the flags alone;
 *   · the LAST lane closing still does the whole resolve, exactly as before;
 *   · the project page's button is still the whole job, and now says so;
 *   · a dismissal is a close too — holding the job and then dismissing the
 *     other card must not strand it in Revisions with nothing left to press;
 *   · and the old project-wide resolver still does the damage, so this drill
 *     would fail loudly if either hand path were ever wired back to it.
 *
 * Nothing here touches production: PGlite in-process, its own DATABASE_URL.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
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
const PORT = 5493;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;
// Slack and the AI both read their tokens out of the Connection table, which is
// empty in here — but the alert channel is an env var, so it goes too. No ping
// leaves this drill.
delete process.env.SLACK_ALERT_CHANNEL;

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const key24 = (...parts: string[]) => createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24);

const VIDEO_ASK = "Can you please remove the walk-out basement clip from the video and re-edit the reel? The music is also too loud.";
const PHOTO_ASK = "The front lawn photo is way too dark and the kitchen photos need retouching. Please re-edit those pictures.";

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { raiseRevision, resolveRevision } = await import("@/lib/comms");
  const { setSmartTaskStatus, toggleTaskChecklistItem, resolveRevisionAction, dismissTask, moveProjectStatus } = await import("@/app/actions");

  const client = await prisma.client.create({ data: { name: "Gary Mercer" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Pierce", email: "kyle@drill.invalid", role: "ADMIN" } });

  const DELIVERED_ON = new Date(Date.now() - 6 * 86_400_000);

  /** A mixed photo+video job the client already has, carrying both lanes plus
   *  the collateral the delivered close-out goes after: an open image flag and
   *  an open re-QC card. */
  const stage = async (label: string, opts: { bothLanes?: boolean } = { bothLanes: true }) => {
    const p = await prisma.project.create({
      data: { title: `${label}, West Chester, PA`, clientId: client.id, status: "DELIVERED", deliveredAt: DELIVERED_ON },
      select: { id: true },
    });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Tour Reel", quantity: 1 } });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "PHOTOS", label: "Photos", quantity: 30 } });
    const flag = await prisma.imageFlag.create({
      data: { projectId: p.id, imageUrl: "https://example.invalid/front-lawn.jpg", tags: "[]", note: "front lawn too dark", status: "OPEN" },
      select: { id: true },
    });
    await prisma.smartTask.create({
      data: { projectId: p.id, taskType: "media_qa", title: `Re-QC — ${label}`, dedupeKey: `media-qa-${p.id}`, status: "OPEN", source: "hub", assignedKey: "kyle" },
    });
    await raiseRevision({ projectId: p.id, clientId: client.id, propertyAddress: label, note: VIDEO_ASK, source: "gmail" });
    if (opts.bothLanes !== false) {
      await raiseRevision({ projectId: p.id, clientId: client.id, propertyAddress: label, note: PHOTO_ASK, source: "gmail" });
    }
    const videoTask = await prisma.smartTask.findUnique({ where: { dedupeKey: key24(p.id, "revision") }, select: { id: true } });
    const photoTask = await prisma.smartTask.findUnique({ where: { dedupeKey: key24(p.id, "revision", "photo") }, select: { id: true } });
    return { projectId: p.id, flagId: flag.id, videoTaskId: videoTask?.id ?? "", photoTaskId: photoTask?.id ?? "" };
  };

  const taskStatus = async (id: string) => (await prisma.smartTask.findUnique({ where: { id }, select: { status: true } }))?.status ?? "GONE";
  const proj = async (id: string) =>
    prisma.project.findUniqueOrThrow({ where: { id }, select: { status: true, revisionRequestedAt: true, revisionNote: true, deliveredAt: true } });
  const flagStatus = async (id: string) => (await prisma.imageFlag.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const qcStatus = async (projectId: string) =>
    (await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `media-qa-${projectId}` }, select: { status: true } })).status;
  const timeline = async (projectId: string) =>
    (await prisma.activity.findMany({ where: { projectId }, select: { body: true } })).map((a) => a.body).join("\n");

  console.log("=".repeat(74));
  console.log("Two lanes on one job: closing one ask");
  console.log("=".repeat(74));

  console.log("\n1. THE STATE THE BUG NEEDS — both lanes open at once");
  const a = await stage("1337 Carolannes Way");
  ok("the video ask exists", !!a.videoTaskId);
  ok("the photo ask is its OWN card, not appended to the video one", !!a.photoTaskId && a.photoTaskId !== a.videoTaskId);
  ok("both are open", (await taskStatus(a.videoTaskId)) === "OPEN" && (await taskStatus(a.photoTaskId)) === "OPEN");
  ok("the client's ask moved the job to Revisions", (await proj(a.projectId)).status === "REVISION");
  // A human put the photo ask on Kyle's plate; nothing automated may move it.
  await prisma.smartTask.update({ where: { id: a.photoTaskId }, data: { assignedManually: true } });

  console.log("\n2. THE COMPLETE BUTTON on the video lane (setSmartTaskStatus)");
  await setSmartTaskStatus(a.videoTaskId, "COMPLETED");
  ok("the video ask is closed", (await taskStatus(a.videoTaskId)) === "COMPLETED");
  ok("KYLE'S PHOTO ASK IS STILL OPEN", (await taskStatus(a.photoTaskId)) === "OPEN", await taskStatus(a.photoTaskId));
  ok("…and still hand-assigned", !!(await prisma.smartTask.findUniqueOrThrow({ where: { id: a.photoTaskId }, select: { assignedManually: true } })).assignedManually);
  const aP = await proj(a.projectId);
  ok("the job stays in Revisions", aP.status === "REVISION", aP.status);
  ok("…with its flag and the client's words still on it", !!aP.revisionRequestedAt && !!aP.revisionNote);
  ok("the open image flag was NOT force-marked FIXED", (await flagStatus(a.flagId)) === "OPEN");
  ok("the re-QC card was NOT retired", (await qcStatus(a.projectId)) === "OPEN");
  ok("the timeline says why the job stayed", /1 ask is still open on this job/.test(await timeline(a.projectId)));
  ok("…and names the stage the job is REALLY on", /keeps its revision flag and stays on Revision\./.test(await timeline(a.projectId)));
  ok("…and names the lane that was closed", /video revision was marked resolved by hand/.test(await timeline(a.projectId)));
  // Pressing Complete on a card that is already done must not add a second
  // line: this updateMany matches on id alone, so the branch is re-entered.
  const linesBefore = (await timeline(a.projectId)).split("\n").filter((l) => /still open on this job/.test(l)).length;
  await setSmartTaskStatus(a.videoTaskId, "COMPLETED");
  const linesAfter = (await timeline(a.projectId)).split("\n").filter((l) => /still open on this job/.test(l)).length;
  ok("a repeat press writes NO second explanation", linesBefore === 1 && linesAfter === 1, `${linesBefore} → ${linesAfter}`);

  console.log("\n3. THE LAST ASK still does the whole resolve");
  await setSmartTaskStatus(a.photoTaskId, "COMPLETED");
  const aP2 = await proj(a.projectId);
  ok("both asks are closed", (await taskStatus(a.photoTaskId)) === "COMPLETED");
  ok("the job lands back on Delivered", aP2.status === "DELIVERED", aP2.status);
  ok("the stamp and the note are cleared", !aP2.revisionRequestedAt && !aP2.revisionNote);
  ok("the REAL delivery date is untouched", aP2.deliveredAt?.getTime() === DELIVERED_ON.getTime());
  ok("the delivered close-out ran (re-QC retired)", (await qcStatus(a.projectId)) === "COMPLETED");

  console.log("\n4. THE CHECKLIST TICK on the video lane (toggleTaskChecklistItem)");
  const b = await stage("5 Nathaniel Ct");
  const items = JSON.parse(
    (await prisma.smartTask.findUniqueOrThrow({ where: { id: b.videoTaskId }, select: { checklist: true } })).checklist ?? "[]",
  ) as unknown[];
  for (let i = 0; i < items.length; i++) await toggleTaskChecklistItem(b.videoTaskId, i);
  ok("ticking every box completed the video ask", (await taskStatus(b.videoTaskId)) === "COMPLETED");
  ok("KYLE'S PHOTO ASK IS STILL OPEN", (await taskStatus(b.photoTaskId)) === "OPEN", await taskStatus(b.photoTaskId));
  ok("the job stays in Revisions", (await proj(b.projectId)).status === "REVISION");
  ok("the image flag is still open", (await flagStatus(b.flagId)) === "OPEN");
  ok("the timeline says why", /still open on this job/.test(await timeline(b.projectId)));

  console.log("\n5. ONE LANE ONLY — the everyday case is unchanged");
  const c = await stage("238 Hudson Dr", { bothLanes: false });
  ok("only the video ask exists", !!c.videoTaskId && !c.photoTaskId);
  await setSmartTaskStatus(c.videoTaskId, "COMPLETED");
  const cP = await proj(c.projectId);
  ok("the job resolves straight back to Delivered", cP.status === "DELIVERED", cP.status);
  ok("the stamp is cleared", !cP.revisionRequestedAt);
  ok("the re-QC card is retired", (await qcStatus(c.projectId)) === "COMPLETED");
  ok("no 'still open' line was written", !/still open on this job/.test(await timeline(c.projectId)));

  console.log("\n6. THE PROJECT PAGE BUTTON is still the whole job — and says so");
  const d = await stage("332 Ruth Ridge Dr");
  await resolveRevisionAction(d.projectId);
  ok("both asks close", (await taskStatus(d.videoTaskId)) === "COMPLETED" && (await taskStatus(d.photoTaskId)) === "COMPLETED");
  ok("the job lands back on Delivered", (await proj(d.projectId)).status === "DELIVERED");
  const dT = await timeline(d.projectId);
  ok("the timeline records that it closed BOTH lanes", /closed all 2 open asks/.test(dT), dT.split("\n").slice(-1)[0]);
  ok("…and names them", /video revision/.test(dT) && /photo revision/.test(dT));

  console.log("\n7. A DISMISSAL is a close too — it must not strand the job");
  const f = await stage("84 Longfellow Cir");
  await setSmartTaskStatus(f.photoTaskId, "COMPLETED");            // held: the video ask is open
  ok("the job is held in Revisions", (await proj(f.projectId)).status === "REVISION");
  await dismissTask(f.videoTaskId, "not needed");                   // the client's email was a misread
  const fP = await proj(f.projectId);
  ok("dismissing the LAST ask resolves the job", fP.status === "DELIVERED", fP.status);
  ok("…and clears the stamp, so the hourly sync cannot re-pin it", !fP.revisionRequestedAt);
  ok("the dismissed row is CANCELLED, never COMPLETED", (await taskStatus(f.videoTaskId)) === "CANCELLED");
  // The send-gate question, asked out loud: resolving off a dismissal must not
  // open any door that resolving off a Complete does not already open. Same
  // job shape, same close-out, same delivery-text card state.
  const deliveryCard = async (projectId: string) =>
    (await prisma.smartTask.findFirst({ where: { projectId, taskType: "delivery_text" }, select: { status: true } }))?.status ?? "none";
  ok(
    "it opens no door the Complete button would not have opened",
    (await deliveryCard(f.projectId)) === (await deliveryCard(a.projectId)),
    `dismissed → ${await deliveryCard(f.projectId)}, completed → ${await deliveryCard(a.projectId)}`,
  );

  console.log("\n8. A DISMISSAL with a sibling still open holds, and is worded as a dismissal");
  const g = await stage("358 N Church St");
  await dismissTask(g.videoTaskId, "not needed");
  ok("the photo ask is untouched", (await taskStatus(g.photoTaskId)) === "OPEN");
  ok("the job stays in Revisions", (await proj(g.projectId)).status === "REVISION");
  const gT = await timeline(g.projectId);
  ok("the timeline says it was DISMISSED, not answered", /video revision was dismissed/.test(gT));
  ok("…and does not claim anyone resolved it", !/dismissed\. [^\n]*marked resolved by hand/.test(gT));

  console.log("\n9. THE STATUS DROPDOWN — Cancelled closes, Waiting does not");
  const h = await stage("204 Spring Ln", { bothLanes: false });
  await setSmartTaskStatus(h.videoTaskId, "WAITING_EDITOR");
  const hP = await proj(h.projectId);
  ok("parking the only ask on Waiting leaves the job in Revisions", hP.status === "REVISION", hP.status);
  ok("…with its flag standing — the ask is still owed", !!hP.revisionRequestedAt);
  await setSmartTaskStatus(h.videoTaskId, "CANCELLED");
  ok("cancelling it from the dropdown resolves the job", (await proj(h.projectId)).status === "DELIVERED");

  console.log("\n10. A JOB THAT IS NOT IN REVISIONS gets a true sentence");
  const i = await stage("TEST Cara cut job");
  // The shape resolveRevision has its own paragraph about: a delivered job
  // re-queued through the fresh rail sits in REVIEW while its ask is open.
  await prisma.project.update({ where: { id: i.projectId }, data: { status: "REVIEW" } });
  await setSmartTaskStatus(i.videoTaskId, "COMPLETED");
  const iT = await timeline(i.projectId);
  ok("the line names Review, not Revisions", /stays on Review\./.test(iT), iT.split("\n").slice(-1)[0]);
  ok("the job really is still on Review", (await proj(i.projectId)).status === "REVIEW");

  console.log("\n11. THE BOARD DRAG to Delivered names the lanes it took");
  const j = await stage("38 E Gay St");
  await moveProjectStatus(j.projectId, "DELIVERED");
  const jT = await timeline(j.projectId);
  ok("both asks close (whole-job, as before)", (await taskStatus(j.videoTaskId)) === "COMPLETED" && (await taskStatus(j.photoTaskId)) === "COMPLETED");
  ok("the timeline records that it closed both", /closed all 2 open asks/.test(jT));
  ok("…and names them", /video revision/.test(jT) && /photo revision/.test(jT));

  console.log("\n12. AN EMPTY NAME is not a person");
  const k = await stage("1244 West Chester Pike");
  const { resolveRevisionWholeJob } = await import("@/lib/comms");
  await resolveRevisionWholeJob(k.projectId, "   ");
  const kT = await timeline(k.projectId);
  ok("the line starts with a name, never a space", /The office marked the revision resolved from the job page/.test(kT), kT.split("\n").slice(-1)[0]);

  console.log("\n13. THE OLD BEHAVIOUR — what the hand paths must never be wired back to");
  const e = await stage("223 E Evans St");
  await resolveRevision(e.projectId); // the bare project-wide resolver
  ok("it closes the untouched photo ask", (await taskStatus(e.photoTaskId)) === "COMPLETED");
  ok("it takes the job out of Revisions", (await proj(e.projectId)).status === "DELIVERED");
  ok("and it marks the open image flag FIXED", (await flagStatus(e.flagId)) === "FIXED");
  console.log("     (all three are the damage F02 describes — the drill above proves the hand paths no longer do it)");

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
