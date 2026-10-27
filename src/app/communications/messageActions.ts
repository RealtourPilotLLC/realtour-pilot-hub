"use server";

import { revalidatePath } from "next/cache";

// Messages actions from the Oct 27 2026 Loom (Jordan, 37:49 and 40:12):
//   · markEmailThreadRead: unfolding an email thread on Messages · Email moves
//     the viewer's read mark (lib/messageReads), so the unread dot goes;
//   · dismissUnsavedNumber: "Not a client" or "Spam" on a text from a number we
//     have not saved: the conversation is cut and the number muted, with the
//     reason (both undoable from the muted-numbers fold);
//   · showHiddenEmail: undo the AI check's "not a client" on one email.

type Result = { ok: boolean; message?: string };

/** The viewer's own mark: never in a "view as" preview. */
export async function markEmailThreadRead(threadKey: string, newestISO: string): Promise<Result> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  if (!me || me.impersonating) return { ok: false };
  const { canAccess } = await import("@/lib/auth/access");
  if (!canAccess(me, "communications")) return { ok: false };
  const key = (threadKey ?? "").trim();
  const at = new Date(newestISO);
  if (!key || key.length > 400 || isNaN(at.getTime())) return { ok: false };
  const { emailReadKey, markRead } = await import("@/lib/messageReads");
  await markRead(me.id, emailReadKey(key), at);
  return { ok: true };
}

export async function dismissUnsavedNumber(threadKey: string, reason: string): Promise<Result> {
  const { requireAdmin } = await import("@/lib/auth/guards");
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Admins only." };
  }
  const { UNSAVED_NUMBER_REASONS, muteNumber } = await import("@/lib/replyQueue");
  const why = (UNSAVED_NUMBER_REASONS as readonly string[]).includes(reason) ? (reason as (typeof UNSAVED_NUMBER_REASONS)[number]) : null;
  if (!why) return { ok: false, message: "Pick Not a client or Spam." };
  const phone = (threadKey ?? "").startsWith("p:") ? threadKey.slice(2) : "";
  if (!/^\d{10}$/.test(phone)) return { ok: false, message: "That conversation is not a phone number." };
  const r = await muteNumber(phone, why);
  revalidatePath("/communications");
  revalidatePath("/ops");
  revalidatePath("/");
  if (r === "teammate") return { ok: false, message: "That is one of our own numbers, so it was not put away." };
  if (r !== "muted") return { ok: false, message: "That conversation is not a phone number." };
  return { ok: true, message: why === "spam" ? "Marked spam. The number is muted." : "Marked not a client. The number is muted." };
}

export async function showHiddenEmail(commLogId: string): Promise<Result> {
  const { requireAdmin } = await import("@/lib/auth/guards");
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Admins only." };
  }
  const id = (commLogId ?? "").trim();
  if (!id || id.length > 64) return { ok: false };
  const { clearNotClientVerdict } = await import("@/lib/commsNotClient");
  await clearNotClientVerdict(id);
  revalidatePath("/communications");
  return { ok: true };
}
