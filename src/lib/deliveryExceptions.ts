import "server-only";

import { prisma } from "@/lib/prisma";
import { parseEvidence } from "@/lib/statusEvidence";
import { getListingMedia } from "@/lib/integrations/aryeo";
import { isTestClientName } from "@/lib/testClients";
import { laneStillOwesWork } from "@/lib/readyToSend";
import type { ProactiveFlag } from "@/lib/queries";

// ---------------------------------------------------------------------------
// DELIVERY EXCEPTIONS — what the hub cannot confirm went to the client.
//
// WHY THIS EXISTS. Sep 17 2026 the reconciliation of the previously "delivered"
// jobs was run off Project.statusEvidence and reported sixteen jobs as owed.
// Thirteen of them were fine. The cached blob is the trap: the hourly status
// sweep stops carrying a job seven days after its deliveredAt (projectStatus.ts,
// the DELIVERED rider), so on a delivered job the Aryeo half of that blob is
// frozen at whatever it last saw — and a frozen `videos: 0` reads exactly like
// a confident one. Same lesson lib/readyToSend learned the same evening on 2051
// Old Sumneytown Pike. So this module never reads the cached counts for the
// Aryeo side. It buys a LIVE listing read per job, every run.
//
// AND THE STAMP IS NOT EVIDENCE EITHER. 1,524 projects carry a deliveredAt and
// none of them carries a deliveredBy or a deliveredVia: measured Sep 18, on
// production. Every one of these sixteen reads "Status re-evaluated: REVIEW →
// DELIVERED. All ordered deliverables confirmed live on Aryeo." — the hourly
// sweep's own sentence, not a person's. 626 Greycliffe Ln is the whole argument
// in one job: the sweep stamped it DELIVERED at 23:02 on Sep 3, the delivery
// text auto-sent at 13:02 the next day, and at 17:05 Gary texted "I'm looking
// for the social media video for Greycliffe". A stamp a machine wrote about
// itself proves nothing about what a client can open.
//
// EVIDENCE IS NOT SYMMETRIC, and this module treats the halves differently:
//   · what a read SAW still stands — media does not un-deliver, so a Dropbox
//     Final count from a week ago is still proof the work exists;
//   · what a read DID NOT see proves nothing unless the read succeeded NOW,
//     which is why an unreadable listing produces "cannot tell" and NEVER an
//     exception. An Aryeo outage must not flag the back catalogue.
//
// WHAT IT MAY DO, AND WHAT IT MAY NOT. The only write in this file is
// Project.deliveryExceptionAt/Note, raised once, through raiseDeliveryException
// below. It is a flag, never an action. It does not text, resend, close a task,
// move a status or touch deliveredAt — projectStatus.ts:1151-1167 settles that
// argument for good ("Delivery is a HUMAN fact — the client has the files — and
// no cross-check of Aryeo and Dropbox gets to overrule it"), and the chain a
// status change would start is real: syncProjectStatuses' `final === "DELIVERED"`
// branch calls createDeliveryTextTask, which mints the delivery_text SmartTask
// that sweepDeliveryTexts sends from. Nothing in this module can reach any of
// it. There is no import here that can send, and the one UPDATE names its two
// columns as a literal.
// ---------------------------------------------------------------------------

/** The four things an Aryeo listing can carry, in the status engine's own words. */
export type DeliveryLane = "VIDEO" | "PHOTOS" | "FLOORPLAN" | "THREED";

const LANE_OF_EXPECTED: Record<string, DeliveryLane> = {
  Video: "VIDEO",
  Photos: "PHOTOS",
  "Floor plan": "FLOORPLAN",
  "3D tour": "THREED",
};

export const laneLabel = (lane: DeliveryLane): string =>
  lane === "VIDEO" ? "Video" : lane === "PHOTOS" ? "Photos" : lane === "FLOORPLAN" ? "Floor plan" : "3D tour";

export type LaneVerdict =
  /** live on a listing Aryeo reports as delivered — the client can open it */
  | "ON_THE_LISTING"
  /** not on the listing, but a person marked this cut sent to the client */
  | "SENT_ANOTHER_WAY"
  /** the work is not finished yet — nothing to reconcile, and nobody is late by this test */
  | "IN_PRODUCTION"
  /** the work exists in our Dropbox and the client has no way to see it */
  | "OWED"
  /** the evidence disagrees with itself, or there is none */
  | "CANNOT_TELL";

export type DeliveryVerdict = "DELIVERED" | "DELIVERED_ANOTHER_WAY" | "IN_PRODUCTION" | "OWED" | "CANNOT_TELL";

/** Worst-first, so a job takes the verdict of its worst lane. */
const VERDICT_RANK: Record<LaneVerdict, number> = {
  OWED: 0,
  CANNOT_TELL: 1,
  IN_PRODUCTION: 2,
  SENT_ANOTHER_WAY: 3,
  ON_THE_LISTING: 4,
};

export type ListingRead =
  | {
      readable: true;
      /** Aryeo's own word: DELIVERED | UNDELIVERED. Media on an UNDELIVERED listing is not released. */
      deliveryStatus: string | null;
      photos: number;
      videos: number;
      floorPlans: number;
      videoTitles: string[];
      atISO: string;
    }
  | { readable: false; why: "no-listing-id" | "order-missing-from-aryeo" | "read-failed" };

export type DeliveryInput = {
  projectId: string;
  street: string;
  status: string;
  deliveredAt: Date | null;
  deliveredBy: string | null;
  deliveredVia: string | null;
  /** expected categories, straight off the evidence blob's own words */
  expected: DeliveryLane[];
  /** ordered VIDEO + SOCIAL_REEL quantity, summed */
  orderedVideoSlots: number;
  /** product titles of the rows that put PHOTOS into `expected` */
  photoLaneProducts: string[];
  /** Dropbox FINAL counts. Positive facts only — an old count still proves the work exists. */
  dropboxFinalVideo: number | null;
  dropboxFinalPhotos: number | null;
  /** ReviewSubmissions a person (or the aryeoDelivery proof pass) stamped sentToClientAt */
  cutsSentToClient: number;
  /**
   * Approved cuts nobody has marked sent, split by whether the 1080p lane has
   * finished with them — readyToSend.laneStillOwesWork is the arbiter, asked
   * rather than re-implemented. A cut whose render is still running is not a
   * video the client is owed: it is a video that does not exist yet. 358 N
   * Church St was approved at 00:45 and read `processing` at 00:55, and an
   * earlier draft of this pass wanted to raise an exception on it.
   */
  finishedCutsUnsent: number;
  renderingCutsUnsent: number;
  listing: ListingRead;
  exceptionAt: Date | null;
  exceptionNote: string | null;
  /** what the CACHED evidence blob last recorded, for the drift measurement only */
  cachedAryeoVideos: number | null;
  cachedAryeoPhotos: number | null;
};

export type LaneFinding = { lane: DeliveryLane; verdict: LaneVerdict; why: string };

export type DeliveryClassification = {
  projectId: string;
  street: string;
  status: string;
  deliveredAt: Date | null;
  verdict: DeliveryVerdict;
  lanes: LaneFinding[];
  /** one sentence a human can act on — this becomes deliveryExceptionNote */
  note: string;
  /** the evidence lines, for the console and for anyone checking the verdict */
  facts: string[];
  /**
   * Whether this deserves a flag. OWED and a MEASURED "cannot tell" do; a
   * "cannot tell" that exists only because we could not read Aryeo does NOT —
   * see the asymmetry note at the top.
   */
  flagWorthy: boolean;
  alreadyFlagged: boolean;
  /**
   * How far the cached evidence blob was behind the live listing, per lane.
   * Not used in the verdict — it is the measurement of the trap itself, so the
   * pass can state how much of the "16 owed" report was stale cache rather than
   * missing work.
   */
  cacheDrift: { lane: DeliveryLane; cached: number; live: number }[];
};

// A product name that names photography, and one that only names video. The
// status engine's CATEGORY_KEYWORDS put /drone|aerial/ in the PHOTOS lane, so
// "Drone Videography" — a video product — makes a job expect listing images.
// That is the same shape as the "Custom Branding Video Package 16 Videos Total"
// bug the Sep 16 audit fixed one keyword along, and it is still live for
// videography: 45 Heron Hill Dr expects Photos and ordered none. This module
// does not fix the mapping (that is projectStatus.ts's to fix); it refuses to
// call a job OWED on the strength of it.
const NAMES_VIDEO = /video|videograph|reel|cinematic|walkthrough|walk-through|motion|teaser|vertical/i;
const NAMES_PHOTOGRAPHY = /photo|hdr|image|gallery|twilight|dusk|headshot|portrait|virtual stag/i;

const photosExpectationIsAProductNameArtifact = (products: string[]): boolean =>
  products.length > 0 && products.every((t) => NAMES_VIDEO.test(t) && !NAMES_PHOTOGRAPHY.test(t));

const listingIsReleased = (l: Extract<ListingRead, { readable: true }>): boolean =>
  (l.deliveryStatus ?? "").toUpperCase() === "DELIVERED";

const countFor = (lane: DeliveryLane, l: Extract<ListingRead, { readable: true }>): number =>
  lane === "VIDEO" ? l.videos : lane === "PHOTOS" ? l.photos : lane === "FLOORPLAN" ? l.floorPlans : 0;

/**
 * Pure. No database, no network — hand it the facts and it returns the verdict,
 * so the classification can be argued with (and tested) without spending an
 * Aryeo read.
 */
export function classifyDelivery(input: DeliveryInput): DeliveryClassification {
  const facts: string[] = [];
  const lanes: LaneFinding[] = [];
  const base = {
    projectId: input.projectId,
    street: input.street,
    status: input.status,
    deliveredAt: input.deliveredAt,
    alreadyFlagged: input.exceptionAt !== null,
  };

  facts.push(
    `hub says ${input.status}${input.deliveredAt ? ` · deliveredAt ${input.deliveredAt.toISOString().slice(0, 10)}` : ""} · ` +
      `actor ${input.deliveredBy ?? input.deliveredVia ?? "none recorded"}`,
  );

  if (!input.listing.readable) {
    const why =
      input.listing.why === "no-listing-id"
        ? "this job has no Aryeo listing id, so there is nothing to read"
        : input.listing.why === "order-missing-from-aryeo"
          ? "Aryeo returns not-found for this order (flagOrphanedOrders owns it)"
          : "the live listing read failed";
    facts.push(`LIVE listing: could not read — ${why}`);
    return {
      ...base,
      verdict: "CANNOT_TELL",
      lanes: input.expected.map((lane) => ({ lane, verdict: "CANNOT_TELL" as const, why })),
      note: `Unconfirmed — ${why}.`,
      facts,
      // Never on a failed read. "We could not look" is not "nothing is there",
      // and an Aryeo outage would otherwise flag every job in one pass.
      flagWorthy: false,
      cacheDrift: [],
    };
  }

  const live = input.listing;
  const released = listingIsReleased(live);
  facts.push(
    `LIVE listing (${live.atISO.slice(0, 16)}): videos ${live.videos} · images ${live.photos} · floor plans ${live.floorPlans} · Aryeo says ${live.deliveryStatus ?? "no delivery status"}`,
  );
  if (live.videoTitles.length) facts.push(`  listing videos: ${live.videoTitles.map((t) => `"${t}"`).join(", ")}`);
  facts.push(
    `Dropbox Final: video ${input.dropboxFinalVideo ?? "?"} · photos ${input.dropboxFinalPhotos ?? "?"} · ` +
      `cuts marked sent ${input.cutsSentToClient} · approved and unsent: ${input.finishedCutsUnsent} finished, ${input.renderingCutsUnsent} still rendering`,
  );

  for (const lane of input.expected) {
    const onListing = countFor(lane, live);
    // The 3D tour has no count of its own on the listing read — the hub has
    // never had a channel for it, so this pass can only ever say so.
    if (lane === "THREED") {
      lanes.push({ lane, verdict: "CANNOT_TELL", why: "Aryeo's listing read carries no 3D-tour count; the hub has no channel for it" });
      continue;
    }
    if (onListing > 0 && !released) {
      lanes.push({
        lane,
        verdict: "CANNOT_TELL",
        why: `${onListing} on the listing, but Aryeo still reads ${live.deliveryStatus ?? "no delivery status"} — it was never released to the client`,
      });
      continue;
    }
    if (onListing > 0) {
      // VIDEO is the one lane with a countable order behind it: one row per
      // video product, quantity included. Fewer live videos than ordered slots
      // is not proof of a missing video (a package can bill several cuts that
      // ship as one), so it is a question, never a debt.
      if (lane === "VIDEO" && input.orderedVideoSlots > onListing) {
        lanes.push({
          lane,
          verdict: "CANNOT_TELL",
          why: `${onListing} video${onListing === 1 ? "" : "s"} on the listing against ${input.orderedVideoSlots} ordered`,
        });
        continue;
      }
      lanes.push({ lane, verdict: "ON_THE_LISTING", why: `${onListing} on a listing Aryeo reports delivered` });
      continue;
    }
    // Nothing of this lane on the listing.
    if (lane === "VIDEO" && input.cutsSentToClient > 0) {
      lanes.push({
        lane,
        verdict: "SENT_ANOTHER_WAY",
        why: `${input.cutsSentToClient} cut${input.cutsSentToClient === 1 ? "" : "s"} carry sentToClientAt — a person, or the aryeoDelivery proof pass, recorded the send`,
      });
      continue;
    }
    // FINISHED VIDEO, TWO WAYS TO KNOW IT. A file in the Dropbox Final folder,
    // or an approved cut the render lane has finished with — including a FAILED
    // pass, where the editor's own export is the deliverable (readyToSend case
    // b, 322 N 62nd St). Counted as a max rather than a sum: 893 S Matlack's
    // six Final files and its one approved cut are the same work seen twice,
    // and "7 finished files" would be a number nobody could check.
    const finishedVideo = Math.max(input.dropboxFinalVideo ?? 0, input.finishedCutsUnsent);
    const inFinal = lane === "VIDEO" ? finishedVideo : lane === "PHOTOS" ? input.dropboxFinalPhotos ?? 0 : 0;
    if (lane === "VIDEO" && inFinal === 0 && input.renderingCutsUnsent > 0) {
      lanes.push({
        lane,
        verdict: "IN_PRODUCTION",
        why: `${input.renderingCutsUnsent} approved cut${input.renderingCutsUnsent === 1 ? " is" : "s are"} still in the 1080p lane — there is no finished file to be owed yet`,
      });
      continue;
    }
    if (lane === "PHOTOS" && photosExpectationIsAProductNameArtifact(input.photoLaneProducts)) {
      lanes.push({
        lane,
        verdict: "CANNOT_TELL",
        why:
          `no images on the listing, and the only products behind the Photos expectation are video ones ` +
          `(${input.photoLaneProducts.map((p) => `"${p}"`).join(", ")}) — the expectation itself may be a product-name artifact` +
          (inFinal > 0 ? `, yet ${inFinal} finished photos sit in the Final folder` : ""),
      });
      continue;
    }
    if (inFinal > 0) {
      lanes.push({
        lane,
        verdict: "OWED",
        why: `${inFinal} finished file${inFinal === 1 ? "" : "s"} in the Dropbox Final folder and nothing on the listing`,
      });
      continue;
    }
    lanes.push({
      lane,
      verdict: "CANNOT_TELL",
      why: "nothing on the listing and nothing finished in Dropbox — the hub cannot see this being produced at all",
    });
  }

  // A 3D tour the hub has no channel for cannot be the reason a job is called
  // uncertain — it would be the reason for EVERY job that ordered one, which is
  // noise, not a finding. It stays in the lane list so the report is honest
  // about what was and was not checked, and out of the verdict.
  const actionable = lanes.filter((l) => !(l.lane === "THREED" && l.verdict === "CANNOT_TELL"));
  const worst = actionable.length
    ? actionable.reduce<LaneVerdict>((w, l) => (VERDICT_RANK[l.verdict] < VERDICT_RANK[w] ? l.verdict : w), "ON_THE_LISTING")
    : null;
  const finalVerdict: DeliveryVerdict =
    worst === "OWED"
      ? "OWED"
      : worst === "CANNOT_TELL"
        ? "CANNOT_TELL"
        : worst === "IN_PRODUCTION"
          ? "IN_PRODUCTION"
          : worst === "SENT_ANOTHER_WAY"
            ? "DELIVERED_ANOTHER_WAY"
            : worst === "ON_THE_LISTING"
              ? "DELIVERED"
              : // nothing this pass has a channel for — say so, flag nobody
                "CANNOT_TELL";

  const problems = actionable.filter((l) => l.verdict === "OWED" || l.verdict === "CANNOT_TELL");
  const lead = finalVerdict === "OWED" ? "Owed" : "Unconfirmed";
  const when = input.deliveredAt
    ? `marked delivered ${input.deliveredAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })} with no person named`
    : `never marked delivered (the job reads ${input.status})`;
  const clean =
    finalVerdict === "DELIVERED_ANOTHER_WAY"
      ? "Confirmed — not on the listing, but the send is recorded against the cut itself."
      : finalVerdict === "DELIVERED"
        ? "Confirmed — every ordered category is live on a listing Aryeo reports delivered."
        : finalVerdict === "IN_PRODUCTION"
          ? "Nothing owed yet — the work is still in the 1080p lane."
          : "Unconfirmed — nothing this pass can read speaks to what was ordered.";
  const note =
    problems.length === 0
      ? clean
      : `${lead} — ${when}: ${problems.map((p) => `${laneLabel(p.lane).toLowerCase()} — ${p.why}`).join("; ")}. Check what actually went out before counting this delivered.`;

  const cacheDrift: { lane: DeliveryLane; cached: number; live: number }[] = [];
  if (input.cachedAryeoVideos !== null && input.cachedAryeoVideos !== live.videos) {
    cacheDrift.push({ lane: "VIDEO", cached: input.cachedAryeoVideos, live: live.videos });
  }
  if (input.cachedAryeoPhotos !== null && input.cachedAryeoPhotos !== live.photos) {
    cacheDrift.push({ lane: "PHOTOS", cached: input.cachedAryeoPhotos, live: live.photos });
  }

  return { ...base, verdict: finalVerdict, lanes, note: note.slice(0, 500), facts, flagWorthy: problems.length > 0, cacheDrift };
}

// ---------------------------------------------------------------------------
// THE ONLY WRITE IN THIS FILE.
// ---------------------------------------------------------------------------

/**
 * Raise the flag, once. Returns "raised" only when a row actually changed.
 *
 * RAW SQL ON PURPOSE. Project.updatedAt is `@updatedAt`, so the Prisma update
 * would restamp it — and syncProjectStatuses selects its hourly candidates
 * `orderBy: { updatedAt: "desc" }, take: 80`. Flagging two REVIEW jobs through
 * Prisma would push them to the head of that queue and two other live jobs off
 * the end of it. A flag must cost the rest of the hub nothing, so this names
 * its two columns and touches nothing else.
 *
 * `deliveryExceptionAt IS NULL` in the WHERE is what makes the pass idempotent
 * and what makes the flag the human's: once raised, neither a re-run nor a
 * later, differently-worded verdict may overwrite the sentence somebody is
 * working from. The schema is explicit that no engine may clear it either.
 */
export async function raiseDeliveryException(
  projectId: string,
  note: string,
  at: Date = new Date(),
): Promise<"raised" | "already-flagged"> {
  const rows = await prisma.$executeRaw`
    UPDATE "Project"
       SET "deliveryExceptionAt" = ${at}, "deliveryExceptionNote" = ${note.slice(0, 500)}
     WHERE "id" = ${projectId}
       AND "deliveryExceptionAt" IS NULL`;
  return rows === 1 ? "raised" : "already-flagged";
}

// ---------------------------------------------------------------------------
// THE PASS
// ---------------------------------------------------------------------------

export type ReconcileOptions = {
  /** raise exceptions for the jobs that earn one. Default false — the pass is a report. */
  write?: boolean;
  /** cap the live Aryeo reads. */
  limit?: number;
  /** include synthetic TEST jobs (default false). */
  includeTest?: boolean;
  onJob?: (c: DeliveryClassification) => void;
};

export type ReconcileResult = {
  scanned: number;
  candidates: number;
  skippedTest: number;
  classifications: DeliveryClassification[];
  raised: { projectId: string; street: string; note: string }[];
  alreadyFlagged: { projectId: string; street: string; note: string | null }[];
  unreadable: { projectId: string; street: string; why: string }[];
};

/**
 * WHO IS A CANDIDATE. Every job whose own records contain a reason to doubt the
 * delivery, which is a much smaller set than "every delivered job" — 21 of
 * 1,559 on Sep 18 — and each one costs a live Aryeo read:
 *   (a) it is already flagged (so a re-run re-checks it and reports movement);
 *   (b) the hub's evidence says an ordered category is finished in our Dropbox
 *       and absent from Aryeo — the original sixteen;
 *   (c) an APPROVED cut exists that nobody has marked sent (lib/readyToSend's
 *       own population);
 *   (d) the evidence blob's own awaitingSend list is not empty.
 * A job with none of these has no internal contradiction to reconcile, and
 * buying 1,517 listing reads to re-confirm what the sweep already confirmed is
 * not a reconciliation — it is a re-sweep, and it is the sweep's job.
 */
export async function reconcileDeliveries(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const projects = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    select: {
      id: true,
      title: true,
      status: true,
      deliveredAt: true,
      deliveredBy: true,
      deliveredVia: true,
      aryeoListingId: true,
      aryeoMissingAt: true,
      statusEvidence: true,
      deliveryExceptionAt: true,
      deliveryExceptionNote: true,
      client: { select: { name: true } },
      deliverables: {
        where: { removedFromOrderAt: null },
        select: { type: true, label: true, productTitle: true, quantity: true },
      },
      reviewSubmissions: {
        select: { status: true, sentToClientAt: true, topazJob: { select: { state: true } } },
      },
    },
    orderBy: { deliveredAt: "desc" },
  });

  const result: ReconcileResult = {
    scanned: projects.length,
    candidates: 0,
    skippedTest: 0,
    classifications: [],
    raised: [],
    alreadyFlagged: [],
    unreadable: [],
  };

  const candidates = projects.filter((p) => {
    if (p.deliveryExceptionAt) return true;
    const e = parseEvidence(p.statusEvidence);
    const finishedButAbsent = !!(
      e &&
      e.aryeo &&
      e.dropbox &&
      ((e.aryeo.videos === 0 && e.dropbox.finalVideo > 0 && e.expected.includes("Video")) ||
        (e.aryeo.photos === 0 && e.dropbox.finalPhotos > 0 && e.expected.includes("Photos")))
    );
    const approvedUnsent = p.reviewSubmissions.some((r) => r.status === "APPROVED" && !r.sentToClientAt);
    const awaitingSend = !!(e && e.awaitingSend.length > 0);
    return finishedButAbsent || approvedUnsent || awaitingSend;
  });

  const live = candidates.filter((p) => {
    // Synthetic clients live in production next to real ones (testClients.ts).
    // They are not a delivery anybody is owed.
    if (!opts.includeTest && (isTestClientName(p.client?.name) || isTestClientName(p.title))) {
      result.skippedTest++;
      return false;
    }
    return true;
  });
  const chosen = opts.limit ? live.slice(0, opts.limit) : live;
  result.candidates = chosen.length;

  for (const p of chosen) {
    const e = parseEvidence(p.statusEvidence);
    let listing: ListingRead;
    if (p.aryeoMissingAt) {
      listing = { readable: false, why: "order-missing-from-aryeo" };
    } else if (!p.aryeoListingId) {
      listing = { readable: false, why: "no-listing-id" };
    } else {
      const m = await getListingMedia(p.aryeoListingId);
      listing = m
        ? {
            readable: true,
            deliveryStatus: m.deliveryStatus,
            photos: m.photoCount,
            videos: m.videoCount,
            floorPlans: m.floorPlanCount,
            videoTitles: m.videos.map((v) => v.title ?? "untitled"),
            atISO: new Date().toISOString(),
          }
        : { readable: false, why: "read-failed" };
    }

    const expected = (e?.expected ?? [])
      .map((w) => LANE_OF_EXPECTED[w])
      .filter((l): l is DeliveryLane => !!l);
    const orderedVideoSlots = p.deliverables
      .filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
      .reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
    const approvedUnsent = p.reviewSubmissions.filter((r) => r.status === "APPROVED" && !r.sentToClientAt);
    const photoLaneProducts = p.deliverables
      .filter((d) => ["PHOTOS", "DRONE", "TWILIGHT", "HEADSHOT", "VIRTUAL_STAGING"].includes(d.type))
      .map((d) => d.productTitle ?? d.label ?? d.type);

    const c = classifyDelivery({
      projectId: p.id,
      street: p.title.split(",")[0],
      status: p.status,
      deliveredAt: p.deliveredAt,
      deliveredBy: p.deliveredBy,
      deliveredVia: p.deliveredVia,
      expected,
      orderedVideoSlots,
      photoLaneProducts,
      dropboxFinalVideo: e?.dropbox?.finalVideo ?? null,
      dropboxFinalPhotos: e?.dropbox?.finalPhotos ?? null,
      cutsSentToClient: p.reviewSubmissions.filter((r) => r.sentToClientAt).length,
      finishedCutsUnsent: approvedUnsent.filter((r) => !(r.topazJob && laneStillOwesWork(r.topazJob.state))).length,
      renderingCutsUnsent: approvedUnsent.filter((r) => !!r.topazJob && laneStillOwesWork(r.topazJob.state)).length,
      listing,
      exceptionAt: p.deliveryExceptionAt,
      exceptionNote: p.deliveryExceptionNote,
      cachedAryeoVideos: e?.aryeo?.videos ?? null,
      cachedAryeoPhotos: e?.aryeo?.photos ?? null,
    });

    result.classifications.push(c);
    opts.onJob?.(c);
    if (!listing.readable) result.unreadable.push({ projectId: p.id, street: c.street, why: listing.why });
    if (c.alreadyFlagged) {
      result.alreadyFlagged.push({ projectId: p.id, street: c.street, note: p.deliveryExceptionNote });
      continue;
    }
    if (c.flagWorthy && opts.write) {
      const r = await raiseDeliveryException(p.id, c.note);
      if (r === "raised") result.raised.push({ projectId: p.id, street: c.street, note: c.note });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// SURFACING IT — the owner's radar, not a fourteenth home screen.
//
// queries.ts getProactiveFlags is the machinery that already puts "X owes $Y"
// and "this job is stuck in revision" on the dashboard, sorted by severity and
// capped at three. A delivery the hub cannot confirm belongs in exactly that
// list, and the row below is shaped to drop into it: `DeliveryExceptionFlag` is
// ProactiveFlag with its own `kind`, so if that type ever changes shape this
// file stops compiling instead of quietly drifting.
//
// This is a plain column read — no Aryeo, no Dropbox — so it costs the
// dashboard one indexed query. The exception was decided by the pass, in one
// place, and written down; the screen only reads it. That is the same division
// lib/readyToSend settled on ("One decision, one place, and a record of it").
//
// NOT YET ON THE DASHBOARD. The splice into getProactiveFlags is two lines and
// it is deliberately not made here: queries.ts was outside this change's remit
// while other work was in flight on it, and a half-merged edit to that file is
// worse than a day's delay. What it needs, verbatim:
//
//   1. queries.ts:1408 — widen the union:
//        kind: "ar" | "vip-quiet" | "revision" | "delivery-exception";
//   2. inside getProactiveFlags, alongside the other three branches:
//        try { flags.push(...(await deliveryExceptionFlags())); } catch { }
//
// The AR branch is already filtered out for non-owners on the dashboard
// (page.tsx `f.kind !== "ar"`), and a delivery exception carries no money, so
// it is correct for Kyle to see it — he is the person who would act on it.
// ---------------------------------------------------------------------------

export type DeliveryExceptionFlag = Omit<ProactiveFlag, "kind"> & { kind: "delivery-exception" };

export async function deliveryExceptionFlags(limit = 3): Promise<DeliveryExceptionFlag[]> {
  const rows = await prisma.project.findMany({
    where: { deliveryExceptionAt: { not: null } },
    select: { id: true, title: true, deliveryExceptionAt: true, deliveryExceptionNote: true },
    orderBy: { deliveryExceptionAt: "desc" },
    take: limit,
  });
  return rows.map((p) => ({
    id: `delivery-exception-${p.id}`,
    // "Owed" is a client waiting on a file; "Unconfirmed" is a question. The
    // pass writes the lead word, so the severity needs no second source.
    severity: (p.deliveryExceptionNote ?? "").startsWith("Owed") ? ("high" as const) : ("medium" as const),
    kind: "delivery-exception" as const,
    title: `${p.title.split(",")[0]} — delivery not confirmed`,
    detail: p.deliveryExceptionNote ?? "Flagged by the delivery reconciliation",
    href: `/projects/${p.id}`,
  }));
}
