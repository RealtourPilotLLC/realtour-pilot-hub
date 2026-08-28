import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE CLIENT VIDEO LIBRARY (Jordan, Aug 28): every content-program video a
// client has ever received, materialized into PortalVideo so their portal
// loads instantly and completely.
//
//   · BACKFILL + SWEEP: Aryeo listing videos on enrollment-month projects —
//     the same CDN files their delivery emails point to. Upserts keyed
//     aryeo:<listingId>:<n>, so a re-run refreshes URLs instead of duplicating.
//   · GOING FORWARD: the Review Room approve hook (addApprovedCutToLibrary) —
//     the moment a cut passes QC, its Dropbox streaming link lands in the
//     library. "It gets added once it passes QC and is uploaded to Dropbox."
// ---------------------------------------------------------------------------

/** Rebuild one enrollment's Aryeo-sourced library rows. Idempotent. */
export async function syncEnrollmentLibrary(enrollmentId: string): Promise<{ videos: number; listings: number }> {
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId },
    select: { id: true },
  });
  if (months.length === 0) return { videos: 0, listings: 0 };
  const projects = await prisma.project.findMany({
    where: {
      contentMonthId: { in: months.map((m) => m.id) },
      status: { not: "CANCELLED" },
      aryeoListingId: { not: null },
    },
    select: { id: true, contentMonthId: true, aryeoListingId: true, deliveredAt: true, shootDate: true },
  });
  if (projects.length === 0) return { videos: 0, listings: 0 };

  const { getListingMedia } = await import("@/lib/integrations/aryeo");
  let videos = 0, listings = 0;
  for (let i = 0; i < projects.length; i += 4) {
    await Promise.all(
      projects.slice(i, i + 4).map(async (p) => {
        const media = await getListingMedia(p.aryeoListingId!).catch(() => null);
        if (!media) return;
        listings++;
        const usable = media.videos.filter((v) => v.playback || v.download);
        for (let n = 0; n < usable.length; n++) {
          const v = usable[n];
          await prisma.portalVideo
            .upsert({
              where: { externalKey: `aryeo:${p.aryeoListingId}:${n}` },
              update: { title: v.title, thumb: v.thumb, playback: v.playback, download: v.download },
              create: {
                enrollmentId,
                monthId: p.contentMonthId,
                projectId: p.id,
                title: v.title,
                thumb: v.thumb,
                playback: v.playback,
                download: v.download,
                source: "aryeo",
                externalKey: `aryeo:${p.aryeoListingId}:${n}`,
                deliveredAt: p.deliveredAt ?? p.shootDate ?? new Date(),
              },
            })
            .then(() => videos++)
            .catch(() => {});
        }
      }),
    );
  }
  return { videos, listings };
}

/**
 * Hourly: refresh libraries for enrollments whose content projects moved
 * recently (a fresh Aryeo delivery lands within the hour). The full history
 * is the backfill script's job, not the cron's.
 */
export async function sweepPortalLibraries(): Promise<{ enrollments: number; videos: number }> {
  const recent = await prisma.project.findMany({
    where: {
      contentMonthId: { not: null },
      status: "DELIVERED",
      deliveredAt: { gte: new Date(Date.now() - 3 * 86_400_000) },
    },
    select: { contentMonthId: true },
  });
  if (recent.length === 0) return { enrollments: 0, videos: 0 };
  const months = await prisma.contentMonth.findMany({
    where: { id: { in: [...new Set(recent.map((p) => p.contentMonthId!))] } },
    select: { enrollmentId: true },
  });
  const enrollmentIds = [...new Set(months.map((m) => m.enrollmentId))];
  let videos = 0;
  for (const id of enrollmentIds) {
    const r = await syncEnrollmentLibrary(id).catch(() => ({ videos: 0, listings: 0 }));
    videos += r.videos;
  }
  return { enrollments: enrollmentIds.length, videos };
}

/**
 * A cut passed QC (Review Room approve) — add it to the client's library
 * immediately, from its Dropbox streaming link. Content-program jobs only;
 * a listing shoot's cut approves as before with no library row.
 */
export async function addApprovedCutToLibrary(submissionId: string): Promise<boolean> {
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true, projectId: true, assetUrl: true, fileName: true, decidedAt: true,
      project: { select: { contentMonthId: true } },
    },
  });
  if (!sub?.assetUrl || !sub.project?.contentMonthId) return false;
  const month = await prisma.contentMonth.findUnique({
    where: { id: sub.project.contentMonthId },
    select: { id: true, enrollmentId: true },
  });
  if (!month) return false;
  await prisma.portalVideo
    .upsert({
      where: { externalKey: `sub:${sub.id}` },
      update: { playback: sub.assetUrl, title: sub.fileName },
      create: {
        enrollmentId: month.enrollmentId,
        monthId: month.id,
        projectId: sub.projectId,
        title: sub.fileName,
        thumb: null,
        playback: sub.assetUrl,
        download: sub.assetUrl,
        source: "review",
        externalKey: `sub:${sub.id}`,
        deliveredAt: sub.decidedAt ?? new Date(),
      },
    })
    .catch(() => {});
  return true;
}
