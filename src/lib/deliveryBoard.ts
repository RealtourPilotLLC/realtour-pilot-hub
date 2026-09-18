import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etAddDays, etDayStartUtc } from "@/lib/datetime";
import { tierFor, dueAtFor, cappedByPromise, pinnedPromise, TIERS, type Tier } from "@/lib/turnaround";
import { parseEvidence, evidenceFreshness, type EvidenceFreshness, type ParsedEvidence } from "@/lib/statusEvidence";
import { isMonthlyContentJob } from "@/lib/pipeline";
// The product-name → category read and the category labels live in the light,
// client-safe qcCategories.ts (review, Sep 16): the only thing this board wanted
// from projectStatus.ts was one pure string function, and importing it pulled
// the whole status engine — Aryeo, Dropbox, connections — into /pipeline's chain.
import { categoryLabelsForLabel } from "@/lib/qcCategories";
import { pendingDuesByCategory, slaTierOf, OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { turnaroundRules } from "@/lib/settings";

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
  /** What that date is FOR — the product Kyle is actually chasing. */
  dueFor: string | null;
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
};

export type DeliveryBoard = {
  today: BoardJob[];
  tomorrow: BoardJob[];
  upcoming: BoardJob[];
  delivered: BoardJob[];
  overdueCount: number;
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
  appointments: { startAt: Date | null; status: string | null }[];
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
};

export type TurnaroundRuleSet = Awaited<ReturnType<typeof turnaroundRules>> | undefined;

// The clock starts at the shoot — that's when we take possession of the work.
// Monthly social content often has no shoot of its own, so its clock runs from
// now. Anything ELSE with no shoot date has no clock at all: an unscheduled
// BOOKED job used to anchor at `now` too, which made it "due tomorrow 5 PM"
// every single day — 775 Scotch Way sat in Due tomorrow for a week (audit, Sep
// 8 2026), padding Kyle's tomorrow count by one. It belongs in Upcoming,
// marked "no date", until it is on the calendar.
function clockStart(p: Pick<PromiseInput, "shootDate" | "deliverables" | "packageName">, now: Date): Date | null {
  return p.shootDate ?? (isMonthlyContentJob(p.deliverables, p.packageName) ? now : null);
}

/** Every ordered product with its own tier and promise — the "n products
 *  ordered" list on the card, and the raw material for the date below. */
export function boardItems(
  p: Pick<PromiseInput, "shootDate" | "deliverables" | "packageName" | "orderItems">,
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
  const at = cappedByPromise(earliest?.dueAt ?? null, pin);
  const capped = !!at && !!earliest && at.getTime() !== earliest.dueAt.getTime();
  return {
    at,
    label: earliest?.title ?? null,
    tierLabel: capped ? "as promised" : earliest?.tierLabel ?? null,
    office: false,
    pinned: capped,
    reason: p.promisedReason ?? null,
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
  p: { status: string; shootDate: Date | null; deliveredAt: Date | null; revisionRequestedAt: Date | null },
  deliverables: { type: string; status: string; uploadedAt: Date | null }[],
  /** the status engine's own answer — categories ordered but not live on
   *  Aryeo. Null when the job has no evidence yet (then the rows decide). */
  missingCategories: string[] | null,
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
  // "With the editor" only once the editor has said so (status EDITING — the
  // queue pill). Files in on a SHOT job are footage waiting to be picked up,
  // and the board used to call that editing (Jordan, Sep 10).
  if (p.status === "EDITING") return { kind: "editing", label: "With the editor" };
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
      appointments: { select: { assignedTo: { select: { name: true } }, startAt: true, status: true }, orderBy: { startAt: "asc" } },
    },
    orderBy: { shootDate: "desc" },
    take: 400,
  });

  const jobs: BoardJob[] = rows.map((p) => {
    const items = boardItems(p, now, turnarounds);

    const ev = parseEvidence(p.statusEvidence);
    const missingCategories = ev ? ev.missing : null;
    const { kind, label } = blockerFor(p, p.deliverables, missingCategories);
    // THE OBLIGATION, once, for the column, the promise and the card.
    const settled = isSettled(p);
    const openAsk = !settled && hasOpenRevision(p);
    const reopened = !settled && !!p.deliveredAt;

    // The promise — the same function the project page's Status check card
    // reads, so the two screens can never call a job late on different days
    // (review, Sep 16).
    const promise = outstandingPromise(p, { now, turnarounds, evidence: ev });
    const dueAt = promise.at;

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
      dueFor: promise.label,
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
      const owedNoClock = (j: BoardJob) => (!j.dueAt && (j.blocker === "revision" || j.blocker === "on_hold") ? 0 : 1);
      return owedNoClock(a) - owedNoClock(b) || byDue(a, b);
    });
  // The delivered tail. Sorted on the stamp where there is one — a terminal
  // row with no stamp (four 2022 imports) has no place in a ten-day tail and
  // is already filtered out by the query.
  const delivered = jobs
    .filter((j) => j.settled)
    .sort((a, b) => (b.deliveredAt?.getTime() ?? 0) - (a.deliveredAt?.getTime() ?? 0));

  return { today, tomorrow, upcoming, delivered, overdueCount: today.filter((j) => j.overdue).length };
}
