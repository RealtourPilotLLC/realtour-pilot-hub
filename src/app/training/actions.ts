"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth/guards";

export type ShareResult = { ok: boolean; token?: string | null; message?: string };

// Mint (or reveal) a public share link for a training lesson, or revoke it.
// Owner-only: a public link makes the lesson's video + summary viewable with no
// login, so only Jordan can create one. The token is an unguessable UUID; the
// public page (/learn/<token>) shows video + summary but never the verbatim
// transcript. Revoking clears the token — the old link 404s immediately.
export async function setLessonShare(lessonId: string, share: boolean): Promise<ShareResult> {
  await requireOwner();
  const lesson = await prisma.trainingLesson.findUnique({
    where: { id: lessonId },
    select: { id: true, shareToken: true },
  });
  if (!lesson) return { ok: false, message: "Lesson not found." };

  if (!share) {
    await prisma.trainingLesson.update({ where: { id: lessonId }, data: { shareToken: null, sharedAt: null } });
    revalidatePath("/training");
    return { ok: true, token: null };
  }

  // Idempotent: keep the existing link if one's already been made (so a shared
  // URL stays stable), otherwise mint a fresh token.
  const token = lesson.shareToken ?? randomUUID();
  if (!lesson.shareToken) {
    await prisma.trainingLesson.update({ where: { id: lessonId }, data: { shareToken: token, sharedAt: new Date() } });
    revalidatePath("/training");
  }
  return { ok: true, token };
}

// One lesson's text, loaded when the lesson is opened (audit F21, Oct 20
// 2026). The page used to put every lesson's full transcript and summary in
// its HTML, all ~165 of them, behind closed sections. Same gate as the page:
// signed in with Training access, and a creative only reads the creative
// courses (lessonAccess.creativeMaySee).
export async function loadLessonText(
  lessonId: string,
): Promise<{ ok: true; body: string; summaryMd: string | null } | { ok: false; message: string }> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const { canAccess, contentTier } = await import("@/lib/auth/access");
  const { creativeMaySee } = await import("./lessonAccess");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) return { ok: false, message: "Please sign in to read this." };
  if (me && !canAccess(me, "training")) return { ok: false, message: "Training isn't available at your access level." };
  const lesson = await prisma.trainingLesson.findUnique({
    where: { id: lessonId },
    select: { volume: true, course: true, body: true, summaryMd: true },
  });
  if (!lesson) return { ok: false, message: "That lesson is no longer here." };
  if (me && contentTier(me.role) === "CREATIVE" && !creativeMaySee(lesson)) {
    return { ok: false, message: "That lesson isn't available at your access level." };
  }
  return { ok: true, body: lesson.body, summaryMd: lesson.summaryMd };
}
