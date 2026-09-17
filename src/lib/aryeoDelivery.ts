import "server-only";
import { prisma } from "@/lib/prisma";
import { Aryeo, orderIdForListing, syncAryeoOrders } from "@/lib/integrations/aryeo";
import { etDateTime } from "@/lib/datetime";
import { stageMeta } from "@/lib/pipeline";

// ---------------------------------------------------------------------------
// WHAT ARYEO TELLS US WHEN KYLE DELIVERS — AND WHY THIS FILE EXISTS
//
// Aryeo cannot be made to deliver a job by API. Their whole v1 surface (95
// operations, read end to end on Sep 16 2026) has no endpoint that uploads or
// creates a video — PUT /videos/{id} takes a `title` and nothing else — and no
// delivery or re-delivery endpoint at all. `delivery_status` exists ONLY on the
// listing READ model and as a query filter; it is not in ListingPutPayload, so
// it cannot be written. Kyle does the upload and the delivery by hand in
// Aryeo's web UI, and that is permanent — see ARYEO_MANUAL_NOTE in
// lib/topazJobs, which says the same thing to Kyle on his own card.
//
// What Aryeo DOES do is tell us the moment it happens, through the Activities
// webhook. Their documented envelope:
//   { "object":"ACTIVITY", "id":"f1906537-…", "name":"LISTING_DELIVERED",
//     "occurred_at":"2023-03-14T01:04:40Z",
//     "resource":{ "object":"LISTING", "id":"0cf74179-…", … } }
// `name` is the verb, `id` is the ACTIVITY id (the receiver's idempotency key),
// and `resource` is the thing it happened to.
//
// Until this file, nothing in the hub acted on any of those names. A delivery
// reached the hub only when the hourly status sweep next happened to read that
// listing: up to an hour late, and Kyle's "upload the 1080p video" card sat
// open the whole time even though he had just done it.
//
// THIS CODE IS DORMANT TODAY, ON PURPOSE. The Aryeo webhook has been silent
// since 2026-09-07T23:56:09Z (36 signature rejections on Sep 8, then nothing),
// and custom webhook management is feature-flagged in Aryeo's own UI — only
// their team can switch it back on, which Jordan is asking them to do. So
// everything here is written to be right on the morning the feed wakes up, and
// to do nothing whatsoever before then. Nothing else in the hub calls it.
//
// THE SAFETY NET IS UNCHANGED. Every fact this file learns early, the hourly
// status sweep (lib/projectStatus) would have learned on its own within the
// hour by reading the same listing. So a webhook that never arrives, arrives
// twice, or is thrown away by a guard below costs lateness, never correctness.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NEVER TRUST THE PAYLOAD.
//
// This receiver is effectively public. The Aryeo lane is in WATCHING mode
// (lib/webhookArming): a secret is saved but Aryeo has not proved it has it, so
// unsigned posts are ACCEPTED and stamped rather than refused — that is the fix
// for the eight days the lane was dead, and it is the steady state until Aryeo
// starts signing. The endpoint URL also became guessable when the app moved to
// hub.realtourpilot.com.
//
// So a stranger can post "LISTING_DELIVERED" at us all day. The rule here is
// that the body is only ever a HINT ABOUT WHERE TO LOOK. Before anything is
// written, the fact is confirmed by reading the listing back from Aryeo with
// our own API key — a read is one cheap call and it is authoritative. If Aryeo
// does not say DELIVERED, this file does nothing at all.
//
// What a forged LISTING_DELIVERED can therefore cause: one authenticated GET
// against Aryeo, and then nothing. It cannot mark a job delivered, cannot write
// a timeline line, and cannot cause a client text. What it CAN do, if the
// forger happens to name a listing Kyle really has just delivered, is make a
// TRUE fact land a few minutes earlier than the hourly sweep would have landed
// it. That is not a harm worth defending against.
//
// KYLE'S UPLOAD CARD NEEDED MORE THAN THAT, and it is worth spelling out why
// (review, Sep 16). "Aryeo says the listing is delivered" is NOT the same fact
// as "Kyle uploaded this job's 1080p video", and the first cut of this file
// treated it as if it were: it closed every open upload card on the job the
// moment any delivery landed. `delivery_status` is STICKY — a listing whose
// photos went out last week reads DELIVERED for ever, and four live jobs read
// DELIVERED today with the video still missing — so the confirmation above was
// true and beside the point. That card is the only thing chasing a video that
// has not been uploaded; closing it wrongly cannot be undone (markTopazDelivered
// no-ops for ever on a stamped row, and the Mark-delivered button disappears),
// and the client never gets their video. It did not even need an attacker: a
// re-delivery for a floor plan, or delivering the photos job of a listing two
// jobs share, did it just as well. So the card now closes only on evidence
// about the VIDEO — see "did the video actually reach Aryeo?" below. Everything
// else this file does is an early re-run of a read-only check the hourly sweep
// makes anyway; the card is the one piece of brand-new state, and it is the one
// that has to be earned.
//
// LISTING_CONTENT_DOWNLOADED is the weak one, and it is worth being blunt about
// it: Aryeo exposes no read that says "this listing's content was downloaded",
// so there is nothing to confirm it against. The strongest check available is
// that the listing exists, belongs to one of our jobs, and is genuinely
// DELIVERED (you cannot download content off a listing that was never
// delivered). Past that gate a forger who already knows a real, already
// delivered listing id can write one "the client downloaded their files" line
// and one timestamp. That is why that signal drives NOTHING — no status, no
// task, and above all no client text. See THE FEEDBACK ASK below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// IDEMPOTENCY — WHAT HAPPENS ON THE SECOND AND THIRD DELIVERY.
//
// Aryeo retries at 10s and 100s and then gives up, so the same activity can
// arrive three times. The receiver already dedupes on the ACTIVITY id, but only
// against rows that have already reached PROCESSED — so the 10s retry of an
// event still in flight goes straight past it and runs concurrently with the
// first. (And it only dedupes when there IS an activity id: of the 908 Aryeo
// webhook rows on file, ZERO carry one, because every real delivery so far has
// been a FLAT resource payload with no ACTIVITY wrapper. A named activity event
// must carry `name`, which only the wrapper has, so these three events should
// always bring an id with them — but "should" is not a thing to build on.)
//
// So this file does its own claiming, on the strongest identity the body
// offers, and every individual step is idempotent underneath that anyway:
//   · the claim  — one AppSetting row created on a unique key. The winner
//     works, the loser returns. Deleted again if the work throws, so a
//     transient failure does not swallow the event for ever.
//   · Kyle's card — markTopazDelivered (lib/topazJobs, not duplicated here)
//     returns early once TopazJob.deliveredAt is set, and its task update
//     refuses to touch a COMPLETED or CANCELLED row, so a card a human already
//     ticked is never reopened or re-closed. And it is only reached at all for
//     a job whose video the listing can account for, which a retry re-derives
//     from the same listing and reaches the same answer on.
//   · the cool-down — one full pass per listing per verb per five minutes.
//     Bounds a retry, a replay and a stranger hammering the endpoint with the
//     same lever, and costs at most an hour of lateness when it fires on
//     something real.
//   · the timeline — one line per delivery MOMENT, matched on the moment
//     itself, so a retry cannot add a second line; and when an event changed
//     nothing at all, one line a day at most, so a listing delivered over and
//     over does not fill a person's timeline with the same sentence.
//   · the status — syncProjectStatuses is the hourly sweep; running it twice in
//     a minute is exactly what "Refresh from Aryeo" already does.
//   · the bell — the "Delivered" notification is minted inside the status
//     engine on dedupeKey `delivered-<projectId>`, once, whoever triggers it.
// ---------------------------------------------------------------------------

/** The activity names this file owns. Anything else falls through to the
 *  receiver's normal resource-based routing. */
const LISTING_DELIVERED = "LISTING_DELIVERED";
const LISTING_CONTENT_DOWNLOADED = "LISTING_CONTENT_DOWNLOADED";
const MEDIA_REQUEST_DELIVERED = "MEDIA_REQUEST_DELIVERED";

const HANDLED_NAMES: readonly string[] = [LISTING_DELIVERED, LISTING_CONTENT_DOWNLOADED, MEDIA_REQUEST_DELIVERED];

/** Cheap enough to call on every event — the receiver gates on this before it
 *  hands the payload over. */
export function isAryeoDeliveryActivity(eventName: string): boolean {
  return HANDLED_NAMES.includes(eventName.toUpperCase());
}

const DAY = 86_400_000;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Aryeo's `occurred_at`, sanity-bounded to a tight window around now. A
 *  webhook must never be able to write a moment onto a client's job that is in
 *  the future or well in the past — an unverified body decides the WORDS on
 *  this line, and "delivered on Jan 1, 2099" on a timeline is the kind of thing
 *  nobody ever manages to explain afterwards. Out of range reads as "Aryeo did
 *  not say when". */
function occurredAtOf(payload: Record<string, unknown>): Date | null {
  const raw = str(payload.occurred_at) ?? str(payload.occurredAt) ?? str(payload.created_at);
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  const now = Date.now();
  if (d.getTime() > now + DAY) return null; // clock skew gets a day; forgery gets nothing
  // SEVEN days back, not a year (review, Sep 16). Aryeo retries at 10s and 100s
  // and then gives up, so a real `occurred_at` is never more than minutes old,
  // and a hand replay of a stored webhook is days at the outside. A year let an
  // unverified body put last winter's date on a client's timeline — and the
  // moment is written the way Jordan reads dates, "Wed, Sep 16, 4:05 PM", with
  // no YEAR in it, so an old date reads as a perfectly plausible recent one.
  if (d.getTime() < now - 7 * DAY) return null;
  return d;
}

type ActivityRef = {
  /** Aryeo's activity id, when the envelope carried one */
  activityId: string | null;
  /** the listing the activity happened to */
  listingId: string | null;
  /** when Aryeo says it happened — NOT when the post reached us. A retry must
   *  not be able to claim a later moment than the delivery it is retrying. */
  occurredAt: Date | null;
};

/** Read the documented ACTIVITY envelope. Deliberately separate from
 *  classifyAryeoPayload in the receiver: that one answers "which resource is
 *  this about", which is all the resource-routed branches need, and it drops
 *  `occurred_at` on the floor. */
function readActivity(payload: Record<string, unknown>): ActivityRef {
  const top = (str(payload.object) ?? "").toUpperCase();
  const resource = ((payload.resource ?? payload.data ?? {}) || {}) as Record<string, unknown>;
  const object = (str(resource.object) ?? "").toUpperCase();
  // A resource that names itself as something OTHER than a listing is not one:
  // an activity id in the listing slot would send us looking up nonsense. An
  // absent `object` is allowed — the id is still worth trying, and the Aryeo
  // read below is what actually decides whether it is real.
  const fromResource = object === "" || object === "LISTING" ? str(resource.id) : null;
  // TWO FALLBACKS, for shapes the documented envelope does not describe but
  // real traffic might (review, Sep 16). Every one of the 908 Aryeo webhooks on
  // file is a FLAT resource with no wrapper at all, so the shape to be
  // defensive about is a flat LISTING that happens to carry an activity `name`:
  // without these it yielded no id, and the event was swallowed with "nothing
  // to look up" when the listing was sitting right there at the top level.
  //   · payload.id, but ONLY when the top-level object actually says LISTING.
  //     On the documented wrapper payload.id is the ACTIVITY id, and looking
  //     THAT up as a listing would be a 404 every time.
  //   · payload.resource_id, the third id slot classifyAryeoPayload reads.
  // Not covered, on purpose: resource.order_id / resource.order.id. Those are
  // ORDER ids, and an order id used as a listing id is just a wrong lookup.
  const listingId = fromResource ?? (top === "LISTING" ? str(payload.id) : null) ?? str(payload.resource_id);
  const id = str(payload.id);
  return {
    // NEVER the listing's own id. On a flat payload payload.id IS the listing,
    // and claiming on it would key every future event about that listing to one
    // claim row — one delivery handled, every later one silently discarded.
    activityId: id && id === listingId ? str(payload.event_id) : (id ?? str(payload.event_id)),
    listingId,
    occurredAt: occurredAtOf(payload),
  };
}

// ---- the claim, the cool-down, and cleaning up after both -------------------

/** Every AppSetting row this file writes starts with this. AppSetting is 239
 *  hand-maintained office settings plus a handful of reconcile cursors, so the
 *  bookkeeping a public endpoint can make us write has to be recognisable at a
 *  glance and sweepable without going anywhere near the real ones. */
const MARK = "aryeo-wh-";

type ClaimState = "claimed" | "taken" | "unavailable";

/** AppSetting.key is the primary key, so `create` is an atomic claim: exactly
 *  one caller can win it. The same trick the client-text sweeps use for their
 *  send markers.
 *
 *  FAILS OPEN on anything that is not a duplicate-key collision. The claim is
 *  an optimisation on top of per-step idempotency, never the thing that makes
 *  the work safe — so a database hiccup while claiming must not silently throw
 *  a real delivery away. */
async function claim(key: string): Promise<ClaimState> {
  try {
    await prisma.appSetting.create({ data: { key, value: new Date().toISOString() } });
    return "claimed";
  } catch (e) {
    const code = (e as { code?: string })?.code;
    return code === "P2002" ? "taken" : "unavailable";
  }
}

/** Hand the claim back when the work threw, so the 100s retry (or a human
 *  replay) can pick it up. Without this one transient Dropbox 429 inside the
 *  status pass would retire the event for good. */
async function unclaim(key: string): Promise<void> {
  await prisma.appSetting.delete({ where: { key } }).catch(() => {});
}

/** The identity we claim on, strongest first. Aryeo's own activity id is the
 *  right answer and should always be there; the listing+moment fallback is
 *  deterministic from the same body, so two retries of one post still collide.
 *  With NEITHER id nor moment there is nothing stable to key on, so we fall
 *  back to the hour — the retry window is 100 seconds, which lands in the same
 *  hour almost always, and the per-step guards catch the rest. */
function claimKey(verb: string, ev: ActivityRef): string {
  if (ev.activityId) return `${MARK}activity-${ev.activityId}`;
  if (ev.occurredAt) return `${MARK}${verb}-${ev.listingId ?? "none"}-${Math.floor(ev.occurredAt.getTime() / 1000)}`;
  return `${MARK}${verb}-${ev.listingId ?? "none"}-h${new Date().toISOString().slice(0, 13)}`;
}

/** One full pass per listing per verb per five minutes.
 *
 *  The claim above stops the SAME activity being handled twice. This stops a
 *  DIFFERENT activity id about the same listing being handled over and over —
 *  which is what a stranger rotating the id gets, and every one of those posts
 *  otherwise bought a full status pass (Aryeo reads, Dropbox reads) and left a
 *  claim row behind. The receiver's burst guard bounds what we STORE, not what
 *  we DO.
 *
 *  What it costs when it fires on something real: Kyle delivers, and delivers
 *  again three minutes later for a floor plan. The second one is skipped and
 *  the hourly sweep reads the same listing within the hour and reaches the same
 *  conclusion. Lateness, never correctness — which is the trade this whole file
 *  is built on.
 *
 *  Fails OPEN. A rate limit that cannot read its own table must not be the
 *  thing that eats a real delivery. */
const COOLDOWN_MS = 5 * 60_000;

async function tooSoon(verb: string, listingId: string): Promise<boolean> {
  const key = `${MARK}seen-${verb}-${listingId}`;
  const now = new Date();
  try {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { updatedAt: true } });
    if (row && now.getTime() - row.updatedAt.getTime() < COOLDOWN_MS) return true;
    // `updatedAt` is @updatedAt, so the write is what moves the window.
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: now.toISOString() },
      update: { value: now.toISOString() },
    });
  } catch {
    return false;
  }
  return false;
}

/** Age out this file's own marker rows once a day.
 *
 *  A claim is only ever consulted inside Aryeo's 100-second retry window and a
 *  cool-down inside five minutes, so a month-old row is dead weight — but
 *  nothing pruned them, and one is written per activity and per listing an
 *  unauthenticated endpoint is asked about. Bounded by the MARK prefix so it
 *  can never reach an office setting. Housekeeping never costs an event: every
 *  failure here is swallowed. */
const MARKER_TTL_MS = 30 * DAY;

async function pruneOldMarkers(): Promise<void> {
  const key = `${MARK}pruned-at`;
  const now = Date.now();
  try {
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    const last = row ? Date.parse(row.value) : 0;
    if (Number.isFinite(last) && now - last < DAY) return;
    // Stamp FIRST, so two events arriving together do not both run the delete.
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: new Date(now).toISOString() },
      update: { value: new Date(now).toISOString() },
    });
    await prisma.appSetting.deleteMany({
      where: { key: { startsWith: MARK }, updatedAt: { lt: new Date(now - MARKER_TTL_MS) } },
    });
  } catch {
    /* never let tidying cost a delivery */
  }
}

// ---- listing → hub job -----------------------------------------------------

type ProjectRef = { id: string; title: string };

/**
 * THE LOOKUP, and every fallback, in one place.
 *
 * 1. Project.aryeoListingId is the normal link (1,516 of 1,575 jobs carry one).
 *    It is NOT unique, and must not be treated as if it were: 12 listing ids
 *    are on two projects each in live data today — the same address sold twice,
 *    or photos and video booked as separate orders against one listing. So this
 *    returns a LIST, and the caller acts on every one of them. That is right
 *    rather than merely safe: each project's own status engine re-reads its own
 *    order's line items against the shared listing, so the photos job settles on
 *    Delivered and the video job stays in Review until the reel is actually
 *    there.
 * 2. When nothing carries it, ask the listing which ORDER it belongs to
 *    (orderIdForListing — `include=orders`, the reverse link) and find the
 *    project by order id. This is the 39 Saratoga Ln shape: a project created
 *    from a thin/ghost ORDER webhook before the listing existed never had its
 *    listing id written, so every later listing event looks like a stranger.
 *    With `repair`, re-syncing that one order also backfills the missing
 *    aryeoListingId, which is what lets the status engine finally see the media.
 * 3. Still nothing: this really is a listing that is not ours, or an order the
 *    hub has never imported. We stop. The generic LISTING branch in the
 *    receiver answers that case with an unbounded `syncAryeoOrders()` sweep;
 *    deliberately not repeated here, because an unauthenticated body must not
 *    be a lever on a minutes-long full sync. The hourly cron imports new orders
 *    anyway.
 */
async function projectsForListing(listingId: string, opts: { repair: boolean }): Promise<ProjectRef[]> {
  const direct = await prisma.project.findMany({
    where: { aryeoListingId: listingId },
    select: { id: true, title: true },
    orderBy: { createdAt: "desc" },
  });
  if (direct.length > 0) return direct;

  try {
    const orderId = await orderIdForListing(listingId);
    if (!orderId) return []; // the listing exists but carries no order — not ours
    if (opts.repair) await syncAryeoOrders({ orderId });
    const linked = await prisma.project.findUnique({
      where: { aryeoOrderId: orderId },
      select: { id: true, title: true },
    });
    return linked ? [linked] : [];
  } catch {
    // orderIdForListing throws a plain 404 for a listing id Aryeo has never
    // heard of — which is exactly what a forged event looks like.
    return [];
  }
}

// ---- the pieces of "Aryeo delivered it" ------------------------------------

// ---------------------------------------------------------------------------
// DID THE VIDEO ACTUALLY REACH ARYEO?
//
// This is the only question in this file whose answer moves state nothing else
// would move, so it is the only one worth being this careful about.
//
// When a cut is approved the hub renders a 1080p pass and drops a
// `topaz-deliver-<jobId>` card on Kyle: "upload this to Aryeo and deliver the
// listing", with a Complete button he presses when he has. That card is the
// ONLY thing chasing that video. Closing it wrongly cannot be undone —
// markTopazDelivered no-ops for ever on a stamped row, the Mark-delivered
// button disappears from the Topaz lane, and the job drops off the
// "done, waiting for Kyle" count — so the video never goes out and nobody is
// told. Kyle pressing Complete himself costs one tap.
//
// The first cut of this closed every open card on the job the moment any
// LISTING_DELIVERED landed and Aryeo confirmed the listing as DELIVERED. That
// confirmation is true and beside the point: `delivery_status` is STICKY, so a
// listing whose photos went out last week reads DELIVERED for ever, and four
// live jobs read DELIVERED today with the video still missing. Staged delivery
// is normal here. So the card would have closed itself on a re-delivery for a
// floor plan, on the photos job of a listing two jobs share (12 listing ids sit
// on two projects each), on the second of two cuts when Kyle uploaded the
// first, and on anyone who posted a listing id at a public endpoint.
//
// WHAT COUNTS AS PROOF. Nothing about the listing's delivery — only the video
// itself. The confirm read the handler already makes comes back with the
// listing's `videos[]` (LISTING_INCLUDES covers images, videos, floor plans,
// interactive content and files), so the evidence is already in hand and costs
// no extra call. Each video carries no created_at — but Aryeo's ids are UUIDv7,
// whose first 48 bits ARE the creation time in milliseconds. Verified against
// live data on Sep 16: every listing id decodes to a few minutes before the
// hub imported that listing, and each listing's video ids decode to days after
// their own listing id — including 308 W Upsal, where the second video decodes
// to 21:48 on Sep 14, three minutes after the client rang in to say the video
// was missing from a gallery delivered at 20:01. The decode is checked, not
// assumed: wrong length, a version nibble that is not 7, or a nonsense moment
// all mean "no evidence", and no evidence means the card stays open. If Aryeo
// ever changes their id format, cards simply stop closing themselves and Kyle
// taps them, which is exactly where we were before this file existed.
//
// So a card closes only when the listing carries a video that appeared AFTER
// that job's 1080p file landed in Dropbox (Kyle cannot have uploaded it before
// it existed — the card is what tells him it is there), whose length matches
// the job's when both are known, and that no other card on the job could
// equally claim. When two cards could each be the same upload, NEITHER closes.
// That is over-cautious by design: guessing wrong costs a client their video,
// and guessing at all is not something a webhook should do.
// ---------------------------------------------------------------------------

/** One video on the listing, with the moment its id says it was created. */
type ListingVideo = { id: string; at: Date; durationSec: number | null };

/** No Aryeo id can pre-date Aryeo. A decode outside this is a coincidence, not
 *  a timestamp, and is thrown away. */
const ARYEO_EPOCH_MS = Date.parse("2015-01-01T00:00:00Z");

/** The creation time carried inside a UUIDv7 id, or null when the id is not one
 *  or the time it yields is not believable. */
function aryeoIdTime(id: string | null | undefined): Date | null {
  if (!id) return null;
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex)) return null;
  if (hex[12] !== "7") return null; // version nibble — anything else carries no time
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms < ARYEO_EPOCH_MS || ms > Date.now() + DAY) return null;
  return new Date(ms);
}

function videosOnListing(listing: { videos?: unknown[] } | null): ListingVideo[] {
  const raw = Array.isArray(listing?.videos) ? (listing.videos as Record<string, unknown>[]) : [];
  const out: ListingVideo[] = [];
  for (const v of raw) {
    const id = typeof v?.id === "string" ? v.id : null;
    const at = aryeoIdTime(id);
    if (!id || !at) continue; // a video we cannot date proves nothing
    const d = typeof v.duration === "number" && Number.isFinite(v.duration) ? v.duration : null;
    out.push({ id, at, durationSec: d });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** A 1080p file that could have been uploaded: when it was ready, and how long
 *  it runs. The finished file is the same length as the source — the render is
 *  an upscale, and frame interpolation is OFF in Jordan's preset ("30 FPS
 *  original, no slow motion", lib/integrations/topaz) — so the duration the hub
 *  probed off the source MP4 header is the uploaded file's duration too. If
 *  that ever stops being true, lengths stop matching and cards simply stay open
 *  for Kyle, which is the safe way round. */
type UploadJob = {
  id: string;
  readyAt: Date;
  durationSec: number | null;
  /** A CLAIMANT THAT MAY NEVER BE PROVEN (Sep 17, review).
   *
   *  Some rows can be the video on the listing without being allowed to be
   *  stamped by this path: a cut the Ready-to-send card is not showing, an
   *  upload card the card-level pass has just declined to close, a cut whose
   *  only evidence is a bare timestamp on a job that was already delivered.
   *  Leaving them OUT of the matcher entirely would be the dangerous way round
   *  — their video would then look free, and prove somebody else's cut. So they
   *  stay in, take part in the rivalry test, and simply never win it.
   *
   *  Default (undefined) is stampable; only the code that knows a reason sets
   *  it false. */
  stampable?: boolean;
};

/** Aryeo reports whole seconds and our probe reports fractions, so a 49.683s
 *  file is a 50s video there. Two seconds covers the rounding without being
 *  wide enough to match a different edit. */
const DURATION_SLACK_SEC = 2;

function couldBe(job: UploadJob, v: ListingVideo): boolean {
  // No skew allowance, deliberately. Kyle uploads minutes or hours after the
  // card appears, never seconds before it, so there is nothing real to rescue
  // — and any tolerance here only lets an OLDER video count as proof.
  if (v.at.getTime() < job.readyAt.getTime()) return false;
  if (job.durationSec == null || v.durationSec == null) return true;
  return Math.abs(job.durationSec - v.durationSec) <= DURATION_SLACK_SEC;
}

/**
 * Which open cards this listing can actually account for.
 *
 * `delivered` are jobs already marked delivered on this project. They go first
 * and take a video each, because each one already claims an upload — otherwise
 * last week's upload would be re-used as proof for this week's card.
 */
function cardsAryeoCanAccountFor(
  videos: ListingVideo[],
  open: UploadJob[],
  delivered: UploadJob[],
): Map<string, string> {
  const taken = new Set<string>();
  const free = (j: UploadJob) => videos.find((v) => !taken.has(v.id) && couldBe(j, v)) ?? null;

  for (const j of [...delivered].sort((a, b) => a.readyAt.getTime() - b.readyAt.getTime())) {
    const hit = free(j);
    if (hit) taken.add(hit.id);
  }

  // id → the video that proves it. The caller wants the video as well as the
  // verdict: it is what lets a stamp say which file it is talking about, and
  // what a second check (a length the hub had to go and measure) is compared
  // against.
  const proven = new Map<string, string>();
  for (const j of [...open].sort((a, b) => a.readyAt.getTime() - b.readyAt.getTime())) {
    const hit = free(j);
    if (!hit) continue;
    // A claimant that is not ours to prove still holds its video: it does NOT
    // consume it (something else may legitimately be it), and it does not win
    // it either. What it does is stay in the rivalry test below, which is the
    // whole reason it is in this list at all.
    if (j.stampable === false) continue;
    // Could another card still waiting also be this upload? Then we do not know
    // which one it was, and closing either is a guess. Leave both.
    const rival = open.some((o) => o.id !== j.id && !proven.has(o.id) && couldBe(o, hit));
    if (rival) continue;
    taken.add(hit.id);
    proven.set(j.id, hit.id);
  }
  return proven;
}

/** KYLE'S CARD CLOSES ITSELF — but only the card whose video Aryeo can show us.
 *
 *  Closing goes through the very same function his own tap calls (lib/topazJobs
 *  markTopazDelivered), never a second copy of its logic. It closes the card,
 *  stamps TopazJob.deliveredAt/deliveredBy and writes its own timeline line.
 *
 *  `deliveredBy` says ARYEO, not a person: the whole point of this line is that
 *  nobody in the hub pressed anything, and a name in that column would be a
 *  small lie on a record Jordan reads. */
async function closeKylesUploadCards(
  projectId: string,
  listing: { videos?: unknown[] } | null,
  occurredAt: Date | null,
): Promise<{ closed: number; held: number; heldJobIds: Set<string> }> {
  const rows = await prisma.topazJob.findMany({
    where: { projectId },
    select: {
      id: true, taskId: true, deliveredAt: true,
      savedAt: true, finishedAt: true, createdAt: true, sourceDurationSec: true,
    },
  });
  // A job with no taskId never reached the "Kyle, upload this" step, and one
  // already stamped delivered is done.
  const waiting = rows.filter((r) => !r.deliveredAt && r.taskId);
  if (waiting.length === 0) return { closed: 0, held: 0, heldJobIds: new Set() };

  // A card whose file has no landing moment on record can never be proven, so
  // it is simply held. (It should not happen: savedAt, finishedAt and taskId
  // are written in the same update.)
  const open: UploadJob[] = waiting.flatMap((r) => {
    const readyAt = r.savedAt ?? r.finishedAt;
    return readyAt ? [{ id: r.id, readyAt, durationSec: r.sourceDurationSec }] : [];
  });
  const delivered: UploadJob[] = rows
    .filter((r) => r.deliveredAt)
    // createdAt as the last resort makes an already-delivered job GREEDIER
    // about which video it can claim, which holds more cards rather than fewer.
    .map((r) => ({ id: r.id, readyAt: r.savedAt ?? r.finishedAt ?? r.createdAt, durationSec: r.sourceDurationSec }));

  const proven = cardsAryeoCanAccountFor(videosOnListing(listing), open, delivered);
  // The cards this pass LOOKED AT and could not prove. The cut-level pass below
  // is handed this set and will not stamp a cut sitting on one of them: the two
  // passes ask the same question about the same upload, from two sides, and the
  // looser-shaped one does not get to overrule the stricter. Without it the
  // handler could report "left 1 upload card open — Aryeo's listing does not
  // show that video yet" and close that very card in the same breath, because
  // markVideoSent closes the cut's Topaz card as part of stamping it.
  const heldJobIds = new Set(waiting.map((r) => r.id).filter((id) => !proven.has(id)));
  if (proven.size === 0) return { closed: 0, held: waiting.length, heldJobIds };

  // This becomes the tail of markTopazDelivered's own timeline line, so it has
  // to finish the sentence "1080p video uploaded to Aryeo and delivered by …"
  // and say what the hub is going on — not just that a webhook arrived.
  const by = occurredAt
    ? `Aryeo itself (the video is on the listing, delivered ${etDateTime(occurredAt)} ET)`
    : "Aryeo itself (the video is on the listing)";
  const { markTopazDelivered } = await import("@/lib/topazJobs");
  let closed = 0;
  for (const id of proven.keys()) {
    // Best-effort per card: one job failing must not cost the others, or the
    // status pass that follows.
    const r = await markTopazDelivered(id, by).catch(() => null);
    if (r?.ok) closed++;
    // A card we tried and failed to close is still a card nobody proved.
    else heldJobIds.add(id);
  }
  return { closed, held: waiting.length - closed, heldJobIds };
}

// ---------------------------------------------------------------------------
// AND THE CARD THAT IS STILL ASKING FOR IT (Sep 17 2026).
//
// "Ready to send" (lib/readyToSend, on both home screens) lists every approved
// cut whose FILE has not gone to the client. A row leaves it when
// ReviewSubmission.sentToClientAt is stamped, and until now the only thing that
// ever stamped it was Kyle pressing "Mark as sent". So the morning after Aryeo
// tells us a listing was delivered, the hub knows the job is delivered, the
// timeline says so, Kyle's upload card is closed — and the card on his home
// screen is still asking him to send a video he sent yesterday. A card that
// asks for work already done is a card people stop reading, which is the exact
// failure mode the module was written to prevent.
//
// WHAT WOULD BE UNFORGIVABLE IS THE OPPOSITE. A stale row costs Kyle a moment.
// A wrong stamp costs a client their video: the row vanishes from the one
// screen that tracks unsent files, nobody is told, and the only trace is a
// timestamp saying it went out. So a cut is stamped only when ALL of this holds:
//
//   · Aryeo has confirmed this listing as DELIVERED with its own API (the
//     caller does that before we are reached at all);
//   · lib/readyToSend says this exact cut is on the card right now — the board's
//     own eligibility rules, asked rather than re-implemented (cutsOnTheCardFor);
//   · the listing carries a video whose UUIDv7 id decodes to a moment AFTER
//     this cut's file existed — Kyle cannot have uploaded it beforehand;
//   · THE LENGTHS MATCH. Not "where both are known" — where the second one is
//     not known, this path goes and MEASURES the file rather than waving the
//     cut through on the timestamp alone (see measureWhereATimestampIsNotEnough
//     for when, and why the timestamp really is not enough);
//   · every cut that is already settled takes a video first, so last week's
//     upload can never be re-used as proof for this week's cut;
//   · two exports of ONE video count as one claimant, and if two different open
//     cuts could each be the same video, NEITHER is stamped;
//   · and the card-level pass above gets the final word on its own cards: a cut
//     whose upload card closeKylesUploadCards has just declined to close is
//     never stamped here (markVideoSent would close that very card).
//
// THE 322 N 62ND ST SHAPE IS THE ONE TO KEEP IN MIND. A silent video went out,
// the editor re-cut it, and the corrected file sat in hand. The listing still
// carries the ORIGINAL video, which decodes to before the new cut was approved,
// so it matches nothing and the row stays on the card exactly where it belongs.
//
// And that shape is why a bare timestamp will not do. lib/readyToSend refuses
// the inference outright on a job that was DELIVERED before the cut was
// approved, because on those jobs "there is a video up there" says nothing. An
// earlier draft of this function claimed to be stricter than that rule and was
// in fact looser: it compared lengths it never had (a cut with no 1080p job has
// no duration column anywhere in the schema), so the whole test collapsed to
// "a video appeared after the approval" — and on 308 W Upsal St that was TRUE
// of a video uploaded 48 minutes before the hub had even finished filing the
// approved file. It would have stamped, on a job already on Jordan's card.
// So the length is now measured off the file's own header when the shape of the
// job demands a second fact, and a cut that cannot produce one waits for the
// human press, exactly as the card says it should.
//
// The write goes through readyToSend.markVideoSent — the very function Kyle's
// own button calls — rather than a second copy of the stamp. That keeps one
// definition of what "sent" does (the atomic claim, the TopazJob stamp, the
// task close, the timeline line in the words of the file that actually went)
// and means this path cannot drift away from the button.
// ---------------------------------------------------------------------------

/** Who the card says sent it. A person's name here would be a small lie on a
 *  record Jordan reads — nobody in the hub pressed anything. It reads back as
 *  "Already marked sent by Aryeo — the video is live on the listing". */
const ARYEO_SENT_BY = "Aryeo — the video is live on the listing";

type CutClaimant = {
  id: string;
  /** "these rows are the same video", in the card's own words
   *  (readyToSend.groupKeyOf) */
  groupKey: string;
  /** when the cut was approved — the moment the card starts asking for it */
  approvedAt: Date;
  /** the earliest moment Kyle could possibly have uploaded this file */
  readyAt: Date;
  durationSec: number | null;
  /** settled = somebody or something already accounted for this cut's file, so
   *  it consumes a video rather than competing for one. */
  settled: boolean;
  /** may this path write "sent" on this row? A false here still competes for
   *  the video — see UploadJob.stampable. */
  stampable: boolean;
  /** the hub's own copy of the file: the only thing this path can measure a
   *  length off, and null on a cut that lives only in Dropbox. */
  blobUrl: string | null;
  sizeBytes: number | null;
};

/**
 * Stamp the approved cuts this delivery can actually account for.
 *
 * `heldUploadCards` are the TopazJob ids the card-level pass just looked at and
 * could not prove. Returns what happened, in numbers the caller turns into the
 * log line. Never throws for a shape it does not recognise: a cut it cannot
 * reason about is a cut it leaves alone.
 */
async function stampCutsTheDeliveryCovers(
  projectId: string,
  listing: { videos?: unknown[] } | null,
  heldUploadCards: Set<string>,
): Promise<{ stamped: number; held: number }> {
  const videos = videosOnListing(listing);
  // No dateable video on the listing means no evidence about any cut. Bail
  // before the query rather than after it.
  if (videos.length === 0) return { stamped: 0, held: 0 };

  const project = await prisma.project
    .findUnique({ where: { id: projectId }, select: { contentMonthId: true, deliveredAt: true } })
    .catch(() => null);
  if (!project) return { stamped: 0, held: 0 };
  // A content-program cut is published to the client's own portal library the
  // moment it is approved, so there is no Aryeo upload for Kyle to do and these
  // never appear on the card at all (see readyToSend's wentOut). Stamping them
  // off an Aryeo delivery would be recording a send that has nothing to do with
  // the thing that was delivered.
  if (project.contentMonthId) return { stamped: 0, held: 0 };

  // EVERY approved cut on the job, with nothing filtered out yet. What gets
  // dropped here and what merely gets held apart is the whole correctness of
  // this function, and an earlier draft dropped superseded rounds and
  // removed-from-order cuts BEFORE working out which of them were already sent
  // — so a round that really had gone to the client stopped consuming its video
  // on the listing, and that freed video then "proved" a different cut that had
  // never been uploaded at all.
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, status: "APPROVED" },
    select: {
      id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, fileName: true,
      blobUrl: true, sizeBytes: true,
      decidedAt: true, completedAt: true, createdAt: true, sentToClientAt: true,
      topazJob: { select: { id: true, state: true, deliveredAt: true, savedAt: true, finishedAt: true, sourceDurationSec: true } },
    },
  });
  if (rows.length === 0) return { stamped: 0, held: 0 };

  const ready = await import("@/lib/readyToSend");
  // The board's own list of what it is asking for on this job. Anything not in
  // it may take part in the matching but can never be written to: that is what
  // keeps this path from stamping — and writing "Video sent to the client" on —
  // a row Kyle has never been shown. If the board cannot be read, nothing is
  // stampable and the event costs nothing but a re-status.
  const onCard = await ready.cutsOnTheCardFor(projectId).catch(() => null);
  if (!onCard || onCard.size === 0) return { stamped: 0, held: 0 };

  const claimants: CutClaimant[] = [];
  for (const r of rows) {
    const j = r.topazJob;
    const approvedAt = r.decidedAt ?? r.completedAt ?? r.createdAt;
    const filed = j?.savedAt ?? j?.finishedAt ?? null;
    // Already sent by a person, or its render job already stamped delivered:
    // either way its upload is spoken for. Decided for EVERY row, before
    // anything is set aside for any other reason — an earlier draft dropped
    // superseded rounds first, and a round that really had gone out then
    // stopped consuming its video.
    const settled = Boolean(r.sentToClientAt) || Boolean(j?.deliveredAt);
    // The lane is still working on this one and has filed nothing, so there is
    // no file in existence for Kyle to have uploaded. Not a claimant at all —
    // and markVideoSent refuses these too, so the two agree. Never applied to a
    // SETTLED row: dropping one of those would free the video it already
    // accounts for.
    if (!settled && j && ready.laneStillOwesWork(j.state) && !filed) continue;
    claimants.push({
      id: r.id,
      groupKey: ready.groupKeyOf(r),
      approvedAt,
      // When the file landed. For a rendered cut that is the moment the 1080p
      // file was filed — the same floor closeKylesUploadCards uses, so the two
      // reach the same answer about the same upload. Otherwise it is the
      // approval: the card that tells Kyle to send it does not exist before then.
      readyAt: filed ?? approvedAt,
      durationSec: j?.sourceDurationSec ?? null,
      settled,
      stampable: !settled && onCard.has(r.id) && !(j ? heldUploadCards.has(j.id) : false),
      blobUrl: r.blobUrl,
      sizeBytes: r.sizeBytes,
    });
  }

  const settled = claimants.filter((c) => c.settled);
  // ONE CLAIMANT PER VIDEO, not per row. Two approved exports of one reel
  // ("Finish_…" and "Revised_…" of the same file) are one video to send, and
  // the card already shows them as one row. Left as two claimants they would be
  // rivals for the same upload and neither would ever be proven. The row the
  // card is showing represents its group; where the card shows none, the newest
  // approval stands in as a rival that can never win.
  const byGroup = new Map<string, CutClaimant[]>();
  for (const c of claimants) {
    if (c.settled) continue;
    byGroup.set(c.groupKey, [...(byGroup.get(c.groupKey) ?? []), c]);
  }
  const open: CutClaimant[] = [];
  for (const g of byGroup.values()) {
    open.push(g.find((c) => c.stampable) ?? [...g].sort((a, b) => b.approvedAt.getTime() - a.approvedAt.getTime())[0]);
  }
  if (open.length === 0) return { stamped: 0, held: 0 };

  // How many of this job's rows the card is showing — the honest denominator
  // for "left N on the Ready-to-send card".
  const onCardHere = claimants.filter((c) => onCard.has(c.id)).length;

  await measureCutLengths(open, project.deliveredAt);

  // The SAME matcher the upload cards use — settled cuts take a video each
  // first, then a cut is only proven when exactly one free video could be it.
  const asJob = (c: CutClaimant): UploadJob => ({ id: c.id, readyAt: c.readyAt, durationSec: c.durationSec, stampable: c.stampable });
  const proven = cardsAryeoCanAccountFor(videos, open.map(asJob), settled.map(asJob));
  if (proven.size === 0) return { stamped: 0, held: onCardHere };

  let stamped = 0;
  for (const id of proven.keys()) {
    // Best-effort per cut: one failing must not cost the others. markVideoSent
    // is idempotent in Postgres, so a retry of this event re-runs it harmlessly
    // and is told the truth about who stamped it first.
    const r = await ready.markVideoSent(id, ARYEO_SENT_BY).catch(() => null);
    if (r?.ok && !r.already) stamped++;
  }
  return { stamped, held: Math.max(0, onCardHere - stamped) };
}

// ---------------------------------------------------------------------------
// WHEN A TIMESTAMP IS NOT PROOF, GO AND MEASURE THE FILE (Sep 17, review).
//
// A cut with no 1080p job has no duration anywhere in the schema —
// ReviewSubmission stores sizeBytes and (since Sep 16) width and height, never
// a length. So for exactly the cuts this function exists to act on, "lengths
// match where both are known" was a promise about a comparison that could never
// run, and the proof was one line long: a video appeared after the approval.
//
// On a job that has NEVER been delivered that is decent evidence, and
// lib/readyToSend accepts the same thing (weaker, in fact: it only ever sees a
// COUNT). On a job that was already delivered before this cut was approved it
// is not evidence at all, and the hub has the counter-example in its own
// timeline: 308 W Upsal St was delivered on Sep 14, the correction was approved
// at 18:10:38 on Sep 16, a video appeared on the listing at 18:13:23 — and the
// hub did not finish filing the approved file until 19:01, 48 minutes later.
// The timestamp test passes on a video the approved file cannot possibly be.
//
// The length settles it, and the length is one ranged read away: the hub holds
// the cut's own bytes and the finishing pass already reads MP4 headers over
// HTTP ranges (probeVideoMetadata, ~0.5s against this very file). Measured, 308
// runs 60s — which is the length of the "Cinematic video Revision" on the
// listing and not of the 66s original beside it. That is a real discriminator,
// and it is the difference between proving something and assuming it.
//
// Bounded, because this runs inside a webhook: at most MEASURE_CAP reads per
// event, each capped in time, the cuts that NEED one first — and a cut on a
// previously-delivered job that cannot be measured is simply not stampable. It
// stays on the card for Kyle, which is where lib/readyToSend would have left it
// anyway.
// ---------------------------------------------------------------------------

/** At most this many header reads per delivery event. Half a second each
 *  against the hub's own store (measured on three live cuts, Sep 17), and a job
 *  with more unsent cuts than this is not a job to be guessing about anyway. */
const MEASURE_CAP = 3;
const MEASURE_TIMEOUT_MS = 6_000;

/**
 * Fill in the lengths this path can measure, and decide what to do about the
 * ones it cannot.
 *
 * Measuring is always worth it when the hub holds the bytes: it turns "a video
 * appeared after this cut was approved" into "a video of exactly this file's
 * length appeared after this cut was approved", which is the difference between
 * an inference and a proof — and it is what stops a re-delivery of somebody
 * else's video clearing a row. On today's board it CONFIRMS rather than blocks:
 * 2051 Old Sumneytown Pike's cut measures 47.533s against the 48s video on its
 * listing, and 308 W Upsal's measures 60s, which is the "Cinematic video
 * Revision" and not the 66s original sitting beside it.
 *
 * What happens when it cannot be measured — no bytes in the hub (four of the
 * seventeen approved cuts today live only in Dropbox), a store having a bad
 * minute, an unreadable header — depends entirely on whether the timestamp
 * alone carries the cut:
 *
 *   · job NOT already delivered when this cut was approved → it does. Anything
 *     on the listing after that moment can only have gone up afterwards, and
 *     this is exactly the evidence lib/readyToSend accepts (on a COUNT, with no
 *     video ids at all). Stamp it.
 *   · job ALREADY delivered → it does not, and this is the 322 shape. The
 *     listing was carrying video before this cut existed, so "there is a video
 *     up there" says nothing about the correction. The row waits for the press,
 *     which is where readyToSend leaves it too.
 *
 * The needy cuts are measured first so a job with several cannot spend the
 * budget on the ones that did not need it.
 */
async function measureCutLengths(open: CutClaimant[], deliveredBefore: Date | null): Promise<void> {
  const timestampWillDo = (c: CutClaimant) =>
    !deliveredBefore || deliveredBefore.getTime() >= c.approvedAt.getTime();
  const wanted = open.filter((c) => c.stampable && c.durationSec == null);
  let budget = MEASURE_CAP;
  // Needy first, then the rest.
  for (const c of [...wanted.filter((c) => !timestampWillDo(c)), ...wanted.filter(timestampWillDo)]) {
    if (budget > 0 && c.blobUrl) {
      budget--;
      const len = await videoLength(c.blobUrl, c.sizeBytes);
      if (len != null) {
        c.durationSec = len;
        continue;
      }
    }
    // Nothing measured, so the timestamp is all there is.
    if (!timestampWillDo(c)) c.stampable = false;
  }
}

/** The file's own length in seconds, or null when it cannot be read in time.
 *  Null is always "we do not know", never "it was fine" — the caller treats it
 *  as a reason not to stamp. */
async function videoLength(url: string, sizeBytes: number | null): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { probeVideoMetadata } = await import("@/lib/integrations/topaz");
    const meta = await Promise.race([
      probeVideoMetadata(url, sizeBytes),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS); }),
    ]);
    return meta && Number.isFinite(meta.durationSec) && meta.durationSec > 0 ? meta.durationSec : null;
  } catch {
    // An unreadable header, a store having a bad minute, a file that is no
    // longer there: all of them mean the same thing here.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// TELLING THE SCREENS.
//
// Every page that shows any of this is `force-dynamic` (57 of them are), so it
// re-queries on each request and there is no cached render for a webhook to
// invalidate — what these calls do is mark the paths so a browser that has
// already visited one does not serve its client-side copy on the next
// navigation. Route handlers only MARK a path; the work happens when someone
// next visits it (Next 16, revalidatePath docs).
//
// So this is worth exactly what it costs and no more, and it is written down
// here so nobody later reads it as a promise that an open tab updates by
// itself. It does not: nothing here pushes to a browser. What it does buy is
// that the moment Kyle looks, the count is right — and that if any of these
// pages is ever given a cache, this path is already telling it the truth.
//
// The path list is the same one markVideoSentAction uses when Kyle presses the
// button (src/app/ops/actions.ts), plus the two pages that are about this job.
// ---------------------------------------------------------------------------
export async function refreshSurfaces(projectId: string): Promise<void> {
  try {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/"); // Jordan's home screen — the Ready-to-send count
    revalidatePath("/ops"); // Kyle's home screen — the same card
    revalidatePath("/tasks"); // the upload card that may have just closed
    revalidatePath("/review"); // the cut queue
    revalidatePath(`/review/${projectId}`); // the Review Room for this job
    revalidatePath(`/projects/${projectId}`); // the job page and its timeline
  } catch {
    /* A webhook must never fail over telling a page to re-read itself. */
  }
}

/** The one line on the job's timeline. The prefix is the dedupe key: a retry of
 *  the same activity rebuilds the same string and finds it already there.
 *
 *  It carries Aryeo's `occurred_at`, never the time the post reached us — the
 *  100-second retry must not be able to say the client's gallery went out later
 *  than it did. */
const DELIVERED_LINE = "Aryeo delivered this listing";

/** What the job turned out to be once the status engine had re-read it. */
type Outcome = { delivered: boolean; statusLabel: string; missing: string[] };

/** One listing, two jobs (12 listing ids sit on two projects each — photos and
 *  video booked separately, or the same address sold twice). Aryeo delivering
 *  the listing is true for both; "the client can see and download their files"
 *  is NOT true of the job whose reel is still in editing. The status engine
 *  already gets that right per job; this sentence has to as well. */
function deliveredBody(marker: string, outcome: Outcome): string {
  if (outcome.delivered) {
    return `${marker} — the client can see and download their files. Aryeo told the hub itself, so nobody here had to mark it.`;
  }
  const m = outcome.missing;
  const what =
    m.length === 0
      ? "something this job was booked for still isn't up there"
      : m.length === 1
        ? `${m[0]} still isn't up there`
        : `${m.slice(0, -1).join(", ")} and ${m[m.length - 1]} still aren't up there`;
  return `${marker}. Not everything this job was booked for is on the listing yet — ${what} — so it stays in ${outcome.statusLabel} until the rest goes up.`;
}

/**
 * TWO GATES, and they answer different questions.
 *
 * 1. THE SAME MOMENT IS NEVER WRITTEN TWICE. A retry rebuilds the same marker
 *    off the same `occurred_at` and finds its own line already there. The
 *    outer bound is 90 days because the moment is written the way Jordan reads
 *    dates ("Wed, Sep 16, 4:05 PM") and carries no YEAR, so without it a
 *    delivery could be suppressed by a line from the same minute a year ago.
 *
 * 2. WHEN NOTHING ACTUALLY HAPPENED, ONE LINE A DAY AT MOST. `newsworthy` is
 *    the caller saying this event changed something: an upload card closed, or
 *    the job crossed into Delivered. Without it, every repeat delivery of an
 *    already-finished listing wrote another line — Kyle re-sending a gallery
 *    link, a floor plan landing, or a stranger posting a real listing id at a
 *    public endpoint with a fresh minute on it each time, which is timeline
 *    spam on a record a person reads. A genuine re-delivery that FINISHES a
 *    job is newsworthy by definition and still gets its own line, same day or
 *    not, which is the case that matters.
 */
async function writeDeliveredLine(
  projectId: string,
  occurredAt: Date | null,
  outcome: Outcome,
  newsworthy: boolean,
): Promise<boolean> {
  const marker = occurredAt ? `${DELIVERED_LINE} on ${etDateTime(occurredAt)} ET` : DELIVERED_LINE;
  const seen = (body: object, since: number) =>
    prisma.activity.findFirst({
      where: { projectId, type: "SYSTEM", body, createdAt: { gt: new Date(Date.now() - since) } },
      select: { id: true },
    });

  if (occurredAt && (await seen({ startsWith: marker }, 90 * DAY))) return false;
  if (!newsworthy && (await seen({ startsWith: DELIVERED_LINE }, DAY))) return false;

  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: deliveredBody(marker, outcome) } });
  return true;
}

/** The SAME two calls the receiver's generic LISTING branch makes, and the same
 *  two the hourly cron makes. There is exactly one way a job becomes Delivered
 *  in this hub — the status engine cross-checking what was ordered against what
 *  is live on Aryeo and in Dropbox — and this is not a second one. It honours
 *  the office's status pin, the Waiting hold, sticky EDITING, the hand-delivery
 *  rule and the anti-demotion guards, because it IS that engine. */
async function restatusAndRetask(projectId: string): Promise<Outcome> {
  const { syncProjectStatuses } = await import("@/lib/projectStatus");
  await syncProjectStatuses({ projectId });
  try {
    const { generateTasksForProject } = await import("@/lib/tasks");
    await generateTasksForProject(projectId);
  } catch {
    /* the hourly reconciler is the net for this half */
  }
  return readOutcome(projectId);
}

/** Where the job landed, in the words the rest of the hub uses for it. The
 *  engine has just rewritten both of these, so this reads what it decided
 *  rather than second-guessing it. */
async function readOutcome(projectId: string): Promise<Outcome> {
  const p = await prisma.project
    .findUnique({ where: { id: projectId }, select: { status: true, statusEvidence: true } })
    .catch(() => null);
  let missing: string[] = [];
  try {
    const ev = p?.statusEvidence ? (JSON.parse(p.statusEvidence) as { missing?: unknown }) : null;
    if (Array.isArray(ev?.missing)) missing = ev.missing.filter((m): m is string => typeof m === "string");
  } catch {
    /* the sentence reads fine without the list */
  }
  return {
    delivered: p?.status === "DELIVERED",
    statusLabel: p ? stageMeta(p.status).label : "its current stage",
    missing,
  };
}

// ---- LISTING_DELIVERED -----------------------------------------------------

async function onListingDelivered(ev: ActivityRef): Promise<string> {
  // No id anywhere in the body (see readActivity for the three places we look).
  // We stop here rather than handing it back to the receiver's generic LISTING
  // branch, which answers an unknown listing with an unbounded order sweep —
  // there is nothing to look up either way, and a body nobody signed must not
  // be able to start a minutes-long sync.
  if (!ev.listingId) return "LISTING_DELIVERED arrived with no listing id on it — nothing to look up.";

  // The cheapest guard first, so it bounds the Aryeo read as well as the work.
  if (await tooSoon("listing-delivered", ev.listingId)) {
    return `Listing ${ev.listingId} was already handled in the last few minutes, so this one was skipped. The hourly check covers anything that changed since.`;
  }

  // CONFIRM IT WITH ARYEO BEFORE BELIEVING A WORD OF IT. One authenticated GET,
  // and it is the whole of the forgery defence: `delivery_status` is a read-only
  // field on Aryeo's side, so nobody but Aryeo can make it say DELIVERED. The
  // listing itself is kept, not just its status — its `videos[]` is the proof
  // that decides whether Kyle's upload card has really been dealt with.
  let listing: Awaited<ReturnType<typeof Aryeo.listing>> | null = null;
  try {
    listing = await Aryeo.listing(ev.listingId);
  } catch {
    // A 404 is what a forged (or very stale) listing id looks like; a 5xx is
    // Aryeo having a bad minute. Neither is a reason to write anything.
    return `Aryeo would not confirm listing ${ev.listingId} just now, so nothing was changed. ${await nudgeLinkedProjects(ev.listingId)}`;
  }
  const deliveryStatus = (listing?.delivery_status ?? "").toUpperCase() || null;
  if (deliveryStatus !== "DELIVERED") {
    return `Something told the hub listing ${ev.listingId} was delivered, but Aryeo itself still has it as ${deliveryStatus ?? "unknown"}. Nothing was changed. ${await nudgeLinkedProjects(ev.listingId)}`;
  }

  const key = claimKey("listing-delivered", ev);
  const state = await claim(key);
  if (state === "taken") return `Already handled this delivery (${key}) — nothing was done twice.`;

  try {
    const projects = await projectsForListing(ev.listingId, { repair: true });
    if (projects.length === 0) {
      return `Aryeo delivered listing ${ev.listingId}, but no job in the hub is linked to it. Nothing to update.`;
    }
    const done: string[] = [];
    for (const p of projects) {
      // Order: Kyle's card (only where the listing can show us the video), then
      // the status engine — and the plain-English line LAST, because it is the
      // only one that needs to know where the job actually landed, and because
      // a timeline reads newest-first, which puts the sentence a person wants
      // at the top of the three.
      const before = await prisma.project
        .findUnique({ where: { id: p.id }, select: { status: true } })
        .catch(() => null);
      const cards = await closeKylesUploadCards(p.id, listing, ev.occurredAt);
      // The cut-level half of the same question, straight after the card-level
      // one so it can see the TopazJob stamps the line above has just written
      // and treat those uploads as spoken for — and so it can be told which
      // cards that pass DECLINED to close, which it is not allowed to close
      // behind its back.
      const cuts = await stampCutsTheDeliveryCovers(p.id, listing, cards.heldJobIds).catch(() => ({ stamped: 0, held: 0 }));
      // Counted AFTER both passes, not from the first one's own arithmetic:
      // stamping a cut closes its upload card too, so a number worked out
      // before that ran could report a card as still open in the same sentence
      // that closed it.
      const stillOpenCards = await prisma.topazJob
        .count({ where: { projectId: p.id, deliveredAt: null, taskId: { not: null } } })
        .catch(() => cards.held);
      const outcome = await restatusAndRetask(p.id);
      // Did this event change anything? A card closed, or the job crossed into
      // Delivered. Read BEFORE the status engine ran, or every repeat would
      // look like news. A retry is never news by this test: its card is already
      // stamped (so it is not in the open set at all) and the job was already
      // Delivered when it arrived.
      const newsworthy =
        cards.closed > 0 || cuts.stamped > 0 || (outcome.delivered && before?.status !== "DELIVERED");
      await writeDeliveredLine(p.id, ev.occurredAt, outcome, newsworthy);
      // Only when something actually moved. A repeat delivery that changed
      // nothing has no screen to refresh.
      if (newsworthy) await refreshSurfaces(p.id);
      const said = [
        cards.closed > 0 ? `closed ${cards.closed} upload card${cards.closed > 1 ? "s" : ""}` : null,
        stillOpenCards > 0
          ? `left ${stillOpenCards} upload card${stillOpenCards > 1 ? "s" : ""} open — Aryeo's listing does not show that video yet, so Kyle still has to upload it`
          : null,
        cuts.stamped > 0
          ? `marked ${cuts.stamped} video${cuts.stamped > 1 ? "s" : ""} as gone to the client, so ${cuts.stamped > 1 ? "they leave" : "it leaves"} the Ready-to-send card`
          : null,
        cuts.held > 0
          ? `left ${cuts.held} on the Ready-to-send card — Aryeo's listing carries no video that can only be ${cuts.held > 1 ? "those cuts" : "that cut"}`
          : null,
      ].filter(Boolean);
      done.push(`${p.title}${said.length ? ` (${said.join("; ")})` : ""}`);
    }
    await pruneOldMarkers();
    return `Aryeo delivered listing ${ev.listingId} — updated ${done.join("; ")}.`;
  } catch (e) {
    if (state === "claimed") await unclaim(key);
    throw e;
  }
}

/** When Aryeo will not confirm, a job that is ALREADY linked to this listing
 *  still deserves the re-check the receiver's generic LISTING branch would have
 *  given it — the status engine re-reads Aryeo itself, so it believes nothing
 *  in the body either way, and this is a real event far more often than it is a
 *  forged one. No order sync on this path: an unauthenticated body must not be
 *  a lever on a full sweep. Nothing linked, nothing happens. */
async function nudgeLinkedProjects(listingId: string): Promise<string> {
  const linked = await prisma.project
    .findMany({ where: { aryeoListingId: listingId }, select: { id: true, title: true } })
    .catch(() => []);
  if (linked.length === 0) return "No job in the hub is linked to that listing.";
  for (const p of linked) {
    try {
      await restatusAndRetask(p.id);
      // The status engine may well have moved this job even though the event
      // itself could not be confirmed — it re-read Aryeo directly, so what it
      // decided is trustworthy whatever the body said.
      await refreshSurfaces(p.id);
    } catch {
      /* the hourly check is the net */
    }
  }
  return `Re-checked ${linked.map((p) => p.title).join("; ")} against Aryeo anyway.`;
}

// ---- LISTING_CONTENT_DOWNLOADED --------------------------------------------

/** THE FEEDBACK ASK — WHY THIS SIGNAL IS RECORDED AND NOT WIRED (Sep 16).
 *
 *  LISTING_CONTENT_DOWNLOADED is the first moment the hub knows the agent
 *  actually TOOK the files, and on the face of it that is a better moment to
 *  ask "how did we do?" than the moment we delivered them. Today the ask is
 *  timed like this: the status engine reaching DELIVERED mints a `delivery_text`
 *  SmartTask (tasks.createDeliveryTextTask), and the hourly sweep
 *  (lib/clientTextSweeps sweepDeliveryTexts) sends it on the next in-window tick
 *  once every one of its gates passes — the whole job proved delivered, every
 *  Review Room cut approved, the client's own switch on, no unanswered question
 *  from them, one auto-text per client per tick, and Jordan's quiet hours
 *  (Mon-Fri, nothing after 4:30pm ET).
 *
 *  It is NOT wired into that send path, and the reason is the paragraph above
 *  about forgery. Aryeo publishes no read that confirms a download — there is
 *  no download record on the listing model, only a `downloads_enabled` setting
 *  — so this is the one signal in this file that cannot be checked against
 *  Aryeo's own API. Letting an unconfirmable, unauthenticated body decide when a
 *  real client gets a real text is a bad trade for a few minutes of timing,
 *  when the ask already goes out the same working day. And the feed is dead
 *  today, so wiring it would ship behaviour nobody can test until Aryeo turns
 *  the tap back on.
 *
 *  HANDOVER, for when the lane is signed and armed (lib/webhookArming reports
 *  `armed` on Connections). Two changes, in this order:
 *    1. In sweepDeliveryTexts, HOLD an ask whose project has a
 *       contentDownloadedAt of null AND was delivered less than N hours ago
 *       (Jordan picks N; 24 is a sane first guess), then release it on the
 *       download or when N passes. Bounded both ways, so a job that never
 *       produces the event keeps exactly today's timing.
 *    2. Only then consider sending on the event itself. It would have to run
 *       through sendThroughOutbox with every existing gate, and the window
 *       check has to stay where it is — a download at 9pm must still wait for
 *       the morning.
 *  Do not do either while the lane is in WATCHING mode. */
async function onContentDownloaded(ev: ActivityRef): Promise<string> {
  if (!ev.listingId) return "LISTING_CONTENT_DOWNLOADED arrived with no listing id on it — nothing to look up.";

  // Its own cool-down, separate from the delivery one. We do not know whether
  // Aryeo fires this per download action or per FILE — an agent pulling 60
  // photos could mean 60 posts — so this is as much about real traffic as
  // about a stranger's.
  if (await tooSoon("content-downloaded", ev.listingId)) {
    return `Already noted a download from listing ${ev.listingId} in the last few minutes.`;
  }

  // The only check that exists: the listing has to be real, ours, and actually
  // delivered. Content cannot be downloaded off a listing that was never
  // delivered, so a claim about one is false whatever else is in the body.
  //
  // And this path deliberately does NOT re-run the status engine, unlike the
  // delivery one above. A download changes nothing about what media exists, so
  // there is no fact to go and re-read — it would be a full Aryeo+Dropbox pass
  // bought with a body nothing can confirm, for no new information.
  let deliveryStatus: string | null = null;
  try {
    const listing = await Aryeo.listing(ev.listingId);
    deliveryStatus = (listing?.delivery_status ?? "").toUpperCase() || null;
  } catch {
    return `Aryeo would not confirm listing ${ev.listingId} just now, so the download was not recorded.`;
  }
  if (deliveryStatus !== "DELIVERED") {
    return `Something said content was downloaded from listing ${ev.listingId}, but Aryeo has that listing as ${deliveryStatus ?? "unknown"} — it cannot have been. Nothing was recorded.`;
  }

  const key = claimKey("content-downloaded", ev);
  const state = await claim(key);
  if (state === "taken") return `Already recorded this download (${key}).`;

  try {
    // `repair: false` — no order re-sync off an unconfirmable event. The link
    // is read if it is already there (and LISTING_DELIVERED, which CAN be
    // confirmed, is what repairs it in the normal order of events).
    const projects = await projectsForListing(ev.listingId, { repair: false });
    if (projects.length === 0) {
      return `Content was downloaded from listing ${ev.listingId}, but no job in the hub is linked to it.`;
    }
    const at = ev.occurredAt ?? new Date();
    const touched: string[] = [];
    for (const p of projects) {
      const first = await recordDownload(p.id, at);
      // Only the first download writes a line anybody can see; every later one
      // moves a timestamp nothing renders, and marking six pages stale for that
      // would be noise.
      if (first) await refreshSurfaces(p.id);
      touched.push(`${p.title}${first ? " (first time)" : ""}`);
    }
    await pruneOldMarkers();
    return `Client downloaded content from listing ${ev.listingId} — noted on ${touched.join("; ")}.`;
  } catch (e) {
    if (state === "claimed") await unclaim(key);
    throw e;
  }
}

/** The timeline wording for a first download — also the dedupe marker. */
const DOWNLOADED_LINE = "The client downloaded their files from Aryeo";

/** Two columns, not the evidence blob. `Project.statusEvidence` looked like the
 *  right home — it is where the status engine already keeps what it knows about
 *  a job — but the engine REWRITES that blob whole on every hourly pass
 *  (`statusEvidence: JSON.stringify(evidence)`), so anything stored in it that
 *  the engine does not itself compute is erased within the hour. A fact the hub
 *  is told once and can never re-derive has to live in a column of its own.
 *
 *  Returns true when this was the FIRST download on the job. */
async function recordDownload(projectId: string, at: Date): Promise<boolean> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { contentDownloadedAt: true, contentDownloadedLastAt: true },
  });
  if (!row) return false;
  const first = !row.contentDownloadedAt;

  const data: { contentDownloadedAt?: Date; contentDownloadedLastAt?: Date } = {};
  // Only ever earlier for the first, only ever later for the last, so a retry,
  // an out-of-order pair of events or a replay cannot walk either stamp the
  // wrong way.
  if (!row.contentDownloadedAt || at.getTime() < row.contentDownloadedAt.getTime()) data.contentDownloadedAt = at;
  if (!row.contentDownloadedLastAt || at.getTime() > row.contentDownloadedLastAt.getTime()) data.contentDownloadedLastAt = at;
  if (Object.keys(data).length > 0) {
    await prisma.project.update({ where: { id: projectId }, data }).catch(() => {});
  }

  // ONE line, on the first download only. We do not know whether Aryeo fires
  // this per download action or per FILE — an agent pulling 60 photos could
  // mean 60 events — and a timeline nobody can read is worse than no line at
  // all. Every later download still moves contentDownloadedLastAt, quietly.
  //
  // The `first` flag above came from a read, so two events racing past a claim
  // that could not be written (see claim(), which fails open) would both think
  // they were first. The line therefore checks for itself as well.
  if (first) {
    const seen = await prisma.activity.findFirst({
      where: { projectId, type: "SYSTEM", body: { startsWith: DOWNLOADED_LINE } },
      select: { id: true },
    });
    if (!seen) {
      await prisma.activity
        .create({
          data: {
            projectId,
            type: "SYSTEM",
            body: `${DOWNLOADED_LINE} on ${etDateTime(at)} ET — this is the first time we know they picked the content up.`,
          },
        })
        .catch(() => {});
    }
  }
  return first;
}

// ---- MEDIA_REQUEST_DELIVERED -----------------------------------------------

/** DECIDED, SO NOBODY HAS TO ASK AGAIN (Sep 16): this one means nothing to the
 *  hub, and is accepted and dropped on purpose.
 *
 *  An Aryeo "media request" is a third party — a co-listing agent, a broker's
 *  marketing person, a stager — asking through Aryeo for a copy of a listing's
 *  media, which the company then releases. It is a SHARE, not a delivery of the
 *  job we were hired for: it has no order behind it, no line items, no money,
 *  no deliverables, and the hub models nothing that corresponds to it — there
 *  is no media_request anywhere in the schema or the code.
 *
 *  Acting on it would be actively wrong. A media request delivered against a
 *  job whose reel is still being edited would say "delivered" about a job that
 *  is not, and the client whose feedback we would then be asking for never
 *  received anything. If the hub ever grows a sharing surface of its own, this
 *  is the event that would feed it — and it should be built then, on that
 *  surface's own terms, not bolted onto delivery. */
function onMediaRequestDelivered(): string {
  return "MEDIA_REQUEST_DELIVERED is a media SHARE with a third party, not this job's delivery — accepted and ignored on purpose.";
}

// ---- the one door ----------------------------------------------------------

/**
 * Handle one of Aryeo's named delivery activities.
 *
 * Returns `handled: false` only when the name is not one of ours, so the
 * receiver can fall through to its normal resource routing. `note` is the
 * plain-English line for the server log — it is written for whoever is reading
 * Vercel's logs at 8am wondering why a job did or did not move.
 *
 * This never throws for a bad payload; it throws only when the hub's own
 * machinery does, which is what the receiver's ERROR path is for.
 */
export async function handleAryeoActivity(
  eventName: string,
  payload: Record<string, unknown>,
): Promise<{ handled: boolean; note: string }> {
  const name = eventName.toUpperCase();
  if (!isAryeoDeliveryActivity(name)) return { handled: false, note: "" };
  if (name === MEDIA_REQUEST_DELIVERED) return { handled: true, note: onMediaRequestDelivered() };

  const ev = readActivity(payload);
  const note =
    name === LISTING_DELIVERED ? await onListingDelivered(ev) : await onContentDownloaded(ev);
  return { handled: true, note };
}
