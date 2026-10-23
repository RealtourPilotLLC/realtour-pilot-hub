import "server-only";
import { prisma } from "@/lib/prisma";
import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// IS THIS FILE THE ONE ON THE ARYEO LISTING? (audit C1, Oct 22 2026)
//
// 859 N Lawrence St: Jordan downloaded the revision at 21:40 UTC while its
// forced 1080p pass was still running, uploaded THAT (the editor's .mov,
// 114,597,798 bytes) to Aryeo at 21:41, and at 21:56 pressed "Mark as
// uploaded", which recorded the 1080p render's fingerprint (an .mp4 of
// 122,532,068 bytes saved at 21:52). The hub's record said the client had the
// processed file; the client had the original. Nothing compared the two.
//
// The comparison, for the file being recorded:
//   · WHEN: a listing video can only be this file if it went up (its Aryeo id
//     carries the moment, readyToSend.aryeoIdTime) at or after this file
//     existed: the render's save time for a 1080p file, the editor's upload
//     for their own export;
//   · SIZE: one HEAD request on the listing video's download link gives its
//     byte size, which must equal this file's (Dropbox's size of the 1080p
//     render, else the version's recorded size). Aryeo keeps the uploaded bytes
//     as they were: the 859 listing video is byte-for-byte the editor's .mov.
// A video on the listing that passes both is this file. When the listing has
// none that could be, it is a different file, and the receipt is refused in
// words. When a read fails (Aryeo, the HEAD, Dropbox) nothing is concluded and
// nothing is refused: a provider being slow never blocks the office.
// ---------------------------------------------------------------------------

export type ListingVideoFact = { id: string; at: Date; sizeBytes: number | null };
export type RecordedFileFact = { readyAt: Date; sizeBytes: number | null; kind: "1080p" | "original" };
export type ListingFileVerdict = {
  verdict: "match" | "mismatch" | "unknown";
  message: string;
  /** the listing video that matched, when one did */
  mediaId?: string | null;
};

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB (${n.toLocaleString("en-US")} bytes)`;
const DIFFERENT = "The listing has a different file, for example the editor's original instead of the 1080p file. Upload this exact file to the Aryeo listing, then mark it uploaded.";

/** The verdict from what was read (pure). */
export function judgeListingFile(file: RecordedFileFact, videos: ListingVideoFact[], undated = 0): ListingFileVerdict {
  const fileWhen = `${file.kind === "1080p" ? "this 1080p file was saved" : "this version was uploaded"} (${etDateTime(file.readyAt)} ET)`;
  if (!videos.length) {
    return undated
      ? { verdict: "unknown", message: "The listing's videos carry no upload time the hub can read." }
      : { verdict: "mismatch", message: "The Aryeo listing shows no video yet. If you just uploaded it, give Aryeo a minute and press again." };
  }
  const newest = videos.reduce((a, b) => (a.at >= b.at ? a : b));
  // The exact bytes settle it, whatever the id's time says: Aryeo can replace
  // a video's file in place under an id older than this file.
  const same = file.sizeBytes != null ? videos.find((v) => v.sizeBytes === file.sizeBytes) : undefined;
  if (same) return { verdict: "match", message: "The listing has this exact file.", mediaId: same.id };
  const after = videos.filter((v) => v.at.getTime() >= file.readyAt.getTime());
  if (!after.length) {
    if (undated) return { verdict: "unknown", message: "A video on the listing carries no upload time the hub can read." };
    return { verdict: "mismatch", message: `The newest video on the Aryeo listing went up ${etDateTime(newest.at)} ET, before ${fileWhen}. ${DIFFERENT}` };
  }
  if (file.sizeBytes == null) return { verdict: "unknown", message: "This file's size could not be read, so only its time was checked." };
  if (after.every((v) => v.sizeBytes != null)) {
    const latest = after.reduce((a, b) => (a.at >= b.at ? a : b));
    return { verdict: "mismatch", message: `The newest video on the Aryeo listing is ${mb(latest.sizeBytes!)}; ${file.kind === "1080p" ? "the 1080p file" : "this version"} is ${mb(file.sizeBytes)}. ${DIFFERENT}` };
  }
  return { verdict: "unknown", message: "The listing video's size could not be read." };
}

/** The file a receipt for this version is about: its time and its size. Null = not readable. */
export async function recordedFileFact(submissionId: string): Promise<RecordedFileFact | null> {
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { createdAt: true, completedAt: true, sizeBytes: true, blobUrl: true, assetPath: true, finalPath: true, topazJob: { select: { state: true, finalPath: true, savedAt: true } } },
  });
  if (!sub) return null;
  const { dbx } = await import("@/lib/integrations/dropbox");
  // Bounded: Dropbox's own read retries for up to a minute, and a person is waiting on the press.
  const sizeOf = async (path: string | null | undefined) => (path
    ? ((await within(dbx<{ size?: number }>("files/get_metadata", { path }).catch(() => null), 5_000, null))?.size ?? null)
    : null);
  const j = sub.topazJob;
  if (j?.state === "done" && j.finalPath && j.savedAt) return { readyAt: j.savedAt, sizeBytes: await sizeOf(j.finalPath), kind: "1080p" };
  // The editor's own export: its recorded size, else Dropbox's.
  return {
    readyAt: sub.createdAt,
    sizeBytes: sub.sizeBytes ?? (sub.blobUrl ? null : await sizeOf(sub.assetPath ?? sub.finalPath)),
    kind: "original",
  };
}

type RawListing = { id?: string; videos?: unknown[] } | null;

/** `p`, or `fallback` once `ms` pass (the timer is cleared either way). */
export async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One HEAD on a listing video's download link: its byte size, or null. */
async function headSize(url: string | null): Promise<number | null> {
  if (!url || !/^https:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const n = Number(res.headers.get("content-length"));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The listing's videos with their upload time and (for those at or after `from`) their size. */
export async function listingVideoFacts(listing: RawListing, from: Date | null, max = 4): Promise<{ videos: ListingVideoFact[]; undated: number }> {
  const raw = Array.isArray(listing?.videos) ? (listing!.videos as Record<string, unknown>[]) : [];
  const { aryeoIdTime } = await import("@/lib/readyToSend");
  const dated = raw.flatMap((v) => {
    const id = typeof v?.id === "string" ? v.id : null;
    const at = aryeoIdTime(id);
    return id && at ? [{ id, at, url: typeof v.download_url === "string" ? v.download_url : null }] : [];
  });
  const newestFirst = [...dated].sort((a, b) => b.at.getTime() - a.at.getTime());
  const sized = new Set(newestFirst.filter((v) => !from || v.at.getTime() >= from.getTime()).slice(0, max).map((v) => v.id));
  // The HEADs together, each timed, so the press waits for the slowest one only.
  const videos: ListingVideoFact[] = await Promise.all(newestFirst.map(async (v) => ({ id: v.id, at: v.at, sizeBytes: sized.has(v.id) ? await headSize(v.url) : null })));
  return { videos, undated: raw.length - dated.length };
}

/**
 * Before a person's "Mark as uploaded" (or "Mark as delivered") is recorded:
 * does the job's Aryeo listing carry this version's exact file? One listing
 * read and at most a few HEADs, each timed. Reads only; never throws.
 */
export async function checkListingHasFile(submissionId: string, opts: { listing?: RawListing } = {}): Promise<ListingFileVerdict> {
  try {
    const cut = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { project: { select: { aryeoListingId: true } } } });
    const listingId = cut?.project.aryeoListingId;
    if (!listingId) return { verdict: "unknown", message: "No Aryeo listing is linked." };
    const file = await recordedFileFact(submissionId);
    if (!file) return { verdict: "unknown", message: "The version could not be read." };
    let listing = opts.listing;
    if (listing === undefined) {
      const { aryeoRequest } = await import("@/lib/integrations/aryeo");
      listing = await aryeoRequest<{ data: RawListing }>(`/listings/${listingId}`, { query: { include: "videos" }, timeoutMs: 6_000, attempts: 1 })
        .then((r) => r.data)
        .catch(() => undefined);
      if (listing === undefined) return { verdict: "unknown", message: "Aryeo could not be read just now." };
    }
    if (!listing || (listing.id && listing.id !== listingId)) return { verdict: "unknown", message: "Aryeo's listing is not this job's listing." };
    // The newest few, whatever their time: a size match on an older id is an
    // in-place replacement of the file, and still this file.
    const { videos, undated } = await listingVideoFacts(listing, null);
    return judgeListingFile(file, videos, undated);
  } catch (e) {
    return { verdict: "unknown", message: e instanceof Error ? e.message.slice(0, 160) : "The check failed." };
  }
}
