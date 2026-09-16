import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etAddDays, etDayStartUtc } from "@/lib/datetime";
import { tierFor, dueAtFor, type Tier } from "@/lib/turnaround";
import { parseEvidence } from "@/lib/statusEvidence";
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
  };
  notes: string | null;
  deliveredAt: Date | null;
};

export type DeliveryBoard = {
  today: BoardJob[];
  tomorrow: BoardJob[];
  upcoming: BoardJob[];
  delivered: BoardJob[];
  overdueCount: number;
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

/**
 * What is holding this job up, in the words Kyle would use.
 *
 * ONE answer, most-blocking first. A card listing six half-true states is what
 * makes a board unreadable — you end up reading every card to find the one
 * thing that needs doing.
 */
function blockerFor(
  p: { status: string; shootDate: Date | null; deliveredAt: Date | null },
  deliverables: { type: string; status: string; uploadedAt: Date | null }[],
  /** the status engine's own answer — categories ordered but not live on
   *  Aryeo. Null when the job has no evidence yet (then the rows decide). */
  missingCategories: string[] | null,
): { kind: BlockerKind; label: string } {
  if (p.deliveredAt) return { kind: "delivered", label: "Delivered" };
  if (p.status === "ON_HOLD") return { kind: "on_hold", label: "On hold" };
  // Neutral: a revision is the client's ask OR the owner bouncing a cut in review.
  if (p.status === "REVISION") return { kind: "revision", label: "Changes requested" };

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
      OR: [
        { deliveredAt: null },
        // A short delivered tail, so Kyle can confirm what just went out.
        { deliveredAt: { gte: etAddDays(etDayStartUtc(), -10) } },
      ],
    },
    select: {
      id: true, title: true, addressLine: true, city: true, status: true,
      shootDate: true, deliveredAt: true, notes: true,
      packageName: true, // monthly-content detection (the one job kind whose clock runs without a shoot)
      dueOverrideAt: true, // the office's due for the job (Sep 13, editOverrides.ts) — wins over every promise below
      tierOverride: true, // the office's tier (Sep 16) — branding → the monthly window, premium → 72h
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
    // The clock starts at the shoot — that's when we take possession of the
    // work. Monthly social content often has no shoot of its own, so its clock
    // runs from now. Anything ELSE with no shoot date has no clock at all: an
    // unscheduled BOOKED job used to anchor at `now` too, which made it "due
    // tomorrow 5 PM" every single day — 775 Scotch Way sat in Due tomorrow
    // for a week (audit, Sep 8 2026), padding Kyle's tomorrow count by one. It
    // belongs in Upcoming, marked "no date", until it is on the calendar.
    const monthly = isMonthlyContentJob(p.deliverables, p.packageName);
    const startedAt = p.shootDate ?? (monthly ? now : null);
    const items: BoardItem[] = p.orderItems.map((oi) => {
      const tier: Tier = tierFor(oi.title);
      return { title: oi.title, quantity: oi.quantity, tierLabel: tier.label, dueAt: startedAt ? dueAtFor(tier, startedAt) : null };
    });

    const ev = parseEvidence(p.statusEvidence);
    const missingCategories = ev ? ev.missing : null;
    const { kind, label } = blockerFor(p, p.deliverables, missingCategories);

    // ---- THE EARLIEST OUTSTANDING PROMISE (Kyle call, Sep 16) -------------
    // The header has always said "a job's due date is the EARLIEST outstanding
    // item", but the code took the min over EVERY item — so a job whose photos
    // went out on time read LATE for the photo promise while the thing actually
    // owed (the video) sat two days out. An item is settled when every category
    // it implies is live on Aryeo; an item the label parser can't classify
    // ("Social Influencer") stays outstanding, because we can't prove it's done.
    const dated = items.filter((i): i is BoardItem & { dueAt: Date } => i.dueAt !== null);
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
            monthlyContent: monthly,
            turnarounds,
            // The office's tier, same ladder as the QC card and the status
            // engine (Sep 16) — a job re-sold as a branding package must not
            // keep reading LATE here on a 48h reel clock.
            tier: slaTierOf(p),
            appointments: p.appointments,
          }).filter((d) => missingCategories.includes(d.category))
        : [];
    const earliestItem = p.deliveredAt || outstandingItems.length === 0
      ? null
      : outstandingItems.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
    const earliestCategory = p.deliveredAt || categoryDues.length === 0 ? null : categoryDues[0];
    // Nothing outstanding at all (every category live, nothing to date): the
    // job is between QC and delivery — keep the old whole-order date so the
    // card still says when it was promised rather than falling into Upcoming.
    const fallback = p.deliveredAt || dated.length === 0 ? null : dated.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
    const earliest = earliestItem ?? (earliestCategory ? { title: earliestCategory.category, tierLabel: null as string | null, dueAt: earliestCategory.at } : fallback);
    // THE OFFICE'S DUE (Sep 13, editOverrides.ts): when Jordan set a date on
    // the job, that is the promise Kyle is chasing — it replaces the earliest
    // product promise and is labelled as the office's, not a tier's. A
    // delivered job has no outstanding promise either way.
    const officeDue = !p.deliveredAt && p.dueOverrideAt ? p.dueOverrideAt : null;
    const dueAt = officeDue ?? earliest?.dueAt ?? null;

    return {
      id: p.id,
      title: (p.title || "Untitled job").split(",")[0].trim(),
      address: [p.addressLine, p.city].filter(Boolean).join(", ") || null,
      client: p.client?.name ?? null,
      status: p.status,
      shootDate: p.shootDate,
      photographer: p.appointments[0]?.assignedTo?.name ?? null,
      dueAt,
      dueTierLabel: officeDue ? "office override" : earliest?.tierLabel ?? null,
      dueFor: officeDue ? earliest?.title ?? "the whole job" : earliest?.title ?? null,
      overdue: !!dueAt && dueAt < now,
      blocker: kind,
      blockerLabel: label,
      items,
      photos: uploadState(p.deliverables.filter((d) => PHOTOISH.has(d.type))),
      video: uploadState(p.deliverables.filter((d) => VIDEOISH.has(d.type))),
      media: (() => {
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
        };
      })(),
      notes: p.notes?.trim() || null,
      deliveredAt: p.deliveredAt,
    };
  });

  const live = jobs.filter((j) => !j.deliveredAt);
  const byDue = (a: BoardJob, b: BoardJob) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity);

  // Overdue rides in Today. A day late is more urgent than due-at-5pm, and a
  // separate Overdue tab is a tab nobody opens until it's already too late.
  const today = live.filter((j) => j.dueAt && etDayKey(j.dueAt) <= todayKey).sort(byDue);
  const tomorrow = live.filter((j) => j.dueAt && etDayKey(j.dueAt) === tomorrowKey).sort(byDue);
  const upcoming = live.filter((j) => !j.dueAt || etDayKey(j.dueAt) > tomorrowKey).sort(byDue);
  const delivered = jobs.filter((j) => j.deliveredAt).sort((a, b) => b.deliveredAt!.getTime() - a.deliveredAt!.getTime());

  return { today, tomorrow, upcoming, delivered, overdueCount: today.filter((j) => j.overdue).length };
}
