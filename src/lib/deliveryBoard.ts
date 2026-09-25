import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etAddDays, etDayStartUtc } from "@/lib/datetime";
import {
  tierFor, dueAtFor, cappedByPromise, pinnedPromise, TIERS, type Tier,
  // §9's per-session clocks (F27 review, Sep 21 2026) — see boardSessions.
  productionSessionsFor, productionWindowFrom,
  // Jordan's honest-date rule (Sep 21 2026, batch 2) — see productionDateState.
  productionAnchorFor, anchorIsKnown, NEEDS_VERIFICATION_LABEL, type ProductionAnchorStatus,
} from "@/lib/turnaround";
import { parseEvidence, evidenceFreshness, type EvidenceFreshness, type ParsedEvidence } from "@/lib/statusEvidence";
import { isMonthlyContentJob } from "@/lib/pipeline";
// The product-name → category read and the category labels live in the light,
// client-safe qcCategories.ts (review, Sep 16): the only thing this board wanted
// from projectStatus.ts was one pure string function, and importing it pulled
// the whole status engine — Aryeo, Dropbox, connections — into /pipeline's chain.
import { categoryLabelsForLabel } from "@/lib/qcCategories";
import { pendingDuesByCategory, slaTierOf, OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { turnaroundRules } from "@/lib/settings";
// Who is ACTUALLY editing a job right now — the editor's own Start/Pause (§7.1).
// Light: prisma, the roster and the date helpers.
import { workLabel, workStateFor, type ProjectWork } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// THE DELIVERY BOARD — Kyle's screen.
//
// Jordan: "I want a screen that our content delivery / quality checking person
// AKA Kyle can come in to and see what projects we have due today, what is
// holding them up, and what is upcoming."
//
// So it answers three things per job and nothing else:
//   WHEN is it due     — from the ordered products, each on its own promise
//   WHAT is holding it — one plain-English blocker, not a status code
//   WHAT was ordered   — the real product names off the order
//
// A job's due date is the EARLIEST outstanding item. A shoot with photos and a
// premium reel is due tomorrow for the photos even though the reel has four
// days — rolled up any other way, the thing that's actually late disappears
// behind the thing that isn't.
// ---------------------------------------------------------------------------

export type BlockerKind =
  | "on_hold" | "revision" | "not_shot" | "awaiting_upload"
  // FILES IN, INSTRUCTIONS ABSENT (audit WF-06, Sep 18). The vocabulary had no
  // value for the state four live jobs were actually in, so blockerFor fell
  // through to ready_to_edit and told Kyle a job was ready to cut when nobody
  // had said what to cut. One new member, not a second vocabulary.
  | "handoff_incomplete"
  | "ready_to_edit" | "editing" | "qc" | "ready" | "delivered";

/** dueAt is null while the job has no shoot date — no clock has started. */
export type BoardItem = { title: string; quantity: number; tierLabel: string; dueAt: Date | null };

export type BoardJob = {
  id: string;
  title: string;
  address: string | null;
  client: string | null;
  status: string;
  shootDate: Date | null;
  photographer: string | null;
  /** Earliest outstanding promise; null when nothing is outstanding. */
  dueAt: Date | null;
  dueTierLabel: string | null;
  /** What that date is FOR — the product Kyle is actually chasing, prefixed
   *  with the filming session on a job that has more than one (§9). */
  dueFor: string | null;
  /** THE SESSION GROUPING (§9; F27 review, Sep 21 2026). Empty on a
   *  single-session job — which is every job on this board but one today — and
   *  otherwise one row per filming session, each with its own day-7/day-10, so
   *  a two-visit job is never presented as one merged date again. */
  sessions: BoardSession[];
  overdue: boolean;
  blocker: BlockerKind;
  blockerLabel: string;
  items: BoardItem[];
  photos: "none" | "some" | "in" | "n/a";
  video: "none" | "some" | "in" | "n/a";
  /** WHERE each kind actually is. "In" on its own meant only that the
   *  deliverable had been ticked as uploaded, which Kyle reads as "done" — on
   *  439 Lake George the video sat in Dropbox (115 files) with nothing on
   *  Aryeo, and the board said "Video in". These say the two things apart:
   *  raw footage sitting in Dropbox, and media live on Aryeo for the client. */
  media: {
    photos: { rawInDropbox: number; liveOnAryeo: number | null; ordered: boolean };
    video: { rawInDropbox: number; liveOnAryeo: number | null; ordered: boolean };
    /** false = the last evidence read failed or is stale, so a zero above is
     *  "we couldn't look", not "nothing is there" (RTP-16, Sep 16). */
    known: boolean;
    /** the last read we know succeeded — what "last known" refers to */
    checkedAt: Date | null;
    /** WHY it isn't known. "The last check failed" and "nothing has looked
     *  since Sep 1" are different facts, and the row used to assert the first
     *  for both — on a held job, which the sweep skips entirely, that was
     *  simply untrue (review, Sep 16). */
    reason: EvidenceFreshness["reason"];
  };
  notes: string | null;
  /** HISTORY. The original delivery, kept exactly as it is — it never decides
   *  which column this job sits in (RTP-04, Sep 16). */
  deliveredAt: Date | null;
  /** When the outstanding ask was raised, on a job that has one. */
  revisionAskedAt: Date | null;
  /** No obligation left: a terminal status with no open revision. THIS is the
   *  live/delivered split — not the deliveredAt stamp. */
  settled: boolean;
  /** Delivered once, and owed again since. */
  reopened: boolean;
  /** THE HONEST-DATE VERDICT for a monthly content job (Jordan, Sep 21 2026).
   *  Null on every other job kind. When `status` is not "known" this job has no
   *  production date at all, and a card MUST print `label` where the date would
   *  go rather than leaving the space blank — a blank date on a board whose only
   *  other signal is a red "overdue" chip reads as on time. */
  productionDate: ProductionDateState | null;
};

export type DeliveryBoard = {
  today: BoardJob[];
  tomorrow: BoardJob[];
  upcoming: BoardJob[];
  delivered: BoardJob[];
  overdueCount: number;
  /** Monthly jobs whose production date Kyle has to correct — filming happened
   *  and the appointment or its end time is missing (Jordan, Sep 21 2026).
   *  Counted separately from `overdueCount` on purpose: "three jobs are late"
   *  and "I cannot tell whether three jobs are late" are different facts, and
   *  the second one used to be invisible.
   *
   *  OPTIONAL for the same reason `unavailable` exists (audit, Sep 17): the
   *  home page builds a fallback board when the query throws, and a required
   *  empty array there would assert "no corrections owed" out of a read that
   *  never happened. Absent means NOT KNOWN; only deliveryBoard() sets it. */
  needsProductionDate?: BoardJob[];
  /**
   * The board could not be read at all (the query threw). An empty board and an
   * unreadable one look identical and mean opposite things — "nothing is late"
   * versus "I do not know what is late" — and the home page used to render the
   * first when it meant the second (audit, Sep 17). Callers that fall back MUST
   * set this, and every reassuring zero is suppressed while it is true.
   */
  unavailable?: boolean;
};

const VIDEOISH = new Set(["VIDEO", "SOCIAL_REEL"]);
const PHOTOISH = new Set(["PHOTOS", "DRONE", "TWILIGHT"]);

// A deliverable counts as IN when EITHER signal says so: the manual uploadedAt
// tick, or the evidence-driven status (DONE = live on Aryeo, UPLOADED = the
// photographer's tick). uploadedAt alone was a field the automated pipeline
// never writes, so the board said "Waiting on photos" on delivered jobs (audit).
// This is the RAW-FILES read — it answers "have the files arrived", and it is
// what the Photos/Video media line shows.
const isIn = (r: { uploadedAt: Date | null; status: string }) =>
  !!r.uploadedAt || r.status === "DONE" || r.status === "UPLOADED";

// What the CLIENT has. UPLOADED is the photographer's raw drop into Dropbox —
// on 358 N Church the video sat UPLOADED with nothing cut and the board read
// "Needs QC" instead of "Waiting on video" (Kyle call, Sep 16). Only DONE (the
// status sweep's word that the media is live) counts as delivered; the legacy
// uploadedAt tick still counts on rows the sweep has never touched.
const isDeliveredRow = (r: { uploadedAt: Date | null; status: string }) =>
  r.status === "DONE" || (!!r.uploadedAt && r.status !== "UPLOADED");

/** none = nothing in, some = partially in, in = all of that kind uploaded. */
function uploadState(rows: { uploadedAt: Date | null; status: string }[]): "none" | "some" | "in" | "n/a" {
  if (rows.length === 0) return "n/a";
  const up = rows.filter(isIn).length;
  return up === 0 ? "none" : up === rows.length ? "in" : "some";
}

// ---------------------------------------------------------------------------
// WHAT DOES THIS JOB STILL OWE? (RTP-04, Sep 16 audit)
//
// The obligation decides everything on this board — which column a job sits
// in, whether it has a promise, and what the blocker chip says. Project
// .deliveredAt is HISTORY and is never asked: 1337 Carolannes went out on Aug
// 28 and the client sent recorded notes on Sep 14, so "delivered" is a true
// fact about August and a lie about today. The stamp itself is never touched.
// ---------------------------------------------------------------------------

/** The two ends of the line. Everything else is live work, at any age. */
const TERMINAL_STATUSES = new Set(["DELIVERED", "CANCELLED"]);

/** An ask raised since the last delivery is still open — the same rule
 *  reviewCuts.ts applies (revisionRequestedAt newer than deliveredAt). A job
 *  delivered AFTER the ask (332 Ruth Ridge: asked Sep 1, delivered Sep 2) is
 *  settled, and a REVISION status with no stamp is its own witness. */
function hasOpenRevision(p: { status: string; deliveredAt: Date | null; revisionRequestedAt: Date | null }): boolean {
  if (p.status === "REVISION") return true;
  if (!p.revisionRequestedAt) return false;
  return !p.deliveredAt || p.revisionRequestedAt > p.deliveredAt;
}

/** Nothing outstanding: a terminal stage with no reopened ask. */
function isSettled(p: { status: string; deliveredAt: Date | null; revisionRequestedAt: Date | null }): boolean {
  return TERMINAL_STATUSES.has(p.status) && !hasOpenRevision(p);
}

// ---------------------------------------------------------------------------
// ONE PROMISE ENGINE (review, Sep 16).
//
// The board and the project page's Status check card each worked out their own
// answer to "when was this due", and they disagreed: on 358 N Church the board
// said Sep 17 05:00 UTC while the card said Sep 18 17:00, so one would have
// gone red hours before the other. Worse, the card only ever had the VIDEO's
// date, so a late Photos job (2358 Buck Mountain, due today on the board) read
// "No promise has been set for it yet."
//
// Everything below is pure and exported: deliveryBoard() calls it per row, and
// StatusEvidenceCard calls it for the one job it is rendering. They cannot
// drift, because there is only one of it.
// ---------------------------------------------------------------------------

/** Exactly what the promise needs off a project row. */
export type PromiseInput = {
  status: string;
  shootDate: Date | null;
  deliveredAt: Date | null;
  revisionRequestedAt: Date | null;
  dueOverrideAt: Date | null;
  tierOverride: string | null;
  /** Project.promisedDueAt — the deadline this job was SOLD under, frozen at
   *  the rules in force then. Optional because two callers outside this file
   *  build the input from their own select; without it a job simply reads on
   *  today's rules, exactly as it did before Sep 18. */
  promisedDueAt?: Date | null;
  /** Project.promisedReason — the documented exception, in the office's own
   *  words, for a job whose date is not what the product table would say. */
  promisedReason?: string | null;
  packageName: string | null;
  statusEvidence: string | null;
  orderItems: { title: string; quantity: number }[];
  deliverables: { type: string; status: string; uploadedAt: Date | null; label: string | null }[];
  // id/endAt/durationMin are OPTIONAL on purpose (F27 review, Sep 21 2026).
  // outstandingPromise is also called by projectBrief.ts and by the project
  // page's StatusEvidenceCard, and both build their own select with startAt and
  // status alone. Requiring the new columns would break those two callers at
  // compile time for a grouping only Kyle's board renders; without them a
  // session simply anchors on its booked start (turnaround.legEnd's
  // `appointment_start` rung), which is labelled as estimated and is never
  // LATER than the end, so the board can only ever call a job late sooner.
  appointments: { id?: string; startAt: Date | null; endAt?: Date | null; durationMin?: number | null; status: string | null }[];
};

/**
 * ONE FILMING SESSION on a multi-session monthly job, with its own day-7/day-10.
 *
 * §9: "Each Pro session has a separate end time and day-7/day-10 target."
 * Joe Sutow, 1023 Sycamore Mills Rd, is filmed twice — Fri Jul 24 and Mon Jul
 * 27 — and every screen in the hub showed it one merged date taken from the
 * LATER visit, so the first session's videos read as on time for three extra
 * days (F27 review, Sep 21 2026). The merged date is fixed below; this is the
 * grouping that replaces it, so a card can print both sessions instead of
 * silently choosing one.
 */
export type BoardSession = {
  appointmentId: string | null;
  /** 1-based over this job's bookable legs, by start — a display ordinal. */
  index: number;
  of: number;
  startAt: Date | null;
  /** the session's END, the anchor §8 asks for. Null when it is not known —
   *  and then `unknownLabel` is what the card prints in its place. */
  anchorAt: Date | null;
  /** RETIRED Sep 21 2026: always false. Nothing is estimated any more. */
  anchorEstimated: boolean;
  /** "known" | "needs_verification" | "not_scheduled" (Jordan, Sep 21 2026).
   *  Only "known" may be coloured or counted as on time. */
  anchorStatus: ProductionAnchorStatus;
  /** "Not scheduled" / "Production date needs verification", or null. */
  unknownLabel: string | null;
  /** why, in one line, when this session has no date. */
  anchorNote: string | null;
  /** business day 7 — what the office aims at. */
  productionTargetAt: Date | null;
  /** business day 10 — late after this. */
  productionDueAt: Date | null;
};

export type BoardPromise = {
  /** null = this job has no clock at all (see the reopened rule below). */
  at: Date | null;
  /** what the date is FOR — the product or category being chased. */
  label: string | null;
  tierLabel: string | null;
  /** the office set this date by hand; it outranks every product promise. */
  office: boolean;
  /** this date is the promise the job was sold under, not today's rules. */
  pinned?: boolean;
  /** the documented reason this job's promise is what it is, if there is one. */
  reason?: string | null;
  /** "Session 1 of 2" — set only on a multi-session monthly job, so a card
   *  saying ONE date for a two-visit job has to name the visit it belongs to
   *  (§9; F27 review, Sep 21 2026). Null everywhere else, which is every job
   *  but one today. */
  sessionLabel?: string | null;
};

export type TurnaroundRuleSet = Awaited<ReturnType<typeof turnaroundRules>> | undefined;

// The clock starts at the shoot — that's when we take possession of the work.
// Anything with no shoot date has no clock at all: an unscheduled BOOKED job
// used to anchor at `now`, which made it "due tomorrow 5 PM" every single day —
// 775 Scotch Way sat in Due tomorrow for a week (audit, Sep 8 2026), padding
// Kyle's tomorrow count by one. It belongs in Upcoming, marked "no date", until
// it is on the calendar.
//
// THAT SAME `now` FALLBACK SURVIVED FOR MONTHLY CONTENT UNTIL Sep 21 2026,
// where it was worse. A monthly job with no shoot date anchored on `now`, so
// its day-10 was recomputed ten business days into the future on every single
// render: the job could never be late, never entered Today, and sat in Upcoming
// looking perfectly on time for as long as it existed. Jordan, Sep 21:
// "Unknown deadlines must not appear as on time." An always-receding deadline
// is the purest form of that, so the fallback is gone and such a job now has no
// date and says which kind of nothing it is — "Not scheduled" when nobody has
// booked it, "Production date needs verification" when filming happened and its
// appointment is missing (turnaround.productionAnchorFor).
/** What clockStart and boardSessions read. `appointments` is Partial so the two
 *  callers outside this file that build their own select keep compiling. */
type SessionSource = Pick<PromiseInput, "deliverables" | "packageName"> & Partial<Pick<PromiseInput, "appointments">>;

function clockStart(
  p: Pick<PromiseInput, "shootDate"> & SessionSource,
  // `now` is no longer read: the monthly `now` fallback it existed for is
  // retired (see above). It stays in the signature because both callers thread
  // their own clock through and a drill replays the board at a chosen instant.
  now: Date,
): Date | null {
  void now;
  const base = p.shootDate ?? null;
  // A MULTI-SESSION MONTHLY JOB IS DATED BY ITS EARLIEST SESSION (F27 review,
  // Sep 21 2026). Project.shootDate carries ONE visit, and on Joe Sutow's
  // 1023 Sycamore Mills Rd it is the second one (Mon Jul 27) — so this board
  // dated the whole job off the later visit and the Fri Jul 24 session's
  // videos read as on time for three extra days. §9 gives each Pro session its
  // own day-7/day-10, and "when is this job late" is the earliest of them.
  //
  // Two deliberate limits:
  //   · MONTHLY ONLY. §9 is about Pro sessions. A listing with two visits is a
  //     different question (a reel filmed on the second visit is not late
  //     against the first, tasks.videoAnchorFor), and moving those dates is not
  //     what this fix was asked to do.
  //   · NEVER LATER. The earliest session's end can in principle sit after
  //     shootDate, and a board date that moved later would HIDE lateness, which
  //     is the same class of bug in the other direction. So this only ever
  //     pulls the clock earlier.
  const sessions = boardSessions(p);
  if (sessions.length < 2) return base;
  const earliest = sessions[0].anchorAt;
  if (!earliest) return base;
  return base && base.getTime() <= earliest.getTime() ? base : earliest;
}

/**
 * The job's filming sessions, each on its own clock. Empty unless this is a
 * monthly content job with MORE THAN ONE bookable leg — a single-session job
 * has nothing to group and must keep exactly the date it has today.
 */
export function boardSessions(p: SessionSource, rules?: TurnaroundRuleSet): BoardSession[] {
  if (!isMonthlyContentJob(p.deliverables, p.packageName)) return [];
  const sessions = productionSessionsFor({ appointments: p.appointments ?? [] });
  if (sessions.length < 2) return [];
  return sessions.map((s) => {
    const win = anchorIsKnown(s.anchor) ? productionWindowFrom(s.anchor.at!, rules) : null;
    return {
      appointmentId: s.legId,
      index: s.index,
      of: s.of,
      startAt: s.startAt,
      anchorAt: anchorIsKnown(s.anchor) ? s.anchor.at : null,
      anchorEstimated: s.anchor.estimated,
      anchorStatus: s.anchor.status,
      unknownLabel: s.anchor.unknownLabel,
      anchorNote: s.anchor.note,
      productionTargetAt: win?.productionTargetAt ?? null,
      productionDueAt: win?.productionDueAt ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// WHEN THERE IS NO DATE, SAY WHICH KIND OF NOTHING (Jordan, Sep 21 2026).
//
//   "Show 'Not scheduled' for genuinely unbooked work. If filming happened but
//    its appointment or end time is missing, show 'Production date needs
//    verification' and assign Kyle the correction. Unknown deadlines must not
//    appear as on time."
//
// The board's `overdue` is `!!dueAt && dueAt < now`, so a job with no date has
// always been not-overdue, which on a green/red board reads as fine. That was
// survivable while the only dateless jobs were reopened and on-hold ones, which
// the Upcoming sort already floats to the top and whose blocker chip says what
// they are. It is not survivable for a monthly job that simply lost its
// appointment: nothing on the card would say so.
//
// So a monthly content job now carries the anchor's own verdict, the Upcoming
// sort floats an undated one alongside the reopened work, and the board counts
// the corrections Kyle owes. MONTHLY ONLY, deliberately: a listing shoot with
// no date is the existing "No shoot date" blocker and is not what this rule is
// about.
// ---------------------------------------------------------------------------

// KYLE'S CORRECTION TASK — the half that is NOT in this file. Jordan asked for
// the exception to be "assigned to Kyle", and a task is a WRITE, which a read
// path that renders a board must not perform. The detector, the wording and the
// list live here; the filing belongs in the sweep that already mints Kyle's
// tasks (src/lib/tasks.ts, the prisma.smartTask.upsert pattern at ~:3058). The
// exact row, so the next pass does not have to invent it:
//
//   taskType "internal_instruction", priority "HIGH", assignedKey "kyle",
//   dedupeKey dedupe([projectId, "production-date-unverified"]),
//   title   `Production date needs verification — ${street}`
//   summary  productionDateState(p).note
//   update: {}   — one per job, never re-opened over a human's handling
//
// It is deliberately NOT minted from deliveryBoard(), because that function is
// called on every render of Kyle's screen and of the home page.
// ---------------------------------------------------------------------------

export type ProductionDateState = {
  status: ProductionAnchorStatus;
  /** what the card prints where the date would go; null when the date is known */
  label: string | null;
  /** one line of why, for the card's second row */
  note: string | null;
  /** Kyle owes a correction on this job */
  needsCheck: boolean;
};

/** The monthly job's production-date verdict. Null on every other job kind,
 *  and null on a SETTLED job: six monthly jobs delivered between Sep 2025 and
 *  Jun 2026 carry no appointment row at all, and putting six closed jobs on
 *  Kyle's correction list would bury the one live exception under history. The
 *  board's own rule — the obligation decides everything here — applies. */
export function productionDateState(
  p: Pick<PromiseInput, "shootDate" | "status" | "deliveredAt" | "revisionRequestedAt"> & SessionSource,
  now = new Date(),
): ProductionDateState | null {
  if (!isMonthlyContentJob(p.deliverables, p.packageName)) return null;
  if (isSettled(p)) return null;
  const anchor = productionAnchorFor(
    { shootDate: p.shootDate, appointments: p.appointments ?? [] },
    { now: now.getTime() },
  );
  // "FILMING HAPPENED" IS NOT ONLY A SHOOT DATE (Jordan, Sep 21 2026). A job
  // with no appointment and no shootDate still had a camera pointed at
  // something if its files are in — and turnaround.productionAnchorFor cannot
  // know that, because it is given the two date columns and nothing else. The
  // board has the deliverable rows, so the upgrade from "nobody booked this" to
  // "somebody filmed this and the booking is missing" belongs here. No live row
  // takes this path today; it exists because a job whose appointment is deleted
  // after delivery would otherwise read as merely unbooked.
  if (anchor.status === "not_scheduled" && (p.deliverables ?? []).some((d) => isIn(d))) {
    return {
      status: "needs_verification",
      label: NEEDS_VERIFICATION_LABEL,
      note: "Files are in for this job but it has no appointment in Aryeo, so there is no session end to count from. Kyle: find or create the appointment so the day-7 and day-10 dates are real.",
      needsCheck: true,
    };
  }
  return {
    status: anchor.status,
    label: anchor.unknownLabel,
    note: anchor.note,
    needsCheck: anchor.status === "needs_verification",
  };
}

/** Every ordered product with its own tier and promise — the "n products
 *  ordered" list on the card, and the raw material for the date below. */
export function boardItems(
  p: Pick<PromiseInput, "shootDate" | "orderItems"> & SessionSource,
  now = new Date(),
  // The office's editable promises. This was the one date path in the hub that
  // never received them, so a turnaround changed in Settings moved every
  // surface EXCEPT Kyle's board (audit WF-04, Sep 17).
  rules?: TurnaroundRuleSet,
): BoardItem[] {
  const startedAt = clockStart(p, now);
  // A VIDEO ON A MONTHLY JOB RUNS ON THE MONTHLY CLOCK (Sep 18). This read a
  // product name and nothing else, so 893 S Matlack's "Custom Branding Video
  // Package 16 Videos Total" was a 48-hour reel here and a 7–10 business-day
  // batch in the SLA engine — the board called it late on Sep 11 for a job the
  // QC card had promised on Sep 23. isMonthlyContentJob is the hub's own
  // reading of a branding plan, and it is what tasks.ts consults. Premium
  // still outranks monthly: a premium listing reel bought by a plan client is
  // a one-off premium deliverable (tasks.ts, PRECEDENCE).
  const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
  return p.orderItems.map((oi) => {
    const read: Tier = tierFor(oi.title);
    const tier: Tier = monthly && read.key === "video_48h" ? TIERS.monthly_social : read;
    return { title: oi.title, quantity: oi.quantity, tierLabel: tier.label, dueAt: startedAt ? dueAtFor(tier, startedAt, rules) : null };
  });
}

/**
 * THE EARLIEST OUTSTANDING PROMISE (Kyle call, Sep 16).
 *
 * The header has always said "a job's due date is the EARLIEST outstanding
 * item", but the code took the min over EVERY item — so a job whose photos
 * went out on time read LATE for the photo promise while the thing actually
 * owed (the video) sat two days out. An item is settled when every category it
 * implies is live on Aryeo; an item the label parser can't classify ("Social
 * Influencer") stays outstanding, because we can't prove it's done.
 */
export function outstandingPromise(
  p: PromiseInput,
  opts: { now?: Date; turnarounds?: TurnaroundRuleSet; evidence?: ParsedEvidence | null } = {},
): BoardPromise {
  const now = opts.now ?? new Date();
  const ev = opts.evidence !== undefined ? opts.evidence : parseEvidence(p.statusEvidence);
  const missingCategories = ev ? ev.missing : null;
  const settled = isSettled(p);
  // REOPENED, not merely "has an open ask" (review, Sep 16). 1337 Carolannes
  // met every promise its order carried back in August and is owed the
  // client's Sep 14 notes; printing "LATE · Aug 26" would date it against a
  // promise it kept. A revision has no clock of its own yet — that is Jordan's
  // open question (a fixed turnaround from the ask, or Kyle sets it by hand) —
  // so until he answers, the honest answer is no date and the card says so in
  // words. A job that was NEVER delivered keeps the promise it is breaking:
  // 893 S Matlack is a REVISION with no delivery, five days past its 48-hour
  // video, and gating on the ask alone quietly took it off Kyle's late list.
  const reopened = !settled && !!p.deliveredAt;

  const startedAt = clockStart(p, now);
  // The clock above is anchored on the EARLIEST session, so a job with more
  // than one visit names that visit rather than presenting its date as the
  // whole job's (§9; F27 review, Sep 21 2026). Null on every single-session
  // job, which is 68 of the 69 live content jobs today.
  const sessions = boardSessions(p, opts.turnarounds);
  const sessionLabel = sessions.length >= 2 ? `Session ${sessions[0].index} of ${sessions[0].of}` : null;
  const dated = boardItems(p, now, opts.turnarounds).filter((i): i is BoardItem & { dueAt: Date } => i.dueAt !== null);
  const outstandingItems = missingCategories
    ? dated.filter((i) => {
        const cats = categoryLabelsForLabel(i.title);
        return cats.length === 0 || cats.some((c) => missingCategories.includes(c));
      })
    : dated;
  // A missing category the order items never name still has a promise — the
  // deliverable rows carry it, and tasks.ts is the one SLA engine (premium
  // 72h, same-day rushes, monthly batches) the QC card is dated by.
  // startedAt guard: with no shoot date there is no clock at all, and
  // pendingDuesByCategory anchors on `now` — which is how an unscheduled
  // BOOKED job used to read "due tomorrow 5 PM" every single day.
  const categoryDues =
    startedAt && missingCategories && missingCategories.length > 0 && outstandingItems.length === 0
      ? pendingDuesByCategory({
          shootDate: startedAt,
          deliverables: p.deliverables,
          orderItems: p.orderItems,
          statusEvidence: p.statusEvidence,
          monthlyContent: isMonthlyContentJob(p.deliverables, p.packageName),
          turnarounds: opts.turnarounds,
          // The office's tier, same ladder as the QC card and the status
          // engine (Sep 16) — a job re-sold as a branding package must not
          // keep reading LATE here on a 48h reel clock.
          tier: slaTierOf(p),
          appointments: p.appointments,
          promisedDueAt: p.promisedDueAt ?? null,
          // `shootDate` above is startedAt — a SUBSTITUTE anchor (`now`) on a
          // monthly job with no visit. The pin must be judged against the real
          // visit or it is discarded on every render (review, Sep 18).
          pinShootDate: p.shootDate,
        }).filter((d) => missingCategories.includes(d.category))
      : [];
  const earliestItem = settled || outstandingItems.length === 0
    ? null
    : outstandingItems.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
  const earliestCategory = settled || categoryDues.length === 0 ? null : categoryDues[0];
  // Nothing outstanding at all (every category live, nothing to date): the job
  // is between QC and delivery — keep the old whole-order date so the card
  // still says when it was promised rather than falling into Upcoming.
  const fallback = settled || dated.length === 0 ? null : dated.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
  const earliest = reopened
    ? null
    : earliestItem ?? (earliestCategory ? { title: earliestCategory.category, tierLabel: null as string | null, dueAt: earliestCategory.at } : fallback);

  // THE OFFICE'S DUE (Sep 13, editOverrides.ts): when Jordan set a date on the
  // job, that is the promise Kyle is chasing — it replaces the earliest product
  // promise and is labelled as the office's, not a tier's. It still stands on a
  // reopened job; only a settled one has no promise at all.
  if (!settled && p.dueOverrideAt) {
    return {
      at: p.dueOverrideAt,
      label: earliest?.title ?? "the whole job",
      tierLabel: "office override",
      office: true,
      reason: p.promisedReason ?? null,
      sessionLabel,
    };
  }
  // THE PROMISE THE JOB WAS SOLD UNDER (Sep 18). Project.promisedDueAt is the
  // whole-job client deadline frozen at the rules in force when it was booked.
  // An item promise recomputed today can now land AFTER it — moving premium
  // reels from 72 elapsed hours to four business days adds days to every reel
  // still in flight — and showing that later date would quietly hand a client
  // time they never agreed to. So a pinned job is never dated past its pin;
  // items promised EARLIER (the photos, due tomorrow) are untouched, because
  // that is still the thing Kyle is chasing.
  // …and the pin is read off the ROW, never against `startedAt` (review, Sep
  // 18). clockStart falls back to `now` for a monthly job with no shoot date,
  // and every pin is older than now — so this line used to discard the pin on
  // every render of every such job. 80 W Lancaster Ave Floor 2 is pinned Mon
  // Sep 7 2:30pm and printed Thu Oct 1 5pm today, Fri Oct 2 5pm tomorrow: the
  // promise walking forward one day per day, which is the exact drift the
  // freeze exists to stop. Only a rebooked VISIT may void a pin.
  const pin = pinnedPromise(p);
  // A FROZEN PROMISE OUTLIVES THE LOSS OF THE CLOCK (Sep 21 2026, batch 2).
  // Retiring the monthly `now` fallback left this job with no computed item
  // date, and cappedByPromise(null, pin) returns null — so 80 W Lancaster Ave
  // Floor 2, a BOOKED job whose only appointment is off the calendar, went from
  // a drifting fake deadline to NO deadline while still carrying a recorded
  // promise of Mon Sep 7 2:30pm. Both readings are wrong and the second is
  // worse, because a job sold under a date that has passed would sit in
  // Upcoming reading as not overdue. A pin is not an invented date — it is the
  // deadline the office wrote down — so where there is nothing to cap, the pin
  // IS the promise.
  // …AND ONLY ON A JOB THAT STILL OWES SOMETHING (review, Sep 21 2026, same
  // day). Written for the dateless job, the line fired on EVERY path that
  // leaves `earliest` null, and there are three of them: a SETTLED job zeroes
  // every candidate above on purpose, a REOPENED job is an explicit
  // `reopened ? null : …` because a revision has no clock until Jordan answers,
  // and only the third is the one this was for. Measured read-only over 400
  // live board rows: 278 jobs took a date from this line — 272 settled and
  // DELIVERED, every one of them instantly overdue (a board of red chips on
  // finished work), 3 live REOPENED jobs re-dated to a promise they had already
  // KEPT, which is precisely what that ternary exists to prevent, and 3 that
  // were the dateless monthly jobs. After this scoping: 3.
  const datelessButPromised = !settled && !reopened && !earliest;
  const at = earliest ? cappedByPromise(earliest.dueAt, pin) : datelessButPromised ? pin : null;
  const capped = !!at && (!earliest || at.getTime() !== earliest.dueAt.getTime());
  return {
    at,
    label: earliest?.title ?? null,
    tierLabel: capped ? "as promised" : earliest?.tierLabel ?? null,
    office: false,
    pinned: capped,
    reason: p.promisedReason ?? null,
    // The label describes the DATE, so a job with no date carries no label —
    // a settled or reopened job printing "Session 1 of 2" beside nothing would
    // read as a promise it does not have (F27 review, Sep 21 2026).
    sessionLabel: at ? sessionLabel : null,
  };
}

/**
 * What is holding this job up, in the words Kyle would use.
 *
 * ONE answer, most-blocking first. A card listing six half-true states is what
 * makes a board unreadable — you end up reading every card to find the one
 * thing that needs doing.
 */
function blockerFor(
  p: { status: string; shootDate: Date | null; deliveredAt: Date | null; revisionRequestedAt: Date | null; handoffBlockedReason?: string | null },
  deliverables: { type: string; status: string; uploadedAt: Date | null }[],
  /** the status engine's own answer — categories ordered but not live on
   *  Aryeo. Null when the job has no evidence yet (then the rows decide). */
  missingCategories: string[] | null,
  /** Who has pressed Start / Pause on the job (lib/editorWork.workStateFor).
   *  Absent or empty = nobody said so. */
  work?: ProjectWork | null,
): { kind: BlockerKind; label: string } {
  // THE OBLIGATION IS TESTED FIRST (RTP-04, Sep 16). This used to open with
  // `if (p.deliveredAt) return "Delivered"`, which read a job delivered months
  // ago and reopened today as done and put it in the Delivered column with a
  // green chip — with nothing on the card saying changes were outstanding.
  if (p.status === "ON_HOLD") return { kind: "on_hold", label: "On hold" };
  // Neutral: a revision is the client's ask OR the owner bouncing a cut in review.
  if (hasOpenRevision(p)) return { kind: "revision", label: "Changes requested" };
  // Only now may the history speak, and only for a job that is genuinely done.
  if (isSettled(p)) return { kind: "delivered", label: "Delivered" };

  const now = new Date();
  if (!p.shootDate || p.shootDate > now) {
    return { kind: "not_shot", label: p.shootDate ? "Not shot yet" : "No shoot date" };
  }

  // Nothing has turned up yet for some ordered item — unchanged: this is the
  // "we don't have the files" case, and the rows are the right witness.
  const missing = deliverables.filter((d) => !isIn(d));
  if (missing.length > 0) {
    const kinds = new Set(missing.map((d) => d.type));
    // Name the missing thing. "Waiting on video" is Jordan's own example.
    const name =
      kinds.has("VIDEO") || kinds.has("SOCIAL_REEL") ? "video"
      : kinds.has("FLOORPLAN") ? "the floor plan"
      : kinds.has("ZILLOW_3D") || kinds.has("MATTERPORT_3D") ? "the 3D tour"
      : kinds.has("VIRTUAL_STAGING") ? "virtual staging"
      : kinds.has("PHOTOS") ? "photos"
      : "files";
    return { kind: "awaiting_upload", label: `Waiting on ${name}` };
  }

  // THE FILES ARE IN AND THE BRIEF IS NOT. Read, never recomputed: the handoff
  // engine stamps this sentence (and the person it is waiting on) when it mints
  // the edit card, so the board and the queue say the same thing rather than
  // each deciding for themselves. Tested after the missing-files case, because
  // "we do not have the footage" is a bigger blocker than "we do not have the
  // notes", and before the editing states, because an editor cannot start.
  if (p.handoffBlockedReason) {
    return { kind: "handoff_incomplete", label: p.handoffBlockedReason.replace(/\.$/, "") };
  }

  if (p.status === "REVIEW") {
    // THE FILES ARE IN — but "in" counts the photographer's raw drop
    // (Deliverable UPLOADED, or the /upload tick), and raw footage in Dropbox
    // is not a video. 358 N Church read "Needs QC" with 57 photos live, no cut
    // made and the client asking for it (Kyle call, Sep 16). What the CLIENT
    // is still missing is the blocker: the status engine's per-category answer
    // first, and where there is no evidence, the rows minus the raw-only ones.
    if (missingCategories && missingCategories.length > 0) {
      const has = (c: string) => missingCategories.includes(c);
      const name =
        has("Video") ? "video"
        : has("Floor plan") ? "the floor plan"
        : has("3D tour") ? "the 3D tour"
        : has("Photos") ? "photos"
        : missingCategories[0].toLowerCase();
      return { kind: "awaiting_upload", label: `Waiting on ${name}` };
    }
    if (!missingCategories) {
      const rawOnly = deliverables.filter((d) => !isDeliveredRow(d));
      if (rawOnly.length > 0) {
        const kinds = new Set(rawOnly.map((d) => d.type));
        const name =
          kinds.has("VIDEO") || kinds.has("SOCIAL_REEL") ? "video"
          : kinds.has("FLOORPLAN") ? "the floor plan"
          : kinds.has("ZILLOW_3D") || kinds.has("MATTERPORT_3D") ? "the 3D tour"
          : kinds.has("PHOTOS") ? "photos"
          : "files";
        return { kind: "awaiting_upload", label: `Waiting on ${name}` };
      }
    }
    return { kind: "qc", label: "Needs QC" };
  }
  if (deliverables.length > 0 && deliverables.every((d) => d.status === "DONE")) {
    return { kind: "ready", label: "Ready to deliver" };
  }
  // WHO IS ON IT — the editor's own Start, not the stage (§7.1, A64, Sep 25).
  // This used to say "With the editor" for every EDITING job, and EDITING is
  // now only the lifecycle ("editing has begun"): a paused job, a board move
  // and a pre-Start claim all wear it. The words are the Editing Room row's
  // own (workLabel), so the two screens say the same thing about a job:
  //   somebody pressed Start → "In editing — Kim since 10:02am"
  //   they paused it         → "Paused — Kim 3:10pm"
  //   EDITING, nobody said   → "In editing — not confirmed"
  //   files in, nobody       → "Ready for editing" (Jordan, Sep 10)
  const w = work && (work.active.length || work.paused.length) ? work : null;
  if (p.status === "EDITING" || w) {
    const { label, chip } = workLabel(p.status === "EDITING" ? "EDITING" : "SHOT", w);
    if (label === "Ready for editing") return { kind: "ready_to_edit", label };
    const who = chip ? chip.replace(/^Paused — /, "") : null;
    return { kind: "editing", label: who ? `${label} — ${who}` : label };
  }
  return { kind: "ready_to_edit", label: "Ready for editing" };
}

/** One query for the whole board — this screen is open all day and must not fan out. */
export async function deliveryBoard(): Promise<DeliveryBoard> {
  const now = new Date();
  const todayKey = etDayKey(now);
  const tomorrowKey = etDayKey(etAddDays(now, 1));
  // Settings → Turnaround promises, so a category with no line item of its own
  // (328 Columbia's video lives inside "Standard Package") is dated by the same
  // engine as the QC card and never by a stale constant.
  const turnarounds = await turnaroundRules().catch(() => undefined);

  const rows = await prisma.project.findMany({
    where: {
      status: { not: "CANCELLED" },
      // RTP-04 (Sep 16): the ten-day window ages out FINISHED work only. It
      // used to key on the deliveredAt stamp, so a job with an old delivery
      // date fell off the board no matter what it owed today — 1337
      // Carolannes (delivered Aug 28, client notes Sep 14) and 56 Hillview
      // (held since Jul 30 with the client's complaint on the record) were on
      // no screen at all. A non-terminal status is live work at any age; the
      // tail is for genuinely delivered rows.
      OR: [
        { status: { not: "DELIVERED" } },
        { deliveredAt: { gte: etAddDays(etDayStartUtc(), -10) } },
        // …and any row the obligation still calls live. isSettled() reads a
        // DELIVERED row whose ask is newer than its delivery as unfinished, so
        // the window has to keep it too — otherwise the same job goes invisible
        // again at ten days, which is the whole of RTP-04 (review, Sep 16).
        // Zero rows today (comms.ts flips such a job to REVISION), so this is a
        // guard against the two rules drifting apart, not a live fix.
        { revisionRequestedAt: { gt: prisma.project.fields.deliveredAt } },
      ],
    },
    select: {
      id: true, title: true, addressLine: true, city: true, status: true,
      shootDate: true, deliveredAt: true, notes: true,
      // Stamped by the handoff engine when it mints the edit card, so the board
      // READS the blocker rather than deciding it a second time (audit WF-06).
      handoffBlockedReason: true,
      // The outstanding ask (RTP-04): a reopened job is live work, and the
      // card says when it was reopened rather than showing a green delivery.
      revisionRequestedAt: true,
      // "We couldn't look" vs "we looked and saw nothing" (RTP-16). All three
      // are new and may be null on every row today — read defensively.
      statusCheckedAt: true, evidenceAttemptedAt: true, evidenceSucceededAt: true, evidenceError: true,
      packageName: true, // monthly-content detection (the one job kind whose clock runs without a shoot)
      dueOverrideAt: true, // the office's due for the job (Sep 13, editOverrides.ts) — wins over every promise below
      tierOverride: true, // the office's tier (Sep 16) — branding → the monthly window, premium → four business days
      // The promise the job was SOLD under, and the documented reason for it
      // (Sep 18) — a job pinned before a default moved keeps its own date.
      promisedDueAt: true, promisedReason: true,
      client: { select: { name: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, status: true, uploadedAt: true, label: true } },
      statusEvidence: true, // Dropbox raw counts + what Aryeo actually carries
      // Legs (not just the first): the photographer name comes off the
      // earliest one, and the video promise below dates from the LAST leg
      // that actually happened — a reel filmed on the second visit is not
      // late against the first (Sep 16 review, videoAnchorFor).
      // id/endAt/durationMin are new (F27 review, Sep 21 2026): §9 anchors each
      // session on its END, and boardSessions cannot tell one session from
      // another without the row id. Aryeo leaves endAt null on some legs, hence
      // durationMin as the second rung of turnaround.legEnd's ladder.
      appointments: { select: { id: true, assignedTo: { select: { name: true } }, startAt: true, endAt: true, durationMin: true, status: true }, orderBy: { startAt: "asc" } },
    },
    orderBy: { shootDate: "desc" },
    take: 400,
  });

  // Who pressed Start (§7.1) — one batched read, and only for the jobs whose
  // blocker can be an editing one. A failed read degrades to "nobody said so"
  // (Ready for editing / not confirmed), never to somebody's live work.
  const work = await workStateFor(rows.filter((p) => p.status === "SHOT" || p.status === "EDITING").map((p) => p.id))
    .catch(() => new Map<string, ProjectWork>());

  const jobs: BoardJob[] = rows.map((p) => {
    const items = boardItems(p, now, turnarounds);

    const ev = parseEvidence(p.statusEvidence);
    const missingCategories = ev ? ev.missing : null;
    const { kind, label } = blockerFor(p, p.deliverables, missingCategories, work.get(p.id));
    // THE OBLIGATION, once, for the column, the promise and the card.
    const settled = isSettled(p);
    const openAsk = !settled && hasOpenRevision(p);
    const reopened = !settled && !!p.deliveredAt;

    // The promise — the same function the project page's Status check card
    // reads, so the two screens can never call a job late on different days
    // (review, Sep 16).
    const promise = outstandingPromise(p, { now, turnarounds, evidence: ev });
    const dueAt = promise.at;
    // §9's grouping, computed once for the card and for the "for …" line.
    const sessions = boardSessions(p, turnarounds);

    return {
      id: p.id,
      title: (p.title || "Untitled job").split(",")[0].trim(),
      address: [p.addressLine, p.city].filter(Boolean).join(", ") || null,
      client: p.client?.name ?? null,
      status: p.status,
      shootDate: p.shootDate,
      photographer: p.appointments[0]?.assignedTo?.name ?? null,
      dueAt,
      dueTierLabel: promise.tierLabel,
      // A job filmed twice says WHICH visit this date belongs to. Without it
      // the card reads as the whole job's promise, which is the merge that let
      // 1023 Sycamore Mills Rd's first session look on time for three extra
      // days (F27 review, Sep 21 2026).
      dueFor: promise.sessionLabel ? [promise.sessionLabel, promise.label].filter(Boolean).join(" · ") : promise.label,
      sessions,
      overdue: !!dueAt && dueAt < now,
      blocker: kind,
      blockerLabel: label,
      items,
      photos: uploadState(p.deliverables.filter((d) => PHOTOISH.has(d.type))),
      video: uploadState(p.deliverables.filter((d) => VIDEOISH.has(d.type))),
      media: (() => {
        // RTP-16 (Sep 16): carry the freshness with the counts. A failed
        // Dropbox read leaves a stale ZERO behind, and the row rendered that
        // as a confident red "nothing yet" — a source failure must never look
        // like a trustworthy fact.
        const fresh = evidenceFreshness({
          evidence: ev,
          attemptedAt: p.evidenceAttemptedAt,
          succeededAt: p.evidenceSucceededAt,
          error: p.evidenceError,
          checkedAt: p.statusCheckedAt,
          now,
        });
        return {
          photos: {
            rawInDropbox: ev?.dropbox?.rawPhotos ?? 0,
            liveOnAryeo: ev?.aryeo ? ev.aryeo.photos : null,
            ordered: p.deliverables.some((d) => PHOTOISH.has(d.type)),
          },
          video: {
            rawInDropbox: ev?.dropbox?.rawVideo ?? 0,
            liveOnAryeo: ev?.aryeo ? ev.aryeo.videos : null,
            ordered: p.deliverables.some((d) => VIDEOISH.has(d.type)),
          },
          known: fresh.known,
          checkedAt: fresh.at,
          reason: fresh.reason,
        };
      })(),
      notes: p.notes?.trim() || null,
      deliveredAt: p.deliveredAt,
      revisionAskedAt: openAsk ? p.revisionRequestedAt : null,
      settled,
      reopened,
      productionDate: productionDateState(p, now),
    };
  });

  // THE SPLIT IS THE OBLIGATION, NOT THE STAMP (RTP-04, Sep 16).
  const live = jobs.filter((j) => !j.settled);
  const byDue = (a: BoardJob, b: BoardJob) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity);

  // Overdue rides in Today. A day late is more urgent than due-at-5pm, and a
  // separate Overdue tab is a tab nobody opens until it's already too late.
  const today = live.filter((j) => j.dueAt && etDayKey(j.dueAt) <= todayKey).sort(byDue);
  const tomorrow = live.filter((j) => j.dueAt && etDayKey(j.dueAt) === tomorrowKey).sort(byDue);
  // Work with no clock sorts to the TOP of Upcoming, not the bottom: a
  // reopened or held job has no promise yet (see the fallback above), and
  // Infinity would bury the one card on this board that nobody is chasing
  // underneath thirty future shoots.
  const upcoming = live
    .filter((j) => !j.dueAt || etDayKey(j.dueAt) > tomorrowKey)
    .sort((a, b) => {
      // A MONTHLY JOB WITH AN UNKNOWN DATE RIDES WITH THE REOPENED WORK (Sep 21
      // 2026). Without this it sorts on Infinity and lands under thirty future
      // shoots — the quietest possible place to put the one card that says "I
      // do not know whether this is late."
      const owedNoClock = (j: BoardJob) =>
        !j.dueAt && (j.blocker === "revision" || j.blocker === "on_hold" || j.productionDate?.needsCheck) ? 0 : 1;
      return owedNoClock(a) - owedNoClock(b) || byDue(a, b);
    });
  // The delivered tail. Sorted on the stamp where there is one — a terminal
  // row with no stamp (four 2022 imports) has no place in a ten-day tail and
  // is already filtered out by the query.
  const delivered = jobs
    .filter((j) => j.settled)
    .sort((a, b) => (b.deliveredAt?.getTime() ?? 0) - (a.deliveredAt?.getTime() ?? 0));

  // The corrections Kyle owes, across every live column. Not a fourth column:
  // these jobs still sit where their state puts them, and this is the list a
  // banner counts so the exception is visible rather than merely present.
  const needsProductionDate = live.filter((j) => j.productionDate?.needsCheck);
  return {
    today, tomorrow, upcoming, delivered,
    overdueCount: today.filter((j) => j.overdue).length,
    needsProductionDate,
  };
}
