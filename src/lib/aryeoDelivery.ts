import "server-only";
import { prisma } from "@/lib/prisma";
import { Aryeo, orderIdForListing, syncAryeoOrders } from "@/lib/integrations/aryeo";
import { etDateTime } from "@/lib/datetime";
import { stageMeta } from "@/lib/pipeline";
import {
  videosOnListing,
  cardsAryeoCanAccountFor,
  readyToSend,
  clientChangeRequestsFor,
  contestedSince,
  type UploadJob,
  type ListingVideo,
} from "@/lib/readyToSend";

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

// THE MATCHER NOW LIVES IN lib/readyToSend (Sep 17, evening), and this file
// calls it rather than keeping a copy.
//
// It was written here, for this webhook. Then the Ready-to-send card needed the
// same question answered — "is the video already on that listing the one we
// owe, or the one we are replacing?" — and answered it with a COUNT, which
// cannot tell those apart and put two false rows on Kyle's home screen on the
// card's first day. Two definitions of that reasoning, in two files, is how the
// strict one gets fixed and the loose one does not. So there is one, in the
// module that the card and this file both already depend on, and the direction
// of the dependency is unchanged: aryeoDelivery → readyToSend.
//
// Nothing about the rules changed in the move; `ListingVideo` merely carries
// the video's title now, for a sentence the card prints to Kyle.

/**
 * Every project this Aryeo listing carries, the one we were asked about first.
 *
 * A video is uploaded to a LISTING, not to a project, and 12 listing ids in the
 * live data sit on two Projects each (163 Spencer Ln, 8 Hopkins Cir, 25 Skye Dr
 * and nine more — usually a photos job and a video job on the same address).
 * Every matcher here reasons by elimination, so a claimant left outside the
 * scope does not merely miss its own proof: the video it already accounts for
 * reads as FREE, and can then prove somebody else's unsent cut.
 *
 * Falls back to the single project whenever the listing is unknown or the
 * lookup fails — a narrower scope is the safe direction for a claimant list,
 * and the callers all treat "no claimants" as "prove nothing".
 */
async function projectsSharingListing(projectId: string, listingId?: string | null): Promise<string[]> {
  let id = listingId ?? null;
  if (id === undefined || id === null) {
    const p = await prisma.project
      .findUnique({ where: { id: projectId }, select: { aryeoListingId: true } })
      .catch(() => null);
    id = p?.aryeoListingId ?? null;
  }
  if (!id) return [projectId];
  const rows = await prisma.project
    .findMany({ where: { aryeoListingId: id }, select: { id: true } })
    .catch(() => [] as { id: string }[]);
  const ids = new Set(rows.map((r) => r.id));
  ids.add(projectId);
  return [...ids];
}

// ---------------------------------------------------------------------------
// THE DOWNLOAD IS CORROBORATION, AND IT ONLY EVER SAYS NO (Sep 21 2026).
//
// ReviewSubmission.downloadedAt is stamped when somebody presses Download on
// the Ready-to-send card: the first half of a hand-off, the moment the file is
// on a laptop on its way to Aryeo. Jordan asked for it to be part of the
// auto-stamp — "video downloaded, webhook says that listing was delivered and
// has a video, and then it marks that as sent".
//
// IT IS USED IN ONE DIRECTION ONLY: to REFUSE a match, never to allow one. A
// downloaded file that never reached Aryeo is exactly the three-days-sitting
// case this whole card exists to catch (5 Raymond Cir, 453 Cardigan Terrace,
// 5642 Limeport Rd, Sep 18-21), so a download on its own proves nothing and is
// never allowed to stamp anything. What it CAN do is contradict: Kyle took the
// file at 2:10pm, so a video that went up at 1:40pm is not it, whatever the
// lengths say.
//
// WHY IT IS A POST-FILTER AND NOT A FLOOR FED INTO THE MATCHER. The obvious
// move is to raise the claimant's `readyAt` to the download moment. That is not
// safe, and the reason is subtle enough to write down. lib/readyToSend's
// matcher keeps a row honest by asking whether a RIVAL could equally be the
// same video (`couldBe`), and a rival is deliberately generous — a claimant
// wrongly ruled out makes its video look free, and a free video is what clears
// somebody else's row. Raising a rival's readyAt rules it out. So a download
// stamp that is merely late (Kyle pulled the file from Dropbox, uploaded it,
// and pressed Download in the hub afterwards) would remove a true rival and
// UNLOCK a stamp on a different cut. Filtering the matcher's ANSWER cannot do
// that: the matching is unchanged, and all this can do is drop a pair.
//
// The cost of being wrong in this direction is one row left on the card and one
// tap from Kyle. The cost of being wrong the other way is a client's video that
// nobody is ever told about. Nothing writes these columns yet, so today this is
// a no-op on every row — which is the right shape for a guard that is only ever
// allowed to subtract.
// ---------------------------------------------------------------------------
function withoutMatchesTheDownloadContradicts(
  proven: Map<string, string>,
  videos: ListingVideo[],
  /** claimant id → when its file was downloaded from the hub, or null when
   *  nobody has (which is every row today) */
  downloadedAt: Map<string, Date | null>,
): { kept: Map<string, string>; refused: string[] } {
  const byId = new Map(videos.map((v) => [v.id, v] as const));
  const kept = new Map<string, string>();
  const refused: string[] = [];
  for (const [id, videoId] of proven) {
    const took = downloadedAt.get(id) ?? null;
    const v = byId.get(videoId);
    // No download stamp, or no video we can date: nothing to contradict, so the
    // match stands exactly as the matcher left it.
    if (took && v && v.at.getTime() < took.getTime()) {
      refused.push(id);
      continue;
    }
    kept.set(id, videoId);
  }
  return { kept, refused };
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
  /** `dryRun` evaluates every rule and writes nothing — the only way to show a
   *  person what this pass WOULD do to real client jobs before letting it. It
   *  is the same code path deliberately: a second, "safe" copy for previewing
   *  would be a copy that can disagree with the real one. */
  opts?: { dryRun?: boolean },
): Promise<{ closed: number; held: number; heldJobIds: Set<string>; wouldClose: string[] }> {
  // Scoped to the LISTING, not the project — see projectsSharingListing. An
  // already-delivered card on the OTHER job at this address has to be able to
  // consume the video it accounts for, or that video reads as free here.
  const listingProjectIds = await projectsSharingListing(projectId);
  const rows = await prisma.topazJob.findMany({
    where: { projectId: { in: listingProjectIds } },
    select: {
      id: true, projectId: true, taskId: true, deliveredAt: true,
      // WHICH CUT THIS RENDER IS OF. Two uses now: the download stamp (see
      // withoutMatchesTheDownloadContradicts) and, since Sep 21, the per-cut
      // stamp this pass owes every card it closes — see stampTheCutItProved.
      // TopazJob.submissionId is unique, so this is one row, not a fan-out.
      submissionId: true,
      savedAt: true, finishedAt: true, finalPath: true, createdAt: true, sourceDurationSec: true,
      submission: { select: { downloadedAt: true } },
    },
  });
  // A job with no taskId never reached the "Kyle, upload this" step, and one
  // already stamped delivered is done.
  const waiting = rows.filter((r) => !r.deliveredAt && r.taskId);
  if (waiting.length === 0) return { closed: 0, held: 0, heldJobIds: new Set(), wouldClose: [] };

  // WHEN THE 1080p FILE LANDED — and only when one actually did (Sep 17, and
  // this is the rule that decides 322 N 62nd St).
  //
  // `finishedAt` used to stand in for `savedAt` here, which reads as harmless
  // and is not: on a SKIPPED or FAILED pass, `finishedAt` is the moment the
  // lane gave up, and no 1080p file exists at all. 322's pass was abandoned
  // because Topaz would not carry the editor's uncompressed audio; it finished
  // at 10:15 and a video appeared on the listing at 10:21, the same 60 seconds
  // long — because it IS the same edit, silent. Dated off `finishedAt` that
  // reads as a clean proof that Kyle uploaded the file this card is about, and
  // the card closes on a video that is the very thing the client rejected.
  //
  // So a card is only ever proven when the file it names was really filed. No
  // file, no landing moment, no proof, and Kyle taps it himself — which is
  // exactly what the comment here always claimed and the code did not do.
  const filedAt = (r: { savedAt: Date | null; finishedAt: Date | null; finalPath: string | null }) =>
    r.savedAt ?? (r.finalPath ? r.finishedAt : null);
  // The client's own word that something up there is wrong, dated. A card whose
  // client complained after its 1080p file landed cannot be proven by a video
  // on the listing: that video may be the complaint. Same rule, same helper and
  // same reasoning as the cut-level pass below — see UploadJob.contested.
  //
  // A02 (Sep 21 audit, fixed Sep 22 2026). When that read FAILS, "no complaints
  // on file" is not established — and this matcher refuses a contested item, so
  // treating a failed read as an empty one removes a guard and makes the pass
  // MORE permissive. Nothing is stamped on unavailable evidence; the cards stay
  // open with the reason on the log, and the next hourly pass tries again.
  const asks = await clientChangeRequestsFor(listingProjectIds);
  if (!asks.known) {
    console.info(`[aryeo] held every upload card on ${projectId}: could not read the revision history (${asks.error ?? "unknown"}). Nothing stamped; the next pass retries.`);
    return { closed: 0, held: waiting.filter((r) => r.projectId === projectId).length, heldJobIds: new Set(waiting.map((r) => r.id)), wouldClose: [] };
  }
  const askList = asks.all;
  const open: UploadJob[] = waiting.flatMap((r) => {
    const readyAt = filedAt(r);
    return readyAt
      ? [{ id: r.id, readyAt, durationSec: r.sourceDurationSec, contested: Boolean(contestedSince(askList, readyAt)) }]
      : [];
  });
  const delivered: UploadJob[] = rows
    .filter((r) => r.deliveredAt)
    // createdAt as the last resort makes an already-delivered job GREEDIER
    // about which video it can claim, which holds more cards rather than fewer.
    .map((r) => ({ id: r.id, readyAt: filedAt(r) ?? r.createdAt, durationSec: r.sourceDurationSec }));

  const videos = videosOnListing(listing);
  // …and then the download stamp gets to say no. Only ever subtracts; see
  // withoutMatchesTheDownloadContradicts for why it is applied to the ANSWER
  // rather than fed into the matching.
  const { kept: proven, refused } = withoutMatchesTheDownloadContradicts(
    cardsAryeoCanAccountFor(videos, open, delivered),
    videos,
    new Map(waiting.map((r) => [r.id, r.submission?.downloadedAt ?? null] as const)),
  );
  if (refused.length > 0) {
    console.info(
      `[aryeo] left ${refused.length} upload card(s) open on ${projectId}: the video on the listing was already up before we took the file, so it is not that file.`,
    );
  }
  // The cards this pass LOOKED AT and could not prove. The cut-level pass below
  // is handed this set and will not stamp a cut sitting on one of them: the two
  // passes ask the same question about the same upload, from two sides, and the
  // looser-shaped one does not get to overrule the stricter. Without it the
  // handler could report "left 1 upload card open — Aryeo's listing does not
  // show that video yet" and close that very card in the same breath, because
  // markVideoSent closes the cut's Topaz card as part of stamping it.
  const heldJobIds = new Set(waiting.map((r) => r.id).filter((id) => !proven.has(id)));
  // "Left N open" is reported about the JOB the caller asked about, even though
  // the matching above ranged over every project this listing carries: a line
  // in this job's log that counts the other job's cards is a line that reads as
  // wrong to the person checking.
  const waitingHere = waiting.filter((r) => r.projectId === projectId).length;
  if (proven.size === 0) return { closed: 0, held: waitingHere, heldJobIds, wouldClose: [] };
  // A preview stops here: every rule above has run, nothing below it writes.
  if (opts?.dryRun) return { closed: 0, held: waitingHere, heldJobIds, wouldClose: [...proven.keys()] };

  // This becomes the tail of markTopazDelivered's own timeline line, so it has
  // to finish the sentence "1080p video uploaded to Aryeo and delivered by …"
  // and say what the hub is going on — not just that a webhook arrived.
  const by = occurredAt
    ? `Aryeo itself (the video is on the listing, delivered ${etDateTime(occurredAt)} ET)`
    : "Aryeo itself (the video is on the listing)";
  const { markTopazDelivered } = await import("@/lib/topazJobs");
  const byVideoId = new Map(videos.map((v) => [v.id, v] as const));
  const submissionOf = new Map(waiting.map((r) => [r.id, r.submissionId] as const));
  let closed = 0;
  for (const [id, videoId] of proven) {
    // Best-effort per card: one job failing must not cost the others, or the
    // status pass that follows.
    const r = await markTopazDelivered(id, by).catch(() => null);
    if (!r?.ok) {
      // A card we tried and failed to close is still a card nobody proved.
      heldJobIds.add(id);
      continue;
    }
    closed++;
    await stampTheCutItProved(submissionOf.get(id) ?? null, byVideoId.get(videoId));
  }
  return { closed, held: Math.max(0, waitingHere - closed), heldJobIds, wouldClose: [] };
}

// ---------------------------------------------------------------------------
// CLOSING THE CARD IS NOT THE SAME AS RECORDING THE SEND (Sep 21 2026).
//
// 5 Raymond Cir, 11:28 AM ET today. Kyle uploaded the video to Aryeo and
// delivered the listing, Aryeo told the hub, and the pass above did everything
// it was written to do: it proved the video, stamped TopazJob.deliveredAt,
// closed Kyle's upload card, wrote the timeline line, and the status engine
// took the job REVIEW -> DELIVERED. The row left the Ready-to-send card, so on
// every screen it looked finished.
//
// And ReviewSubmission.sentToClientAt was still NULL on the cut, its
// DeliverableOutput slot still had deliveredAt NULL and no sentSubmissionId.
// Three of the seven stamped 1080p jobs in the live data are in that state and
// all three were stamped by this pass; not one human press has ever produced
// it, because Kyle's own button goes through markVideoSent, which writes both.
//
// WHY THAT MATTERS ENOUGH TO FIX. The per-cut stamp is the one record that
// answers "did THIS FILE go out" — the schema comment above it cites 322 N 62nd
// St, where a corrected video's re-send could not be confirmed because nothing
// was written per file. And DeliverableOutput.deliveredAt is what the evidence
// engine counts as 'named': 9 rows of 924 carry one, which is why so many jobs
// read "confirmed by count, not by name". This is the cheapest place in the
// hub to improve that number, because here Aryeo TOLD us, and the matcher has
// already worked out which individual video it was.
//
// WHY THE CUT-LEVEL PASS BELOW CANNOT DO IT, and why the ordering is a red
// herring. It is true that by the time stampCutsTheDeliveryCovers runs the cut
// has left the card (readyToSend's wentOut reads TopazJob.deliveredAt), so
// cutsOnTheCardFor no longer names it. But running it FIRST would change
// nothing: `stampable` there is `!settled && !j && …`, and a cut with a 1080p
// job of its own is deliberately never stampable from that side. That is the
// Sep 17 rule and it is right — where the hub handed a specific file to a
// specific person, only that person's press closes it, and the single exception
// is this pass proving the upload that card named. So the exception has to
// finish the job it started rather than hand it to a door that is bolted.
//
// ONE DEFINITION OF SENT, STILL. The write goes through readyToSend's
// markVideoSent, the same function Kyle's own button calls: the atomic claim on
// `sentToClientAt: null`, the DeliverableOutput naming, the timeline line in
// the words of the file that actually went. Nothing here re-implements any of
// it. It is idempotent by the database, so a webhook replay and the hourly
// sweep passing over the same rows both write it once — and it is only ever
// reached for a card THIS pass just proved and closed, so it can never be
// looser than the proof that earned it.
//
// The sentence names the video, the way the cut-level pass does, because a
// stamp that only says "Aryeo" cannot be audited a week later when a client
// says they never got the right file. markVideoSent reads the "Aryeo" prefix to
// record the channel as aryeo-listing, so the wording carries a fact too.
//
// BEST-EFFORT, DELIBERATELY. A failure here leaves exactly today's state: card
// closed, cut unstamped. It must never undo the close or cost the jobs behind
// it in the loop, so it is logged and the pass carries on.
// ---------------------------------------------------------------------------
async function stampTheCutItProved(submissionId: string | null, video: ListingVideo | undefined): Promise<void> {
  if (!submissionId) return;
  const { markVideoSent } = await import("@/lib/readyToSend");
  const r = await markVideoSent(submissionId, aryeoSentBy(video)).catch(() => null);
  if (!r?.ok) {
    console.warn(
      `[aryeo] closed the upload card for cut ${submissionId} but could not record the send on the cut itself${r ? `: ${r.message}` : ""}. The job is delivered; the per-video record is missing and the next sweep will not retry it.`,
    );
  }
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
//   · and the cut never had a 1080p job of its own. That is the Sep 17 rule and
//     it is the strictest one here: where the hub handed a specific file to a
//     specific person, only that person's press closes it, and the single
//     exception is the card-level pass above proving the upload it named. This
//     path does not get a second, looser door onto the same decision.
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

/** …and WHICH video proved it. A machine stamp that only says "Aryeo" cannot be
 *  audited: the one thing a person would want to know a week later, when a
 *  client says they never got the right file, is which video on the listing the
 *  hub matched and when it went up. The matcher already returns it, so the
 *  record may as well name it. Falls back to the bare line if the video cannot
 *  be found, because a stamp must never depend on a sentence. */
function aryeoSentBy(v: ListingVideo | undefined): string {
  if (!v) return ARYEO_SENT_BY;
  const named = v.title ? `“${v.title}”` : "a video";
  const len = v.durationSec != null ? `, ${Math.round(v.durationSec)}s` : "";
  return `Aryeo — ${named}${len} on the listing since ${etDateTime(v.at)} ET`;
}

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
  /** the client has told us something is wrong with this listing's video since
   *  this file was ready — see UploadJob.contested */
  contested: boolean;
  /** when somebody pressed Download on the Ready-to-send card, or null. Only
   *  ever used to REFUSE a match this pass has already made — see
   *  withoutMatchesTheDownloadContradicts. */
  downloadedAt: Date | null;
};

/**
 * Stamp the approved cuts this delivery can actually account for.
 *
 * It used to be handed the TopazJob ids the card-level pass had declined to
 * close, so it could not stamp a cut sitting on one of them. It no longer needs
 * telling: a cut with a 1080p job of its own is not stampable here at all (see
 * `stampable` below), so the only cuts this pass can write to are the ones that
 * never had a card in the first place. Returns what happened, in numbers the
 * caller turns into the log line. Never throws for a shape it does not
 * recognise: a cut it cannot reason about is a cut it leaves alone.
 */
async function stampCutsTheDeliveryCovers(
  projectId: string,
  listing: { videos?: unknown[] } | null,
  /** See closeKylesUploadCards: same rules, no writes, so what this pass would
   *  do to real client jobs can be read before it is allowed to do it. */
  opts?: { dryRun?: boolean },
): Promise<{ stamped: number; held: number; wouldStamp: string[] }> {
  const videos = videosOnListing(listing);
  // No dateable video on the listing means no evidence about any cut. Bail
  // before the query rather than after it.
  if (videos.length === 0) return { stamped: 0, held: 0, wouldStamp: [] };

  const project = await prisma.project
    .findUnique({ where: { id: projectId }, select: { contentMonthId: true, aryeoListingId: true } })
    .catch(() => null);
  if (!project) return { stamped: 0, held: 0, wouldStamp: [] };
  // A content-program cut is published to the client's own portal library the
  // moment it is approved, so there is no Aryeo upload for Kyle to do and these
  // never appear on the card at all (see readyToSend's wentOut). Stamping them
  // off an Aryeo delivery would be recording a send that has nothing to do with
  // the thing that was delivered.
  if (project.contentMonthId) return { stamped: 0, held: 0, wouldStamp: [] };

  // EVERY approved cut on the job, with nothing filtered out yet. What gets
  // dropped here and what merely gets held apart is the whole correctness of
  // this function, and an earlier draft dropped superseded rounds and
  // removed-from-order cuts BEFORE working out which of them were already sent
  // — so a round that really had gone to the client stopped consuming its video
  // on the listing, and that freed video then "proved" a different cut that had
  // never been uploaded at all.
  // EVERY PROJECT THIS LISTING CARRIES, not just the one being evaluated (Sep
  // 17, second review). A video is uploaded to a LISTING, and 12 listing ids in
  // the live data sit on two Projects each — a photos job and a video job on
  // the same address, most often. Scoped to one project, the other project's
  // sent cut could not consume the video it had already accounted for, so that
  // video read as free and was available to prove an unsent cut beside it.
  // Nothing hits it today (none of the 12 pairs has an approved cut on either
  // side), but this pass now runs hourly rather than on a webhook that has been
  // silent since Sep 7, so "not today" is not a reason to leave it.
  const listingProjectIds = await projectsSharingListing(projectId, project.aryeoListingId);

  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId: { in: listingProjectIds }, status: "APPROVED" },
    select: {
      id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, fileName: true,
      blobUrl: true, sizeBytes: true,
      decidedAt: true, completedAt: true, createdAt: true, sentToClientAt: true, downloadedAt: true,
      project: { select: { contentMonthId: true } },
      topazJob: { select: { id: true, state: true, deliveredAt: true, savedAt: true, finishedAt: true, finalPath: true, sourceDurationSec: true } },
    },
  });
  if (rows.length === 0) return { stamped: 0, held: 0, wouldStamp: [] };

  const ready = await import("@/lib/readyToSend");
  // The board's own list of what it is asking for, on every project the listing
  // carries. Anything not in it may take part in the matching but can never be
  // written to: that is what keeps this path from stamping — and writing "Video
  // sent to the client" on — a row Kyle has never been shown. If the board
  // cannot be read, nothing is stampable and the event costs nothing but a
  // re-status.
  const onCard = new Set<string>();
  for (const id of listingProjectIds) {
    const cuts = await ready.cutsOnTheCardFor(id).catch(() => null);
    if (!cuts) return { stamped: 0, held: 0, wouldStamp: [] };
    for (const c of cuts) onCard.add(c);
  }
  if (onCard.size === 0) return { stamped: 0, held: 0, wouldStamp: [] };

  // What the client has asked to be changed on any job on this listing. A
  // complaint is about the LISTING's video, so it counts whichever project it
  // was filed against — see UploadJob.contested for why this is the fact that
  // holds 322 N 62nd St when nothing else can.
  //
  // A02, same rule as closeKylesUploadCards: an unreadable revision history is
  // not an empty one, and this pass refuses contested cuts — so a failed read
  // would let one through. Hold everything and say why.
  const asks = await clientChangeRequestsFor(listingProjectIds);
  if (!asks.known) {
    console.info(`[aryeo] stamped no cut on ${projectId}: could not read the revision history (${asks.error ?? "unknown"}). The next pass retries.`);
    return { stamped: 0, held: onCard.size, wouldStamp: [] };
  }
  const askList = asks.all;

  const claimants: CutClaimant[] = [];
  for (const r of rows) {
    const j = r.topazJob;
    const approvedAt = r.decidedAt ?? r.completedAt ?? r.createdAt;
    // Only a pass that really filed a file has a landing moment — see filedAt in
    // closeKylesUploadCards. A skipped or failed pass finishing is not a file
    // appearing, and dating a cut off it is what nearly closed 322 N 62nd St.
    const filed = j?.savedAt ?? (j?.finalPath ? j.finishedAt : null) ?? null;
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
      // WHO MAY BE WRITTEN TO, and the first clause is the Sep 17 one.
      //
      // `!j` — a cut with a 1080p job of its own is NEVER stamped from the
      // listing. The hub handed a specific file to a specific person when it
      // made that card, and lib/readyToSend's whole precedence rule is that
      // only that person's press closes it; the one thing that may close it
      // instead is closeKylesUploadCards proving the upload, which stamps the
      // JOB and takes the row off the card by the same rule. Letting this pass
      // stamp such a cut as well was a second, looser door onto the same
      // decision — and on 322 N 62nd St it was open: the pass was skipped, so
      // the file Kyle was given was the editor's export, and a 60-second video
      // of the same edit (silent, and rejected by the client that morning) sat
      // on the listing matching it on both time and length.
      // (…and never a content-program cut, on any project the listing carries:
      // those are the client's the moment they are approved and have no Aryeo
      // upload for anybody to do. They still COMPETE — a content video really
      // can be on the listing, and one that is must not read as free — they
      // just cannot be written to.)
      stampable: !settled && !j && onCard.has(r.id) && !r.project.contentMonthId,
      blobUrl: r.blobUrl,
      sizeBytes: r.sizeBytes,
      // The client complained about this listing's video AFTER this file was
      // ready, so whatever is up there may be the complaint rather than the fix.
      contested: Boolean(contestedSince(askList, filed ?? approvedAt)),
      downloadedAt: r.downloadedAt,
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
  if (open.length === 0) return { stamped: 0, held: 0, wouldStamp: [] };

  // How many of THIS job's rows the card is showing — the honest denominator
  // for "left N on the Ready-to-send card". Counted off the rows rather than the
  // claimants because the claimants now range over every project the listing
  // carries, and a count that included the other job's rows would read as wrong
  // to whoever checks the line against the screen.
  const onCardHere = rows.filter((r) => r.projectId === projectId && onCard.has(r.id)).length;

  await measureCutLengths(open);

  // The SAME matcher the upload cards use — settled cuts take a video each
  // first, then a cut is only proven when exactly one free video could be it,
  // both lengths are known and agree, nothing was already on the listing when
  // the file was made, and the client has not since said it is wrong.
  const asJob = (c: CutClaimant): UploadJob => ({
    id: c.id, readyAt: c.readyAt, durationSec: c.durationSec, stampable: c.stampable, contested: c.contested,
  });
  // The matcher decides; the download stamp is then allowed to contradict it and
  // nothing else. See withoutMatchesTheDownloadContradicts — a cut whose file
  // was taken from the hub AFTER the video went up cannot be that video, and a
  // cut nobody has downloaded is unaffected (which is every cut today).
  const { kept: proven, refused } = withoutMatchesTheDownloadContradicts(
    cardsAryeoCanAccountFor(videos, open.map(asJob), settled.map(asJob)),
    videos,
    new Map(open.map((c) => [c.id, c.downloadedAt] as const)),
  );
  if (refused.length > 0) {
    console.info(
      `[aryeo] left ${refused.length} cut(s) on the Ready-to-send card for ${projectId}: the video on the listing was already up before we took the file, so it is not that file.`,
    );
  }
  if (proven.size === 0) return { stamped: 0, held: onCardHere, wouldStamp: [] };

  // A preview stops here, with the measurement done and the matching done —
  // everything below this line is the write.
  if (opts?.dryRun) return { stamped: 0, held: onCardHere, wouldStamp: [...proven.keys()] };

  let stamped = 0;
  const byVideoId = new Map(videos.map((v) => [v.id, v] as const));
  for (const [id, videoId] of proven) {
    // Best-effort per cut: one failing must not cost the others. markVideoSent
    // is idempotent in Postgres, so a retry of this event re-runs it harmlessly
    // and is told the truth about who stamped it first.
    const r = await ready.markVideoSent(id, aryeoSentBy(byVideoId.get(videoId))).catch(() => null);
    if (r?.ok && !r.already) stamped++;
  }
  return { stamped, held: Math.max(0, onCardHere - stamped), wouldStamp: [] };
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
 * When it cannot be measured — no bytes in the hub (four of the seventeen
 * approved cuts today live only in Dropbox), a store having a bad minute, an
 * unreadable header — the cut is simply not stampable. There is no second
 * branch and no shortcut; see the comment at the bottom of this function for
 * the one that used to be here and what it did on 322 N 62nd St.
 */
async function measureCutLengths(open: CutClaimant[]): Promise<void> {
  const wanted = open.filter((c) => c.stampable && c.durationSec == null);
  let budget = MEASURE_CAP;
  // Oldest first: on a tight budget the row that has been waiting longest is
  // the one worth a read.
  for (const c of [...wanted].sort((a, b) => a.readyAt.getTime() - b.readyAt.getTime())) {
    if (budget > 0 && c.blobUrl) {
      budget--;
      const len = await videoLength(c.blobUrl, c.sizeBytes);
      if (len != null) {
        c.durationSec = len;
        continue;
      }
    }
    // NO MEASUREMENT, NO STAMP — full stop (Sep 17, second review).
    //
    // There used to be a way past this: `timestampWillDo`, which waved a cut
    // through on "a video appeared after the approval" whenever the job had not
    // been delivered BEFORE that approval. Two things were wrong with it, and
    // the second is why it is gone rather than corrected.
    //
    //   · It asked Project.deliveredAt, which is not a clock for "the listing
    //     took a video". It is the hub's own DELIVERED transition, and the
    //     status engine fires that when the approved file lands in the job's
    //     Dropbox folder — 2051 Old Sumneytown Pike went DELIVERED 61 seconds
    //     after its own approval, with `aryeo.videos: 0` in the same evidence
    //     blob. On 322 N 62nd St the predicate came out TRUE: the silent
    //     delivery happened the MORNING AFTER the approval, so the code
    //     concluded "this job was not already delivered" about the one job in
    //     the hub whose delivery is the entire problem.
    //   · Even asked of the right clock it is a guess, and this path is only
    //     allowed to write a proof. Measuring costs one ranged HTTP read of a
    //     file the hub is already holding (~0.5s), inside an hourly pass. There
    //     is no case for guessing instead.
    //
    // A cut that cannot be measured — no bytes in the hub, an unreadable
    // header, a store having a bad minute — stays on the card for Kyle, which
    // is where lib/readyToSend would have left it anyway.
    c.stampable = false;
  }
}

/** The file's own length in seconds, or null when it cannot be read in time.
 *  Null is always "we do not know", never "it was fine" — the caller treats it
 *  as a reason not to stamp. */
async function videoLength(url: string, sizeBytes: number | null): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { probeVideoMetadata } = await import("@/lib/integrations/topaz");
    // THE LAST RAW URL (R05, review Sep 18). probeVideoMetadata takes a bare
    // URL and sends no headers, so a store object has to arrive already
    // carrying its permission. Against today's public store probeableUrl hands
    // the URL straight back and costs nothing; against a private one it mints a
    // short-lived signed GET. Without it this one read would be the single
    // caller that breaks on the day the store is replaced — and it would break
    // quietly, as "we could not measure it", which this function deliberately
    // treats as a reason not to stamp a delivery.
    const { probeableUrl } = await import("@/lib/reviewCuts");
    const probe = await probeableUrl(url);
    if (!probe) return null;
    const meta = await Promise.race([
      probeVideoMetadata(probe, sizeBytes),
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
      const cuts = await stampCutsTheDeliveryCovers(p.id, listing).catch(() => ({ stamped: 0, held: 0, wouldStamp: [] }));
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
  //
  // THE LISTING IS KEPT WHOLE NOW, NOT REDUCED TO ONE FIELD (Sep 21 2026). This
  // read already comes back with `videos[]` and it was being thrown away — see
  // proveListingNow for why that mattered, and for 453 Cardigan Terrace, whose
  // only two Aryeo events since its cut was approved are both downloads.
  let listing: Awaited<ReturnType<typeof Aryeo.listing>> | null = null;
  let deliveryStatus: string | null = null;
  try {
    listing = await Aryeo.listing(ev.listingId);
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
    // AND WHILE WE ARE LOOKING AT THIS LISTING (Sep 21 2026). Somebody pulling
    // files off a delivered listing is not proof of anything on its own — this
    // is the one signal in this file Aryeo publishes no read to confirm — but
    // the listing we just read authoritatively IS, and it is in hand. Run the
    // same proof the delivery handler runs, off the same read, for no extra
    // call. It cannot write a delivery this way: everything it decides comes
    // from Aryeo's own `videos[]` and our own rows, and a listing that proves
    // nothing costs nothing. See proveListingNow.
    const proof = await proveListingNow(ev.listingId, "a download from this listing", listing).catch(
      () => ({ looked: false, closed: 0, stamped: 0, note: "the proof pass threw — the hourly sweep still covers it" }),
    );
    await pruneOldMarkers();
    const also = proof.closed > 0 || proof.stamped > 0 ? ` Also: ${proof.note}` : "";
    return `Client downloaded content from listing ${ev.listingId} — noted on ${touched.join("; ")}.${also}`;
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

// ===========================================================================
// THE SAME PROOF, THE MOMENT ARYEO SAYS ANYTHING ABOUT THE LISTING
// (Sep 21 2026 — Jordan: "when the video is sent, that auto updates").
//
// THE GAP THIS CLOSES, in live numbers read this afternoon. The feed woke up on
// Sep 18 and is healthy: 176 Aryeo events in ten days, 13 refused, none of them
// real. But of the listing traffic, 16 posts are LISTING_DELIVERED and 72 are
// LISTING_CONTENT_DOWNLOADED — and only the first of those two was ever wired to
// the proof. The second, the loud one, read the listing, checked one field on it
// (`delivery_status`), threw the rest away and recorded a timestamp.
//
// 453 Cardigan Terrace is the case. Aryeo delivered that listing on Sep 18 at
// 16:22. Renee Ryan's cut was not approved until Sep 19 at 13:54 — a day AFTER
// the only delivery event that listing has ever produced — so the one signal the
// hub was listening for had already come and gone before there was anything to
// prove. Since then Aryeo has posted about that listing twice, both times today
// (14:19 and 14:30), both times LISTING_CONTENT_DOWNLOADED, and both times the
// hub read the listing and looked at one field. `delivery_status` is sticky, so
// a re-delivery is not guaranteed to fire again; the download is what keeps
// arriving. The gap was never "we cannot tell" — it was that we did not look.
//
// So the same proof now runs on ANY Aryeo event about a listing, off the read
// that event already paid for. No new matching, no second definition of "has
// this been sent": the two functions above are called exactly as the hourly
// sweep and the delivery handler call them.
//
// WHAT A FORGED EVENT BUYS. Nothing new. This never believes the body — the
// videos it reasons over come from an authenticated read of the listing with our
// own key, and everything else comes out of our own database. The worst a
// stranger who knows a real listing id can do is make a TRUE proof land a few
// minutes earlier than the hourly sweep would have landed it, which is the same
// trade the rest of this file is built on. What they cannot do is make it say
// yes: `cardsAryeoCanAccountFor` is unchanged and still refuses everything it
// cannot prove twice over.
//
// WHAT IT COSTS. Bounded three ways before a single API call: one pass per
// listing per five minutes (the same cool-down the rest of this file uses), a
// direct link lookup that never buys an Aryeo call to repair a missing one, and
// a count that stops dead when the job has nothing outstanding — which is the
// common case, and is why 72 download events do not become 72 listing reads.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not re-run the status engine, does
// not re-read orders, does not write a timeline line of its own and does not
// send anything to anybody. "Aryeo delivered this listing" is a sentence about
// an event, and most of these are not that event; the two passes it calls write
// their own lines about the things they actually change.
// ===========================================================================

/** Just enough of an Aryeo listing to reason about. Typed structurally so the
 *  caller can hand over the listing it has already read — the download handler
 *  and the receiver both have one in hand — instead of paying for a second. */
type ListingForProof = { delivery_status?: string | null; videos?: unknown[] } | null;

export type ProofResult = {
  /** did the matching actually run? false means a guard stopped it first */
  looked: boolean;
  closed: number;
  stamped: number;
  /** the line for the server log, in the words of whoever reads it at 8am */
  note: string;
};

export async function proveListingNow(
  listingId: string,
  /** the Aryeo event name that brought us here, for the log line */
  why: string,
  /** the listing, when the caller has already read it authoritatively. Omitted,
   *  we read it ourselves — and we never, ever take it from a webhook body. */
  supplied?: ListingForProof,
): Promise<ProofResult> {
  const quiet = (note: string): ProofResult => ({ looked: false, closed: 0, stamped: 0, note });

  // 1. THE COOL-DOWN FIRST, so it bounds the reads as well as the work. Aryeo
  //    sends these in bursts — one listing produced 23 download posts inside two
  //    minutes on Sep 18 — and every one of them asks the same question about
  //    the same listing. Five minutes of lateness is the price, and the hourly
  //    sweep is behind it either way.
  if (await tooSoon("prove-listing", listingId)) {
    return quiet(`listing ${listingId} was already checked in the last few minutes — skipped`);
  }

  // 2. THE LINK WE ALREADY HAVE, and deliberately no attempt to repair a missing
  //    one. projectsForListing's fallback asks Aryeo which order a listing
  //    belongs to, which is a call per event on a listing that is not ours —
  //    LISTING_DELIVERED can afford that because it is rare and confirmable;
  //    this path runs on everything. A job whose listing id was never written is
  //    repaired by the delivery handler and by the receiver's own LISTING
  //    branch, both of which run before this does.
  const projects = await prisma.project
    .findMany({ where: { aryeoListingId: listingId }, select: { id: true, title: true }, orderBy: { createdAt: "desc" } })
    .catch(() => [] as ProjectRef[]);
  if (projects.length === 0) return quiet(`no job in the hub is linked to listing ${listingId}`);

  // 3. IS THERE A QUESTION OUTSTANDING AT ALL? This is the check that keeps the
  //    cost honest. Most Aryeo events are about a job where every card is closed
  //    and every cut is stamped, and for those there is nothing an Aryeo read
  //    could tell us. Two counts against our own database, no API.
  const ids = projects.map((p) => p.id);
  const [openCards, unsentCuts] = await Promise.all([
    prisma.topazJob.count({ where: { projectId: { in: ids }, deliveredAt: null, taskId: { not: null } } }).catch(() => 0),
    prisma.reviewSubmission.count({ where: { projectId: { in: ids }, status: "APPROVED", sentToClientAt: null } }).catch(() => 0),
  ]);
  if (openCards === 0 && unsentCuts === 0) {
    return quiet(`nothing outstanding on ${projects.map((p) => p.title).join("; ")} — no need to look`);
  }

  // 4. ARYEO'S OWN ANSWER, never the body's. A supplied listing is one the
  //    caller read with our key moments ago; anything else is read here.
  let listing: ListingForProof = supplied ?? null;
  if (!listing) {
    try {
      listing = await Aryeo.listing(listingId);
    } catch {
      return quiet(`Aryeo would not answer for listing ${listingId} just now — nothing changed`);
    }
  }

  // 5. NOTHING ON AN UNDELIVERED LISTING HAS REACHED ANYBODY. Same rule the
  //    hourly sweep applies, and for the same reason: a video sitting on a
  //    listing the client cannot open is not a video the client has.
  const delivery = (listing?.delivery_status ?? "").toUpperCase() || null;
  if (delivery !== "DELIVERED") {
    return quiet(`Aryeo has listing ${listingId} as ${delivery ?? "unknown"} — nothing there has reached the client`);
  }

  // 6. File what we just saw. The Ready-to-send card reads its evidence out of
  //    this blob, and a fresh look is worth the read on its own — a frozen
  //    `videos: 0` is what kept 2051 Old Sumneytown Pike on the card for nine
  //    days in September.
  const { refreshListingEvidence } = await import("@/lib/projectStatus");
  for (const p of projects) await refreshListingEvidence(p.id, listing as never).catch(() => null);

  // 7. THE SAME TWO PASSES, unchanged. Both range over every project the listing
  //    carries, and both are idempotent in Postgres — markTopazDelivered returns
  //    early on a stamped row, markVideoSent claims with `sentToClientAt: null`
  //    in its WHERE — so a replay of this event, a webhook landing mid-sweep and
  //    the hourly sweep running over the same rows afterwards all reach the same
  //    answer and write it once.
  let closed = 0;
  let stamped = 0;
  const said: string[] = [];
  for (const p of projects) {
    const cards = await closeKylesUploadCards(p.id, listing, null).catch(() => null);
    const cuts = await stampCutsTheDeliveryCovers(p.id, listing).catch(() => ({ stamped: 0, held: 0, wouldStamp: [] }));
    closed += cards?.closed ?? 0;
    stamped += cuts.stamped;
    if ((cards?.closed ?? 0) > 0 || cuts.stamped > 0) {
      said.push(
        `${p.title} (${[
          (cards?.closed ?? 0) > 0 ? `closed ${cards!.closed} upload card${cards!.closed > 1 ? "s" : ""}` : null,
          cuts.stamped > 0 ? `marked ${cuts.stamped} video${cuts.stamped > 1 ? "s" : ""} as gone to the client` : null,
        ]
          .filter(Boolean)
          .join("; ")})`,
      );
      await refreshSurfaces(p.id);
    }
  }

  return {
    looked: true,
    closed,
    stamped,
    note:
      said.length > 0
        ? `${why}: ${said.join("; ")}`
        : `${why}: Aryeo's listing carries no video that can only be this job's unsent cut — left for Kyle`,
  };
}

// ===========================================================================
// THE SAME PROOF, ON A SCHEDULE — because the webhook is not coming back this
// week (Sep 17 2026).
//
// Everything above runs when Aryeo tells us a listing was delivered. Aryeo has
// told us nothing since 2026-09-07T23:56:09Z: custom webhooks are feature-
// flagged inside their own UI, only their team can switch the lane back on, and
// Jordan's answer on how long that will take is "it's going to take a while to
// hear back from them". So the careful half of this file — the half that can
// look at individual videos and prove which upload was which — has been sitting
// unreachable while the Ready-to-send card guessed from a count and got two
// rows out of four wrong on its first day.
//
// This runs that same proof hourly, against the jobs that actually have a
// question outstanding: the ones with a row on the card. Nothing about the
// rules is relaxed to make it work without the event, and one thing is
// stricter: with no delivery event to anchor to, the listing itself must read
// DELIVERED before any of it counts. A video sitting on an undelivered listing
// has not reached anybody.
//
// WHAT IT COSTS. One authenticated GET per job with a row on the card — four
// today, ~300ms each, measured — plus at most three MP4 header reads per job
// when a length has to be measured (~0.5s each, capped inside
// measureCutLengths). It is bounded by `max` and by the cron step's own
// budget, and it is paid once an hour by a cron, never by a page.
//
// AND IT LEAVES THE CARD FRESHER THAN IT FOUND IT. The listing read is filed
// into the job's evidence (refreshListingEvidence), which is where the card
// reads what Aryeo is showing. That is what stops the other half of this
// morning: the hourly status sweep drops a job seven days after delivery, so
// 2051 Old Sumneytown Pike's counts had been frozen since Sep 8 while its video
// went up on Sep 9. A job with an unsent finished video is now looked at for as
// long as that stays true.
//
// It writes no timeline line of its own. "Aryeo delivered this listing" is a
// sentence about an event, and there is no event here — the two functions it
// calls write their own lines about the things they actually change.
// ===========================================================================

export type ReadySweepJob = {
  projectId: string;
  title: string;
  /** what happened, in the words the cron log should carry */
  note: string;
  closedCards: number;
  stampedCuts: number;
  wouldClose: string[];
  wouldStamp: string[];
};

export async function sweepReadyToSendAgainstAryeo(opts?: {
  /** how many jobs to look at in one pass. The card is a short list by design;
   *  a day where it is not is a day with bigger problems than this sweep. */
  max?: number;
  /** stop cleanly rather than being killed mid-write when the hour is tight */
  budgetMs?: number;
  /** evaluate everything, write nothing */
  dryRun?: boolean;
}): Promise<{ looked: number; closed: number; stamped: number; unread: number; jobs: ReadySweepJob[] }> {
  const max = opts?.max ?? 12;
  const deadline = Date.now() + (opts?.budgetMs ?? 60_000);
  const board = await readyToSend().catch(() => null);
  if (!board || board.ready.length === 0) return { looked: 0, closed: 0, stamped: 0, unread: 0, jobs: [] };

  // The card's own order — late first, then oldest — so a tight budget spends
  // itself on the rows that have been waiting longest.
  const projectIds = [...new Set(board.ready.map((r) => r.projectId))].slice(0, max);
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, title: true, aryeoListingId: true },
  });
  const byId = new Map(projects.map((p) => [p.id, p] as const));

  const jobs: ReadySweepJob[] = [];
  let closed = 0;
  let stamped = 0;
  let unread = 0;
  // One pass per LISTING. Both passes below now range over every project the
  // listing carries (projectsSharingListing), so the second job at an address
  // has already been evaluated by the first job's turn — going round again
  // would buy a second Aryeo read of the same listing and reach the same answer.
  const listingsDone = new Set<string>();
  for (const id of projectIds) {
    if (Date.now() > deadline) break;
    const p = byId.get(id);
    if (!p) continue;
    if (p.aryeoListingId && listingsDone.has(p.aryeoListingId)) continue;
    const row = (note: string, extra?: Partial<ReadySweepJob>) =>
      jobs.push({ projectId: id, title: p.title, note, closedCards: 0, stampedCuts: 0, wouldClose: [], wouldStamp: [], ...extra });
    if (!p.aryeoListingId) {
      row("no Aryeo listing on this job — nothing to check it against");
      continue;
    }
    listingsDone.add(p.aryeoListingId);
    let listing: Awaited<ReturnType<typeof Aryeo.listing>> | null = null;
    try {
      listing = await Aryeo.listing(p.aryeoListingId);
    } catch (e) {
      // Aryeo having a bad minute. The job keeps the counts it had, they keep
      // their old timestamp, and the card goes on saying it cannot see.
      unread++;
      row(`Aryeo wouldn't answer for this listing (${(e instanceof Error ? e.message : String(e)).slice(0, 60)}) — nothing changed`);
      continue;
    }

    // File what we just saw, whatever else happens below: the card's evidence
    // line is worth the read on its own.
    if (!opts?.dryRun) {
      const { refreshListingEvidence } = await import("@/lib/projectStatus");
      await refreshListingEvidence(id, listing).catch(() => null);
    }

    const delivery = (listing?.delivery_status ?? "").toUpperCase() || null;
    if (delivery !== "DELIVERED") {
      row(`Aryeo has this listing as ${delivery ?? "unknown"}, so nothing there has reached the client — left alone`);
      continue;
    }

    const cards = await closeKylesUploadCards(id, listing, null, { dryRun: opts?.dryRun }).catch(() => null);
    if (!cards) {
      row("couldn't read this job's 1080p jobs — left alone");
      continue;
    }
    const cuts = await stampCutsTheDeliveryCovers(id, listing, { dryRun: opts?.dryRun }).catch(
      () => ({ stamped: 0, held: 0, wouldStamp: [] as string[] }),
    );
    closed += cards.closed;
    stamped += cuts.stamped;
    const said = [
      cards.closed > 0 ? `closed ${cards.closed} upload card${cards.closed > 1 ? "s" : ""}` : null,
      cuts.stamped > 0 ? `marked ${cuts.stamped} video${cuts.stamped > 1 ? "s" : ""} as gone to the client` : null,
      opts?.dryRun && cards.wouldClose.length > 0 ? `WOULD close ${cards.wouldClose.length} upload card(s)` : null,
      opts?.dryRun && cuts.wouldStamp.length > 0 ? `WOULD mark ${cuts.wouldStamp.length} video(s) sent` : null,
    ].filter(Boolean);
    row(
      said.length > 0
        ? said.join("; ")
        : "Aryeo's listing carries no video that can only be this job's unsent cut — left on the card for Kyle",
      { closedCards: cards.closed, stampedCuts: cuts.stamped, wouldClose: cards.wouldClose, wouldStamp: cuts.wouldStamp },
    );
    if (!opts?.dryRun && (cards.closed > 0 || cuts.stamped > 0)) await refreshSurfaces(id);
  }
  return { looked: jobs.length, closed, stamped, unread, jobs };
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
