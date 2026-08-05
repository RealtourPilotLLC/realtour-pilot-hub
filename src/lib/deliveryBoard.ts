import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etAddDays, etDayStartUtc } from "@/lib/datetime";
import { tierFor, dueAtFor, type Tier } from "@/lib/turnaround";

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
  | "editing" | "qc" | "ready" | "delivered";

export type BoardItem = { title: string; quantity: number; tierLabel: string; dueAt: Date };

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

/** none = nothing in, some = partially in, in = all of that kind uploaded. */
function uploadState(rows: { uploadedAt: Date | null }[]): "none" | "some" | "in" | "n/a" {
  if (rows.length === 0) return "n/a";
  const up = rows.filter((r) => r.uploadedAt).length;
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
): { kind: BlockerKind; label: string } {
  if (p.deliveredAt) return { kind: "delivered", label: "Delivered" };
  if (p.status === "ON_HOLD") return { kind: "on_hold", label: "On hold" };
  if (p.status === "REVISION") return { kind: "revision", label: "Client asked for changes" };

  const now = new Date();
  if (!p.shootDate || p.shootDate > now) {
    return { kind: "not_shot", label: p.shootDate ? "Not shot yet" : "No shoot date" };
  }

  const missing = deliverables.filter((d) => !d.uploadedAt);
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

  if (p.status === "REVIEW") return { kind: "qc", label: "Needs QC" };
  if (deliverables.length > 0 && deliverables.every((d) => d.status === "DONE")) {
    return { kind: "ready", label: "Ready to deliver" };
  }
  return { kind: "editing", label: "With the editor" };
}

/** One query for the whole board — this screen is open all day and must not fan out. */
export async function deliveryBoard(): Promise<DeliveryBoard> {
  const now = new Date();
  const todayKey = etDayKey(now);
  const tomorrowKey = etDayKey(etAddDays(now, 1));

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
      client: { select: { name: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { select: { type: true, status: true, uploadedAt: true } },
      appointments: { select: { assignedTo: { select: { name: true } } }, orderBy: { startAt: "asc" }, take: 1 },
    },
    orderBy: { shootDate: "desc" },
    take: 400,
  });

  const jobs: BoardJob[] = rows.map((p) => {
    // The clock starts at the shoot — that's when we take possession of the
    // work. Monthly social content often has no shoot of its own.
    const startedAt = p.shootDate ?? now;
    const items: BoardItem[] = p.orderItems.map((oi) => {
      const tier: Tier = tierFor(oi.title);
      return { title: oi.title, quantity: oi.quantity, tierLabel: tier.label, dueAt: dueAtFor(tier, startedAt) };
    });

    const { kind, label } = blockerFor(p, p.deliverables);
    const earliest = p.deliveredAt || items.length === 0
      ? null
      : items.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));

    return {
      id: p.id,
      title: (p.title || "Untitled job").split(",")[0].trim(),
      address: [p.addressLine, p.city].filter(Boolean).join(", ") || null,
      client: p.client?.name ?? null,
      status: p.status,
      shootDate: p.shootDate,
      photographer: p.appointments[0]?.assignedTo?.name ?? null,
      dueAt: earliest?.dueAt ?? null,
      dueTierLabel: earliest?.tierLabel ?? null,
      dueFor: earliest?.title ?? null,
      overdue: !!earliest && earliest.dueAt < now,
      blocker: kind,
      blockerLabel: label,
      items,
      photos: uploadState(p.deliverables.filter((d) => PHOTOISH.has(d.type))),
      video: uploadState(p.deliverables.filter((d) => VIDEOISH.has(d.type))),
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
