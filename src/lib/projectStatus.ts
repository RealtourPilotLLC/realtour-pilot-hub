import "server-only";
import { prisma } from "@/lib/prisma";
import type { ProjectStatus } from "@prisma/client";
import { Aryeo, type AryeoListing } from "@/lib/integrations/aryeo";
import { dropboxConfigured } from "@/lib/integrations/dropbox";
import { getSecret } from "@/lib/integrations/connections";
import { actualFolderPaths, folderFileCount } from "@/lib/dropboxFolders";
import { deliveryPromiseFor, deliveryDueFrom, slaTierOf, videoAnchorFor, OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import type { NotifyTarget } from "@/lib/notify";
import { photoTargetFor, RAW_OVERAGE_FACTOR, BRACKET_RATIO } from "@/lib/culling";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { parseEvidence } from "@/lib/statusEvidence";
import { reviewRoomRules } from "@/lib/settings";
import { holdStands, loadWaitingHolds, releaseWaitingHold } from "@/lib/queueWaiting";

// ---------------------------------------------------------------------------
// Smart project-status engine.
//
// Aryeo flips an order to FULFILLED the moment ANY media is delivered — so when
// we send photos early and the video later, the order looks "done" while work
// remains. Kyle forgets to un-toggle it. This engine ignores that single flag
// and instead figures out the TRUE stage by cross-checking, per ordered item:
//   • what was ordered  (parsed from the order's line items)            EXPECTED
//   • what's live on the Aryeo listing (photos/videos/floor-plans/3D)   PRESENT
//   • what's sitting in the Dropbox raw/final folders                   IN-FLIGHT
// A job is only DELIVERED when every expected category is actually present.
// "Fulfilled on Aryeo but a category missing" → REVIEW, flagged as a partial.
// ---------------------------------------------------------------------------

export type MediaCategory = "PHOTOS" | "VIDEO" | "FLOORPLAN" | "THREED";

const CATEGORY_LABEL: Record<MediaCategory, string> = {
  PHOTOS: "Photos",
  VIDEO: "Video",
  FLOORPLAN: "Floor plan",
  THREED: "3D tour",
};

// Keyword → category. A single line item can imply several categories
// (e.g. "Gold Package + Video + Floor Plan"), so we scan for ALL matches.
const CATEGORY_KEYWORDS: [RegExp, MediaCategory][] = [
  [/floor\s?plan|2d plan|iguide/i, "FLOORPLAN"],
  [/matterport|3d tour|3-d|zillow 3d|virtual tour|interactive tour/i, "THREED"],
  [/reel|video|cinematic|walkthrough|walk-through|motion|social media|teaser|vertical/i, "VIDEO"],
  // Photos: only words that NAME photography — the photo add-ons that are
  // delivered as listing images (twilight, drone, headshots, virtual staging)
  // included. The bundle words (package|bundle|bronze|silver|gold|platinum|
  // diamond|essential) used to live here too, and that was the bug: a label is
  // scanned for EXTRA categories beyond the row's own type, so "Custom
  // Branding Video Package 16 Videos Total" — a video-only product — expected
  // Photos, read "Partial delivery — still missing Photos" and minted a false
  // "Chase AutoHDR photo edits" (Sharra Mercer #1584, Sep 16 audit; 1 of 38
  // live jobs). Packages belong to the product mapping in aryeo.ts, which
  // already expands them into typed rows — this scan must not second-guess it.
  [/photo|hdr|image|gallery|twilight|dusk|drone|aerial|headshot|portrait|virtual stag/i, "PHOTOS"],
];

export function categoriesForLabel(label: string): MediaCategory[] {
  const out: MediaCategory[] = [];
  for (const [re, cat] of CATEGORY_KEYWORDS) if (re.test(label) && !out.includes(cat)) out.push(cat);
  return out;
}

// Content goes out staged: photos next day, then the video/reel. A pending
// reel isn't "missing" until its turnaround window passes — and that window is
// the SINGLE source of truth in tasks.ts (`deliveryDueFrom`: standard 48h,
// premium 72h, monthly content 7-10 business days). computeStatus calls it so
// the status card, delivery-due, and QA task never disagree.
export type VideoTier = "standard" | "premium";
// Premium = the higher-end reel products (longer edit). Tune these keywords.
// "Standard Cinematic Video" is a STANDARD product — an explicit "standard"
// vetoes the premium words (matches aryeo.ts isPremiumProduct; the audit
// caught the two regexes disagreeing on cinematic variants).
const PREMIUM_VIDEO_RE = /premium|influencer|cinematic|luxury|signature|elite|flagship/i;
const STANDARD_VETO_RE = /\bstandard\b/i;

// Classify a project's video deliverable as standard vs premium (or null if no
// video was ordered) — by the order item's product name.
export function videoTier(deliverables: { type: string; label: string | null }[]): VideoTier | null {
  let hasVideo = false;
  let premium = false;
  for (const d of deliverables) {
    if (!expectedCategories([d]).has("VIDEO")) continue;
    hasVideo = true;
    if (PREMIUM_VIDEO_RE.test(d.label ?? "") && !STANDARD_VETO_RE.test(d.label ?? "")) premium = true;
  }
  if (!hasVideo) return null;
  return premium ? "premium" : "standard";
}

// One place to ask "is this video job's SLA blown, and by how much?" — the
// /editing countdown, the /edit header line, and any later dashboard read all
// agree by calling this instead of recomputing the window. Returns null when
// there's no video ordered or no shoot date to anchor the SLA. `due` is the
// VIDEO delivery-due (shootDate + standard/premium/monthly window); `overdue`
// is past-due with the cut not yet delivered; `msRemaining` is negative when
// overdue (drives the red "OVERDUE 2d" chip). Pure — safe on client via a prop.
export function getVideoSlaStatus(p: {
  shootDate: Date | null;
  status?: string | null;
  deliverables: { type: string; label: string | null }[];
  client?: { socialClient?: boolean | null } | null;
  /** the job's appointment legs — the video clock runs from the LAST one that
   *  has happened, not from Project.shootDate (see videoAnchorFor). Optional:
   *  a caller that hasn't loaded them keeps the old shootDate reading.
   *
   *  NOTE for whoever owns those files: the two live callers — /edit/[id]'s
   *  header ("cut due") and lib/queries.ts's owner dial (the past-SLA count) —
   *  still pass only { shootDate, status, deliverables, client }, so BOTH
   *  still date a second-visit reel from the first visit and ignore the
   *  office's tier. Each needs appointments + tierOverride + packageName added
   *  to its select and passed through here; left alone on purpose, those two
   *  files are outside this batch's file set. */
  appointments?: { status: string | null; startAt: Date | null }[];
  /** the office's tier (Sep 16) — branding → monthly, premium → 72h */
  tierOverride?: string | null;
  packageName?: string | null;
}): { tier: VideoTier; due: Date; overdue: boolean; msRemaining: number } | null {
  const tier = videoTier(p.deliverables);
  if (!tier || !p.shootDate) return null;
  const v = p.deliverables.find((d) => expectedCategories([d]).has("VIDEO"));
  // THE OFFICE'S TIER decides the window when it is set; otherwise the hub's
  // own reading of the product (slaTierOf is that ladder, stated once).
  const sla = slaTierOf({ tierOverride: p.tierOverride ?? null, packageName: p.packageName ?? null, deliverables: p.deliverables });
  const anchor = videoAnchorFor(p) ?? p.shootDate;
  const due = deliveryDueFrom(anchor, v?.type ?? "SOCIAL_REEL", {
    premium: sla === "premium",
    monthlyContent: sla === "branding",
  });
  const msRemaining = due.getTime() - Date.now();
  // A video already delivered isn't "overdue" even past its window.
  const delivered = (p.status ?? "").toUpperCase() === "DELIVERED";
  return { tier, due, overdue: !delivered && msRemaining < 0, msRemaining };
}

// Derive the set of media categories an order is expected to deliver from its
// line items (the Deliverable rows mirror the Aryeo order items).
export function expectedCategories(
  deliverables: { type: string; label: string | null }[],
): Set<MediaCategory> {
  const set = new Set<MediaCategory>();
  for (const d of deliverables) {
    // Trust the parsed type first, then keyword-scan the label for extras.
    switch (d.type) {
      case "PHOTOS":
      case "TWILIGHT":
      case "DRONE":
      case "HEADSHOT":
      case "VIRTUAL_STAGING":
        set.add("PHOTOS");
        break;
      case "VIDEO":
      case "SOCIAL_REEL":
        set.add("VIDEO");
        break;
      case "FLOORPLAN":
        set.add("FLOORPLAN");
        break;
      case "MATTERPORT_3D":
      case "ZILLOW_3D":
        set.add("THREED");
        break;
    }
    for (const c of categoriesForLabel(d.label ?? "")) set.add(c);
  }
  return set;
}

// ---- signals + decision ----------------------------------------------------

export type AryeoMediaSignal = {
  photos: number;
  videos: number;
  floorPlans: number;
  interactive: number;
  delivery: string | null; // listing delivery_status: DELIVERED | UNDELIVERED
  cover: string | null; // first live listing image (thumb) — the My Shoots card swap
  /** ISO time of the listing read these counts came from.
   *
   *  The blob's own `checkedAt` is the time of the WHOLE pass, and until Sep 17
   *  that was the only clock on the Aryeo half. It stopped being good enough
   *  the moment the Aryeo block could be refreshed on its own
   *  (refreshListingEvidence, below): a reader has to be able to tell how old
   *  THESE counts are, not how old the pass that last touched the row was. */
  at?: string;
  /** EVERY video on the listing, not just how many.
   *
   *  A COUNT CANNOT ANSWER THE ONLY QUESTION THAT MATTERS about a finished
   *  video: "is the video up there the one we owe, or the one we are
   *  replacing?" Both read as `videos: 1`. Ready-to-send (lib/readyToSend) and
   *  the Aryeo delivery webhook (lib/aryeoDelivery) both have to tell those
   *  apart, and Aryeo's ids are UUIDv7 — the first 48 bits are the moment the
   *  video was created — so keeping the ids turns a number into a timeline.
   *  The title and duration come along because they are what a person
   *  recognises a file by ("Cinematic video Revision", 60s).
   *
   *  It costs NOTHING to collect: the listing read already asks for
   *  `include=…,videos,…` and the array is sitting in the response.
   *
   *  Optional, and every reader must treat its absence as "we do not know"
   *  rather than "there are none": blobs written before Sep 17 2026 have no
   *  such field and are still on 1,500 jobs. */
  videoList?: { id: string; title: string | null; duration: number | null }[];
};

export type DropboxSignal = {
  rawPhotos: number;
  rawVideo: number;
  finalPhotos: number;
  finalVideo: number;
  /** ISO time of the read these counts came from */
  at?: string;
  /** true = this pass could NOT read Dropbox; these are the last good counts,
   *  carried forward so one 429 can't blank a job's evidence (audit HIGH:
   *  a shoot with 126 clips read as "scheduled" after a rate-limited pass). */
  stale?: boolean;
  /** why the latest read failed (e.g. too_many_requests, 401) — only when stale */
  readError?: string;
};

export type StatusSignals = {
  expected: Set<MediaCategory>;
  aryeo: AryeoMediaSignal | null;
  dropbox: DropboxSignal | null;
  fulfilled: boolean; // Aryeo order fulfilled_at present
  scheduled: boolean; // a SCHEDULED (non-cancelled) appointment exists
  anyAppt: boolean;
  /** a non-canceled appointment WITH a start time (an UNSCHEDULED/postponed row has none) */
  datedAppt: boolean;
  /** every live appointment is postponed / unscheduled — the job needs a new date */
  postponed: boolean;
  shootDate: Date | null;
  /** where the VIDEO's window opens — the last leg that has happened, which is
   *  not always shootDate on a two-visit job (videoAnchorFor) */
  videoAnchor: Date | null;
  /** The shoot hasn't happened yet (shootDate ahead, no non-canceled leg in the
   *  past). Files under this job's name can't be its raws — a same-street
   *  re-shoot found the first job's 84 raws in the shared folder and read as
   *  SHOT two days before the appointment (Sep 8 2026 audit, 1946 Rowan St). */
  shootPending: boolean;
  // Dropbox was needed but couldn't be read (not connected, or a listing call
  // FAILED — distinct from "no folders", which is a real zero). Signals here are
  // absent, not empty; don't conclude "no media" from them.
  dropboxUnavailable: boolean;
  revisionOpen: boolean; // client requested changes after delivery (comms)
  revisionNote?: string | null;
  videoTier: VideoTier | null; // standard | premium (null = no video ordered)
  videoType?: string | null; // the reel/video deliverable type (SOCIAL_REEL | VIDEO)
  monthlyContent: boolean; // recurring social-plan content (longer turnaround)
  /** RTP-06 (Sep 16 audit): what each evidence SOURCE actually did on this
   *  pass. It feeds the attempted/succeeded/error stamps and NOTHING else —
   *  computeStatus never reads it, because a status must not change shape
   *  because a read failed (that is what the anti-demotion guards are for).
   *  Optional so every existing StatusSignals literal still compiles. */
  read?: EvidenceReadOutcome;
};

/** Per-source outcome of one evidence pass.
 *    ok           — we read it and believe the numbers
 *    failed       — the call errored; the counts here are unknown, not zero
 *    skipped      — we chose not to spend the call (Aryeo already accounts for
 *                   everything ordered, so Dropbox was not asked)
 *    unavailable  — there was nothing to read from (no listing id) or the
 *                   integration is not connected at all
 *  Only `failed` makes a pass unsuccessful: a skipped source was never a
 *  question, and a stale zero from a failed one is not an absence. */
export type SourceOutcome = "ok" | "failed" | "skipped" | "unavailable";
export type EvidenceReadOutcome = { aryeo: SourceOutcome; dropbox: SourceOutcome; error: string | null };

/** The three stamps for one project's pass (RTP-06). attemptedAt moves every
 *  time we look; succeededAt ONLY when a source actually answered and nothing
 *  we tried to read failed;
 *  evidenceError carries the reason, or clears on a clean pass. Deliberately
 *  separate from statusCheckedAt, which keeps its existing meaning ("the
 *  status engine ran") because two readers and three other batches read it. */
export function evidenceStamps(
  read: EvidenceReadOutcome | undefined,
  now: Date = new Date(),
): { evidenceAttemptedAt: Date; evidenceSucceededAt?: Date; evidenceError: string | null } {
  const failed = read ? read.aryeo === "failed" || read.dropbox === "failed" : false;
  // A pass that read NOTHING is not a successful cross-check either. Both
  // sources `unavailable` — no listing id AND Dropbox not connected (that one
  // is decided batch-wide) — used to fall through to the success branch and
  // stamp a fresh succeededAt, so the card said "Cross-checked 3 minutes ago"
  // about a job nobody had looked at (Sep 16 review of RTP-06). 52 live jobs
  // carry no listing id, so the whole set would go confidently green the
  // moment the Dropbox token lapsed. Success means at least one source
  // actually answered.
  const anyRead = !!read && (read.aryeo === "ok" || read.dropbox === "ok");
  if (!read || failed || !anyRead) {
    // Three different "not a success", and the reason says which: a caller
    // that recorded no outcome, a source that errored, or nothing to read.
    // In every one of them succeededAt stays where it was.
    return {
      evidenceAttemptedAt: now,
      evidenceError: !read
        ? "read outcome not recorded"
        : failed
          ? (read.error ?? "evidence read failed").slice(0, 200)
          : (read.error ?? "no evidence source could be read").slice(0, 200),
    };
  }
  return { evidenceAttemptedAt: now, evidenceSucceededAt: now, evidenceError: null };
}

export type StatusEvidence = {
  expected: string[];
  present: string[];
  missing: string[];
  /**
   * Ordered, finished, and sitting in our Dropbox rather than on the client's
   * Aryeo listing — a send somebody still owes (audit WF-01, Sep 17). Distinct
   * from `missing`, which is work that does not exist yet. Empty when Aryeo
   * could not be read, and empty when the office hand-delivered the job.
   */
  awaitingSend: string[];
  partial: boolean; // looked delivered on Aryeo but content is missing
  aryeo: AryeoMediaSignal | null;
  dropbox: DropboxSignal | null;
  fulfilledOnAryeo: boolean;
  reason: string;
  checkedAt: string;
  // Video SLA: when a pending video is due, and whether it's past that window.
  videoTier: VideoTier | null;
  videoDue: string | null; // ISO date the video is expected by
  videoOverdue: boolean; // past the window with no video delivered yet
  // Cull-at-source (Jul 2026): stamped when the raw pile blew past the photo
  // budget × the overage factor, so the project page / Kyle can see WHY the
  // cull task fired. Absent when raws are within budget or unknown.
  cull?: { rawPhotos: number; photoTarget: number; overBy: number };
};

export type StatusResult = { status: ProjectStatus; evidence: StatusEvidence };

export function computeStatus(sig: StatusSignals): StatusResult {
  const a = sig.aryeo;
  const d = sig.dropbox;
  // Files in the folder BEFORE the shoot happened are not this job's — a
  // same-street re-shoot inherited the first job's raws and flipped to SHOT at
  // import (Sep 8 2026 audit, 1946 Rowan St). The counts stay in the evidence
  // so a human can see them; they don't drive presence or the SHOT flip.
  const own = sig.shootPending ? null : d;

  // WHO HAS IT vs WHO MADE IT (audit WF-01, Sep 17). These used to be one set,
  // and that is how a job could read "All ordered deliverables confirmed live
  // on Aryeo" while the video existed only in our own Dropbox: the photos going
  // out flipped the Aryeo ORDER to delivered, the Final folder made the video
  // count as present, and the two together satisfied everything. The client
  // could not open the video, and Kyle still owed the send.
  //   · clientHas — on the Aryeo listing. This is the only evidence that the
  //     client can actually get the file.
  //   · weHave    — in Dropbox Final. Produced, not delivered.
  // `present` stays their union because "is it made yet" is a real question
  // too (it drives the video-SLA and partial-delivery branches); what it may no
  // longer do on its own is claim a delivery.
  const clientHas = new Set<MediaCategory>();
  if ((a?.photos ?? 0) > 0) clientHas.add("PHOTOS");
  if ((a?.videos ?? 0) > 0) clientHas.add("VIDEO");
  if ((a?.floorPlans ?? 0) > 0) clientHas.add("FLOORPLAN");
  if ((a?.interactive ?? 0) > 0) clientHas.add("THREED");

  const weHave = new Set<MediaCategory>();
  if ((own?.finalPhotos ?? 0) > 0) weHave.add("PHOTOS");
  if ((own?.finalVideo ?? 0) > 0) weHave.add("VIDEO");

  const present = new Set<MediaCategory>([...clientHas, ...weHave]);

  const anyAryeoMedia = a ? a.photos + a.videos + a.floorPlans + a.interactive > 0 : false;
  const anyFinalDropbox = own ? own.finalPhotos + own.finalVideo > 0 : false;
  const anyRaw = own ? own.rawPhotos + own.rawVideo > 0 : false;
  const strayFiles = !own && !!d && d.rawPhotos + d.rawVideo + d.finalPhotos + d.finalVideo > 0;
  const deliveredOnAryeo = a?.delivery === "DELIVERED";
  const fulfilled = sig.fulfilled || deliveredOnAryeo;

  const expected = [...sig.expected];
  const verifiable = expected.length > 0;
  const missing = verifiable ? expected.filter((c) => !present.has(c)) : [];
  // Satisfied = everything ordered is present. When we can't parse what was
  // ordered, fall back to "Aryeo says fulfilled AND some media exists".
  const satisfied = verifiable ? missing.length === 0 : fulfilled && anyAryeoMedia;

  // Ordered, finished, and still not where the client can reach it. Asked only
  // when Aryeo actually ANSWERED (a failed read must not invent an owed send),
  // and never against the office's own hand-delivery: `sig.fulfilled` is
  // `!!deliveredAt`, a human saying the client has the files, and no
  // cross-check of two APIs overrules that (Sep 16, Kyle call). What this
  // catches is the other case — Aryeo's ORDER flag flipping because the photos
  // went out, while the video sits in Final.
  const awaitingSend = a && !sig.fulfilled ? expected.filter((c) => weHave.has(c) && !clientHas.has(c)) : [];

  // Video SLA: a missing video is only a problem once its production window
  // (shoot date + standard/premium SLA) has passed. Before that, it's on-track.
  const fmtDate = (dt: Date) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let videoDue: Date | null = null;
  let videoOverdue = false;
  // Only when content has actually started going out (photos/other media present)
  // AND the video specifically is still missing — i.e. a real staged/partial
  // delivery. Not for shoots that haven't happened yet (present is empty there).
  // "Still owed to the client" covers both shapes: never made (missing) and
  // made but never sent (awaitingSend). Before WF-01 the second one silently
  // stopped the clock — a video finished on day 2 and never sent could not go
  // overdue, because it was no longer missing.
  if ((missing.includes("VIDEO") || awaitingSend.includes("VIDEO")) && present.size > 0 && sig.videoTier && sig.shootDate) {
    // Use the SAME turnaround the task engine uses, so the status card, the
    // project's delivery-due, and the QA task all agree on one date — anchored
    // on the leg the footage came from (videoAnchorFor), not on a shootDate a
    // reschedule may have moved.
    videoDue = deliveryDueFrom(sig.videoAnchor ?? sig.shootDate, sig.videoType ?? "SOCIAL_REEL", {
      premium: sig.videoTier === "premium",
      monthlyContent: sig.monthlyContent,
    });
    videoOverdue = Date.now() > videoDue.getTime();
  }

  let status: ProjectStatus;
  let reason: string;

  // Comms override: a client asked for changes after delivery. The media may
  // all be present, but the job is NOT done until the revision is handled.
  if (sig.revisionOpen) {
    return {
      status: "REVISION",
      evidence: {
        expected: expected.map((c) => CATEGORY_LABEL[c]),
        present: [...present].map((c) => CATEGORY_LABEL[c]),
        missing: missing.map((c) => CATEGORY_LABEL[c as MediaCategory]),
        awaitingSend: awaitingSend.map((c) => CATEGORY_LABEL[c]),
        partial: false,
        aryeo: a,
        dropbox: d,
        fulfilledOnAryeo: fulfilled,
        // Neutral wording: a revision can be the client's post-delivery ask OR
        // the owner bouncing a cut in the Review Room (Aug 27).
        reason: sig.revisionNote
          ? `Changes requested: "${sig.revisionNote.slice(0, 160)}"`
          : "Changes requested — revision in progress.",
        checkedAt: new Date().toISOString(),
        videoTier: sig.videoTier,
        videoDue: null,
        videoOverdue: false,
      },
    };
  }

  if (satisfied && fulfilled && awaitingSend.length === 0) {
    status = "DELIVERED";
    // Only say "live on Aryeo" when Aryeo is actually showing them. A job that
    // gets here with something the listing does not carry got there on the
    // office's hand-delivery, and the sentence says which fact it rests on.
    const allOnAryeo = verifiable && expected.every((c) => clientHas.has(c));
    reason = !verifiable
      ? "Order fulfilled and media is live on Aryeo."
      : allOnAryeo
        ? "All ordered deliverables confirmed live on Aryeo."
        : "Delivered by the office. Not everything is on the Aryeo listing — the delivery rests on that confirmation, not on the listing.";
  } else if (satisfied && fulfilled) {
    // Everything ordered has been MADE and Aryeo calls the order delivered, but
    // a category is only in our Dropbox. This is the shape the audit named: the
    // photos went out, the video did not. It is a partial delivery with a send
    // still owed, and Kyle is the one who owes it.
    status = "REVIEW";
    const owed = awaitingSend.map((c) => CATEGORY_LABEL[c]).join(" and ");
    reason = `${owed} finished and in Dropbox, but not on the client's Aryeo listing — still to send.`;
  } else if (satisfied && !fulfilled) {
    status = "REVIEW";
    reason = "All media is present but the order isn't marked delivered on Aryeo yet — ready to deliver.";
  } else if ((fulfilled || anyFinalDropbox || present.has("PHOTOS") || present.has("VIDEO")) && verifiable && missing.length > 0) {
    // Partial delivery — but ONLY when CORE content (photos/video, i.e. work
    // that flowed through the shoot→edit pipeline) is out, or a human marked
    // the order fulfilled. Floor plans / 3D tours arrive on their own from
    // vendors (CubiCasa auto-syncs to Aryeo hours after the scan) — treating
    // those as "delivery started" jumped fresh shoots SCHEDULED → REVIEW
    // before the photographer even uploaded raws, which hid the job from the
    // upload portal (3188 Thornapple, Jul 2026).
    status = "REVIEW";
    const others = missing.filter((c) => c !== "VIDEO").map((c) => CATEGORY_LABEL[c]);
    if (missing.includes("VIDEO") && videoDue) {
      const tier = sig.videoTier === "premium" ? "Premium" : "Standard";
      const lead = present.has("PHOTOS") ? "Photos delivered." : "Delivery underway.";
      reason = videoOverdue
        ? `Video overdue — was due ${fmtDate(videoDue)}. Confirm it was delivered to the client, or upload it.`
        : `${lead} ${tier} video in production — due ${fmtDate(videoDue)}.`;
      if (others.length) reason += ` Also missing ${others.join(", ")}.`;
    } else {
      reason = `Partial delivery — still missing ${missing.map((m) => CATEGORY_LABEL[m as MediaCategory]).join(", ")}.`;
    }
    // A category can be missing AND another one finished-but-unsent on the same
    // job (floor plan still to come, video sitting in Final). The unsent one has
    // an owner and an action, so it does not get to hide behind the missing one.
    if (awaitingSend.length > 0) {
      reason += ` ${awaitingSend.map((c) => CATEGORY_LABEL[c]).join(" and ")} finished and in Dropbox, not yet on the Aryeo listing — still to send.`;
    }
  } else if (anyRaw) {
    status = "SHOT";
    reason = "Raw files uploaded to Dropbox — awaiting editing.";
  } else if (sig.scheduled || (sig.shootDate && sig.shootDate.getTime() > Date.now())) {
    status = "SCHEDULED";
    reason = strayFiles
      ? "Shoot scheduled. Files are already in its Dropbox folder, but the shoot hasn't happened — they are not counted as this job's."
      : "Shoot scheduled.";
  } else if (sig.postponed && !sig.datedAppt) {
    // A postponed job is "order received, needs a date" — BOOKED — not
    // "scheduled with no date", which is the state that let 775 Scotch Way sit
    // in Scheduled while every date-keyed list dropped it (Sep 1 2026 audit).
    // Tested BEFORE the shootDate fallback: a postponement that lands after
    // the slot's start leaves a stale past shootDate behind (review).
    status = "BOOKED";
    reason = "Postponed in Aryeo — no new date yet. Rebook it.";
  } else if (sig.datedAppt || sig.shootDate) {
    status = "SCHEDULED";
    reason = "Appointment on file.";
  } else {
    status = "BOOKED";
    reason = "No shoot scheduled yet.";
  }

  const partial = fulfilled && verifiable && missing.length > 0;

  return {
    status,
    evidence: {
      expected: expected.map((c) => CATEGORY_LABEL[c]),
      present: [...present].map((c) => CATEGORY_LABEL[c]),
      missing: missing.map((c) => CATEGORY_LABEL[c as MediaCategory]),
      awaitingSend: awaitingSend.map((c) => CATEGORY_LABEL[c]),
      partial,
      aryeo: a,
      dropbox: d,
      fulfilledOnAryeo: fulfilled,
      reason,
      checkedAt: new Date().toISOString(),
      videoTier: sig.videoTier,
      videoDue: videoDue ? videoDue.toISOString() : null,
      videoOverdue,
    },
  };
}

// ---- data gathering --------------------------------------------------------

type ShootTiming = {
  shootDate: Date | null;
  appointments?: { status: string | null; startAt: Date | null }[];
};

// "The shoot already happened" — the arming condition for the sweep's
// anti-demotion guards. shootDate alone is NOT enough: it's movable. When an
// already-shot job gets a return visit or a forward reschedule, the appointment
// sync points shootDate at the FUTURE leg, and a guard keyed only on
// `shootDate < now` silently disarms — re-opening the exact demotion cascade it
// was built to stop (audit crack #2 / 2075 Flint Hill). So any non-canceled
// appointment leg that started in the past also counts. The shootDate test
// still matters on its own: manual/unsynced projects have no appointment rows.
// Exported (Sep 8 2026) so the photo counter and the legacy Dropbox sweep gate
// on the SAME predicate instead of a bare shootDate compare.
export function shootHappenedFor(p: ShootTiming, now: number = Date.now()): boolean {
  return (
    (p.shootDate !== null && p.shootDate.getTime() < now) ||
    (p.appointments ?? []).some(
      (a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt !== null && a.startAt.getTime() < now,
    )
  );
}

// The opposite, narrowly: the shoot is KNOWN to be ahead (a future shootDate or
// a future non-canceled leg) and no leg has happened. A job with no date at all
// is neither — raws there keep their old meaning. Files found under a pending
// job's name cannot be its raws (Sep 8 2026 audit, 1946 Rowan St).
export function shootPendingFor(p: ShootTiming, now: number = Date.now()): boolean {
  if (shootHappenedFor(p, now)) return false;
  return (
    (p.shootDate !== null && p.shootDate.getTime() > now) ||
    (p.appointments ?? []).some(
      (a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt !== null && a.startAt.getTime() > now,
    )
  );
}

// WHERE THE VIDEO CLOCK STARTS: videoAnchorFor now lives in lib/tasks beside
// the promise table it dates (Sep 16 review), so the queue's per-category due
// dates and this engine's SLA read the SAME anchor — the last leg that really
// happened, not whichever leg the appointment sync last pointed shootDate at.
// Re-exported here because every existing caller imports it from the status
// engine.
export { videoAnchorFor };

// `onError` (Sep 16, RTP-06): the failure was always swallowed here, so a
// caller could not tell "the listing has no video" from "Aryeo would not
// answer". The signal is still null either way — only the STAMPS learn the
// difference, never the status decision.
async function aryeoMedia(listingId: string, onError?: (e: unknown) => void): Promise<AryeoMediaSignal | null> {
  try {
    const l = await Aryeo.listing(listingId);
    return mediaSignalOf(l);
  } catch (e) {
    onError?.(e);
    return null;
  }
}

/** One listing read → the signal, so the hourly pass and the targeted refresh
 *  below can never describe the same listing two different ways. */
function mediaSignalOf(l: AryeoListing): AryeoMediaSignal {
  // First gallery image (same preference order getListingMedia uses) — the
  // My Shoots card swaps its Street View for this once photos land.
  const gallery = (l.images ?? []).filter((i) => i.display_in_gallery !== false);
  const first = gallery[0] as { thumbnail_url?: string; large_url?: string; original_url?: string } | undefined;
  return {
    photos: l.images?.length ?? 0,
    videos: l.videos?.length ?? 0,
    floorPlans: l.floor_plans?.length ?? 0,
    interactive: l.interactive_content?.length ?? 0,
    delivery: l.delivery_status ?? null,
    cover: l.thumbnail_url ?? first?.thumbnail_url ?? first?.large_url ?? null,
    at: new Date().toISOString(),
    videoList: videoFactsOf(l.videos),
  };
}

/** The listing's videos, reduced to the three facts a reader can act on. Kept
 *  deliberately small: this is written into a JSON column on 1,500 jobs, and a
 *  whole Aryeo video object is mostly urls that go stale. */
function videoFactsOf(videos: unknown[] | undefined): { id: string; title: string | null; duration: number | null }[] {
  if (!Array.isArray(videos)) return [];
  const out: { id: string; title: string | null; duration: number | null }[] = [];
  for (const v of videos as Record<string, unknown>[]) {
    const id = typeof v?.id === "string" ? v.id : null;
    if (!id) continue; // a video with no id proves nothing about anything
    out.push({
      id,
      title: typeof v.title === "string" ? v.title.slice(0, 120) : null,
      duration: typeof v.duration === "number" && Number.isFinite(v.duration) ? v.duration : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A TARGETED RE-READ OF ONE LISTING — for the jobs the sweep has stopped
// looking at (Sep 17 2026).
//
// The hourly pass only carries a DELIVERED job for seven days after delivery
// (see the `where` below), which is right for a status engine: after a week the
// job is history and the API calls are wasted. It is wrong for "Ready to send",
// which asks a question that stays open for as long as a finished video has not
// gone out — and 2051 Old Sumneytown Pike proved it in the live data: delivered
// Sep 8, its evidence frozen at `videos: 0` from 22:01 that night, while the
// video itself went up on Aryeo at 15:48 the NEXT day. Nine days later the card
// was still asking Kyle to send a video that had been live all along, because
// the only number it had was a stale zero.
//
// This is the cheapest possible fix for that: ONE listing read, and a write
// that adds one key to the evidence blob and changes nothing that was already
// in it (see the write below — the key is `listing`, not `aryeo`, and the
// reason is that only the card may act on what this reads).
//
// WHAT IT DELIBERATELY DOES NOT DO is run the status engine. syncProjectStatuses
// on an old delivered job re-runs the whole decision — deliverable statuses,
// task generation, the delivery-text mint — for a job that settled a week ago,
// and the one thing this needed was a fresher count. Reading is free of
// consequences; deciding is not.
//
// It is safe to race the engine: the engine rewrites the blob whole from its
// own read moments later, and both writes are snapshots of the same listing.
// The worst case is one pass's counts overwritten by another's, seconds apart —
// and since Sep 17 they are not even the same key, so the engine's own block is
// never touched from here at all.
// ---------------------------------------------------------------------------
export async function refreshListingEvidence(
  projectId: string,
  listing?: AryeoListing | null,
): Promise<{ ok: boolean; videos: number; reason?: string }> {
  const p = await prisma.project
    .findUnique({ where: { id: projectId }, select: { aryeoListingId: true, statusEvidence: true } })
    .catch(() => null);
  if (!p) return { ok: false, videos: 0, reason: "no such job" };
  if (!p.aryeoListingId) return { ok: false, videos: 0, reason: "no listing id" };

  let l = listing ?? null;
  if (!l) {
    try {
      l = await Aryeo.listing(p.aryeoListingId);
    } catch (e) {
      // Aryeo would not answer. The OLD counts stay exactly as they were —
      // never blanked, never re-stamped with a fresh `at`, because a read that
      // did not happen must not be able to make anything look freshly
      // confirmed. Every reader treats old counts as "we have not looked".
      return { ok: false, videos: 0, reason: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    }
  }
  const aryeo = mediaSignalOf(l);

  // Merge, never replace: `expected`, `missing`, the Dropbox half and the
  // status engine's own reason all belong to the engine and are none of this
  // function's business. A blob that will not parse is left alone entirely —
  // writing a new one from here would erase the engine's reasoning.
  let blob: Record<string, unknown>;
  try {
    blob = JSON.parse(p.statusEvidence ?? "") as Record<string, unknown>;
    if (!blob || typeof blob !== "object") return { ok: false, videos: aryeo.videos, reason: "evidence unreadable" };
  } catch {
    return { ok: false, videos: aryeo.videos, reason: "evidence unreadable" };
  }
  // UNDER ITS OWN KEY, NOT `aryeo` (Sep 17, second review).
  //
  // `blob.aryeo` is read all over the hub, and two of its readers gate a
  // message to a CLIENT on the video COUNT: the monthly-content batch hold in
  // lib/tasks (hold the delivery text until the month's videos are live) and
  // the "positive proof a video shipped" test in lib/clientTextSweeps. Until
  // now only the hourly status engine could move those numbers, and it stops
  // carrying a job seven days after delivery — so a count that had gone stale
  // stayed stale, and stale meant HELD.
  //
  // This refresh exists to put a sentence on the Ready-to-send card, and it
  // deliberately reaches jobs the status engine has dropped (including content
  // months — the first row on the card today is one). A card's re-read must not
  // be able to release a text to a client as a side effect, however true its
  // numbers are. So it writes here; lib/readyToSend reads here and prefers
  // whichever block was read most recently; nothing else in the hub can see it.
  blob.listing = aryeo;
  await prisma.project
    .update({ where: { id: projectId }, data: { statusEvidence: JSON.stringify(blob) } })
    .catch(() => {});
  return { ok: true, videos: aryeo.videos };
}

// A missing folder is a trustworthy ZERO (nothing was uploaded there). Any OTHER
// failure — auth, rate limit, network, a 5xx — is UNKNOWN, not zero: treating it
// as zero made a one-second Dropbox blip read as "no media", which demoted shot
// jobs and destroyed their QC/delivery tasks (audit crack #2). null = "couldn't look".
// The ONE shared counter (folderFileCount, identical null/not_found semantics)
// is called directly in gatherSignals so the status engine can't drift from
// the portal again: it once kept its own top-level-only listing, so a nested
// camera dump read as zero here even after the portal was fixed (review).

type StatusProject = {
  id: string;
  title: string;
  status: ProjectStatus;
  aryeoListingId: string | null;
  deliveredAt: Date | null;
  uploadedAt: Date | null;
  // The photographer's upload-page submit — the release signal for the office's
  // Waiting hold (queueWaiting.ts). Only finalizeUpload writes it.
  debriefSubmittedAt: Date | null;
  coverImageUrl: string | null;
  shootDate: Date | null;
  addressLine: string | null;
  createdAt: Date;
  dropboxFolder: string | null;
  packageName: string | null;
  revisionRequestedAt: Date | null;
  revisionNote: string | null;
  photographerId: string | null;
  // Culling budget inputs: squareFeet sizes the 50-vs-80 default, photoTarget is
  // the owner override. The photographer name keys the cull task's assignedKey.
  squareFeet: number | null;
  photoTarget: number | null;
  photographer: { name: string } | null;
  client: { name: string; socialClient: boolean };
  deliverables: { id: string; type: string; label: string | null; status: string; quantity?: number }[];
  appointments: { status: string | null; startAt: Date | null; postponedAt?: Date | null }[];
  /** the previous pass's evidence — last-known-good Dropbox counts live here */
  statusEvidence?: string | null;
  // The office's overrides (Sep 13, editOverrides.ts): a pinned status is
  // never written over by this sweep; a due the office set replaces the SLA
  // date the status card shows.
  statusPinnedAt?: Date | null;
  dueOverrideAt?: Date | null;
  /** the office's tier (Sep 16) — the video's window, via tasks.slaTierOf */
  tierOverride?: string | null;
  /** the promise this job was SOLD under. Read here only to know whether the
   *  job has been pinned yet; the sweep writes it exactly once (Sep 18). */
  promisedDueAt?: Date | null;
};

async function gatherSignals(p: StatusProject, useDropbox: boolean): Promise<StatusSignals> {
  const expected = expectedCategories(p.deliverables);
  const sla = slaTierOf(p);
  // RTP-06: remember WHY each source is null, for the stamps only.
  let aryeoError: string | null = null;
  const aryeo = p.aryeoListingId
    ? await aryeoMedia(p.aryeoListingId, (e) => {
        aryeoError = (e instanceof Error ? e.message : String(e)).slice(0, 80);
      })
    : null;
  const aryeoOutcome: SourceOutcome = !p.aryeoListingId ? "unavailable" : aryeo ? "ok" : "failed";

  // Only spend Dropbox calls when Aryeo doesn't already account for everything
  // ordered — Aryeo is the delivery source of truth; Dropbox explains the
  // in-flight stage (raw shot / final awaiting upload) when Aryeo is short.
  const aryeoSatisfies =
    expected.size > 0 &&
    [...expected].every((c) => {
      if (c === "PHOTOS") return (aryeo?.photos ?? 0) > 0;
      if (c === "VIDEO") return (aryeo?.videos ?? 0) > 0;
      if (c === "FLOORPLAN") return (aryeo?.floorPlans ?? 0) > 0;
      return (aryeo?.interactive ?? 0) > 0;
    });

  let dropbox: DropboxSignal | null = null;
  let dropboxUnavailable = !useDropbox;
  // "unconfigured" and "we didn't need to ask" are both honest non-failures;
  // only a read that errored makes the pass unsuccessful (RTP-06).
  let dropboxOutcome: SourceOutcome = !useDropbox ? "unavailable" : aryeoSatisfies ? "skipped" : "ok";
  let dropboxError: string | null = null;
  if (useDropbox && !aryeoSatisfies) {
    // The REAL folder — a rescheduled shoot's files stay put while the
    // convention path moves, and reading the wrong path counted 0 media
    // (which drives evidence, /ops chips, and the delivery-text gate).
    const f = actualFolderPaths(p);
    // Sequential, not Promise.all: the four reads used to fan out ×5 projects
    // into a 20-wide burst on one token (13 of 44 came back 429 live; the same
    // reads pass 44/44 one at a time). dbx() now also caps in-flight calls.
    let readError: string | undefined;
    const read = (path: string) =>
      folderFileCount(path, (e) => {
        readError = (e instanceof Error ? e.message : String(e)).slice(0, 80);
      });
    const rawPhotos = await read(f.rawPhotos);
    const rawVideo = await read(f.rawVideo);
    const finalPhotos = await read(f.finalPhotos);
    const finalVideo = await read(f.finalVideo);
    // Any FAILED folder read (null ≠ a real "not found" zero) poisons the whole
    // signal — partial counts would read as "media vanished". Unknown beats wrong.
    if ([rawPhotos, rawVideo, finalPhotos, finalVideo].some((c) => c === null)) {
      dropboxUnavailable = true;
      dropboxOutcome = "failed";
      dropboxError = readError ?? "folder read failed";
      // Unknown is not zero — and it is not "forget what we knew" either. Keep
      // the last good counts (marked stale) so a rate-limited pass can't blank
      // the evidence Ops Day, the editor handoff and the delivery gate read.
      // Ceiling: counts older than 48h are not "known" any more (a dead token
      // must not pin every job on ancient numbers forever) → back to unknown.
      // The original `at` survives across consecutive stale passes.
      const priorEv = parseEvidence(p.statusEvidence ?? null);
      const prior = priorEv?.dropbox;
      const priorAt = prior?.at ?? priorEv?.checkedAt;
      const fresh = priorAt ? Date.now() - Date.parse(priorAt) < 48 * 3600_000 : false;
      if (prior && fresh && [prior.rawPhotos, prior.rawVideo, prior.finalPhotos, prior.finalVideo].every((n) => typeof n === "number")) {
        dropbox = { ...prior, at: priorAt, stale: true, ...(readError ? { readError: readError.slice(0, 80) } : {}) };
      }
    } else {
      dropbox = {
        rawPhotos: rawPhotos as number,
        rawVideo: rawVideo as number,
        finalPhotos: finalPhotos as number,
        finalVideo: finalVideo as number,
        at: new Date().toISOString(),
      };
    }
  }

  return {
    expected,
    aryeo,
    dropbox,
    dropboxUnavailable,
    fulfilled: !!p.deliveredAt,
    scheduled: p.appointments.some((a) => (a.status || "").toUpperCase() === "SCHEDULED"),
    // Canceled appointments are not "an appointment on file" — a job whose only
    // appointments were canceled must not read as scheduled (audit crack #14).
    anyAppt: p.appointments.some((a) => (a.status || "").toUpperCase() !== "CANCELED"),
    datedAppt: p.appointments.some((a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt !== null),
    postponed: p.appointments.some(
      (a) =>
        !(a.status || "").toUpperCase().startsWith("CANCEL") && // Aryeo keeps postponed_at on a later cancel
        ((a.status || "").toUpperCase() === "UNSCHEDULED" || (!!a.postponedAt && a.startAt === null)),
    ),
    shootDate: p.shootDate,
    videoAnchor: videoAnchorFor(p),
    shootPending: shootPendingFor(p),
    // A revision stamp OLDER than the delivery is stale — that delivery WAS the
    // revision being resolved. Treating it as open resurrected delivered jobs
    // as zombie REVISION rows on every full sweep (Jul 24 + Aug 25 audits).
    revisionOpen:
      !!p.revisionRequestedAt &&
      !(p.deliveredAt && p.revisionRequestedAt.getTime() <= p.deliveredAt.getTime()),
    revisionNote: p.revisionNote,
    // THE OFFICE'S TIER DRIVES THE CLOCK (Sep 16, Kyle call). slaTierOf is the
    // one ladder — the hub's reading of the product, with Project.tierOverride
    // on top — so the status card, the delivery-due, the QC card and the
    // editor queue can't disagree about how long a video has. Sharra Mercer's
    // #1584 ran a 48h reel clock while the queue chip already said Personal
    // Branding. null still means "no video was ordered".
    videoTier: videoTier(p.deliverables) === null ? null : sla === "premium" ? "premium" : "standard",
    monthlyContent: sla === "branding",
    videoType: p.deliverables.find((d) => expectedCategories([d]).has("VIDEO"))?.type ?? null,
    // The stamps' only input. Nothing above this line reads it.
    read: {
      aryeo: aryeoOutcome,
      dropbox: dropboxOutcome,
      error:
        [aryeoOutcome === "failed" ? `aryeo: ${aryeoError ?? "unreadable"}` : null, dropboxOutcome === "failed" ? `dropbox: ${dropboxError ?? "unreadable"}` : null]
          .filter(Boolean)
          .join(" · ") || null,
    },
  };
}

// The queue ladder's words for the pin note in the evidence (Sep 13) — the
// same labels editorQueue.STATUS_LABEL prints, kept here so this module does
// not import the queue builder.
const STATUS_WORD: Record<string, string> = {
  BOOKED: "Waiting",
  SCHEDULED: "Waiting",
  SHOT: "Ready for editing",
  EDITING: "In editing",
  REVIEW: "Ready for review",
  REVISION: "Revisions",
  DELIVERED: "Completed",
  ON_HOLD: "On hold",
  CANCELLED: "Cancelled",
};

// Simple bounded-concurrency map so a full backfill doesn't hammer the APIs.
async function pMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Recompute status for projects by cross-checking Aryeo media + Dropbox.
//   opts.full   → every Aryeo project (one-time backfill; run locally)
//   default     → active + recently-changed only (serverless-safe, capped)
// Never touches ON_HOLD (manual) or CANCELLED projects, and won't demote an
// EDITING project back to SHOT — nor move it to REVIEW while the video is still
// owed (EDITING is the editor's own "I've started", Sep 10; see the loop).
// Honours the office's Waiting hold (queueWaiting.ts, Sep 11): a job put back
// to Waiting on the queue pill stays there whatever the folder says, until the
// photographer submits the upload page or the office moves it on.
// ---------------------------------------------------------------------------
export async function syncProjectStatuses(
  opts: { full?: boolean; limit?: number; projectId?: string } = {},
): Promise<{
  checked: number;
  changed: number;
  partials: number;
  byStatus: Record<string, number>;
  /** projects whose Dropbox folders could not be read this pass (carried forward) */
  dropboxUnreadable: number;
  dropboxErrors: Record<string, number>;
}> {
  const useDropbox = dropboxConfigured() && !!(await getSecret("dropbox"));

  // On a full backfill, first sweep delivered jobs' comms for any revision
  // request we may have missed, so they reopen to REVISION before we compute.
  if (opts.full) {
    const { scanProjectCommsForRevision } = await import("@/lib/comms");
    const delivered = await prisma.project.findMany({
      where: { source: "ARYEO", status: "DELIVERED", revisionRequestedAt: null },
      select: { id: true },
    });
    for (const p of delivered) await scanProjectCommsForRevision(p.id);
  }

  const where = opts.projectId
    ? // Single project (e.g. an Aryeo media-delivered webhook) — but the
      // ON_HOLD/CANCELLED exclusion applies here too: the contract above says
      // manual holds are never touched, and the bare {id} branch was quietly
      // re-arming them (Aug 18 audit).
      { id: opts.projectId, status: { notIn: ["ON_HOLD", "CANCELLED"] as ProjectStatus[] } }
    : opts.full
    ? { source: "ARYEO" as const, status: { notIn: ["ON_HOLD", "CANCELLED"] as ProjectStatus[] }, aryeoMissingAt: null }
    : {
        source: "ARYEO" as const,
        // An order that 404s in Aryeo has no listing to read — recomputing
        // would only erase evidence. flagOrphanedOrders owns these jobs.
        aryeoMissingAt: null,
        OR: [
          { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] as ProjectStatus[] } },
          // A RECENTLY DELIVERED job rides along (Sep 16, Kyle call). Its
          // status is now untouchable from evidence (see the DELIVERED guard
          // in the loop), but its EVIDENCE has to keep catching up: 39
          // Saratoga Ln was hand-delivered at 8:10pm on Sep 15 and its card
          // still read "Raw files uploaded — awaiting editing / Photos
          // missing" the next afternoon, because the hourly pass had stopped
          // looking at it the moment it was delivered. Seven days is long
          // enough for a listing id to land, a floor plan to sync or a vendor
          // to come back; after that the job is history and we stop paying
          // for the API calls.
          { status: "DELIVERED" as ProjectStatus, deliveredAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } },
        ],
      };

  const projects = (await prisma.project.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    ...(opts.full || opts.projectId ? {} : { take: opts.limit ?? 80 }),
    select: {
      id: true,
      title: true,
      status: true,
      aryeoListingId: true,
      deliveredAt: true,
      uploadedAt: true,
      debriefSubmittedAt: true,
      coverImageUrl: true,
      shootDate: true,
      addressLine: true,
      createdAt: true,
      dropboxFolder: true,
      packageName: true,
      revisionRequestedAt: true,
      revisionNote: true,
      photographerId: true,
      squareFeet: true,
      photoTarget: true,
      photographer: { select: { name: true } },
      client: { select: { name: true, socialClient: true } },
      // Owed rows only — an item removed from the Aryeo order, or waived by
      // the office as not required on this job, must not be "expected" (632
      // Greenridge read "video overdue" for a week; 195 Woodhill kept a floor
      // plan the client never bought). OWED_DELIVERABLE_WHERE is that rule,
      // stated once for every reader (tasks.ts).
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { id: true, type: true, label: true, status: true, quantity: true } },
      appointments: { select: { status: true, startAt: true, postponedAt: true } },
      statusEvidence: true,
      // Loaded with the batch, no extra query: the office's pin, due and tier
      // (Sep 13 / Sep 16) — see the guards in the loop and slaTierOf.
      statusPinnedAt: true,
      dueOverrideAt: true,
      tierOverride: true,
      // Has this job's promise been frozen yet? (Sep 18 — see the pin write
      // after the update below.) One column, no extra query.
      promisedDueAt: true,
    },
  })) as StatusProject[];

  let changed = 0;
  let partials = 0;
  const byStatus: Record<string, number> = {};
  let dropboxUnreadable = 0;
  const dropboxErrors: Record<string, number> = {};

  const results = await pMap(projects, 5, async (p) => {
    const sig = await gatherSignals(p, useDropbox);
    return { p, sig, ...computeStatus(sig) };
  });

  // A job a human put in front of an editor by hand — the manual "Add a job"
  // on /editing pins its open edit card (assignedManually) — may have no media
  // evidence at all: old footage, a video added after the booking, a null or
  // postponed shootDate. Since Sep 10 that add lands on SHOT (Ready for
  // editing), not EDITING, so the sticky-EDITING rule below no longer shields
  // it; without this the hourly recompute read "no raws, no past shoot" as
  // BOOKED/SCHEDULED and the job fell out of the Editing Room an hour after
  // the editor was belled "added to your queue" (Sep 10 review). It arms the
  // same Scheduled/Booked guard as shootHappened.
  const manualQueued = new Set(
    (
      await prisma.smartTask.findMany({
        where: {
          projectId: { in: projects.map((p) => p.id) },
          taskType: "edit_video",
          assignedManually: true,
          status: { notIn: ["COMPLETED", "CANCELLED"] },
        },
        select: { projectId: true },
      })
    ).flatMap((t) => (t.projectId ? [t.projectId] : [])),
  );

  // THE OFFICE'S WAITING HOLD (Jordan, Sep 11: "I should also be able to
  // change projects back to waiting but its blocked off"). The queue pill's
  // Waiting writes SCHEDULED/BOOKED plus a `queue-waiting:<id>` marker; the
  // raws that made the job read Ready for editing are still in the folder,
  // so without this the anyRaw branch would flip it straight back within the
  // hour (the Sep 8 shape: 1946 Rowan St #2 wearing another job's raws).
  // Loaded once per batch, like manualQueued. A hold stands until the
  // photographer submits the upload page AFTER it — debriefSubmittedAt, the
  // one stamp only finalizeUpload writes (uploadedAt is stamped by this very
  // sweep on a folder read, so it can't be the release signal) — or the
  // office moves the job on from the pill, which deletes the marker itself.
  const waitingHolds = await loadWaitingHolds(projects.map((p) => p.id));

  for (const { p, sig, status, evidence } of results) {
    if (sig.dropboxUnavailable && useDropbox && sig.dropbox?.stale !== undefined) {
      dropboxUnreadable++;
      const k = sig.dropbox?.readError ?? "unknown";
      dropboxErrors[k] = (dropboxErrors[k] ?? 0) + 1;
    } else if (sig.dropboxUnavailable && useDropbox && !sig.dropbox) {
      dropboxUnreadable++;
      dropboxErrors.unknown = (dropboxErrors.unknown ?? 0) + 1;
    }
    // "The shoot already happened" — the arming condition for both anti-demotion
    // guards below (see shootHappenedFor for why shootDate alone is not enough).
    const shootHappened = shootHappenedFor(p);
    // Signal-fetch FAILURE is unknown, not zero. When Aryeo couldn't be read AND
    // Dropbox is unavailable for a past-shoot production job, we have no evidence
    // at all — keep the prior status/evidence untouched instead of recomputing
    // from nothing (which erased "present" evidence, flipped deliverables back to
    // PENDING, and cascaded into destroyed QC tasks — audit crack #2).
    // (With counts carried forward, sig.dropbox is non-null on a failed read —
    // the old `!sig.dropbox` term here would have disarmed this guard on the
    // very pass it exists for: Aryeo AND Dropbox both unreadable.)
    // DELIVERED joined this list on Sep 16, the day delivered jobs joined the
    // hourly pass: a delivered job has no "shoot happened" question left, and
    // recomputing one from two unreadable APIs would rewrite its evidence to
    // "the hub cannot see: Photos" and walk every DONE deliverable back to
    // PENDING — the same cascade this guard exists to stop, on the jobs where
    // it would be most alarming to Kyle.
    if (
      !sig.aryeo &&
      sig.dropboxUnavailable &&
      ["SHOT", "EDITING", "REVIEW", "REVISION", "DELIVERED"].includes(p.status) &&
      (shootHappened || p.status === "DELIVERED")
    ) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      // RTP-06 (Sep 16): this is the branch where the hub could not look at
      // all, and until now it stamped the same column a successful pass
      // stamps — so StatusEvidenceCard read "Cross-checked 3 minutes ago ·
      // Aryeo media + Dropbox folders" over evidence nobody had managed to
      // read, and deliveryWatch's photos-not-delivered text could fire on a
      // stale zero. statusCheckedAt keeps its old meaning ("the engine ran")
      // because other readers and batches depend on it; the honest pair is
      // evidenceAttemptedAt (moves) and evidenceSucceededAt (does NOT).
      await prisma.project.update({
        where: { id: p.id },
        data: { statusCheckedAt: new Date(), ...evidenceStamps(sig.read) },
      });
      continue;
    }
    // Don't demote a manually-advanced EDITING project back to SHOT — and a
    // job may have no media evidence at all, so block the Scheduled/Booked
    // recompute too. "In editing" is a human signal (the editor's own click on
    // the Editing Room queue pill, Sep 10); only a human may undo it — the
    // office's "Ready for editing" on that same pill, or the pipeline board.
    // (The manual "Add a job" on /editing lands on SHOT now, not EDITING; a
    // past-shoot or hand-queued SHOT job is kept off Scheduled/Booked by the
    // guard below.)
    let final = status;
    if (p.status === "EDITING" && ["SHOT", "SCHEDULED", "BOOKED"].includes(status)) final = "EDITING";
    // Nor to REVIEW while the video is still owed. "Photos delivered, video in
    // production" recomputes as REVIEW (the partial-delivery branch), and that
    // is the common shape of an in-flight video job — every "In editing" click
    // on record was undone by the next sweep this way (617 Westbourne Rd and
    // 99 W Bridge St on Sep 9, within the hour), which turned every surface
    // back to "Ready for editing" while the editor's card sat IN_PROGRESS
    // (Sep 10 review). The photos going out is not the footage leaving the
    // editor's desk: only the VIDEO landing (live on Aryeo or in the Final
    // folder, so "Video" is no longer missing) or a full delivery moves it on.
    if (p.status === "EDITING" && status === "REVIEW" && evidence.missing.includes("Video")) final = "EDITING";
    // Same for REVIEW: an editor's "send to review" is a human signal the cut
    // exists (in the Review Room) that the evidence engine can't
    // see — recomputing raws-in/no-Aryeo-media as SHOT must not silently undo
    // it (July 2026 audit: REVIEW→SHOT was written unconditionally).
    if (p.status === "REVIEW" && status === "SHOT") final = "REVIEW";
    // A HAND DELIVERY STICKS (Sep 16, Kyle call — 39 Saratoga Ln, 195
    // Woodhill Rd, 68 New St, 632 Greenridge Rd).
    //
    // `fulfilled` is `!!deliveredAt`, which is true the moment the office
    // moves a job to Delivered by hand — so the partial-delivery branch read
    // "fulfilled, but a category is missing" and computed REVIEW. Nothing
    // stopped it being written: this sweep, Refresh from Aryeo and the Aryeo
    // webhook all call syncProjectStatuses, and moveProjectStatus clears the
    // status pin on its way out. Kyle would have watched four jobs he
    // delivered himself walk back into "Review / QC" the next time anyone
    // pressed anything.
    //
    // Delivery is a HUMAN fact — the client has the files — and no cross-check
    // of Aryeo and Dropbox gets to overrule it. What the evidence may still
    // do is say, plainly, what the hub has not been able to confirm. A client
    // revision (computed REVISION) is the one thing bigger than the delivery,
    // exactly as it outranks the office's status pin.
    if (p.status === "DELIVERED" && status !== "REVISION") {
      final = "DELIVERED";
      // Not a "partial delivery" any more: that banner exists to stop Kyle
      // treating a half-delivered job as done, and he is the one who
      // delivered it.
      evidence.partial = false;
      if (evidence.missing.length > 0) {
        const on = p.deliveredAt
          ? ` on ${p.deliveredAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}`
          : "";
        evidence.reason = `Delivered by the office${on}; the hub still cannot see: ${evidence.missing.join(", ")}.`;
      }
      // …and when the missing list empties (the listing id lands, the floor
      // plan syncs), computeStatus's own "All ordered deliverables confirmed
      // live on Aryeo." stands untouched. The sentence clears itself.
    }
    // A job whose shoot already happened can NEVER go back to Scheduled/Booked.
    // Zero detected media there means either a transient Aryeo/Dropbox failure or
    // raws not uploaded yet — un-shooting the job is always wrong, and the demotion
    // cascades: the task reconciler auto-completes its QC/delivery tasks and never
    // re-mints them (audit crack #2 — live jobs went invisible after API blips).
    // `shootHappened` (not `shootDate < now`) because a rescheduled/return-visit
    // job carries a FUTURE shootDate while its original leg is already in the can.
    if (
      ["SHOT", "EDITING", "REVIEW", "REVISION"].includes(p.status) &&
      (final === "SCHEDULED" || final === "BOOKED") &&
      (shootHappened || manualQueued.has(p.id))
    ) {
      final = p.status;
    }
    // The office's Waiting hold (waitingHolds above). A submit stamped after
    // it releases it: the job advances normally below and the marker goes.
    // Standing, it keeps a BOOKED/SCHEDULED job put whatever the folder
    // computed — SHOT off the raws, or the partial-delivery REVIEW — and says
    // why in the evidence, so the project page and the queue's green RAW dot
    // don't read as a disagreement. DELIVERED and REVISION still move: a full
    // delivery or a client ask is bigger news than the hold.
    const hold = waitingHolds.get(p.id);
    let held = false;
    if (hold && !holdStands(hold, p.debriefSubmittedAt)) {
      if (await releaseWaitingHold(p.id)) {
        await prisma.activity.create({
          data: { projectId: p.id, type: "SYSTEM", body: "Waiting hold released — the photographer submitted the upload page." },
        }).catch(() => {});
      }
    } else if (hold && ["BOOKED", "SCHEDULED"].includes(p.status) && ["SHOT", "EDITING", "REVIEW"].includes(final)) {
      held = true;
      final = p.status;
      const seen = status === "SHOT" ? "raw files are in the folder" : "media is already showing for this job";
      evidence.reason = `Held in Waiting by the office${hold.by ? ` (${hold.by})` : ""}; ${seen} — it stays Waiting until the photographer submits the upload page or the office moves it on.`;
    }
    // THE OFFICE'S STATUS PIN (Jordan, Sep 13: "I want to be able to override
    // anything"). While Project.statusPinnedAt is set, the status the office
    // forced through the override dialog is the status, full stop: this sweep
    // — the hourly pass, the per-project recheck, the Aryeo media webhook —
    // never writes over it, whatever the evidence computed. Sits beside the
    // sticky-EDITING / Waiting-hold / manualQueued guards above and outranks
    // them all; loaded with the batch (statusPinnedAt in the select), no
    // extra query. The evidence still records what the hub WOULD say, so the
    // project page explains the disagreement instead of hiding it. Only a
    // human ends it — the pill, the pipeline board, the dialog's "Let the hub
    // manage the status again" — or Aryeo cancelling the order (aryeo.ts,
    // which clears the pin as it writes CANCELLED), or a client revision
    // arriving (comms.raiseRevision — client news outranks a pin).
    // computeStatus never yields CANCELLED, so there is no exception to make
    // here.
    // THE OFFICE'S DUE (Sep 13): the status card's "video due" is the date
    // the office set, not the SLA's — and "overdue" is judged against it.
    // Only while the video is still owed; a delivered video has no due.
    //
    // Sep 16 (Kyle call): it REWRITES the sentence instead of appending to it.
    // 99 W Bridge St read "Video overdue — was due Sep 11. Confirm it was
    // delivered to the client, or upload it. Also missing Floor plan. Video
    // due Sep 19 (set by the office)." — the hub calling a video late and
    // giving it three more days in the same breath. Only the SLA sentence is
    // replaced: a SHOT job's "Raw files uploaded to Dropbox" is not a claim
    // about the video's deadline, so that one still just gets the date added.
    // Runs BEFORE the pin block so a pinned job's prefix wraps the final
    // sentence rather than being overwritten by it.
    if (p.dueOverrideAt && evidence.missing.includes("Video")) {
      const officeDue = p.dueOverrideAt;
      const when = officeDue.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
      // Sep 16 review: a DELIVERED job keeps the delivery sentence. The office
      // hand-delivering a job whose video the hub still cannot see is exactly
      // the 99 W Bridge shape, and rewriting "Delivered by the office on Sep
      // 16; the hub still cannot see: Video." into "Premium video due Sep 19"
      // would put a job Kyle has already delivered back on the clock.
      const delivered = p.status === "DELIVERED" && status !== "REVISION";
      const builtFromSla = evidence.videoDue !== null && !delivered;
      evidence.videoDue = officeDue.toISOString();
      // A delivered video is never late (same rule getVideoSlaStatus applies).
      evidence.videoOverdue = !delivered && Date.now() > officeDue.getTime();
      if (delivered) {
        // The date is still worth showing beside the delivery sentence.
        evidence.reason += ` The office's video date was ${when}.`;
      } else if (builtFromSla) {
        const others = evidence.missing.filter((m) => m !== "Video");
        const tierWord = sig.videoTier === "premium" ? "Premium" : "Standard";
        const lead = evidence.present.includes("Photos") ? "Photos delivered." : "Delivery underway.";
        evidence.reason = evidence.videoOverdue
          ? `Video overdue — the office's date was ${when}. Confirm it was delivered to the client, or upload it.`
          : `${lead} ${tierWord} video due ${when} (set by the office).`;
        if (others.length) evidence.reason += ` Also missing ${others.join(", ")}.`;
      } else {
        evidence.reason += ` Video due ${when} (set by the office).`;
      }
    }
    if (p.statusPinnedAt) {
      if (final !== p.status) {
        const wouldBe = STATUS_WORD[final] ?? final;
        evidence.reason = `Status pinned by the office on ${STATUS_WORD[p.status] ?? p.status} (${p.statusPinnedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}); on its own the hub would read ${wouldBe} — ${evidence.reason}`;
      }
      final = p.status;
    }

    if (evidence.partial) partials++;
    byStatus[final] = (byStatus[final] ?? 0) + 1;

    const statusChanged = final !== p.status;

    // Cull-at-the-source (Jul 2026 audit). Raws in but not yet delivered is the
    // only window where over-shooting can still be fixed cheaply. When the live
    // raw count blows past the home's photo budget × the overage factor, stamp
    // the evidence (so the project page shows WHY) and mint ONE cull task + text
    // the photographer below. SHOT/EDITING only — never nag a delivered job.
    // Nor one whose photos are already out: an EDITING job now survives the
    // photos-delivered recompute (Sep 10, above), and thinning raws after the
    // photos went out buys nothing — the text would only puzzle the photographer.
    let cullOver = false;
    if (
      ["SHOT", "EDITING"].includes(final) &&
      !evidence.present.includes("Photos") &&
      sig.dropbox &&
      !sig.dropbox.stale &&
      sig.dropbox.rawPhotos > 0
    ) {
      const photoTarget = photoTargetFor(p);
      const rawPhotos = sig.dropbox.rawPhotos;
      if (rawPhotos > photoTarget * RAW_OVERAGE_FACTOR) {
        cullOver = true;
        evidence.cull = { rawPhotos, photoTarget, overBy: rawPhotos - photoTarget * BRACKET_RATIO };
      }
    }

    // First arrival at DELIVERED — the same condition that stamps deliveredAt
    // below; drives the one-time "Delivered" bell inside the statusChanged block.
    const justDelivered = final === "DELIVERED" && !p.deliveredAt;
    // Standard delivery due = shoot date + longest turnaround of what was ordered.
    // The office's tier moves this promise too (Sep 16) — the editor queue's
    // due cell and the delivery board both read Project.deliveryDue, so a
    // branding job re-sold after booking has to stop reading "due in 48h"
    // there as well as on the card.
    const promise = p.shootDate
      ? deliveryPromiseFor(p.shootDate, p.deliverables, isMonthlyContentJob(p.deliverables), null, {
          tier: slaTierOf(p),
          // …and the reel's half of that promise runs from the leg it was
          // filmed on, not from whichever leg shootDate points at (Sep 16).
          videoAnchor: sig.videoAnchor,
        })
      : null;
    const deliveryDue = promise?.at ?? null;
    // Raws detected in Dropbox → stamp uploadedAt (first time only). This sweep
    // is the path that ACTUALLY detects uploads in prod, but it never wrote the
    // timestamp — so /upload kept showing "Upload" CTAs on jobs whose raws were
    // fully in, and photographers got no confirmation their drop registered
    // (July 2026 audit).
    // Not before the shoot: files under a pending job's name are another
    // job's, and the stamp is what lit "Uploaded" on /upload and "Submitted —
    // you're good to go" on Harrison's page for a shoot that hadn't happened
    // (Sep 8 2026 audit, 1946 Rowan St).
    // Nor while the office holds the job in Waiting (Sep 11): the office has
    // said the files in the folder are not this job's footage, and the stamp
    // is what lights "Uploaded" on /upload for a page nobody submitted.
    // A Waiting the office PINNED through the override dialog (Sep 13) is the
    // same word said harder — the override releases the hold and relies on
    // the pin, so the pin has to carry this rule too.
    const pinnedWaiting = !!p.statusPinnedAt && (p.status === "BOOKED" || p.status === "SCHEDULED");
    const rawsDetected = !sig.shootPending && !held && !pinnedWaiting && !!sig.dropbox && sig.dropbox.rawPhotos + sig.dropbox.rawVideo > 0;
    await prisma.project.update({
      where: { id: p.id },
      data: {
        status: final,
        statusEvidence: JSON.stringify(evidence),
        statusCheckedAt: new Date(),
        // The honest read (RTP-06). A pass that got everything it asked for
        // advances succeededAt and clears the error; a pass where ONE source
        // failed — Aryeo 503, a Dropbox 429 — advances only attemptedAt and
        // records why, even though the evidence below is still written from
        // the counts we do have (carried forward and marked stale). A stale
        // zero never proves absence; a stale positive never proves a new
        // delivery. Nothing here changes the status decision above.
        ...evidenceStamps(sig.read),
        ...(deliveryDue ? { deliveryDue } : {}),
        ...(final === "DELIVERED" && !p.deliveredAt ? { deliveredAt: new Date() } : {}),
        ...(rawsDetected && !p.uploadedAt ? { uploadedAt: new Date() } : {}),
        // First live Aryeo image → the My Shoots thumbnail (refresh if it changes).
        ...(sig.aryeo?.cover && sig.aryeo.cover !== p.coverImageUrl ? { coverImageUrl: sig.aryeo.cover } : {}),
      },
    });

    // ---- FREEZE THE PROMISE, ONCE, THE FIRST TIME THIS JOB HAS ONE ----------
    //
    // Until now NOTHING in the application wrote Project.promisedDueAt (review,
    // Sep 18: a grep of src/ found reads only). The whole freeze was one
    // historical pass — scripts/pin-promises.ts — so it covered exactly the 538
    // rows that existed the day it ran, and every job booked after it was
    // unpinned: deliveryDue is recomputed from today's table on EVERY pass of
    // this sweep, so the next turnaround change would re-date all of them and
    // re-score the owner's on-time dial and the photographer's quarterly bonus
    // against deadlines nobody ever quoted. That is the exact failure the pin
    // was invented to stop, and it was live again for every new job.
    //
    // Four rules, all enforced on this one line:
    //   · ONLY when there is a date  — `promise` is null without a shoot date,
    //     and a pin of null is not a promise.
    //   · ONLY WHEN THE CLOCK HAS ACTUALLY STARTED — the shoot has happened.
    //     Not at booking: an Aryeo order keeps growing after it lands, and a
    //     promise frozen off half an order is worse than no promise at all,
    //     because the pin CAPS every later item (cappedByPromise). 893 S
    //     Matlack was booked Aug 21 and its VIDEO row arrived Aug 25 — pinned
    //     at booking, its 16-video branding batch would have been capped at
    //     the photo date and read late from the day it was ordered. Before the
    //     shoot nothing is judged anyway: no deliverable is late, no dial
    //     counts the job, and deliveryDue is recomputed every pass regardless.
    //     Measured on production (scripts/_fix/B/p12-growth-after-shoot.ts,
    //     excluding the Jun 23 backfill that created rows for 1,356 projects
    //     at once): orders grow after the project row on 12 of 1,479 jobs and
    //     after the shoot on 7 — so waiting for the shoot removes most of the
    //     exposure, and the rest is a known 0.5%.
    //   · ONLY when something is OWED — with no owed row left, the ladder's
    //     answer is a bare 48h fallback, which is not a promise about anything.
    //   · ONLY when there is no pin  — the `promisedDueAt: null` in the WHERE
    //     makes that atomic, so two sweeps racing (or a re-run after a crash)
    //     can never move a promise that is already made. updateMany, not
    //     update, because update cannot carry that guard.
    //   · NEVER an update           — nothing anywhere writes these columns a
    //     second time. An office change of date goes to dueOverrideAt, which
    //     outranks the pin in effectiveDue.
    // The tier and the aim come from the same ladder that produced the date
    // (tasks.deliveryPromiseFor), so a pin made here records what pin-promises
    // had to reconstruct by hand for the rows that pre-date it.
    const clockHasStarted = !!p.shootDate && p.shootDate <= new Date();
    if (promise && clockHasStarted && p.deliverables.length > 0 && !p.promisedDueAt) {
      await prisma.project.updateMany({
        where: { id: p.id, promisedDueAt: null },
        data: {
          promisedDueAt: promise.at,
          promisedTargetAt: promise.targetAt,
          promisedTierKey: promise.tierKey,
          promisedPinnedAt: new Date(),
        },
      });
    }

    // Reflect category presence onto the deliverable rows for the portal/detail.
    await syncDeliverableStatuses(p, evidence);

    // Over-shot the budget → mint ONE cull task + text the photographer, so the
    // pile gets thinned BEFORE it costs editing money. Deduped per project inside
    // mintCullTask. Best-effort; never breaks the sweep.
    if (cullOver && evidence.cull) {
      try {
        const { mintCullTask } = await import("@/lib/tasks");
        await mintCullTask({
          projectId: p.id,
          title: p.title,
          rawPhotos: evidence.cull.rawPhotos,
          target: evidence.cull.photoTarget,
          photographerId: p.photographerId,
          photographerName: p.photographer?.name ?? null,
        });
      } catch { /* cull nudge is best-effort */ }
    }

    // Vendor round-trip chase (audit crack #16): a floor plan (CubiCasa) or the
    // photo edits (AutoHDR) still missing days after the shoot means the vendor
    // handoff dropped — mint ONE deduped chase task per project+category.
    // Non-delivered production stages only; best-effort, never breaks the sync.
    if (["SHOT", "EDITING", "REVIEW"].includes(final) && evidence.missing.length > 0) {
      try {
        const { chaseVendorsForMissing } = await import("@/lib/tasks");
        await chaseVendorsForMissing(p.id, {
          title: p.title,
          shootDate: p.shootDate,
          missing: evidence.missing,
        });
      } catch { /* chase is best-effort */ }
    }

    // RAWS LANDED / EDITOR HANDOFF — idempotent and STAGE-INDEPENDENT. The old
    // wiring only fired inside `statusChanged && final === "SHOT"`, which had
    // two fatal holes (July 2026 audit, both proven live in prod): (1) a job
    // whose photos deliver fast jumps SCHEDULED→REVIEW without ever landing on
    // SHOT — its video got NO editor task, NO notification, NO Luma dispatch
    // (4 of 5 video-owing REVIEW jobs had none); (2) the photographer "done"
    // buttons set SHOT directly, so the sweep saw no transition and skipped the
    // handoff. ensureEditorHandoff re-checks every pass and is deduped inside
    // (activity marker + dedupeKeys), so calling it every hour is safe.
    if (["SHOT", "EDITING", "REVIEW"].includes(final)) {
      try {
        const { ensureEditorHandoff } = await import("@/lib/tasks");
        await ensureEditorHandoff(p.id);
      } catch { /* handoff is best-effort — never break the sweep */ }
    }
    // Finished cuts → Review Room, one row per (file, round) with a playable
    // link. REVISION included on purpose: a multi-video monthly job sits in
    // REVISION from the first bounce on, and that is exactly when videos
    // 2..N and the redo land (audit HIGH: no playable video on any
    // submission; a batch got one blank placeholder). Stale counts are fine
    // here — a stale finalVideo>0 came from a real read.
    // REVIEW/REVISION run discovery UNCONDITIONALLY: once Aryeo carries the
    // original video (a post-delivery revision, or video #1 of a batch) the
    // sweep no longer reads Dropbox, so the evidence count can't be the gate
    // — the redo would never enter the room (review). listFinalCuts is one
    // cheap listing and returns [] for an empty folder.
    // Opt-in only (Settings → Review Room): cuts reach the room by UPLOAD
    // through the editor portal; reading the Final folder is the fallback.
    const discover = (await reviewRoomRules()).discoverFromDropbox;
    if (
      discover &&
      ((["REVIEW", "REVISION"].includes(final)) ||
        (["SHOT", "EDITING"].includes(final) && (sig.dropbox?.finalVideo ?? 0) > 0))
    ) {
      try {
        const { discoverCutsForReview } = await import("@/lib/reviewCuts");
        await discoverCutsForReview(p.id, p.title);
      } catch { /* discovery is best-effort — never break the sweep */ }
    } else if (discover && final === "DELIVERED") {
      // A delivered job carrying one of the old blank placeholders: give it
      // its file and record what delivery meant (approved). Aryeo satisfies
      // these jobs so Dropbox isn't consulted above — check the row instead.
      try {
        const blank = await prisma.reviewSubmission.count({
          where: { projectId: p.id, assetPath: null, status: "PENDING", submittedByName: "Auto — Final folder" },
        });
        if (blank > 0) {
          const { discoverCutsForReview } = await import("@/lib/reviewCuts");
          await discoverCutsForReview(p.id, p.title);
        }
      } catch { /* best-effort */ }
    }

    // DELIVERED — re-attempt the delivery-text mint every pass, not just on the
    // transition. A monthly-content job holds the task back until its video
    // BATCH is really done (createDeliveryTextTask), and videos 2-4 land days
    // after the status flip; without this re-check the task would never be
    // created and the client would never hear from us (review HIGH).
    // dedupeKey-guarded inside, so re-calling hourly is a no-op once minted.
    // Monthly plans owe a BATCH: Product.videoQuantity (Starter 2 / Accelerator
    // 4 / Pro 8, set on /settings/products) only multiplies at Aryeo sync time,
    // so rows created before a product was mapped sit at quantity 1 and the
    // editor queue says "1 deliverable" for a 2-video session (Jordan, Sep 1 —
    // 1033 Preserve Ln). Self-heal every pass; never lowers a count.
    try {
      const { isMonthlyContentJob, monthlyVideoQuota } = await import("@/lib/pipeline");
      if (final !== "CANCELLED" && isMonthlyContentJob(p.deliverables, p.packageName)) {
        const names = [p.packageName, ...p.deliverables.map((d) => d.label)];
        // A product that STATES its batch outranks the plan table (Sep 16,
        // Kyle call): "Custom Branding Video Package 16 Videos Total" is a
        // 16-video package sold outside Starter/Accelerator/Pro, and
        // monthlyVideoQuota would file it under the generic 4. The number is
        // written on the product; read it rather than guess.
        const stated = names
          .map((n) => /(\d{1,2})\s+videos?\b/i.exec(n ?? "")?.[1])
          .filter(Boolean)
          .map(Number)
          .filter((n) => n > 0 && n <= 60);
        // Never LOWER the plan's own number with a stated one (Sep 16 review):
        // a Pro label that happens to say "4 videos" in its blurb must not
        // drop the quota from 8. The bigger of the two wins, and this whole
        // block never lowers a row's quantity either.
        const quota = Math.max(...stated, monthlyVideoQuota(names));
        for (const d of p.deliverables) {
          if (d.type !== "VIDEO" && d.type !== "SOCIAL_REEL") continue;
          if ((d.quantity ?? 1) >= quota) continue;
          await prisma.deliverable.update({ where: { id: d.id }, data: { quantity: quota } }).catch(() => {});
        }
      }
    } catch { /* best-effort */ }

    if (final === "DELIVERED") {
      try {
        const { createDeliveryTextTask } = await import("@/lib/tasks");
        await createDeliveryTextTask(p.id);
      } catch { /* best-effort */ }
    }

    // RAWS MISSING watchdog — the counterpart alarm. Shoot happened, 18+ hours
    // passed, and the raw folders are KNOWN empty (not unknown — Dropbox errors
    // don't count): the job is silently rotting in SCHEDULED (877 S York sat 11
    // days with nobody told — July 2026 audit). Mint ONE deduped chase task +
    // ring/SMS the photographer. Auto-clears inside when raws land.
    // SHOT is included deliberately. A photographer pressing "Mark shoot
    // complete" in the field flips the job to SHOT, and the old gate of
    // BOOKED/SCHEDULED meant exactly the people who told us they had finished
    // were the ones never chased for their files — the hole this watchdog was
    // built to close. Marking it shot is a claim about the camera, not about
    // Dropbox.
    if (["BOOKED", "SCHEDULED", "SHOT"].includes(final) && shootHappened) {
      try {
        const { reconcileRawsMissing } = await import("@/lib/tasks");
        await reconcileRawsMissing(p.id, {
          // "Known empty" needs a read from THIS pass: a stale zero carried from
          // the night before the shoot must not mint a "no raws" chase after
          // the raws landed (that chase is one-per-project, forever).
          rawsKnownEmpty: !!sig.dropbox && !sig.dropbox.stale && sig.dropbox.rawPhotos + sig.dropbox.rawVideo === 0,
          anyAryeoMedia: !!sig.aryeo && sig.aryeo.photos + sig.aryeo.videos > 0,
          dropboxReadable: !sig.dropboxUnavailable,
        });
      } catch { /* watchdog is best-effort */ }
    }

    if (statusChanged) {
      changed++;
      // Delivered/cancelled jobs shouldn't keep open production tasks.
      if (final === "DELIVERED" || final === "CANCELLED") {
        const { closeObsoleteTasks } = await import("@/lib/tasks");
        await closeObsoleteTasks(p.id, final);
      }
      await prisma.activity.create({
        data: {
          projectId: p.id,
          type: "SYSTEM",
          body: `Status re-evaluated: ${p.status} → ${final}. ${evidence.reason}`,
        },
      });
      // Bell: the job just shipped — ops broadcast + the photographer who shot
      // it (per-editor rows are skipped in v1; they see /editing clear). The
      // delivery_text task above is untouched — this is the announcement, not
      // the work item. Best-effort.
      if (justDelivered) {
        try {
          const { notifyInApp } = await import("@/lib/notify");
          const targets: NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
          if (p.photographerId) targets.push({ roles: ["PHOTOGRAPHER"], userKey: `tm:${p.photographerId}` });
          await notifyInApp({
            kind: "delivery_out",
            title: `Delivered — ${(p.title || "this job").split(",")[0].trim()}`,
            href: `/projects/${p.id}`,
            targets,
            dedupeKey: `delivered-${p.id}`,
          });
        } catch { /* bell is best-effort */ }
      }
    }
  }

  return { checked: projects.length, changed, partials, byStatus, dropboxUnreadable, dropboxErrors };
}

// Mark each deliverable DONE/PENDING based on whether its category is present.
async function syncDeliverableStatuses(p: StatusProject, evidence: StatusEvidence) {
  const presentSet = new Set(evidence.present);
  // Human-owned states the hourly sweep must never stomp (audit Aug 25: the
  // photographer's UPLOADED tick and the owner's IN_PROGRESS/FLAGGED picks
  // were rewritten to PENDING every hour). DONE still wins over them — live
  // Aryeo evidence is stronger than any manual state.
  const MANUAL_STATES = new Set(["UPLOADED", "IN_PROGRESS", "FLAGGED"]);
  for (const d of p.deliverables) {
    const cats = expectedCategories([d]);
    if (cats.size === 0) continue;
    const done = [...cats].every((c) => presentSet.has(CATEGORY_LABEL[c]));
    const next = done ? "DONE" : "PENDING";
    if (d.status === next) continue; // hundreds of no-op writes/day, gone
    if (!done && MANUAL_STATES.has(d.status as string)) continue;
    await prisma.deliverable.update({
      where: { id: d.id },
      data: { status: next as never },
    });
  }
}
