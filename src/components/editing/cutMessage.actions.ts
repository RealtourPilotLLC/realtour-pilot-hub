"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { slugForName } from "@/lib/assignees";

// ---------------------------------------------------------------------------
// The editor's message that travels WITH a cut — Jordan, Sep 2: "no border
// version", "client's logo added", "couldn't fix the audio at 0:42".
//
// NOTHING NEW IS STORED: it writes ReviewSubmission.note, the column the
// folder-submit path (submitCutForReview) has always filled, which the Review
// Room already prints next to the cut — the queue row on /review and the
// quoted line above the player on /review/<id>. The upload path just never had
// a way to fill it, so the field sat empty for every cut sent the new way.
//
// It lives beside the editor's screen rather than in /app/review/actions.ts
// only because that file belongs to another lane this week. The guard is the
// SAME rule startCutUpload's uploadAuthor applies — owner/admin always, an
// EDITOR only on a job that is really on their queue — plus the "your own cut"
// escape addCutNote uses, because uploading COMPLETES the edit task and
// without it an editor could never correct the message they just sent.
// ---------------------------------------------------------------------------
export async function saveCutMessage(
  submissionId: string,
  message: string,
): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, submittedByKey: true },
  });
  if (!row) return { ok: false, message: "That cut no longer exists." };

  const me = await getCurrentUser().catch(() => null);
  // Same rule as requireRole: a null viewer is only ever local dev with auth off.
  if (!me && authEnforced()) return { ok: false, message: "Sign in to leave a message on a cut." };
  if (me?.impersonating) {
    return { ok: false, message: "You're previewing another user — exit the preview to make changes." };
  }
  if (me && !["OWNER", "ADMIN", "EDITOR"].includes(me.role)) {
    return { ok: false, message: "Only editors, admins and the owner can message a cut." };
  }
  if (me?.role === "EDITOR") {
    const key = me.editorKey ?? (me.name ? slugForName(me.name) : null);
    const ownsCut = !!key && row.submittedByKey === key;
    if (!ownsCut) {
      const mine = await prisma.smartTask.findFirst({
        where: {
          projectId: row.projectId,
          taskType: { in: ["edit_video", "revision"] },
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          assignedKey: key ?? "__none__",
        },
        select: { id: true },
      });
      if (!mine) {
        return { ok: false, message: "This job isn't on your queue — ask Kyle or Jordan to assign it to you first." };
      }
    }
  }

  // Same 1,000-char clamp the folder-submit path uses, so one column can never
  // hold two shapes of value.
  await prisma.reviewSubmission.update({
    where: { id: submissionId },
    data: { note: message.trim().slice(0, 1000) || null },
  });
  revalidatePath("/review");
  revalidatePath(`/review/${row.projectId}`);
  revalidatePath(`/edit/${row.projectId}`);
  return { ok: true, message: "Saved — the reviewer sees this with the cut." };
}
