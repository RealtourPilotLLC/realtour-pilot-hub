// PROOF for SERIOUS 2, MINOR 3 and MINOR 4 — the three defects that are about
// what a WRITE does, so they cannot be proved by a pure function and must not
// be proved by writing to production.
//
// Runs the SHIPPED functions (deliverableOutputs.ensureOutputsForProject /
// refreshOutputsForProject / outputsForProject, reviewCuts.correctedCutApproved)
// against an ISOLATED loopback PGlite database, the same belt-and-braces the
// WF-06 coverage drill uses: DATABASE_URL is pinned to 127.0.0.1 before
// anything imports @/lib/prisma, and every integration key is stripped from the
// environment so no assertion here can reach a real phone, inbox or Dropbox.
//
//   PATH=<node20>:$PATH npx tsx scripts/_fix/A/drill-outputs.ts
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const PORT = Number(process.env.DRILL_PORT ?? 5451);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
if (!URL.includes("127.0.0.1")) throw new Error("refusing to run: the drill's DATABASE_URL is not loopback");
process.env.DATABASE_URL = URL;
process.env.DIRECT_URL = URL;
for (const k of Object.keys(process.env)) {
  if (/^(OPENPHONE|SLACK|GOOGLE|DROPBOX|ARYEO|TOPAZ|STRIPE|PLAID|QBO|BLOB)_/.test(k)) delete process.env[k];
}

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (cond) pass++; else fail++;
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  try {
    console.log("── schema onto the isolated database");
    await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL },
      maxBuffer: 64 * 1024 * 1024,
    });

    const { prisma } = await import("@/lib/prisma");
    const projects = await prisma.project.count();
    ok(
      "drill is on an empty, loopback database — not production",
      (process.env.DATABASE_URL ?? "").includes("127.0.0.1") && projects === 0,
      `${projects} projects`,
    );

    const { ensureOutputsForProject, refreshOutputsForProject, outputsForProject } = await import("@/lib/deliverableOutputs");
    const { slotKeyOf, photoLaneRevisionKey, correctedCutApproved } = await import("@/lib/reviewCuts");

    const client = await prisma.client.create({ data: { name: "Drill Client" }, select: { id: true } });
    const mkProject = (title: string, extra: Record<string, unknown> = {}) =>
      prisma.project.create({ data: { title, clientId: client.id, ...extra }, select: { id: true } });

    // =====================================================================
    // SERIOUS 2 — the office waives a video, then UN-waives it.
    // =====================================================================
    console.log("\n── SERIOUS 2: an un-waived video comes back onto the job");
    const pA = await mkProject("1 Waiver Way");
    const dA = await prisma.deliverable.create({
      data: { projectId: pA.id, type: "VIDEO", label: "Cinematic Video", quantity: 1 },
      select: { id: true },
    });
    await ensureOutputsForProject(pA.id);
    ok("the owed video has a row", (await prisma.deliverableOutput.count({ where: { projectId: pA.id } })) === 1);

    // waiveDeliverable's own write (deliverableActions.ts), then the sweep.
    await prisma.deliverable.update({ where: { id: dA.id }, data: { waivedAt: new Date(), waivedBy: "Kyle", waivedNote: "discounted off the package" } });
    const waived = await ensureOutputsForProject(pA.id);
    const afterWaive = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: pA.id }, select: { waivedAt: true } });
    ok("waiving the row stamps the output", !!afterWaive.waivedAt, `waived=${waived.waived}`);
    ok("…and the project view says so", (await outputsForProject(pA.id))[0]?.state === "waived");

    // unwaiveDeliverable's own write, then the sweep.
    await prisma.deliverable.update({ where: { id: dA.id }, data: { waivedAt: null, waivedBy: null, waivedNote: null } });
    const unwaived = await ensureOutputsForProject(pA.id);
    const afterUnwaive = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: pA.id }, select: { waivedAt: true } });
    ok("UN-waiving clears the output's stamp", afterUnwaive.waivedAt === null, `unwaived=${unwaived.unwaived}`);
    const viewA = await outputsForProject(pA.id);
    ok("…the video is owed work again, not 'Not required on this job'", viewA[0]?.state === "not_started", viewA[0]?.detail ?? "");
    ok("…and it is counted in the job's total again", viewA[0]?.total === 1, `total=${viewA[0]?.total}`);
    ok("re-running the sweep changes nothing (idempotent)", (await ensureOutputsForProject(pA.id)).unwaived === 0);
    ok("nothing was deleted — the row is the same one", (await prisma.deliverableOutput.count({ where: { projectId: pA.id } })) === 1);

    // =====================================================================
    // MINOR 3 — removeCut DELETES a round; the stamps must retract.
    // =====================================================================
    console.log("\n── MINOR 3: approving v2 then removing it retracts the approval");
    const pB = await mkProject("2 Retraction Rd");
    const dB = await prisma.deliverable.create({ data: { projectId: pB.id, type: "VIDEO", quantity: 1 }, select: { id: true } });
    const v1 = await prisma.reviewSubmission.create({
      data: { projectId: pB.id, kind: "video", deliverableId: dB.id, slot: 1, round: 1, status: "CHANGES_REQUESTED", fileName: "v1.mp4" },
      select: { id: true },
    });
    const v2 = await prisma.reviewSubmission.create({
      data: { projectId: pB.id, kind: "video", deliverableId: dB.id, slot: 1, round: 2, status: "APPROVED", decidedAt: new Date(), fileName: "v2.mp4" },
      select: { id: true },
    });
    await ensureOutputsForProject(pB.id);
    await refreshOutputsForProject(pB.id);
    const before = await prisma.deliverableOutput.findFirstOrThrow({
      where: { projectId: pB.id },
      select: { currentSubmissionId: true, approvedSubmissionId: true, approvedAt: true, reviewReadyAt: true },
    });
    ok("v2 is the approved version", before.approvedSubmissionId === v2.id && !!before.approvedAt);
    ok("…and the current one", before.currentSubmissionId === v2.id);

    // What removeCut does to the row (review/actions.removeCutInner → deleteCutRow).
    await prisma.reviewSubmission.delete({ where: { id: v2.id } });
    await refreshOutputsForProject(pB.id);
    const after = await prisma.deliverableOutput.findFirstOrThrow({
      where: { projectId: pB.id },
      select: { currentSubmissionId: true, approvedSubmissionId: true, approvedAt: true, reviewReadyAt: true },
    });
    ok("the approval is retracted — no pointer at a row that is gone", after.approvedSubmissionId === null, String(after.approvedSubmissionId));
    ok("…and approvedAt no longer asserts an approval nobody stands behind", after.approvedAt === null, String(after.approvedAt));
    ok("the current version falls back to v1", after.currentSubmissionId === v1.id);
    const viewB = await outputsForProject(pB.id);
    ok("the project view reads 'back with the editor', not 'approved'", viewB[0]?.state === "in_revisions", viewB[0]?.detail ?? "");

    // The delivery stamp is the office's word and survives; only the pointer heals.
    console.log("\n── MINOR 3b: a removal does not un-send a video the client has");
    const pC = await mkProject("3 Delivered Dr");
    const dC = await prisma.deliverable.create({ data: { projectId: pC.id, type: "VIDEO", quantity: 1 }, select: { id: true } });
    const sent = await prisma.reviewSubmission.create({
      data: { projectId: pC.id, kind: "video", deliverableId: dC.id, slot: 1, round: 1, status: "APPROVED", decidedAt: new Date(), sentToClientAt: new Date(), sentToClientBy: "Kyle" },
      select: { id: true },
    });
    await ensureOutputsForProject(pC.id);
    await refreshOutputsForProject(pC.id);
    const sentBefore = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: pC.id }, select: { deliveredAt: true, sentSubmissionId: true } });
    ok("the send is stamped", !!sentBefore.deliveredAt && sentBefore.sentSubmissionId === sent.id);
    await prisma.reviewSubmission.delete({ where: { id: sent.id } });
    await refreshOutputsForProject(pC.id);
    const sentAfter = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: pC.id }, select: { deliveredAt: true, sentSubmissionId: true, approvedAt: true } });
    ok("deliveredAt SURVIVES the removal — the client still has the video", !!sentAfter.deliveredAt);
    ok("…the dangling pointer is repaired", sentAfter.sentSubmissionId === null);
    ok("…and the approval, which is ours, is retracted", sentAfter.approvedAt === null);

    // =====================================================================
    // MINOR 4 — a photo-lane brief must not gate the video ask.
    // =====================================================================
    console.log("\n── MINOR 4: two lanes, one project, one revisionRequestedAt");
    const raisedAt = new Date(Date.now() - 60 * 60 * 1000);
    const pD = await mkProject("4 Two Lane Ln", {
      status: "REVISION",
      deliveredAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // delivered, so any later cut is the correction
      revisionRequestedAt: raisedAt,
    });
    const dD = await prisma.deliverable.create({ data: { projectId: pD.id, type: "VIDEO", quantity: 2 }, select: { id: true } });
    const slot1 = slotKeyOf(dD.id, 1);
    const slot2 = slotKeyOf(dD.id, 2);

    const videoTask = await prisma.smartTask.create({
      data: { projectId: pD.id, taskType: "revision", title: "Video revision — client asked for changes", summary: "Swap the music on video 1", createdAt: raisedAt },
      select: { id: true },
    });
    const photoTask = await prisma.smartTask.create({
      data: { projectId: pD.id, taskType: "revision", title: "Photo revision", summary: "Re-edit the sky on the exterior", dedupeKey: photoLaneRevisionKey(pD.id), createdAt: raisedAt },
      select: { id: true },
    });
    // The VIDEO brief: one item, on video 1 — the one being approved.
    await prisma.revisionBrief.create({
      data: {
        projectId: pD.id, taskId: videoTask.id, source: "openphone", originalText: "swap the music on the first one",
        itemsJson: JSON.stringify({ items: [{ id: "i1", ask: "Swap the music on video 1", cuts: [slot1], scope: "named" }] }),
        createdAt: new Date(raisedAt.getTime() + 1000),
      },
    });
    // The PHOTO brief, written LATER — what the old "newest brief in the window"
    // lookup would have picked — and scoped to a video nobody has re-cut.
    await prisma.revisionBrief.create({
      data: {
        projectId: pD.id, taskId: photoTask.id, source: "gmail", originalText: "and the sky on the photos",
        itemsJson: JSON.stringify({ items: [{ id: "p1", ask: "Re-edit the sky", cuts: [slot2], scope: "named" }] }),
        createdAt: new Date(raisedAt.getTime() + 2000),
      },
    });
    const newestInWindow = await prisma.revisionBrief.findFirst({
      where: { projectId: pD.id, createdAt: { gte: new Date(raisedAt.getTime() - 60_000) } },
      orderBy: { createdAt: "desc" },
      select: { taskId: true },
    });
    ok("the OLD lookup would have picked the PHOTO lane's brief", newestInWindow?.taskId === photoTask.id);

    const corrected = await prisma.reviewSubmission.create({
      data: { projectId: pD.id, kind: "video", deliverableId: dD.id, slot: 1, round: 2, status: "APPROVED", decidedAt: new Date(), createdAt: new Date(raisedAt.getTime() + 60_000), fileName: "v2.mp4" },
      select: { id: true, createdAt: true, round: true, deliverableId: true, slot: true, assetPath: true },
    });
    const r = await correctedCutApproved(pD.id, { cutCreatedAt: corrected.createdAt, round: corrected.round, cut: corrected });
    ok("approving video 1 CLOSES the video lane", r.closed === 1, JSON.stringify(r));
    const vt = await prisma.smartTask.findUniqueOrThrow({ where: { id: videoTask.id }, select: { status: true } });
    const pt = await prisma.smartTask.findUniqueOrThrow({ where: { id: photoTask.id }, select: { status: true } });
    ok("…the video revision task is COMPLETED", vt.status === "COMPLETED", vt.status);
    ok("…and the PHOTO lane is untouched — it was never this approval's to close", pt.status === "OPEN", pt.status);
    const held = await prisma.activity.findFirst({ where: { projectId: pD.id, body: { contains: "The revision stays open" } }, select: { body: true } });
    ok("…and no 'stays open' line was written off the other lane's brief", held === null, held?.body ?? "");

    // The same shape, with the VIDEO brief naming a video nobody re-cut: it
    // must still hold — the fix is scoping, not permissiveness.
    console.log("\n── MINOR 4b: the lane's OWN brief still holds the ask open");
    const pE = await mkProject("5 Still Owed St", { status: "REVISION", deliveredAt: new Date(Date.now() - 2 * 60 * 60 * 1000), revisionRequestedAt: raisedAt });
    const dE = await prisma.deliverable.create({ data: { projectId: pE.id, type: "VIDEO", quantity: 2 }, select: { id: true } });
    const eTask = await prisma.smartTask.create({
      data: { projectId: pE.id, taskType: "revision", title: "Video revision", summary: "Fix video 2", createdAt: raisedAt },
      select: { id: true },
    });
    await prisma.revisionBrief.create({
      data: {
        projectId: pE.id, taskId: eTask.id, source: "openphone", originalText: "the second one needs the text fixed",
        itemsJson: JSON.stringify({ items: [{ id: "i1", ask: "Fix the on-screen text on video 2", cuts: [slotKeyOf(dE.id, 2)], scope: "named" }] }),
        createdAt: new Date(raisedAt.getTime() + 1000),
      },
    });
    const wrongOne = await prisma.reviewSubmission.create({
      data: { projectId: pE.id, kind: "video", deliverableId: dE.id, slot: 1, round: 2, status: "APPROVED", decidedAt: new Date(), createdAt: new Date(raisedAt.getTime() + 60_000) },
      select: { id: true, createdAt: true, round: true, deliverableId: true, slot: true, assetPath: true },
    });
    const rE = await correctedCutApproved(pE.id, { cutCreatedAt: wrongOne.createdAt, round: wrongOne.round, cut: wrongOne });
    ok("approving video 1 does NOT close an untouched ask about video 3", rE.closed === 0, JSON.stringify(rE));
    ok("…the task is still open", (await prisma.smartTask.findUniqueOrThrow({ where: { id: eTask.id }, select: { status: true } })).status === "OPEN");

    // =====================================================================
    // SERIOUS 1, end to end through the shipped action.
    // =====================================================================
    console.log("\n── SERIOUS 1 end to end: the editor's FOLDER submit on a one-video job");
    const pF = await mkProject("6 Folder Path Fwy", { status: "REVISION", deliveredAt: new Date(Date.now() - 2 * 60 * 60 * 1000), revisionRequestedAt: raisedAt });
    const dF = await prisma.deliverable.create({ data: { projectId: pF.id, type: "VIDEO", quantity: 1 }, select: { id: true } });
    const fTask = await prisma.smartTask.create({
      data: { projectId: pF.id, taskType: "revision", title: "Video revision", summary: "Trim the ending", createdAt: raisedAt },
      select: { id: true },
    });
    await prisma.revisionBrief.create({
      data: {
        projectId: pF.id, taskId: fTask.id, source: "openphone", originalText: "can you trim the ending",
        // scope "all" with one owed video — exactly what analyzeRevisionText writes.
        itemsJson: JSON.stringify({ items: [{ id: "i1", ask: "Trim the ending", cuts: [slotKeyOf(dF.id, 1)], scope: "all" }] }),
        createdAt: new Date(raisedAt.getTime() + 1000),
      },
    });
    // syncFinalCutsToReview's row: NO deliverableId, identified by its path.
    const folderRound = await prisma.reviewSubmission.create({
      data: {
        projectId: pF.id, kind: "video", round: 2, status: "APPROVED", decidedAt: new Date(),
        assetPath: "/AutoHDR/2026/Q3/September/6 Folder Path Fwy/05-Final-Video/Final_v2.mp4",
        fileName: "Final_v2.mp4", createdAt: new Date(raisedAt.getTime() + 60_000),
      },
      select: { id: true, createdAt: true, round: true, deliverableId: true, slot: true, assetPath: true },
    });
    const rF = await correctedCutApproved(pF.id, { cutCreatedAt: folderRound.createdAt, round: folderRound.round, cut: folderRound });
    ok("a folder-submitted approval CLOSES the one-video job's ask", rF.closed === 1, JSON.stringify(rF));
    ok("…the task is COMPLETED", (await prisma.smartTask.findUniqueOrThrow({ where: { id: fTask.id }, select: { status: true } })).status === "COMPLETED");

    await prisma.$disconnect();
  } finally {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
