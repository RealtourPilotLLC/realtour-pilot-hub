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
