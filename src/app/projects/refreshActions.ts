"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireShootAccess } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------
// "Refresh from Aryeo" — pull THIS job's live truth on demand.
//
// Everything already reaches the hub two ways: the hourly cron and the Aryeo
// webhooks. But a webhook can be missed (or not registered for a verb), and the
// cron's incremental pass only walks a 45-day window — so a listing whose media
// or appointment changed a minute ago, or an older job that changed at all, can
// read stale on screen. This is the manual "no, check right now" button.
//
// It reuses the SAME engines the webhook uses, in the same order, so there is
// no second implementation to drift:
//   1. the order itself  — line items, price, payment status, cancels, client
//   2. appointments      — times, reschedules, who is assigned
//   3. the status engine — live Aryeo media + Dropbox → stage, cover, evidence
//   4. the task engine   — QC/delivery tasks reconcile to the new truth
// ---------------------------------------------------------------------------

export type RefreshResult = {
  ok: boolean;
  message: string;
  status?: string;
  shootISO?: string | null;
  photographer?: string | null;
  media?: { photos: number; videos: number; floorPlans: number; interactive: number } | null;
  changed?: string[];
};

export async function refreshFromAryeo(projectId: string): Promise<RefreshResult> {
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const before = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, status: true, shootDate: true, price: true, paymentStatus: true,
      aryeoOrderId: true, aryeoListingId: true, statusEvidence: true,
      photographer: { select: { name: true } },
      _count: { select: { deliverables: true, appointments: true } },
    },
  });
  if (!before) return { ok: false, message: "Project not found." };
  if (!before.aryeoOrderId && !before.aryeoListingId) {
    return { ok: false, message: "This job didn't come from Aryeo, so there's nothing to pull." };
  }

  try {
    const { syncAryeoOrders, syncAryeoAppointments } = await import("@/lib/integrations/aryeo");

    // 1. The order — scoped to this one, so it's a single API call.
    if (before.aryeoOrderId) {
      const r = await syncAryeoOrders({ orderId: before.aryeoOrderId });
      if (r.missing) {
        return {
          ok: false,
          message: "This order no longer exists in Aryeo (deleted or archived there). Cancel the job here, put it on hold as a manual job, or update its Aryeo order id if it was re-created.",
        };
      }
    }
    // 2. Appointments — scoped to this order (times, reschedules, assignee).
    //    Walking the bounded list instead costs ~53s; this is ~1s.
    if (before.aryeoOrderId) {
      await syncAryeoAppointments({ orderId: before.aryeoOrderId }).catch(() => null);
    }

    // 3. Media + stage, live off the listing (this also refreshes the cover
    //    image and flips each deliverable as its category goes live).
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    await syncProjectStatuses({ projectId });

    // 4. Tasks follow the new truth (QC opens/closes, delivery due moves).
    try {
      const { generateTasksForProject } = await import("@/lib/tasks");
      await generateTasksForProject(projectId);
    } catch { /* task reconcile is best-effort */ }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Aryeo didn't answer.";
    return { ok: false, message: `Couldn't reach Aryeo — ${msg.slice(0, 140)}` };
  }

  const after = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      status: true, shootDate: true, price: true, paymentStatus: true, statusEvidence: true,
      aryeoListingId: true,
      photographer: { select: { name: true } },
      _count: { select: { deliverables: true, appointments: true } },
    },
  });
  if (!after) return { ok: false, message: "Project not found after refresh." };

  // Tell the owner what actually moved — a refresh that silently changes
  // nothing is indistinguishable from a broken button.
  const changed: string[] = [];
  const fmt = (d: Date | null) =>
    d ? d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "none";
  // THE LISTING LINK (Sep 16, Kyle call — 39 Saratoga Ln). It is the single
  // biggest thing this button can fix and it used to be invisible: the job had
  // no listing id, so there was no media to compare, so the button reported
  // "Up to date" on a page showing "Photos missing" beside 77 delivered
  // photos. Report it first, and say what it bought us.
  const listingLinked = !before.aryeoListingId && !!after.aryeoListingId;
  if (listingLinked) changed.push("Listing linked");
  if (before.status !== after.status) changed.push(`stage ${before.status} → ${after.status}`);
  if ((before.shootDate?.getTime() ?? 0) !== (after.shootDate?.getTime() ?? 0)) {
    changed.push(`shoot ${fmt(before.shootDate)} → ${fmt(after.shootDate)}`);
  }
  if ((before.photographer?.name ?? null) !== (after.photographer?.name ?? null)) {
    changed.push(`photographer ${before.photographer?.name ?? "unassigned"} → ${after.photographer?.name ?? "unassigned"}`);
  }
  if (Math.abs((before.price ?? 0) - (after.price ?? 0)) > 0.005) {
    changed.push(`invoice $${(before.price ?? 0).toFixed(2)} → $${(after.price ?? 0).toFixed(2)}`);
  }
  if ((before.paymentStatus ?? null) !== (after.paymentStatus ?? null)) {
    changed.push(`payment ${before.paymentStatus ?? "—"} → ${after.paymentStatus ?? "—"}`);
  }
  // Retire-not-delete keeps the row count constant, so an item removed from
  // (or restored to) the order would otherwise report "Up to date" — read the
  // reconcile's own activity row from this refresh instead.
  const orderChange = await prisma.activity.findFirst({
    where: { projectId, type: "SYSTEM", body: { startsWith: "Order changed in Aryeo" }, createdAt: { gte: new Date(Date.now() - 2 * 60_000) } },
    select: { body: true },
    orderBy: { createdAt: "desc" },
  });
  if (orderChange) changed.push(orderChange.body.replace(/^Order changed in Aryeo \(#[^)]*\): /, "order items: ").replace(/\.$/, ""));
  if (before._count.deliverables !== after._count.deliverables) {
    changed.push(`${after._count.deliverables - before._count.deliverables > 0 ? "+" : ""}${after._count.deliverables - before._count.deliverables} order items`);
  }
  if (before._count.appointments !== after._count.appointments) {
    changed.push(`${after._count.appointments - before._count.appointments > 0 ? "+" : ""}${after._count.appointments - before._count.appointments} appointments`);
  }

  const parse = (raw: string | null) => {
    try {
      return JSON.parse(raw ?? "{}") as {
        aryeo?: { photos?: number; videos?: number; floorPlans?: number; interactive?: number };
        missing?: string[];
      };
    } catch { return {}; }
  };
  const e0 = parse(before.statusEvidence);
  const e1 = parse(after.statusEvidence);
  const a0 = e0.aryeo ?? {};
  const a1 = e1.aryeo ?? {};
  const media = {
    photos: a1.photos ?? 0, videos: a1.videos ?? 0,
    floorPlans: a1.floorPlans ?? 0, interactive: a1.interactive ?? 0,
  };
  const noun = (k: string) => (k === "floorPlans" ? "floor plans" : k === "interactive" ? "3D/tour items" : k);
  const mediaDelta = (["photos", "videos", "floorPlans", "interactive"] as const)
    .map((k) => ({ k, d: (a1[k] ?? 0) - (a0[k] ?? 0) }))
    .filter((x) => x.d !== 0);
  for (const m of mediaDelta) {
    // After a link the delta is not "77 new photos arrived" — they were always
    // there. Say what actually changed: the hub can see them now.
    changed.push(listingLinked && m.d > 0 ? `${m.d} ${noun(m.k)} now visible` : `${m.d > 0 ? "+" : ""}${m.d} ${noun(m.k)}`);
  }
  // What the cross-check can no longer confirm — or has stopped complaining
  // about. On a delivered job this is the whole point of pressing the button.
  const m0 = e0.missing ?? [];
  const m1 = e1.missing ?? [];
  if (m0.join("|") !== m1.join("|")) {
    // "Still missing" is only true when the list SHRANK — a list that grew is
    // news, and calling it "still" would bury it (Sep 16 review).
    const grew = m1.some((c) => !m0.includes(c));
    changed.push(
      m1.length === 0
        ? `nothing missing now (was ${m0.join(", ")})`
        : `${grew ? "now" : "still"} missing ${m1.join(", ")}`,
    );
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/shoot/${projectId}`);
  revalidatePath(`/upload/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/schedule");

  return {
    ok: true,
    message: changed.length ? `Updated — ${changed.join(" · ")}` : "Up to date — Aryeo matches what you're seeing.",
    status: after.status,
    shootISO: after.shootDate ? after.shootDate.toISOString() : null,
    photographer: after.photographer?.name ?? null,
    media,
    changed,
  };
}
