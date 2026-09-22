import "server-only";
import { prisma } from "@/lib/prisma";
import { NOTHING_TO_REMOVE_SENTINEL, DEBRIEF_QC_LABELS, QC_LABEL_SHOT_ORDER, QC_LABEL_REMOVALS, QC_LABEL_VIDEO_BRIEF, QC_LABEL_PAGE_SUBMITTED } from "@/lib/debrief";
import { QC_LABEL, QC_FAILURE_MODES, VIP_EXTRA_PASS, TYPE_CATEGORY_LABEL, qcCategoryOfRow, qcCategoriesLanded } from "@/lib/qcCategories";
import crypto from "crypto";
import { parseEvidence } from "@/lib/statusEvidence";
import { type ChecklistItem, parseChecklist, serializeChecklist, checklistComplete } from "@/lib/checklist";
import { addBusinessDaysET, endOfBusinessDaysET, etAt, etDateTime, etDayKey, etDayStartUtc } from "@/lib/datetime";
import { premiumDueFrom, businessDayEndHour, cappedByPromise, livePromise, targetAtFor, TIERS, type PromiseRules, type TierKey } from "@/lib/turnaround";
import { slugForName } from "@/lib/assignees";
import { BRACKET_RATIO, photoTargetFor } from "@/lib/culling";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { clip } from "@/lib/text";
import { pinnedEditorFor } from "@/lib/editors";
import { effectiveTier } from "@/lib/editOverrides";

// ---------------------------------------------------------------------------
// Phase 1 of the listener-first platform: turnaround rules + due-date/priority
// engine + package-driven task generation from real Aryeo projects.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// WHAT A JOB STILL OWES — one WHERE, used by every reader (Kyle call, Sep 16).
//
// Two ways an ordered item stops being owed, and they are NOT the same thing:
//   · removedFromOrderAt — Aryeo no longer carries the line (the order
//     reconcile owns it, and it re-instates the row the moment the line comes
//     back — which a PACKAGE-implied type does immediately).
//   · waivedAt — the OFFICE said "not required on this job" (195 Woodhill's
//     floor plan was discounted off the Essentials Package; 68 New St's moved
//     to another order). Hub-owned: no sync, sweep or reconcile ever clears it,
//     because nothing on the Aryeo order will ever say the floor plan was
//     dropped. Only a human unwaives it.
// Every "is this owed?" query spreads this constant, so a new reader cannot
// quietly forget the waiver the way each one used to have to remember
// removedFromOrderAt by hand.
// ---------------------------------------------------------------------------
export const OWED_DELIVERABLE_WHERE = { removedFromOrderAt: null, waivedAt: null } as const;

// The three tiers the office can set on a job (editOverrides.ts EDIT_TIERS).
// Repeated here as a plain union so the pure SLA helpers below stay free of
// server-only imports.
export type SlaTier = "standard" | "premium" | "branding";

/** What a tier means to the turnaround table: branding is the monthly window
 *  (7–10 business days), premium 72h, standard 48h. Null = no tier was stated,
 *  so the caller's own per-label reading stands. */
export function slaOptsForTier(tier: SlaTier | null | undefined): { premium: boolean; monthlyContent: boolean } | null {
  if (!tier) return null;
  return { premium: tier === "premium", monthlyContent: tier === "branding" };
}

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
//   • Premium reel/video   → 4 BUSINESS days, aiming at 3 (Jordan, Sep 18)
//   • Monthly content      → 7-10 BUSINESS days  [recurring social-plan client]
// PRECEDENCE: premium wins over monthly. A premium LISTING reel (e.g. a premium
// reel ordered with a property shoot) is a one-off premium deliverable, NOT
// recurring monthly content — so it keeps the 3-day premium SLA even when the
// client is on a social plan. Only NON-premium reels for a social client use the
// monthly window. Premium-ness rides on the deliverable LABEL ("Premium Reel"/
// "Premium Video"), set from the product map.
const REEL_VIDEO_TYPES = new Set(["SOCIAL_REEL", "VIDEO"]);
const STANDARD_REEL_HOURS = 48;

// The forward business-day walk this file used to keep lives in datetime.ts now
// (addBusinessDayKeysET / endOfBusinessDaysET). It counted days by adding 86.4m
// milliseconds at a time, which is an hour out either side of a clock change,
// and there were three copies of it in the hub. The backward walk below has no
// shared twin yet, so it stays — it decides when a task is MINTED, not what a
// client was promised.

// Walk BACK N business days (skip Sat/Sun).
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
  opts: DueOpts & { rules?: PromiseRules } = {},
): Date {
  const r = opts.rules;
  // A same-day rush outranks every table below, INCLUDING the editable
  // promises: the client bought a specific day, not a shorter hour count.
  if (opts.sameDay) return sameDayDue(anchor);
  if (deliverableType && REEL_VIDEO_TYPES.has(deliverableType)) {
    // PREMIUM AND MONTHLY ARE DAY-QUOTED (Sep 18). Both used to be hour
    // arithmetic off the anchor, which dated a Friday 9am premium shoot at
    // Monday 9am — a deadline inside the weekend's shadow that nobody in the
    // office would have quoted. turnaround.ts owns the premium arithmetic now,
    // so the board, the card and this engine cannot hold different numbers.
    if (opts.premium) return premiumDueFrom(anchor, r);
    if (opts.monthlyContent) {
      return endOfBusinessDaysET(anchor, r?.monthlyBusinessDays ?? 10, businessDayEndHour(r));
    }
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

/**
 * THE JOB'S TIER, office first (Sep 16, Kyle call). The hub's own reading is
 * the same ladder the editor queue draws its row chip from — monthly/branding
 * plan → "branding", a premium reel/video label → "premium", else "standard" —
 * and `Project.tierOverride` (the override dialog's picker) wins over it.
 * Feeding it to the SLA helpers is what finally makes that picker move the
 * deadline instead of only the label. Kept here, beside the promise table, so
 * lib/projectStatus can call it without importing the queue.
 */
export function slaTierOf(p: {
  tierOverride?: string | null;
  packageName?: string | null;
  deliverables: { type: string; label?: string | null }[];
}): SlaTier {
  const monthly = isMonthlyContentJob(p.deliverables, p.packageName ?? null);
  const premium = p.deliverables.some((d) => REEL_VIDEO_TYPES.has(d.type) && isPremiumLabel(d.label));
  const computed: SlaTier = monthly ? "branding" : premium ? "premium" : "standard";
  return effectiveTier({ tierOverride: p.tierOverride ?? null }, computed);
}

// A project's overall delivery due = shoot date + the LONGEST turnaround among
// its ordered deliverables (premium reel/video pushes it out, monthly further).
export function standardDeliveryDue(
  shootDate: Date,
  deliverables: { type: string; label?: string | null; productTitle?: string | null }[],
  monthlyContent = false,
  /** the stored Aryeo line items — the only place a same-day PHOTO rush still
   *  shows once its row has folded into the main Photos row (see sameDayAddOns) */
  orderItems?: { title: string; isCanceled?: boolean }[] | null,
  /** the office's tier on the job (Sep 16). A tier is a statement about the
   *  VIDEO's clock, so it only re-dates the reel/video rows: Sharra Mercer's
   *  #1584 became a branding package after booking, and until now the tier
   *  moved the queue's LABEL while the 48h reel SLA kept firing overdue. */
  /** the last leg that actually happened (videoAnchorFor). The VIDEO rows date
   *  from it rather than from shootDate on a multi-visit job (Sep 16). */
  /** Project.promisedDueAt — the promise this job was SOLD under, frozen at
   *  the rules in force then (scripts/pin-promises.ts). When it is set it IS
   *  the answer: recomputing a delivered job's deadline under today's defaults
   *  is how a settings change silently re-scores history and the photographer
   *  bonus that reads it. Callers that do not load the column get the computed
   *  date exactly as before. */
  opts: { tier?: SlaTier | null; videoAnchor?: Date | null; promisedDueAt?: Date | null } = {},
): Date {
  if (opts.promisedDueAt) return opts.promisedDueAt;
  return deliveryPromiseFor(shootDate, deliverables, monthlyContent, orderItems, opts).at;
}

/**
 * The same answer as standardDeliveryDue, plus WHICH promise produced it and
 * what we were aiming at — the three things a pin records.
 *
 * It exists so the sweep can freeze a job's promise the moment it first
 * computes one (projectStatus.ts) without a second, differently-worded copy of
 * this ladder. scripts/pin-promises.ts had to hand-reconstruct the tier for the
 * 538 rows that pre-dated the freeze; nothing booked from here on has to be
 * reconstructed, because the engine that sets the date also says what it was.
 *
 * The tier is the tier of the deliverable that WON the max, not "there is a
 * premium row on this order": 893 S Matlack carries a premium reel AND a
 * 16-video branding batch, and the batch is what dates it — labelling that pin
 * premium_reel would record an aim three days after the shoot for a job
 * promised two weeks out (pin-promises.ts, same rule).
 */
export type DeliveryPromise = { at: Date; tierKey: TierKey; targetAt: Date };
export function deliveryPromiseFor(
  shootDate: Date,
  deliverables: { type: string; label?: string | null; productTitle?: string | null }[],
  monthlyContent = false,
  orderItems?: { title: string; isCanceled?: boolean }[] | null,
  opts: { tier?: SlaTier | null; videoAnchor?: Date | null } = {},
): DeliveryPromise {
  // An order with no owed rows left (everything waived or removed) — 48h is
  // what this engine has always answered for that, and next_day is how
  // pin-promises labelled it.
  if (deliverables.length === 0) {
    return { at: new Date(shootDate.getTime() + 48 * HOUR), tierKey: "next_day", targetAt: new Date(shootDate.getTime() + 48 * HOUR) };
  }
  const rush = sameDayTypes(deliverables, orderItems);
  const tierOpts = slaOptsForTier(opts.tier);
  let best: { at: Date; tierKey: TierKey; anchor: Date } | null = null;
  for (const d of deliverables) {
    const video = REEL_VIDEO_TYPES.has(d.type);
    const anchor = video && opts.videoAnchor ? opts.videoAnchor : shootDate;
    const premium = video && tierOpts ? tierOpts.premium : isPremiumLabel(d.label);
    const monthly = video && tierOpts ? tierOpts.monthlyContent : monthlyContent;
    const sameDay = rush.has(d.type);
    const at = deliveryDueFrom(anchor, d.type, { monthlyContent: monthly, premium, sameDay });
    const tierKey: TierKey =
      sameDay ? "same_day"
      : video && premium ? "premium_reel"
      : video && monthly ? "monthly_social"
      : video ? "video_48h"
      : "next_day";
    if (!best || at > best.at) best = { at, tierKey, anchor };
  }
  const b = best!;
  // A target that falls after the deadline is not a target (pin-promises.ts):
  // the non-video rows are quoted in HOURS here (photos 20h) while the aim is
  // quoted in days, so on a rush or a short table the aim can overshoot.
  const aim = targetAtFor(TIERS[b.tierKey], b.anchor);
  return { at: b.at, tierKey: b.tierKey, targetAt: aim > b.at ? b.at : aim };
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

// WHERE THE VIDEO CLOCK STARTS (Sep 16, Kyle call — 99 W Bridge St).
//
// Project.shootDate is ONE date: the appointment sync points it at whichever
// leg it considers current. A job shot over two visits — stills on Monday, the
// reel filmed on Friday — therefore dated its reel from Monday and declared it
// overdue on Sep 11 while the video was being filmed that morning. The reel is
// cut from the footage that exists, so its window opens with the LAST leg that
// has actually happened. A future leg is not an anchor (nothing is shot yet),
// and a job with no past leg keeps its shootDate exactly as before.
// Deliberately narrow: this is the job's OWN legs, never "some later shoot at
// the same address" — a second Aryeo order is a different job.
//
// Lives HERE beside the promise table (Sep 16 review): the queue's per-category
// dates (pendingDuesByCategory, specsForProject) need the same anchor the
// status engine uses, and projectStatus already imports this module — a second
// copy would drift, an import the other way would be a cycle. projectStatus
// re-exports it, so every existing caller is unchanged.
export function videoAnchorFor(
  p: { shootDate: Date | null; appointments?: { status: string | null; startAt: Date | null }[] | null },
  now: number = Date.now(),
): Date | null {
  // A leg only anchors the clock if the visit ACTUALLY happened: cancelled is
  // out, and so is UNSCHEDULED — the office postponed it and it has no slot
  // yet, so a stale time on the row is not a shoot (Sep 16 review).
  // `postponedAt` itself is NOT a disqualifier, checked against the live rows:
  // all 37 dated postponed legs are SCHEDULED re-times of a moved booking, on
  // jobs that delivered off them; a postponed leg still waiting for a new time
  // carries startAt = null and is already excluded by the date test.
  const past = (p.appointments ?? [])
    .filter((a) => {
      const s = (a.status || "").toUpperCase();
      return !s.startsWith("CANCEL") && s !== "UNSCHEDULED" && a.startAt !== null && a.startAt.getTime() < now;
    })
    .map((a) => a.startAt!.getTime());
  const shoot = p.shootDate && p.shootDate.getTime() < now ? p.shootDate.getTime() : null;
  const candidates = [...past, ...(shoot !== null ? [shoot] : [])];
  if (candidates.length === 0) return p.shootDate;
  return new Date(Math.max(...candidates));
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

// The QC checklist vocabulary (friendly labels, the guided failure modes, the
// VIP extra pass, type → category) lives in the client-safe qcCategories.ts
// since Sep 16: the /tasks card needs the same "which category is this row"
// read as the reconciler and the one-press "Photos done". Re-exported here so
// server callers keep their import path.
export {
  QC_LABEL, QC_FAILURE_MODES, VIP_EXTRA_PASS, TYPE_CATEGORY_LABEL, QC_CATEGORIES,
  qcCategoryOfRow, qcCategoryStates, qcWaitingOnMediaOnly, qcCategoriesLanded, qcCategoryNoun, qcNotLiveMessage,
  type QcCategory, type QcCategoryState,
} from "@/lib/qcCategories";
const guide = (steps: string[]): ChecklistItem[] => steps.map((label) => ({ label, done: false }));
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

type PendingDueInput = {
  shootDate: Date | null;
  deliverables: { type: string; label?: string | null; productTitle?: string | null }[];
  /** stored Aryeo line items — same-day rush detection (see sameDayAddOns) */
  orderItems?: { title: string; isCanceled?: boolean }[] | null;
  statusEvidence?: string | null;
  monthlyContent?: boolean;
  turnarounds?: PromiseRules;
  /** the office's tier on the job (Sep 16) — branding → the monthly window,
   *  premium → four business days, standard → 48h. It re-dates the VIDEO rows
   *  only; when it is absent every row is read exactly as before. */
  tier?: SlaTier | null;
  /** Project.promisedDueAt. A per-category promise recomputed today may land
   *  AFTER the whole-job deadline the client agreed to (the premium move on
   *  Sep 18 pushes reels out); the pin caps it, so nobody is quietly granted
   *  days that were never sold. Categories promised earlier are untouched. */
  promisedDueAt?: Date | null;
  /** The row's REAL Project.shootDate, for callers whose `shootDate` above is a
   *  substitute anchor. Only a rebooked VISIT may void a pin (livePromise), and
   *  the delivery board anchors a monthly job with no shoot on `now` — against
   *  which every pin looks stale, so the pin was thrown away on every render
   *  (review, Sep 18: 80 W Lancaster). Omit it and `shootDate` answers, which
   *  is correct for every caller that passes the visit itself. */
  pinShootDate?: Date | null;
  /** The job's appointment legs. The VIDEO rows date from the LAST leg that
   *  actually happened (videoAnchorFor), not from Project.shootDate — a reel
   *  filmed on the second visit is not late against the first (99 W Bridge,
   *  Sep 16). Callers that don't load legs keep the shootDate reading. */
  appointments?: { status: string | null; startAt: Date | null }[] | null;
};

/** EVERY still-undelivered category and when it is promised, soonest first —
 *  one row per category (VIDEO and SOCIAL_REEL both land on "Video"; the
 *  earlier promise wins). The QC card says it per line now ("Video — waiting
 *  on the editor, due Fri"), so the per-category dates have to come from the
 *  same arithmetic as the whole job's (Kyle call, Sep 16). */
export function pendingDuesByCategory(p: PendingDueInput): { category: string; at: Date }[] {
  const anchor = p.shootDate ?? new Date();
  // The reel dates from the last leg that happened; everything else from the
  // job's shoot date (Sep 16 review — the multi-leg anchor was landing in the
  // status engine only, so the QC card and the delivery board still called a
  // second-visit video late).
  const videoAnchor = videoAnchorFor({ shootDate: p.shootDate, appointments: p.appointments }) ?? anchor;
  const present = new Set(parseEvidence(p.statusEvidence)?.present ?? []);
  const premiumTypes = new Set(p.deliverables.filter((d) => isPremiumLabel(d.label)).map((d) => d.type));
  // Rushed types are keyed on the raw type; dedupeTypes folds DRONE into
  // PHOTOS, and PHOTOS is in the rushed set whenever DRONE is.
  const rushTypes = sameDayTypes(p.deliverables, p.orderItems);
  const pending = dedupeTypes(p.deliverables).filter((t) => {
    const lbl = TYPE_CATEGORY_LABEL[t];
    return !lbl || !present.has(lbl);
  });
  // The office's tier speaks for the video rows; everything else keeps its own
  // label-derived reading (Sep 16 — the tier picker in the override dialog is
  // now the one switch that moves a video's deadline).
  const tierOpts = slaOptsForTier(p.tier);
  // livePromise: a pin quoted from a visit that was later rescheduled is not
  // this job's promise — it is a deadline that falls before its own shoot. The
  // anchor for THAT question is the real visit (pinShootDate), never the
  // substitute clock a caller may have passed as `shootDate`. Loop-invariant,
  // so it is answered once.
  const pin = livePromise(p.promisedDueAt, p.pinShootDate !== undefined ? p.pinShootDate : p.shootDate);
  const soonestByCategory = new Map<string, number>();
  for (const t of pending) {
    const category = TYPE_CATEGORY_LABEL[t] ?? labelFor(t);
    const video = REEL_VIDEO_TYPES.has(t);
    const computed = deliveryDueFrom(video ? videoAnchor : anchor, t, {
      monthlyContent: video && tierOpts ? tierOpts.monthlyContent : !!p.monthlyContent,
      premium: video && tierOpts ? tierOpts.premium : premiumTypes.has(t),
      sameDay: rushTypes.has(t),
      rules: p.turnarounds,
    });
    const at = (cappedByPromise(computed, pin) ?? computed).getTime();
    const prev = soonestByCategory.get(category);
    if (prev === undefined || at < prev) soonestByCategory.set(category, at);
  }
  return [...soonestByCategory.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([category, at]) => ({ category, at: new Date(at) }));
}

/** The SOONEST still-undelivered deliverable and when it is promised — what the
 *  job owes next, as distinct from when the whole job is late. */
export function nextPendingDue(p: PendingDueInput): { at: Date; categories: string[] } | null {
  const dues = pendingDuesByCategory(p);
  if (dues.length === 0) return null;
  const soonest = dues[0].at.getTime();
  return {
    at: new Date(soonest),
    categories: dues.filter((d) => d.at.getTime() === soonest).map((d) => d.category),
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
  turnarounds?: PromiseRules;
  /** Aryeo appointment legs — shootStillAhead needs a past leg to tell a
   *  return visit from a not-yet-shot job. */
  appointments?: { startAt: Date | null; status: string | null }[] | null;
  /** the account client's name — the no-customer placeholder gets no confirmation */
  clientName?: string | null;
  /** title fallbacks for coordinate-only orders (see jobLabelFor) */
  addressLine?: string | null;
  city?: string | null;
  /** the office's tier (Sep 16) — the video rows' clock, see PendingDueInput */
  tier?: SlaTier | null;
  /** Project.promisedDueAt — the sold deadline, see PendingDueInput */
  promisedDueAt?: Date | null;
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
  // The office's tier re-dates the VIDEO rows only (Sep 16) — see standardDeliveryDue.
  const tierOpts = slaOptsForTier(p.tier);
  const dueOpts = (type: string) => {
    const video = REEL_VIDEO_TYPES.has(type);
    return {
      monthlyContent: video && tierOpts ? tierOpts.monthlyContent : monthly,
      premium: video && tierOpts ? tierOpts.premium : premiumTypes.has(type),
      sameDay: rushTypes.has(type),
      rules: p.turnarounds,
    };
  };

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
    // The video rows date from the last leg that actually happened (Sep 16
    // review): on a two-visit job the QC card's due is the LATEST pending
    // item, so anchoring the reel on the first visit made the whole card read
    // overdue while the reel was still being filmed.
    const videoAnchor = videoAnchorFor({ shootDate: shoot, appointments: p.appointments }) ?? anchor;
    const anchorFor = (type: string) => (REEL_VIDEO_TYPES.has(type) ? videoAnchor : anchor);
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
    // Each pending item's own promise, never later than the deadline the job
    // was SOLD under (Sep 18) — the same cap pendingDuesByCategory applies, so
    // the QC card and the delivery board cannot print different dates.
    const dueFor = (d: string) => {
      const computed = deliveryDueFrom(anchorFor(d), d, dueOpts(d));
      return cappedByPromise(computed, livePromise(p.promisedDueAt, p.shootDate)) ?? computed;
    };
    const pendingDues = qcTypes.filter((d) => !isDelivered(d)).map((d) => dueFor(d).getTime());
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
        dueAt: pendingDues.length ? new Date(Math.max(...pendingDues)) : dueFor(primary),
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

// ---------------------------------------------------------------------------
// A DISMISSAL IS A DECISION, NOT A TIMEOUT (Kyle's call, Sep 16).
//
// Both routers below REOPEN a closed row when a new message lands on the same
// dedupe key — correct for real messages, and the reason a cancel was never a
// durable "no". But when a person has dismissed the row by hand ("already
// done", "not needed"), a "thanks!" or a 👍 must not drag it straight back
// onto the board; that is the loop Kyle described. A real question still
// reopens it, because a real question is a real ask.
// ---------------------------------------------------------------------------
async function dismissedAndOnlyCourtesy(
  existing: { status: string; summary: string | null } | null,
  text: string | null | undefined,
): Promise<boolean> {
  if (!existing || existing.status !== "CANCELLED") return false;
  const { isDismissedSummary } = await import("@/lib/triage");
  if (!isDismissedSummary(existing.summary)) return false; // a sweep closed it — reopen freely
  const t = (text ?? "").trim();
  if (!t) return true; // nothing said = nothing new
  const { isCourtesyMessage } = await import("@/lib/replyQueue");
  return isCourtesyMessage(t);
}

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
  // A row someone dismissed by hand stays dismissed until there is something
  // real to say (Sep 16).
  if (await dismissedAndOnlyCourtesy(existing, opts.snippet ?? opts.aiDetail)) return false;
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
        // They wrote again, so the chase date restarts (see the mint below).
        followUpAt: addBusinessDaysET(new Date(), 1),
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
    // WHEN TO CHASE IT AGAIN — distinct from dueAt on purpose, and the reason
    // this row can now outlive the messages that made it (audit R07, Sep 18).
    // `dueAt` is the "reply within four hours" clock: a week later it says
    // nothing except "late", and the reply queue reads MESSAGES, which age out
    // of the seven-day window. The obligation itself does not age out — the
    // ledger in replyQueue.ts (`openObligations`) reads these rows with no
    // window at all — so it needs a date that still means something on day 60.
    // Next business day, restarted every time the client writes again.
    followUpAt: addBusinessDaysET(new Date(), 1),
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
  // Same rule as createCommTask: a hand-dismissed follow-up is not resurrected
  // by a courtesy note (Sep 16).
  if (await dismissedAndOnlyCourtesy(existing, opts.text)) return false;
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
    // TEAM + SLACK INSTRUCTIONS DIE WITH THE JOB (Kyle's call, Sep 16: "several
    // tasks describe work that's already done"). Delivery used to close only
    // PRODUCTION work, so a Slack ask and a teammate's job-prep note sat open
    // on a shipped gallery until the 7-day sweep silently cancelled it or
    // nobody ever touched it: 14 open rows on DELIVERED jobs on Sep 16,
    // including "Confirm showcase video has been removed for 204 Spring Ln"
    // and "Pay question — James · 921 Hummingbird Ln" (14 days).
    //
    // The 24-hour floor is the whole safety margin: an ask raised WHILE the job
    // was being delivered is usually about the delivery itself, and closing it
    // in the same minute would eat real work. Three carve-outs stay open:
    //   · assignedManually / flaggedAt — a person put it there on purpose,
    //     the invariant every engine in this file respects;
    //   · a field flag ("Shoot issue …", source "manual") — that belongs to
    //     the field-flag owner, not to housekeeping;
    //   · an @mention companion ("<name> tagged you — <address>") — someone was
    //     asked a question directly, and it gets a full week (the janitor's
    //     rule below).
    // CANCELLED, not COMPLETED, with the reason on the row: nothing happened
    // here, and a silent close is what made the board untrustworthy.
    const extra = await prisma.smartTask.updateMany({
      where: {
        projectId,
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        assignedManually: false,
        flaggedAt: null,
        createdAt: { lt: new Date(Date.now() - 24 * 3600_000) },
        // dedupeKey is NULLABLE, and in SQL a NOT on a null column is neither
        // true nor false — a bare `NOT: { startsWith }` silently drops every
        // row that has no key at all (14 of 1820 rows today). Spelled out so a
        // future slack/team ask minted without a key is still closed (review).
        AND: [{ OR: [{ dedupeKey: null }, { NOT: { dedupeKey: { startsWith: "mention-" } } }] }],
        OR: [
          { taskType: "internal_instruction", source: { in: ["slack", "team"] } },
          { taskType: "todo", source: "brain" },
        ],
      },
      data: { status: "CANCELLED", summary: "Job delivered — closed by the hub." },
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
    // Both closes count: the janitor's step log is how anyone knows the sweep
    // is doing anything, and dropping `extra` under-reported it (review).
    return r.count + extra.count;
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
export async function closeTasksOnInactiveProjects(): Promise<{ delivered: number; cancelled: number; onHold: number; chasesReleased: number }> {
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
        // Sep 16: a DELIVERED job whose ONLY open row is a Slack ask or a
        // teammate's note was never SELECTED here, so the new delivery rule in
        // closeObsoleteTasks would never have run for it — the job has no
        // production task left to bring it into this sweep. Six of the 14 open
        // rows on delivered jobs on Sep 16 were exactly that shape.
        {
          project: { status: "DELIVERED" },
          flaggedAt: null,
          createdAt: { lt: new Date(Date.now() - 24 * 3600_000) },
          // Same nullable-column spelling as the rule this selects for — a
          // bare NOT on a null dedupeKey matches nothing (review).
          AND: [{ OR: [{ dedupeKey: null }, { NOT: { dedupeKey: { startsWith: "mention-" } } }] }],
          OR: [
            { taskType: "internal_instruction", source: { in: ["slack", "team"] } },
            { taskType: "todo", source: "brain" },
          ],
        },
        { project: { status: "ON_HOLD" }, taskType: { in: PRODUCTION_TASK_TYPES } },
      ],
    },
    select: { id: true, projectId: true, project: { select: { status: true } } },
  });
  const out = { delivered: 0, cancelled: 0, onHold: 0, chasesReleased: 0 };
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

  // @MENTION COMPANIONS ON A SHIPPED JOB (Kyle's call, Sep 16). "Jordan
  // Spackman tagged you — 632 Greenridge Rd" is one row per tagged person
  // (mentions.ts, dedupeKey mention-<project>-<person>), and the ONLY thing
  // that ever closed one was a human clicking Handled — replying on the note
  // itself does not. Three of them sat on one delivered job. A week after the
  // gallery shipped, the question is moot: close it with the reason on the
  // row, and leave anything a person put on their own plate alone. Deliberately
  // a week, not a day: being tagged is someone asking YOU something.
  const mentions = await prisma.smartTask.updateMany({
    where: {
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      assignedManually: false,
      flaggedAt: null,
      dedupeKey: { startsWith: "mention-" },
      createdAt: { lt: new Date(Date.now() - 7 * 86_400_000) },
      project: { status: "DELIVERED" },
    },
    data: { status: "CANCELLED", summary: "Job delivered a week ago — closed by the hub." },
  });
  out.delivered += mentions.count;

  // A PARKED JOB CANNOT ANSWER A CHASE (journey drill, Sep 20, 1462 Brandywine
  // Ln). ensureEditorHandoff is the only writer in the hub that can null
  // SmartTask.followUpAt, and the hourly sweep only calls it for SHOT / EDITING
  // / REVIEW (projectStatus.ts) — ON_HOLD and REVISION are outside that door,
  // and ON_HOLD is not even swept. So: blocked on a missing brief, chase armed
  // and matured onto the exceptions board, the office parks the job, the
  // photographer THEN writes the brief and submits — and 72 further hourly
  // sweeps left a HIGH "Follow-up date passed — blocked: waiting on the flow
  // and vision" row whose advice is "clear the blocker" when the blocker was
  // answered three days earlier. No screen in the hub can set or clear
  // followUpAt, so the only exit was moving the job back to EDITING. That is
  // the same unclearable chase 073a6f5 cured on three live cards, reached
  // through a door that fix did not close.
  //
  // So the chase is cleared on the way OUT of the editing lane as well as
  // inside it — the ready branch's own "both fields, or neither" rule, applied
  // to the door. Nothing is lost by it: the blocker is RECOMPUTED, not
  // remembered (projectBrief works it out from the job's own fields, and the
  // delivery board answers "On hold" / "Changes requested" before it ever
  // reads the stored sentence), so the moment the job comes back into the lane
  // the next sweep re-reads readiness and re-arms a fresh chase if it is still
  // blocked.
  out.chasesReleased = await releaseChasesOffTheEditingLane();

  return out;
}

/** Null the blocker and the chase on every open editor card whose job has left
 *  the editing lane. Set-based and self-limiting: a card that is already clear
 *  is not selected, so an hourly pass on a quiet database is one indexed read
 *  and no writes. Returns how many cards were released. */
export async function releaseChasesOffTheEditingLane(): Promise<number> {
  const stranded = await prisma.smartTask.findMany({
    where: {
      taskType: "edit_video",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      // Only rows with something to clear — no churn on updatedAt, the same
      // diff-before-write discipline ensureEditorHandoff keeps on this card.
      OR: [{ followUpAt: { not: null } }, { blockedReason: { not: null } }],
      // The lane the handoff engine runs in, spelled the way its door spells
      // it. Anything else — ON_HOLD, REVISION, a job moved back to SCHEDULED,
      // a delivered one — is a job no sweep will ever clear from the inside.
      project: { is: { status: { notIn: ["SHOT", "EDITING", "REVIEW"] } } },
    },
    select: { id: true, projectId: true },
  });
  if (stranded.length === 0) return 0;
  const cards = await prisma.smartTask.updateMany({
    where: { id: { in: stranded.map((t) => t.id) }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { blockedReason: null, followUpAt: null },
  });
  // The project's copy of the same sentence goes with it, or the delivery board
  // and the card would disagree the moment the job comes off hold and lands
  // somewhere the handoff engine does not run. handoffReadyAt is NOT touched:
  // it is the moment the job became workable, stamped once.
  const projectIds = [...new Set(stranded.map((t) => t.projectId).filter((id): id is string => !!id))];
  if (projectIds.length > 0) {
    await prisma.project.updateMany({
      where: {
        id: { in: projectIds },
        OR: [{ handoffBlockedReason: { not: null } }, { handoffOwnerKey: { not: null } }],
      },
      data: { handoffBlockedReason: null, handoffOwnerKey: null },
    });
  }
  return cards.count;
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
/** Stamped (with the categories appended, "|"-separated — category names carry
 *  spaces) on a by-hand-closed QC card the reconciler brought back because a
 *  NEW category landed on Aryeo after the close — "closed the photos, the
 *  video showed up two days later" (Kyle call, Sep 16). It is both the audit
 *  trail and the loop-stop: a reopened card is OPEN and no longer carries
 *  CLOSED_BY_HAND, so the reopen rule can only fire again after a human closes
 *  it again — by which time the landed category is part of what he closed on. */
export const REOPENED_FOR_PREFIX = "reopened-for:";
/** Every category a reopen is waiting on. Plural since the review: a video AND
 *  a floor plan can land between two hourly passes, and reopening for only the
 *  first silently ticked the other's checks as QC'd by nobody. */
export const reopenedForCategories = (sourceDetail: string | null | undefined): string[] =>
  sourceDetail?.startsWith(REOPENED_FOR_PREFIX)
    ? sourceDetail.slice(REOPENED_FOR_PREFIX.length).split("|").map((c) => c.trim()).filter(Boolean)
    : [];
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
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true, quantity: true } },
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
export async function closeVendorChasesForPresent(
  projectId: string,
  present: string[],
  /** what the job is EXPECTED to deliver at all (statusEvidence.expected). A
   *  chase for a category the job turns out never to have owed is not "still
   *  outstanding", it is a mistake with a task attached: Sharra Mercer's #1584
   *  chased AutoHDR for photos because the word "Package" in a video-only
   *  product implied a gallery (Sep 16). When the expected set stops naming
   *  the category, the chase goes with it. Omitted = don't judge. */
  expected?: string[],
): Promise<number> {
  // Arrived → the chase is DONE. Never owed → the chase is CANCELLED: a task
  // nobody should have been given does not belong in the Done ledger as work.
  const arrived = VENDOR_CHASE.filter((v) => present.includes(v.category)).map((v) => vendorChaseKey(projectId, v.category));
  const unowed =
    expected !== undefined && expected.length > 0
      ? VENDOR_CHASE.filter((v) => !present.includes(v.category) && !expected.includes(v.category)).map((v) => vendorChaseKey(projectId, v.category))
      : [];
  let n = 0;
  if (arrived.length > 0) {
    n += (await prisma.smartTask.updateMany({
      where: { dedupeKey: { in: arrived }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    })).count;
  }
  if (unowed.length > 0) {
    n += (await prisma.smartTask.updateMany({
      where: { dedupeKey: { in: unowed }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "CANCELLED", sourceDetail: "Not ordered on this job" },
    })).count;
  }
  return n;
}

/** The office said a category is not required on this job (deliverableActions
 *  .waiveDeliverable) — its vendor chase is answered, not outstanding. */
export async function cancelVendorChaseFor(projectId: string, category: string): Promise<number> {
  const v = VENDOR_CHASE.find((x) => x.category === category);
  if (!v) return 0;
  const r = await prisma.smartTask.updateMany({
    where: { dedupeKey: vendorChaseKey(projectId, category), status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  return r.count;
}

export async function chaseVendorsForMissing(
  projectId: string,
  opts: { title: string; shootDate: Date | null; missing: string[] },
): Promise<number> {
  if (!opts.shootDate || opts.missing.length === 0) return 0;
  const daysSinceShoot = (Date.now() - opts.shootDate.getTime()) / DAY;
  let due = VENDOR_CHASE.filter(
    (v) => opts.missing.includes(v.category) && daysSinceShoot >= v.delayDays,
  );
  if (due.length === 0) return 0;

  // THE PHOTOGRAPHER ALREADY ANSWERED (Sep 16, Kyle call). James wrote "no
  // floor plan for this one" on the upload page on Sep 9 and the hub chased
  // CubiCasa for it on Sep 11 anyway — the reason was an Admin-visible note
  // and no engine read it. It still isn't a waiver (only the office waives,
  // see the Confirm card minted below), but it IS a reason not to chase a
  // vendor for something the field says nobody ordered.
  const owed = await prisma.deliverable.findMany({
    where: { projectId, ...OWED_DELIVERABLE_WHERE },
    select: { id: true, type: true, label: true, notCompletedReason: true },
  });
  const answered = new Set(
    due
      .filter((v) => {
        const rows = owed.filter((d) => (TYPE_CATEGORY_LABEL[d.type] ?? labelFor(d.type)) === v.category);
        return rows.length > 0 && rows.every((d) => !!d.notCompletedReason);
      })
      .map((v) => v.category),
  );
  // SUPPRESSION ALWAYS COSTS A QUESTION (Sep 16 review). Swallowing the chase
  // and asking nobody would be worse than the chase: 322 N 62nd St carries two
  // field reasons written before any of this existed, so no waive-confirm card
  // was ever minted for them and the job would sit "missing Floor plan" in
  // silence forever. Whatever the reason suppresses here, the office gets the
  // one deduped "is it really not required?" card in its place (deduped and
  // never re-asked once answered — see confirmNotRequiredTask).
  if (answered.size > 0) {
    for (const d of owed) {
      if (!d.notCompletedReason) continue;
      if (!answered.has(TYPE_CATEGORY_LABEL[d.type] ?? labelFor(d.type))) continue;
      await confirmNotRequiredTask(d.id).catch(() => { /* best-effort: never break the sweep */ });
    }
  }
  due = due.filter((v) => !answered.has(v.category));
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
// "COULDN'T COMPLETE" → ONE QUESTION FOR THE OFFICE (Sep 16, Kyle call).
//
// The photographer already tells us on the upload page when an item was not
// wanted ("Client did not need 2d floor plan", 322 N 62nd St). Until now that
// answer was a note nobody's engine read, so the hub kept the item owed, kept
// it in "still missing", and chased CubiCasa for it three days later.
//
// It does NOT waive the item — the field says what happened at the property,
// the office says what the client bought (68 New St's floor plan really did
// move to another order; 195 Woodhill's was discounted off the package). So
// this mints ONE deduped question on Kyle's plate with a one-tap link to the
// job's deliverables, where "Not required" is a single press. Withdrawing the
// reason on the upload page cancels the question again.
// ---------------------------------------------------------------------------
export const waiveConfirmKey = (deliverableId: string) => `waive-confirm-${deliverableId}`;

export async function confirmNotRequiredTask(deliverableId: string): Promise<void> {
  const d = await prisma.deliverable.findUnique({
    where: { id: deliverableId },
    select: {
      id: true, type: true, label: true, notCompletedReason: true, waivedAt: true, removedFromOrderAt: true,
      project: { select: { id: true, title: true, clientId: true, status: true, photographer: { select: { name: true } } } },
    },
  });
  if (!d?.project) return;
  const key = waiveConfirmKey(d.id);
  const open = { status: { notIn: ["COMPLETED", "CANCELLED"] } };
  // The reason was withdrawn, the office already waived it, or the order lost
  // the line — there is nothing left to ask.
  if (!d.notCompletedReason || d.waivedAt || d.removedFromOrderAt || ["CANCELLED", "ON_HOLD"].includes(d.project.status)) {
    await prisma.smartTask.updateMany({ where: { dedupeKey: key, ...open }, data: { status: "CANCELLED" } }).catch(() => {});
    return;
  }
  const category = TYPE_CATEGORY_LABEL[d.type] ?? labelFor(d.type);
  const street = (d.project.title || "this job").split(",")[0].trim();
  const who = d.project.photographer?.name?.split(" ")[0] ?? "the photographer";
  const title = `Confirm: ${category} not required on ${street}? (${who}: ${clip(d.notCompletedReason, 40)})`.slice(0, 120);
  const summary = [
    `${who} marked the ${category.toLowerCase()} not completed at the shoot: "${clip(d.notCompletedReason, 220)}".`,
    `If the client really didn't buy it, mark it "Not required" on the job — it then stops counting as missing, stops the ${category === "Floor plan" ? "CubiCasa" : "vendor"} chase, and stays on the record with your note.`,
    `If it IS still owed, leave it: /projects/${d.project.id}#deliverables`,
  ].join(" ");
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true, status: true } });
  if (existing) {
    if (existing.status === "COMPLETED" || existing.status === "CANCELLED") return; // answered once, never re-asked
    await prisma.smartTask.update({ where: { id: existing.id }, data: { title, summary: summary.slice(0, 500) } }).catch(() => {});
    return;
  }
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } });
  await prisma.smartTask.create({
    data: {
      taskType: "internal_instruction",
      title,
      summary: summary.slice(0, 500),
      reasonCreated: `The photographer marked the ${category.toLowerCase()} not completed — only the office can say it is not required.`,
      source: "system",
      priority: "MEDIUM",
      dueAt: new Date(Date.now() + 24 * HOUR),
      projectId: d.project.id,
      clientId: d.project.clientId,
      propertyAddress: d.project.title,
      ownerId: kyle?.id ?? null,
      assignedKey: "kyle",
      deliverableType: d.type,
      dedupeKey: key,
    },
  }).catch(() => { /* a race on the unique key is a no-op */ });
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
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
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
    // stamped on after we know what the notify bridge actually did (the
    // editor's own row on Settings → Team notifications decides Slack, text
    // or bell — src/lib/notify.ts bridgePerson, Sep 15) — the old
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
  // `rules` and `promisedDueAt` landed Sep 18: this was the one SLA path that
  // never received the office's editable promises, so an edit card could sit a
  // day off the QC card and the board for the same reel — and a premium job
  // sold under the old 72-hour clock has to keep that date, not inherit the
  // longer business-day one.
  opts: { premium: boolean; monthlyContent: boolean; rules?: PromiseRules; promisedDueAt?: Date | null },
): { videoDue: Date | null; late: boolean; dueAt: Date } {
  const computed = shootDate ? deliveryDueFrom(shootDate, videoType, opts) : null;
  const videoDue = cappedByPromise(computed, livePromise(opts.promisedDueAt, shootDate));
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
      // The promise the job was sold under (Sep 18) — see editDueRule.
      promisedDueAt: true,
      editor: { select: { name: true } },
      client: { select: { name: true, socialClient: true } },
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
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
  const { turnaroundRules: editTurnarounds } = await import("@/lib/settings");
  const rule = editDueRule(p.shootDate, v.type, {
    premium: isPremium,
    monthlyContent: monthly,
    rules: await editTurnarounds().catch(() => undefined),
    promisedDueAt: p.promisedDueAt,
  });
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
/**
 * A stable key pair for pg_advisory_xact_lock, scoped to ONE edit card.
 *
 * Two FNV-1a passes with different seeds give the lock's two-int4 form: same
 * card → same pair on every worker, different cards → different pairs, so two
 * projects' rounds never wait on each other. A collision across cards would
 * only ever cost a moment's waiting, never correctness. (Two int4s rather than
 * one int8 because the build targets below ES2020 — no BigInt literals; and the
 * ::int4 casts at the call site are load-bearing, because Prisma sends a JS
 * number as a bigint and Postgres has no pg_advisory_xact_lock(bigint, bigint).)
 */
function editCardLockKey(taskId: string): [number, number] {
  const fnv = (seed: number): number => {
    let h = seed;
    for (let i = 0; i < taskId.length; i++) {
      h ^= taskId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0;
  };
  return [fnv(0x811c9dc5), fnv(0x9e3779b9)];
}

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
  const summary = `Round ${opts.round} — ${n} note${n === 1 ? "" : "s"} to fix (${opts.reason}). The notes are below and on the cut at /edit/${projectId}; fix them and upload the next version.`.slice(0, 500);
  // Due: the same SLA−12h rule as a first cut, off the job's video deliverable
  // — unless the office set the due / priority on the job (Sep 13), which a
  // round refresh must not undo any more than the hourly one may.
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { shootDate: true, dueOverrideAt: true, priorityOverride: true, promisedDueAt: true, deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } } },
  });
  const v = p?.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const { videoTier } = await import("@/lib/projectStatus");
  const { turnaroundRules: roundTurnarounds } = await import("@/lib/settings");
  const rule = editDueRule(p?.shootDate ?? null, v?.type ?? "VIDEO", {
    premium: p ? videoTier(p.deliverables) === "premium" : false,
    monthlyContent: p ? isMonthlyContentJob(p.deliverables) : false,
    rules: await roundTurnarounds().catch(() => undefined),
    promisedDueAt: p?.promisedDueAt ?? null,
  });
  const dueAt = p?.dueOverrideAt ?? rule.dueAt;

  // ---------------------------------------------------------------------
  // A05 (Sep 21 audit, fixed Sep 22 2026) — THE APPEND HAPPENS UNDER A LOCK.
  //
  // This used to read card.description into a local, append its own block in
  // memory, and write the whole string back. On a multi-video job that is the
  // ordinary case, not a freak one: two cuts of the same project are sent back
  // within the same second, both calls read the same original description, and
  // the second write erases the first one's notes. The audit reproduced it —
  // "the final description contained Cut B's music instruction but not Cut A's
  // crop instruction."
  //
  // The cut-level notes survive in their own rows, so nothing was lost
  // outright. What was lost is the thing this card exists to be: the ONE brief
  // the editor works from. An instruction that is only in a place the editor
  // does not open is an instruction that does not get followed.
  //
  // So the read-modify-write happens inside one transaction, behind an advisory
  // lock keyed on the CARD — same pattern, same ::int4 casts and same reason as
  // the cut-slot lock in app/review/actions.ts. Different projects never wait on
  // each other; two rounds on the same project queue for a moment and both
  // survive.
  // ---------------------------------------------------------------------
  const [lockA, lockB] = editCardLockKey(card.id);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockA}::int4, ${lockB}::int4)`;
    // Re-read INSIDE the lock. The copy fetched before the lock is exactly the
    // stale one this whole block exists to stop being written back.
    const fresh = await tx.smartTask.findUnique({ where: { id: card!.id }, select: { description: true } });
    let description = fresh?.description ?? "";
    if (!description.includes(block)) description = description ? `${description}\n\n${block}` : block;
    if (description.length > 4000) description = "…" + description.slice(-4000);
    await tx.smartTask.update({
      where: { id: card!.id },
      data: {
        status: "OPEN",
        completedAt: null,
        summary,
        description,
        dueAt,
        priority: p?.priorityOverride ?? computePriority({ dueAt, status: "SHOT" }),
      },
    });
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
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true, productTitle: true, notCompletedReason: true, quantity: true } },
      orderItems: { select: { title: true } },
      packageName: true,
      videosFilmed: true,
      videosOwedOverride: true, // the office's batch size (Sep 13) — wins below
      // WHETHER THE EDITOR CAN ACTUALLY START (audit WF-06, Sep 18). This select
      // used to carry none of these, so the engine minted editing work from
      // FOOTAGE EVIDENCE alone and could not tell a complete handoff from a pile
      // of files — the delivery board then fell through to "ready to edit" and
      // told Kyle a job was ready to cut when nobody had said what to cut.
      debriefSubmittedAt: true,
      videoInstructions: true,
      editorBrief: true,
      reelScript: true,
      reelHook: true,
      scriptConfirmedAt: true,
      handoffReadyAt: true,
      // The stored blocker itself, not only the stamp. The early return further
      // down has to be able to see whether this job is still WEARING one, so it
      // can put the project row and the card back in agreement (Sep 20).
      handoffBlockedReason: true,
      handoffOwnerKey: true,
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
  // A WITHDRAWN round is not a cut (Jordan, Sep 16: the editor took the wrong
  // file back) — counting it here made the handoff return early and leave the
  // editor with no work item to upload the right file against.
  const submitted = await prisma.reviewSubmission.count({ where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } } });
  // A cut exists (submission) or the video is verifiably live → nothing to
  // chase. But a MONTHLY job is a BATCH: the first cut landing must not close
  // the editor's work item while videos 2..N are still owed — without it the
  // editor has no task to submit against (submitCutForReview scopes to their
  // open task) and the rest of the set has no owner (audit).
  if (submitted > 0 || videoPresent) {
    await clearNudge();
    // A CUT EXISTS, SO THE HANDOFF QUESTION IS CLOSED — and the readiness block
    // at the end of this function is never reached again for this job, which is
    // the second way a card used to freeze wearing a blocker (Sep 20). A row
    // that was blocked when its cut landed kept saying "waiting on the flow and
    // vision for the edit from Harrison" for good, with a chase date nothing
    // would ever move, while the edit was already sitting in the Review Room.
    // The test lives in the where clause, so this writes nothing — and does not
    // touch updatedAt — on the great majority of jobs that carry neither.
    await prisma.smartTask.updateMany({
      where: {
        dedupeKey: `edit-video-${projectId}`,
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [{ blockedReason: { not: null } }, { followUpAt: { not: null } }],
      },
      data: { blockedReason: null, followUpAt: null },
    });
    // AND THE SAME ON THE PROJECT ROW, or the two halves of one sentence now
    // contradict each other. The delivery board READS the stored blocker
    // (deliveryBoard.ts) and tests it BEFORE the REVIEW branch, so clearing only
    // the card would hand the editor a clean work item while the board went on
    // telling Kyle the job was waiting on Harrison for a brief. 2645 N 8th St is
    // in that shape today: REVIEW, one cut submitted, still carrying "waiting on
    // the flow and vision for the edit". Stale on both sides was wrong but at
    // least consistent; stale on one side is a board arguing with a card.
    // handoffReadyAt is deliberately NOT stamped — this job never became
    // workable, the question simply stopped being asked once a cut existed.
    // (projectBrief recomputes readiness instead of reading the column, so the
    // delivery board is the whole audience for this.) Guarded, so a job wearing
    // neither is not written at all.
    if (p.handoffBlockedReason || p.handoffOwnerKey) {
      await prisma.project.update({
        where: { id: projectId },
        data: { handoffBlockedReason: null, handoffOwnerKey: null },
      });
    }
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

  // NAME THE BLOCKER, THE OWNER AND THE NEXT CHASE (audit WF-06 / directive 8).
  //
  // The card is minted either way — the work exists and needs an owner, and a
  // job with no card is a job nobody is carrying. What changes is that a card
  // the editor cannot start now SAYS so, in words, with the person it is waiting
  // on and a date to chase them. A plain social reel demands nothing and reads
  // ready the moment the footage is in (Jordan: "if it's a standard social reel,
  // it doesn't need additional notes").
  //
  // The task's STATUS is deliberately untouched. Moving it to BLOCKED would take
  // it off queues that filter on OPEN, and an editor who CAN start on what they
  // have should not be stopped by the hub — the point is that everybody can see
  // what is missing, not that the work is frozen.
  try {
    const { handoffReadiness } = await import("@/lib/handoff");
    const { isMonthlyContentJob } = await import("@/lib/pipeline");
    const r = handoffReadiness({
      titles: [...p.orderItems.map((o) => o.title), ...p.deliverables.map((d) => d.productTitle ?? d.label)],
      hasFullVideo: p.deliverables.some((d) => d.type === "VIDEO"),
      isMonthly: isMonthlyContentJob(p.deliverables, p.packageName),
      debriefSubmittedAt: p.debriefSubmittedAt,
      videoInstructions: p.videoInstructions,
      editorBrief: p.editorBrief,
      reelScript: p.reelScript,
      reelHook: p.reelHook,
      scriptConfirmedAt: p.scriptConfirmedAt,
      videosFilmed: p.videosFilmed,
      photographerName: p.photographer?.name ?? null,
      photographerKey: p.photographer?.name ? slugForName(p.photographer.name) : null,
    });
    // SAY NOTHING WHEN THERE IS NOTHING TO SAY (Sep 20 journey drill). The card
    // write below has read-then-diff discipline and this one did not, so a job
    // sitting quietly in the editing lane had its project row rewritten with
    // the values it already held on every pass: 120 of 120 no-op sweeps on a
    // blocked job, 48 of 48 on a job that was already clear, against 0 of 120
    // on the card. Project.updatedAt is the age the exceptions board falls back
    // to when a job has no shoot date (opsExceptions.ts), so a no-op write is
    // not free — it is the row forgetting when it was last genuinely touched.
    const projectRight = r.ready
      ? !!p.handoffReadyAt && !p.handoffBlockedReason && !p.handoffOwnerKey
      : p.handoffBlockedReason === r.blockedReason && p.handoffOwnerKey === r.ownerKey;
    if (!projectRight) {
      await prisma.project.update({
        where: { id: projectId },
        data: r.ready
          ? {
              // Stamped once. It is the moment the job became workable, not the
              // last time a sweep happened to agree.
              ...(p.handoffReadyAt ? {} : { handoffReadyAt: new Date() }),
              handoffBlockedReason: null,
              handoffOwnerKey: null,
            }
          : { handoffBlockedReason: r.blockedReason, handoffOwnerKey: r.ownerKey },
      });
    }
    // The chase date lives on the CARD, in followUpAt rather than dueAt: a job
    // blocked on a missing brief still owes its delivery date, and moving dueAt
    // would move the clock the editor is scored on.
    //
    // READ THE CARD FIRST — the same once-only discipline the project stamp
    // above keeps, which this write did not (Sep 20). Two things were wrong:
    //
    //   · THE CHASE NEVER FIRED. The date was re-stamped on every hourly sweep,
    //     and addBusinessDaysET lands on MIDNIGHT ET of the next business day —
    //     the exact instant the top-of-the-hour cron runs — so the date the
    //     sweep wrote at 5pm was written again at 6pm and was never once in the
    //     past. 120 simulated hourly ticks, not one of them overdue. A job
    //     blocked on Harrison's flow-and-vision note could sit blocked for a
    //     week and nothing would ever say so. So: set it ONCE per blocker, and
    //     let it mature at 9am when somebody is at a desk rather than at
    //     midnight. A DIFFERENT blocker is a new ask and earns a fresh day.
    //   · A CLEARED BLOCKER LEFT ITS DATE. The ready branch nulled the reason
    //     and said nothing about the date, so three live cards (107 E Old
    //     Baltimore Pike, 1462 Brandywine Ln and one job with no address on it)
    //     were carrying a chase they could never shed: it matured into a
    //     "Follow-up date passed" row on the home exceptions card, aged into
    //     high severity after three days, and NO screen in the hub can set or
    //     clear followUpAt. Ready means the chase is over. Both fields, or
    //     neither.
    const card = await prisma.smartTask.findUnique({
      where: { dedupeKey: `edit-video-${projectId}` },
      select: { status: true, blockedReason: true, followUpAt: true },
    });
    const chaseAlreadySet = !!card?.followUpAt && card.blockedReason === r.blockedReason;
    // A CLOSED CARD IS ALREADY RIGHT, whatever it is wearing: the write below
    // excludes COMPLETED and CANCELLED, so comparing a closed row's fields only
    // ever produced a 0-row update that fired again an hour later, for good. Two
    // live rows are exactly that — 453 Cardigan Terrace and 2645 N 8th St both
    // closed still holding a chase date — and reading the status is what stops
    // the sweep pointlessly re-asking about them (Sep 20). Same for no card at
    // all: there is nothing to write.
    const terminal = card?.status === "COMPLETED" || card?.status === "CANCELLED";
    // Say nothing when there is nothing to say — mintEditTask's own
    // diff-before-write discipline. An hourly no-op update still moves
    // updatedAt, and updatedAt is the only thing some of these rows have left
    // to say when they were last genuinely touched.
    const alreadyRight =
      !card || terminal || (r.ready ? !card.blockedReason && !card.followUpAt : chaseAlreadySet);
    if (!alreadyRight) {
      await prisma.smartTask.updateMany({
        where: { dedupeKey: `edit-video-${projectId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: r.ready
          ? { blockedReason: null, followUpAt: null }
          : {
              blockedReason: r.blockedReason,
              followUpAt: endOfBusinessDaysET(new Date(), 1, 9),
            },
      });
    }
  } catch { /* readiness is advisory — it must never stop a card being minted */ }

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
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true, productTitle: true } },
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
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true, productTitle: true } },
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
  /** the office's tier (Sep 13 column, honoured by the clock from Sep 16) */
  tierOverride?: string | null;
  packageName?: string | null;
  /** the promise this job was SOLD under (Sep 18 column) — rides along with
   *  `include`, and caps every date this reconciler writes */
  promisedDueAt?: Date | null;
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
      // Rows still uploading (or whose upload died) are not cuts — nor is a
      // round that was WITHDRAWN (Sep 16). Without that exclusion this
      // evidence-close read a taken-back cut as "the cut is with the owner"
      // and re-completed the editor's card an hour after they reopened it.
      finalVideoLanded =
        (await prisma.reviewSubmission.count({ where: { projectId: p.id, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } } })) > 0;
    }
    // MULTI-VIDEO packages (monthly personal branding: 2–5 videos) submit one
    // video at a time, and submitCutForReview deliberately keeps the edit task
    // OPEN until the whole set is in. "A submission exists / a file is in the
    // Final folder" is NOT done for those jobs — require every owed video to
    // have been through review before this evidence-close may fire.
    if (finalVideoLanded) {
      const vids = await prisma.deliverable.findMany({
        where: { projectId: p.id, type: { in: ["VIDEO", "SOCIAL_REEL"] }, ...OWED_DELIVERABLE_WHERE },
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
    // The sold deadline caps every QC date below (Sep 18) — see PendingDueInput.
    promisedDueAt: p.promisedDueAt ?? null,
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
    // THE OFFICE'S TIER (Sep 16, Kyle call): until now the tier picker in the
    // override dialog moved the queue's label and nothing else, so Sharra
    // Mercer's #1584 — booked as a premium reel, re-sold as a 16-video
    // branding package — kept its 48h reel clock and every card it owned read
    // overdue. Branding now means the monthly window, here and on the status
    // card, off the one column.
    tier: slaTierOf(p),
  });
  // The vendor's piece arrived (the status sweep just refreshed this
  // evidence, and `tasks` runs right after it) → its chase is done.
  try {
    const chaseEv = parseEvidence(p.statusEvidence);
    await closeVendorChasesForPresent(p.id, chaseEv?.present ?? [], chaseEv?.expected);
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
        // --- A by-hand close is not the end of QC (Kyle call, Sep 16) --------
        // Kyle closes the card when the photos are out and the video is still
        // days away; today that is FINAL (the guard below), so the video is
        // never QC'd from this card. If a category LANDS after the close — its
        // "QC <x>" evidence row was unticked then and is ticked now — bring the
        // card back with ONLY the landed categories outstanding: every other
        // human row is ticked, because he already decided about those. The
        // stamp records what brought it back and is what stops this from firing
        // hourly: a reopened card is OPEN and no longer CLOSED_BY_HAND, so the
        // rule can only run again after another by-hand close, whose snapshot
        // then includes the landed category.
        //
        // ALL of them, not the first (review): a video and a floor plan can
        // both land between two hourly passes — 358 N Church and 99 W Bridge
        // owe exactly that pair today — and reopening for the video alone
        // ticked "Square footage matches the listing" as QC'd by nobody.
        const reopenFor = exists.status === "COMPLETED" && exists.sourceDetail === CLOSED_BY_HAND
          ? [...qcCategoriesLanded(prev, merged)].filter((c) =>
              merged.some((i) => !i.done && qcCategoryOfRow(i.label) === c))
          : [];
        if (reopenFor.length > 0) {
          // Only the landed categories' rows stay open. Gate rows are evidence,
          // never ours to tick — a "QC Floor plan" ticked by hand here would
          // tell the whole hub a missing floor plan had been checked.
          const stillOpen = new Set<string>(reopenFor);
          const reopened: ChecklistItem[] = merged.map((i) => {
            const c = qcCategoryOfRow(i.label);
            return (c && stillOpen.has(c)) || isQcGateRow(i.label) ? i : { ...i, done: true };
          });
          const named = reopenFor.join(" + ");
          await prisma.smartTask.update({
            where: { id: exists.id },
            data: {
              status: "OPEN",
              completedAt: null,
              sourceDetail: `${REOPENED_FOR_PREFIX}${reopenFor.join("|")}`,
              checklist: serializeChecklist(reopened),
              summary: `${named} landed after this card was closed — check ${reopenFor.length === 1 ? "it" : "them"} before ${reopenFor.length === 1 ? "it goes" : "they go"} out.`,
              // A revision promises nothing (Sep 8) — the same carve-out the
              // normal path makes four lines below. Without it a card that
              // came back mid-revision carried the spec's shoot-anchored date
              // and read weeks overdue the moment it reopened (review).
              ...(p.status === "REVISION"
                ? { dueAt: null, priority: "HIGH" as const }
                : s.dueAt
                  ? { dueAt: s.dueAt, priority: computePriority({ dueAt: s.dueAt, status: p.status }) }
                  : {}),
            },
          });
          await prisma.activity
            .create({
              data: {
                projectId: p.id,
                type: "SYSTEM",
                body: `QC reopened — ${named} landed on Aryeo after the card was closed by hand.`,
              },
            })
            .catch(() => {});
          continue;
        }
        // Sep 8: the evidence rows (+ the two self-clearing debrief rows) are
        // the gate; every human tick is optional — see qcGateComplete.
        // A card the rule above brought back holds open until the landed
        // category's own rows are ticked (or a human closes it again) —
        // otherwise the very next pass would auto-close it on the evidence
        // that reopened it, and the card would flicker instead of being QC'd.
        const reopenedFor = new Set(reopenedForCategories(exists.sourceDetail));
        const reopenedWorkLeft =
          reopenedFor.size > 0 &&
          merged.some((i) => {
            const c = qcCategoryOfRow(i.label);
            return !i.done && !!c && reopenedFor.has(c);
          });
        const allDone = qcGateComplete(merged) && !reopenedWorkLeft;
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
          // A reopened card keeps its own headline until the landed category
          // is checked off; the spec's generic summary would erase why it is
          // back on Kyle's plate.
          ...(s.summary && !inRevision && !reopenedWorkLeft ? { summary: s.summary } : {}),
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
  // A CONFIRMATION TEXT FOR A SHOOT THAT ALREADY HAPPENED (Kyle's call,
  // Sep 16). Two of these had been open since Aug 4 and Aug 20. The text is
  // sent the day BEFORE — once the shoot date is behind us there is nothing
  // left to confirm, and the row is just noise on the board and in the 4
  // o'clock digest. A rebooked job gets a NEW shoot date and a fresh card, so
  // this only ever catches the genuinely stranded ones. Anything a person put
  // on their own plate (assignedManually) or deliberately flagged (flaggedAt)
  // is left alone, the carve-out every other close rule in this file carries.
  await prisma.smartTask.updateMany({
    where: {
      taskType: "confirmation_text",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      assignedManually: false,
      flaggedAt: null,
      project: { shootDate: { lt: new Date() } },
    },
    data: { status: "CANCELLED", summary: "Stale — shoot date passed." },
  });

  const cutoff = new Date(Date.now() - 7 * 86_400_000);

  // SAY SOMETHING BEFORE IT DIES (Kyle's call, Sep 16). In 30 days, 108 Slack
  // asks were minted and 50 were cancelled — 9 of them by this sweep, with
  // nobody told. A row that expires in silence teaches the office that the
  // board forgets things, which is the reason Kyle stopped trusting it. So on
  // day 6 the person it is assigned to gets one nudge with the link; on day 7
  // it closes as before. Deduped per task, so the nudge goes exactly once.
  try {
    const warnFrom = new Date(Date.now() - 7 * 86_400_000);
    const warnTo = new Date(Date.now() - 6 * 86_400_000);
    const soon = await prisma.smartTask.findMany({
      where: {
        taskType: "internal_instruction",
        source: "slack",
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        assignedKey: { not: null },
        createdAt: { gte: warnFrom, lt: warnTo },
      },
      select: { id: true, title: true, assignedKey: true, propertyAddress: true },
      take: 30,
    });
    if (soon.length > 0) {
      const { notifyInApp } = await import("@/lib/notify");
      const { slugForName } = await import("@/lib/assignees");
      const roster = await prisma.teamMember.findMany({ select: { id: true, name: true } });
      const byKey = new Map(roster.map((m) => [slugForName(m.name), m.id]));
      for (const t of soon) {
        const tmId = t.assignedKey ? byKey.get(t.assignedKey) : undefined;
        if (!tmId) continue; // nobody to tell — it still expires tomorrow
        const href = `/tasks?tab=slack&task=${t.id}`;
        // BELL ONLY, for now, and the wording downstream says so. notify.ts's
        // bridge only pushes a kind it can map to one of the person's notify
        // switches (notifyPrefs.ts KIND_TO_EVENT), and "task_expiring" is not
        // in that map yet — so the slackDm below is carried but not sent. It
        // is left in place deliberately: the day the kind is classified
        // (notifyPrefs.ts is B4's file, Sep 16 handover) the DM starts going
        // out with no change here. Until then the cancel summary and the guide
        // say "posted in the hub", which is what actually happens (review).
        await notifyInApp({
          kind: "task_expiring",
          title: `Still needed? “${t.title.slice(0, 50)}” closes tomorrow`,
          body: "It closes tomorrow unless you act.",
          href,
          targets: [
            {
              roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"],
              userKey: `tm:${tmId}`,
              href,
              slackDm: `This Slack ask has been open a week: “${t.title.slice(0, 120)}”${t.propertyAddress ? ` (${t.propertyAddress.split(",")[0]})` : ""}. Still needed? It closes tomorrow unless you act. ${href}`,
            },
          ],
          dedupeKey: `slack-expiring-${t.id}`,
        });
      }
    }
  } catch { /* the nudge is a courtesy — it must never stop the sweep below */ }

  const r = await prisma.smartTask.updateMany({
    where: { taskType: "internal_instruction", source: "slack", status: "OPEN", createdAt: { lt: cutoff } },
    // Say so on the row (the Done tab shows cancelled rows): a silent cancel
    // read as "someone did this" (audit, Sep 8). Summary only — sourceDetail
    // carries the Slack channel and taskSource.ts parses it. Text mirrors
    // slackSync.SLACK_EXPIRED_SUMMARY; kept literal so tasks.ts does not pull
    // the Slack client into every import.
    data: { status: "CANCELLED", summary: "Auto-closed: 7 days with no action. A reminder was posted in the hub yesterday." },
  });
  return { expired: r.count };
}
