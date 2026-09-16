import "server-only";
import { prisma } from "@/lib/prisma";
import { parseEvidence, EVIDENCE_STALE_HOURS, type ParsedEvidence } from "@/lib/statusEvidence";
import { effectiveSlotCounts } from "@/lib/editOverrides";
import { isMonthlyContentJob, monthlyVideoQuota } from "@/lib/pipeline";
import { videoStyleFor } from "@/lib/videoStyles";
import type { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// THE UNIT (RTP-03 / RTP-05 / RTP-24, Sep 16 — PHASE 0, READ-ONLY).
//
// docs/COMPLETION-CONTRACT.md is the decision document this file makes
// executable. Nothing here writes a row, and nothing here is wired into a
// screen: it exists so the reconciliation report can show Jordan, per job,
// what the new model would say against what the screens say today — BEFORE a
// single column is added or backfilled. Every predicate below is the contract's
// predicate, in the same order, with the same words.
//
// The unit of everything is ONE DELIVERABLE SLOT — not the job and not the
// coarse category. `Deliverable` is one row per TYPE and `ReviewSubmission` is
// the only table that already carries a (deliverableId, slot) identity (and
// only for video), which is why today's rollup collapses PHOTOS / TWILIGHT /
// DRONE / HEADSHOT / VIRTUAL_STAGING into one "Photos" verdict and hands a
// four-video batch a single yes/no. The unit is that missing row, computed
// rather than stored, so Phase 0 can measure the change it would cause.
//
// The slot arithmetic is BYTE-FOR-BYTE what the Editing Room already computes
// (reviewCuts.cutSlots / its pure twin pureSlots, both via
// editOverrides.effectiveSlotCounts), so a unit key `deliverableId:slot` joins
// the existing ReviewSubmission rows with nothing rewritten.
// ---------------------------------------------------------------------------

/** Drift guard (the qcCategories lesson): tasks.ts:OWED_DELIVERABLE_WHERE is
 *  the ROW-level "is this still owed", and its two keys are exactly the two
 *  terminal unit states below. If a third way to stop owing a row is ever
 *  added there, this stops compiling until REMOVED/WAIVED grow a sibling.
 *  Type-only import — no runtime dependency on tasks.ts from this module. */
type OwedWhereKey = keyof typeof OWED_DELIVERABLE_WHERE;
type OwedKeysCovered = Exclude<OwedWhereKey, "removedFromOrderAt" | "waivedAt"> extends never ? true : never;
const _owedKeysCovered: OwedKeysCovered = true;
void _owedKeysCovered;

// ---------------------------------------------------------------------------
// States. Derived on every read; never hand-written except through a named
// office column (waivedAt, removedFromOrderAt today; deliveredVia='office-hand'
// in Phase 1). See the contract, section "The state machine".
// ---------------------------------------------------------------------------
export type UnitState =
  | "OWED" // required, no evidence of any kind
  | "RAW_IN" // raw files exist for this unit. NOT a product
  | "REVIEW_READY" // a version exists: a live review round, or an artefact off the listing
  | "APPROVED" // we accept it. Explicitly NOT delivery
  | "DELIVERED" // positive client-visible evidence
  | "WAIVED" // the office said "not required on this job"
  | "REMOVED" // off the order, or moved to another order
  | "UNKNOWN"; // the hub cannot see this unit's evidence — never folded into owed OR delivered

/** The states that still count as work owed. The contract's word `owed`,
 *  generalised from tasks.OWED_DELIVERABLE_WHERE (the row) to the unit. */
export const OWED_STATES = ["OWED", "RAW_IN", "REVIEW_READY", "APPROVED"] as const;

/** Finer than the four evidence categories the status engine collapses to —
 *  that collapse IS the defect (55 live add-on units read DONE off one listing
 *  photo). Kept as its own vocabulary so a drone obligation can be named. */
export type UnitCategory =
  | "PHOTOS"
  | "DRONE"
  | "TWILIGHT"
  | "HEADSHOT"
  | "VIRTUAL_STAGING"
  | "VIDEO"
  | "FLOORPLAN"
  | "THREED"
  | "OTHER";

/** Which live counter, if any, can EVER prove this unit reached the client.
 *  "none" is the honest answer for the photo add-ons: Aryeo gives one gallery
 *  count, so nothing in the data distinguishes the twilight frames from the
 *  daylight ones (open question 8 — Kyle ticks them, or we state the
 *  assumption on screen). A unit with no channel is never DELIVERED by
 *  evidence and never silently OWED either: it is UNKNOWN. */
export type EvidenceChannel = "aryeo.photos" | "aryeo.videos" | "aryeo.floorPlans" | "aryeo.interactive" | "none";

const CATEGORY_BY_TYPE: Record<string, UnitCategory> = {
  PHOTOS: "PHOTOS",
  DRONE: "DRONE",
  TWILIGHT: "TWILIGHT",
  HEADSHOT: "HEADSHOT",
  VIRTUAL_STAGING: "VIRTUAL_STAGING",
  VIDEO: "VIDEO",
  SOCIAL_REEL: "VIDEO",
  FLOORPLAN: "FLOORPLAN",
  MATTERPORT_3D: "THREED",
  ZILLOW_3D: "THREED",
  OTHER: "OTHER",
};

const CHANNEL_BY_CATEGORY: Record<UnitCategory, EvidenceChannel> = {
  PHOTOS: "aryeo.photos",
  VIDEO: "aryeo.videos",
  FLOORPLAN: "aryeo.floorPlans",
  THREED: "aryeo.interactive",
  // No independent signal exists for these — they land inside the same gallery.
  DRONE: "none",
  TWILIGHT: "none",
  HEADSHOT: "none",
  VIRTUAL_STAGING: "none",
  OTHER: "none",
};

const CATEGORY_WORD: Record<UnitCategory, string> = {
  PHOTOS: "Photos",
  DRONE: "Drone",
  TWILIGHT: "Twilight",
  HEADSHOT: "Headshots",
  VIRTUAL_STAGING: "Virtual staging",
  VIDEO: "Video",
  FLOORPLAN: "Floor plan",
  THREED: "3D tour",
  OTHER: "Other",
};

export function unitCategoryFor(type: string): UnitCategory {
  return CATEGORY_BY_TYPE[type] ?? "OTHER";
}
export function evidenceChannelFor(category: UnitCategory): EvidenceChannel {
  return CHANNEL_BY_CATEGORY[category];
}
export function categoryWord(category: UnitCategory): string {
  return CATEGORY_WORD[category];
}

/** The photo lane: everything Aryeo delivers inside the one listing gallery. */
export const PHOTO_LANE: UnitCategory[] = ["PHOTOS", "DRONE", "TWILIGHT", "HEADSHOT", "VIRTUAL_STAGING"];

// ---------------------------------------------------------------------------
// Inputs — plain row shapes, so computeUnits() is pure and testable without a
// database. Every field is one that already exists at HEAD.
// ---------------------------------------------------------------------------
export type UnitDeliverableInput = {
  id: string;
  type: string;
  label: string | null;
  quantity: number | null;
  /** today's row verdict — what the project page, portal and QC card read */
  status: string;
  capturedAt: Date | null;
  uploadedAt: Date | null;
  waivedAt: Date | null;
  removedFromOrderAt: Date | null;
  removedFromOrderNote?: string | null;
  videoStyle: string | null;
  productTitle: string | null;
  createdAt?: Date | null;
};

export type UnitSubmissionInput = {
  id: string;
  deliverableId: string | null;
  slot: number | null;
  assetPath: string | null;
  status: string;
  round: number;
  decidedAt: Date | null;
  completedAt: Date | null;
  withdrawnAt: Date | null;
};

export type UnitProjectInput = {
  id: string;
  title: string | null;
  addressLine: string | null;
  status: string;
  deliveredAt: Date | null;
  shootDate: Date | null;
  packageName: string | null;
  videosFilmed: number | null;
  videosOwedOverride: number | null;
  statusEvidence: string | null;
  statusCheckedAt: Date | null;
  /** RTP-06's honest stamps. Null on every row until the sweep has run once
   *  with them — computeUnits falls back to statusEvidence.checkedAt so the
   *  Phase 0 report is meaningful on today's data. */
  evidenceAttemptedAt?: Date | null;
  evidenceSucceededAt?: Date | null;
  evidenceError?: string | null;
  aryeoListingId?: string | null;
  contentMonthId?: string | null;
  deliverables: UnitDeliverableInput[];
  reviewSubmissions: UnitSubmissionInput[];
};

/** Why a unit is in the state it is — the sentence a screen would print. The
 *  contract's rule that a completion explanation must NAME ITS SOURCE. */
export type UnitEvidenceSource =
  | "aryeo-listing"
  | "review-approved"
  | "review-open"
  | "dropbox-final"
  | "dropbox-raw"
  | "deliverable-stamp"
  | "office-waived"
  | "order-removed"
  | "no-evidence-channel"
  | "source-unreadable"
  | "stale-read"
  | "never-read"
  | "nothing-yet";

export type Unit = {
  projectId: string;
  deliverableId: string;
  slot: number;
  /** slots this deliverable row owes in total (the "of 4") */
  count: number;
  type: string;
  category: UnitCategory;
  channel: EvidenceChannel;
  /** "Personal Branding Reel — Video 2 of 4", "Twilight", … */
  label: string;
  state: UnitState;
  source: UnitEvidenceSource;
  /** plain-English sentence naming the ACTUAL source (never "confirmed live on
   *  Aryeo" for a file that was only ever in Dropbox) */
  reason: string;
  /** today's Deliverable.status, spread across every slot of the row — what the
   *  screens say about this unit right now */
  todayRowStatus: string;
  /** the approved round for this slot, when there is one */
  approvedSubmissionId: string | null;
  latestRound: number | null;
};

/** How much the last evidence pass can be trusted for this job.
 *
 *  TWO questions, not one (Sep 16 review of RTP-03): `trusted` is "did a read
 *  ever actually succeed", `fresh` is "recently enough to prove an ABSENCE".
 *  They are separate because evidence is not symmetric —
 *    · a POSITIVE observation keeps (the gallery was live and released on Jun
 *      20; media does not un-deliver, so that job is still delivered), and
 *    · a NEGATIVE one rots (the listing showed no video on Jun 20 — it may
 *      have gone out the next morning, so "still owed" is a guess).
 *  So `trusted` gates what the read SAW and `fresh` gates what it DIDN'T. */
export type EvidenceRead = {
  trusted: boolean;
  /** within RECONCILE_STALE_HOURS of a successful read — required before any
   *  absence may be read as an obligation */
  fresh: boolean;
  reason: "ok" | "never-read" | "failed-last-pass" | "no-listing" | "stale";
  /** ISO of the last read we believe actually succeeded */
  succeededAt: string | null;
  /** hours since that read, for the sentence a screen would print */
  ageHours: number | null;
  error: string | null;
  /** Dropbox counts were carried forward from an older pass */
  dropboxStale: boolean;
};

/** How old a SUCCESSFUL read may be and still prove that something is missing.
 *  Deliberately the hub's existing number (statusEvidence.EVIDENCE_STALE_HOURS,
 *  what the project card already calls stale) rather than a second definition
 *  of stale invented for this contract — see COMPLETION-CONTRACT.md §4/§8. */
export const RECONCILE_STALE_HOURS = EVIDENCE_STALE_HOURS;

export type ProjectUnits = {
  projectId: string;
  title: string | null;
  street: string;
  status: string;
  deliveredAt: Date | null;
  contentMonthId: string | null;
  evidence: EvidenceRead;
  units: Unit[];
};

// ---------------------------------------------------------------------------
// THE PURE COMPUTATION.
// ---------------------------------------------------------------------------

const isVideoRow = (d: { type: string }) => d.type === "VIDEO" || d.type === "SOCIAL_REEL";
const NOT_A_CUT = ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"];

/** Trust in the last evidence read. attempted/succeeded is the RTP-06 split;
 *  until the sweep stamps them, a parsed statusEvidence blob with a checkedAt
 *  is the legacy proxy for "we looked once". A stale zero never proves absence
 *  and a stale positive never proves a new delivery — so every conclusion this
 *  module draws from an untrusted read is UNKNOWN, not OWED and not DELIVERED. */
export function evidenceReadFor(p: UnitProjectInput, ev: ParsedEvidence | null, now: Date = new Date()): EvidenceRead {
  const dropboxStale = ev?.dropbox?.stale === true;
  const ageOf = (at: string | null): number | null => {
    if (!at) return null;
    const t = Date.parse(at);
    return Number.isFinite(t) ? (now.getTime() - t) / 3_600_000 : null;
  };
  const untrusted = (reason: EvidenceRead["reason"], succeededAt: string | null, error: string | null): EvidenceRead => ({
    trusted: false,
    fresh: false,
    reason,
    succeededAt,
    ageHours: ageOf(succeededAt),
    error,
    dropboxStale,
  });
  /** A read that did succeed — its age decides whether it may prove an absence. */
  const succeeded = (succeededAt: string): EvidenceRead => {
    const ageHours = ageOf(succeededAt);
    const fresh = ageHours !== null && ageHours <= RECONCILE_STALE_HOURS && !dropboxStale;
    return { trusted: true, fresh, reason: fresh ? "ok" : "stale", succeededAt, ageHours, error: null, dropboxStale };
  };

  if (p.evidenceAttemptedAt) {
    const ok = !!p.evidenceSucceededAt && p.evidenceSucceededAt.getTime() >= p.evidenceAttemptedAt.getTime();
    if (!ok) {
      return untrusted("failed-last-pass", p.evidenceSucceededAt ? p.evidenceSucceededAt.toISOString() : null, p.evidenceError ?? null);
    }
    return succeeded(p.evidenceSucceededAt!.toISOString());
  }
  if (!ev || !ev.checkedAt) {
    return untrusted("never-read", null, null);
  }
  // A job with no Aryeo listing has no client-visible channel at all: Aryeo is
  // where a client sees their media, so "we read nothing" is the truth, not a
  // zero. Manual/hub-created jobs live here.
  if (!ev.aryeo) {
    return untrusted("no-listing", ev.checkedAt, null);
  }
  return succeeded(ev.checkedAt);
}

/** Every unit this job owes, with the state the evidence actually supports.
 *  Pure: same rows in, same units out, no clock beyond `now` (used only for
 *  nothing at present — states are evidence, not time; overdue is separate). */
export function computeUnits(p: UnitProjectInput, now: Date = new Date()): ProjectUnits {
  const ev = parseEvidence(p.statusEvidence);
  const read = evidenceReadFor(p, ev, now);
  const street = (p.title || p.addressLine || "Project").split(",")[0].trim();

  // ---- the slots -----------------------------------------------------------
  // Video rows: exactly cutSlots()' arithmetic — per-row quantity, the monthly
  // batch on the FIRST video row, then the office's total laid over the lot.
  // Non-video rows: one unit per row (slot 1). Aryeo sells "photos" as one
  // line item; the add-ons are their own rows, which is what makes them
  // countable here and invisible in the four-category rollup.
  //
  // "Exactly" means the SAME ROW SET cutSlots reads: it selects video rows
  // `where removedFromOrderAt: null`, so a removed row must not sit in this
  // list either (Sep 16 review). It matters because the office's total is
  // split by ROW INDEX — 893 S Matlack St (videos owed 16, two video rows, one
  // removed) hands the 15 to the removed row otherwise, and the Editing Room's
  // 16 live cuts read as 1. A removed video row is one REMOVED unit and takes
  // no slot from the rows still on the order.
  const videoRows = p.deliverables.filter((d) => isVideoRow(d) && !d.removedFromOrderAt);
  const monthly = isMonthlyContentJob(videoRows, p.packageName);
  const quota = monthlyVideoQuota([p.packageName, ...videoRows.map((d) => d.label)]);
  const tier = videoRows.length === 0 ? null : videoTierOf(videoRows);
  const baseCounts = videoRows.map((d, i) => {
    let count = Math.max(1, d.quantity ?? 1);
    if (monthly && i === 0) count = Math.max(count, p.videosFilmed ?? quota);
    return count;
  });
  const videoCounts = effectiveSlotCounts(p, baseCounts);

  // ---- the evidence --------------------------------------------------------
  const aryeo = ev?.aryeo ?? null;
  const dropbox = ev?.dropbox ?? null;
  const listingDelivered = aryeo?.delivery === "DELIVERED";
  const counterFor = (channel: EvidenceChannel): number | null => {
    if (!aryeo || channel === "none") return null;
    if (channel === "aryeo.photos") return aryeo.photos ?? 0;
    if (channel === "aryeo.videos") return aryeo.videos ?? 0;
    if (channel === "aryeo.floorPlans") return aryeo.floorPlans ?? 0;
    return aryeo.interactive ?? 0;
  };

  // Rounds, keyed the way reviewCuts.cutKeyOf keys them. A withdrawn round is
  // kept (the history is the point) but is not a cut anybody is waiting on.
  const byKey = new Map<string, UnitSubmissionInput[]>();
  for (const s of p.reviewSubmissions) {
    if (!s.deliverableId) continue; // legacy folder-discovered rows key on a path, not a slot
    if (s.withdrawnAt || NOT_A_CUT.includes(s.status)) continue;
    const k = `${s.deliverableId}:${s.slot ?? 1}`;
    const arr = byKey.get(k) ?? [];
    arr.push(s);
    byKey.set(k, arr);
  }

  // How many client-visible videos the listing can account for, spent slot by
  // slot in order. Aryeo names no cut, so which slot a listing video IS cannot
  // be known — the allocation is stated as an assumption in the contract and
  // reported as one. Same rule for the photo lane, where the count is 0 or 1
  // slots wide anyway.
  let videoDeliveryBudget = listingDelivered ? counterFor("aryeo.videos") ?? 0 : 0;
  // Final-folder artefacts the listing does NOT account for: a produced video
  // that never reached the client. This is the Q7 population — 11 jobs since
  // Aug 1 read "All ordered deliverables confirmed live on Aryeo" off one.
  let videoArtefactBudget = dropbox && !read.dropboxStale ? dropbox.finalVideo ?? 0 : 0;

  const units: Unit[] = [];
  let videoRowIndex = -1;

  for (const d of p.deliverables) {
    const category = unitCategoryFor(d.type);
    const channel = evidenceChannelFor(category);
    const video = isVideoRow(d);
    // Only rows still ON the order draw from the office's slot budget — the
    // same rows cutSlots counts. A removed video row produces its one REMOVED
    // unit below and does not advance the index.
    const liveVideo = video && !d.removedFromOrderAt;
    if (liveVideo) videoRowIndex++;
    const count = liveVideo ? videoCounts[videoRowIndex] ?? 0 : 1;
    const styleName = video ? videoStyleFor(d, { monthly, tier }).name : CATEGORY_WORD[category];

    for (let slot = 1; slot <= count; slot++) {
      const label = video && count > 1 ? `${styleName} — Video ${slot} of ${count}` : styleName;
      const rounds = byKey.get(`${d.id}:${slot}`) ?? [];
      const approved = rounds.find((r) => r.status === "APPROVED") ?? null;
      const open = rounds.find((r) => r.status === "PENDING" || r.status === "CHANGES_REQUESTED") ?? null;
      const latestRound = rounds.reduce<number | null>((m, r) => (m === null || r.round > m ? r.round : m), null);

      const base = {
        projectId: p.id,
        deliverableId: d.id,
        slot,
        count,
        type: d.type,
        category,
        channel,
        label,
        todayRowStatus: d.status,
        approvedSubmissionId: approved?.id ?? null,
        latestRound,
      };

      // 1. REMOVED / WAIVED — the two office/order facts that end the
      //    obligation. Same pair as tasks.OWED_DELIVERABLE_WHERE, and neither
      //    is ever cleared by a sweep.
      if (d.removedFromOrderAt) {
        units.push({
          ...base,
          state: "REMOVED",
          source: "order-removed",
          reason: d.removedFromOrderNote?.trim()
            ? `Off the order — ${d.removedFromOrderNote.trim().slice(0, 120)}.`
            : "No longer on the Aryeo order.",
        });
        continue;
      }
      if (d.waivedAt) {
        units.push({ ...base, state: "WAIVED", source: "office-waived", reason: "Waived by the office — not required on this job." });
        continue;
      }

      // 2. DELIVERED — POSITIVE client-visible evidence only. The category is
      //    live on THIS job's listing AND the listing is released to the
      //    client. A Dropbox Final-folder file is not delivery, and neither is
      //    an approval: both are handled below.
      const counter = counterFor(channel);
      if (read.trusted && channel !== "none" && listingDelivered && counter !== null && counter > 0) {
        if (!video) {
          units.push({
            ...base,
            state: "DELIVERED",
            source: "aryeo-listing",
            reason: `Live on the Aryeo listing (${counter} ${counter === 1 ? "file" : "files"}) and released to the client.`,
          });
          continue;
        }
        if (videoDeliveryBudget > 0) {
          videoDeliveryBudget--;
          // A delivered cut is almost certainly one of the files in the Final
          // folder too, so it spends an artefact as well — otherwise a job
          // with one listing video and one Final-folder file would report a
          // SECOND, unexplained cut waiting in the folder.
          if (videoArtefactBudget > 0) videoArtefactBudget--;
          units.push({
            ...base,
            state: "DELIVERED",
            source: "aryeo-listing",
            reason: "On the Aryeo listing and released to the client.",
          });
          continue;
        }
      }

      // 3. APPROVED — WE accept the cut. Not delivery; ReviewSubmission
      //    .completedAt (the Dropbox Final-folder copy) is not delivery either.
      if (approved) {
        // Same accounting as delivery: an approved cut's file is one of the
        // Final-folder files (that is what `completedAt` copies), so it must
        // not also be counted as an unexplained artefact below.
        if (video && videoArtefactBudget > 0) videoArtefactBudget--;
        units.push({
          ...base,
          state: "APPROVED",
          source: "review-approved",
          reason: approved.completedAt
            ? "Approved in the Review Room and copied to the Final folder — the client has not been shown it."
            : "Approved in the Review Room — not yet on the listing.",
        });
        continue;
      }

      // 4. REVIEW_READY — a version exists: an open round, or an artefact in
      //    the Final folder that the listing cannot account for.
      if (open) {
        units.push({
          ...base,
          state: "REVIEW_READY",
          source: "review-open",
          reason: open.status === "CHANGES_REQUESTED" ? "Bounced back to the editor — revision in progress." : `Round ${open.round} waiting on a verdict.`,
        });
        continue;
      }
      if (video && videoArtefactBudget > 0) {
        videoArtefactBudget--;
        units.push({
          ...base,
          state: "REVIEW_READY",
          source: "dropbox-final",
          reason: "A cut is in the job's Final folder but it is not on the Aryeo listing.",
        });
        continue;
      }
      if (!video && PHOTO_LANE.includes(category) && read.trusted && !read.dropboxStale && (dropbox?.finalPhotos ?? 0) > 0 && channel !== "none") {
        units.push({
          ...base,
          state: "REVIEW_READY",
          source: "dropbox-final",
          reason: "Edited photos are in the job's Final folder but not on the Aryeo listing.",
        });
        continue;
      }

      // 5. RAW_IN — files exist, no product yet. The photographer's own stamps
      //    first (they name the row), then the folder counts for the lane.
      if (d.uploadedAt || d.capturedAt) {
        units.push({
          ...base,
          state: "RAW_IN",
          source: "deliverable-stamp",
          reason: d.uploadedAt ? "The photographer marked the raw files uploaded." : "The photographer ticked this off on site.",
        });
        continue;
      }
      if (read.trusted && !read.dropboxStale && dropbox) {
        const raw = video ? dropbox.rawVideo ?? 0 : PHOTO_LANE.includes(category) ? dropbox.rawPhotos ?? 0 : 0;
        if (raw > 0) {
          units.push({ ...base, state: "RAW_IN", source: "dropbox-raw", reason: `${raw} raw ${video ? "clips" : "files"} in the job's folder — nothing produced yet.` });
          continue;
        }
      }

      // 6. UNKNOWN — "the hub cannot see this". Never folded into owed OR
      //    delivered (the contract's sixth word). FOUR distinct reasons, kept
      //    apart because they need different answers: never-read and a failed
      //    read are ops problems, a missing channel is question 8, and a stale
      //    read (below) is the sweep not reaching far enough down the table.
      if (!read.trusted) {
        units.push({
          ...base,
          state: "UNKNOWN",
          source: read.reason === "never-read" ? "never-read" : "source-unreadable",
          reason:
            read.reason === "never-read"
              ? "The hub has never managed to read this job's evidence."
              : read.reason === "no-listing"
                ? "No Aryeo listing on this job — there is no channel that could show the client has it."
                : `The last evidence read failed${read.error ? ` (${read.error})` : ""} — a stale zero is not proof of absence.`,
        });
        continue;
      }
      if (channel === "none" && galleryIsOut(aryeo)) {
        // The add-on population: drone / twilight / headshots / virtual staging
        // land inside the same gallery as the listing photos, so once the
        // gallery is out the hub genuinely cannot tell whether this add-on is
        // in it. Today the row reads DONE off that same gallery; the honest
        // answer is that nobody knows.
        units.push({
          ...base,
          state: "UNKNOWN",
          source: "no-evidence-channel",
          reason: `The photo gallery is out, but Aryeo gives one count for the whole gallery — nothing proves the ${CATEGORY_WORD[category].toLowerCase()} is in it.`,
        });
        continue;
      }
      // A read that SUCCEEDED but is old can still stand behind what it saw
      // (delivery does not undo itself) — it cannot stand behind what it did
      // not see. 103 Swedesford Rd and 198 Bridge St were last read on Jun 20,
      // when the listing had not gone out: calling all four videos "owed" off
      // a June zero is a guess, and a guess must read UNKNOWN (Sep 16 review).
      // The no-channel branch above wins when both apply — "Aryeo counts the
      // whole gallery" is the more specific and more actionable sentence.
      if (!read.fresh) {
        const days = read.ageHours === null ? null : Math.floor(read.ageHours / 24);
        units.push({
          ...base,
          state: "UNKNOWN",
          source: "stale-read",
          reason: read.dropboxStale
            ? "The job folder's counts were carried forward from an older pass — nothing here is a fresh look."
            : `The last successful evidence read was ${days === null ? "a long time" : days === 0 ? "over a day" : `${days} days`} ago — a stale zero is not proof that this is still owed.`,
        });
        continue;
      }

      // 7. OWED — required, and a fresh look found nothing anywhere.
      units.push({ ...base, state: "OWED", source: "nothing-yet", reason: "Nothing produced for this yet." });
    }
  }

  return {
    projectId: p.id,
    title: p.title,
    street,
    status: p.status,
    deliveredAt: p.deliveredAt,
    contentMonthId: p.contentMonthId ?? null,
    evidence: read,
    units,
  };
}

/** The listing gallery has media on it AND the listing is released — the only
 *  condition under which "is the twilight set in there?" becomes unanswerable
 *  rather than simply not-yet-done. */
function galleryIsOut(aryeo: ParsedEvidence["aryeo"]): boolean {
  return !!aryeo && (aryeo.photos ?? 0) > 0 && aryeo.delivery === "DELIVERED";
}

/** The job's video tier by product name — the same two regexes projectStatus
 *  uses, restated here so this module stays free of the status engine (which
 *  imports Aryeo, Dropbox and the settings store). Only feeds the cut's NAME. */
function videoTierOf(videoRows: { label: string | null; productTitle?: string | null }[]): "standard" | "premium" {
  const PREMIUM = /premium|influencer|cinematic|luxury|signature|elite|flagship/i;
  const STANDARD_VETO = /\bstandard\b/i;
  for (const d of videoRows) {
    const t = `${d.productTitle ?? ""} ${d.label ?? ""}`;
    if (PREMIUM.test(t) && !STANDARD_VETO.test(t)) return "premium";
  }
  return "standard";
}

// ---------------------------------------------------------------------------
// THE SIX WORDS — one predicate each, so no reader may invent its own.
// ---------------------------------------------------------------------------

/** owed — the unit is still work. Not DELIVERED / WAIVED / REMOVED, and not
 *  UNKNOWN (an unknown is a question, not an obligation). */
export function isOwed(u: { state: UnitState }): boolean {
  return (OWED_STATES as readonly string[]).includes(u.state);
}

/** approved — a UNIT property. A job is never "approved". */
export function isApproved(u: { state: UnitState }): boolean {
  return u.state === "APPROVED";
}

/** delivered (unit) — positive client-visible evidence. */
export function isDeliveredUnit(u: { state: UnitState }): boolean {
  return u.state === "DELIVERED";
}

/** delivered (job) — every unit is DELIVERED, or was waived/removed. An
 *  UNKNOWN unit blocks it: the hub must not claim a delivery it cannot see.
 *  This is a STATE. Project.deliveredAt stays what it is — the HISTORY fact
 *  that the job was once delivered — and is never rewritten by it. */
export function jobIsDelivered(units: { state: UnitState }[]): boolean {
  if (units.length === 0) return false;
  return units.every((u) => u.state === "DELIVERED" || u.state === "WAIVED" || u.state === "REMOVED");
}

/** The obligation is closed — the predicate every board and recency query
 *  should read INSTEAD of Project.deliveredAt (1337 Carolannes Way: delivered
 *  Aug 28, reopened Sep 14, on no board at all). Delivered-once is history;
 *  this is now. `revisionOpen` is the caller's (comms/review) verdict. */
export function obligationClosed(input: { units: { state: UnitState }[]; revisionOpen: boolean; status: string }): boolean {
  if (input.status === "CANCELLED") return true;
  if (input.revisionOpen) return false;
  return jobIsDelivered(input.units);
}

/** unknown — "the hub cannot see this". Never silently owed or delivered. */
export function isUnknown(u: { state: UnitState }): boolean {
  return u.state === "UNKNOWN";
}

/** overdue — per unit, against ITS OWN promise. Never derived from
 *  Project.status (which is what makes getVideoSlaStatus call a delivered-by-
 *  hand job on-time and an undelivered one late). `promisedAt` is the
 *  contractual promise the caller resolved (office override first). */
export function isOverdue(u: { state: UnitState }, promisedAt: Date | null, now: Date = new Date()): boolean {
  if (!promisedAt) return false;
  if (!isOwed(u)) return false;
  return now.getTime() > promisedAt.getTime();
}

/** overridden — the office's explicit values on this job, each attributed and
 *  un-clearable by any sweep. Phase 0 reads the columns that exist today;
 *  dueOverrideScope and deliveredVia join in Phase 1. */
export function overrideMarks(p: {
  statusPinnedAt?: Date | null;
  dueOverrideAt?: Date | null;
  videosOwedOverride?: number | null;
  tierOverride?: string | null;
  overrideBy?: string | null;
  overrideAt?: Date | null;
}): string[] {
  const out: string[] = [];
  const who = p.overrideBy ? ` by ${p.overrideBy}` : "";
  const when = p.overrideAt ? ` on ${p.overrideAt.toISOString().slice(0, 10)}` : "";
  if (p.statusPinnedAt) out.push(`status pinned${when}${who}`);
  if (p.dueOverrideAt) out.push(`due set${when}${who}`);
  if (p.videosOwedOverride != null && p.videosOwedOverride > 0) out.push(`videos owed set to ${p.videosOwedOverride}${when}${who}`);
  if (p.tierOverride) out.push(`tier set to ${p.tierOverride}${when}${who}`);
  return out;
}

// ---------------------------------------------------------------------------
// READ-ONLY QUERIES. Nothing below writes. The select lists are the exact
// columns the pure computation needs — no more, so a reconciliation pass over
// the whole table stays cheap.
// ---------------------------------------------------------------------------

const UNIT_PROJECT_SELECT = {
  id: true,
  title: true,
  addressLine: true,
  status: true,
  deliveredAt: true,
  shootDate: true,
  packageName: true,
  videosFilmed: true,
  videosOwedOverride: true,
  statusEvidence: true,
  statusCheckedAt: true,
  evidenceAttemptedAt: true,
  evidenceSucceededAt: true,
  evidenceError: true,
  aryeoListingId: true,
  contentMonthId: true,
  // EVERY deliverable, waived and removed rows included: this module classifies
  // them as WAIVED / REMOVED rather than filtering them out, so the report can
  // show an office decision as a decision instead of as an absence.
  deliverables: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      label: true,
      quantity: true,
      status: true,
      capturedAt: true,
      uploadedAt: true,
      waivedAt: true,
      removedFromOrderAt: true,
      removedFromOrderNote: true,
      videoStyle: true,
      productTitle: true,
      createdAt: true,
    },
  },
  reviewSubmissions: {
    orderBy: { round: "asc" },
    select: {
      id: true,
      deliverableId: true,
      slot: true,
      assetPath: true,
      status: true,
      round: true,
      decidedAt: true,
      completedAt: true,
      withdrawnAt: true,
    },
  },
} as const;

/** Units for a set of projects, in two queries' worth of rows. Read-only. */
export async function unitsForProjects(projectIds: string[]): Promise<Map<string, ProjectUnits>> {
  const out = new Map<string, ProjectUnits>();
  if (projectIds.length === 0) return out;
  const rows = await prisma.project.findMany({ where: { id: { in: projectIds } }, select: UNIT_PROJECT_SELECT });
  for (const r of rows) out.set(r.id, computeUnits(r as UnitProjectInput));
  return out;
}

/** Every non-cancelled project's units, paged so a full pass never loads the
 *  table at once. Read-only; the reconciliation report is its only caller. */
export async function eachProjectUnits(
  onBatch: (batch: ProjectUnits[]) => Promise<void> | void,
  opts: { includeCancelled?: boolean; pageSize?: number; since?: Date | null } = {},
): Promise<number> {
  const pageSize = opts.pageSize ?? 200;
  let cursor: string | undefined;
  let seen = 0;
  for (;;) {
    const rows = await prisma.project.findMany({
      where: {
        ...(opts.includeCancelled ? {} : { status: { not: "CANCELLED" } }),
        ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
      },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: UNIT_PROJECT_SELECT,
    });
    if (rows.length === 0) break;
    await onBatch(rows.map((r) => computeUnits(r as UnitProjectInput)));
    seen += rows.length;
    cursor = rows[rows.length - 1].id;
    if (rows.length < pageSize) break;
  }
  return seen;
}
