"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireTaskAccess } from "@/lib/auth/guards";
import { editorForDeliverable, editorTeamMemberId, EDITOR_KEYS, type EditorKey } from "@/lib/editors";
import type { NotifyTarget } from "@/lib/notify";

// ---------------------------------------------------------------------------
// Server actions for the editor platform's /editing surface. Two things happen
// here that need to touch the DB:
//   · setEditVideoEditor — owner/admin reassign a video job to a different
//     editor (one-click select on the tracker row). Updates the edit_video
//     task's assignedKey AND Project.editorId when the new editor maps to a
//     TeamMember (Kim/Remar); externals (Luma) clear the link.
//   · sendEditToReview — the editor's "Done — send to review" primary action.
//     Completes their edit_video task, flips EDITING→REVIEW, and fires the
//     edit_finished bell to ADMIN (reusing the Frame.io handoff kind).
// Both fail-closed once auth is enforced (no-op in local dev).
// ---------------------------------------------------------------------------

// Reassign a video job to a different editor. Owner/admin only.
export async function setEditVideoEditor(projectId: string, editorKey: string): Promise<void> {
  await requireAdmin();
  if (!(EDITOR_KEYS as string[]).includes(editorKey)) throw new Error("Unknown editor.");
  const key = editorKey as EditorKey;

  // Re-route the open edit_video task to the new editor (there's one per project,
  // deduped edit-video-<projectId>). If none is open (e.g. already delivered),
  // this is a no-op — we still repoint the Project link below.
  await prisma.smartTask.updateMany({
    where: { projectId, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { assignedKey: key },
  });

  // Persist Project.editorId when the new editor is a linkable person; clear it
  // for externals/vendors (Luma) so the tracker doesn't show a stale name.
  const tmId = await editorTeamMemberId(key);
  await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId } });

  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: `Video edit reassigned to ${key}.` },
  });

  revalidatePath("/editing");
}

// The editor's "Done — send to review". Completes their edit_video task, flips
// the job EDITING→REVIEW, and pings ADMIN. Guarded by requireTaskAccess so the
// editor can only close a job that's actually routed to them (owner/admin also
// pass). Best-effort on the bell — never blocks the flip.
export async function sendEditToReview(projectId: string): Promise<void> {
  const task = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  // Access is keyed off the edit_video task (its assignedKey = the editor). If
  // there's no open task, fall back to admin — an owner/admin can always review.
  if (task) await requireTaskAccess(task.id);
  else await requireAdmin();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, status: true, clientId: true, deliverables: { select: { type: true, label: true } }, client: { select: { socialClient: true } } },
  });
  if (!project) throw new Error("Project not found.");

  // Complete the editor's work item.
  if (task) {
    await prisma.smartTask.update({
      where: { id: task.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  }

  // EDITING/SHOT → REVIEW (the cut is in, Kyle QCs next). Never demote a job
  // that's already past review (DELIVERED/REVIEW stays put).
  if (project.status === "EDITING" || project.status === "SHOT") {
    await prisma.project.update({ where: { id: projectId }, data: { status: "REVIEW" } });
    await prisma.activity.create({
      data: { projectId, type: "SYSTEM", body: "Editor sent the cut to review → moved to Review." },
    });
  }

  const street = (project.title || "this job").split(",")[0].trim();
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const v = project.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL") ?? project.deliverables[0];
    const editorKey = editorForDeliverable(v?.type, v?.label, !!project.client?.socialClient);
    const targets: NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
    if (editorKey) targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}` });
    await notifyInApp({
      kind: "edit_finished",
      title: `Edit ready for review — ${street}`,
      href: `/projects/${projectId}`,
      targets,
      // One announcement per send (a re-send after a revision is a new event).
      dedupeKey: `editdone-${projectId}-${Date.now()}`,
    });
  } catch { /* bell is best-effort */ }

  revalidatePath("/editing");
}
