import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE CLIENT VIDEO LIBRARY (Jordan, Aug 28): every content-program video a
// client has ever received, materialized into PortalVideo so their portal
// loads instantly and completely.
//
//   · BACKFILL + SWEEP: Aryeo listing videos on enrollment-month projects —
//     the same CDN files their delivery emails point to. Upserts keyed
//     aryeo:<listingId>:<videoId>, so a re-run refreshes URLs instead of
//     duplicating.
//
// F23 (Sep 21 audit, fixed Sep 22 2026) — THE KEY USED TO BE A POSITION.
//
// The key was `aryeo:<listingId>:<n>` where n was the index into a FILTERED
// array (videos with a playback or download URL). Nothing about a position is
// stable: add a video, remove one, or have Aryeo return them in a different
// order, and the row keyed `:0` gets UPDATED with a different video's title,
// thumbnail and URLs. The client's library quietly relabels itself, and the
// download button under one video's name hands them another video's file.
//
// 157 live rows are keyed that way. They are re-keyed in place by
// rekeyIndexedLibraryRows() below — never deleted, and never guessed: a row is
// only re-keyed when its stored playback/download URL still matches exactly one
// video on the listing today. A row that cannot be identified keeps its old key
// and is reported, because a wrong re-key is the same defect with a new name.
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
        for (const v of usable) {
          // NO ID, NO ROW. A video Aryeo will not name cannot be given a stable
          // key, and falling back to its position is the bug this replaces —
          // it would be the one row that silently re-points on the next
          // refresh. The hourly sweep tries again; none of the 157 live rows
          // came from a payload without ids.
          if (!v.id) continue;
          const externalKey = `aryeo:${p.aryeoListingId}:${v.id}`;
          await prisma.portalVideo
            .upsert({
              where: { externalKey },
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
                externalKey,
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

// ---------------------------------------------------------------------------
// F23 — RE-KEY THE ROWS THAT ARE STILL ON A POSITION.
//
// Identity, not arithmetic. A row is re-keyed only when the URL it is already
// showing the client matches exactly ONE video on that listing today — which
// means the row and the video are provably the same file, whatever index it
// used to sit at. Anything else keeps its old key and is counted:
//
//   · the listing no longer carries that URL (the video was replaced) — the
//     row is stale either way and a re-key would attach it to a stranger;
//   · two videos share the URL (should not happen; if it does, a person looks);
//   · the listing cannot be read right now — try again next sweep.
//
// Nothing is deleted and no row's title, thumbnail or URLs are touched. The
// only thing that changes is the key, which is what stops the NEXT refresh
// rewriting one video's row with another's.
// ---------------------------------------------------------------------------
export async function rekeyIndexedLibraryRows(opts: { dryRun?: boolean; max?: number } = {}): Promise<{
  examined: number;
  rekeyed: number;
  alreadyKeyed: number;
  unmatched: number;
  unreadable: number;
  collisions: number;
  detail: { externalKey: string; to: string | null; why: string }[];
}> {
  // The old shape: aryeo:<listingId>:<digits>. The new one ends in a uuid.
  const rows = await prisma.portalVideo.findMany({
    where: { source: "aryeo", externalKey: { startsWith: "aryeo:" } },
    select: { id: true, externalKey: true, playback: true, download: true, projectId: true },
    take: opts.max ?? 500,
  });
  const INDEXED = /^aryeo:([^:]+):(\d+)$/;
  const detail: { externalKey: string; to: string | null; why: string }[] = [];
  let rekeyed = 0, alreadyKeyed = 0, unmatched = 0, unreadable = 0, collisions = 0;

  const { getListingMedia } = await import("@/lib/integrations/aryeo");
  const listings = new Map<string, Awaited<ReturnType<typeof getListingMedia>>>();

  for (const row of rows) {
    const m = INDEXED.exec(row.externalKey);
    if (!m) { alreadyKeyed++; continue; }
    const listingId = m[1];
    if (!listings.has(listingId)) listings.set(listingId, await getListingMedia(listingId).catch(() => null));
    const media = listings.get(listingId) ?? null;
    if (!media) { unreadable++; detail.push({ externalKey: row.externalKey, to: null, why: "Aryeo would not return that listing just now" }); continue; }

    const mine = media.videos.filter((v) => v.id && ((row.playback && v.playback === row.playback) || (row.download && v.download === row.download)));
    if (mine.length === 0) {
      unmatched++;
      detail.push({ externalKey: row.externalKey, to: null, why: "no video on the listing carries this row's URL any more — left alone rather than re-pointed" });
      continue;
    }
    if (mine.length > 1) {
      collisions++;
      detail.push({ externalKey: row.externalKey, to: null, why: `${mine.length} videos on the listing share this URL — a person should look` });
      continue;
    }
    const to = `aryeo:${listingId}:${mine[0].id}`;
    detail.push({ externalKey: row.externalKey, to, why: "its URL matches exactly one video on the listing" });
    if (opts.dryRun) { rekeyed++; continue; }
    try {
      await prisma.portalVideo.update({ where: { id: row.id }, data: { externalKey: to } });
      rekeyed++;
    } catch {
      // The id-keyed row already exists (a sweep created it beside this one).
      // The old row is RETIRED by key, not deleted: it stops colliding and
      // stops being refreshed, and the history is still there to read.
      await prisma.portalVideo.update({ where: { id: row.id }, data: { externalKey: `retired:${row.externalKey}:${row.id}` } }).catch(() => {});
      collisions++;
      detail.push({ externalKey: row.externalKey, to, why: "the id-keyed row already existed — this duplicate was retired, not deleted" });
    }
  }
  return { examined: rows.length, rekeyed, alreadyKeyed, unmatched, unreadable, collisions, detail };
}
