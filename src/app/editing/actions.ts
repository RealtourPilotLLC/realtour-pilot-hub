"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { editorTeamMemberId, EDITOR_KEYS, type EditorKey } from "@/lib/editors";

// ---------------------------------------------------------------------------
// Server actions for the editor platform's /editing surface.
//   · setEditVideoEditor — owner/admin reassign a video job to a different
//     editor (one-click select on the tracker row). Updates the edit_video
//     task's assignedKey AND Project.editorId when the new editor maps to a
//     TeamMember (Kim/Remar); externals (Luma) clear the link.
// The editor's "Done — send to review" action moved to
// src/app/review/actions.ts (submitCutForReview) — see the note at the bottom.
// Fail-closed once auth is enforced (no-op in local dev).
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

// The editor's "Done — send to review" now lives in src/app/review/actions.ts
// (submitCutForReview): it does everything the old action here did PLUS parks
// the actual cut (a streamable Dropbox link) in the owner's Review Room at
// /review, so the reviewer watches it in-house instead of hunting folders.
