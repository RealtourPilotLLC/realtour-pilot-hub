"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// The spelling check's trial (Oct 24 2026; lib/videoAnalysis). Jordan marks
// each flag Right (a real mistake on screen) or Wrong (a false alarm), which is
// how the hub measures whether the check is good enough to show reviewers.
// Owner only, and never from a "view as" preview (requireOwner refuses both).
// ---------------------------------------------------------------------------

export type SpellingActionResult = { ok: boolean; message: string };

const ID_RE = /^[a-z0-9]{10,40}$/i;

export async function markSpellingFlag(submissionId: string, flagId: string, verdict: "RIGHT" | "WRONG" | null): Promise<SpellingActionResult> {
  await requireOwner();
  if (!ID_RE.test(submissionId) || typeof flagId !== "string" || flagId.length > 60) return { ok: false, message: "That flag is no longer there." };
  if (verdict !== null && verdict !== "RIGHT" && verdict !== "WRONG") return { ok: false, message: "Right or Wrong only." };
  const me = await getCurrentUser().catch(() => null);
  const { recordSpellingVerdict } = await import("@/lib/videoAnalysis");
  const r = await recordSpellingVerdict(submissionId, flagId, verdict, me?.email ?? me?.name ?? "owner");
  revalidatePath("/connections");
  return r;
}

/** Settings → Video Review Room: "Show spelling flags to reviewers". OFF until Jordan decides the trial is good enough. */
export async function setSpellingFlagsForReviewers(on: boolean): Promise<SpellingActionResult> {
  await requireOwner();
  const me = await getCurrentUser().catch(() => null);
  const { setSpellingReviewers } = await import("@/lib/videoAnalysis");
  await setSpellingReviewers(on === true, me?.email ?? null);
  revalidatePath("/settings");
  revalidatePath("/connections");
  return { ok: true, message: on ? "Reviewers now see spelling flags above Approve." : "Spelling flags are back to you only." };
}
