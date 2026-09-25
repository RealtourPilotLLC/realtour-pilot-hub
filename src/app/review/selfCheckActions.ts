"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireCutReviewer } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import type { SelfCheckInput, SelfCheckItem } from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// THE EDITOR'S SELF-CHECK — the doors that are not an upload (§8.2, Sep 25).
//
// An upload carries its check on startCutUpload, and the Final-folder button
// on submitCutForReview. This file is the third way in: FINISHING the check on
// a cut that already exists but is held — found by the folder sweep, an upload
// whose bytes were not the file that was checked, a cut moved to another job.
// The editor whose cut it is, or the office on their behalf (recorded as the
// office, for the editor named). Nothing here can rule on a cut.
// ---------------------------------------------------------------------------

type Actor = { name: string; userId: string | null; editorKey: string | null; office: boolean };

async function checkActorFor(row: { projectId: string; submittedByKey: string | null }): Promise<{ ok: true; actor: Actor } | { ok: false; message: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (!authEnforced()) return { ok: true, actor: { name: "Local dev", userId: null, editorKey: null, office: true } };
    return { ok: false, message: "Sign in to finish the check." };
  }
  if (me.impersonating) return { ok: false, message: "You're previewing another user — exit the preview to make changes." };
  if (me.realRole === "OWNER" || me.realRole === "ADMIN") {
    return { ok: true, actor: { name: me.name ?? me.email, userId: me.id, editorKey: null, office: true } };
  }
  if (me.realRole !== "EDITOR") return { ok: false, message: "Only the editor, Kyle or Jordan can finish this check." };
  const key = me.editorKey ?? (me.name ? slugForName(me.name) : null);
  if (!key) return { ok: false, message: "Your account is not linked to an editor profile yet — ask Jordan or Kyle." };
  // THEIR cut, or an unclaimed one on a job they hold — the same scope an
  // upload has (review/actions.uploadAuthor).
  if (row.submittedByKey && row.submittedByKey !== key) return { ok: false, message: "That cut was handed in by another editor." };
  if (!row.submittedByKey) {
    const mine = await prisma.smartTask.findFirst({
      where: { projectId: row.projectId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] }, assignedKey: key },
      select: { id: true },
    });
    if (!mine) return { ok: false, message: "This job isn't on your queue — ask Kyle or Jordan to assign it to you first." };
  }
  return { ok: true, actor: { name: me.name ?? me.email, userId: me.id, editorKey: key, office: false } };
}

/** Finish the check on a held cut and send it to review. */
export async function submitSelfCheck(
  submissionId: string,
  input: SelfCheckInput,
): Promise<{ ok: boolean; message: string; needsSelfCheck?: boolean }> {
  if (typeof submissionId !== "string" || !submissionId) return { ok: false, message: "Which cut?" };
  const row = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, status: true, assetPath: true, blobUrl: true, movedAt: true, submittedByKey: true, selfCheckId: true, selfCheckedAt: true },
  });
  if (!row) return { ok: false, message: "That cut no longer exists." };
  const who = await checkActorFor(row);
  if (!who.ok) return who;
  const { isHeldForSelfCheck } = await import("@/lib/selfCheck");
  if (!isHeldForSelfCheck(row)) return { ok: true, message: row.status === "PENDING" ? "Already in review." : "That version isn't waiting on a check any more." };
  // A Final-folder cut (not moved) goes through the editor's own button, which
  // owns its close-out — the same gate, the same single entry.
  if (row.assetPath && !row.blobUrl && !row.movedAt) {
    const { submitCutForReview } = await import("@/app/review/actions");
    const r = await submitCutForReview(row.projectId, undefined, input, { submissionId: row.id });
    return { ok: r.ok, message: r.message, needsSelfCheck: r.needsSelfCheck };
  }
  const { attestAndEnter } = await import("@/lib/selfCheckStore");
  const r = await attestAndEnter(row.id, input, who.actor);
  revalidatePath(`/edit/${row.projectId}`);
  revalidatePath(`/review/${row.projectId}`);
  revalidatePath("/review");
  revalidatePath("/editing");
  return { ok: r.ok, message: r.message, needsSelfCheck: r.needsSelfCheck };
}

/**
 * James (or Jordan) refines a product's checklist (§8.2: "James can refine
 * checklist requirements by product"). A refinement is a NEW VERSION: checks
 * already given keep the list they were given under. "Watched the actual
 * export" cannot be removed — resolveSelfCheckProfile puts it back.
 */
export async function saveSelfCheckProfile(
  styleKey: string,
  items: SelfCheckItem[],
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireCutReviewer();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { DEFAULT_SELF_CHECK } = await import("@/lib/selfCheck");
  if (!DEFAULT_SELF_CHECK[styleKey]) return { ok: false, message: "Unknown product." };
  const clean = (Array.isArray(items) ? items : [])
    .filter((i) => i && typeof i.key === "string" && typeof i.label === "string" && i.label.trim().length >= 8)
    .slice(0, 20)
    .map((i) => ({
      key: i.key.replace(/[^a-z0-9_]/gi, "_").slice(0, 40) || "item",
      label: i.label.trim().slice(0, 240),
      help: typeof i.help === "string" && i.help.trim() ? i.help.trim().slice(0, 300) : undefined,
      naAllowed: !!i.naAllowed,
      naHint: typeof i.naHint === "string" && i.naHint.trim() ? i.naHint.trim().slice(0, 160) : undefined,
      when: i.when === "revision" ? ("revision" as const) : ("always" as const),
    }));
  if (clean.length < 3) return { ok: false, message: "Keep at least three lines on the list." };
  const { selfCheckOverrides, SELF_CHECK_SETTING } = await import("@/lib/selfCheckStore");
  const { putSetting } = await import("@/lib/settings");
  const { resolveSelfCheckProfile } = await import("@/lib/selfCheck");
  const current = await selfCheckOverrides();
  const was = resolveSelfCheckProfile(styleKey, current);
  const me = await getCurrentUser().catch(() => null);
  await putSetting(SELF_CHECK_SETTING, { ...current, [styleKey]: { version: was.version + 1, items: clean } }, me?.name ?? me?.email ?? null);
  revalidatePath("/quality");
  return { ok: true, message: `Saved as version ${was.version + 1} — new checks use it; earlier ones keep theirs.` };
}
