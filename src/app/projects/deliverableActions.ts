"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { TYPE_CATEGORY_LABEL } from "@/lib/qcCategories";

// ---------------------------------------------------------------------------
// "NOT REQUIRED ON THIS JOB" — the office's waiver (Sep 16, Kyle call).
//
// Two live jobs sat in Review for a fortnight over a floor plan nobody was
// ever going to deliver: 195 Woodhill Rd (discounted off the Essentials
// Package) and 68 New St (moved to the 2 Grace Cir order). Nothing on the
// Aryeo order said so — the package still implies a floor plan — so the order
// reconcile could never retire the row, and clearing it took Kyle a
// mark-handled on the chase, a hand-close of the QC card, and a hand-move to
// Delivered. Three presses, none of which fixed the evidence.
//
// The waiver is a first-class hub fact, deliberately separate from
// removedFromOrderAt (which Aryeo owns and un-retires the moment a package
// implies the type again). Every "owed" reader honours it through ONE shared
// filter — tasks.OWED_DELIVERABLE_WHERE — so the item stops being missing on
// the home QC card, the delivery board, the editor brief, the status card and
// the confirmation text at the same moment.
//
// What it does NOT do: move the job. Waiving a floor plan on a job still
// waiting for its reel leaves it exactly where it was — the next status sweep
// simply stops counting a category nobody owes. And the row is never deleted:
// who waived it, when, and why stay on the job forever.
// ---------------------------------------------------------------------------

export type WaiveResult = { ok: boolean; message: string };

async function loadDeliverable(deliverableId: string) {
  return prisma.deliverable.findUnique({
    where: { id: deliverableId },
    select: {
      id: true, type: true, label: true, waivedAt: true, waivedBy: true, waivedNote: true,
      removedFromOrderAt: true, notCompletedReason: true,
      project: { select: { id: true, title: true } },
    },
  });
}

const categoryOf = (type: string) => TYPE_CATEGORY_LABEL[type] ?? type;

export async function waiveDeliverable(deliverableId: string, note: string): Promise<WaiveResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const d = await loadDeliverable(deliverableId);
  if (!d?.project) return { ok: false, message: "That item no longer exists." };
  if (d.waivedAt) return { ok: true, message: "Already marked not required." };

  const who = (await getCurrentUser().catch(() => null))?.name?.trim() || "the office";
  // A reason is not optional: this row is the only record of why the client
  // never got something they ordered, and "no reason given" is what made
  // Kyle re-litigate 195 Woodhill three times.
  const reason = note.trim().slice(0, 300);
  if (!reason) return { ok: false, message: "Say why it isn't required — that note is the record." };

  await prisma.deliverable.update({
    where: { id: d.id },
    data: { waivedAt: new Date(), waivedBy: who, waivedNote: reason },
  });

  const label = d.label ?? d.type;
  await prisma.activity.create({
    data: {
      projectId: d.project.id,
      type: "SYSTEM",
      body: `“${label}” marked not required on this job by ${who} — ${reason}`.slice(0, 1000),
    },
  }).catch(() => {});

  // The vendor we were chasing for it, and the question we asked the office
  // about the photographer's note, are both answered by this.
  try {
    const { cancelVendorChaseFor, confirmNotRequiredTask } = await import("@/lib/tasks");
    await cancelVendorChaseFor(d.project.id, categoryOf(d.type));
    await confirmNotRequiredTask(d.id);
  } catch { /* task cleanup is best-effort */ }

  await recomputeAfterWaiver(d.project.id);
  return { ok: true, message: `${categoryOf(d.type)} is no longer counted as owed on this job.` };
}

export async function unwaiveDeliverable(deliverableId: string): Promise<WaiveResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const d = await loadDeliverable(deliverableId);
  if (!d?.project) return { ok: false, message: "That item no longer exists." };
  if (!d.waivedAt) return { ok: true, message: "It was already owed." };

  const who = (await getCurrentUser().catch(() => null))?.name?.trim() || "the office";
  await prisma.deliverable.update({
    where: { id: d.id },
    data: { waivedAt: null, waivedBy: null, waivedNote: null },
  });
  await prisma.activity.create({
    data: {
      projectId: d.project.id,
      type: "SYSTEM",
      body: `“${d.label ?? d.type}” is owed again — ${who} undid the “not required” mark${d.waivedNote ? ` (was: ${d.waivedNote})` : ""}.`.slice(0, 1000),
    },
  }).catch(() => {});

  await recomputeAfterWaiver(d.project.id);
  return { ok: true, message: `${categoryOf(d.type)} is counted as owed again.` };
}

// Re-run the ONE status engine so the evidence, the deliverable rows and the
// job's tasks all agree within the same press — rather than leaving the card
// contradicting itself until the next hourly sweep (the gap Kyle hit). The
// engine's own guards decide the status: a hand-delivered job stays delivered,
// a job still owing its reel stays in Review.
async function recomputeAfterWaiver(projectId: string) {
  try {
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    await syncProjectStatuses({ projectId });
  } catch { /* the hourly sweep is the backstop */ }
  try {
    const { generateTasksForProject } = await import("@/lib/tasks");
    await generateTasksForProject(projectId);
  } catch { /* task reconcile is best-effort */ }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/upload/${projectId}`);
  revalidatePath("/");
  revalidatePath("/ops");
  revalidatePath("/tracker");
}
