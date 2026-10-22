import "server-only";
import { prisma } from "@/lib/prisma";
import { LISTING_CHECK_ACTOR, recordUploaded } from "@/lib/deliveryUploads";
import { clientChangeRequestsFor, contestedSince, couldBe, readyToSend, videosOnListing, type UploadJob } from "@/lib/readyToSend";

// ---------------------------------------------------------------------------
// THE UPLOAD RECORDS ITSELF (Jordan, Oct 13 2026: "There should be a webhook
// that checks when something was delivered or uploaded").
//
// Aryeo sends no event when a video is uploaded to a listing, but every read of
// the listing names its videos, and each video's id carries the moment it went
// up. So when the listing check (the scheduled Aryeo sweep, a LISTING_DELIVERED
// webhook, or any other Aryeo event that reads the listing) sees a NEW video on
// a job's listing after the job's finished file was ready, it records the
// upload Kyle would otherwise have pressed "Mark as Uploaded" for: the same
// upload receipt (lib/deliveryUploads), written by "Aryeo listing check" and
// dated when the video went up.
//
// CONSERVATIVE BY DESIGN. It records only when the listing can answer the
// question by COUNT alone, and leaves the row for a person in every other case:
//   · every job on the listing is a listing job (no content-program job, no
//     video still in the 1080p pass, no upload already recorded and waiting);
//   · nothing else on the listing was delivered since the earliest file was
//     ready (that delivery's video could be among the new ones);
//   · the client has not reported a problem since the file was ready, and the
//     revision history could be read (the 322 N 62nd St rule);
//   · the number of videos that went up after the earliest file was ready is
//     EXACTLY the number of videos owed, and every one went up after every
//     owed file was ready and after any download of it;
//   · lengths agree wherever both are known; and when the listing already had
//     video on it before (a replacement), only a single owed video with a
//     measured length that matches is recorded;
//   · a person who undid or corrected an upload record has the last word.
// An upload receipt is not "sent": the row moves to "On Aryeo, waiting for
// delivery", and Aryeo's own LISTING_DELIVERED event (or the scheduled proof
// pass after it) settles the send. Nothing here reaches a client or writes to
// Aryeo.
// ---------------------------------------------------------------------------

type ListingRead = { id?: string; delivery_status?: string | null; videos?: unknown[] } | null;

export type ListingUploadCheck = {
  /** submission ids an upload receipt was written for */
  recorded: string[];
  /** dry run: the ids it WOULD record */
  wouldRecord: string[];
  /** projects whose card changed */
  projectIds: string[];
  /** one line for the log */
  note: string;
};

const SKEW_MS = 5 * 60_000;

export async function recordUploadsSeenOnListing(listingId: string, listing: ListingRead, opts: { dryRun?: boolean } = {}): Promise<ListingUploadCheck> {
  const none = (note: string): ListingUploadCheck => ({ recorded: [], wouldRecord: [], projectIds: [], note });
  if (!listing || (listing.id && listing.id !== listingId)) return none("no listing read to check");
  const raw = Array.isArray(listing.videos) ? listing.videos : [];
  const videos = videosOnListing(listing);
  // A video we cannot date could be any of them; a count with a hole in it is no count.
  if (videos.length !== raw.length) return none("a video on the listing carries no readable upload time — left for a person");
  if (!videos.length) return none("no video on the listing yet");

  const projects = await prisma.project.findMany({ where: { aryeoListingId: listingId }, select: { id: true, contentMonthId: true } });
  if (!projects.length) return none("no job is linked to this listing");
  if (projects.some((p) => p.contentMonthId)) return none("a content-program job shares this listing — left for a person");
  const projectIds = projects.map((p) => p.id);

  const boards = await Promise.all(projectIds.map((projectId) => readyToSend({ projectId, recordFollowUpHealth: false, includeNoticeIncidents: false })));
  const rows = boards.flatMap((b) => b.ready);
  if (!rows.length) return none("nothing on the card for this listing");
  if (boards.some((b) => b.rendering.length > 0)) return none("a video on this listing is still in the 1080p pass — left for a person");
  if (rows.some((r) => r.deliveryDestination === "client-portal" || (!r.deliveryDestination && r.monthlyProgram))) return none("a portal video is on this listing — left for a person");
  if (rows.some((r) => r.uploaded)) return none("an upload is already recorded here and waiting for Aryeo's delivery");
  if (rows.some((r) => r.listingMissing || !r.uploadFingerprint)) return none("a video here has no exact finished file to record — left for a person");

  const subs = await prisma.reviewSubmission.findMany({
    where: { id: { in: rows.map((r) => r.submissionId) } },
    select: { id: true, decidedAt: true, completedAt: true, createdAt: true, downloadedAt: true, topazJob: { select: { savedAt: true, sourceDurationSec: true } } },
  });
  const owed = rows.flatMap((r) => {
    const s = subs.find((x) => x.id === r.submissionId);
    if (!s) return [];
    const approvedAt = s.decidedAt ?? s.completedAt ?? s.createdAt;
    // The same floor the card and the proof pass use (claimantOf): the filed
    // 1080p file when there is one, else the approval.
    const job: UploadJob = { id: s.id, readyAt: s.topazJob?.savedAt ?? approvedAt, durationSec: s.topazJob?.sourceDurationSec ?? null };
    return [{ row: r, job, downloadedAt: s.downloadedAt }];
  });
  if (owed.length !== rows.length) return none("a video here could not be read — left for a person");

  const floor = new Date(Math.min(...owed.map((o) => o.job.readyAt.getTime())));
  const latestReady = Math.max(...owed.map((o) => o.job.readyAt.getTime()));
  const settledSince = await prisma.reviewSubmission.count({
    where: { projectId: { in: projectIds }, status: "APPROVED", OR: [{ sentToClientAt: { gte: floor } }, { topazJob: { is: { deliveredAt: { gte: floor } } } }] },
  });
  if (settledSince > 0) return none("another video on this listing was delivered since these files were ready — left for a person");

  const asks = await clientChangeRequestsFor(projectIds);
  if (!asks.known) return none("the client's revision history could not be read — left for a person");
  if (owed.some((o) => contestedSince(asks.all, o.job.readyAt))) return none("the client reported a problem since the file was ready — left for a person to play it");

  const newer = videos.filter((v) => v.at.getTime() > floor.getTime());
  if (!newer.length) return none("no new video on the listing since the file was ready");
  if (newer.length !== owed.length) return none(`${newer.length} new video${newer.length === 1 ? "" : "s"} on the listing for ${owed.length} owed — left for a person`);
  if (newer.some((v) => v.at.getTime() < latestReady || v.at.getTime() > Date.now() + SKEW_MS)) return none("a new video went up before one of these files was ready — left for a person");
  const lastDownload = Math.max(0, ...owed.map((o) => o.downloadedAt?.getTime() ?? 0));
  if (newer.some((v) => v.at.getTime() < lastDownload)) return none("a file was downloaded after the new video went up — left for a person");
  if (!owed.every((o) => newer.some((v) => couldBe(o.job, v))) || !newer.every((v) => owed.some((o) => couldBe(o.job, v)))) {
    return none("the new video's length doesn't match what is owed — left for a person");
  }
  // A REPLACEMENT (the listing already carried video before these files were
  // ready): the next upload is as likely a re-upload of the wrong export as the
  // fix, so only a measured length that matches is enough (308 W Upsal St).
  if (videos.length > newer.length) {
    const [only] = owed;
    if (owed.length !== 1 || only.job.durationSec == null || newer[0].durationSec == null) return none("the listing already had video on it, and the new one can't be matched by length — left for a person");
  }

  // THE SAME BYTES (audit C1, Oct 22 2026): one HEAD per new listing video
  // gives its size, which must match the finished files owed (the 1080p
  // render's Dropbox size, else the version's own). 859 N Lawrence St's
  // listing carried the editor's original while the hub recorded the 1080p
  // file. A size that differs leaves it for a person, said in the log; a size
  // that could not be read changes nothing.
  {
    const { recordedFileFact, listingVideoFacts } = await import("@/lib/listingFileMatch");
    const read = await listingVideoFacts(listing, floor, newer.length);
    const listed = newer.map((v) => read.videos.find((x) => x.id === v.id)?.sizeBytes ?? null);
    const files = (await Promise.all(owed.map((o) => recordedFileFact(o.row.submissionId).catch(() => null)))).map((f) => f?.sizeBytes ?? null);
    if (listed.every((n) => n != null) && files.every((n) => n != null)) {
      const key = (xs: (number | null)[]) => [...xs].sort((a, b) => a! - b!).join(",");
      if (key(listed) !== key(files)) {
        console.warn(`[aryeo] listing ${listingId}: the new video's size (${listed.join(", ")} bytes) is not the finished file's (${files.join(", ")} bytes)`);
        return none("the video on the listing is a different file from the finished one (its size differs) — left for a person");
      }
    }
  }

  const ids = owed.map((o) => o.row.submissionId);
  if (opts.dryRun) return { recorded: [], wouldRecord: ids, projectIds: [], note: `WOULD record ${ids.length} upload${ids.length === 1 ? "" : "s"} seen on the listing` };
  const uploadedAt = newer[newer.length - 1].at;
  const mediaIds = newer.map((v) => v.id);
  const recorded: string[] = [];
  const touched = new Set<string>();
  for (const o of owed) {
    const r = await recordUploaded(o.row.submissionId, { id: null, name: LISTING_CHECK_ACTOR }, o.row.uploadFingerprint!, { uploadedAt, mediaIds }).catch(() => null);
    if (r?.ok) { recorded.push(o.row.submissionId); touched.add(o.row.projectId); }
  }
  return {
    recorded, wouldRecord: [], projectIds: [...touched],
    note: recorded.length ? `recorded ${recorded.length} upload${recorded.length === 1 ? "" : "s"} seen on the Aryeo listing` : "could not record the uploads seen on the listing — left for a person",
  };
}
