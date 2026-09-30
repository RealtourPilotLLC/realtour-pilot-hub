// W04 listing-final check: isolated database and fake Aryeo listing read.
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

let delivered = false;
let playback = "https://example.test/listing/video-a.mp4";
const v7 = (at: number) => {
  const hex = at.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
};
const currentId = v7(Date.now() - 30 * 60_000);
const secondId = v7(Date.now() - 20 * 60_000);
let providerVideoId = currentId;
interceptModule(
  (r) => r === "@/lib/integrations/aryeo" || /[\\/]src[\\/]lib[\\/]integrations[\\/]aryeo(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "getListingMedia") return async () => ({ deliveryStatus: delivered ? "DELIVERED" : "IN_PROGRESS",
        photoCount: 0, videoCount: 3, floorPlanCount: 0, cover: null, images: [], floorPlans: [],
        videos: [
          { id: v7(Date.now() - 3 * 86_400_000), title: "Old video", thumb: null, playback: "https://example.test/old.mp4", download: null, duration: 40 },
          { id: providerVideoId, title: "Current title", thumb: null, playback, download: null, duration: 62 },
          { id: secondId, title: "Second output", thumb: null, playback: "https://example.test/second.mp4", download: null, duration: 45 },
        ] });
      return t[k];
    },
  }),
);
installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5782) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { listingChoices, recordListingCheck, manualListingCheckReady, FINAL_CHECK_KEYS } = await import("@/lib/finalRendition");
    const client = await prisma.client.create({ data: { name: "W04 Listing TEST" } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "W04 TEST Address", status: "REVIEW", aryeoListingId: "fake-listing" } });
    const d = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO", quantity: 2 } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: d.id, slot: 1, round: 2, status: "APPROVED",
      blobUrl: "https://example.test/source-v2.mp4", contentHash: "hash-v2", assetPath: "/Final/video-v2.mp4", decidedAt: new Date(Date.now() - 86_400_000) } });
    await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: d.id, slot: 1, category: "VIDEO", currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
    const other = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: d.id, slot: 2, round: 1, status: "APPROVED",
      blobUrl: "https://example.test/other.mp4", decidedAt: new Date(Date.now() - 86_400_000) } });
    await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: d.id, slot: 2, category: "VIDEO", currentSubmissionId: other.id, approvedSubmissionId: other.id } });
    const actor = { id: "kyle-test", name: "Kyle TEST" };
    const choices = await listingChoices(cut.id);
    c.ok("choice excludes older Aryeo video and names the two new media identities", choices.ok && choices.choices.length === 2 && choices.choices.some((x) => x.id === providerVideoId));
    c.ok("unchecked final file cannot be manually delivered", !(await manualListingCheckReady(cut.id)).ok);
    const { markVideoSentAction } = await import("@/app/ops/actions");
    const blockedAction = await markVideoSentAction(cut.id, "not-yet");
    c.ok("staff send action leaves unchecked cut unsent", !blockedAction.ok && !(await prisma.reviewSubmission.findUnique({ where: { id: cut.id } }))?.sentToClientAt);
    c.ok("partial checklist refused without a record", !(await recordListingCheck({ submissionId: cut.id, mediaId: providerVideoId, checks: ["identity"], actor })).ok && await prisma.finalRenditionCheck.count() === 0);
    c.ok("unknown provider video refused", !(await recordListingCheck({ submissionId: cut.id, mediaId: "missing", checks: [...FINAL_CHECK_KEYS], actor })).ok);
    const saved = await recordListingCheck({ submissionId: cut.id, mediaId: providerVideoId, checks: [...FINAL_CHECK_KEYS], metadata: { duration: 62, width: 1920, height: 1080 }, actor });
    const row = await prisma.finalRenditionCheck.findFirst({ where: { submissionId: cut.id } });
    c.ok("attributed exact-version attestation saved", saved.ok && row?.checkedBy === actor.name && row.destinationMediaId === providerVideoId && !!row.sourceFingerprint && !!row.metadataJson);
    c.ok("one video's check cannot certify sibling output", !(await manualListingCheckReady(other.id)).ok);
    c.ok("provider listing not yet delivered blocks manual send", !(await manualListingCheckReady(cut.id)).ok);
    delivered = true;
    c.ok("same provider file on delivered listing allows manual record", (await manualListingCheckReady(cut.id)).ok);
    playback = "https://example.test/replaced.mp4";
    c.ok("changed provider playback invalidates check", !(await manualListingCheckReady(cut.id)).ok);
    playback = "https://example.test/listing/video-a.mp4";
    providerVideoId = v7(Date.now() - 20 * 60_000);
    c.ok("changed provider identity invalidates check", !(await manualListingCheckReady(cut.id)).ok);
    providerVideoId = currentId;
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { blobUrl: "https://example.test/source-replaced.mp4" } });
    c.ok("changed source bytes pointer invalidates check", !(await manualListingCheckReady(cut.id)).ok);
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { blobUrl: "https://example.test/source-v2.mp4" } });
    const newer = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: d.id, slot: 1, round: 3, status: "PENDING", blobUrl: "https://example.test/v3.mp4" } });
    c.ok("newer round invalidates old approval", !(await manualListingCheckReady(cut.id)).ok);
    await prisma.reviewSubmission.update({ where: { id: newer.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    const sent = await markVideoSentAction(cut.id, "not-yet");
    const deliveredCut = await prisma.reviewSubmission.findUnique({ where: { id: cut.id } });
    const deliveredOutput = await prisma.deliverableOutput.findFirst({ where: { projectId: project.id, deliverableId: d.id, slot: 1 } });
    c.ok("verified manual action records this exact cut and output as sent", sent.ok && !!deliveredCut?.sentToClientAt && deliveredOutput?.sentSubmissionId === cut.id);
    const topaz = await prisma.topazJob.create({ data: { projectId: project.id, submissionId: other.id,
      state: "done", finalPath: "/Final/second-1080p.mp4", savedAt: new Date(Date.now() - 60 * 60_000) } });
    const task = await prisma.smartTask.create({ data: { projectId: project.id, taskType: "finish_delivery", title: "Upload second video", dedupeKey: `topaz-deliver-${topaz.id}` } });
    await prisma.topazJob.update({ where: { id: topaz.id }, data: { taskId: task.id } });
    const { setSmartTaskStatus } = await import("@/app/actions");
    const blockedTask = await setSmartTaskStatus(task.id, "COMPLETED");
    c.ok("Topaz task completion refuses missing final-file check", blockedTask?.ok === false && (await prisma.smartTask.findUnique({ where: { id: task.id } }))?.status === "OPEN");
    c.ok("second output cannot claim first Aryeo video", !(await recordListingCheck({ submissionId: other.id, mediaId: currentId, checks: [...FINAL_CHECK_KEYS], actor })).ok);
    const checkedSecond = await recordListingCheck({ submissionId: other.id, mediaId: secondId, checks: [...FINAL_CHECK_KEYS], actor });
    const taskDone = await setSmartTaskStatus(task.id, "COMPLETED");
    const topazAfter = await prisma.topazJob.findUnique({ where: { id: topaz.id } });
    const taskAfter = await prisma.smartTask.findUnique({ where: { id: task.id } });
    const outputAfter = await prisma.deliverableOutput.findFirst({ where: { projectId: project.id, deliverableId: d.id, slot: 2 } });
    c.ok("verified Topaz task records cut, output, render and task together", checkedSecond.ok && taskDone?.ok === true && !!topazAfter?.deliveredAt && taskAfter?.status === "COMPLETED" && outputAfter?.sentSubmissionId === other.id);
    c.ok("no provider request escaped fake listing", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
