"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import { createResource, updateResource, setResourcePublished, markResourceReviewed, type ResourceInput } from "@/lib/portalResourcesAdmin";
import { markReviewItemHandled, unmarkReviewItem } from "@/lib/programMonitoring";

// Writes for the Resources tab (§11) and the program-wide backfill review (§14).
// Publishing is OWNER-only: a published guide is client-facing copy.

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

async function who(): Promise<string> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}

export async function createResourceAction(input: ResourceInput): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    await createResource(input, await who());
    revalidatePath("/content/resources");
    return { ok: true, message: "Saved as a draft. It is not visible to any client until it is published." };
  } catch (e) { return fail(e); }
}

export async function updateResourceAction(id: string, input: ResourceInput): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await updateResource(id, input); revalidatePath("/content/resources"); return { ok: true, message: "Saved." }; }
  catch (e) { return fail(e); }
}

export async function publishResourceAction(id: string, published: boolean): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    await setResourcePublished(id, published, await who());
    revalidatePath("/content/resources");
    return { ok: true, message: published ? "Published — clients can see it, and today is its review date." : "Unpublished. It disappears from the client's Resources immediately." };
  } catch (e) { return fail(e); }
}

export async function reviewResourceAction(id: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await markResourceReviewed(id, await who()); revalidatePath("/content/resources"); return { ok: true, message: "Marked as reviewed today." }; }
  catch (e) { return fail(e); }
}

// ---- backfill review (§14) ----------------------------------------------------------------

/**
 * A person's judgement on a mis-filed-looking record. It changes NO data: it
 * records that somebody looked, what they concluded and why. Fixing the
 * record itself is done on the client's own Import tab, by hand, on purpose.
 */
export async function markReviewItemAction(key: string, action: string, note: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!note.trim()) return { ok: false, message: "Write what you concluded — an unexplained tick is not a decision anyone can act on later." };
  try {
    await markReviewItemHandled(key, { by: await who(), at: new Date().toISOString(), note: note.trim().slice(0, 500), action });
    revalidatePath("/content/resources");
    revalidatePath("/content/monitoring");
    return { ok: true, message: "Recorded. Nothing was changed — the record is exactly as it was." };
  } catch (e) { return fail(e); }
}

export async function unmarkReviewItemAction(key: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await unmarkReviewItem(key, await who()); revalidatePath("/content/monitoring"); return { ok: true, message: "Back on the list." }; }
  catch (e) { return fail(e); }
}
