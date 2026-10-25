import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE MEDIA CHECK CLOSES WITH THE PHOTO JOB (Jordan, Oct 21 2026; audit C11).
//
// "Media checks to finish" (the shoot's media_qa card) was a second manual
// photo check on top of the Photo Delivery queue: Kyle approved the gallery
// there, then closed the same check again on the card. Now the card closes
// itself the moment the photo job is approved or delivered:
//   · Kyle's Approve and deliver / Approve and upload (aryeoPush.approveJob),
//   · the hub's own same-day approval (aryeoPush's driver),
//   · a delivery verified on the listing (delivery.verifyDelivery), which
//     covers Mark as delivering and a delivery done in Aryeo by hand.
//
// It closes the way a person's close does (CLOSED_BY_HAND, the reason on the
// card and the job's timeline, a QcRecord for the owner's QC history), so the
// hourly reconciler never reopens it over unticked boxes. A category that
// lands on Aryeo LATER (the video, a floor plan) still brings the card back
// for that category alone: that is the reconciler's own rule, unchanged.
// It closes once (an open card only) and reopens nothing. Two carve-outs,
// both the reconciler's: never while the job is in revision (those closes
// belong to the re-QC tick or resolveRevision), and never a card the
// reconciler brought back for a category other than the photos.
// Best-effort: a failure here never stops an approval or a delivery.
// ---------------------------------------------------------------------------

export async function closeMediaCheckForPhotos(jobId: string, opts: { by: string; reason: string; human: boolean }): Promise<number> {
  try {
    const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
    if (!job?.projectId) return 0;
    const projectId = job.projectId;
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true, client: { select: { segment: true } } } });
    if (!project || project.status === "REVISION") return 0;
    const cards = await prisma.smartTask.findMany({
      where: { projectId, taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true, checklist: true, sourceDetail: true, assignedKey: true },
    });
    if (!cards.length) return 0;
    const { CLOSED_BY_HAND, recordQcCompletion, reopenedForCategories } = await import("@/lib/tasks");
    const { parseChecklist, serializeChecklist } = await import("@/lib/checklist");
    const { QC_LABEL } = await import("@/lib/qcCategories");
    // The photo job's own media only: virtual staging and headshots land by other paths and keep their own reopen.
    const ownRows = new Set(["PHOTOS", "DRONE", "TWILIGHT"].map((t) => `QC ${QC_LABEL[t]}`));
    const reason = `${opts.reason}${opts.human ? ` by ${opts.by}` : ""}.`.slice(0, 300);
    let closed = 0;
    for (const card of cards) {
      const backFor = reopenedForCategories(card.sourceDetail);
      if (backFor.some((c) => c !== "Photos")) continue;
      // Before the flip, as every other close does: a throw can't leave a
      // closed card with no record. Deduped and swallowed inside.
      await recordQcCompletion({
        projectId,
        items: parseChecklist(card.checklist),
        clientSegment: project.client?.segment ?? null,
        completedBy: opts.human ? card.assignedKey ?? "kyle" : "auto:photo-delivery",
      }).catch(() => {});
      // The photos' evidence row ("QC Photos") is ticked with the close (audit
      // Oct 25 2026). The hourly reconciler reopens a by-hand-closed card for
      // any category whose evidence row was unticked at the close and is
      // ticked now, and the photos reach the listing minutes AFTER the
      // approval that closes this card: 8 of the last 8 approvals came back as
      // "Photos landed on Aryeo after the card was closed by hand" (3745 S
      // Saucon Ave still open), work Photo Delivery had just done. A video or a
      // floor plan landing later still brings the card back, as before.
      const items = parseChecklist(card.checklist);
      const ticked = items.map((i) => (ownRows.has(i.label.trim()) ? { ...i, done: true } : i));
      const r = await prisma.smartTask.updateMany({
        where: { id: card.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: new Date(), sourceDetail: CLOSED_BY_HAND, summary: reason, ...(ticked.some((i, n) => i.done !== items[n].done) ? { checklist: serializeChecklist(ticked) } : {}) },
      });
      closed += r.count;
    }
    if (closed) {
      await prisma.activity
        .create({ data: { projectId, type: "SYSTEM", body: `Media check closed: ${reason}`.slice(0, 500) } })
        .catch(() => {});
    }
    return closed;
  } catch (e) {
    console.warn("[photo-delivery] media check close failed", (e as Error)?.message);
    return 0;
  }
}
