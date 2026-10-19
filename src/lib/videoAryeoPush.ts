import "server-only";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { videoDeliverySettings, type VideoPushMode } from "@/lib/videoDeliverySettings";
import type { HoldingAsk } from "@/lib/clientAsks";
import type { FinalSoundCheck } from "@/lib/finalRendition";
import type { UploadReceipt } from "@/lib/deliveryUploads";

// ---------------------------------------------------------------------------
// LISTING VIDEOS INTO ARYEO, BY THE HUB (Oct 19 2026).
//
// Jordan: "We should be able to send the videos just like we send the photos
// to Aryeo. Any videos that get approved should be uploaded and delivered once
// approved and back from Topaz. Once it's back from Topaz, it should
// automatically get uploaded to Aryeo and then delivered, with the login
// retries and things like that." The Review Room approval IS the person's
// approval for a video (for video only, it replaces the Oct 15 photo rule
// "Kyle approves every Aryeo delivery"). Monthly and personal-branding videos
// go to the client's portal and are never touched here.
//
// ONE RUN PER APPROVED CUT, kept in AppSetting "video_aryeo_push:<cut id>",
// moved on by the 1080p cron (driveVideoPushes) a step at a time, one driver at
// a time (compare-and-swap + a 45 s lease), the same shape as the photo push
// (lib/photoDelivery/aryeoPush.ts) and through the same Aryeo login
// (integrations/aryeoWeb.ts: one session, signs in again when Aryeo drops it,
// and a change Aryeo may already have made is NEVER sent twice):
//
//   PREPARING   every gate below, fresh; the file's size from Dropbox; what the
//               listing already shows (the public API), so the new video can
//               be told apart; which earlier video of OURS it replaces
//   SENDING     the 1080p file to Aryeo's video upload service: Uploadcare
//               fetches it from a temporary Dropbox link (from_url), or, when
//               that is refused, the hub sends it in 5 MB parts across as
//               many cron passes as it takes (a 345 MB file is 69 parts)
//   ADDING      the intent is saved FIRST, then the Add Video call goes once.
//               A pass that died around it, or Aryeo signing the hub out in
//               the middle, never sends it again: the check decides
//   CHECKING    the public API must show a NEW video (not there before, made
//               after the add), the file's length, playable; Aryeo converts in
//               the background, so up to an hour. Then the upload receipt is
//               written (the hub as the uploader, with the video's id)
//   REPLACING   a revision: the hub's OWN earlier video of this same video
//               comes off (never one somebody else put there)
//   WAITING     upload only: on the listing, Kyle presses Deliver now. Also
//               the short automatic waits before a delivery (another video of
//               the job still on its way, photos going up on the listing, a
//               delivery minutes ago)
//   DELIVERING  the gates again, then Aryeo's own Re-deliver, ONCE per
//               listing even when a job owes several videos
//   CONFIRMING  the video is still on the listing; markVideoSent (which closes
//               the 1080p job and Kyle's upload task) and the client notice
//   DONE | FAILED (with Aryeo's words; a sign-in failure is retried after 30
//               minutes) | HELD (why, in plain words) | SHADOW (practice run)
//
// THE GATES. Before the upload: the switch, the hub's Aryeo login, the listing
// linked, the cut still the current approved version, a checked 1080p file
// (Topaz done and verified, never held or unchecked), the final file's sound
// (finalRendition.finalFileSoundCheck: a hold holds, an unread check does
// not), no open client ask on the job (lib/clientAsks; a failed read holds),
// not a program video, the job not on hold. Every listing is already delivered
// (photos first), so a video on it is visible to the client at once: the asks
// gate runs BEFORE the upload, not only before the delivery. Before the
// delivery: the same, the file's fingerprint unchanged, every video of the job
// that is on its way on the listing, no photo push sending or waiting on the
// same listing, and a few minutes since the listing's last delivery.
// ---------------------------------------------------------------------------

const KEY = (submissionId: string) => `video_aryeo_push:${submissionId}`;
const DELIVER_KEY = (listingId: string) => `video_aryeo_deliver:${listingId}`;
const PREFIX = "video_aryeo_push:";
const LEASE_MS = 45_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const CHECK_FOR_MS = 60 * MIN;
const FROM_URL_FOR_MS = 30 * MIN;
const READY_FOR_MS = 15 * MIN;
const SIBLING_WAIT_MS = 2 * HOUR;
const DURATION_SLACK_SEC = 2;
const SKEW_MS = 5 * MIN;

/** Who the upload receipt names (the card reads "Uploaded by the hub"). */
export const HUB_UPLOAD_ACTOR = "the hub";
/** Who markVideoSent names. Starts with "Aryeo": the per-video row records the channel as the listing. */
export const HUB_SENT_BY = "Aryeo (delivered by the hub)";

export type VideoPushState =
  | "SHADOW" | "PREPARING" | "SENDING" | "ADDING" | "CHECKING" | "REPLACING"
  | "WAITING" | "DELIVERING" | "CONFIRMING" | "HELD" | "DONE" | "FAILED";
const ACTIVE: VideoPushState[] = ["PREPARING", "SENDING", "ADDING", "CHECKING", "REPLACING", "DELIVERING", "CONFIRMING"];
/** States a pass may move (HELD and WAITING look again when their time comes). */
const MOVABLE: VideoPushState[] = [...ACTIVE, "HELD", "WAITING"];
/** Before the video is on the listing: a run here is "on its way". */
const BEFORE_LISTING: VideoPushState[] = ["PREPARING", "SENDING", "ADDING", "CHECKING"];

export type HoldGate = "asks" | "sound" | "job-hold" | "listing" | "manual";
export type WaitGate = "kyle" | "siblings" | "photos" | "cooldown";

export type VideoPushRun = {
  id: string;
  submissionId: string;
  projectId: string;
  listingId: string;
  topazJobId: string | null;
  state: VideoPushState;
  fingerprint: string | null;
  file: { path: string; name: string; size: number | null; durationSec: number | null; contentType: string };
  title: string;
  upload: {
    method: "from_url" | "multipart" | null;
    token: string | null;
    fromUrlAt: string | null;
    /** Why Uploadcare would not fetch the link (the multipart upload took over). */
    fromUrlRefused: string | null;
    mpUuid: string | null;
    /** Signed part addresses: server-side only, never rendered. */
    parts: string[];
    partsDone: number;
    mpStartedAt: string | null;
    fileUuid: string | null;
    fileAt: string | null;
    tries: number;
  };
  /** The listing's video ids (public API) before the add. */
  before: string[] | null;
  addSentAt: string | null;
  addedAt: string | null;
  mediaId: string | null;
  mediaAt: string | null;
  /** The hub's own earlier videos of this same video, to take off once the new one is up. */
  replace: { mediaId: string; submissionId: string }[];
  /** When the delete of those went to Aryeo (never sent twice). */
  replaceSentAt: string | null;
  replacedAt: string | null;
  /** An earlier version went up by hand: not ours to remove, so the delivery waits for a person. */
  handUploadedBefore: boolean;
  /** A person pressed Deliver now (skips the waits for another video and the cooldown, never a hold). */
  deliverNow: boolean;
  deliveredAt: string | null;
  deliveredBy: "hub" | "earlier" | null;
  /** Aryeo signed the hub out during Deliver: whether the email went is not known. Never re-sent. */
  deliverUncertain: boolean;
  /** The sound check passed (or could not run) for this fingerprint: not read again on every recheck. */
  soundCheckedFp: string | null;
  hold: { gate: HoldGate; why: string; by: string | null; at: string; resume: VideoPushState } | null;
  wait: { gate: WaitGate; why: string; since: string } | null;
  recheckAt: string | null;
  /** An earlier run's add that was never confirmed: the listing is checked before anything is sent again. */
  priorAdd: { sentAt: string; before: string[] } | null;
  by: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  note: string | null;
  /** The last line written to the job's timeline (one line per change, never a repeat). */
  logged: string | null;
  lease: { token: string; until: number } | null;
  retryAfter: string | null;
  /** A Dropbox or network blip: the next pass after this tries again (3 at most). */
  pauseUntil: string | null;
  errors: number;
  /** The switch when the run started (a practice run says SHADOW). */
  mode: VideoPushMode;
};

// ---- drills ---------------------------------------------------------------------------------

type Hooks = {
  openAsks?: (projectId: string) => Promise<HoldingAsk[]>;
  soundCheck?: (submissionId: string) => Promise<FinalSoundCheck>;
  sleep?: (ms: number) => Promise<void>;
  /** How many parts one pass may send (a cron pass runs out of time; drills show the resume). */
  partsPerPass?: number;
};
let hooks: Hooks = {};
/** Drills only. */
export function __setVideoPushHooksForTests(h: Hooks | null) {
  hooks = h ?? {};
}
const sleep = (ms: number) => (hooks.sleep ? hooks.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));

// ---- the run record -------------------------------------------------------------------------

async function load(submissionId: string): Promise<{ run: VideoPushRun | null; raw: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(submissionId) }, select: { value: true } });
  if (!row) return { run: null, raw: null };
  try {
    return { run: JSON.parse(row.value) as VideoPushRun, raw: row.value };
  } catch {
    return { run: null, raw: row.value };
  }
}

async function save(submissionId: string, run: VideoPushRun, prevRaw: string | null): Promise<string | null> {
  const value = JSON.stringify({ ...run, updatedAt: new Date().toISOString() });
  if (prevRaw == null) {
    try {
      await prisma.appSetting.create({ data: { key: KEY(submissionId), value, updatedBy: "video-aryeo-push" } });
      return value;
    } catch {
      return null;
    }
  }
  const r = await prisma.appSetting.updateMany({ where: { key: KEY(submissionId), value: prevRaw }, data: { value, updatedBy: "video-aryeo-push" } });
  return r.count === 1 ? value : null;
}

/** Every run, by cut (the board's read: one query). */
export async function runsFor(submissionIds: string[]): Promise<Map<string, VideoPushRun>> {
  const out = new Map<string, VideoPushRun>();
  if (!submissionIds.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: submissionIds.map(KEY) } }, select: { key: true, value: true } });
  for (const r of rows) {
    try {
      out.set(r.key.slice(PREFIX.length), JSON.parse(r.value) as VideoPushRun);
    } catch { /* an unreadable record reads as no run */ }
  }
  return out;
}

export async function videoPushRun(submissionId: string): Promise<VideoPushRun | null> {
  return (await load(submissionId)).run;
}

// ---- what the gates read --------------------------------------------------------------------

const CUT_SELECT = {
  id: true, projectId: true, status: true, round: true, deliverableId: true, slot: true, fileName: true, sentToClientAt: true, sentToClientBy: true, decidedAt: true,
  deliverable: { select: { label: true, productTitle: true, type: true } },
  project: { select: { id: true, title: true, status: true, contentMonthId: true, aryeoListingId: true } },
  topazJob: { select: { id: true, state: true, finalPath: true, savedAt: true, outputCheck: true, outputCheckJson: true, sourceDurationSec: true, sourceSizeBytes: true } },
} as const;

type Verdict =
  | { ok: true; fingerprint: string; listingId: string; projectId: string; topazJobId: string; path: string; durationSec: number | null; approxBytes: number | null; note: string | null }
  | { ok: false; kind: "sent"; why: string }
  | { ok: false; kind: "never" | "manual" | "stale" | "not-yet"; why: string }
  | { ok: false; kind: "hold"; gate: HoldGate; why: string };

const VERIFIED = new Set(["verified", "resolved-processed"]);
const RECHECK: Record<HoldGate, number> = { asks: 10 * MIN, sound: HOUR, "job-hold": 30 * MIN, listing: 30 * MIN, manual: 0 };

function heldReason(json: string | null): string | null {
  try {
    const c = json ? (JSON.parse(json) as { verdict?: string; reason?: string | null }) : null;
    return c?.reason ? String(c.reason) : null;
  } catch {
    return null;
  }
}

/**
 * Every gate, in order, cheapest first. `asks` and `sound` are the two that
 * read outside the cut's own rows (the client-asks table; the file's header).
 */
async function gates(submissionId: string, opts: { asks: boolean; sound: boolean; soundCheckedFp?: string | null }): Promise<Verdict> {
  const cut = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: CUT_SELECT });
  if (!cut) return { ok: false, kind: "never", why: "That video no longer exists." };
  if (cut.project.contentMonthId) return { ok: false, kind: "never", why: "A content-program video: it goes to the client's portal, never to Aryeo by the hub." };
  if (cut.sentToClientAt) return { ok: false, kind: "sent", why: `Delivered${cut.sentToClientBy ? ` (recorded by ${cut.sentToClientBy})` : ""}.` };
  if (cut.status !== "APPROVED") return { ok: false, kind: "stale", why: "This version is no longer approved, so the hub stopped." };
  if (cut.project.status === "CANCELLED") return { ok: false, kind: "never", why: "The job was cancelled." };
  if (cut.project.status === "ON_HOLD") return { ok: false, kind: "hold", gate: "job-hold", why: "The job is on hold. It goes once the hold is released." };
  const { loadCut, currentApproved, sourceFingerprint } = await import("@/lib/finalRendition");
  const full = await loadCut(submissionId);
  if (!full || !(await currentApproved(full))) return { ok: false, kind: "stale", why: "A newer version of this video replaced this one, so the hub stopped." };
  const { usesAryeoDelivery } = await import("@/lib/videoDeliveryDestination");
  if (!(await usesAryeoDelivery(full))) return { ok: false, kind: "never", why: "This video does not go to Aryeo." };
  if (!cut.project.aryeoListingId) return { ok: false, kind: "hold", gate: "listing", why: "This job has no Aryeo listing linked yet. Open the job and press Refresh from Aryeo." };
  const j = cut.topazJob;
  if (!j) return { ok: false, kind: "manual", why: "No 1080p pass ran for this video, so the hub does not send it on its own. Upload it by hand." };
  if (j.state === "held") {
    const reason = heldReason(j.outputCheckJson);
    return { ok: false, kind: "hold", gate: "sound", why: `Sound check held this file${reason ? `: ${reason}` : ": its sound could not be checked"}. Listen to it on the delivery queue.` };
  }
  if (j.state === "failed" || j.state === "skipped" || j.state === "cancelled") return { ok: false, kind: "manual", why: "The 1080p pass did not produce a file. Upload the editor's export by hand." };
  if (j.state !== "done" || !j.finalPath || !j.savedAt) return { ok: false, kind: "not-yet", why: "The 1080p pass has not finished yet." };
  if (!VERIFIED.has(j.outputCheck ?? "")) {
    if (j.outputCheck === "unverified") return { ok: false, kind: "hold", gate: "sound", why: "Sound check held this file: it was never confirmed. Listen to it on the delivery queue." };
    if (j.outputCheck === "resolved-original") return { ok: false, kind: "manual", why: "A reviewer kept the editor's original, so the hub does not send it on its own. Upload it by hand." };
    return { ok: false, kind: "manual", why: "The 1080p file was never checked, so the hub does not send it on its own. Upload it by hand." };
  }
  const fingerprint = sourceFingerprint(full);
  if (!fingerprint) return { ok: false, kind: "not-yet", why: "The finished file is not ready yet." };
  if (opts.asks) {
    let asks: HoldingAsk[];
    try {
      asks = hooks.openAsks ? await hooks.openAsks(cut.projectId) : await import("@/lib/clientAsks").then((m) => m.openAsksHolding(cut.projectId, "video"));
    } catch {
      // A read that failed is never permission to send (the A02 lesson).
      return { ok: false, kind: "hold", gate: "asks", why: "The client's open asks could not be read just now, so the hub is holding it." };
    }
    if (asks.length) {
      const first = asks[0].summary.replace(/\s+/g, " ").trim();
      return { ok: false, kind: "hold", gate: "asks", why: `Waiting on Kyle to confirm ${asks.length} client ask${asks.length === 1 ? "" : "s"}${first ? ` ("${first.slice(0, 120)}")` : ""}.` };
    }
  }
  let note: string | null = null;
  if (opts.sound && opts.soundCheckedFp !== fingerprint) {
    const s = hooks.soundCheck ? await hooks.soundCheck(submissionId) : await import("@/lib/finalRendition").then((m) => m.finalFileSoundCheck(submissionId));
    if (s.verdict === "hold") return { ok: false, kind: "hold", gate: "sound", why: `Sound check held this file: ${s.reason}. Ask the editor for a new export.` };
    if (s.verdict === "unchecked") note = s.message;
  }
  return {
    ok: true, fingerprint, listingId: cut.project.aryeoListingId, projectId: cut.projectId, topazJobId: j.id, path: j.finalPath,
    durationSec: j.sourceDurationSec ?? null, approxBytes: j.sourceSizeBytes ?? null, note,
  };
}

/** What Aryeo's public API shows on the listing (null = it could not be read just now). */
type ListedVideo = { id: string; at: Date | null; durationSec: number | null; playable: boolean; title: string | null };
async function listedVideos(listingId: string): Promise<ListedVideo[] | null> {
  const { getListingMedia } = await import("@/lib/integrations/aryeo");
  const { aryeoIdTime } = await import("@/lib/readyToSend");
  const m = await getListingMedia(listingId);
  if (!m) return null;
  return m.videos.filter((v): v is typeof v & { id: string } => !!v.id).map((v) => ({ id: v.id, at: aryeoIdTime(v.id), durationSec: typeof v.duration === "number" ? v.duration : null, playable: !!(v.playback || v.download), title: v.title }));
}

const durationMatches = (want: number | null, got: number | null) => want == null || (got != null && Math.abs(want - got) <= DURATION_SLACK_SEC);

async function tempLink(path: string): Promise<{ link: string; size: number | null }> {
  const { dbx } = await import("@/lib/integrations/dropbox");
  const r = await dbx<{ link?: string; metadata?: { size?: number } }>("files/get_temporary_link", { path });
  if (!r.link) throw new Error("Dropbox did not give a link to the 1080p file.");
  return { link: r.link, size: typeof r.metadata?.size === "number" ? r.metadata.size : null };
}

async function readRange(link: string, start: number, end: number): Promise<Uint8Array> {
  const res = await fetch(link, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(120_000) });
  if (res.status !== 206 && res.status !== 200) throw new Error(`Dropbox answered ${res.status} for a part of the 1080p file.`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const want = end - start + 1;
  // A 200 is the whole file (a server that ignored the range): take the slice.
  const part = res.status === 200 ? buf.subarray(start, end + 1) : buf;
  if (part.length !== want) throw new Error(`Dropbox handed back ${part.length} bytes of a ${want}-byte part.`);
  return part;
}

const contentTypeOf = (name: string) => (/\.mov$/i.test(name) ? "video/quicktime" : "video/mp4");
const mb = (bytes: number | null) => (bytes == null ? null : Math.max(1, Math.round(bytes / 1_000_000)));

/** The hub's own earlier videos of this same video on the listing (a revision replaces them). */
async function ownEarlierVideos(submissionId: string, listingId: string): Promise<{ replace: { mediaId: string; submissionId: string }[]; handUploadedBefore: boolean }> {
  const cut = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true, deliverableId: true, slot: true, assetPath: true, round: true } });
  if (!cut) return { replace: [], handUploadedBefore: false };
  const earlier = await prisma.reviewSubmission.findMany({
    where: {
      projectId: cut.projectId, id: { not: submissionId },
      ...(cut.deliverableId ? { deliverableId: cut.deliverableId, slot: cut.slot } : { deliverableId: null, assetPath: cut.assetPath }),
    },
    select: { id: true, sentToClientAt: true },
  });
  if (!earlier.length) return { replace: [], handUploadedBefore: false };
  const runs = await runsFor(earlier.map((e) => e.id));
  const replace: { mediaId: string; submissionId: string }[] = [];
  let hand = false;
  for (const e of earlier) {
    const r = runs.get(e.id);
    if (r?.mediaId && r.listingId === listingId) replace.push({ mediaId: r.mediaId, submissionId: e.id });
    else if (e.sentToClientAt) hand = true;
  }
  return { replace, handUploadedBefore: hand && !replace.length };
}

/** The video's title on the listing (the client sees it): the product's own
 *  video name when it has one ("Cinematic Video"), else the Review Room's. */
async function titleFor(submissionId: string, projectId: string): Promise<string> {
  const own = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { deliverable: { select: { productTitle: true } } } });
  const product = own?.deliverable?.productTitle?.trim();
  if (product && /video|reel|cinematic|walk-?through|tour/i.test(product) && product.length <= 80) return product;
  try {
    const { videoStatesFor } = await import("@/lib/reviewCuts");
    const states = await videoStatesFor([projectId]);
    const c = states.get(projectId)?.cuts.find((x) => x.submissionId === submissionId);
    if (c?.cutLabel && !/\.(mp4|mov)$/i.test(c.cutLabel)) return c.cutLabel.slice(0, 120);
  } catch { /* the plain name below */ }
  const d = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { deliverable: { select: { productTitle: true, label: true } } } });
  return (d?.deliverable?.productTitle ?? d?.deliverable?.label ?? "Listing Video").slice(0, 120);
}

// ---- the listing: other deliveries, photo pushes, sibling videos -----------------------------

type ListingDelivery = { state: "sending" | "sent" | "uncertain" | "refused"; at: string; submissionId: string; runId: string };

async function listingDelivery(listingId: string): Promise<{ rec: ListingDelivery | null; raw: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: DELIVER_KEY(listingId) }, select: { value: true } });
  if (!row) return { rec: null, raw: null };
  try {
    return { rec: JSON.parse(row.value) as ListingDelivery, raw: row.value };
  } catch {
    return { rec: null, raw: row.value };
  }
}

async function saveListingDelivery(listingId: string, rec: ListingDelivery, prevRaw: string | null): Promise<boolean> {
  const value = JSON.stringify(rec);
  if (prevRaw == null) {
    try {
      await prisma.appSetting.create({ data: { key: DELIVER_KEY(listingId), value, updatedBy: "video-aryeo-push" } });
      return true;
    } catch {
      return false;
    }
  }
  const r = await prisma.appSetting.updateMany({ where: { key: DELIVER_KEY(listingId), value: prevRaw }, data: { value, updatedBy: "video-aryeo-push" } });
  return r.count === 1;
}

const PHOTO_BUSY = ["PREPARING", "SENDING", "ADDING", "CHECKING", "ORDERING", "DELIVERING", "CONFIRMING", "WAITING"];

/** Photo pushes on this listing: one sending or waiting, and the deliveries they made. */
async function photoPushesOn(listingId: string): Promise<{ busy: boolean; waitingForKyle: boolean; deliveries: Date[] }> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: "photo_aryeo_push:" }, value: { contains: `"listingId":${JSON.stringify(listingId)}` } }, select: { value: true } });
  let busy = false;
  let waitingForKyle = false;
  const deliveries: Date[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(r.value) as { listingId?: string; state?: string; deliveredAt?: string | null; updatedAt?: string };
      if (p.listingId !== listingId) continue;
      // A photo run nobody has touched for a day (or a stuck one, two hours) does not hold a video back.
      const age = Date.now() - (Date.parse(p.updatedAt ?? "") || 0);
      const fresh = p.state === "WAITING" ? age < 24 * HOUR : age < 2 * HOUR;
      if (p.state && PHOTO_BUSY.includes(p.state) && fresh) {
        busy = true;
        if (p.state === "WAITING") waitingForKyle = true;
      }
      if (p.deliveredAt && Number.isFinite(Date.parse(p.deliveredAt))) deliveries.push(new Date(p.deliveredAt));
    } catch { /* skip */ }
  }
  return { busy, waitingForKyle, deliveries };
}

/** Every delivery of this listing the hub knows of: its own video deliveries, photo pushes, Aryeo's signed events. */
async function listingDeliveries(listingId: string): Promise<{ at: Date; uncertain: boolean }[]> {
  const out: { at: Date; uncertain: boolean }[] = [];
  const { rec } = await listingDelivery(listingId);
  if (rec && (rec.state === "sent" || rec.state === "uncertain")) out.push({ at: new Date(rec.at), uncertain: rec.state === "uncertain" });
  for (const at of (await photoPushesOn(listingId)).deliveries) out.push({ at, uncertain: false });
  const { deliveryOccurrences } = await import("@/lib/deliveryUploads");
  for (const o of await deliveryOccurrences(listingId).catch(() => [])) if (o.source === "aryeo-event") out.push({ at: o.at, uncertain: false });
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Other videos of this listing's listing jobs that are on their way to it (so the client gets one email). */
async function siblingsOnTheWay(r: VideoPushRun): Promise<string[]> {
  const projects = await prisma.project.findMany({ where: { aryeoListingId: r.listingId, contentMonthId: null, status: { notIn: ["CANCELLED", "ON_HOLD"] } }, select: { id: true } });
  if (!projects.length) return [];
  const subs = await prisma.reviewSubmission.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, status: "APPROVED", sentToClientAt: null, id: { not: r.submissionId }, decidedAt: { gte: new Date(Date.now() - 6 * HOUR) } },
    select: { id: true, topazJob: { select: { state: true, outputCheck: true } } },
  });
  if (!subs.length) return [];
  const { loadCut, currentApproved } = await import("@/lib/finalRendition");
  const runs = await runsFor(subs.map((s) => s.id));
  const out: string[] = [];
  for (const s of subs) {
    const cut = await loadCut(s.id);
    if (!cut || !(await currentApproved(cut))) continue;
    const run = runs.get(s.id);
    const rendering = !!s.topazJob && !["done", "failed", "cancelled", "skipped", "held"].includes(s.topazJob.state);
    const startsSoon = !run && s.topazJob?.state === "done" && VERIFIED.has(s.topazJob.outputCheck ?? "");
    if (rendering || startsSoon || (run && BEFORE_LISTING.includes(run.state))) out.push(s.id);
  }
  return out;
}

// ---- starting one ---------------------------------------------------------------------------

function blank(submissionId: string, by: string, mode: VideoPushMode): VideoPushRun {
  const now = new Date().toISOString();
  return {
    id: randomBytes(4).toString("hex"), submissionId, projectId: "", listingId: "", topazJobId: null, state: "PREPARING", fingerprint: null,
    file: { path: "", name: "", size: null, durationSec: null, contentType: "video/mp4" }, title: "",
    upload: { method: null, token: null, fromUrlAt: null, fromUrlRefused: null, mpUuid: null, parts: [], partsDone: 0, mpStartedAt: null, fileUuid: null, fileAt: null, tries: 0 },
    before: null, addSentAt: null, addedAt: null, mediaId: null, mediaAt: null, replace: [], replaceSentAt: null, replacedAt: null, handUploadedBefore: false,
    deliverNow: false, deliveredAt: null, deliveredBy: null, deliverUncertain: false, soundCheckedFp: null,
    hold: null, wait: null, recheckAt: null, priorAdd: null, by, startedAt: now, updatedAt: now, finishedAt: null, note: null, logged: null, lease: null, retryAfter: null, pauseUntil: null, errors: 0, mode,
  };
}

async function log(projectId: string, body: string): Promise<void> {
  if (!projectId) return;
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: `Video to Aryeo: ${body}`.slice(0, 500) } }).catch(() => {});
}

/**
 * Start (or, in shadow mode, write down) a push for one approved cut. The cron
 * calls this for every approved listing video with a checked 1080p file;
 * Kyle's Retry calls it too. Refusals say why in plain words.
 */
export async function requestVideoPush(submissionId: string, opts: { by?: string; mode?: VideoPushMode } = {}): Promise<{ ok: boolean; started: boolean; message: string }> {
  const settings = await videoDeliverySettings();
  const mode = opts.mode ?? settings.aryeoPush;
  if (mode === "off") return { ok: false, started: false, message: "Sending videos to Aryeo is switched off (Video delivery settings)." };
  const by = opts.by ?? "hub";
  const { run: cur, raw } = await load(submissionId);
  if (cur && MOVABLE.includes(cur.state) && cur.state !== "HELD") return { ok: true, started: false, message: "Already sending this video to Aryeo." };
  if (cur?.state === "HELD" && cur.hold?.gate === "manual") return { ok: false, started: false, message: `Held by ${cur.hold.by ?? "a person"}. Release it first.` };
  if (mode !== "shadow") {
    const { aryeoWebCredentials } = await import("@/lib/integrations/aryeoWeb");
    if (!(await aryeoWebCredentials().catch(() => null))) return { ok: false, started: false, message: "The hub's Aryeo login is not set up yet. Jordan adds it on Connections, Aryeo hub login." };
  }
  // Shadow reads only the hub's own rows (no Dropbox, no sound read).
  const g = await gates(submissionId, { asks: true, sound: false });
  const next = blank(submissionId, by, mode);
  // What an earlier run already did is carried, so nothing is sent twice.
  if (cur) {
    if (cur.mediaId && cur.fingerprint && g.ok && cur.fingerprint === g.fingerprint) {
      next.mediaId = cur.mediaId;
      next.mediaAt = cur.mediaAt;
      next.addSentAt = cur.addSentAt;
      next.addedAt = cur.addedAt;
      next.before = cur.before;
    } else if (cur.addSentAt && !cur.mediaId) next.priorAdd = { sentAt: cur.addSentAt, before: cur.before ?? [] };
    else if (cur.priorAdd && !cur.mediaId) next.priorAdd = cur.priorAdd;
    next.soundCheckedFp = cur.soundCheckedFp;
  }
  if (!g.ok && g.kind !== "hold") {
    // Delivered, not ready yet, or never the hub's (a program video): nothing is written.
    if (g.kind === "sent" || g.kind === "not-yet" || g.kind === "never") return { ok: g.kind === "sent", started: false, message: g.why };
    // Say why on the board; the cron looks again in an hour (a person may fix it meanwhile).
    const ids = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true, project: { select: { aryeoListingId: true } } } });
    const failed: VideoPushRun = { ...next, state: "FAILED", note: g.why, finishedAt: next.startedAt, retryAfter: g.kind === "stale" ? null : new Date(Date.now() + HOUR).toISOString(), projectId: ids?.projectId ?? "", listingId: ids?.project.aryeoListingId ?? "", logged: `stopped. ${g.why}` };
    if (await save(submissionId, failed, raw)) {
      if (cur?.note !== g.why) await log(failed.projectId, `not sent by the hub. ${g.why}`);
    }
    return { ok: false, started: false, message: g.why };
  }
  const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: submissionId }, select: { projectId: true, project: { select: { title: true, aryeoListingId: true } }, topazJob: { select: { id: true, finalPath: true, sourceDurationSec: true, sourceSizeBytes: true } } } });
  next.projectId = cut.projectId;
  next.listingId = cut.project.aryeoListingId ?? "";
  next.topazJobId = cut.topazJob?.id ?? null;
  next.file = { path: cut.topazJob?.finalPath ?? "", name: cut.topazJob?.finalPath?.split("/").pop() ?? "video.mp4", size: null, durationSec: cut.topazJob?.sourceDurationSec ?? null, contentType: contentTypeOf(cut.topazJob?.finalPath ?? "") };
  next.fingerprint = g.ok ? g.fingerprint : null;
  if (mode === "shadow") {
    const then = "then re-deliver the listing (Aryeo's own email to the client)";
    const size = mb(cut.topazJob?.sourceSizeBytes ?? null);
    const says = g.ok
      ? `Practice run: would upload ${size ? `about ${size} MB` : "the 1080p file"} (${next.file.name}) to the Aryeo listing for ${cut.project.title.split(",")[0].trim()}, ${then}. Nothing was sent.`
      : `Practice run: would hold it. ${g.why}`;
    const shadow: VideoPushRun = { ...next, state: "SHADOW", note: says, finishedAt: next.startedAt };
    if (cur?.state === "SHADOW" && cur.note === says && cur.fingerprint === shadow.fingerprint) return { ok: true, started: false, message: says };
    if (!(await save(submissionId, shadow, raw))) return { ok: false, started: false, message: "That changed a moment ago. Reload the page." };
    return { ok: true, started: true, message: says };
  }
  if (!g.ok) {
    // A hold the push itself re-checks (asks, the job on hold, no listing, the sound).
    const held: VideoPushRun = { ...next, state: "HELD", hold: { gate: g.gate, why: g.why, by: null, at: next.startedAt, resume: "PREPARING" }, note: g.why, recheckAt: new Date(Date.now() + RECHECK[g.gate]).toISOString() };
    if (cur?.state === "HELD" && cur.note === g.why) return { ok: false, started: false, message: g.why };
    if (!(await save(submissionId, { ...held, logged: `held. ${g.why}` }, raw))) return { ok: false, started: false, message: "That changed a moment ago. Reload the page." };
    await log(next.projectId, `held. ${g.why}`);
    return { ok: false, started: false, message: g.why };
  }
  if (!(await save(submissionId, next, raw))) return { ok: false, started: false, message: "Someone started it a moment ago." };
  await log(next.projectId, `${mode === "deliver" ? "uploading and delivering" : "uploading"} ${next.file.name} (approved, back from the 1080p pass).`);
  return { ok: true, started: true, message: mode === "deliver" ? "Sending it to the Aryeo listing, then re-delivering the listing." : "Sending it to the Aryeo listing. Press Deliver now when it is there." };
}

// ---- moving one on --------------------------------------------------------------------------

const fail = (r: VideoPushRun, note: string): VideoPushRun => ({ ...r, state: "FAILED", note: note.slice(0, 400), finishedAt: new Date().toISOString(), lease: null, wait: null, hold: null, recheckAt: null });
const done = (r: VideoPushRun, note: string | null): VideoPushRun => ({ ...r, state: "DONE", note, finishedAt: new Date().toISOString(), lease: null, wait: null, hold: null, recheckAt: null });
function holdRun(r: VideoPushRun, gate: HoldGate, why: string, resume: VideoPushState): VideoPushRun {
  return { ...r, state: "HELD", hold: { gate, why, by: null, at: new Date().toISOString(), resume }, note: why, recheckAt: new Date(Date.now() + RECHECK[gate]).toISOString() };
}
function waitRun(r: VideoPushRun, gate: WaitGate, why: string, recheckAt: Date | null): VideoPushRun {
  const since = r.wait?.gate === gate ? r.wait.since : new Date().toISOString();
  return { ...r, state: "WAITING", wait: { gate, why, since }, note: why, recheckAt: recheckAt ? recheckAt.toISOString() : null };
}

/** A gate verdict that is not ok, as the run's next state. `resume` is where a hold picks up again. */
function blocked(r: VideoPushRun, g: Exclude<Verdict, { ok: true }>, resume: VideoPushState): VideoPushRun {
  if (g.kind === "sent") return done(r, g.why);
  if (g.kind === "hold") return holdRun(r, g.gate, g.why, resume);
  if (g.kind === "not-yet") return { ...r, note: g.why };
  return fail(r, g.why);
}

/** After the video is on the listing: deliver, or wait for Kyle (upload only, or an earlier version put up by hand). */
async function afterUpload(r: VideoPushRun): Promise<VideoPushRun> {
  const s = await videoDeliverySettings();
  if (r.handUploadedBefore && !r.deliverNow) {
    return waitRun(r, "kyle", "On the Aryeo listing. An earlier version of this video went up by hand and is still there: remove it in Aryeo, then press Deliver now.", null);
  }
  if (s.aryeoPush === "deliver" || r.deliverNow) return { ...r, state: "DELIVERING", note: null, wait: null };
  return waitRun(r, "kyle", "On the Aryeo listing. Press Deliver now to send it to the client.", null);
}

type Ctx = { deadline: number };

async function step(r0: VideoPushRun, ctx: Ctx): Promise<VideoPushRun | null> {
  const r: VideoPushRun = JSON.parse(JSON.stringify(r0));
  const W = await import("@/lib/integrations/aryeoWeb");
  const now = Date.now();
  try {
    // ---- the two waiting states look again when their time comes
    if (r.state === "HELD") {
      if (!r.hold || r.hold.gate === "manual") return null;
      if (r.recheckAt && Date.parse(r.recheckAt) > now) return null;
      return { ...r, state: r.hold.resume, hold: null, recheckAt: null };
    }
    if (r.state === "WAITING") {
      // Somebody marked it sent meanwhile (Kyle delivered in Aryeo by hand): nothing left to do.
      const sent = await prisma.reviewSubmission.findUnique({ where: { id: r.submissionId }, select: { sentToClientAt: true, sentToClientBy: true } });
      if (sent?.sentToClientAt) return done(r, `Delivered (recorded by ${sent.sentToClientBy ?? "a person"}).`);
      if (!r.wait || r.wait.gate === "kyle") return null;
      if (r.recheckAt && Date.parse(r.recheckAt) > now) return null;
      return { ...r, state: "DELIVERING", wait: r.wait, recheckAt: null };
    }

    // A Dropbox or network blip a moment ago: the next pass tries again.
    if (r.pauseUntil && Date.parse(r.pauseUntil) > now) return null;

    if (r.state === "PREPARING") {
      const g = await gates(r.submissionId, { asks: true, sound: true, soundCheckedFp: r.soundCheckedFp });
      if (!g.ok) {
        const n = blocked(r, g, "PREPARING");
        return n.state === r.state && n.note === r0.note ? null : n;
      }
      r.fingerprint = g.fingerprint;
      r.soundCheckedFp = g.fingerprint;
      r.listingId = g.listingId;
      r.projectId = g.projectId;
      r.topazJobId = g.topazJobId;
      r.file = { ...r.file, path: g.path, name: g.path.split("/").pop() ?? r.file.name, durationSec: g.durationSec, contentType: contentTypeOf(g.path) };
      if (!r.title) r.title = await titleFor(r.submissionId, r.projectId);
      // Already on the listing: a receipt for this exact file (Kyle's, or the listing check's).
      const { uploadsFor } = await import("@/lib/deliveryUploads");
      const receipt = (await uploadsFor([r.submissionId])).get(r.submissionId) as (UploadReceipt & { mediaIds?: string[] }) | undefined;
      const listed = await listedVideos(r.listingId);
      if (!listed) {
        r.note = "Aryeo's listing could not be read just now; trying again.";
        return r.note === r0.note ? null : r;
      }
      const own = await ownEarlierVideos(r.submissionId, r.listingId);
      r.replace = own.replace.filter((x) => listed.some((v) => v.id === x.mediaId));
      r.handUploadedBefore = own.handUploadedBefore;
      if (receipt && receipt.sourceFingerprint === r.fingerprint && receipt.listingId === r.listingId) {
        const id = receipt.mediaIds?.find((m) => listed.some((v) => v.id === m)) ?? null;
        r.mediaId = r.mediaId ?? id;
        r.addedAt = r.addedAt ?? receipt.uploadedAt;
        r.note = `Already on the listing (recorded by ${receipt.actor}).`;
        r.replace = [];
        return afterUpload(r);
      }
      // Carried from an earlier run: already on the listing, or an add that was never confirmed.
      if (r.mediaId && listed.some((v) => v.id === r.mediaId)) {
        r.state = "CHECKING";
        return r;
      }
      if (r.priorAdd) {
        const since = Date.parse(r.priorAdd.sentAt) - SKEW_MS;
        // Any new video counts (Aryeo may not know its length yet), unless its length is known and wrong.
        const seen = listed.filter((v) => !r.priorAdd!.before.includes(v.id) && (!v.at || v.at.getTime() >= since) && (v.durationSec == null || durationMatches(r.file.durationSec, v.durationSec)));
        if (seen.length) {
          // The earlier add did land: never sent again.
          r.before = r.priorAdd.before;
          r.addSentAt = r.priorAdd.sentAt;
          r.addedAt = r.priorAdd.sentAt;
          r.state = "CHECKING";
          r.note = "The earlier try did reach the listing; checking it.";
          return r;
        }
      }
      // The file's size, from Dropbox (the multipart upload needs it exactly).
      const { size } = await tempLink(r.file.path);
      if (!size) return fail(r, "Dropbox did not say how big the 1080p file is.");
      r.file.size = size;
      r.before = listed.map((v) => v.id);
      r.state = "SENDING";
      r.note = g.note;
      return r;
    }

    if (r.state === "SENDING") {
      const u = r.upload;
      if (!u.fileUuid) {
        if (!u.method) u.method = "from_url";
        if (u.method === "from_url") {
          if (!u.token) {
            const { link } = await tempLink(r.file.path);
            try {
              const got = await W.uploadcareVideoFromUrl(link, r.file.name);
              if ("uuid" in got) {
                u.fileUuid = got.uuid;
                u.fileAt = new Date().toISOString();
              } else {
                u.token = got.token;
                u.fromUrlAt = new Date().toISOString();
              }
              r.note = "Aryeo's upload service is fetching the 1080p file.";
            } catch (e) {
              const err = e as Error & { kind?: string };
              if (err.kind === "transient" && ++u.tries < 3) {
                r.note = err.message;
                return r;
              }
              u.method = "multipart";
              u.tries = 0;
              u.fromUrlRefused = err.message.slice(0, 200);
              r.note = "Aryeo's upload service would not fetch the file from a link, so the hub is sending it in parts.";
            }
            return r;
          }
          // Poll while there is time; the next pass picks it up otherwise.
          for (;;) {
            const st = await W.uploadcareFromUrlStatus(u.token);
            if (st.status === "success" && st.uuid) {
              u.fileUuid = st.uuid;
              u.fileAt = new Date().toISOString();
              break;
            }
            if (st.status === "error" || (u.fromUrlAt && Date.now() - Date.parse(u.fromUrlAt) > FROM_URL_FOR_MS)) {
              u.method = "multipart";
              u.token = null;
              u.fromUrlRefused = (st.error ?? "it took more than 30 minutes").slice(0, 200);
              r.note = `Aryeo's upload service could not fetch the file (${u.fromUrlRefused}), so the hub is sending it in parts.`;
              return r;
            }
            const done_ = st.done != null && st.total ? ` (${mb(st.done)} of ${mb(st.total)} MB)` : "";
            r.note = `Aryeo's upload service is fetching the 1080p file${done_}.`;
            if (ctx.deadline - Date.now() < 15_000) return r.note === r0.note ? null : r;
            await sleep(3_000);
          }
        }
        if (u.method === "multipart" && !u.fileUuid) {
          const size = r.file.size ?? 0;
          if (!u.mpUuid) {
            const started = await W.uploadcareMultipartStart({ filename: r.file.name, size, contentType: r.file.contentType });
            if (started.parts.length !== Math.ceil(size / W.UPLOADCARE_PART_BYTES)) return fail(r, `Aryeo's upload service split the file into ${started.parts.length} parts, not the ${Math.ceil(size / W.UPLOADCARE_PART_BYTES)} the hub expected. Upload it by hand.`);
            u.mpUuid = started.uuid;
            u.parts = started.parts;
            u.partsDone = 0;
            u.mpStartedAt = new Date().toISOString();
            r.note = `Sending the 1080p file to Aryeo in ${started.parts.length} parts.`;
            return r;
          }
          if (u.partsDone < u.parts.length) {
            const { link } = await tempLink(r.file.path);
            const P = W.UPLOADCARE_PART_BYTES;
            let sentThisPass = 0;
            while (u.partsDone < u.parts.length && ctx.deadline - Date.now() > 12_000 && sentThisPass < (hooks.partsPerPass ?? Infinity)) {
              const i = u.partsDone;
              const bytes = await readRange(link, i * P, Math.min(size, (i + 1) * P) - 1);
              try {
                await W.uploadcarePutPart(u.parts[i], bytes);
              } catch (e) {
                const err = e as Error & { kind?: string };
                if (err.kind === "transient") break;
                // A signed address that expired: start the upload again (twice at most).
                if (++u.tries > 2) return fail(r, `Aryeo's upload service kept refusing parts of the video (${err.message}). Upload it by hand.`);
                u.mpUuid = null;
                u.parts = [];
                u.partsDone = 0;
                r.note = "Aryeo's upload service refused a part; starting the upload again.";
                return r;
              }
              u.partsDone++;
              sentThisPass++;
            }
            r.note = `Sending the 1080p file to Aryeo: ${u.partsDone} of ${u.parts.length} parts (about ${mb(Math.min(size, u.partsDone * P))} of ${mb(size)} MB).`;
            if (u.partsDone < u.parts.length) return r;
          }
          await W.uploadcareMultipartComplete(u.mpUuid);
          u.fileUuid = u.mpUuid;
          u.fileAt = new Date().toISOString();
          u.parts = [];
          return r;
        }
      }
      // The file is in; Uploadcare puts it together before Aryeo can use it.
      const info = await W.uploadcareVideoInfo(u.fileUuid!);
      if (!info.isReady) {
        if (u.fileAt && Date.now() - Date.parse(u.fileAt) > READY_FOR_MS) return fail(r, "Aryeo's upload service did not finish the file in 15 minutes. Press Retry, or upload it by hand.");
        r.note = "Aryeo's upload service is finishing the file.";
        return r.note === r0.note ? null : r;
      }
      r.state = "ADDING";
      r.note = null;
      return r;
    }

    if (r.state === "ADDING") {
      // 1. The gates again (cheap ones), just before the client could see it,
      //    then the intent, saved before anything reaches Aryeo.
      if (!r.addSentAt) {
        const g = await gates(r.submissionId, { asks: true, sound: false });
        if (!g.ok) return blocked(r, g, "ADDING");
        if (g.fingerprint !== r.fingerprint) return fail(r, "The finished file changed after it was sent to Aryeo's upload service. The new file goes on its own run.");
        r.addSentAt = new Date().toISOString();
        return r;
      }
      // 2. A pass that died around the add: never sent again; the check decides.
      if (Date.now() - Date.parse(r.addSentAt) > 90_000) {
        r.addedAt = r.addSentAt;
        r.state = "CHECKING";
        r.note = "Checking the listing for the video (the hub stopped around the add, so it is not sent again).";
        return r;
      }
      // 3. Once. Only Aryeo's own "no" stops the run; any other answer (signed
      //    out in the middle, a page the hub does not recognise, no answer)
      //    may have added it, so the check decides and nothing is sent again.
      try {
        await W.addListingVideo(r.listingId, { cdnUrl: W.videoCdnUrl(r.upload.fileUuid!), title: r.title });
        r.note = null;
      } catch (e) {
        const err = e as Error & { kind?: string };
        if (err.name === "AryeoWebError" && err.kind === "refused") throw e;
        if (err.name === "AryeoWebError" && (err.kind === "sign-in" || err.kind === "not-connected")) {
          const { markError } = await import("@/lib/integrations/connections");
          await markError(W.ARYEO_WEB_PROVIDER, err.message).catch(() => {});
        }
        r.note = `${err.message.slice(0, 200)} The hub checks the listing rather than adding it again.`;
      }
      r.addedAt = new Date().toISOString();
      r.state = "CHECKING";
      return r;
    }

    if (r.state === "CHECKING") {
      const listed = await listedVideos(r.listingId);
      if (!listed) {
        // Aryeo's API had a bad minute; an hour of them stops the run for a person.
        if (Date.now() - Date.parse(r.addedAt ?? r.addSentAt ?? r.startedAt) > CHECK_FOR_MS) return fail(r, "Aryeo's listing could not be read for an hour, so the hub cannot tell whether the video is there. Look at the listing in Aryeo.");
        return null;
      }
      let hit: ListedVideo | null = null;
      let accepted = false;
      let waiting = "Aryeo is processing the video.";
      if (r.mediaId) {
        // Carried from an earlier run: the same video, still there and playable.
        hit = listed.find((v) => v.id === r.mediaId) ?? null;
        accepted = !!hit && hit.playable && (hit.durationSec == null || durationMatches(r.file.durationSec, hit.durationSec));
      } else {
        const since = Date.parse(r.addSentAt ?? r.addedAt ?? r.startedAt) - SKEW_MS;
        // New: not on the listing before the add, and (when Aryeo's id carries its time) made after it.
        const fresh = listed.filter((v) => !(r.before ?? []).includes(v.id) && (!v.at || v.at.getTime() >= since));
        const lengthUnknownFor = Date.now() - Date.parse(r.addedAt ?? r.addSentAt ?? r.startedAt) > 30 * MIN;
        hit = [...fresh].reverse().find((v) => v.playable && (durationMatches(r.file.durationSec, v.durationSec) || (v.durationSec == null && lengthUnknownFor))) ?? null;
        const wrong = fresh.find((v) => v.durationSec != null && !durationMatches(r.file.durationSec, v.durationSec));
        if (!hit && wrong) waiting = `Aryeo shows a new video on the listing, but it runs ${Math.round(wrong.durationSec!)} s, not ${Math.round(r.file.durationSec ?? 0)} s. Waiting for the right one.`;
        accepted = !!hit;
      }
      if (hit && accepted) {
        r.mediaId = hit.id;
        r.mediaAt = (hit.at ?? new Date()).toISOString();
        // The upload receipt: the hub as the uploader, with the video's id.
        const { recordUploaded } = await import("@/lib/deliveryUploads");
        const rec = await recordUploaded(r.submissionId, { id: null, name: HUB_UPLOAD_ACTOR }, r.fingerprint!, { uploadedAt: new Date(r.mediaAt), mediaIds: [hit.id], by: "hub-aryeo-push" }).catch((e) => ({ ok: false, message: (e as Error).message }));
        if (!rec.ok && /no longer a current approved|changed/i.test(rec.message)) return fail(r, `The video is on the listing, but ${rec.message}`);
        r.note = null;
        if (r.replace.length) {
          r.state = "REPLACING";
          return r;
        }
        return afterUpload(r);
      }
      const from = Date.parse(r.addedAt ?? r.addSentAt ?? r.startedAt);
      if (Date.now() - from > CHECK_FOR_MS) {
        return fail(r, r.mediaId
          ? "The video the hub put on the listing is no longer there, or Aryeo could not play it. Look at the listing in Aryeo."
          : "Aryeo did not show the new video on the listing within an hour. Look at the listing in Aryeo. Retry checks the listing again before it sends anything.");
      }
      if (waiting === r0.note) return null;
      r.note = waiting;
      return r;
    }

    if (r.state === "REPLACING") {
      const listed = await listedVideos(r.listingId);
      if (!listed) return null;
      // Only the hub's own earlier video of THIS video, read from its own records.
      const still = r.replace.filter((x) => listed.some((v) => v.id === x.mediaId));
      if (!still.length) {
        r.replacedAt = new Date().toISOString();
        r.note = null;
        return afterUpload(r);
      }
      // Sent once; then the public API decides (Aryeo can take a moment to drop it).
      if (r.replaceSentAt) {
        if (Date.now() - Date.parse(r.replaceSentAt) < 20 * MIN) {
          const msg = "Taking the earlier version off the listing.";
          if (msg === r0.note) return null;
          r.note = msg;
          return r;
        }
        r.replacedAt = new Date().toISOString();
        r.note = "Aryeo still shows the earlier version of this video on the listing. Remove it in Aryeo.";
        return afterUpload(r);
      }
      r.replaceSentAt = new Date().toISOString();
      for (const x of still) {
        try {
          await W.deleteListingVideo(r.listingId, x.mediaId);
        } catch (e) {
          const err = e as Error & { kind?: string };
          if (err.name === "AryeoWebError" && (err.kind === "refused" || err.kind === "changed")) {
            // The new video is up; the old one stays for a person (never tried twice).
            r.replacedAt = new Date().toISOString();
            r.note = `Aryeo would not remove the earlier version (${err.message.slice(0, 160)}). Remove it in Aryeo.`;
            return afterUpload(r);
          }
          r.note = `${err.message.slice(0, 200)} Checking whether the earlier version came off.`;
          return r;
        }
      }
      r.note = "Taking the earlier version off the listing.";
      return r;
    }

    if (r.state === "DELIVERING") {
      const s = await videoDeliverySettings();
      if (s.aryeoPush !== "deliver" && !r.deliverNow) return waitRun(r, "kyle", "On the Aryeo listing. Press Deliver now to send it to the client.", null);
      const g = await gates(r.submissionId, { asks: true, sound: false });
      if (!g.ok) return blocked(r, g, "DELIVERING");
      if (g.fingerprint !== r.fingerprint) return fail(r, "The finished file changed after it went on the listing. Nothing was delivered; the new file goes on its own run.");
      // On the listing from here (the later of Aryeo's id time and the moment the add returned).
      const on = Math.max(Date.parse(r.mediaAt ?? "") || 0, Date.parse(r.addedAt ?? "") || 0) || Date.parse(r.startedAt);
      // Already delivered since the video went up (another video of the job, the photos, Kyle in Aryeo): no second email.
      const deliveries = await listingDeliveries(r.listingId);
      // (Kyle's Deliver now after a delivery the hub could not see finish means: send it.)
      const covering = deliveries.find((d) => d.at.getTime() > on && !(r.deliverNow && d.uncertain));
      if (covering) {
        r.deliveredAt = covering.at.toISOString();
        r.deliveredBy = "earlier";
        r.deliverUncertain = covering.uncertain;
        r.state = "CONFIRMING";
        r.wait = null;
        return r;
      }
      const photos = await photoPushesOn(r.listingId);
      if (photos.busy) {
        return waitRun(r, "photos", photos.waitingForKyle
          ? "On the listing. Photos on this listing are waiting for Kyle's approval; the video is delivered with them."
          : "On the listing. Photos are going up on this listing right now; the video is delivered after them.", new Date(Date.now() + 5 * MIN));
      }
      if (!r.deliverNow) {
        const sibs = await siblingsOnTheWay(r);
        const since = r.wait?.gate === "siblings" ? Date.parse(r.wait.since) : Date.now();
        if (sibs.length && Date.now() - since < SIBLING_WAIT_MS) {
          return waitRun(r, "siblings", `On the listing. Waiting for the other video${sibs.length === 1 ? "" : "s"} on this listing, so the client gets one email.`, new Date(Date.now() + 5 * MIN));
        }
        const last = deliveries[0];
        if (last && Date.now() - last.at.getTime() < s.cooldownMin * MIN) {
          const at = new Date(last.at.getTime() + s.cooldownMin * MIN);
          const { etTime } = await import("@/lib/datetime");
          return waitRun(r, "cooldown", `On the listing. This listing was delivered a few minutes ago; re-delivering at ${etTime(at)} ET.`, at);
        }
      }
      // One delivery per listing at a time (compare-and-swap).
      const { rec, raw } = await listingDelivery(r.listingId);
      if (rec?.state === "sending" && rec.runId === r.id) {
        // This run claimed it and stopped before it knew the answer: it may have gone. Never re-sent.
        await saveListingDelivery(r.listingId, { ...rec, state: "uncertain" }, raw);
        return { ...r, deliveredAt: rec.at, deliveredBy: "hub", deliverUncertain: true, state: "CONFIRMING", wait: null, note: "The hub stopped while delivering; checking whether Aryeo sent it." };
      }
      if (rec?.state === "sending" && Date.now() - Date.parse(rec.at) < 3 * MIN) return null;
      // The listing's page first (its time zone): nothing has been claimed yet if this read fails.
      const page = await W.listingPage(r.listingId);
      const claimed: ListingDelivery = { state: "sending", at: new Date().toISOString(), submissionId: r.submissionId, runId: r.id };
      if (!(await saveListingDelivery(r.listingId, claimed, raw))) return null;
      const claimRaw = JSON.stringify(claimed);
      try {
        await W.deliverListing(r.listingId, { fulfillOrders: true, timezone: page.timezone, redeliver: true });
      } catch (e) {
        const err = e as Error & { kind?: string };
        if (err.name === "AryeoWebError" && err.kind !== "transient") {
          await saveListingDelivery(r.listingId, { ...claimed, state: "refused" }, claimRaw);
          throw e;
        }
        // Signed out in the middle, or no answer: the email may have gone. Never re-sent.
        await saveListingDelivery(r.listingId, { ...claimed, state: "uncertain" }, claimRaw);
        r.deliveredAt = claimed.at;
        r.deliveredBy = "hub";
        r.deliverUncertain = true;
        r.state = "CONFIRMING";
        r.wait = null;
        r.note = err.message.slice(0, 300);
        return r;
      }
      await saveListingDelivery(r.listingId, { ...claimed, state: "sent" }, claimRaw);
      r.deliveredAt = claimed.at;
      r.deliveredBy = "hub";
      r.state = "CONFIRMING";
      r.wait = null;
      r.note = null;
      return r;
    }

    if (r.state === "CONFIRMING") {
      if (r.deliverUncertain) {
        // Only Aryeo's own signed word settles a delivery the hub could not see finish.
        const { deliveryOccurrences } = await import("@/lib/deliveryUploads");
        const ev = (await deliveryOccurrences(r.listingId).catch(() => [])).find((o) => o.source === "aryeo-event" && o.at.getTime() >= Date.parse(r.deliveredAt!) - MIN);
        if (!ev) {
          if (Date.now() - Date.parse(r.deliveredAt!) < 15 * MIN) return null;
          return waitRun({ ...r, deliverUncertain: false, deliveredAt: null, deliveredBy: null }, "kyle", "On the listing. Aryeo signed the hub out while it was delivering, so the hub cannot tell whether the email went. Look at the listing in Aryeo; if it was not delivered, press Deliver now.", null);
        }
        r.deliverUncertain = false;
      }
      const listed = await listedVideos(r.listingId);
      if (!listed) return null;
      if (r.mediaId && !listed.some((v) => v.id === r.mediaId)) return fail(r, "Delivered, but the video the hub put on the listing is no longer there. Look at the listing in Aryeo.");
      const { recordUploaded } = await import("@/lib/deliveryUploads");
      if (r.mediaId) await recordUploaded(r.submissionId, { id: null, name: HUB_UPLOAD_ACTOR }, r.fingerprint!, { uploadedAt: new Date(r.mediaAt ?? r.addedAt ?? Date.now()), mediaIds: [r.mediaId], by: "hub-aryeo-push" }).catch(() => null);
      const { markVideoSent } = await import("@/lib/readyToSend");
      const sent = await markVideoSent(r.submissionId, HUB_SENT_BY, { expectedFingerprint: r.fingerprint ?? undefined, providerConfirmed: true, notice: r.deliveredBy === "hub" ? "aryeo-email" : null });
      if (!sent.ok) return fail(r, `Delivered in Aryeo, but the hub could not record it: ${sent.message}`);
      const { refreshSurfaces } = await import("@/lib/aryeoDelivery");
      await refreshSurfaces(r.projectId).catch(() => {});
      const { etTime } = await import("@/lib/datetime");
      return done(r, r.deliveredBy === "hub" ? `Uploaded and delivered by the hub at ${etTime(new Date(r.deliveredAt!))} ET.` : `Uploaded by the hub; the listing's delivery at ${etTime(new Date(r.deliveredAt!))} ET covered it.`);
    }
    return null;
  } catch (e) {
    const err = e as Error & { kind?: string };
    if (err.name === "AryeoWebError" && err.kind === "transient") {
      r.note = err.message;
      return r.note === r0.note ? null : r;
    }
    if (err.name === "AryeoWebError" && (err.kind === "sign-in" || err.kind === "not-connected")) {
      const { markError } = await import("@/lib/integrations/connections");
      await markError(W.ARYEO_WEB_PROVIDER, err.message).catch(() => {});
      // Not this video's fault: tried again once the login works (the photo push's Godfrey lesson).
      return { ...fail(r, err.message), retryAfter: new Date(Date.now() + 30 * MIN).toISOString() };
    }
    // A Dropbox read or a network blip (not Aryeo saying no): twice more, a couple of minutes apart.
    if (err.name !== "AryeoWebError" && ++r.errors < 3) {
      r.note = `${err.message.slice(0, 200)} Trying again in a couple of minutes.`;
      r.pauseUntil = new Date(Date.now() + 2 * MIN).toISOString();
      return r;
    }
    return fail(r, err.message);
  }
}

/** One line on the job's timeline per change (never a repeat). */
async function logTransition(prev: VideoPushRun, next: VideoPushRun): Promise<VideoPushRun> {
  let line: string | null = null;
  if (next.state === "FAILED") line = `stopped. ${next.note ?? ""}`;
  else if (next.state === "HELD") line = `held. ${next.note ?? ""}`;
  else if (next.state === "WAITING" && next.wait?.gate === "kyle") line = next.note ?? "on the listing, waiting for Deliver now.";
  else if (next.state === "DONE") line = next.note ?? "delivered.";
  else if (next.state === "CHECKING" && prev.state === "ADDING") line = `added ${next.file.name} to the Aryeo listing; Aryeo is processing it.`;
  if (!line || line === next.logged) return next;
  await log(next.projectId, line.trim());
  return { ...next, logged: line };
}

/** Is there anything for a pass to do on this run right now? */
function dueNow(r: VideoPushRun): boolean {
  if (!MOVABLE.includes(r.state)) return false;
  if (r.pauseUntil && Date.parse(r.pauseUntil) > Date.now()) return false;
  if (r.state === "HELD") return r.hold?.gate !== "manual" && !!r.recheckAt && Date.parse(r.recheckAt) <= Date.now();
  if (r.state === "WAITING") return r.wait?.gate !== "kyle" && !!r.recheckAt && Date.parse(r.recheckAt) <= Date.now();
  return true;
}

/** Move one run on, up to `budgetMs`. One driver at a time (lease). */
export async function advanceVideoPush(submissionId: string, opts: { budgetMs?: number } = {}): Promise<VideoPushRun | null> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 40_000;
  const ctx: Ctx = { deadline: t0 + budget };
  const token = randomBytes(6).toString("hex");
  let { run, raw } = await load(submissionId);
  if (!run || !MOVABLE.includes(run.state)) return run;
  // Kyle's Deliver now and a sent stamp are looked at by the step even while it waits for him.
  if (!dueNow(run) && !(run.state === "WAITING" && run.wait?.gate === "kyle")) return run;
  if (run.lease && run.lease.until > Date.now() && run.lease.token !== token) return run;
  const leased = await save(submissionId, { ...run, lease: { token, until: Date.now() + LEASE_MS } }, raw);
  if (!leased) return run;
  raw = leased;
  run = JSON.parse(leased) as VideoPushRun;
  while (Date.now() < ctx.deadline - 5_000 && MOVABLE.includes(run.state)) {
    const before: VideoPushRun = run;
    let next = await step(run, ctx);
    if (!next) break;
    next = await logTransition(before, next);
    next.lease = MOVABLE.includes(next.state) ? { token, until: Date.now() + LEASE_MS } : null;
    const saved = await save(submissionId, next, raw);
    if (!saved) break; // someone else took it over
    raw = saved;
    run = JSON.parse(saved) as VideoPushRun;
    // A wait or a hold ends this pass: the cron looks again when its time comes.
    if (!dueNow(run)) break;
    // Parts of a big file went up and more are left: this pass's time is spent; the next carries on.
    if (run.state === "SENDING" && run.upload.mpUuid && run.upload.partsDone > before.upload.partsDone && run.upload.partsDone < run.upload.parts.length) break;
  }
  if (run.lease?.token === token) {
    const end = await save(submissionId, { ...run, lease: null }, raw);
    if (end) run = JSON.parse(end) as VideoPushRun;
  }
  return run;
}

// ---- the cron -------------------------------------------------------------------------------

/**
 * Cron (every 5 minutes, from /api/cron/topaz right after the 1080p step, so a
 * file filed this tick starts this tick): start a run for every approved
 * listing video whose checked 1080p file is ready, with no upload recorded and
 * not sent (readyToSend decides which file goes out), then move every live run.
 */
export async function driveVideoPushes(opts: { budgetMs?: number } = {}): Promise<{ mode: VideoPushMode; started: string[]; moved: string[]; skipped?: string }> {
  const settings = await videoDeliverySettings();
  const mode = settings.aryeoPush;
  if (mode === "off") return { mode, started: [], moved: [], skipped: "sending videos to Aryeo is switched off" };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 60_000;
  const started: string[] = [];
  const { readyToSend } = await import("@/lib/readyToSend");
  const board = await readyToSend({ recordFollowUpHealth: false, includeNoticeIncidents: false });
  const rows = board.ready.filter((v) => v.deliveryDestination === "aryeo-listing" && !v.monthlyProgram && v.file.source === "topaz-1080p");
  const runs = await runsFor(rows.map((v) => v.submissionId));
  for (const v of rows) {
    if (started.length >= 3 || Date.now() - t0 > budget / 3) break;
    const cur = runs.get(v.submissionId);
    // An upload somebody else recorded (Kyle's Mark as Uploaded, the listing check): theirs to finish.
    if (v.uploaded && !cur) continue;
    if (cur) {
      if (MOVABLE.includes(cur.state) || cur.state === "DONE") continue;
      // A practice-run line is written once per file; a refusal is looked at again after its wait.
      if (cur.state === "SHADOW" && mode === "shadow" && cur.fingerprint === v.uploadFingerprint) continue;
      if (cur.state === "FAILED" && !(cur.retryAfter && Date.parse(cur.retryAfter) < Date.now())) continue;
    }
    const r = await requestVideoPush(v.submissionId, { by: "hub", mode }).catch(() => null);
    if (r?.started) started.push(v.submissionId);
  }
  // Practice runs call nothing: nothing to move.
  if (mode === "shadow") return { mode, started, moved: [] };
  const live = await prisma.appSetting.findMany({
    where: { key: { startsWith: PREFIX }, NOT: [{ value: { contains: '"state":"DONE"' } }, { value: { contains: '"state":"FAILED"' } }, { value: { contains: '"state":"SHADOW"' } }] },
    select: { key: true, value: true },
    orderBy: { updatedAt: "asc" },
    take: 40,
  });
  const moved: string[] = [];
  const parsed = live.flatMap((row) => {
    try {
      return [JSON.parse(row.value) as VideoPushRun];
    } catch {
      return [];
    }
  });
  // Waiting for Kyle's Deliver now: moved only once somebody marked it sent (Kyle delivered in Aryeo by hand).
  const forKyle = parsed.filter((r) => r.state === "WAITING" && r.wait?.gate === "kyle").map((r) => r.submissionId);
  const sentNow = new Set(forKyle.length ? (await prisma.reviewSubmission.findMany({ where: { id: { in: forKyle }, sentToClientAt: { not: null } }, select: { id: true } })).map((x) => x.id) : []);
  for (const r of parsed) {
    if (!dueNow(r) && !sentNow.has(r.submissionId)) continue;
    const left = budget - (Date.now() - t0);
    if (left < 10_000) break;
    await advanceVideoPush(r.submissionId, { budgetMs: Math.min(left, 90_000) }).catch(() => null);
    moved.push(r.submissionId);
  }
  return { mode, started, moved };
}

// ---- Kyle's controls ------------------------------------------------------------------------

/** Retry a stopped or held run (the listing is checked before anything is sent again). */
export async function retryVideoPush(submissionId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const { run } = await load(submissionId);
  if (run && ACTIVE.includes(run.state)) return { ok: true, message: "Already sending this video to Aryeo." };
  if (run?.state === "HELD" && run.hold?.gate === "manual") return { ok: false, message: `Held by ${run.hold.by ?? "a person"}. Release it first.` };
  if (run?.state === "DONE") return { ok: true, message: run.note ?? "Already delivered." };
  const r = await requestVideoPush(submissionId, { by });
  if (r.started) await advanceVideoPush(submissionId, { budgetMs: 20_000 }).catch(() => null);
  return { ok: r.ok, message: r.message };
}

/** Deliver now: a video on the listing waiting for Kyle (upload only) or for another video or the cooldown. Never past a hold. */
export async function deliverVideoNow(submissionId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const settings = await videoDeliverySettings();
  if (settings.aryeoPush === "off" || settings.aryeoPush === "shadow") return { ok: false, message: "Sending videos to Aryeo is not switched on (Video delivery settings)." };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { run, raw } = await load(submissionId);
    if (!run) return { ok: false, message: "Nothing has been sent to Aryeo for this video yet." };
    if (run.state === "DONE") return { ok: true, message: run.note ?? "Already delivered." };
    if (run.state === "HELD") return { ok: false, message: run.hold?.why ?? "It is held." };
    if (run.state === "DELIVERING" || run.state === "CONFIRMING") return { ok: true, message: "Already delivering." };
    if (run.state !== "WAITING" || (!run.mediaId && !run.addedAt)) return { ok: false, message: "It is not on the listing yet. It is delivered as soon as it is." };
    const next: VideoPushRun = { ...run, state: "DELIVERING", deliverNow: true, wait: null, recheckAt: null, by, note: null, lease: null };
    if (await save(submissionId, next, raw)) {
      await log(run.projectId, `${by} pressed Deliver now.`);
      await advanceVideoPush(submissionId, { budgetMs: 25_000 }).catch(() => null);
      const after = (await load(submissionId)).run;
      return { ok: true, message: after?.state === "DONE" ? after.note ?? "Delivered." : after?.note ?? "Delivering in Aryeo now." };
    }
  }
  return { ok: false, message: "That changed a moment ago. Reload the page." };
}

/** Kyle's Hold: the hub does nothing more with this video until he releases it. */
export async function holdVideoPush(submissionId: string, by: string, reason: string | null): Promise<{ ok: boolean; message: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { run, raw } = await load(submissionId);
    if (run?.state === "DONE") return { ok: false, message: "Already delivered." };
    if (run?.state === "CONFIRMING" || run?.state === "DELIVERING") return { ok: false, message: "It is being delivered right now and cannot be held." };
    const why = `Held by ${by}${reason ? `: ${reason.trim().slice(0, 200)}` : ""}.`;
    const base = run ?? (await (async () => {
      const b = blank(submissionId, by, (await videoDeliverySettings()).aryeoPush);
      const cut = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true, project: { select: { aryeoListingId: true } } } });
      return { ...b, projectId: cut?.projectId ?? "", listingId: cut?.project.aryeoListingId ?? "" };
    })());
    const resume: VideoPushState = run && MOVABLE.includes(run.state) && run.state !== "HELD" && run.state !== "WAITING" ? run.state : run?.state === "WAITING" ? "DELIVERING" : "PREPARING";
    const next: VideoPushRun = { ...base, state: "HELD", hold: { gate: "manual", why, by, at: new Date().toISOString(), resume }, note: why, recheckAt: null, lease: null, finishedAt: null };
    if (run?.lease && run.lease.until > Date.now()) {
      // A pass is moving it right now: the hold lands as soon as it lets go.
      await sleep(2_000);
      continue;
    }
    if (await save(submissionId, { ...next, logged: why }, raw)) {
      await log(base.projectId, why);
      return { ok: true, message: "Held. The hub does nothing more with this video until you release it." };
    }
  }
  return { ok: false, message: "It is being worked on right now. Try again in a minute." };
}

/** Release Kyle's hold: the run picks up where it stopped. */
export async function releaseVideoPush(submissionId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const { run, raw } = await load(submissionId);
  if (!run || run.state !== "HELD" || run.hold?.gate !== "manual") return { ok: false, message: "It is not held by a person." };
  const next: VideoPushRun = { ...run, state: run.hold.resume, hold: null, note: null, recheckAt: null };
  if (!(await save(submissionId, next, raw))) return { ok: false, message: "That changed a moment ago. Reload the page." };
  await log(run.projectId, `${by} released the hold.`);
  return { ok: true, message: "Released. The hub carries on from where it stopped." };
}

// ---- the line on every screen ---------------------------------------------------------------

export type VideoPushLine = {
  mode: VideoPushMode;
  state: VideoPushState | null;
  says: string;
  tone: "progress" | "waiting" | "held" | "failed" | "done" | "info";
  /** The hub has this one: Kyle is not asked to upload it by hand. */
  handledByHub: boolean;
  /** On the listing, waiting for Kyle's Deliver now (upload only, or an earlier version up by hand). */
  waitingForKyle: boolean;
  /** Kyle's controls that apply now. */
  canRetry: boolean;
  canDeliverNow: boolean;
  canHold: boolean;
  canRelease: boolean;
  updatedAtISO: string | null;
};

const TONE: Record<VideoPushState, VideoPushLine["tone"]> = {
  SHADOW: "info", PREPARING: "progress", SENDING: "progress", ADDING: "progress", CHECKING: "progress", REPLACING: "progress",
  DELIVERING: "progress", CONFIRMING: "progress", WAITING: "waiting", HELD: "held", DONE: "done", FAILED: "failed",
};

/** The default words for a state with no note of its own. */
function stateWords(r: VideoPushRun): string {
  switch (r.state) {
    case "PREPARING": return "Getting ready to send it to Aryeo.";
    case "SENDING": return "Sending the 1080p file to Aryeo.";
    case "ADDING": return "Adding the video to the Aryeo listing.";
    case "CHECKING": return "On its way: Aryeo is processing the video.";
    case "REPLACING": return "Taking the earlier version off the listing.";
    case "DELIVERING": return "Delivering the listing in Aryeo.";
    case "CONFIRMING": return "Delivered in Aryeo; recording it.";
    case "DONE": return "Uploaded and delivered.";
    default: return "";
  }
}

export function lineFor(run: VideoPushRun | null, mode: VideoPushMode, eligible: boolean): VideoPushLine | null {
  if (!run) {
    if (mode === "off") return null;
    return {
      mode, state: null, tone: "info", updatedAtISO: null,
      says: mode === "shadow" ? "Practice run: the hub writes down what it would send at the next pass." : eligible ? "The hub sends it to Aryeo at its next pass (every 5 minutes)." : "Kyle uploads this one by hand.",
      handledByHub: mode !== "shadow" && eligible, waitingForKyle: false, canRetry: false, canDeliverNow: false, canHold: mode !== "shadow" && eligible, canRelease: false,
    };
  }
  const live = mode === "upload" || mode === "deliver";
  const says = run.state === "HELD" ? run.hold?.why ?? run.note ?? "Held." : run.note ?? stateWords(run);
  return {
    mode, state: run.state, tone: TONE[run.state], says, updatedAtISO: run.updatedAt,
    handledByHub: live && run.state !== "FAILED" && run.state !== "HELD" && run.state !== "SHADOW",
    waitingForKyle: live && run.state === "WAITING" && run.wait?.gate === "kyle",
    canRetry: live && (run.state === "FAILED" || (run.state === "HELD" && run.hold?.gate !== "manual") || run.state === "SHADOW"),
    canDeliverNow: live && run.state === "WAITING",
    canHold: live && ((ACTIVE.includes(run.state) && run.state !== "DELIVERING" && run.state !== "CONFIRMING") || run.state === "WAITING" || (run.state === "HELD" && run.hold?.gate !== "manual") || run.state === "FAILED"),
    canRelease: run.state === "HELD" && run.hold?.gate === "manual",
  };
}

/** The push line for each cut (readyToSend's rows, the Video delivery screen). One settings read, two queries. */
export async function pushLinesFor(submissionIds: string[]): Promise<Map<string, VideoPushLine>> {
  const out = new Map<string, VideoPushLine>();
  if (!submissionIds.length) return out;
  const [settings, runs, subs] = await Promise.all([
    videoDeliverySettings(),
    runsFor(submissionIds),
    prisma.reviewSubmission.findMany({ where: { id: { in: submissionIds } }, select: { id: true, project: { select: { contentMonthId: true, aryeoListingId: true } }, topazJob: { select: { state: true, outputCheck: true, savedAt: true, finalPath: true } } } }),
  ]);
  for (const s of subs) {
    if (s.project.contentMonthId) continue;
    const run = runs.get(s.id) ?? null;
    const eligible = !!s.project.aryeoListingId && s.topazJob?.state === "done" && !!s.topazJob.savedAt && !!s.topazJob.finalPath && VERIFIED.has(s.topazJob.outputCheck ?? "");
    const line = lineFor(run, settings.aryeoPush, eligible);
    if (line) out.set(s.id, line);
  }
  return out;
}
