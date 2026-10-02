// W04 acceptance: a delivered video on a mixed listing cannot resolve its
// photo obligations; completing a photo ask cannot resolve its video sibling.
// Real signed actions/domain helpers, disposable PGlite, fake Aryeo reads only.
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

type Listing = { mediaId: string; duration: number; title: string };
const listings = new Map<string, Listing>();
const reads = { manual: 0, automatic: 0 };
const v7 = (at: number) => {
  const hex = at.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
};
const listingFor = (id: string) => {
  const listing = listings.get(id);
  if (!listing) throw new Error(`No fake listing registered: ${id}`);
  return listing;
};
interceptModule(
  (r) => r === "@/lib/integrations/aryeo" || /[\\/]src[\\/]lib[\\/]integrations[\\/]aryeo(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key === "getListingMedia") return async (id: string) => {
        reads.manual++;
        const l = listingFor(id);
        return {
          deliveryStatus: "DELIVERED", photoCount: 1, videoCount: 1, floorPlanCount: 0,
          cover: null, floorPlans: [],
          images: [{ id: "photo-with-open-correction", url: "https://example.test/photo.jpg" }],
          videos: [{ id: l.mediaId, title: l.title, duration: l.duration, thumb: null,
            playback: `https://example.test/${id}.mp4`, download: null }],
        };
      };
      if (key === "Aryeo") return new Proxy(target[key] as Record<string | symbol, unknown>, {
        get(aryeo, method) {
          if (method === "listing") return async (id: string) => {
            reads.automatic++;
            const l = listingFor(id);
            return { id, delivery_status: "DELIVERED",
              images: [{ id: "photo-with-open-correction", url: "https://example.test/photo.jpg" }],
              videos: [{ id: l.mediaId, title: l.title, duration: l.duration, content_hash: "fixture-final-hash" }] };
          };
          return aryeo[method];
        },
      });
      return target[key];
    },
  }),
);
installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: 5793, env: {
    AUTH_ENFORCE: "true", APP_SECRET: "w04-mixed-isolated-session-secret",
  } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { FINAL_CHECK_KEYS } = await import("@/lib/finalRendition");
    const { recordListingFinalCheckAction } = await import("@/app/ops/finalRenditionActions");
    const { markVideoSentAction } = await import("@/app/ops/actions");
    const { proveListingNow } = await import("@/lib/aryeoDelivery");
    const { setSmartTaskStatus } = await import("@/app/actions");
    const user = await prisma.appUser.create({ data: {
      email: "kyle-w04-mixed@example.test", name: "Kyle Mixed TEST", role: "ADMIN", status: "ACTIVE",
    } });
    await setSession({ uid: user.id, email: user.email, role: user.role });
    c.ok("signed staff actions run with auth enforced in a separate loopback database",
      process.env.AUTH_ENFORCE === "true" && new URL(process.env.DATABASE_URL!).port === "5793");
    const client = await prisma.client.create({ data: { name: "W04 Mixed TEST", autoDeliveryText: false } });
    const now = Date.now();
    const askedAt = new Date(now - 3 * 86_400_000);
    const approvedAt = new Date(now - 2 * 86_400_000);
    const savedAt = new Date(now - 86_400_000);

    const mixedJob = async (name: string) => {
      const listingId = `w04-mixed-${name}`;
      const project = await prisma.project.create({ data: {
        clientId: client.id, title: `W04 ${name} TEST`, aryeoListingId: listingId,
        status: "REVISION", revisionRequestedAt: askedAt, revisionNote: "Correct the dark front photo",
      } });
      const photo = await prisma.deliverable.create({ data: {
        projectId: project.id, type: "PHOTOS", quantity: 1, status: "FLAGGED", label: "Professional Photography",
      } });
      const video = await prisma.deliverable.create({ data: {
        projectId: project.id, type: "VIDEO", quantity: 1, productTitle: "Cinematic Video",
      } });
      const cut = await prisma.reviewSubmission.create({ data: {
        projectId: project.id, deliverableId: video.id, slot: 1, round: 2, status: "APPROVED",
        fileName: `${name}-v2.mov`, blobUrl: `https://example.test/${name}-v2.mov`,
        contentHash: `${name}-exact-v2`, assetPath: `/Final/${name}-v2.mov`, decidedAt: approvedAt,
      } });
      const output = await prisma.deliverableOutput.create({ data: {
        projectId: project.id, deliverableId: video.id, slot: 1, category: "VIDEO",
        currentSubmissionId: cut.id, approvedSubmissionId: cut.id,
      } });
      const photoTask = await prisma.smartTask.create({ data: {
        projectId: project.id, taskType: "revision", title: "Photo revision — dark front photo",
        dedupeKey: `revision-${project.id}-photo`, assignedKey: "kyle", status: "OPEN", createdAt: askedAt,
      } });
      const qc = await prisma.smartTask.create({ data: {
        projectId: project.id, taskType: "media_qa", title: "Re-QC photo correction",
        dedupeKey: `media-qa-${project.id}`, assignedKey: "kyle", status: "OPEN",
      } });
      const flag = await prisma.imageFlag.create({ data: {
        projectId: project.id, imageUrl: "https://example.test/photo.jpg", tags: "[]",
        note: "Correct the dark front photo", status: "OPEN", createdAt: askedAt,
      } });
      // The photo ask predates this render. A newer complaint deliberately
      // holds automatic proof under the existing conservative matching rule.
      const mediaId = v7(now - 3_600_000);
      listings.set(listingId, { mediaId, duration: 62, title: "Cinematic Video" });
      return { project, photo, video, cut, output, photoTask, qc, flag, listingId, mediaId };
    };
    type MixedJob = Awaited<ReturnType<typeof mixedJob>>;
    const photoStillOwed = async (name: string, job: MixedJob) => {
      const [photo, task, flag, qc, project] = await Promise.all([
        prisma.deliverable.findUniqueOrThrow({ where: { id: job.photo.id } }),
        prisma.smartTask.findUniqueOrThrow({ where: { id: job.photoTask.id } }),
        prisma.imageFlag.findUniqueOrThrow({ where: { id: job.flag.id } }),
        prisma.smartTask.findUniqueOrThrow({ where: { id: job.qc.id } }),
        prisma.project.findUniqueOrThrow({ where: { id: job.project.id } }),
      ]);
      c.ok(`${name}: photo obligation remains flagged, unwaived and on the order`,
        photo.status === "FLAGGED" && !photo.waivedAt && !photo.removedFromOrderAt);
      c.ok(`${name}: exact photo revision stays open`, task.status === "OPEN" && !task.completedAt);
      c.ok(`${name}: exact image correction stays open`, flag.status === "OPEN" && !flag.resolvedAt);
      c.ok(`${name}: photo re-QC stays open`, qc.status === "OPEN" && !qc.completedAt);
      c.ok(`${name}: project retains the photo revision and its original request time`,
        project.status === "REVISION" && project.revisionRequestedAt?.getTime() === askedAt.getTime()
        && project.revisionNote === job.project.revisionNote && !project.deliveredAt);
    };
    const sentExactVideo = async (name: string, job: MixedJob) => {
      const [cut, output] = await Promise.all([
        prisma.reviewSubmission.findUniqueOrThrow({ where: { id: job.cut.id } }),
        prisma.deliverableOutput.findUniqueOrThrow({ where: { id: job.output.id } }),
      ]);
      c.ok(`${name}: exact approved cut and video output are recorded as delivered`,
        !!cut.sentToClientAt && !!output.deliveredAt && output.sentSubmissionId === cut.id);
      c.ok(`${name}: current and approved video pointers remain on that exact version`,
        output.currentSubmissionId === cut.id && output.approvedSubmissionId === cut.id);
    };

    c.head("Signed final-file check and manual delivery on a mixed listing");
    const manual = await mixedJob("manual");
    const form = new FormData();
    form.set("submissionId", manual.cut.id); form.set("mediaId", manual.mediaId);
    for (const key of FINAL_CHECK_KEYS) form.set(key, "yes");
    form.set("duration", "62"); form.set("width", "1920"); form.set("height", "1080");
    const checked = await recordListingFinalCheckAction(form);
    const check = await prisma.finalRenditionCheck.findFirst({ where: { submissionId: manual.cut.id } });
    c.ok("final-file check records signed staff and the exact video identity on this mixed listing",
      checked.ok && check?.checkedByUserId === user.id && check.destinationMediaId === manual.mediaId);
    const { recordUploaded } = await import("@/lib/deliveryUploads");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");
    await recordUploaded(manual.cut.id, { id: user.id, name: user.name! }, sourceFingerprint((await loadCut(manual.cut.id))!)!);
    const sent = await markVideoSentAction(manual.cut.id);
    c.ok("verified manual send confirms its own receipt", sent.ok, sent.message);
    await sentExactVideo("manual video delivery", manual);
    await photoStillOwed("manual video delivery", manual);

    c.head("Automatic provider proof of the exact rendered video on a mixed listing");
    const auto = await mixedJob("automatic");
    const upload = await prisma.smartTask.create({ data: {
      projectId: auto.project.id, taskType: "delivery", title: "Upload the 1080p video to Aryeo",
      dedupeKey: `topaz-deliver-${auto.cut.id}`, assignedKey: "kyle", status: "OPEN",
    } });
    const topaz = await prisma.topazJob.create({ data: {
      projectId: auto.project.id, submissionId: auto.cut.id, taskId: upload.id, state: "done",
      fileName: "automatic-v2.mov", sourceDurationSec: 62, savedAt, finishedAt: savedAt,
      finalPath: "/Final/automatic-v2-1080p.mp4",
    } });
    const uploaded = await recordUploaded(auto.cut.id, { id: user.id, name: user.name! }, sourceFingerprint((await loadCut(auto.cut.id))!)!);
    c.ok("automatic proof starts from exact staff upload", uploaded.ok);
    // Private exact-file receipt: fake Dropbox is intentionally not contacted.
    const receipt = await prisma.auditLog.findFirstOrThrow({ where: { target: auto.cut.id, action: "video_uploaded" } });
    await prisma.auditLog.update({ where: { id: receipt.id }, data: { detail: JSON.stringify({ ...JSON.parse(receipt.detail), finalContentHash: "fixture-final-hash" }) } });
    const withoutEvent = await proveListingNow(auto.listingId, "drill: no trusted occurrence");
    c.ok("delivered listing alone does not close uploaded file", withoutEvent.closed === 0 && !(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: auto.cut.id } })).sentToClientAt);
    await prisma.auditLog.create({ data: { action: "aryeo_listing_delivery_event", target: auto.listingId, actor: "authenticated-webhook", detail: JSON.stringify({ listingId: auto.listingId, occurredAt: new Date().toISOString() }) } });
    await prisma.appSetting.updateMany({ where: { key: `aryeo-wh-seen-prove-listing-${auto.listingId}` }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    const proof = await proveListingNow(auto.listingId, "drill: W04 mixed delivery");
    c.ok("actual automatic proof reads the fake mixed listing and closes exactly its upload card",
      proof.looked && proof.closed === 1 && reads.automatic === 2, proof.note);
    const [jobAfter, uploadAfter] = await Promise.all([
      prisma.topazJob.findUniqueOrThrow({ where: { id: topaz.id } }),
      prisma.smartTask.findUniqueOrThrow({ where: { id: upload.id } }),
    ]);
    c.ok("proof settles only the rendered-video upload receipt", !!jobAfter.deliveredAt && uploadAfter.status === "COMPLETED");
    await sentExactVideo("automatic video delivery", auto);
    await photoStillOwed("automatic video delivery", auto);

    c.head("Completing one photo revision retains current video work");
    const converse = await mixedJob("photo-completion");
    const videoAsk = await prisma.smartTask.create({ data: {
      projectId: converse.project.id, taskType: "revision", title: "Video revision — correct the next cut",
      dedupeKey: `revision-${converse.project.id}-video`, assignedKey: "kyle", status: "OPEN",
    } });
    await setSmartTaskStatus(converse.photoTask.id, "COMPLETED");
    const [photoDone, videoOpen, cut, output, project, qc] = await Promise.all([
      prisma.smartTask.findUniqueOrThrow({ where: { id: converse.photoTask.id } }),
      prisma.smartTask.findUniqueOrThrow({ where: { id: videoAsk.id } }),
      prisma.reviewSubmission.findUniqueOrThrow({ where: { id: converse.cut.id } }),
      prisma.deliverableOutput.findUniqueOrThrow({ where: { id: converse.output.id } }),
      prisma.project.findUniqueOrThrow({ where: { id: converse.project.id } }),
      prisma.smartTask.findUniqueOrThrow({ where: { id: converse.qc.id } }),
    ]);
    c.ok("signed real task action completes the photo ask", photoDone.status === "COMPLETED" && !!photoDone.completedAt);
    c.ok("photo completion leaves the exact video ask open and assigned", videoOpen.status === "OPEN" && !videoOpen.completedAt && videoOpen.assignedKey === videoAsk.assignedKey);
    c.ok("photo completion cannot stamp the current video delivered", !cut.sentToClientAt && !output.deliveredAt && !output.sentSubmissionId);
    c.ok("photo completion preserves current and approved video version pointers", output.currentSubmissionId === cut.id && output.approvedSubmissionId === cut.id);
    c.ok("photo completion retains the project revision and outstanding QC", project.status === "REVISION" && project.revisionRequestedAt?.getTime() === askedAt.getTime() && qc.status === "OPEN");
    c.ok("manual path used fake listing reads and no provider request escaped the fence", reads.manual > 0 && fence.blocked.length === 0);
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
