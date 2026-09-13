import "server-only";
import { prisma } from "@/lib/prisma";
import { NOTHING_TO_REMOVE_SENTINEL, DEBRIEF_QC_LABELS, QC_LABEL_SHOT_ORDER, QC_LABEL_REMOVALS, QC_LABEL_VIDEO_BRIEF, QC_LABEL_PAGE_SUBMITTED } from "@/lib/debrief";
import crypto from "crypto";
import { parseEvidence } from "@/lib/statusEvidence";
import { type ChecklistItem, parseChecklist, serializeChecklist, checklistComplete } from "@/lib/checklist";
import { etAt, etDayKey, etDayStartUtc, etDateTime } from "@/lib/datetime";
import { slugForName } from "@/lib/assignees";
import { BRACKET_RATIO, photoTargetFor } from "@/lib/culling";
import { isMonthlyContentJob } from "@/lib/pipeline";
import type { TurnaroundRules } from "@/lib/settings";
import { clip } from "@/lib/text";
import { pinnedEditorFor } from "@/lib/editors";

// ---------------------------------------------------------------------------
// Phase 1 of the listener-first platform: turnaround rules + due-date/priority
// engine + package-driven task generation from real Aryeo projects.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Turnaround targets in hours by deliverable type (admin-editable later).
const TURNAROUND_HOURS: Record<string, number> = {
  PHOTOS: 20, // next morning
  DRONE: 20,
  FLOORPLAN: 36,
  MATTERPORT_3D: 36,
  ZILLOW_3D: 36,
  TWILIGHT: 20,
  VIRTUAL_STAGING: 48,
  SOCIAL_REEL: 48,
  VIDEO: 48,
  HEADSHOT: 24,
  OTHER: 48,
};

// Reel/video turnaround tiers (a reel is just a vertical social video):
//   • Standard reel/video  → 1-2 days (48h)
//   • Premium reel/video   → 3 days (72h)   [label starts with "Premium"]
//   • Monthly content      → 7-10 BUSINESS days  [recurring social-plan client]
// PRECEDENCE: premium wins over monthly. A premium LISTING reel (e.g. a premium
// reel ordered with a property shoot) is a one-off premium deliverable, NOT
// recurring monthly content — so it keeps the 3-day premium SLA even when the
// client is on a social plan. Only NON-premium reels for a social client use the
// monthly window. Premium-ness rides on the deliverable LABEL ("Premium Reel"/
// "Premium Video"), set from the product map.
const REEL_VIDEO_TYPES = new Set(["SOCIAL_REEL", "VIDEO"]);
const PREMIUM_HOURS = 72;
const STANDARD_REEL_HOURS = 48;

// Add N business days (skip Sat/Sun) to a date.
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

// Walk BACK N business days (skip Sat/Sun) — the mirror of addBusinessDays.
// Used to hold the confirmation-text mint until the shoot is close: a task
// minted at booking for a shoot 62 days out (47 Venuti Dr, Aug 4 → Oct 6) sits
// in the open count for two months doing nothing (Sep 8 audit).
export function businessDaysBefore(from: Date, days: number): Date {
  const d = new Date(from);
  let removed = 0;
  while (removed < days) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) removed++;
  }
  return d;
}

// Confirmation texts are minted this many business days before the shoot —
// always ahead of the auto-send sweep's 48h lead (3 business days ≥ 72h, and
// the Friday "last chance" send for a Monday shoot happens ≥ 1 business day
// after the Wednesday mint), so the row the sweep claims is always there.
export const CONFIRMATION_MINT_BUSINESS_DAYS = 3;

type DueOpts = { monthlyContent?: boolean; premium?: boolean; sameDay?: boolean };

// ---- Same-day rush add-ons (Jordan, Sep 2 2026: "notify the morning tower
// about shoots with same-day delivery photos or floor plans") -----------------
// Two ADDON catalog products sell the client the day back: "Same Day Photo
// Delivery" and "Same Day 2D Floor-Plan Delivery". They are the ONE case where
// a category is promised the SAME day as the shoot — by end of business — not
// next morning. Until now nothing read them: the rushed media rode the
// standard clock, so a $100 rush read "due tomorrow" on the QC card and the
// tower never said a word.
//
// HOW AN ORDER IS KNOWN TO CARRY ONE — three sources, unioned, in order of
// trust. None of them alone is enough:
//   1. Deliverable.productTitle — the Aryeo order-item name the row came from,
//      verbatim (shared contract, Sep 2 2026).
//   2. Deliverable.label — rows written before productTitle existed kept the
//      product name as their label while the product was unmapped (1526 James
//      Rd, Jul 24: both add-ons verbatim). A MAPPED row reads "Photos" and
//      can't say — this is the fallback for rows not yet backfilled.
//   3. OrderItem.title — the stored line items (commercial truth; every job
//      since the Jul 28 backfill). NOT a mere fallback: the order reconcile
//      keeps ONE deliverable row per type, so the photo add-on (mapped
//      ["PHOTOS"]) folds into the main Photos row and its name is gone from
//      the deliverable side entirely. Only the line item still says it.
// "Same Day Reschedule Fee" is a real product too — the words "same day" are
// NOT the signal on their own; the media word after them is.
export const SAME_DAY_PHOTOS_RE = /\bsame[-\s]?day\b[^,;|]*\bphoto/i;
export const SAME_DAY_FLOORPLAN_RE = /\bsame[-\s]?day\b[^,;|]*\bfloor[-\s]?plan/i;

export type SameDayAddOns = { photos: boolean; floorPlan: boolean };
type RushRow = { label?: string | null; productTitle?: string | null };
type RushLine = { title: string; isCanceled?: boolean };

/** Which rush add-ons this order carries (see the three sources above). */
export function sameDayAddOns(deliverables: RushRow[], orderItems?: RushLine[] | null): SameDayAddOns {
  const names: string[] = [];
  for (const d of deliverables) {
    if (d.productTitle) names.push(d.productTitle);
    if (d.label) names.push(d.label);
  }
  for (const it of orderItems ?? []) if (!it.isCanceled) names.push(it.title);
  return {
    photos: names.some((n) => SAME_DAY_PHOTOS_RE.test(n)),
    floorPlan: names.some((n) => SAME_DAY_FLOORPLAN_RE.test(n)),
  };
}
export const hasSameDayAddOn = (a: SameDayAddOns) => a.photos || a.floorPlan;

// What each add-on pulls to the shoot day. Photos = the gallery, and drone
// stills ship IN the gallery (dedupeTypes folds DRONE into PHOTOS for QC).
// Twilight / staging / headshots stay on their own clocks — a twilight is shot
// at dusk and staging is a 48h edit; neither is what "same day photos" buys.
// Floor plan = the measured CubiCasa plan ONLY. A Zillow Showcase 3D tour is
// not a floor plan (Jordan, Sep 2), so ZILLOW_3D / MATTERPORT_3D never move.
const SAME_DAY_PHOTO_TYPES = ["PHOTOS", "DRONE"];
/** The deliverable TYPES this order owes by end of the shoot day. */
export function sameDayTypes(deliverables: RushRow[], orderItems?: RushLine[] | null): Set<string> {
  const rush = sameDayAddOns(deliverables, orderItems);
  const out = new Set<string>();
  if (rush.photos) for (const t of SAME_DAY_PHOTO_TYPES) out.add(t);
  if (rush.floorPlan) out.add("FLOORPLAN");
  return out;
}

// "By end of business" = 5 PM ET on the shoot's ET day — the same hour
// etEndOfDay / turnaround.ts dueAtFor already treat as the close of a promise
// day. Floored at shoot + 3h so a late-afternoon shoot isn't "overdue" before
// the photographer could physically have shot, uploaded and edited it — the
// promise is the day, not a minute that precedes the work.
export const SAME_DAY_EOB_HOUR = 17;
const SAME_DAY_MIN_HOURS = 3;
export function sameDayDue(shootDate: Date): Date {
  const eob = etAt(etDayKey(shootDate), SAME_DAY_EOB_HOUR);
  const floor = shootDate.getTime() + SAME_DAY_MIN_HOURS * HOUR;
  return eob.getTime() < floor ? new Date(floor) : eob;
}

// Turnaround due for one deliverable from an anchor date.
// The promise table is EDITABLE (Settings → Turnaround promises). Callers that
// already have the rules pass them in; everything else keeps the built-in
// defaults, so this stays a pure sync function used across client + server.
export function deliveryDueFrom(
  anchor: Date,
  deliverableType?: string | null,
  opts: DueOpts & { rules?: TurnaroundRules } = {},
): Date {
  const r = opts.rules;
  // A same-day rush outranks every table below, INCLUDING the editable
  // promises: the client bought a specific day, not a shorter hour count.
  if (opts.sameDay) return sameDayDue(anchor);
  if (deliverableType && REEL_VIDEO_TYPES.has(deliverableType)) {
    if (opts.premium) return new Date(anchor.getTime() + (r?.premiumVideoHours ?? PREMIUM_HOURS) * HOUR);
    if (opts.monthlyContent) return addBusinessDays(anchor, r?.monthlyBusinessDays ?? 10);
    return new Date(anchor.getTime() + (r?.standardVideoHours ?? STANDARD_REEL_HOURS) * HOUR);
  }
  const table: Record<string, number> = r
    ? {
        PHOTOS: r.photos, DRONE: r.drone, TWILIGHT: r.twilight,
        FLOORPLAN: r.floorPlan, MATTERPORT_3D: r.tour3d, ZILLOW_3D: r.tour3d,
        HEADSHOT: r.headshot, VIRTUAL_STAGING: r.virtualStaging,
        SOCIAL_REEL: r.standardVideoHours, VIDEO: r.standardVideoHours, OTHER: r.otherHours,
      }
    : TURNAROUND_HOURS;
  const h = (deliverableType && table[deliverableType]) || (r?.otherHours ?? 48);
  return new Date(anchor.getTime() + h * HOUR);
}

// MUST match projectStatus.ts PREMIUM_VIDEO_RE — the status card's videoDue and
// the delivery SLA written here have to agree (they previously diverged: this was
// /premium/ only, so an Influencer/Cinematic reel got a 48h SLA here but showed
// 72h on the status card — a 24h disagreement).
const isPremiumLabel = (label?: string | null) =>
  !!label &&
  /premium|influencer|cinematic|luxury|signature|elite|flagship/i.test(label) &&
  // "Standard Cinematic Video" is standard — explicit "standard" vetoes
  // (aligned with projectStatus.ts + aryeo.ts isPremiumProduct).
  !/\bstandard\b/i.test(label);

// A project's overall delivery due = shoot date + the LONGEST turnaround among
// its ordered deliverables (premium reel/video pushes it out, monthly further).
export function standardDeliveryDue(
  shootDate: Date,
  deliverables: { type: string; label?: string | null; productTitle?: string | null }[],
  monthlyContent = false,
  /** the stored Aryeo line items — the only place a same-day PHOTO rush still
   *  shows once its row has folded into the main Photos row (see sameDayAddOns) */
  orderItems?: { title: string; isCanceled?: boolean }[] | null,
): Date {
  if (deliverables.length === 0) return new Date(shootDate.getTime() + 48 * HOUR);
  const rush = sameDayTypes(deliverables, orderItems);
  return deliverables
    .map((d) => deliveryDueFrom(shootDate, d.type, { monthlyContent, premium: isPremiumLabel(d.label), sameDay: rush.has(d.type) }))
    .reduce((a, b) => (a > b ? a : b));
}

export type Priority = "URGENT" | "HIGH" | "MEDIUM" | "LOW";

// Derive priority from due date + shoot proximity + status.
export function computePriority(opts: {
  dueAt?: Date | null;
  shootDate?: Date | null;
  status?: string;
  now?: Date;
}): Priority {
  const now = opts.now ?? new Date();
  const startToday = new Date(now.toDateString()).getTime();
  if (opts.dueAt) {
    const diff = opts.dueAt.getTime() - now.getTime();
    if (diff < 0) return "URGENT"; // overdue
    if (diff < 4 * HOUR) return "URGENT";
    if (diff < DAY) return "HIGH";
  }
  if (opts.shootDate) {
    const days = Math.floor((opts.shootDate.getTime() - startToday) / DAY);
    if (days >= 0 && days <= 1) return "URGENT"; // shoot today/tomorrow
    if (days > 1 && days <= 3) return "HIGH"; // within 72h
  }
  return "MEDIUM";
}

function dedupe(parts: (string | null | undefined)[]): string {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

// The real sender to store on a task, but ONLY when it's a different person than
// the account client it folds to (e.g. assistant "Olivia" on agent "Mike"'s
// account). Returns null when they're the same, so the card doesn't show a
// redundant name.
function differentName(contactName: string | null | undefined, clientName: string | null | undefined): string | null {
  const c = (contactName ?? "").trim();
  if (!c) return null;
  if (c.toLowerCase() === (clientName ?? "").trim().toLowerCase()) return null;
  return c.slice(0, 120);
}

type TaskSpec = {
  taskType: string;
  title: string;
  reasonCreated: string;
  checklist: ChecklistItem[];
  deliverableType?: string;
  dueAt?: Date | null;
  description?: string; // pre-drafted message (e.g. the confirmation text)
  summary?: string; // "what happened / what's needed" for the card
  assignedKey?: string; // editor this is delegated to (see src/lib/editors.ts)
  // The spec is EXPECTED (an existing row is kept, refreshed, reopened) from
  // the moment it is emitted, but a NEW row is not created before this
  // instant. Lets a confirmation be "expected" for the whole booking without
  // being minted two months early — and keeps every row minted under the old
  // rule alive instead of cancelling it as "no longer expected".
  mintNotBefore?: Date | null;
};

// A row this reconciler parked (CANCELLED with one of these stamps in
// sourceDetail) is NOT terminal the way a human cancel or the Aryeo-orphan
// stand-down is: the spec re-emitting is what brings it back. Two reasons a
// card is parked:
/** The project went ON_HOLD (Sep 8 audit: a "QC & deliver" card on a held job
 *  sat open 41 days, invisible on every screen but counted in "84 open"). */
export const JOB_ON_HOLD = "job-on-hold";
/** The job reads SHOT/EDITING/REVIEW while its shoot is still ahead — a
 *  same-address re-shoot whose Dropbox folder already holds the FIRST shoot's
 *  raws (1946 Rowan St #2, Sep 8: "2 ready now" for photos that don't exist). */
export const SHOOT_NOT_YET = "shoot-not-yet";
const REOPENABLE_CANCELS = new Set([JOB_ON_HOLD, SHOOT_NOT_YET]);

// ---- Diff-before-write --------------------------------------------------
// Every open QC and edit card used to be rewritten every hour whether or not
// anything changed (Sep 8 audit: 10 of 11 open media_qa and 3 of 4 edit_video
// rows all stamped 16:01:40). That makes updatedAt meaningless on exactly the
// rows where it is later read as "when it closed" (the CANCELLED paths) and as
// a throttle (portal/actions.ts). So a refresh writes only when a field moves.
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return (a ?? null) === (b ?? null);
}
/** Keys of `patch` whose value differs from what the row already holds. */
export function changedKeys(row: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => !sameValue(row[k], patch[k]));
}

// "The shoot is still ahead of us." Mirrors projectStatus.ts shootHappened:
// shootDate alone is movable (a return visit points it at the FUTURE leg), so
// any non-canceled appointment leg that already started also counts as proof
// the shoot happened. With only the future leg on the books (Rowan #2) the
// shoot is pending; with a past leg + a future one (1224 Gail Rd, Aug 7 + Aug
// 24) it is not — that job's QC card was real work, completed six days
// before its second visit.
export function shootStillAhead(
  shootDate: Date | null | undefined,
  appointments?: { startAt: Date | null; status: string | null }[] | null,
  now = Date.now(),
): boolean {
  if (!shootDate || shootDate.getTime() <= now) return false;
  const pastLeg = (appointments ?? []).some(
    (a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt !== null && a.startAt.getTime() < now,
  );
  return !pastLeg;
}

// Aryeo titles a coordinate-only order "[No address provided], 40.62…,-75.37…"
// (aryeo.ts addressTitle → unparsed_address, verbatim). A task titled with a
// lat/lng is one nobody can read at a glance; the street line or the town is
// what a person would say. The project title itself is left alone — Dropbox
// folders are named from it.
export function jobLabelFor(p: { title: string; addressLine?: string | null; city?: string | null }): string {
  if (!/^\[?\s*no address/i.test(p.title)) return p.title;
  const line = p.addressLine?.trim();
  if (line) return line;
  return p.city ? `Pin drop near ${p.city}` : "Pin drop (no address on the order)";
}

// The placeholder client an Aryeo order with no customer is filed under
// (aryeo.ts UNKNOWN_CUSTOMER_NAME). Matched by prefix rather than imported:
// the integration module is heavy and imports this one dynamically.
const isUnknownCustomer = (name: string | null | undefined) => /^unknown customer\b/i.test(name ?? "");

// Friendly per-deliverable label for the consolidated QC checklist.
const QC_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Drone / aerial", TWILIGHT: "Twilight", HEADSHOT: "Headshots",
  VIRTUAL_STAGING: "Virtual staging", VIDEO: "Video", SOCIAL_REEL: "Reel",
  FLOORPLAN: "Floor plan", MATTERPORT_3D: "Matterport 3D", ZILLOW_3D: "Zillow 3D tour", OTHER: "Other",
};
const guide = (steps: string[]): ChecklistItem[] => steps.map((label) => ({ label, done: false }));

// Guided QC failure modes — the SPECIFIC things Kyle must actually eyeball before
// a category ships. These exist because QC was blind: his written guidance was one
// static sentence and the checklist had nothing to tick, so revisions ran ~13.7%
// and the sampled bounce-back reasons were EXACTLY the misses below (crooked
// verticals/perspective, item-removal left undone, reflections, sign/clutter). The
// vocabulary is keyed to IMAGE_FLAG_TAGS so a later auto-QA model trains on the
// same labels. Keyed by media CATEGORY (Photos / Video / Floor plan) — one block
// per category, appended to the checklist ONLY once that category is live on Aryeo
// (so we never ask Kyle to verify photos that haven't landed yet, and nothing gates
// prematurely). Labels are STABLE strings: the reconciler merge keys on label to
// preserve Kyle's manual ticks across syncs, so these must never change wording
// once shipped or a re-sync would drop the tick and silently re-open the gate.
const QC_FAILURE_MODES: Record<string, string[]> = {
  // Photos (covers PHOTOS / DRONE / TWILIGHT / HEADSHOT / VIRTUAL_STAGING — all
  // fold to the "Photos" category in TYPE_CATEGORY_LABEL and QC together).
  Photos: [
    "Verticals & horizontals straight (perspective)",
    "Blemishes / AI errors removed",
    "Colors & lighting consistent",
    "Clutter + our yard sign removed",
    "People / camera in mirrors & reflections gone",
    "Virtual staging / item removal done (if ordered)",
  ],
  // Video covers VIDEO + SOCIAL_REEL (both "Video" category).
  Video: [
    "Text on screen spelled right",
    "Music + branding correct",
  ],
  "Floor plan": [
    "Square footage matches the listing",
  ],
};

// The two extra passes we ask for on VIP / heavy clients — 38% of deliveries are
// VIP-segment (66% VIP+heavy) yet QC was client-blind. These are the two misses
// that most often bounce a high-value client. Prefixed "VIP —" so the card can
// render them as a distinct extra-pass section; they're real Kyle-ticks and gate
// auto-close like any other failure-mode item.
const VIP_EXTRA_PASS = [
  "VIP — Mirrors/reflections re-checked frame by frame",
  "VIP — Clutter sweep on every room",
] as const;
export const VIP_SEGMENTS = new Set(["vip", "heavy"]);

// ---------------------------------------------------------------------------
// REVISIONS PROMISE NOTHING (Jordan, Sep 8: "Revisions dont promise anything").
// A client's revision used to mint URGENT with dueAt = the raise moment, so
// every revision card read "Overdue · <the minute it arrived>" from second
// zero — 14 of 32 in 60 days were born overdue and the red label carried no
// information (Sep 8 audit, due-fuses). There is no revision turnaround in
// Settings, the playbook or the guide to point a date at, so the card carries
// NO due date and reads its age from createdAt ("requested 3 days ago").
// Priority is HIGH; URGENT only when the client is a VIP/heavy account or the
// ask itself says they are unhappy. Shared by every revision-type minter
// (comms.raiseRevision, the re-QC card, the Editing Room's new-cut rail).
// ---------------------------------------------------------------------------
// "again" only counts when it carries a complaint ("wrong again", "once again",
// "again … not") — a bare `again` made "thanks again for the great video!"
// URGENT (Sep 8 review).
const UNHAPPY_ASK = /\b(?:unacceptable|disappointed|unhappy|frustrated|terrible|not happy|third time|(?:yet|still|once) again|again\b[^.!?]*\b(?:wrong|not|still)|(?:wrong|still)\b[^.!?]*\bagain)\b/i;
export function revisionPriority(opts: { segment?: string | null; ask?: string | null }): "URGENT" | "HIGH" {
  const vip = !!opts.segment && VIP_SEGMENTS.has(opts.segment);
  const unhappy = !!opts.ask && UNHAPPY_ASK.test(opts.ask);
  return vip || unhappy ? "URGENT" : "HIGH";
}

// ---------------------------------------------------------------------------
// QC TICKS ARE OPTIONAL (Jordan, Sep 8: "Ticking QC should be optional").
// The card's own promise — "auto-completes once everything is live" — was
// false: checklistComplete needed every guided failure-mode tick too, 2.2% of
// those were ever ticked, and 83% of QC cards died in the DELIVERED sweep
// instead (Sep 8 audit, U1). The gate is now the EVIDENCE rows only — every
// ordered category live ("QC <category>") and the gallery out ("Deliver the
// gallery" / "Produce + deliver") — plus the two debrief rows that clear
// themselves from real state: "Photographer submitted the upload page"
// (Jordan's law — the job isn't done until it is; the submit flips it) and
// the shot-order line (always emitted done). The other debrief rows (verify
// the flagged removals, check the video against the brief) and the "Re-QC
// after revision" row are human ticks that never self-clear — keeping them in
// the gate held 632 Greenridge, 102 Knoxlyn Farm, 68 New St and 2051 Old
// Sumneytown open on exactly those rows (Sep 8 review), which is the same
// broken promise in a smaller box. They stay on the card as reminders, like
// the failure-mode and VIP extra-pass ticks; none of them hold it open.
// ---------------------------------------------------------------------------
const QC_DELIVER_ROW = /^(Deliver the gallery|Produce \+ deliver)/;
export function isQcGateRow(label: string): boolean {
  return /^QC\s/.test(label) || QC_DELIVER_ROW.test(label) || label === QC_LABEL_PAGE_SUBMITTED || label === QC_LABEL_SHOT_ORDER;
}
export function qcGateComplete(items: ChecklistItem[]): boolean {
  const gate = items.filter((i) => isQcGateRow(i.label));
  // A card with no evidence rows at all (shouldn't exist) falls back to the
  // strict rule rather than closing on nothing.
  if (gate.length === 0) return checklistComplete(items);
  return gate.every((i) => i.done);
}

// Media category label for a deliverable type — mirrors CATEGORY_LABEL in
// projectStatus.ts (kept here to avoid a circular import). Lets us tell, from a
// project's status evidence (which lists present/missing by category label),
// whether a given ordered deliverable is already live on Aryeo.
const TYPE_CATEGORY_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Photos", TWILIGHT: "Photos", HEADSHOT: "Photos", VIRTUAL_STAGING: "Photos",
  VIDEO: "Video", SOCIAL_REEL: "Video",
  FLOORPLAN: "Floor plan",
  MATTERPORT_3D: "3D tour", ZILLOW_3D: "3D tour",
};

// ---------------------------------------------------------------------------
// When does a QC card actually become WORK? Two different dates, and conflating
// them hid yesterday's shoots from the morning QC block (Jordan, Sep 1):
//
//  · the JOB's promise  = the LATEST pending deliverable (the media_qa dueAt).
//    This is what "overdue" means — we blew the whole promise.
//  · the WORK's arrival = the moment a category goes live on Aryeo, because the
//    guided failure-mode checks for a category are only emitted once it lands.
//
// 208 N Adams (shot yesterday) had photos + floor plan live with six unticked
// photo checks sitting there — real morning QC work — but its card was dated by
// the VIDEO's 48h SLA, so it read "not due yet" and never surfaced.
// ---------------------------------------------------------------------------

/** Checklist rows that are Kyle's work RIGHT NOW: unticked, and the media they
 *  check is already live. Auto-evidence rows ("QC Video") are the pipeline
 *  waiting on media, not work — and the video-brief row can't be done until
 *  there is a video to watch. */
export function actionableQcCount(
  items: { label: string; done?: boolean }[],
  presentCategories: string[],
): number {
  const hasVideo = presentCategories.includes("Video");
  const nothingLive = presentCategories.length === 0;
  return items.filter((i) => {
    if (i.done) return false;
    if (/^QC /.test(i.label)) return false; // auto-ticks when the category lands
    // "Photographer submitted the upload page" and "Deliver the gallery" cannot
    // be done before anything is live — a card for a shoot that has not happened
    // read "2 ready now" (1946 Rowan #2, 632 Greenridge; audit, Sep 8).
    if (nothingLive && /upload page|deliver the gallery/i.test(i.label)) return false;
    if (i.label === QC_LABEL_VIDEO_BRIEF && !hasVideo) return false;
    return true;
  }).length;
}

/** The SOONEST still-undelivered deliverable and when it is promised — what the
 *  job owes next, as distinct from when the whole job is late. */
export function nextPendingDue(p: {
  shootDate: Date | null;
  deliverables: { type: string; label?: string | null; productTitle?: string | null }[];
  /** stored Aryeo line items — same-day rush detection (see sameDayAddOns) */
  orderItems?: { title: string; isCanceled?: boolean }[] | null;
  statusEvidence?: string | null;
  monthlyContent?: boolean;
  turnarounds?: TurnaroundRules;
}): { at: Date; categories: string[] } | null {
  const anchor = p.shootDate ?? new Date();
  const present = new Set(parseEvidence(p.statusEvidence)?.present ?? []);
  const premiumTypes = new Set(p.deliverables.filter((d) => isPremiumLabel(d.label)).map((d) => d.type));
  // Rushed types are keyed on the raw type; dedupeTypes folds DRONE into
  // PHOTOS, and PHOTOS is in the rushed set whenever DRONE is.
  const rushTypes = sameDayTypes(p.deliverables, p.orderItems);
  const pending = dedupeTypes(p.deliverables).filter((t) => {
    const lbl = TYPE_CATEGORY_LABEL[t];
    return !lbl || !present.has(lbl);
  });
  if (pending.length === 0) return null;
  const dues = pending.map((t) => ({
    category: TYPE_CATEGORY_LABEL[t] ?? labelFor(t),
    at: deliveryDueFrom(anchor, t, {
      monthlyContent: !!p.monthlyContent,
      premium: premiumTypes.has(t),
      sameDay: rushTypes.has(t),
      rules: p.turnarounds,
    }).getTime(),
  }));
  const soonest = Math.min(...dues.map((d) => d.at));
  return {
    at: new Date(soonest),
    categories: [...new Set(dues.filter((d) => d.at === soonest).map((d) => d.category))],
  };
}

// Decide the expected tasks for one project, based on its pipeline stage.
// Pure (no I/O) and exported so a read-only probe can dry-run the gates on a
// live row without the reconciler writing anything.
export function specsForProject(p: {
  status: string;
  title: string;
  shootDate: Date | null;
  deliverables: { type: string; label?: string | null; productTitle?: string | null }[];
  /** stored Aryeo line items — same-day rush detection (see sameDayAddOns) */
  orderItems?: { title: string; isCanceled?: boolean }[] | null;
  statusEvidence?: string | null;
  monthlyContent?: boolean;
  // Culling budget inputs — size the "gallery is over target, cull it" nudge on
  // the QC checklist (Kyle's manual read, doesn't gate auto-close).
  squareFeet?: number | null;
  photoTarget?: number | null;
  // Client segment (vip | heavy | …) — drives the VIP extra-pass ticks on the QC
  // checklist. QC used to be client-blind despite 38% of deliveries being VIP.
  clientSegment?: string | null;
  // Shoot-debrief answers, dispatched onto the QC card (Jordan, Sep 1).
  removalNotes?: string | null;
  shotOrderNotes?: string | null;
  debriefSubmittedAt?: Date | null;
  videoInstructions?: string | null;
  /** editable promise table (Settings → Turnaround promises) */
  turnarounds?: TurnaroundRules;
  /** Aryeo appointment legs — shootStillAhead needs a past leg to tell a
   *  return visit from a not-yet-shot job. */
  appointments?: { startAt: Date | null; status: string | null }[] | null;
  /** the account client's name — the no-customer placeholder gets no confirmation */
  clientName?: string | null;
  /** title fallbacks for coordinate-only orders (see jobLabelFor) */
  addressLine?: string | null;
  city?: string | null;
}): TaskSpec[] {
  const specs: TaskSpec[] = [];
  const shoot = p.shootDate;
  const now = Date.now();
  const label = jobLabelFor(p);
  const shootAhead = shootStillAhead(shoot, p.appointments, now);
  const primary = p.deliverables[0]?.type ?? "PHOTOS";
  const monthly = !!p.monthlyContent;
  // Which deliverable types are premium (3-4 day reel/video) on this project.
  const premiumTypes = new Set(p.deliverables.filter((d) => isPremiumLabel(d.label)).map((d) => d.type));
  // Same-day rush add-ons pull PHOTOS(+DRONE) / FLOORPLAN to end of the shoot
  // day; qcTypes are already DRONE→PHOTOS-folded, and PHOTOS is in the set.
  const rushTypes = sameDayTypes(p.deliverables, p.orderItems);
  const dueOpts = (type: string) => ({ monthlyContent: monthly, premium: premiumTypes.has(type), sameDay: rushTypes.has(type), rules: p.turnarounds });

  // What's already live on Aryeo (from the status cross-check). Used to retire
  // QA / "deliver gallery" work for a category the moment it's delivered — even
  // while the rest of the order (e.g. a reel) is still in production. Staged
  // delivery: photos go out next-day, the reel days later.
  const ev = parseEvidence(p.statusEvidence);
  const presentLabels = new Set(ev?.present ?? []);
  const isDelivered = (type: string) => {
    const lbl = TYPE_CATEGORY_LABEL[type];
    return !!lbl && presentLabels.has(lbl);
  };
  const galleryDelivered = presentLabels.has("Photos");

  // NOTE: there's no separate "finish delivery" leak task. Each still-pending
  // deliverable already gets its own per-item QA task below (due at that item's
  // turnaround, auto-closing when it goes live), and the project page's Status
  // card surfaces any partial / missing items — so a standalone catch-all task
  // was just duplicate, often-stale noise (e.g. "missing Video" on a reel that
  // was actually on track). Removed in favor of the per-deliverable tasks.

  // Only while the shoot is still ahead of us. Once the shoot day arrives the
  // confirmation is moot — dropping the spec lets the reconciler auto-close any
  // open confirmation_text below, so it never lingers or reads "overdue" forever.
  //
  // Gated on the SHOOT DATE, not the status (Sep 8 audit, 1946 Rowan St #2):
  // a same-address re-shoot read SHOT a minute after import because the
  // Dropbox folder still held the first shoot's raws, and "BOOKED/SCHEDULED
  // only" meant tomorrow's 9 AM shoot got no confirmation text at all. The
  // same hole swallowed every return visit on a job past SCHEDULED (1224 Gail
  // Rd, 3206 W Dauphin: zero outbound texts in the 72h before the second leg).
  // A job still BOOKED/SCHEDULED with no date yet keeps its dateless row (the
  // date has to be chased — clientTexts.ts); past SCHEDULED a real upcoming
  // date is required, otherwise a shot job that lost its slot would grow one.
  // The shoot INSTANT, not the ET-day start: a job that shot this morning and
  // reads SHOT kept emitting a confirmation spec all day, so its unsent row
  // lingered overdue instead of retiring at the shoot (review, Sep 8).
  const shootDayNotReached = !!shoot && shoot.getTime() > Date.now();
  const preShootStage = p.status === "BOOKED" || p.status === "SCHEDULED";
  const confirmationWanted = preShootStage ? !shoot || shootDayNotReached : shootDayNotReached;
  // An order with no customer has nobody to text (the drafted text greeted
  // "Unknown"; the sweep skipped it for lack of a phone; it sat until the
  // shoot day cancelled it). When the customer lands the spec re-emits and
  // the reopen path below puts the row back.
  if (confirmationWanted && !isUnknownCustomer(p.clientName)) {
    specs.push({
      taskType: "confirmation_text",
      title: `Confirmation text — ${label}`,
      reasonCreated: "Day-before confirmation text (SOP)",
      summary: "Day before the shoot: review the drafted confirmation text and send it. Confirm access (someone meeting us or a lockbox + code), what to highlight/avoid, and offer an upgrade if it fits.",
      // No deliverableType: a confirmation is one-per-shoot, so its dedupe key must
      // stay stable. Keying it on the primary deliverable meant a re-synced order
      // whose deliverables reordered could mint a SECOND confirmation task.
      deliverableType: undefined,
      dueAt: shoot ? new Date(shoot.getTime() - DAY) : null,
      // Minted close to the shoot, not at booking (see businessDaysBefore). A
      // dateless row is minted at once — the missing date is the work.
      mintNotBefore: shoot ? businessDaysBefore(shoot, CONFIRMATION_MINT_BUSINESS_DAYS) : null,
      // description (the drafted text) is filled in at creation time, where the
      // client name + shoot time + photographer are available.
      checklist: guide([
        "Review the drafted confirmation text below",
        "Send it to the client via OpenPhone",
        "Confirm access — someone meeting us, or a lockbox? Get the code",
        "Note what to highlight / avoid + that the property will be ready",
        "Offer an upgrade if it fits — twilight, drone, staging, 3D, floor plan",
      ]),
    });
  }

  // REVISION included: the reopened QC card must keep receiving evidence
  // merges (re-ticked auto rows when the corrected media lands) instead of
  // freezing until a human resolves the revision.
  //
  // Never while the shoot is still ahead (shootStillAhead): the status engine
  // reads a same-address re-shoot as SHOT off the previous shoot's raws, and
  // the QC card then sat in Kyle's 9:30 block as "shot Wed, Sep 9 · 2 ready
  // now" the day BEFORE the shoot (Sep 8 audit). The reconciler parks the
  // existing card (SHOOT_NOT_YET) and brings it back the hour the shoot has
  // happened. A return visit with a past leg is not "ahead" — its card stays.
  const productionStage = p.status === "SHOT" || p.status === "EDITING" || p.status === "REVIEW" || p.status === "REVISION";
  if (productionStage && !shootAhead) {
    const anchor = shoot ?? new Date();
    // ONE consolidated QC task per project: a checkbox per deliverable category,
    // pre-checked for anything already live on Aryeo. Replaces the old per-item
    // "QA <type>" tasks. Due at the SOONEST pending item's turnaround. Only the
    // pending (unchecked) items are work; if everything's live we skip it (and
    // the reconciler closes any existing one).
    const qcTypes = dedupeTypes(p.deliverables);
    // Build the checklist category-by-category: the auto-checked "QC <category>"
    // evidence row, then — ONLY once that category is live on Aryeo — the guided
    // failure-mode sub-items Kyle must actually verify. Appending sub-items only
    // when isDelivered(d) means a photos-not-yet-live job shows NO photo sub-items
    // yet, so nothing gates before the media exists; they appear the moment the
    // category lands and the reconciler's prevDone map preserves Kyle's ticks from
    // then on. Auto-check rows stay auto-checked; only the sub-items are his work.
    const isVip = !!p.clientSegment && VIP_SEGMENTS.has(p.clientSegment);
    const seenCategories = new Set<string>();
    const qcItems: ChecklistItem[] = [];
    for (const d of qcTypes) {
      const live = isDelivered(d);
      qcItems.push({ label: `QC ${QC_LABEL[d] ?? labelFor(d)}`, done: live });
      // Failure modes attach to the media CATEGORY, not the raw type, and only
      // once — a job with photos + drone (both "Photos") gets ONE photo block.
      const category = TYPE_CATEGORY_LABEL[d];
      if (live && category && !seenCategories.has(category)) {
        seenCategories.add(category);
        for (const label of QC_FAILURE_MODES[category] ?? []) qcItems.push({ label, done: false });
        // VIP extra pass rides on the Photos block (that's where reflections/
        // clutter misses live) — the two ticks that most often bounce a VIP.
        if (isVip && category === "Photos") for (const label of VIP_EXTRA_PASS) qcItems.push({ label, done: false });
      }
    }
    // ---- Shoot-debrief dispatch (Jordan, Sep 1; hardened per review): every
    // line uses a STABLE label (the reconciler merges ticks by label) with the
    // debrief STATE carried in `done`, and once a line has been emitted its
    // condition can only self-clear (done flips true in the spec), never drop
    // the label — a dropped done:false label would strand as a permanent
    // auto-close blocker via the extras rule. Dynamic text (the actual notes)
    // lives on the project page and Ops Day, never in a label.
    if (p.shotOrderNotes) {
      qcItems.push({ label: QC_LABEL_SHOT_ORDER, done: true });
    }
    if (p.removalNotes) {
      // Unchecked = real Kyle work; the photographer flipping to "nothing to
      // remove" on a re-submit self-clears it (spec re-emits done:true).
      qcItems.push({ label: QC_LABEL_REMOVALS, done: p.removalNotes === NOTHING_TO_REMOVE_SENTINEL });
    }
    if (p.videoInstructions && qcTypes.some((d) => TYPE_CATEGORY_LABEL[d] === "Video")) {
      qcItems.push({ label: QC_LABEL_VIDEO_BRIEF, done: false });
    }
    if (
      p.shootDate && p.shootDate.getTime() >= Date.parse("2026-09-02T00:00:00-04:00") &&
      // dedupeTypes folds DRONE into PHOTOS, so PHOTOS/TWILIGHT is the real set.
      qcTypes.some((d) => ["PHOTOS", "TWILIGHT"].includes(d))
    ) {
      // Positive framing so done:true = good; unchecked BLOCKS delivery until
      // the page is submitted (Jordan's law: the job isn't done until it is),
      // and the submit self-clears it on the next sweep.
      qcItems.push({ label: QC_LABEL_PAGE_SUBMITTED, done: !!p.debriefSubmittedAt });
    }

    // QC and "deliver the gallery" are ONE motion for Kyle — a separate
    // "Deliver gallery" task open NEXT TO the QC task doubled every job's cards
    // (Jordan: "too many redundant QC tasks"; 47 of 65 recent jobs carried 2-4
    // check-type tasks). The deliver step is the QC card's LAST checklist item,
    // auto-checked when the gallery goes out — so the card lives QC → deliver →
    // done, and one job = one card. (The old delivery-spec keys fall out of
    // expectedKeys, so the reconciler retires existing open ones.)
    qcItems.push({
      label: monthly
        ? "Produce + deliver this month's content (Aryeo + branded email)"
        : "Deliver the gallery (Aryeo + branded email)",
      done: galleryDelivered,
    });
    // Cull-at-delivery guardrail (Jul 2026 audit): delivered count == final-folder
    // count in EVERY observed job — nobody culls, so 76% of galleries ship over 50.
    // When the live photo count already exceeds this home's budget, add ONE
    // guidance line so Kyle culls near-duplicates before delivering. It's a READ,
    // not a gate: pushed pre-checked (done: true) so it NEVER blocks the media_qa
    // auto-close (checklistComplete needs every item done). Mirrors how the
    // isDelivered() items ride the same checklist without becoming Kyle's work.
    const galleryPhotoCount = Math.max(ev?.aryeo?.photos ?? 0, ev?.dropbox?.finalPhotos ?? 0);
    const budget = photoTargetFor({ squareFeet: p.squareFeet, photoTarget: p.photoTarget, shootDate: p.shootDate });
    if (galleryPhotoCount > budget) {
      qcItems.push({
        label: `Gallery is ${galleryPhotoCount} photos vs ~${budget} target — cull near-duplicates before delivering (keep the best of each room).`,
        done: true,
      });
    }
    const pendingDues = qcTypes.filter((d) => !isDelivered(d)).map((d) => deliveryDueFrom(anchor, d, dueOpts(d)).getTime());
    if (qcTypes.length > 0 && qcItems.some((i) => !i.done)) {
      specs.push({
        taskType: "media_qa",
        title: `QC & deliver — ${label}`,
        reasonCreated: "Media in production — QC each deliverable, then deliver",
        // Sep 8: the ticks are optional (qcGateComplete) — say so, so the card
        // never promises a close it can't deliver.
        summary: monthly
          ? "Monthly personal-branding / social content (7–10 business-day turnaround). QC each piece as it lands, then produce + deliver this month's content. The checks below are reminders, not gates — the card closes on its own once everything is live and delivered."
          : "Content is coming in for this shoot. Quality-check each deliverable as it lands on Aryeo (verticals + horizontals, no odd edits/reflections/blemishes, staging + item removal done), then deliver the gallery via Aryeo + the branded email. The checks below are reminders, not gates — the card closes on its own once every category is live and the gallery is out.",
        // The card is due when the JOB is due — the LATEST still-pending
        // deliverable — not the earliest. Using the min made every shoot read
        // "overdue" the morning after (photos are a 20h SLA) while the video
        // still had a day to run, so Kyle's QC list cried wolf on jobs that
        // were perfectly on time (Jordan, Sep 1: 208 N Adams, 2009 Garrison,
        // 263 Towamensing). Per-item SLAs still drive the per-item chases.
        dueAt: pendingDues.length ? new Date(Math.max(...pendingDues)) : deliveryDueFrom(anchor, primary, dueOpts(primary)),
        checklist: qcItems,
      });
    }
  }

  return specs;
}

function dedupeTypes(deliverables: { type: string }[]): string[] {
  // Drone aerial photos are part of the photo set — QA them together, so a job
  // with photos + drone gets ONE "QA photos" task, not separate drone/photo QAs.
  const norm = (t: string) => (t === "DRONE" ? "PHOTOS" : t);
  return [...new Set(deliverables.map((d) => norm(d.type)))].slice(0, 4);
}
function labelFor(t: string) {
  return t.replace(/_/g, " ").toLowerCase();
}

// Create a "client reply / callback" task from an inbound communication, matched
// to a client (+ their latest project). One open reply task per client is kept
// (deduped) so a burst of texts doesn't spawn duplicates.
export async function createCommTask(opts: {
  clientId: string;
  clientName: string;
  // The real person who wrote in, when different from the account client (e.g. an
  // assistant emailing on the agent's behalf). Shown as the person on the card.
  contactName?: string | null;
  projectId?: string | null;
  propertyAddress?: string | null;
  kind: "text" | "missed_call" | "voicemail";
  snippet?: string;
  source?: string;
  // AI-derived, specific action ("Reschedule 320 Tarbert to Thursday").
  aiTitle?: string | null;
  aiDetail?: string | null;
  // Smart-Brain priority (context-aware). Defaults to HIGH.
  priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  // Provenance ref (e.g. "gmail-thread:hello@…:<threadId>") so the listener can
  // auto-close the task once we've replied in that thread.
  threadRef?: string | null;
  // The brain's call (brain.brainTaskType): a real unanswered inbound is a
  // client_reply; bookkeeping it asked of US ("Note builder relationship
  // context…", "Prep for Thursday 3:30 call") is a todo — the Done tab was
  // labelling those "Client reply" (audit, Sep 8). Defaults to client_reply.
  taskType?: "client_reply" | "todo";
}): Promise<boolean> {
  const taskType = opts.taskType ?? "client_reply";
  // One open reply task per (client, order) — a multi-order client's questions
  // stay separate, and replying about one order won't close another's.
  // A todo gets its own key so a later real reply never appends onto an
  // internal note (and vice versa).
  const key = dedupe([opts.clientId, opts.projectId ?? "noproject", taskType === "todo" ? "brain_todo" : "client_reply"]);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") {
    // APPEND, don't drop (Aug 24 audit): a client sending three texts used to
    // leave the task showing only the FIRST — Kyle answered stale asks. One
    // task per conversation, every message on it, count in the summary.
    const line = (opts.snippet ? clip(opts.snippet, 400) : opts.aiDetail?.trim()) || "(another message)";
    const at = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date());
    const prev = existing.description ?? "";
    const appended = `${prev}\n\n— ${at}: ${line}`.trim();
    const count = (appended.match(/^— /gm)?.length ?? 0) + 1; // first message + appends
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        description: appended.length > 4000 ? appended.slice(appended.length - 4000) : appended,
        summary: `${opts.clientName}: ${count} messages waiting — latest: \u201C${clip(line, 200)}\u201D`.slice(0, 500),
        // A follow-up nudge means they're waiting — never LATER than the
        // current due, sometimes sooner.
        ...(existing.dueAt && existing.dueAt.getTime() > Date.now() + 2 * HOUR ? { dueAt: new Date(Date.now() + 2 * HOUR) } : {}),
      },
    }).catch(() => {});
    return false;
  }

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const verb = opts.kind === "text" ? "Reply to" : "Call back";
  const sourceName =
    opts.source === "gmail" ? "Gmail" : opts.source === "slack" ? "Slack" : "OpenPhone";
  const reason =
    opts.kind === "text"
      ? `Inbound message from client (${sourceName})`
      : opts.kind === "voicemail"
        ? "Voicemail from client (OpenPhone)"
        : "Missed call from client (OpenPhone)";
  // Replies due within a few hours; callbacks sooner.
  const dueAt = new Date(Date.now() + (opts.kind === "text" ? 4 : 1) * HOUR);

  // The client's name renders UNDER the title on every task card, so we keep it
  // out of the title itself (no redundant "(Client Name)" suffix). Fall back to a
  // clean generic when the brain didn't title it.
  const title = opts.aiTitle
    ? opts.aiTitle
    : opts.kind === "text"
      ? "Reply to the latest message"
      : opts.kind === "voicemail"
        ? "Return the voicemail"
        : "Return the missed call";
  // Keep the MESSAGE itself on the task (word-boundary clip, generous cap) —
  // "read the full context" shouldn't require leaving the card. aiDetail is NOT
  // prefixed here: it already IS the summary, and prefixing rendered the same
  // paragraph twice on the card and in the full view.
  const description = (opts.snippet ? clip(opts.snippet, 1200) : opts.aiDetail?.trim()) || null;
  // "What happened" summary for the card: the brain's read of the ask, else the
  // message itself.
  const summary =
    opts.aiDetail?.trim() ||
    (opts.snippet ? `${opts.clientName} ${opts.kind === "text" ? "wrote in" : "reached out"}: “${clip(opts.snippet, 240)}”` : `${verb} ${opts.clientName}.`);

  const data = {
    taskType,
    title: title.slice(0, 120),
    summary: summary.slice(0, 500),
    description,
    reasonCreated: reason,
    checklist: JSON.stringify([
      "Read the full conversation in Communications",
      "Match to the right order if multiple",
      "Reply / call back",
      "Log outcome",
    ]),
    source: opts.source ?? "openphone",
    sourceDetail: opts.threadRef ?? null,
    priority: opts.priority ?? "HIGH",
    dueAt,
    clientId: opts.clientId,
    contactName: differentName(opts.contactName, opts.clientName),
    projectId: opts.projectId ?? null,
    propertyAddress: opts.propertyAddress ?? null,
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };

  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }
  // URGENT means "someone should know NOW" — ping Slack instead of waiting for
  // the next hub visit. Best-effort: never breaks task creation.
  if (data.priority === "URGENT") {
    try {
      const { notifyUrgent } = await import("@/lib/notify");
      await notifyUrgent(`URGENT — ${data.title}${opts.clientName ? ` (${opts.clientName})` : ""}`);
    } catch { /* non-fatal */ }
  }
  return true;
}

// File an instruction/follow-up task on a SPECIFIC project from an inbound text
// that named that property — even when the sender isn't the project's client
// (a photographer like Harrison, or a coordinator like Ruthie). Deduped to one
// open task per (project, sender) so a back-and-forth refreshes instead of piling up.
export async function createProjectFollowupTask(opts: {
  projectId: string;
  clientId?: string | null;
  propertyAddress?: string | null;
  senderName: string;
  text: string;
  source?: string;
  aiTitle?: string | null;
  aiDetail?: string | null;
  priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
}): Promise<boolean> {
  // Stable per (project, sender) — normalize the sender so name variants
  // ("Harrison" vs "Harrison Wells") don't spawn duplicate tasks.
  const senderKey = opts.senderName.toLowerCase().replace(/[^a-z]/g, "").slice(0, 16) || opts.senderName;
  const key = dedupe([opts.projectId, "comms_followup", senderKey]);
  // Always anchor the task to a client: derive it from the order when not given.
  let clientId = opts.clientId ?? null;
  if (!clientId) {
    const p = await prisma.project.findUnique({ where: { id: opts.projectId }, select: { clientId: true } });
    clientId = p?.clientId ?? null;
  }
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const street = (opts.propertyAddress ?? "this job").split(",")[0];
  const title = (opts.aiTitle || `${opts.senderName} re ${street}`).slice(0, 120);
  // Message only — aiDetail already lives in the summary (no double render).
  const description = clip(opts.text, 1200) || null;
  const summary =
    opts.aiDetail?.trim() || `${opts.senderName} messaged about ${street}: “${clip(opts.text, 240)}”`;
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  const data = {
    taskType: "comms_followup",
    title,
    summary: summary.slice(0, 500),
    description,
    reasonCreated: `${opts.senderName} texted about this job (${opts.source ?? "openphone"})`,
    checklist: JSON.stringify([
      "Read the full message in Communications",
      "Action the request on this job",
      "Reply / confirm with the sender",
      "Log the outcome",
    ]),
    source: opts.source ?? "openphone",
    priority: opts.priority ?? "HIGH",
    dueAt: new Date(Date.now() + 4 * HOUR),
    clientId,
    projectId: opts.projectId,
    propertyAddress: opts.propertyAddress ?? null,
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };
  if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") {
    // APPEND, don't overwrite (audit Aug 25): the same fix client_reply got on
    // Aug 24 — a second text from the same sender used to REPLACE the task's
    // description, silently erasing the first instruction (Harrison texts a
    // lockbox code, then a detail; only the detail survived).
    const at = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date());
    const line = clip(opts.text, 400) || "(another message)";
    const prev = existing.description ?? "";
    const appended = `${prev}\n\n— ${at}: ${line}`.trim();
    const count = (appended.match(/^— /gm)?.length ?? 0) + 1;
    // One-way priority escalation: a follow-up classified hotter RAISES the
    // task; a routine follow-up never downgrades it (review finding — the
    // append branch silently dropped an URGENT re-classification).
    const RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const incoming = opts.priority ?? "HIGH";
    const escalate = (RANK[incoming] ?? 9) < (RANK[existing.priority] ?? 9);
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        description: appended.length > 4000 ? appended.slice(appended.length - 4000) : appended,
        summary: `${opts.senderName}: ${count} messages on ${street} — latest: “${clip(opts.text, 200)}”`.slice(0, 500),
        ...(escalate ? { priority: incoming } : {}),
        ...(existing.dueAt && existing.dueAt.getTime() > Date.now() + 2 * HOUR ? { dueAt: new Date(Date.now() + 2 * HOUR) } : {}),
      },
    });
  } else if (existing) {
    // Closed task, new message → reopen fresh with the new content.
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }
  return true;
}

// Close a client's open "reply" task once we've responded. With per-order reply
// tasks, pass the projectId to close ONLY that order's reply task; omit it to
// close all of the client's open reply tasks (used when we can't tell which order
// a reply addressed).
export async function closeClientReplyTask(clientId: string, projectId?: string | null): Promise<boolean> {
  // Only the CLIENT's own reply ask. A comms_followup is a separate instruction
  // filed by a non-client teammate (a photographer's lockbox code, a coordinator's
  // note) — replying to the client does NOT mean that instruction was handled, so
  // it must never be auto-closed here or actionable work would silently vanish.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } };
  if (projectId) where.projectId = projectId;
  const r = await prisma.smartTask.updateMany({ where, data: { status: "COMPLETED", completedAt: new Date() } });
  return r.count > 0;
}

// Close the right reply task after WE send an outbound message, inferring which
// order it addressed: first from the text (a named street), then from the most
// recent inbound we logged for this client. Falls back to closing all the
// client's reply tasks only when the order genuinely can't be determined.
export async function closeReplyForOutbound(clientId: string, text: string): Promise<boolean> {
  let projectId: string | null = null;
  try {
    const { findClientProjectByText } = await import("@/lib/contacts");
    const named = await findClientProjectByText(clientId, text || "");
    if (named) projectId = named.id;
  } catch { /* fall through */ }
  if (!projectId) {
    const lastInbound = await prisma.commLog.findFirst({
      where: { clientId, direction: "in", projectId: { not: null } },
      orderBy: { occurredAt: "desc" },
      select: { projectId: true },
    });
    projectId = lastInbound?.projectId ?? null;
  }
  return closeReplyScoped(clientId, projectId);
}

// After an outbound CALL to the client (we returned their call), close the
// callback/reply task. No text to parse, so scope to the passed order when known,
// else close only when there's a single open reply task.
export async function closeReplyForOutboundCall(clientId: string, projectId?: string | null): Promise<boolean> {
  return closeReplyScoped(clientId, projectId ?? null);
}

// Close a client's reply task WITHOUT risking the wrong order's: if the order is
// known, close that one; if not, only blanket-close when the client has exactly
// ONE open reply task. Multi-order + unknown → leave it for a human, so a generic
// "thanks!" outbound can't silently clear an unrelated order's open question.
async function closeReplyScoped(clientId: string, projectId: string | null): Promise<boolean> {
  // A scoped close that matches NOTHING falls through to the single-open-task
  // blanket below — the task and the comm row can legitimately disagree on the
  // project (the comms refile re-points CommLog rows when a new project is
  // created but tasks keep their mint-time guess; review: Kyle's street-less
  // "Perfect, we'll be there" stranded the open reply task forever).
  if (projectId && (await closeClientReplyTask(clientId, projectId))) return true;
  const open = await prisma.smartTask.findMany({
    where: { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  if (open.length !== 1) return false;
  await prisma.smartTask.update({ where: { id: open[0].id }, data: { status: "COMPLETED", completedAt: new Date() } });
  return true;
}

// Merge a new inbound into an EXISTING open task the Smart Brain flagged as the
// same request — reopen it, refresh the title/priority/order, and append the new
// context instead of creating a duplicate.
export async function mergeIntoExistingTask(taskId: string, opts: {
  title?: string;
  detail?: string;
  priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  projectId?: string | null;
  clientId?: string | null;
  propertyAddress?: string | null;
  snippet?: string;
  clientName?: string;
  contactName?: string | null;
}): Promise<boolean> {
  const existing = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { description: true, taskType: true } });
  if (!existing) return false;
  // Never merge an inbound comm into a production task (QC/delivery/confirmation/
  // delivery text) — that would overwrite its title/summary. Refuse so the caller
  // falls back to creating a proper reply task.
  if (["media_qa", "delivery", "confirmation_text", "delivery_text", "feedback_review", "image_fixes"].includes(existing.taskType)) return false;
  // The MESSAGE is the update; detail (the brain's read) refreshes the summary
  // below — repeating it in the description doubled the same paragraph.
  const addition = opts.snippet ? clip(opts.snippet, 800) : opts.detail ?? "";
  // Keep the LATEST updates when the log outgrows the cap — the newest message
  // is the one being acted on (the old head-slice silently ate new updates).
  let description = [existing.description, addition ? `Update: ${addition}` : null].filter(Boolean).join("\n\n");
  if (description.length > 4000) description = "…" + description.slice(-4000);
  const titled = opts.title ? opts.title.slice(0, 120) : undefined;
  // Refresh the "what happened" summary to the latest read when we have one.
  const summary = (opts.detail?.trim() || opts.snippet?.trim()) ? (opts.detail?.trim() || `New message: “${clip(opts.snippet!, 240)}”`) : undefined;
  await prisma.smartTask.update({
    where: { id: taskId },
    data: {
      status: "OPEN",
      completedAt: null,
      description,
      ...(summary ? { summary: summary.slice(0, 500) } : {}),
      ...(titled ? { title: titled } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
      ...(opts.propertyAddress !== undefined ? { propertyAddress: opts.propertyAddress } : {}),
      ...(opts.contactName !== undefined ? { contactName: differentName(opts.contactName, opts.clientName) } : {}),
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// QcRecord — the owner's quality dial. One row per QC pass, written when a
// media_qa card completes. It snapshots WHICH failure-mode items Kyle actually
// ticked (a miss = a Kyle-tick left false at completion) so we can see, over
// time, whether QC is being run or rubber-stamped, and — when a revision later
// reopens the QC — WHY it bounced. Read-only analytics; never gates task flow.
// ---------------------------------------------------------------------------

// Auto-checked evidence rows on a media_qa checklist are driven by Aryeo/gallery
// signals, NOT by Kyle: the per-category "QC <label>" rows, the "Deliver the
// gallery / Produce + deliver …" row, and the pre-checked "cull near-duplicates"
// guidance line. Everything else (the failure-mode sub-items, VIP passes, and any
// revision-injected re-QC item) is a MANUAL Kyle-tick — those are the ones a miss
// is counted against. Keep this in sync with the labels specsForProject emits.
function isAutoCheckRow(label: string): boolean {
  const l = label.trim();
  // Category evidence rows: "QC Photos", "QC Reel", "QC Floor plan", … BUT not a
  // revision-injected "QC <cat> (revision)" (that IS Kyle's manual re-QC work).
  if (/^QC\s/i.test(l) && !/\(revision\)/i.test(l)) return true;
  if (/deliver the gallery/i.test(l) || /produce \+ deliver/i.test(l)) return true;
  if (/cull near-duplicates/i.test(l)) return true;
  return false;
}

// How many Kyle-tick items were left unchecked at completion (the auto-check
// evidence rows don't count as misses — they're not his to verify).
export function countQcMisses(items: ChecklistItem[]): number {
  return items.filter((i) => !isAutoCheckRow(i.label) && !i.done).length;
}

// Write ONE QcRecord for a just-completed media_qa task, idempotently. Called
// from BOTH completion paths (the reconciler's auto-complete branch and the
// interactive toggle action) — dedupe on "a QcRecord for this project completed
// in the last few minutes" so re-running the reconciler right after a completion
// never double-writes. Best-effort: a QcRecord failure must never break the task
// flow, so callers wrap this and swallow.
const QC_RECORD_DEDUPE_MS = 5 * 60_000;
export async function recordQcCompletion(opts: {
  projectId: string;
  items: ChecklistItem[];
  clientSegment?: string | null;
  completedBy?: string | null;
}): Promise<void> {
  const recent = await prisma.qcRecord.findFirst({
    where: { projectId: opts.projectId, completedAt: { gte: new Date(Date.now() - QC_RECORD_DEDUPE_MS) } },
    select: { id: true },
  });
  if (recent) return; // already logged this completion (both paths fired)
  await prisma.qcRecord.create({
    data: {
      projectId: opts.projectId,
      clientSegment: opts.clientSegment ?? null,
      itemsChecked: serializeChecklist(opts.items),
      missCount: countQcMisses(opts.items),
      completedBy: opts.completedBy ?? null,
    },
  });
}

// When a deliverable goes back into revision (e.g. Luma "Revision Request
// Received" on a reel), reflect it in the project's QC task: reopen it and mark
// the revised deliverable's checkbox as needing a re-QC (unchecked). Creates the
// QC task if the job had already been delivered + its QC completed.
// `categories` = QC labels like ["Reel"] / ["Photos"]; empty = generic re-QC.
// `reason` = the revision summary; when present we stamp the project's latest
// QcRecord with reopenedByRevisionAt + revisionReason — that bounce IS the QC-miss
// event, and it's what the owner dial reads to compute the real miss rate.
export async function reflectRevisionInQc(projectId: string, categories: string[], reason?: string | null): Promise<void> {
  // Stamp the latest QC pass as reopened-by-revision (best-effort, before the
  // reopen below re-opens the task). If QC never ran (no record) this no-ops.
  try {
    const last = await prisma.qcRecord.findFirst({
      where: { projectId },
      orderBy: { completedAt: "desc" },
      select: { id: true },
    });
    if (last) {
      await prisma.qcRecord.update({
        where: { id: last.id },
        data: { reopenedByRevisionAt: new Date(), revisionReason: reason?.slice(0, 500) ?? null },
      });
    }
  } catch { /* dial is analytics-only — never block the revision */ }
  const existing = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "media_qa" },
    orderBy: { createdAt: "desc" },
  });

  const markRevised = (items: ChecklistItem[]): ChecklistItem[] => {
    const out = [...items];
    if (categories.length === 0) {
      // A SECOND generic revision must re-arm the gate: the row from round one
      // is already ticked done, and leaving it done meant the reconciler saw
      // an all-done card and auto-completed the re-QC within the hour.
      const idx = out.findIndex((i) => /re-?qc after revision/i.test(i.label));
      if (idx >= 0) out[idx] = { label: out[idx].label, done: false };
      else out.push({ label: "Re-QC after revision", done: false });
      return out;
    }
    for (const c of categories) {
      const idx = out.findIndex((i) => i.label.toLowerCase().includes(c.toLowerCase()));
      if (idx >= 0) out[idx] = { label: out[idx].label.includes("(revision)") ? out[idx].label : `${out[idx].label} (revision)`, done: false };
      else out.push({ label: `QC ${c} (revision)`, done: false });
    }
    return out;
  };

  // Sep 8 (due-fuses audit): the re-QC card was born due-now too — "Overdue ·
  // <raise minute>" on Kyle's list before the corrected media could exist.
  // No due date (a revision promises nothing); HIGH, URGENT for VIP/unhappy.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, clientId: true, client: { select: { segment: true } } },
  });
  if (!project) return;
  const priority = revisionPriority({ segment: project.client?.segment, ask: reason });

  if (existing) {
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        status: "OPEN",
        completedAt: null,
        priority,
        dueAt: null,
        checklist: serializeChecklist(markRevised(parseChecklist(existing.checklist))),
      },
    });
    return;
  }

  // No QC task (job was delivered + QC closed) → make one for the re-QC.
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "media_qa",
      title: `QC — ${project.title}`,
      summary: "A deliverable went back into revision after delivery. Re-QC the corrected version once it's re-uploaded, then re-deliver to the client.",
      reasonCreated: "Deliverable back in revision — re-QC the new version",
      checklist: serializeChecklist(markRevised([])),
      source: "revision",
      priority,
      assignedKey: "kyle",
      dueAt: null,
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: dedupe([projectId, "media_qa"]),
    },
  });
}

// Production tasks that become obsolete once a job is delivered/cancelled.
const PRODUCTION_TASK_TYPES = ["confirmation_text", "appointment_prep", "media_qa", "delivery", "finish_delivery"];
// On DELIVERED we ALSO retire a couple of non-"production" types that are moot
// once the gallery shipped: outstanding photo-flag fixes (a real re-do comes back
// as a client revision, which is left open) and teammate job-prep instructions.
// NOT delivery_text — that's created below and closes on its own timer/send.
// vendor_update ("download + QC the finished Luma reel") is delivery work by
// definition — once the job is DELIVERED it happened; nothing else closes it
// (audit: no close path, tasks rotted open forever).
const DELIVERED_CLOSE_TYPES = [...PRODUCTION_TASK_TYPES, "image_fixes", "comms_followup", "edit_video", "vendor_update"];

// Close out a project's now-obsolete open tasks when it reaches a terminal
// state, so Daily Tasks doesn't show ghost work on finished/cancelled jobs.
//   DELIVERED  → complete the production tasks (QA/deliver/prep/finish)
//   CANCELLED  → cancel every open task on the job
// Comm-driven tasks (client_reply / revision) are left alone — still actionable.
//
// `sweep`: called from closeTasksOnInactiveProjects (hourly janitor) rather
// than from the status transition. Same rules, two differences: a row a human
// (re)opened by hand (assignedManually) is never a janitor's to close — that
// invariant every engine respects — and no delivery text is minted here: the
// status sweep already mints one per pass on DELIVERED jobs, and a job that
// shipped weeks ago must not get a "how did we do?" from housekeeping.
export async function closeObsoleteTasks(
  projectId: string,
  projectStatus: string,
  opts: { sweep?: boolean } = {},
): Promise<number> {
  const humanKept = opts.sweep ? { assignedManually: false } : {};
  // A delivered or cancelled job has no Waiting hold left to honour (Sep 11
  // review): the marker (queueWaiting.ts) is inert on any status but
  // BOOKED/SCHEDULED, but left behind it would re-arm under the old name and
  // time the day a board drag puts the job back on Scheduled. Every delivery
  // and cancel path — the board, the queue pill, the sweep, the janitor,
  // Aryeo's cancel — comes through here.
  if (projectStatus === "CANCELLED" || projectStatus === "DELIVERED") {
    try {
      const { releaseWaitingHold } = await import("@/lib/queueWaiting");
      await releaseWaitingHold(projectId);
    } catch { /* hygiene only — never blocks the close */ }
  }
  if (projectStatus === "CANCELLED") {
    const r = await prisma.smartTask.updateMany({
      where: { projectId, status: { notIn: ["COMPLETED", "CANCELLED"] }, ...humanKept },
      data: { status: "CANCELLED" },
    });
    return r.count;
  }
  if (projectStatus === "DELIVERED") {
    // Kyle delivers on Aryeo directly, so this sweep — not the guided checklist
    // — is how most media_qa cards actually die. Snapshot each one into a
    // QcRecord FIRST (missCount = whatever was still unticked, completedBy
    // "auto:delivered") so a bypassed QC pass is measurable instead of
    // invisible: 30 of 30 deliveries had closed this way with ZERO QcRecords,
    // and the owner's quality dial read empty (July 2026 audit). Analytics
    // only — a record failure never blocks the close.
    try {
      const qcCards = await prisma.smartTask.findMany({
        where: { projectId, taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { checklist: true },
      });
      if (qcCards.length > 0) {
        const segment = await prisma.project.findUnique({
          where: { id: projectId },
          select: { client: { select: { segment: true } } },
        });
        for (const card of qcCards) {
          await recordQcCompletion({
            projectId,
            items: parseChecklist(card.checklist),
            clientSegment: segment?.client?.segment ?? null,
            completedBy: "auto:delivered",
          });
        }
      }
    } catch { /* QC snapshot is best-effort */ }
    // Receipt for the editor BEFORE the close: their card vanishing silently
    // was indistinguishable from "disappeared" (audit) — now the bell (and the
    // editor dashboard's For-you feed) says "accepted & delivered".
    try {
      const editorTasks = await prisma.smartTask.findMany({
        where: { projectId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] }, assignedKey: { not: null } },
        select: { assignedKey: true, title: true },
      });
      if (editorTasks.length) {
        const { notifyInApp } = await import("@/lib/notify");
        const { TEAM_MEMBER_EDITOR_KEYS } = await import("@/lib/editors");
        for (const t of editorTasks) {
          if (!t.assignedKey || !(TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(t.assignedKey)) continue;
          await notifyInApp({
            kind: "edit_finished",
            title: `Delivered ✓ — ${t.title.split("—").pop()?.trim() ?? t.title}`.slice(0, 90),
            href: "/editing",
            targets: [{ roles: ["EDITOR"], userKey: `editor:${t.assignedKey}` }],
            dedupeKey: `editdone-${projectId}-${t.assignedKey}`,
          });
        }
      }
    } catch { /* receipts never block the close */ }
    const r = await prisma.smartTask.updateMany({
      where: {
        projectId,
        taskType: { in: DELIVERED_CLOSE_TYPES },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        ...humanKept,
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    // EVERY system watchdog to-do on this job is moot once the gallery shipped —
    // the cull nudge, "Find the raw video", "No raws uploaded" (audit Aug 25:
    // 8 of 11 open watchdogs sat on already-DELIVERED jobs for up to 16 days,
    // because only the cull nudge had this carve-out). System-minted todos are
    // recognizable by their dedupeKey prefixes; a HUMAN-added todo (manual/
    // assistant source, no dedupeKey pattern) is left alone — it may be real
    // follow-up work.
    await prisma.smartTask.updateMany({
      where: {
        projectId,
        taskType: "todo",
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [
          { dedupeKey: `cull-${projectId}` },
          { dedupeKey: `raws-missing-${projectId}` },
          { dedupeKey: `raw-video-missing-${projectId}` },
        ],
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    // Closing the image_fixes task without resolving its ImageFlag rows left
    // the Flags tab lying ("3 open flags" on a delivered gallery) — and ONE new
    // flag resurrected every stale one into Kyle's 24h fix task (audit). The
    // delivery IS the resolution: fixed or shipped-as-is, the round is over.
    await prisma.imageFlag
      .updateMany({
        where: { projectId, status: "OPEN" },
        data: { status: "FIXED", resolvedAt: new Date() },
      })
      .catch(() => {});
    if (!opts.sweep) await createDeliveryTextTask(projectId);
    return r.count;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Janitor for tasks on jobs the hourly reconciler never visits. It scans only
// active statuses, so a task left open on a DELIVERED / CANCELLED / ON_HOLD job
// stayed open until some webhook happened to touch the project (Sep 8 audit:
// "QC & deliver — 56 Hillview Rd" open 41 days on a held job, invisible on
// every screen but counted in "84 open"; two confirmations on DELIVERED jobs
// cancelled only when a webhook wandered by at 15:58). Same rules as the
// status transition (closeObsoleteTasks, sweep mode); ON_HOLD parks the
// production tasks — CANCELLED with the JOB_ON_HOLD stamp — and the
// reconciler reopens exactly those when the job comes off hold. Runs every
// hour from generateTasksForActiveProjects (one indexed query when there is
// nothing to do); exported so the daily cron can own it instead if preferred.
// ---------------------------------------------------------------------------
export async function closeTasksOnInactiveProjects(): Promise<{ delivered: number; cancelled: number; onHold: number }> {
  const stray = await prisma.smartTask.findMany({
    where: {
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      assignedManually: false, // a human's reopened work is never a janitor's to close
      projectId: { not: null },
      OR: [
        { project: { status: "CANCELLED" } },
        // The SWEEP arm skips image_fixes and anything a person flagged: those are
        // minted AFTER delivery on purpose (flagged photos, a field flag), and the
        // hourly pass was completing them — and flipping every OPEN ImageFlag to
        // FIXED — silently (review, Sep 8). The DELIVERED transition itself
        // (closeObsoleteTasks) still closes pre-delivery production work.
        { project: { status: "DELIVERED" }, taskType: { in: DELIVERED_CLOSE_TYPES.filter((t) => t !== "image_fixes") }, flaggedAt: null },
        { project: { status: "ON_HOLD" }, taskType: { in: PRODUCTION_TASK_TYPES } },
      ],
    },
    select: { id: true, projectId: true, project: { select: { status: true } } },
  });
  const out = { delivered: 0, cancelled: 0, onHold: 0 };
  const byProject = new Map<string, { status: string; ids: string[] }>();
  for (const t of stray) {
    if (!t.projectId || !t.project) continue;
    const e = byProject.get(t.projectId) ?? { status: t.project.status, ids: [] };
    e.ids.push(t.id);
    byProject.set(t.projectId, e);
  }
  for (const [projectId, { status, ids }] of byProject) {
    if (status === "ON_HOLD") {
      const r = await prisma.smartTask.updateMany({
        where: { id: { in: ids }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        // CANCELLED, never COMPLETED: nothing happened. No completedAt for
        // the same reason (every "what got done" count pairs it with COMPLETED).
        data: {
          status: "CANCELLED",
          sourceDetail: JOB_ON_HOLD,
          summary: "Parked — the job is on hold. This comes back on its own when the job comes off hold.",
        },
      });
      out.onHold += r.count;
      continue;
    }
    // DELIVERED / CANCELLED: the exact transition-time rules, in sweep mode.
    const n = await closeObsoleteTasks(projectId, status, { sweep: true });
    if (status === "DELIVERED") out.delivered += n;
    else out.cancelled += n;
  }
  return out;
}

// When a job is delivered, queue Kyle's post-delivery client TEXT (we dropped
// care calls — no one answers). The drafted, status-aware message + feedback
// link is attached so Kyle just reviews and sends. Deduped one per project.
/** Marks a delivery text minted only because the monthly batch ran out of
 *  time — a HUMAN decides on these; the auto-sweep never sends them. */
export const MONTHLY_BATCH_INCOMPLETE = "monthly-batch-incomplete";
/** A delivery text minted for a job Aryeo fulfilled days ago (an order the
 *  hub only caught up with now). Kyle decides — never auto-sent. */
export const DELIVERED_LONG_AGO = "delivered-long-ago";
/** Stamped on a QC card a human closed with a reason — the reconciler must
 *  never reopen it over unticked boxes. */
export const CLOSED_BY_HAND = "closed-by-hand";
/** Stamped on a client-text task the sweep CLAIMED but could not prove it sent
 *  (a timeout / 5xx after OpenPhone may already have accepted the message). The
 *  claim is held so the sweep can never double-text — this marks the row so a
 *  human, and any later honesty audit, can tell it apart from a clean send. */
export const SEND_UNVERIFIED = "send-unverified";

// ---------------------------------------------------------------------------
// DELIVERY-TEXT LIFECYCLE (Jordan, Sep 2 2026: "every number on screen is true")
//
// Audit fault #8: of the delivery-text tasks that reached the 7-day sweeper in
// 60 days, 12 of 12 had ZERO outbound text to that client in the whole window —
// and the sweeper wrote COMPLETED, so the Done ledger credited a text nobody
// sent. The confirmation twin already stamps CANCELLED when its spec vanishes
// (see reconcileTasks); this one was never mirrored. Two rules now:
//   · a delivery text nothing can prove was sent closes CANCELLED, with a
//     reason on the task AND on the project timeline — never COMPLETED;
//   · it is not born overdue (deliveryTextDueAt below).
// ---------------------------------------------------------------------------

/** When a delivery text should actually go out, as a real deadline.
 *
 *  It used to mint with `dueAt: new Date()` — due the millisecond it existed,
 *  so it read "overdue" before anyone could act and 13 of the system's 33
 *  overdue items were these. 46% of them were minted OUTSIDE the 9am-4pm ET
 *  send window (an Aryeo fulfilment at 7pm, an overnight reconcile), so they
 *  could not have been sent at all before the clock condemned them.
 *
 *  The honest deadline is the END of the send window it can first go out in:
 *  minted inside today's window → due when today's window shuts; minted after
 *  it (or overnight) → due when tomorrow's shuts. Nothing reads late until the
 *  last moment it could really have been sent has passed. DST-safe via etAt.
 *
 *  SEAM (Jordan is changing what this text SAYS — it becomes a feedback ask
 *  that waits for the whole job to be delivered): the copy lives in
 *  lib/delivery `deliveryMessage`, and the "is the whole job actually out?"
 *  gate is the statusEvidence check in sweepDeliveryTexts. If the ask needs to
 *  wait longer than the first send window (e.g. a day after the last
 *  deliverable lands), change WHEN here — the honest-close half needs no
 *  change, because it asks whether a text was sent, not how long it's been. */
export function deliveryTextDueAt(from: Date, sendUntilHour: number): Date {
  const closesToday = etAt(etDayKey(from), sendUntilHour);
  if (from.getTime() < closesToday.getTime()) return closesToday;
  // +30h off THIS ET midnight lands safely inside tomorrow either side of a
  // DST flip (the etDayStartUtc/etEndOfTodayUtc idiom used in lib/clientTexts).
  return etAt(etDayKey(new Date(etDayStartUtc(from).getTime() + 30 * HOUR)), sendUntilHour);
}

/** Proof that a delivery text for THIS job actually reached the client.
 *
 *  Deliberately project-scoped, not client-scoped. Every send path leaves a
 *  trace against the project:
 *    · the auto-sweep      → the `auto-delivery-<projectId>` AppSetting marker
 *    · the in-app Send     → an Activity "Delivery text sent to …" (actions.ts
 *                            sendDeliveryText / sendAllActions sendDraftText)
 *    · Kyle from his phone → an outbound CommLog text filed to this project by
 *                            the OpenPhone webhook (projectGuess rows excluded:
 *                            a router GUESS is not evidence)
 *  Anything else — including a text to the same client about a different
 *  address — is not proof this job's client was told. Over-cancelling is the
 *  safe direction; crediting an unsent text is the sin Jordan is buying out.
 *
 *  The window opens 12h BEFORE the task was minted: Kyle regularly texts "it's
 *  all live" before Aryeo's fulfilment reaches the hub and mints the task (of
 *  the 12, exactly one — 1741 Hilltop Rd — was sent 2h20m before its own task
 *  existed, and this grace is what keeps it honest). */
export async function deliveryTextSendProof(
  t: { projectId: string | null; clientId: string | null; createdAt: Date },
  until: Date = new Date(),
): Promise<{ how: string | null; at: Date | null; clientTextedAt: Date | null }> {
  if (!t.projectId) return { how: null, at: null, clientTextedAt: null };
  const from = new Date(t.createdAt.getTime() - 12 * HOUR);

  // STRONGEST first: a real logged outbound message. logComm only runs after
  // OpenPhone accepted the send, so this row IS a text that left the building.
  const logged = await prisma.commLog
    .findFirst({
      where: { projectId: t.projectId, channel: "text", direction: "out", projectGuess: false, occurredAt: { gte: from, lte: until } },
      select: { occurredAt: true },
      orderBy: { occurredAt: "desc" },
    })
    .catch(() => null);
  if (logged) return { how: "texted about this job", at: logged.occurredAt, clientTextedAt: null };

  // The per-card Send writes no CommLog of its own (it leans on the delivery
  // webhook, which may file the echo to a GUESSED project) — its Activity row
  // is the only project-scoped receipt, so it has to count.
  const act = await prisma.activity
    .findFirst({
      where: {
        projectId: t.projectId,
        type: "SYSTEM",
        OR: [{ body: { startsWith: "Delivery text sent" } }, { body: { startsWith: "Delivery text auto-sent" } }],
        createdAt: { gte: from, lte: until },
      },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
    })
    .catch(() => null);
  if (act) return { how: "sent from the hub", at: act.createdAt, clientTextedAt: null };

  // WEAKEST, and last on purpose: the auto-sweep's claim marker. It is written
  // just BEFORE the send and released again on a provable rejection, so its
  // presence means "sent, or ambiguous" — and the ambiguous ones are stamped
  // SEND_UNVERIFIED (see clientTextSweeps markSendUnverified). It earns its
  // place because logComm there is best-effort and can silently fail.
  const marker = await prisma.appSetting
    .findFirst({ where: { key: `auto-delivery-${t.projectId}` }, select: { value: true } })
    .catch(() => null);
  if (marker) {
    const at = new Date(marker.value);
    return { how: "the hub sent it automatically", at: isNaN(at.getTime()) ? null : at, clientTextedAt: null };
  }

  // Nothing for this job. Was the client texted AT ALL? Not proof — but it's
  // the difference between "we talked to them about something else" and "we
  // went silent on this person", and the close reason says which.
  const anyText = t.clientId
    ? await prisma.commLog
        .findFirst({
          where: { clientId: t.clientId, channel: "text", direction: "out", occurredAt: { gte: from, lte: until } },
          select: { occurredAt: true },
          orderBy: { occurredAt: "desc" },
        })
        .catch(() => null)
    : null;
  return { how: null, at: null, clientTextedAt: anyText?.occurredAt ?? null };
}

export async function createDeliveryTextTask(projectId: string): Promise<void> {
  const key = dedupe([projectId, "delivery_text"]);
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, clientId: true, statusEvidence: true, packageName: true, shootDate: true, deliveredAt: true,
      // The batch this job owes, the office's number first (Sep 13) — see
      // effectiveVideosOwed below.
      videosOwedOverride: true, videosFilmed: true,
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } },
      client: { select: { name: true } },
    },
  });
  if (!project) return;
  // The hub flipped this job DELIVERED because the ORDER changed (an item
  // was removed and the reconcile just caught up — 632 Greenridge: Aryeo
  // delivered Aug 26, reconciled Sep 1), not because media landed. "Your
  // gallery is ready — how did we do?" days late reads as a bug to the
  // client. Mint it as a decision for Kyle, never an auto-send. Keyed on the
  // reconcile's own activity row (last 3h) — NOT on Aryeo's fulfilled_at,
  // which lands at the first media delivery of every staged job.
  const orderJustChanged = await prisma.activity.findFirst({
    where: { projectId, type: "SYSTEM", body: { startsWith: "Order changed in Aryeo" }, createdAt: { gte: new Date(Date.now() - 3 * HOUR) } },
    select: { id: true },
  });
  const deliveredLongAgo = !!orderJustChanged;
  // MONTHLY CONTENT: the order carries ONE line item but the session owes a
  // BATCH of videos, so Aryeo showing video #1 used to mint (and auto-send)
  // "everything has been delivered" while the rest were still in production
  // (Jordan, Sep 1 — 131 Woodcutter St). Hold the task back until the batch is
  // real. Gating the SEND instead was worse: the task aged out of the sweep's
  // 72h window and the 7-day sweeper closed it, so the text never went at all
  // (review HIGH). Because this mint is dedupeKey-guarded and re-attempted
  // every status pass, holding back here is safe and self-healing.
  let batchIncomplete = false;
  const { autoTextRules } = await import("@/lib/settings");
  const rules = await autoTextRules();
  const requireBatch = rules.delivery.requireMonthlyBatch;
  if (requireBatch && isMonthlyContentJob(project.deliverables, project.packageName)) {
    const { parseEvidence } = await import("@/lib/statusEvidence");
    const { monthlyVideoQuota } = await import("@/lib/pipeline");
    const videos = parseEvidence(project.statusEvidence)?.aryeo?.videos ?? 0;
    // The batch: the office's number when it set one (Sep 13, editOverrides
    // — "videos owed 6" on a 4-video month holds the text until six are
    // live); otherwise the plan quota, raised to the photographer's own count
    // when they filmed more (the same ladder cutSlots owes against).
    const { effectiveVideosOwed } = await import("@/lib/editOverrides");
    const quota =
      project.videosOwedOverride ??
      Math.max(
        monthlyVideoQuota([project.packageName, ...project.deliverables.map((d) => d.label)]),
        effectiveVideosOwed(project, project.deliverables),
      );
    // The editor's explicit override on the Editor Queue (setQueueStatus), or
    // the office forcing Completed through the override dialog (Sep 13) —
    // either is a human saying the batch is done. Only when it is the LATEST
    // human status word on the job (review, Sep 13): those rows are
    // permanent, and a job put back to In editing after a Completed used to
    // read "marked complete" forever, so the text went the moment it next
    // read Delivered — with the batch still short. The newest "Queue status
    // set: …" / "Override by …: status …" row decides; any later one that is
    // not a Completed hands the decision back to the evidence.
    const latestStatusWord = await prisma.activity.findFirst({
      where: {
        projectId,
        type: "SYSTEM",
        OR: [
          { body: { startsWith: "Queue status set:" } },
          // describeOverrides puts the status part first: "Override by
          // <name>: status A → B …" — so a note that merely says "status"
          // can't pass as a status row.
          { body: { startsWith: "Override by", contains: ": status " } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    });
    const markedComplete =
      !!latestStatusWord &&
      (latestStatusWord.body.startsWith("Queue status set: Completed") ||
        (latestStatusWord.body.startsWith("Override by") &&
          (latestStatusWord.body.includes("→ Completed") || latestStatusWord.body.includes("pinned on Completed"))));
    if (videos < quota && !markedComplete) {
      // Not there yet. Keep waiting UNLESS the promised turnaround has already
      // passed — then a human must decide rather than the job going silent.
      const due = project.shootDate ? deliveryDueFrom(project.shootDate, "VIDEO", { monthlyContent: true }) : null;
      if (!due || due.getTime() > Date.now()) return;
      batchIncomplete = true;
    }
  }
  const { deliveryMessage } = await import("@/lib/delivery");
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "delivery_text",
      title: `Send delivery text — ${project.title}`,
      summary: batchIncomplete
        ? "This monthly-content job is past its turnaround but Aryeo still shows fewer videos than the plan owes. Check what actually shipped: finish the batch, or send the client an honest update. The hub will NOT send this one on its own."
        : deliveredLongAgo
          ? "This job read as delivered only after its Aryeo order changed (an item was removed) — the client may have had everything for days. A \"how did we do?\" text now may read oddly: send it, adapt it, or skip it. The hub will NOT send this one on its own."
          : "This job was delivered. Review the drafted post-delivery text (with the feedback link) and send it to the client. A feedback reply auto-logs back to the project.",
      // Same copy the sweep will actually send (Jordan's feedback ask), so the
      // task board and the outgoing text can never disagree.
      description: deliveryMessage(project, await (async () => {
        const { textTemplates, DEFAULT_DELIVERY_FEEDBACK_TEXT } = await import("@/lib/settings");
        const tpl = await textTemplates();
        return { ...tpl, deliveryAll: tpl.deliveryAll.trim() || DEFAULT_DELIVERY_FEEDBACK_TEXT };
      })()),
      reasonCreated: "Delivered — send the post-delivery client text + feedback link",
      checklist: JSON.stringify([
        "Review the drafted message below",
        "Send it to the client via OpenPhone",
        "Watch for a feedback reply (auto-logs to the project)",
      ]),
      source: "system",
      // An incomplete batch past its turnaround is a decision, not a courtesy
      // nudge — it outranks a normal delivery text and is flagged so the
      // auto-sweep leaves it strictly alone.
      priority: batchIncomplete ? "HIGH" : "MEDIUM",
      ...(batchIncomplete ? { sourceDetail: MONTHLY_BATCH_INCOMPLETE } : deliveredLongAgo ? { sourceDetail: DELIVERED_LONG_AGO } : {}),
      // NOT `new Date()` — that minted it already overdue (see
      // deliveryTextDueAt). The send window is the settings-driven one the
      // sweep actually obeys, so the deadline moves with it.
      // Weekend-aware: a task minted Friday evening must not read overdue all
      // weekend when the send window is Mon-Fri (dynamic import — clientTextSweeps
      // imports this module, so a static one would cycle).
      dueAt: (await import("@/lib/clientTextSweeps")).clientTextDueAt(new Date(), rules),
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    },
  });
}

// Retire delivery texts a week after they were queued — but HONESTLY.
//
// The old version was one blanket `updateMany` to COMPLETED on the assumption
// that "Kyle already sent it from his phone". Live data says otherwise: 12 of
// the 12 tasks that reached this sweeper in 60 days had no outbound text to
// that client at all, and the Done ledger credited every one of them as a text
// that went out. Now each row is judged on evidence (deliveryTextSendProof):
//   · proof the client was told  → COMPLETED, as before
//   · no proof                   → CANCELLED, with a reason on the task and a
//                                  line on the project timeline
// CANCELLED is the twin of what the confirmation reconciler already does — it
// clears the overdue count exactly the same way, without claiming credit.
export async function closeStaleDeliveryTexts(days = 7): Promise<{ sent: number; neverSent: number }> {
  const cutoff = new Date(Date.now() - days * DAY);
  const stale = await prisma.smartTask.findMany({
    where: { taskType: "delivery_text", status: { notIn: ["COMPLETED", "CANCELLED"] }, createdAt: { lt: cutoff } },
    select: { id: true, projectId: true, clientId: true, createdAt: true, propertyAddress: true, client: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    // This is now evidence-per-row instead of one blanket updateMany, so cap the
    // batch: a one-off backlog must not eat the daily cron's budget. Oldest
    // first, and tomorrow's run takes the rest.
    take: 200,
  });
  let sent = 0, neverSent = 0;
  const now = new Date();
  for (const t of stale) {
    const proof = await deliveryTextSendProof(t, now);
    const who = t.client?.name ?? "the client";
    const job = t.propertyAddress ?? "this job";
    // Per-row and CONDITIONAL on the row still being open — the in-app Send
    // button, the batch send and the auto-sweep all claim this same row, so a
    // send landing mid-sweep must win rather than be overwritten.
    const claimed = await prisma.smartTask.updateMany({
      where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: proof.how
        ? { status: "COMPLETED", completedAt: now }
        : {
            // NO completedAt on a cancel — same as the confirmation twin in
            // reconcileTasks. Every "what got done" count pairs completedAt
            // with status COMPLETED today, and a close-stamp on a never-sent
            // row is exactly the kind of field a future query would read
            // without the status filter and credit as work. updatedAt already
            // records when it closed.
            status: "CANCELLED",
            summary: clip(
              `Closed unsent after ${days} days. No delivery text ever reached ${who} about ${job} — nothing went out from the hub, and no outbound text to them is filed against this job. ` +
                (proof.clientTextedAt
                  ? `We did text ${who} on ${etDateTime(proof.clientTextedAt)} ET, but about another job. `
                  : `${who} was not texted at all in that window. `) +
                `It is NOT counted as done. Text them by hand if it still helps.`,
              500,
            ),
          },
    });
    if (claimed.count === 0) continue; // someone sent it in the last second — their close stands
    if (proof.how) { sent++; continue; }
    neverSent++;
    if (t.projectId) {
      await prisma.activity
        .create({
          data: {
            projectId: t.projectId,
            type: "SYSTEM",
            body: `No delivery text was ever sent to ${who} for this job — the reminder was closed unsent after ${days} days.`,
          },
        })
        .catch(() => {});
    }
  }
  return { sent, neverSent };
}


// ---------------------------------------------------------------------------
// Vendor round-trip chase (audit crack #16). CubiCasa (floor plans) and AutoHDR
// (photo edits) are fire-and-forget vendors: their "it's ready" emails are
// filtered as noise, so when their piece never comes back the only tracker is
// Kyle's memory — 14 of 141 recent deliveries shipped missing a whole ordered
// category. When the status cross-check shows one of their categories STILL
// missing days after the shoot, mint ONE deduped chase task per
// project+category (never re-minted once handled, even if completed).
// ---------------------------------------------------------------------------
const VENDOR_CHASE: { category: string; vendor: string; work: string; delayDays: number }[] = [
  // Floor-plan turnaround is 36h; photos are next-morning. Chasing a day+ past
  // those SLAs keeps this conservative — no task while the vendor is on time.
  { category: "Floor plan", vendor: "CubiCasa", work: "floor plan", delayDays: 3 },
  { category: "Photos", vendor: "AutoHDR", work: "photo edits", delayDays: 2 },
];
const vendorChaseKey = (projectId: string, category: string) =>
  `vendor-chase-${projectId}-${category.toLowerCase().replace(/\s+/g, "")}`;

// The chase's only close used to be DELIVERED (Sep 8 audit: "Chase CubiCasa
// floor plan — 195 Woodhill Rd" open 7 days; once the plan lands the chase
// would stay open until the whole job shipped, so Kyle chases a vendor who
// already delivered). The status cross-check that minted it also proves the
// piece arrived — a category in statusEvidence.present closes its chase.
export async function closeVendorChasesForPresent(projectId: string, present: string[]): Promise<number> {
  const keys = VENDOR_CHASE.filter((v) => present.includes(v.category)).map((v) => vendorChaseKey(projectId, v.category));
  if (keys.length === 0) return 0;
  const r = await prisma.smartTask.updateMany({
    where: { dedupeKey: { in: keys }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return r.count;
}

export async function chaseVendorsForMissing(
  projectId: string,
  opts: { title: string; shootDate: Date | null; missing: string[] },
): Promise<number> {
  if (!opts.shootDate || opts.missing.length === 0) return 0;
  const daysSinceShoot = (Date.now() - opts.shootDate.getTime()) / DAY;
  const due = VENDOR_CHASE.filter(
    (v) => opts.missing.includes(v.category) && daysSinceShoot >= v.delayDays,
  );
  if (due.length === 0) return 0;

  const street = (opts.title || "this job").split(",")[0].trim();
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });

  let created = 0;
  for (const v of due) {
    // One chase per project+category, ever — a completed chase means Kyle
    // already handled it; don't nag again on the next hourly pass.
    const key = vendorChaseKey(projectId, v.category);
    if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) continue;
    await prisma.smartTask.create({
      data: {
        taskType: "comms_followup",
        title: `Chase ${v.vendor} ${v.work} — ${street}`.slice(0, 120),
        summary: `The ordered ${v.category.toLowerCase()} still isn't live on Aryeo ${Math.floor(daysSinceShoot)} days after the shoot — the ${v.vendor} round-trip may have dropped. Check the ${v.vendor} portal/email for the finished ${v.work}, upload it, or chase them for an ETA.`.slice(0, 500),
        reasonCreated: `Ordered ${v.category.toLowerCase()} missing ${v.delayDays}+ days after the shoot (${v.vendor} round-trip)`,
        checklist: JSON.stringify([
          `Check ${v.vendor} for the finished ${v.work}`,
          "Upload it to Aryeo (or confirm it was delivered off-Aryeo)",
          `Chase ${v.vendor} for an ETA if it's not ready`,
        ]),
        source: "system",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 4 * HOUR),
        projectId,
        clientId: project?.clientId ?? null,
        propertyAddress: opts.title,
        ownerId: kyle?.id ?? null,
        // Chasing vendors is Kyle's routine, like QC and delivery — the row
        // used to carry only ownerId, so it read "unassigned" on every screen
        // that keys on assignedKey (Sep 8 audit: both open chases, no name).
        assignedKey: "kyle",
        dedupeKey: key,
      },
    });
    created++;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Cull-at-the-source (Jul 2026 audit). The hourly status sweep is the only place
// that reads the RAW folder count, so it's where "the photographer shot too much"
// gets caught. When raws blow past the photo budget × the overage factor, mint
// ONE deduped task pointing at the photographer so the pile gets culled BEFORE it
// costs editing money — and text them, since they've left the property. Called
// from syncProjectStatuses on SHOT/EDITING jobs only (raws in, not yet delivered).
// Best-effort by design: the caller never lets it break the sweep.
// ---------------------------------------------------------------------------
export async function mintCullTask(opts: {
  projectId: string;
  title: string;
  rawPhotos: number;
  target: number;
  photographerId: string | null;
  photographerName: string | null;
}): Promise<boolean> {
  const { projectId, rawPhotos, target } = opts;
  const street = (opts.title || "this job").split(",")[0].trim();
  const estFinals = Math.round(rawPhotos / BRACKET_RATIO);
  const overBy = rawPhotos - target * BRACKET_RATIO;
  // One cull task per project, ever — a completed one means the photographer
  // already handled it; don't re-nag on the next hourly pass (mirrors the
  // vendor-chase dedupe). "todo" type so no reconciler/auto-close sweep fights it.
  const key = `cull-${projectId}`;
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return false;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { clientId: true, addressLine: true },
  });
  // Route to the photographer by their first-name slug (same convention as every
  // other photographer-owned task); if we can't resolve one, leave it null so it
  // lands in triage rather than on the wrong person.
  const assignedKey = opts.photographerName ? slugForName(opts.photographerName) : null;

  await prisma.smartTask.create({
    data: {
      taskType: "todo",
      title: `Cull before edit — ${street}: ${rawPhotos} JPGs ≈ ${estFinals} finals vs ~${target} target`.slice(0, 120),
      summary: `This shoot uploaded ${rawPhotos} bracketed JPGs — roughly ${estFinals} finals once AutoHDR blends each ${BRACKET_RATIO}-exposure set, against a ~${target}-photo budget for this home (${overBy > 0 ? `~${overBy} JPGs over` : "over budget"}). Cull the raw folder before it goes to editing: keep the best ONE ${BRACKET_RATIO}-bracket set per room/composition and drop the near-duplicates. Culling here saves editing money and gives the client a tighter gallery.`.slice(0, 500),
      reasonCreated: `Raw upload (${rawPhotos} JPGs) far exceeds the ~${target}-photo budget (× ${BRACKET_RATIO}-bracket ratio) — over-shot`,
      checklist: JSON.stringify([
        "Open the 01-RAW-Photos folder for this shoot",
        `Keep the best single ${BRACKET_RATIO}-bracket set per room / composition`,
        "Delete the near-duplicate sets and machine-gunned extras",
        `Aim to land near ~${target} finals (~${target * BRACKET_RATIO} JPGs at ${BRACKET_RATIO} brackets each)`,
      ]),
      source: "system",
      priority: "HIGH",
      dueAt: new Date(Date.now() + 4 * HOUR),
      projectId,
      clientId: project?.clientId ?? null,
      propertyAddress: opts.title,
      assignedKey,
      dedupeKey: key,
    },
  });

  // Text the photographer — they've left the property, so the bell alone won't
  // reach them. Best-effort; the bridge no-ops if OpenPhone/phone is missing.
  if (opts.photographerId) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "cull",
        // SMS = this title + a link, so the bracket math rides along: the
        // photographer sees files ≈ finals vs target, not a bare file count.
        title: `Cull before edit — ${street}: ${rawPhotos} JPGs ≈ ${estFinals} finals vs ~${target} target`.slice(0, 90),
        href: `/upload/${projectId}`,
        targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${opts.photographerId}`, href: `/upload/${projectId}` }],
        dedupeKey: `cull-notify-${projectId}`,
      });
    } catch { /* SMS/bell is best-effort */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Push handoff when a shoot's raws land (audit crack #19). Flipping to SHOT
// notified no one — the editor queue is pull-only — and a premium reel had no
// "send raws + brief to Luma" task anywhere, so a forgotten dispatch surfaced
// only as an overdue video days later. Called from the upload portal's
// finalize + the Dropbox raw-detection sweep, on the actual transition only.
// Idempotent: the Slack ping is keyed off a timeline marker, the Luma dispatch
// task off its dedupe key. Best-effort by design — callers never let it throw.
// ---------------------------------------------------------------------------
export async function notifyRawsLanded(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      editorManual: true,
      editor: { select: { name: true } },
      client: { select: { socialClient: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
    },
  });
  if (!p) return;
  const street = (p.title || "this job").split(",")[0].trim();

  // Ping ops once per project — if either path (portal finalize / Dropbox sweep)
  // already announced it, don't re-ping. Once per HOLD, that is (Sep 11): a
  // job the office put back to Waiting (setQueueStatus → queueWaiting.ts) was
  // announced off raws that were not really its footage, so when the hold
  // releases (upload-page submit, or the office moving it on) the editors are
  // owed a fresh "Raws in". Only a marker newer than the latest hold line
  // counts as spent, and the bell's dedupe key carries that line's time so
  // the row inserts again. The boundary is the newest of the "Put back to
  // Waiting by" line (setQueueStatus) and, as the fallback, any line carrying
  // "Waiting hold released" (the sweep, finalizeUpload, the office's Ready
  // for editing) — every release path writes its line BEFORE the handoff
  // runs, so a lost hold line still rings once (Sep 11 review). While the
  // hold stands nothing calls this at all: the status sweep runs the handoff
  // for SHOT/EDITING/REVIEW only, and a held job is kept on SCHEDULED/BOOKED.
  const MARKER = `Raws in for ${street}`;
  const lastHold = await prisma.activity.findFirst({
    where: {
      projectId,
      type: "SYSTEM",
      OR: [{ body: { startsWith: "Put back to Waiting by" } }, { body: { contains: "Waiting hold released" } }],
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const already = await prisma.activity.findFirst({
    where: { projectId, type: "SYSTEM", body: { startsWith: MARKER }, ...(lastHold ? { createdAt: { gt: lastHold.createdAt } } : {}) },
    select: { id: true },
  });
  if (!already) {
    // Marker row FIRST (crash-safe idempotence: a re-run after a mid-flight
    // crash must not re-ping) with neutral wording; the concrete outcome is
    // stamped on after we know what channelForEditor actually did — the old
    // hard-coded "notified via Slack" claimed delivery that often never
    // happened (John has no Slack/phone yet; audit #33 honesty residue).
    const marker = await prisma.activity.create({
      data: { projectId, type: "SYSTEM", body: `${MARKER} — announced to the editor bench.` },
    });
    try {
      const { notifyUrgent, notifyInApp } = await import("@/lib/notify");
      const { editorForDeliverable, editorMeta } = await import("@/lib/editors");
      await notifyUrgent(`Raws in for ${street} — ready for editing`, "/editing");
      // Bell mirror: ops + the whole editor bench (raws are pull-work — whoever
      // it routes to sees it in /editing either way) + a PERSON-ADDRESSED row for
      // the routed video editor (editor:<key>) so the notify bridge can DM/text
      // them in Manila. Photos-only jobs route to Kyle (not a bench editor) — the
      // editor:key row is only added for a real video route (kim/john/luma).
      const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
      const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["ADMIN"] }, { roles: ["EDITOR"] }];
      let routedKey: string | null = null;
      if (v) {
        const { editorRouting } = await import("@/lib/settings");
        const { editorKeyForTeamName } = await import("@/lib/editors");
        // The owner's pinned editor gets the DM — same precedence as mintEditTask,
        // so the person who's pinged is the person whose queue the task lands in.
        const pin = pinnedEditorFor(p);
        const key = pin.pinned ? pin.key : editorForDeliverable(v.type, v.label, isMonthlyContentJob(p.deliverables), await editorRouting());
        // Only in-house editors have a reachable channel; Luma (external) has no
        // bell/DM — its dispatch is the Kyle task below.
        if (key === "kim" || key === "john") {
          routedKey = key;
          // Their brief — the one page the EDITOR role can act from.
          targets.push({ roles: ["EDITOR"], userKey: `editor:${key}`, href: `/edit/${projectId}` });
        }
      }
      const { bridged } = await notifyInApp({
        kind: "raws_landed",
        title: `Raws in — ${street}`,
        href: "/editing",
        targets,
        // After a hold the key changes, or the P2002 dedupe would swallow the
        // second, real announcement.
        dedupeKey: lastHold ? `raws-${projectId}-h${lastHold.createdAt.getTime()}` : `raws-${projectId}`,
      });
      // Stamp the truth onto the timeline row.
      let outcome = "— posted to the editor bench (bell) + ops Slack.";
      if (routedKey) {
        const name = editorMeta(routedKey)?.name ?? routedKey;
        const channel = bridged.find((b) => b.userKey === `editor:${routedKey}`)?.channel ?? "none";
        outcome =
          channel === "slack" ? `— ${name} pinged by Slack DM.`
          : channel === "sms" ? `— ${name} texted (SMS).`
          : channel === "relay" ? `— ${name} has no Slack/phone on file; relayed to ops Slack to pass along by hand.`
          : channel === "quiet" ? `— bell posted for ${name}; ping held for their overnight quiet hours.`
          : `— bell posted for ${name}; no direct ping went out.`;
      }
      await prisma.activity.update({ where: { id: marker.id }, data: { body: `${MARKER} ${outcome}` } }).catch(() => {});
    } catch { /* never let a ping break the upload flow */ }
  }

  // Luma dispatch task REMOVED (Aug 18 audit): the Luma engagement ended
  // Aug 14 — premium reels cut in-house (John Mark) through the normal
  // edit_video mint above; a "Send raws to Luma" card on Kyle's board was
  // instructing him to ship footage to a vendor we no longer use.
}

// ---------------------------------------------------------------------------
// Editor-addressed work just landed on a bell that NO login can see (no
// AppUser carries this editorKey) — nudge Jordan once to send that editor
// their invite. Called from the notify bridge on every new editor: row;
// deduped hard: the dedupeKey row (open OR completed) permanently blocks
// re-creation, so once Jordan completes it the nudge never comes back —
// and once the login exists the AppUser check short-circuits first.
// Best-effort: a nudge failure must never break the bell that triggered it.
// ---------------------------------------------------------------------------
export async function ensureEditorLoginNudge(editorKey: string): Promise<void> {
  try {
    const { TEAM_MEMBER_EDITOR_KEYS, editorMeta } = await import("@/lib/editors");
    if (!(TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(editorKey)) return; // vendors have no login
    const hasLogin = await prisma.appUser.count({ where: { editorKey, status: { not: "DISABLED" } } });
    if (hasLogin > 0) return;
    const key = `editor-login-${editorKey}`;
    if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;
    const name = editorMeta(editorKey)?.name ?? editorKey;
    await prisma.smartTask.create({
      data: {
        taskType: "todo",
        title: `Send ${name} their Hub login — need their email`.slice(0, 120),
        summary:
          `Work keeps getting pinged to ${name}'s bell, but no Hub login exists for editor key "${editorKey}" — everything addressed to them is invisible in-app (they're reached only by Slack/SMS/ops relay for now). ` +
          `Invite them on /users with role EDITOR and first name "${name}" so their editor key wires up automatically` +
          (editorKey === "john" ? ", and add John Mark's phone to his Team row so texts can reach him too." : "."),
        reasonCreated: "Editor-addressed notification landed with no editor login to see it",
        source: "system",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 24 * HOUR),
        assignedKey: "jordan",
        dedupeKey: key,
      },
    });
  } catch { /* nudge is best-effort */ }
}

// ---------------------------------------------------------------------------
// The editor's WORK ITEM for a video job. `notifyRawsLanded` pings the bench;
// THIS mints the accountable task that lands in the routed editor's "Do now"
// list on /editing — the one thing that was missing while 4-of-8 videos ran
// overdue with nobody's name on them. VIDEO-ONLY: photos are AutoHDR'd on
// upload (no human), so a photos-only job mints nothing here. Deduped
// `edit-video-<projectId>`; auto-closed by the reconciler when the final video
// lands (see syncOneProjectTasks). Best-effort — callers wrap in try/catch.
//
// dueAt = the video's delivery-due MINUS a 12h QC buffer: the edit has to be in
// the door early enough for Kyle to QC + the client to see it before the SLA
// clock (shootDate + VIDEO SLA) actually expires. If the buffer would put the
// due date in the past (an already-late job), we don't backdate below "now +
// nudge" — an overdue edit is URGENT either way and a wildly-past date just
// reads as noise.
// ---------------------------------------------------------------------------
/** The edit card's due rule, shared with addRoundToEditCard (Sep 8): the
 *  video's SLA minus a 12h QC buffer. Never surface a wildly-backdated due;
 *  clamp an already-late edit to "soon" when the row is BORN. On refresh the
 *  clamp is not rolled forward: doing that every hour meant a late edit read
 *  "due in an hour" forever and the row was rewritten every tick (Sep 8 audit)
 *  — the stamp it already carries stands, and an edit past its SLA reads
 *  late, which is the truth. */
function editDueRule(
  shootDate: Date | null,
  videoType: string,
  opts: { premium: boolean; monthlyContent: boolean },
): { videoDue: Date | null; late: boolean; dueAt: Date } {
  const videoDue = shootDate ? deliveryDueFrom(shootDate, videoType, opts) : null;
  const rawDue = videoDue ? new Date(videoDue.getTime() - 12 * HOUR) : new Date(Date.now() + 4 * HOUR);
  const late = rawDue.getTime() < Date.now();
  return { videoDue, late, dueAt: late ? new Date(Date.now() + HOUR) : rawDue };
}

/** A bounce round on the edit card starts its summary this way — mintEditTask's
 *  hourly refresh leaves such a summary alone (see addRoundToEditCard). */
export const EDIT_ROUND_SUMMARY = /^Round \d+ — /;

export async function mintEditTask(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      shootDate: true,
      addressLine: true,
      createdAt: true,
      dropboxFolder: true, // the RAW link must open THIS job's folder (re-shoot / moved shoot; audit, Sep 8)
      editorManual: true,
      // The office's due / priority for this edit (Sep 13, editOverrides.ts)
      // — they win over the SLA rule below, on the first mint AND every
      // hourly refresh.
      dueOverrideAt: true,
      priorityOverride: true,
      editor: { select: { name: true } },
      client: { select: { name: true, socialClient: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
    },
  });
  if (!p) return;
  // Only video/reel jobs get an editor task — photos are automated.
  const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (!v) return;

  const { videoTier } = await import("@/lib/projectStatus");
  const { editorForDeliverable, editorMeta, editorKeyForTeamName } = await import("@/lib/editors");
  const { dropboxWebUrl, actualFolderPaths } = await import("@/lib/dropboxFolders");

  const monthly = isMonthlyContentJob(p.deliverables);
  const tier = videoTier(p.deliverables); // standard | premium | null
  const isPremium = tier === "premium";
  // null = personal branding: deliberately unrouted (Jordan assigns by hand);
  // edit_video is in TRIAGE_TYPES so the unassigned task sits in "Needs assigning".
  const { editorRouting } = await import("@/lib/settings");
  // A hand-picked editor on the PROJECT (queue-row reassign while the job was
  // still upcoming, before any task existed) beats the routing rules — that's
  // the whole point of editorManual. Falls through to the rules when the pinned
  // person doesn't map to an editor key.
  // pinnedEditorFor: a pin to nobody or to the outside shop is a human pick too,
  // and the rules must not route John or Kim back onto it (review, Sep 7).
  const pin = pinnedEditorFor(p);
  const pinnedKey = pin.key;
  const assignedKey = pin.pinned ? pin.key : editorForDeliverable(v.type, v.label, monthly, await editorRouting()); // per /settings rules; null = manual
  const editorName = assignedKey ? editorMeta(assignedKey)?.name ?? assignedKey : "manual assignment";
  const street = (p.title || "this job").split(",")[0].trim();

  // Video delivery-due = shootDate + the SAME SLA the status card uses, then a
  // 12h QC buffer pulls the EDIT due earlier. No shootDate → no computable SLA,
  // fall back to a short nudge window so the task still surfaces.
  // THE OFFICE'S DUE (Sep 13): when dueOverrideAt is set the card is due at
  // exactly that instant — no QC buffer, no late-clamp — and the summary
  // names that date. The hourly refresh below reads the same column, so it
  // can never roll the office's date back to the SLA.
  const rule = editDueRule(p.shootDate, v.type, { premium: isPremium, monthlyContent: monthly });
  const videoDue = p.dueOverrideAt ?? rule.videoDue;
  const dueAt = p.dueOverrideAt ?? rule.dueAt;
  const late = p.dueOverrideAt ? false : rule.late;

  const rawUrl = dropboxWebUrl(actualFolderPaths(p).rawVideo);
  const briefUrl = `/edit/${projectId}`;
  const tierLabel = isPremium ? "Premium" : "Standard";
  const dueLabel = videoDue
    ? videoDue.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "soon";

  const summary =
    `${tierLabel} reel for ${street}. Raws are in — cut the video. Delivery due ${dueLabel}${p.dueOverrideAt ? " (set by the office)" : " (edit due 12h earlier for QC)"}. ` +
    `RAW footage: ${rawUrl} · Brief: ${briefUrl}`;

  const key = `edit-video-${projectId}`;
  // The office's priority pins the card (Sep 13); otherwise it is priced by
  // the due date as always.
  const priorityFor = (due: Date) => p.priorityOverride ?? computePriority({ dueAt: due, status: "SHOT" });
  const priority = priorityFor(dueAt);
  // Upsert so a re-detected SHOT keeps ONE task and refreshes its route/due,
  // but a COMPLETED one is never resurrected (the reconciler owns re-open).
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing) {
    if (existing.status === "COMPLETED" || existing.status === "CANCELLED") return;
    const refreshedDue = late && existing.dueAt ? existing.dueAt : dueAt;
    const data = {
      // A human's editor choice (reassign / manual queue-add) outlives every
      // automatic refresh — only route when nobody picked by hand. And the
      // auto-router may IMPROVE a route but never STRIP one: a null route
      // (personal branding) must not un-assign work someone already owns.
      // A project-level pin (editorManual) is a human pick too — carry it
      // onto the task as assignedManually so every downstream engine sees it.
      ...(existing.assignedManually || !assignedKey ? {} : { assignedKey, ...(pin.pinned ? { assignedManually: true } : {}) }),
      dueAt: refreshedDue,
      priority: priorityFor(refreshedDue),
      // A bounce writes "Round N — …" here (addRoundToEditCard, Sep 8): that
      // is the editor's current instruction and outlives the hourly refresh
      // until the card closes. Only the plain first-cut summary is rewritten.
      summary: EDIT_ROUND_SUMMARY.test(existing.summary ?? "") ? existing.summary : summary.slice(0, 500),
    };
    // Diff-before-write: an unchanged card is not touched (see changedKeys).
    if (changedKeys(existing, data).length === 0) return;
    await prisma.smartTask.update({ where: { id: existing.id }, data });
    return;
  }
  await prisma.smartTask.create({
    data: {
      taskType: "edit_video",
      title: `Edit — ${street}`.slice(0, 120),
      summary: summary.slice(0, 500),
      reasonCreated: assignedKey
        ? `Raws landed — ${tierLabel} reel routed to ${editorName}`
        : `Raws landed — personal-branding reel, needs an editor assigned`,
      checklist: JSON.stringify([
        "Open the RAW video folder",
        "Read the brief (reel recipe, editing notes, brand)",
        "Cut the video to the brief",
        "Drop the finished cut in 05-Final-Video",
        "Hit “Done — send to review” on your queue",
      ]),
      source: "system",
      priority,
      dueAt,
      assignedKey,
      // The owner picked this editor on the project before the task existed —
      // the task inherits that as a manual assignment, not an auto route. A
      // pin to nobody / the agency is manual too: it is what keeps the hourly
      // sweep from handing the job back to an in-house editor.
      assignedManually: pin.pinned,
      projectId,
      clientId: p.clientId,
      propertyAddress: p.title,
      dedupeKey: key,
    },
  });
}

// ---------------------------------------------------------------------------
// ONE CARD PER CUT (Jordan, Sep 8: "When a cut changes after a card is made,
// make it 1 card."). A Review Room send-back and the Editing Room's
// "Revisions" flip used to mint a SEPARATE revision task beside the editor's
// edit_video card (cut-changes-* / queue-revision-*) — two cards for one cut
// on the editor's board, three with Kyle's QC (38 E Gay St; Sep 8 audit R1).
// Now a bounce is a ROUND on the job's edit_video card: title unchanged,
// summary "Round N — M notes to fix", the notes appended to the description,
// due refreshed by the same SLA−12h rule mintEditTask uses, the card reopened
// if the editor's submit had closed it. The client's own `revision` task
// (their ask — Kyle's and Jordan's record) is a different thing and is never
// touched here. Idempotent: the same round block is never appended twice.
// The card keeps whoever holds it (the assignedManually invariant); a card
// that never existed is minted through mintEditTask so the pin/routing rules
// decide, exactly as for a first cut.
// ---------------------------------------------------------------------------
export async function addRoundToEditCard(
  projectId: string,
  opts: {
    /** the version the editor is being asked for (bounced round + 1) */
    round: number;
    /** the reviewer's notes, one per line (already timestamped where they have one) */
    notes: string[];
    /** where the round came from, e.g. "sent back from the Review Room" */
    reason: string;
  },
): Promise<{ taskId: string; assignedKey: string | null; assignedManually: boolean } | null> {
  const key = `edit-video-${projectId}`;
  let card = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (!card) {
    // A vendor cut / legacy job may never have had a card — mint one the
    // normal way so the pin and routing rules pick the editor.
    await mintEditTask(projectId);
    card = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  }
  if (!card) return null; // no video deliverable → nothing to hang a round on
  const n = opts.notes.length;
  const header = `Round ${opts.round} — ${opts.reason}`;
  const block = [header, ...opts.notes.map((x) => (x.trim().startsWith("•") ? x.trim() : `• ${x.trim()}`))].join("\n");
  let description = card.description ?? "";
  if (!description.includes(block)) description = description ? `${description}\n\n${block}` : block;
  if (description.length > 4000) description = "…" + description.slice(-4000);
  const summary = `Round ${opts.round} — ${n} note${n === 1 ? "" : "s"} to fix (${opts.reason}). The notes are below and on the cut at /edit/${projectId}; fix them and upload the next version.`.slice(0, 500);
  // Due: the same SLA−12h rule as a first cut, off the job's video deliverable
  // — unless the office set the due / priority on the job (Sep 13), which a
  // round refresh must not undo any more than the hourly one may.
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { shootDate: true, dueOverrideAt: true, priorityOverride: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } } },
  });
  const v = p?.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const { videoTier } = await import("@/lib/projectStatus");
  const rule = editDueRule(p?.shootDate ?? null, v?.type ?? "VIDEO", {
    premium: p ? videoTier(p.deliverables) === "premium" : false,
    monthlyContent: p ? isMonthlyContentJob(p.deliverables) : false,
  });
  const dueAt = p?.dueOverrideAt ?? rule.dueAt;
  await prisma.smartTask.update({
    where: { id: card.id },
    data: {
      status: "OPEN",
      completedAt: null,
      summary,
      description,
      dueAt,
      priority: p?.priorityOverride ?? computePriority({ dueAt, status: "SHOT" }),
    },
  });
  return { taskId: card.id, assignedKey: card.assignedKey, assignedManually: card.assignedManually };
}

/** The editor handed in a version of a cut (portal upload or the Final-folder
 *  submit). The edit card answers the way submitCutForReview always has: on a
 *  one-video job, or once every owed cut has been through review, the card is
 *  COMPLETED (scoped to the submitting editor's own key when one is given —
 *  never a co-editor's work item); on a multi-video job that still owes cuts
 *  a "Round N — …" summary is rewritten so the card stops telling the editor
 *  to fix a version they just sent (the queue row already reads Ready for
 *  review — Sep 8 review), and mintEditTask's hourly refresh restores the
 *  plain brief. Before this a portal re-upload left the round summary on the
 *  card until the reconciler's evidence close, up to an hour later. */
export async function editCardCutSubmitted(
  projectId: string,
  opts: { round: number; cutLabel?: string | null; close: boolean; editorKey?: string | null },
): Promise<void> {
  const scope = opts.editorKey ? { assignedKey: opts.editorKey } : {};
  if (opts.close) {
    await prisma.smartTask.updateMany({
      where: { projectId, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] }, ...scope },
      data: { status: "COMPLETED", completedAt: new Date() },
    }).catch(() => {});
    return;
  }
  const card = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] }, ...scope },
    select: { id: true, summary: true },
  });
  if (!card || !EDIT_ROUND_SUMMARY.test(card.summary ?? "")) return;
  await prisma.smartTask.update({
    where: { id: card.id },
    data: {
      summary: `Version ${opts.round}${opts.cutLabel ? ` of ${opts.cutLabel}` : ""} is in the Review Room waiting on the verdict — the rest of the set is still owed. Brief: /edit/${projectId}`.slice(0, 500),
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// ENSURE the editor handoff — idempotent, stage-independent, called by the
// hourly sweep for EVERY job in SHOT/EDITING/REVIEW (and by the photographer
// "done" buttons). Replaces the old transition-only wiring that had two fatal
// holes (July 2026 audit): jobs that skip SHOT (photos deliver fast →
// SCHEDULED→REVIEW) never got an editor task, and button-flipped SHOT never
// re-transitioned so the handoff was skipped. Everything inside is deduped
// (activity marker / dedupeKeys), so hourly re-calls are safe.
//   1. raws in            → notifyRawsLanded (bench ping + Luma dispatch, once)
//   2. video job          → persist Project.editorId for the tracker/reassign
//   3. cut submitted/live → clear any raw-video nudge, done
//   4. raw video missing  → ONE "find the raw video" task (folder mismatch or
//                           forgotten card — either way a human must look)
//   5. otherwise          → mint the edit_video work item; resurrect one that
//                           was falsely auto-completed with no cut anywhere
// ---------------------------------------------------------------------------
export async function ensureEditorHandoff(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      status: true,
      statusEvidence: true,
      editorId: true,
      editorManual: true,
      photographerId: true,
      photographer: { select: { name: true } },
      client: { select: { socialClient: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, notCompletedReason: true, quantity: true } },
      packageName: true,
      videosFilmed: true,
      videosOwedOverride: true, // the office's batch size (Sep 13) — wins below
    },
  });
  if (!p) return;

  let ev: { present?: string[]; dropbox?: { rawPhotos?: number; rawVideo?: number; finalVideo?: number; stale?: boolean } | null } = {};
  try {
    ev = p.statusEvidence ? JSON.parse(p.statusEvidence) : {};
  } catch { /* unreadable evidence → treat as unknown */ }
  const dropbox = ev.dropbox ?? null;
  // Stale counts (carried forward from an earlier read because this pass
  // couldn't reach Dropbox) are true for what they SAW: a stale >0 is real
  // evidence, a stale 0 is not evidence of anything.
  const dropboxFresh = !!dropbox && !dropbox.stale;
  const anyRaw = !!dropbox && (dropbox.rawPhotos ?? 0) + (dropbox.rawVideo ?? 0) > 0;

  // 1. Announce the raws once (marker-idempotent inside notifyRawsLanded).
  if (anyRaw) await notifyRawsLanded(projectId);

  const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (!v) return; // photos-only → AutoHDR, no human editor

  // Every video deliverable marked "couldn't complete + why" on the wrap-up →
  // the footage is NOT owed. Chasing the photographer ("the video clock is
  // running") for a reel the agent canceled on site punishes honesty (review
  // HIGH). Instead: one Admin decision task — cancel the item (fix the order
  // in Aryeo so billing + expectations follow) or book the re-shoot.
  const videoDeliverables = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (videoDeliverables.length > 0 && videoDeliverables.every((d) => d.notCompletedReason)) {
    const street = (p.title || "this job").split(",")[0].trim();
    const reason = videoDeliverables.map((d) => d.notCompletedReason).filter(Boolean).join(" · ");
    await prisma.smartTask.upsert({
      where: { dedupeKey: dedupe([projectId, "video-not-completable"]) },
      create: {
        taskType: "internal_instruction",
        title: `Video marked not completable — ${street}`.slice(0, 120),
        summary: `The photographer marked the video/reel on ${street} as “couldn't complete”: ${reason.slice(0, 300)}. Decide: cancel the item in Aryeo (so the order, billing, and delivery expectations match reality) or book a re-shoot.`.slice(0, 500),
        reasonCreated: "Photographer marked the video not completable on the upload wrap-up.",
        source: "system",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 24 * HOUR),
        assignedKey: "kyle",
        projectId,
        clientId: p.clientId,
        propertyAddress: p.title,
        dedupeKey: dedupe([projectId, "video-not-completable"]),
      },
      update: {}, // one decision task per job — never re-open or overwrite a human's handling
    });
    // Clear any already-minted raw-video chase; skip minting the edit task —
    // there is nothing to edit until a human decides.
    await prisma.smartTask
      .updateMany({
        where: { dedupeKey: `raw-video-missing-${projectId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "CANCELLED", completedAt: new Date() },
      })
      .catch(() => {});
    return;
  }

  // A human hand-picked this job's editor (owner reassign / manual queue-add):
  // don't overwrite their routing, and don't chase raw video — the owner just
  // looked at the job (old footage / externally-held files are expected there).
  const manualTask = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "edit_video", assignedManually: true, status: { notIn: ["CANCELLED"] } },
    select: { id: true },
  });

  // 2. Persist the routed editor for the tracker + one-click reassign (in-house
  // only). editorManual = the owner picked this job's editor by hand (queue-row
  // reassign) — never auto-revert their choice, same deal as photographerManual.
  if (!manualTask && !p.editorManual) {
    try {
      const { editorForDeliverable, editorTeamMemberId } = await import("@/lib/editors");
      const { editorRouting: er } = await import("@/lib/settings");
      const key = editorForDeliverable(v.type, v.label, isMonthlyContentJob(p.deliverables), await er());
      const tmId = await editorTeamMemberId(key);
      if (tmId && p.editorId !== tmId) {
        await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId } });
      }
    } catch { /* editor link is best-effort */ }
  }

  const NUDGE_KEY = `raw-video-missing-${projectId}`;
  const clearNudge = () =>
    prisma.smartTask.updateMany({
      where: { dedupeKey: NUDGE_KEY, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

  // 3. AUTO-SUPPLY THE REVIEW ROOM (Jordan Aug 25: keep the room, make it
  // real). Every video file in the Dropbox Final folder becomes its own
  // PENDING ReviewSubmission with a playable link — one row per (file, round),
  // deduped by path inside syncFinalCutsToReview, so calling this every hour
  // is safe and a monthly batch's videos 2..N enter review as they land. The
  // old version minted ONE blank placeholder per project and never looked
  // again (audit HIGH: no playable video on any submission).
  // (Discovery of finished cuts into the Review Room lives in the status
  // sweep — discoverCutsForReview — because it must also run for REVISION
  // jobs, which this handoff deliberately skips.)
  const videoPresent = (ev.present ?? []).includes("Video") || (dropbox?.finalVideo ?? 0) > 0;
  const submitted = await prisma.reviewSubmission.count({ where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } } });
  // A cut exists (submission) or the video is verifiably live → nothing to
  // chase. But a MONTHLY job is a BATCH: the first cut landing must not close
  // the editor's work item while videos 2..N are still owed — without it the
  // editor has no task to submit against (submitCutForReview scopes to their
  // open task) and the rest of the set has no owner (audit).
  if (submitted > 0 || videoPresent) {
    await clearNudge();
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    if (!monthly) return;
    const { monthlyVideoQuota } = await import("@/lib/pipeline");
    const { submittedDistinctCuts } = await import("@/lib/reviewCuts");
    const quantityOwed = p.deliverables
      .filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
      .reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
    // The office's number wins over the order row, the photographer's count
    // and the plan quota alike (Sep 13, editOverrides.ts).
    const owed = p.videosOwedOverride ?? Math.max(quantityOwed, p.videosFilmed ?? monthlyVideoQuota([p.packageName, ...p.deliverables.map((d) => d.label)]));
    // SUBMITTED files, not approved — the editor's item closes when the set is
    // in (submitCutForReview's closeEdit), and gating on approvals here would
    // keep re-minting between "all in" and "all approved".
    if ((await submittedDistinctCuts(projectId)) >= owed) return;
    if (p.status === "DELIVERED") return;
    await mintEditTask(projectId); // creates if absent, refreshes if open, never reopens a completed one
    return;
  }

  // 4. Raw video KNOWN missing (folders readable, zero video files) — the edit
  // can't start. Either the photographer forgot the video card or the files
  // live in a differently-named folder the hub can't see. ONE deduped task so
  // a human finds out TODAY instead of when the video runs overdue; the
  // photographer also gets a bell+SMS pointing at their upload page.
  // Skipped for manually-queued jobs: no footage in the folder is EXPECTED for
  // old-footage / externally-shot work, and the wrong "upload your video" text
  // would chase a photographer who owes nothing.
  // A FRESH zero only — a stale zero carried from the night before the shoot
  // must not chase a photographer whose footage landed since.
  if (!manualTask && dropbox && dropboxFresh && (dropbox.rawVideo ?? 0) === 0) {
    const street = (p.title || "this job").split(",")[0].trim();
    const first = (p.photographer?.name || "the photographer").split(/\s+/)[0];
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: NUDGE_KEY } });
    if (!existing) {
      const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
      await prisma.smartTask.create({
        data: {
          taskType: "todo", // swept by nothing; ensureEditorHandoff clears it when footage appears
          title: `Find the raw video — ${street}`.slice(0, 120),
          summary: `A video is ordered for ${street} but the RAW-Video folder shows no files. Either ${first} hasn't uploaded the footage yet, or it's sitting in a folder the hub isn't watching (naming mismatch). The edit can't start until this is found.`,
          description: `Check the Dropbox listing folder for ${street}. If the footage is there under a different name, move it into 02-RAW-Video. If it isn't, chase ${first} — the video clock is running.`,
          reasonCreated: "Video ordered, raw footage not found",
          checklist: JSON.stringify([
            "Open the listing's Dropbox folder",
            `If missing: text ${first} for the footage`,
            "Confirm files land in 02-RAW-Video",
          ]),
          source: "system",
          priority: "HIGH",
          dueAt: new Date(Date.now() + 4 * HOUR),
          assignedKey: "kyle",
          projectId,
          clientId: p.clientId,
          propertyAddress: p.title,
          ownerId: kyle?.id ?? null,
          dedupeKey: NUDGE_KEY,
        },
      });
      try {
        const { notifyInApp } = await import("@/lib/notify");
        const targets = await creativeAlertTargets(p.photographerId, `/upload/${projectId}`);
        await notifyInApp({
          kind: "raws_missing",
          title: `Video files needed — ${street}`,
          href: `/projects/${projectId}`,
          targets,
          dedupeKey: `raw-video-missing-bell-${projectId}`,
        });
      } catch { /* nudge bell is best-effort */ }
    }
    return; // hold the edit task until footage is findable
  }

  // Unknown read (Dropbox unreadable, or a carried-forward zero for video):
  // neither clear the chase NOR hand off. Completing the chase on "couldn't
  // look" silenced it forever (a completed dedupeKey is never re-minted), and
  // minting the edit task off stale photo counts handed the editor footage
  // the hub could not confirm. Mirrors the fresh-zero hold above.
  if (!dropbox || (dropbox.stale && (dropbox.rawVideo ?? 0) === 0)) return;
  // Footage is in → clear the nudge and make sure the editor's accountable
  // work item exists.
  await clearNudge();
  if (!anyRaw) return; // nothing detected at all → nothing to hand off yet

  await mintEditTask(projectId); // creates if absent; refreshes if open; skips completed

  // 5. Resurrect a falsely-completed work item: task COMPLETED but no cut
  // anywhere (no submission, no video evidence — checked above) and no open
  // revision carrying the work instead. This is how the 5-Nathaniel-Ct class of
  // silent losses self-heals: the sweep notices the video is still owed and
  // puts the job back on the editor's Do-now.
  try {
    const t = await prisma.smartTask.findUnique({
      where: { dedupeKey: `edit-video-${projectId}` },
      select: { id: true, status: true },
    });
    if (t?.status === "COMPLETED") {
      const openRevision = await prisma.smartTask.count({
        where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      });
      if (openRevision === 0) {
        await prisma.smartTask.update({
          where: { id: t.id },
          data: { status: "OPEN", completedAt: null },
        });
        await prisma.activity.create({
          data: {
            projectId,
            type: "SYSTEM",
            body: "Edit task reopened — the video is still owed but its work item had been closed with no cut on file.",
          },
        });
      }
    }
  } catch { /* resurrection is best-effort */ }
}

// ---------------------------------------------------------------------------
// RAWS MISSING watchdog — the "shoot happened, nothing ever landed" alarm the
// system never had (877 S York sat SCHEDULED for 11 days with nobody told —
// July 2026 audit). Called by the sweep for BOOKED/SCHEDULED jobs whose shoot
// is in the past. Mints ONE deduped chase task on Kyle + bell/SMS to the
// photographer once the raws are 18+ hours late; self-clears when files land.
// ---------------------------------------------------------------------------
// 18h fired on most shoots (89 bells in 30 days — noise, audit Aug 25); a
// real miss is still loud a day later.
const RAWS_MISSING_AFTER_MS = 30 * HOUR;

// Who hears about a creative's field problem, beyond the person themselves.
// ADMIN is a role broadcast (Kyle) so it survives a rename; the Creative
// Manager is addressed personally because they need it on their phone, and the
// roles list is deliberately broad so the row stays visible on the day their
// AppUser role changes (a tm: row is invisible unless its audience contains the
// recipient's CURRENT role — a promotion would otherwise silently mute them).
async function creativeAlertTargets(
  shooterId: string | null | undefined,
  href: string,
): Promise<import("@/lib/notify").NotifyTarget[]> {
  const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
  const manager = await prisma.teamMember
    .findFirst({ where: { creativeManager: true, active: true }, select: { id: true } })
    .catch(() => null);
  if (manager && manager.id !== shooterId) {
    targets.push({ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${manager.id}`, href });
  }
  if (shooterId) targets.push({ roles: ["PHOTOGRAPHER"], userKey: `tm:${shooterId}`, href });
  return targets;
}

export async function reconcileRawsMissing(
  projectId: string,
  sig: { rawsKnownEmpty: boolean; anyAryeoMedia: boolean; dropboxReadable?: boolean },
): Promise<void> {
  const key = `raws-missing-${projectId}`;
  // Unknown is not proof of absence — and it is not proof of PRESENCE either.
  // A pass that couldn't read Dropbox neither mints nor completes the
  // watchdog (a completed one is never re-minted: one nag per project).
  if (sig.dropboxReadable === false && !sig.anyAryeoMedia) return;
  // Raws showed up (or Aryeo already has media): close any open watchdog.
  if (!sig.rawsKnownEmpty || sig.anyAryeoMedia) {
    await prisma.smartTask.updateMany({
      where: { dedupeKey: key, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return;
  }
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return; // one nag per project

  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      shootDate: true,
      photographerId: true,
      photographer: { select: { name: true } },
      appointments: { select: { status: true, startAt: true } },
    },
  });
  if (!p) return;

  // When did the shoot actually happen? Latest PAST non-canceled appointment
  // leg, else the (past) shootDate — same semantics as the sweep's shootHappened.
  const now = Date.now();
  const legs = p.appointments
    .filter((a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt && a.startAt.getTime() < now)
    .map((a) => a.startAt!.getTime());
  if (p.shootDate && p.shootDate.getTime() < now) legs.push(p.shootDate.getTime());
  const shotAt = legs.length ? Math.max(...legs) : null;
  if (!shotAt || now - shotAt < RAWS_MISSING_AFTER_MS) return; // give them the evening

  const street = (p.title || "this job").split(",")[0].trim();
  const first = (p.photographer?.name || "the photographer").split(/\s+/)[0];
  const hoursLate = Math.round((now - shotAt) / HOUR);
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "todo", // swept by nothing; this watchdog clears it itself when raws land
      title: `No raws uploaded — ${street}`.slice(0, 120),
      summary: `${first} shot ${street} ~${hoursLate}h ago and the raw folders are still empty. Nothing downstream (editing, QC, delivery) can start until the files land — chase it now.`,
      description: `If ${first} uploaded somewhere else, move the files into the listing's 01-RAW-Photos / 02-RAW-Video folders. If not, get an ETA. The delivery clock started at the shoot.`,
      reasonCreated: "Shoot happened, no raw files ever landed",
      checklist: JSON.stringify([
        `Text ${first} — where are the files?`,
        "Check the Dropbox folder naming matches the listing",
        "Confirm the raws land",
      ]),
      source: "system",
      priority: "HIGH",
      dueAt: new Date(now + 4 * HOUR),
      assignedKey: "kyle",
      projectId,
      clientId: p.clientId,
      propertyAddress: p.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    },
  });
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const targets = await creativeAlertTargets(p.photographerId, `/upload/${projectId}`);
    await notifyInApp({
      kind: "raws_missing",
      title: `Upload needed — ${street}`,
      href: `/projects/${projectId}`,
      targets,
      dedupeKey: `raws-missing-bell-${projectId}`,
    });
  } catch { /* watchdog bell is best-effort */ }
}

// Generate (idempotently) the expected tasks for every ACTIVE project.
export async function generateTasksForActiveProjects(): Promise<{ created: number; projects: number }> {
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const { confirmationMessage } = await import("@/lib/delivery");
  // The two legacy retirement sweeps that lived here (per-deliverable "QA
  // <type>" media_qa rows, "Confirmation call" appointment_prep rows) matched
  // nothing for months — 0 open rows of either, every hour (Sep 8 audit U4) —
  // and are gone. What runs in their place is the janitor for tasks stranded
  // on jobs this reconciler never visits. Best-effort: housekeeping must never
  // stop the mint below.
  try {
    await closeTasksOnInactiveProjects();
  } catch { /* janitor is best-effort */ }
  const projects = await prisma.project.findMany({
    // An order that 404s in Aryeo is a human decision, not a task mint.
    where: { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] }, aryeoMissingAt: null },
    include: {
      // productTitle + the live line items: how the SLA engine sees a same-day
      // rush add-on (sameDayAddOns explains why the row alone can't say).
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, productTitle: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      // segment drives the VIP extra-pass ticks on the guided QC checklist.
      client: { select: { id: true, name: true, socialClient: true, segment: true } },
      photographer: { select: { name: true } },
      // appointment legs: shootStillAhead tells a return visit from a job
      // that only READS shot (same-address raws) before its shoot.
      appointments: { select: { startAt: true, status: true } },
    },
  });

  let created = 0;
  for (const p of projects) created += await syncOneProjectTasks(p, kyle, confirmationMessage);
  return { created, projects: projects.length };
}

// REVISION is included so a QC card reopened by reflectRevisionInQc keeps
// getting evidence merges + the moot sweeps keep running — a REVISION-stage
// job used to be invisible to this reconciler and its tasks froze until a
// human resolved the revision (audit #17).
const ACTIVE_TASK_STATUSES = ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"];

// Regenerate/reconcile a SINGLE project's tasks right now. The Aryeo webhook
// calls this so a new order / delivery / appointment change produces or clears
// its tasks at event time instead of waiting up to an hour for the cron.
export async function generateTasksForProject(projectId: string): Promise<number> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      // Same shape as generateTasks above — the same-day rush needs both.
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, productTitle: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      // segment drives the VIP extra-pass ticks on the guided QC checklist.
      client: { select: { id: true, name: true, socialClient: true, segment: true } },
      photographer: { select: { name: true } },
      appointments: { select: { startAt: true, status: true } },
    },
  });
  if (!p || !ACTIVE_TASK_STATUSES.includes(p.status)) return 0;
  if (p.aryeoMissingAt) return 0; // order gone from Aryeo — a human decides, nothing gets minted
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const { confirmationMessage } = await import("@/lib/delivery");
  return syncOneProjectTasks(p, kyle, confirmationMessage);
}

type TaskProject = {
  id: string; status: string; title: string; shootDate: Date | null; statusEvidence: string | null;
  squareFeet: number | null; photoTarget: number | null;
  // Shoot-debrief answers (the queries use `include`, so these ride along) —
  // dispatched onto the QC card so Kyle verifies against the photographer's
  // own notes instead of guessing (Jordan, Sep 1).
  removalNotes: string | null; shotOrderNotes: string | null;
  cullingConfirmedAt: Date | null; debriefSubmittedAt: Date | null; videoInstructions: string | null;
  deliverables: { type: string; label: string | null; productTitle?: string | null }[];
  /** live Aryeo line items (isCanceled filtered at the query) — same-day rush */
  orderItems?: { title: string }[];
  client: { id: string; name: string | null; socialClient: boolean; segment: string | null };
  photographer: { name: string } | null;
  /** Aryeo appointment legs (both queries include them) — see shootStillAhead */
  appointments?: { startAt: Date | null; status: string | null }[];
  /** title fallbacks for coordinate-only orders (scalars ride along with `include`) */
  addressLine?: string | null;
  city?: string | null;
  /** the office's batch size / the photographer's count (Sep 13, editOverrides) — ride along with `include` */
  videosOwedOverride?: number | null;
  videosFilmed?: number | null;
};

// Dedupe-key families minted OUTSIDE this reconciler (webhooks/integrations).
// Their keys aren't sha1 spec hashes, so they never appear in expectedKeys — the
// reconciler used to read that as "no longer expected" and auto-complete them
// within the hour (the old Frame.io "Review finals" task self-destructed on first
// use — audit crack #20). Externally-minted tasks are closed by their OWN flows.
// "frameio-review-" stays so legacy rows from the retired integration (removed
// Sep 1 2026) are never auto-closed by this reconciler.
const EXTERNAL_KEY_PREFIXES = ["frameio-review-", "scripting-script-", "scripting-client-", "luma-", "slack-", "lead-", "edit-video-"];

// Reconcile one active project's expected tasks (create missing, refresh QC /
// delivery, retire what's no longer expected). Returns how many it created.
async function syncOneProjectTasks(
  p: TaskProject,
  kyle: { id: string } | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  confirmationMessage: (...args: any[]) => string,
): Promise<number> {
  let created = 0;
  // edit_video is externally-minted (mintEditTask, off the →SHOT hook), so it's
  // NOT in `specs` and the spec-based sweep never touches it (edit-video- is in
  // EXTERNAL_KEY_PREFIXES). Close it here on EVIDENCE the cut landed — the final
  // video is on Aryeo/Dropbox (present.Video / dropbox.finalVideo), the editor
  // submitted it through the Review Room, or the job is DELIVERED. Status REVIEW
  // alone is deliberately NOT evidence: the status engine derives REVIEW for
  // PARTIAL deliveries too (photos live, video explicitly missing — the NORMAL
  // staged flow), and using it here auto-completed the editor's only work item
  // within the hour of photo delivery while the reel was still unmade (July
  // 2026 audit, proven live on 5 Nathaniel Ct). Mirrors how media_qa auto-closes
  // on positive evidence: an editor's finished cut shouldn't sit open forever.
  // REVISION deliberately does NOT close it — a bounced reel is back on the
  // editor's plate. Best-effort; wrapped so a stray parse can't break the sync.
  // During REVISION every "landed" signal (present.Video, dropbox.finalVideo,
  // a past ReviewSubmission) describes the PREVIOUS, bounced cut — closing the
  // editor's work item off that evidence would erase the redo. The comment
  // above always declared this; now that REVISION projects actually reach this
  // reconciler, enforce it by skipping the evidence-close entirely.
  if (p.status !== "REVISION") try {
    let finalVideoLanded = p.status === "DELIVERED";
    if (!finalVideoLanded && p.statusEvidence) {
      const ev = JSON.parse(p.statusEvidence) as {
        present?: string[];
        dropbox?: { finalVideo?: number } | null;
      };
      finalVideoLanded =
        (ev.present ?? []).includes("Video") || (ev.dropbox?.finalVideo ?? 0) > 0;
    }
    // The editor said "done" through the Review Room — the cut is with the owner
    // (any round, any verdict state) and their work item was already completed
    // by submitCutForReview; treat as landed so nothing here fights that flow.
    if (!finalVideoLanded) {
      // Rows still uploading (or whose upload died) are not cuts.
      finalVideoLanded =
        (await prisma.reviewSubmission.count({ where: { projectId: p.id, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } } })) > 0;
    }
    // MULTI-VIDEO packages (monthly personal branding: 2–5 videos) submit one
    // video at a time, and submitCutForReview deliberately keeps the edit task
    // OPEN until the whole set is in. "A submission exists / a file is in the
    // Final folder" is NOT done for those jobs — require every owed video to
    // have been through review before this evidence-close may fire.
    if (finalVideoLanded) {
      const vids = await prisma.deliverable.findMany({
        where: { projectId: p.id, type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null },
        select: { quantity: true, label: true, type: true },
      });
      // MONTHLY jobs deliver an open-ended SET (2–5 videos, stored quantity is
      // usually 1 — audit) — evidence can never prove the set is done, so the
      // close is owned by the submit flow / delivery, never by this sweep.
      if (isMonthlyContentJob(vids)) {
        finalVideoLanded = p.status === "DELIVERED";
      } else {
        // The office's number first (Sep 13, editOverrides.effectiveVideosOwed):
        // "videos owed 2" on a one-reel listing keeps the card open until the
        // second cut is in, exactly as the queue cell and the cut slots say.
        const { effectiveVideosOwed } = await import("@/lib/editOverrides");
        const videosOwed = effectiveVideosOwed(
          { videosOwedOverride: p.videosOwedOverride ?? null, videosFilmed: p.videosFilmed ?? null },
          vids,
        );
        if (videosOwed > 1) {
          // Distinct CUTS (deliverable × slot for uploads, file for legacy
          // folder rows) — uploaded cuts carry no Dropbox path.
          const { submittedDistinctCuts } = await import("@/lib/reviewCuts");
          if ((await submittedDistinctCuts(p.id)) < videosOwed) finalVideoLanded = false;
        }
      }
    }
    if (finalVideoLanded) {
      await prisma.smartTask.updateMany({
        where: {
          projectId: p.id,
          taskType: "edit_video",
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          // A manually-(re)opened edit is NEW work a human just asked for — the
          // "landed" evidence here is the PREVIOUS cut (old finalVideo file, a
          // past ReviewSubmission, a live listing video), so it must not close
          // it. Manual edits close only via the editor's "send to review".
          assignedManually: false,
        },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    }
  } catch { /* evidence-close is best-effort */ }
  // One draft per project — the confirmation text is (re)rendered at creation,
  // on reopen, and on a due-date drift, always from the same current fields.
  const draftConfirmation = () =>
    confirmationMessage({ title: p.title, shootDate: p.shootDate, client: { name: p.client.name ?? "" }, photographer: p.photographer, deliverables: p.deliverables });
  const { turnaroundRules } = await import("@/lib/settings");
  const specs = specsForProject({
    turnarounds: await turnaroundRules(),
    status: p.status,
    title: p.title,
    shootDate: p.shootDate,
    deliverables: p.deliverables,
    orderItems: p.orderItems,
    statusEvidence: p.statusEvidence,
    // PROJECT-level: a listing shoot for a social-plan client is NOT monthly
    // content — the client flag alone gave listing jobs the 7–10-day QC copy
    // and SLA (caught live July 2026).
    monthlyContent: isMonthlyContentJob(p.deliverables),
    squareFeet: p.squareFeet,
    photoTarget: p.photoTarget,
    clientSegment: p.client.segment,
    // Shoot-debrief dispatch — WITHOUT these the whole feature is dead code
    // (review, Sep 1: optional params + an explicit literal = silent no-op).
    removalNotes: p.removalNotes,
    shotOrderNotes: p.shotOrderNotes,
    debriefSubmittedAt: p.debriefSubmittedAt,
    videoInstructions: p.videoInstructions,
    appointments: p.appointments,
    clientName: p.client.name,
    addressLine: p.addressLine,
    city: p.city,
  });
  // The vendor's piece arrived (the status sweep just refreshed this
  // evidence, and `tasks` runs right after it) → its chase is done.
  try {
    await closeVendorChasesForPresent(p.id, parseEvidence(p.statusEvidence)?.present ?? []);
  } catch { /* chase close is best-effort */ }
  // The shoot is still ahead but the job already reads shot (same-address
  // raws): park the QC card rather than let the "no longer expected" sweep
  // below COMPLETE it — nothing was QC'd, and a COMPLETED card would sit in
  // the Done ledger as a QC pass for a day. CANCELLED + SHOOT_NOT_YET, and
  // the media_qa branch below reopens it the first pass after the shoot.
  // REVISION keeps its carve-out: a re-shoot raised mid-revision must not
  // lose the reflectRevisionInQc card.
  if (p.status !== "REVISION" && shootStillAhead(p.shootDate, p.appointments)) {
    await prisma.smartTask.updateMany({
      where: { projectId: p.id, taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: {
        status: "CANCELLED",
        sourceDetail: SHOOT_NOT_YET,
        summary: "Parked — the shoot is still ahead. This comes back on its own once the shoot has happened.",
      },
    });
  }
  // Reconcile: close any open production task that's no longer expected. This
  // retires "QA photos" / "Deliver gallery" once the photos are live (even
  // while a reel is still rendering), and clears a stale "finish delivery"
  // when its missing items showed up or fell back inside their window.
  const expectedKeys = new Set(specs.map((s) => dedupe([p.id, s.taskType, s.deliverableType])));
  await prisma.smartTask.updateMany({
    where: {
      projectId: p.id,
      // During REVISION the QC card is a reflectRevisionInQc-reopened row whose
      // spec may not be emitted at all (everything reads "live" — the OLD cut
      // is what's live, that's why it's in revision). "No longer expected" must
      // never complete media_qa mid-revision; its closes are the human re-QC
      // tick or resolveRevision. delivery/finish_delivery still retire (that's
      // how frozen legacy cards on REVISION jobs finally clear).
      taskType: { in: p.status === "REVISION" ? ["delivery", "finish_delivery"] : ["media_qa", "delivery", "finish_delivery"] },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      NOT: [
        { dedupeKey: { in: [...expectedKeys] } },
        // Never auto-close externally-minted tasks (Script Studio/Slack handoffs etc.)
        // just because this reconciler didn't expect their key.
        ...EXTERNAL_KEY_PREFIXES.map((pfx) => ({ dedupeKey: { startsWith: pfx } })),
      ],
    },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  // A confirmation whose spec vanished (shoot day passed / job moved past
  // SCHEDULED) was never sent through the hub — it's MOOT, not done. Stamp it
  // CANCELLED so the Done ledger stops crediting never-sent confirmations as
  // sent (audit: ~40% of "completed" confirmations were these). The
  // follow-the-shoot reopen below already handles CANCELLED → OPEN when the
  // spec re-emits with a fresh shoot date.
  await prisma.smartTask.updateMany({
    where: {
      projectId: p.id,
      taskType: "confirmation_text",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      NOT: [
        { dedupeKey: { in: [...expectedKeys] } },
        ...EXTERNAL_KEY_PREFIXES.map((pfx) => ({ dedupeKey: { startsWith: pfx } })),
      ],
    },
    data: { status: "CANCELLED" },
  });
  for (const s of specs) {
    const key = dedupe([p.id, s.taskType, s.deliverableType]);
    const exists = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
    if (exists) {
      // The confirmation follows the shoot even out of a terminal state. Its
      // dedupe key is deliberately date-less (changing it would re-mint
      // duplicates for every already-confirmed project), so a fresh task can
      // never appear — the existing row must be REOPENED instead:
      //   · COMPLETED: the client confirmed the OLD time — void once the spec's
      //     dueAt (shoot - 1 day) drifts >= 1h, or when the confirmation was
      //     completed while the job had NO shoot date and a real one landed.
      //     The 1h guard keeps bulk-auto-closed tasks from flapping when
      //     nothing actually moved.
      //   · CANCELLED: the dead-slot sweep in aryeo.ts cancels it when a shoot
      //     is postponed; the spec re-emitting WITH a dueAt means the shoot is
      //     back on the books.
      // No ping-pong with the auto-close sweep above: this reopen only fires
      // while the spec IS emitted (key in expectedKeys), the sweep only when it
      // is NOT — mutually exclusive by construction. Nulling completedAt
      // mirrors the media_qa reopen, so /history stops counting it as a sent
      // confirmation until it's re-sent. Every OTHER task type keeps its
      // terminal states terminal.
      if (s.taskType === "confirmation_text" && (exists.status === "CANCELLED" || exists.status === "COMPLETED")) {
        if (s.dueAt) {
          const rebooked = exists.status === "CANCELLED";
          const drifted = !exists.dueAt || Math.abs(s.dueAt.getTime() - exists.dueAt.getTime()) >= HOUR;
          if (rebooked || drifted) {
            await prisma.smartTask.update({
              where: { id: exists.id },
              data: {
                status: "OPEN",
                completedAt: null,
                dueAt: s.dueAt,
                priority: computePriority({ dueAt: s.dueAt, shootDate: p.shootDate, status: p.status }),
                description: draftConfirmation(),
                // Re-assert the spec's summary. A reopened row kept whatever
                // the last close wrote there — including the sweep's "could not
                // be confirmed" doubt note (SEND_UNVERIFIED) — so a re-booked
                // shoot showed a stale warning instead of the SOP.
                summary: s.summary ?? null, // `undefined` would be a Prisma no-op — the point is to CLEAR a stale note
                sourceDetail: null,
                reasonCreated: rebooked
                  ? exists.sourceDetail === JOB_ON_HOLD
                    ? "Job came off hold — confirm the shoot time with the client"
                    : "Shoot was re-booked after being postponed — confirm the new time with the client"
                  : "Shoot was rescheduled after the last confirmation — confirm the new time with the client",
              },
            });
          }
        }
        continue;
      }
      // A card THIS reconciler parked (job on hold / shoot still ahead) comes
      // back when its spec does; every other cancel stays terminal.
      const parked = exists.status === "CANCELLED" && REOPENABLE_CANCELS.has(exists.sourceDetail ?? "");
      if (exists.status === "CANCELLED" && !parked) continue;
      // For the consolidated QC task, re-sync its checklist each run: an item
      // is checked if it's live on Aryeo OR Kyle already ticked it manually
      // (manual checks are preserved). If every item ends up checked, the task
      // auto-completes. Also keep the due date fresh. The checklist is no longer
      // an interactive UI — it drives this auto-close + the read-only status row.
      if (s.taskType === "media_qa") {
        const prev = parseChecklist(exists.checklist);
        const prevDone = new Map(prev.map((i) => [i.label, i.done]));
        const specLabels = new Set(s.checklist.map((i) => i.label));
        // Keep any item the SPEC didn't produce (e.g. a revision-injected
        // "Re-QC after revision" / "QC Reel (revision)" from reflectRevisionInQc)
        // with its done state — otherwise it'd be silently dropped and the task
        // could auto-complete while a re-QC was still pending.
        // Debrief lines are exempt from extras-preservation: their labels are
        // stable constants that self-clear via spec state, so one absent from
        // the spec is retired ON PURPOSE (e.g. a video deliverable removed) —
        // preserving it unchecked would block auto-close forever (review).
        // Auto-evidence rows ("QC Video") for a category the spec no longer
        // emits — the item was removed from the order — are dropped, not
        // preserved: kept unticked they would block auto-close forever
        // (review). Human sub-items and "Re-QC after revision" survive.
        const extras = prev.filter((i) => !specLabels.has(i.label) && !DEBRIEF_QC_LABELS.has(i.label) && !/^QC\s/.test(i.label));
        const merged: ChecklistItem[] = [
          ...s.checklist.map((i) => ({ label: i.label, done: i.done || (prevDone.get(i.label) ?? false) })),
          ...extras,
        ];
        // Sep 8: the evidence rows (+ the two self-clearing debrief rows) are
        // the gate; every human tick is optional — see qcGateComplete.
        const allDone = qcGateComplete(merged);
        // A COMPLETED QC whose evidence still shows unchecked work on a live
        // SHOT/EDITING/REVIEW job was almost certainly auto-closed by this
        // reconciler during a transient signal blip (a demoted-then-healed job) —
        // REOPEN it: auto-close requires positive evidence, and a completed
        // dedupe key is never re-minted, so the work would vanish forever
        // (audit crack #2). If everything IS live, leave the completion alone.
        if (exists.status === "COMPLETED" && allDone) continue;
        // A HUMAN close with a reason ("floor plan removed from the order")
        // is not a blip — leave it closed, boxes or no boxes.
        if (exists.status === "COMPLETED" && exists.sourceDetail === CLOSED_BY_HAND) continue;
        // During REVISION this reconciler must never flip the card COMPLETED —
        // every "done" signal describes the PREVIOUS accepted cut (the old
        // media is what's live on Aryeo), so a stale ticked re-QC row would
        // close the gate with zero human re-look. Mid-revision closes belong
        // to the human tick path (toggleTaskChecklistItem) or resolveRevision
        // ONLY. It also keeps reflectRevisionInQc's framing (HIGH, dueAt=raise
        // time, revision copy) instead of the spec's shoot-anchored values.
        const inRevision = p.status === "REVISION";
        // A real completion this run: everything (incl. Kyle's failure-mode ticks)
        // is done and the task wasn't already closed. Log the QC pass for the
        // owner dial. Best-effort + deduped so the interactive-toggle path (which
        // also logs) can't double-write. Do it BEFORE the status flip so a throw
        // can't leave a completed task with no record — recordQcCompletion swallows.
        const nowCompleting = allDone && !inRevision && exists.status !== "COMPLETED";
        const data = {
          checklist: serializeChecklist(merged),
          ...(s.summary && !inRevision ? { summary: s.summary } : {}),
          // Post-shoot QC: priced by its turnaround due date, NOT shoot proximity
          // (a 7–10 day monthly job shouldn't read URGENT because it shot today).
          ...(s.dueAt && !inRevision ? { dueAt: s.dueAt, priority: computePriority({ dueAt: s.dueAt, status: p.status }) } : {}),
          ...(allDone && !inRevision
            ? { status: "COMPLETED", completedAt: new Date(), ...(parked ? { sourceDetail: null } : {}) }
            : exists.status === "COMPLETED" || parked
              ? {
                  status: "OPEN",
                  completedAt: null,
                  // The park stamp is spent the moment the card is back.
                  ...(parked ? { sourceDetail: null } : {}),
                  // Reopening a delivered-era card mid-revision (the manual
                  // prior-cut rail flips a job to REVISION without going
                  // through reflectRevisionInQc): stamp the revision framing
                  // so Kyle doesn't get a weeks-overdue "QC & deliver" card.
                  // No due date: a revision promises nothing (Sep 8).
                  ...(inRevision
                    ? {
                        priority: "HIGH",
                        dueAt: null,
                        summary: "Back into revision — re-QC the fixed items before they go back to the client.",
                      }
                    : {}),
                }
              : {}),
        };
        // Diff-before-write: the merged checklist, summary, due and priority
        // are deterministic from the project, so an unchanged card is left
        // alone — its updatedAt keeps meaning something (see changedKeys).
        if (changedKeys(exists, data).length === 0) continue;
        if (nowCompleting) {
          try {
            await recordQcCompletion({
              projectId: p.id,
              items: merged,
              clientSegment: p.client.segment,
              completedBy: exists.assignedKey ?? "kyle",
            });
          } catch { /* analytics only — never block auto-close */ }
        }
        await prisma.smartTask.update({ where: { id: exists.id }, data });
        continue;
      }
      // Other completed task types stay closed — only the confirmation (handled
      // above) follows the shoot.
      if (exists.status === "COMPLETED") continue;
      // A rescheduled shoot (or a turnaround-rule change, for delivery-type
      // tasks) moves the spec's dueAt — any still-open task has to
      // follow it (>= 1h drift, so rounding noise doesn't churn writes) or it
      // surfaces in the morning brief on the WRONG day and then sits overdue.
      // Priority rides along, same formula as the creation path below. The
      // confirmation's drafted preview embeds the old date/time and
      // sendConfirmationText re-renders fresh at send time — re-render here too
      // so the draft Kyle reviews matches what actually gets sent.
      if (s.dueAt && (!exists.dueAt || Math.abs(s.dueAt.getTime() - exists.dueAt.getTime()) >= HOUR)) {
        const postShoot = ["media_qa", "delivery", "delivery_text"].includes(s.taskType);
        await prisma.smartTask.update({
          where: { id: exists.id },
          data: {
            dueAt: s.dueAt,
            priority: computePriority({ dueAt: s.dueAt, shootDate: postShoot ? null : p.shootDate, status: p.status }),
            ...(s.taskType === "confirmation_text" ? { description: draftConfirmation() } : {}),
          },
        });
      }
      continue;
    }
    // Expected, but not yet due to exist (a confirmation for a shoot weeks
    // out). The next pass after mintNotBefore creates it.
    if (s.mintNotBefore && s.mintNotBefore.getTime() > Date.now()) continue;
    // Pre-shoot tasks (confirmation) factor shoot proximity; post-shoot production
    // (QC / deliver / delivery text) is priced by its turnaround due date only.
    const postShoot = ["media_qa", "delivery", "delivery_text"].includes(s.taskType);
    const priority = computePriority({ dueAt: s.dueAt, shootDate: postShoot ? null : p.shootDate, status: p.status });
    // Pre-draft the confirmation text so Kyle just reviews + sends.
    const description = s.taskType === "confirmation_text" ? draftConfirmation() : s.description ?? null;
    await prisma.smartTask.create({
      data: {
        taskType: s.taskType,
        title: s.title,
        summary: s.summary ?? null,
        description,
        reasonCreated: s.reasonCreated,
        checklist: serializeChecklist(s.checklist),
        // QC & delivery work is Kyle's routine by definition — born on his
        // plate, not in the triage pile (audit Aug 25: all 57 media_qa cards
        // ever minted arrived unowned).
        assignedKey: s.assignedKey ?? (["media_qa", "delivery", "delivery_text", "confirmation_text"].includes(s.taskType) ? "kyle" : null),
        source: "aryeo",
        priority,
        dueAt: s.dueAt ?? null,
        deliverableType: s.deliverableType ?? null,
        projectId: p.id,
        clientId: p.client.id,
        propertyAddress: p.title,
        ownerId: kyle?.id ?? null,
        dedupeKey: key,
      },
    });
    created++;
  }
  return created;
}

// Stale-Slack sweep (daily): an unactioned Slack instruction older than 7 days
// is dead weight — nobody is going to do it from the task list, and the pile
// was 60% of the board (Aug 24 audit: 86 open, median 6 days). Cancel, don't
// complete: the truth is it wasn't done here.
export async function expireStaleSlackTasks(): Promise<{ expired: number }> {
  // System watchdog to-dos (find-the-raws / cull nudges) that survived 14 days
  // are stale alarms, not work — the job either resolved another way or the
  // chase happened off-platform. They also close at DELIVERED; this catches
  // the rest (audit Aug 25: "swept by nothing").
  await prisma.smartTask.updateMany({
    where: {
      taskType: "todo",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      createdAt: { lt: new Date(Date.now() - 14 * 86_400_000) },
      OR: [
        { dedupeKey: { startsWith: "cull-" } },
        { dedupeKey: { startsWith: "raws-" } },
        { dedupeKey: { startsWith: "raw-video-missing-" } },
      ],
    },
    data: { status: "CANCELLED", summary: "Auto-closed: a 14-day-old watchdog nudge — the job resolved another way." },
  });
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const r = await prisma.smartTask.updateMany({
    where: { taskType: "internal_instruction", source: "slack", status: "OPEN", createdAt: { lt: cutoff } },
    // Say so on the row (the Done tab shows cancelled rows): a silent cancel
    // read as "someone did this" (audit, Sep 8). Summary only — sourceDetail
    // carries the Slack channel and taskSource.ts parses it. Text mirrors
    // slackSync.SLACK_EXPIRED_SUMMARY; kept literal so tasks.ts does not pull
    // the Slack client into every import.
    data: { status: "CANCELLED", summary: "Auto-closed: 7 days with no action." },
  });
  return { expired: r.count };
}
