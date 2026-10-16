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
export async function syncEnrollmentLibrary(enrollmentId: string): Promise<{ videos: number; listings: number; repoints?: RepointReport[] }> {
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId },
    select: { id: true },
  });
  if (months.length === 0) return { videos: 0, listings: 0 };
  // Oct 15 2026: whether a row still on an old index key may be re-pointed to
  // its re-edit ("Tip #1" → "Tip #1 V2"); off = reported only (see below).
  const apply = await import("@/lib/programWatch").then((m) => m.programWatchRules()).then((r) => r.libraryRepoint).catch(() => false);
  const repoints: RepointReport[] = [];
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
        // Oct 15 2026: the re-edit re-point runs BEFORE the upserts, so a row
        // re-pointed to its V2 is refreshed under its new key below instead of
        // the V2 being minted a second time beside it. Then what the listing
        // holds is kept for the nightly completeness check (no second read).
        const r = await repointReplacedRows({ enrollmentId, listingId: p.aryeoListingId!, videos: media.videos, apply }).catch(() => [] as RepointReport[]);
        repoints.push(...r);
        await cacheListingMedia(p.aryeoListingId!, media.videos, r).catch(() => {});
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
  return { videos, listings, ...(repoints.length ? { repoints } : {}) };
}

/**
 * Hourly: refresh libraries for enrollments whose content projects moved
 * recently (a fresh Aryeo delivery lands within the hour). The full history
 * is the backfill script's job, not the cron's.
 */
export async function sweepPortalLibraries(opts: { days?: number } = {}): Promise<{ enrollments: number; videos: number; completeness?: LibraryCheckResult | { error: string } }> {
  const swept = await sweepRecentLibraries(opts);
  // Oct 15 2026: the once-a-day pass (the cron's 4 AM run, 60 days back) ends
  // with the library completeness check. Database only: it reads what the
  // sweep just cached from the listings and calls no provider itself.
  if ((opts.days ?? 3) < 30) return swept;
  const completeness = await checkLibraryCompleteness().catch((e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 200) : "library check failed" }));
  return { ...swept, completeness };
}

async function sweepRecentLibraries(opts: { days?: number }): Promise<{ enrollments: number; videos: number }> {
  // Oct 15 2026: the hourly pass looks 3 days back; once a day the cron looks
  // 60 days back, because a listing gains videos AFTER its delivery (a re-edit
  // "V2", a late "Why I Love Bow Tree") and the 3-day window never saw Marcee
  // McMullen's August additions.
  const days = Math.max(1, Math.min(120, Math.trunc(opts.days ?? 3)));
  const recent = await prisma.project.findMany({
    where: {
      contentMonthId: { not: null },
      status: "DELIVERED",
      deliveredAt: { gte: new Date(Date.now() - days * 86_400_000) },
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
  // The upsert used to end in `.catch(() => {})` and the function returned
  // `true` regardless — so a caller that DID check got "added" on a row that
  // was never written (F14). It throws now; approveCut's own try/catch is what
  // keeps an approval from failing over it, and repairApprovedCutLibrary is
  // what makes sure the row arrives in the end.
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
    });
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

// ---------------------------------------------------------------------------
// F14 — THE APPROVE → LIBRARY BRIDGE CONVERGES INSTEAD OF HOPING.
//
// approveCut calls addApprovedCutToLibrary inside a try/catch with the comment
// "best-effort — approval never fails over it". Making the approval survive a
// library failure is right. Leaving the library row missing forever afterwards
// is not: the client's Videos tab simply never shows that cut, nobody is told,
// and nothing looks again. addApprovedCutToLibrary itself swallows its own
// upsert error too, so even a caller that checked the return value would be
// told `true` on a failed write.
//
// sweepPortalLibraries does not cover this: it only rebuilds the ARYEO-sourced
// rows, and only for projects delivered in the last three days. A `sub:` row
// that never landed is invisible to it.
//
// This is the watcher. It asks the only question that matters — which approved
// content cuts have no library row — and makes the missing ones, idempotently.
// It is cheap because the answer is normally zero.
// ---------------------------------------------------------------------------
export async function repairApprovedCutLibrary(opts: { sinceDays?: number; max?: number } = {}): Promise<{ checked: number; repaired: number; failed: number; lastError: string | null }> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 45) * 86_400_000);
  // Approved cuts on content-program jobs — the exact set addApprovedCutToLibrary
  // is meant to have covered.
  const approved = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", assetUrl: { not: null }, decidedAt: { gte: since }, project: { contentMonthId: { not: null }, status: { not: "CANCELLED" } } },
    select: { id: true },
    orderBy: { decidedAt: "desc" },
    take: opts.max ?? 200,
  });
  if (!approved.length) return { checked: 0, repaired: 0, failed: 0, lastError: null };

  const have = new Set(
    (await prisma.portalVideo.findMany({ where: { externalKey: { in: approved.map((a) => `sub:${a.id}`) } }, select: { externalKey: true } })).map((r) => r.externalKey),
  );
  let repaired = 0, failed = 0;
  let lastError: string | null = null;
  for (const a of approved) {
    if (have.has(`sub:${a.id}`)) continue;
    try {
      const ok = await addApprovedCutToLibrary(a.id);
      // A false here is a legitimate refusal (no asset, not a content job), not
      // a failure — the row is not owed.
      if (ok) repaired++;
    } catch (e) {
      failed++;
      lastError = e instanceof Error ? e.message.slice(0, 200) : "unknown";
    }
  }
  if (repaired > 0) console.info(`[library] ${repaired} approved cut(s) had no portal row and were added — the approve-time write had failed and nothing was watching.`);
  return { checked: approved.length, repaired, failed, lastError };
}

// ---------------------------------------------------------------------------
// A RE-EDIT REPLACED THE FILE (Oct 15 2026). Marcee McMullen's August listing
// had its four tips re-delivered as "… V2"; her library rows, still on the old
// index key (aryeo:<listing>:<n>), kept pointing at the first versions, and
// rekeyIndexedLibraryRows above leaves such rows alone on purpose (their URL
// matches nothing on the listing any more).
//
// The one safe re-point: the row's file is gone from the listing, and EXACTLY
// ONE listing video's title is the row's title plus a version suffix ("V2",
// "v2", "(2)"). Then the row takes that video's key, title and links. If the
// re-edit already has its own id-keyed row, the old row is retired by key
// (never deleted), exactly as the F23 re-key does. Anything else is reported
// and left alone. With the libraryRepoint switch off (the default) nothing is
// written: the report rides the nightly check so a person can decide.
// ---------------------------------------------------------------------------

export type RepointReport = { externalKey: string; title: string | null; to: string | null; toTitle: string | null; action: "repointed" | "retired" | "would-repoint" | "would-retire" | "left-alone"; why: string };

const VERSION_SUFFIX = /\s*(?:[-–—:]\s*)?(?:\(\s*v\s*\d+\s*\)|\bv\s*\d+|\(\s*\d+\s*\))\s*$/i;
const titleKey = (t: string | null | undefined) =>
  (t ?? "").toLowerCase().replace(VERSION_SUFFIX, "").replace(/[–—-]/g, " ").replace(/#\s*/g, "#").replace(/\s+/g, " ").trim();

/** The listing videos that are THIS title's re-edit: same words, plus a version suffix. Pure. */
export function reEditsOf<V extends { id: string | null; title: string | null; playback: string | null; download: string | null }>(oldTitle: string | null, videos: V[]): V[] {
  const base = titleKey(oldTitle);
  if (!base) return [];
  const old = (oldTitle ?? "").trim().toLowerCase();
  return videos.filter((v) => !!v.id && !!(v.playback || v.download) && !!v.title && VERSION_SUFFIX.test(v.title) && v.title.trim().toLowerCase() !== old && titleKey(v.title) === base);
}

type ListingVideo = { id: string | null; title: string | null; thumb: string | null; playback: string | null; download: string | null };

export async function repointReplacedRows(input: { enrollmentId: string; listingId: string; videos: ListingVideo[]; apply: boolean }): Promise<RepointReport[]> {
  const INDEXED = new RegExp(`^aryeo:${input.listingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)$`);
  const rows = (await prisma.portalVideo.findMany({
    where: { enrollmentId: input.enrollmentId, externalKey: { startsWith: `aryeo:${input.listingId}:` } },
    select: { id: true, externalKey: true, title: true, playback: true, download: true },
  })).filter((r) => INDEXED.test(r.externalKey));
  const out: RepointReport[] = [];
  for (const row of rows) {
    const same = input.videos.some((v) => (row.playback && v.playback === row.playback) || (row.download && v.download === row.download));
    if (same) continue; // still the same file: the F23 re-key's business, not this
    const hits = reEditsOf(row.title, input.videos);
    if (hits.length !== 1) {
      out.push({ externalKey: row.externalKey, title: row.title, to: null, toTitle: null, action: "left-alone", why: hits.length ? `${hits.length} re-edits on the listing match its title, a person should pick` : "its file is no longer on the listing and no re-edit matches its title" });
      continue;
    }
    const v = hits[0];
    const to = `aryeo:${input.listingId}:${v.id}`;
    const clash = await prisma.portalVideo.findUnique({ where: { externalKey: to }, select: { id: true } });
    if (!input.apply) {
      out.push({ externalKey: row.externalKey, title: row.title, to, toTitle: v.title, action: clash ? "would-retire" : "would-repoint", why: clash ? "the re-edit already has its own library row" : "its file was replaced by the re-edit" });
      continue;
    }
    try {
      if (clash) {
        await prisma.portalVideo.update({ where: { id: row.id }, data: { externalKey: `retired:${row.externalKey}:${row.id}` } });
        out.push({ externalKey: row.externalKey, title: row.title, to, toTitle: v.title, action: "retired", why: "the re-edit already had its own library row; the old row was retired by key, not deleted" });
      } else {
        await prisma.portalVideo.update({ where: { id: row.id }, data: { externalKey: to, title: v.title, thumb: v.thumb, playback: v.playback, download: v.download } });
        out.push({ externalKey: row.externalKey, title: row.title, to, toTitle: v.title, action: "repointed", why: "its file was replaced by the re-edit" });
      }
    } catch (e) {
      out.push({ externalKey: row.externalKey, title: row.title, to, toTitle: v.title, action: "left-alone", why: `the write failed (${e instanceof Error ? e.message.slice(0, 80) : "unknown"})` });
    }
  }
  if (out.some((r) => r.action === "repointed" || r.action === "retired")) {
    console.info(`[library] ${input.listingId}: ${out.filter((r) => r.action === "repointed" || r.action === "retired").length} row(s) moved to their re-edit`);
  }
  return out;
}

// ---- what the listing held, kept for the nightly check -------------------------

export const LISTING_MEDIA_PREFIX = "listing-media:";
type ListingCache = { at: string; videos: { id: string | null; title: string | null; file: boolean }[]; repoints: RepointReport[] };

async function cacheListingMedia(listingId: string, videos: ListingVideo[], repoints: RepointReport[]): Promise<void> {
  const key = `${LISTING_MEDIA_PREFIX}${listingId}`;
  const value = JSON.stringify({
    at: new Date().toISOString(),
    videos: videos.slice(0, 60).map((v) => ({ id: v.id, title: v.title, file: !!(v.playback || v.download) })),
    repoints: repoints.slice(0, 20),
  } satisfies ListingCache);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedBy: "library-sync" }, update: { value, updatedBy: "library-sync" } });
}

// ---------------------------------------------------------------------------
// IS EVERYTHING OWED ACTUALLY IN THE CLIENT'S LIBRARY? (Oct 15 2026)
//
// Marcee McMullen's portal library was missing videos and nobody knew until
// she said so. Nightly (the 4 AM sweep), for every program month of the last
// four whose work SHOULD be done (a video counts once its promise plus one
// business day has passed, or its job is delivered), the videos owed are set
// against the videos the client can see in her library (ContentVideo released,
// approved or delivered). A month that is short, or whose listing holds a
// video the library does not, or whose library row still plays a replaced
// file, is raised on the exceptions board ("library-missing", see
// opsExceptions) with the candidates said plainly:
//   · an owed video with an approved cut that is not published;
//   · an owed video with no approved cut yet;
//   · a video on the client's Aryeo listing that is not in the library (read
//     from what the hourly sync last saw, never a new call from a page);
//   · a library row still on an old key whose file was replaced by a re-edit.
// The record clears itself the night the month is whole. Read-only towards
// the library: this writes only its own AppSetting rows.
// ---------------------------------------------------------------------------

export const LIBRARY_SHORT_PREFIX = "library-short:";
export type LibraryShortRecord = {
  monthId: string;
  monthKey: string;
  enrollmentId: string;
  clientId: string;
  clientName: string;
  /** owed videos whose work should be done */
  due: number;
  /** of the month's videos, the ones the client can see */
  inLibrary: number;
  short: number;
  /** plain lines, most useful first */
  missing: string[];
  firstSeenAt: string;
  checkedAt: string;
  resolvedAt: string | null;
};
export type LibraryCheckResult = { months: number; checked: number; short: number; raised: number; resolved: number };

const VISIBLE_STATUSES = new Set(["CLIENT_REVIEW", "APPROVED", "DELIVERED"]);
const monthKeyBack = (now: Date, n: number) => {
  const [y, m] = now.toISOString().slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 15));
  return d.toISOString().slice(0, 7);
};

export async function checkLibraryCompleteness(opts: { now?: Date; monthsBack?: number } = {}): Promise<LibraryCheckResult> {
  const now = opts.now ?? new Date();
  const out: LibraryCheckResult = { months: 0, checked: 0, short: 0, raised: 0, resolved: 0 };
  const months = await prisma.contentMonth.findMany({
    where: { monthKey: { gte: monthKeyBack(now, opts.monthsBack ?? 4) }, historical: false, status: { not: "SKIPPED" } },
    select: { id: true, monthKey: true, enrollmentId: true, clientId: true, videosOwed: true },
  });
  out.months = months.length;
  if (months.length === 0) return out;
  const monthIds = months.map((m) => m.id);
  const [projects, existing] = await Promise.all([
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds }, status: { not: "CANCELLED" } },
      select: { id: true, title: true, contentMonthId: true, status: true, deliveredAt: true, deliveryDue: true, dueOverrideAt: true, promisedDueAt: true, shootDate: true, aryeoListingId: true },
    }),
    prisma.appSetting.findMany({ where: { key: { in: monthIds.map((id) => `${LIBRARY_SHORT_PREFIX}${id}`) } }, select: { key: true, value: true } }),
  ]);
  const prior = new Map<string, LibraryShortRecord>();
  for (const e of existing) {
    try { prior.set(e.key.slice(LIBRARY_SHORT_PREFIX.length), JSON.parse(e.value) as LibraryShortRecord); } catch { /* rewritten below */ }
  }
  const pIds = projects.map((p) => p.id);
  const [outputs, rounds, videos, libraryRows, clients] = await Promise.all([
    pIds.length
      ? prisma.deliverableOutput.findMany({
          where: { projectId: { in: pIds }, waivedAt: null, removedFromOrderAt: null, deliverable: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
          select: { id: true, projectId: true, deliverableId: true, slot: true, title: true, promisedAt: true },
        })
      : [],
    pIds.length
      ? prisma.reviewSubmission.findMany({
          where: { projectId: { in: pIds }, deliverableId: { not: null }, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
          select: { id: true, deliverableId: true, slot: true, status: true, decidedAt: true, createdAt: true, fileName: true },
          orderBy: { round: "asc" },
        })
      : [],
    prisma.contentVideo.findMany({
      where: { monthId: { in: monthIds }, status: { not: "ARCHIVED" } },
      select: { id: true, monthId: true, outputId: true, title: true, status: true, deliveredAt: true, releasedToClientAt: true },
    }),
    prisma.portalVideo.findMany({ where: { monthId: { in: monthIds } }, select: { externalKey: true, monthId: true } }),
    prisma.client.findMany({ where: { id: { in: [...new Set(months.map((m) => m.clientId))] } }, select: { id: true, name: true } }),
  ]);
  const listingIds = [...new Set(projects.map((p) => p.aryeoListingId).filter((x): x is string => !!x))];
  const caches = new Map<string, ListingCache>();
  if (listingIds.length) {
    for (const r of await prisma.appSetting.findMany({ where: { key: { in: listingIds.map((id) => `${LISTING_MEDIA_PREFIX}${id}`) } }, select: { key: true, value: true } })) {
      try { caches.set(r.key.slice(LISTING_MEDIA_PREFIX.length), JSON.parse(r.value) as ListingCache); } catch { /* unreadable = not read */ }
    }
  }
  const { effectiveDue } = await import("@/lib/editOverrides");
  const { addBusinessDaysET, etDate } = await import("@/lib/datetime");
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const libraryKeys = new Set(libraryRows.map((r) => r.externalKey));
  // Which of those rows the client's library page actually shows: a library
  // row becomes a client video through its source link (contentVideos sync).
  const linkedKeys = new Set(
    libraryRows.length
      ? (await prisma.contentVideoSource.findMany({ where: { kind: "PORTAL_VIDEO", ref: { in: libraryRows.map((r) => r.externalKey) } }, select: { ref: true } })).map((r) => r.ref)
      : [],
  );
  const quoteT = (t: string | null | undefined, fallback: string) => `"${(t?.trim() || fallback).replace(/"/g, "'")}"`;

  for (const m of months) {
    const mine = projects.filter((p) => p.contentMonthId === m.id);
    const pById = new Map(mine.map((p) => [p.id, p]));
    const owed = outputs.filter((o) => pById.has(o.projectId));
    const due = owed.filter((o) => {
      const p = pById.get(o.projectId)!;
      if (p.status === "DELIVERED") return true;
      const promise = o.promisedAt ?? effectiveDue(p, p.deliveryDue);
      return !!promise && addBusinessDaysET(promise, 1) <= now;
    });
    const key = `${LIBRARY_SHORT_PREFIX}${m.id}`;
    const was = prior.get(m.id) ?? null;
    if (due.length === 0) {
      if (was && !was.resolvedAt) {
        await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify({ ...was, resolvedAt: now.toISOString(), checkedAt: now.toISOString() }) } }).catch(() => {});
        out.resolved++;
      }
      continue;
    }
    out.checked++;
    const monthVideos = videos.filter((v) => v.monthId === m.id);
    const visible = monthVideos.filter((v) => !!v.deliveredAt || !!v.releasedToClientAt || VISIBLE_STATUSES.has(v.status));
    const visibleOutputs = new Set(visible.map((v) => v.outputId).filter((x): x is string => !!x));
    const short = Math.max(0, due.length - visible.length);
    const missing: string[] = [];
    if (short > 0) {
      for (const o of due.filter((x) => !visibleOutputs.has(x.id))) {
        const rs = rounds.filter((r) => r.deliverableId === o.deliverableId && r.slot === o.slot);
        const approved = [...rs].reverse().find((r) => r.status === "APPROVED") ?? null;
        const cv = monthVideos.find((v) => v.outputId === o.id) ?? null;
        const name = quoteT(o.title ?? cv?.title ?? approved?.fileName, `Video ${o.slot}`);
        if (approved) missing.push(`${name} was approved on ${etDate(approved.decidedAt ?? approved.createdAt)} and is not published to the library`);
        else if (rs.length) missing.push(`${name} has a cut but none approved yet`);
        else missing.push(`${name} has no cut yet`);
      }
    }
    for (const p of mine) {
      if (!p.aryeoListingId) continue;
      const cache = caches.get(p.aryeoListingId);
      if (!cache) {
        if (short > 0) missing.push(`the listing for ${(p.title ?? "").split(",")[0].trim() || "this month's job"} was not read recently, so its videos were not compared`);
        continue;
      }
      const reported = new Set((cache.repoints ?? []).map((r) => r.to).filter(Boolean));
      for (const v of cache.videos) {
        if (!v.id || !v.file) continue;
        const k = `aryeo:${p.aryeoListingId}:${v.id}`;
        if (reported.has(k)) continue; // said once, as the re-edit below
        if (!libraryKeys.has(k)) missing.push(`${quoteT(v.title, "A video")} is on the Aryeo listing but not in the library`);
        else if (!linkedKeys.has(k)) missing.push(`${quoteT(v.title, "A video")} is on the Aryeo listing but not on the client's library page yet`);
      }
      for (const r of cache.repoints ?? []) {
        if (r.action === "would-repoint" || r.action === "would-retire") missing.push(`${quoteT(r.title, "A library video")} still plays the old file; the listing now has ${quoteT(r.toTitle, "a re-edit")} (re-point it, or turn on the library re-point switch)`);
        else if (r.action === "left-alone") missing.push(`${quoteT(r.title, "A library video")}: ${r.why}`);
      }
    }
    const lines = [...new Set(missing)];
    if (short === 0 && lines.length === 0) {
      if (was && !was.resolvedAt) {
        await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify({ ...was, resolvedAt: now.toISOString(), checkedAt: now.toISOString() }) } }).catch(() => {});
        out.resolved++;
      }
      continue;
    }
    if (short > 0) out.short++;
    const rec: LibraryShortRecord = {
      monthId: m.id, monthKey: m.monthKey, enrollmentId: m.enrollmentId, clientId: m.clientId, clientName: clientName.get(m.clientId) ?? "A program client",
      due: due.length, inLibrary: visible.length, short, missing: lines.slice(0, 12),
      firstSeenAt: was && !was.resolvedAt ? was.firstSeenAt : now.toISOString(), checkedAt: now.toISOString(), resolvedAt: null,
    };
    const value = JSON.stringify(rec);
    await prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedBy: "library-check" }, update: { value, updatedBy: "library-check" } });
    out.raised++;
  }
  return out;
}

/** The open "library short" records, for the exceptions board. Database only. */
export async function openLibraryShortRecords(opts: { excludeClientIds?: string[] } = {}): Promise<LibraryShortRecord[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: LIBRARY_SHORT_PREFIX } }, select: { value: true }, take: 500 });
  const excluded = new Set(opts.excludeClientIds ?? []);
  const out: LibraryShortRecord[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as LibraryShortRecord;
      if (!v.resolvedAt && !excluded.has(v.clientId)) out.push(v);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.short - a.short || a.firstSeenAt.localeCompare(b.firstSeenAt));
}
