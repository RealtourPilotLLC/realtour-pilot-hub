"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { FINAL_CHECK_KEYS, listingChoices, recordListingCheck, finalChoices, recordFinalCheck, finalCheckReceipt, type FinalCheckKey } from "@/lib/finalRendition";

export async function listingFinalChoicesAction(submissionId: string) {
  await requireAdmin();
  const me = await getCurrentUser();
  if (me?.impersonating) return { ok: false, message: "Leave preview mode before checking a final file.", choices: [] };
  return listingChoices(submissionId);
}

export async function recordListingFinalCheckAction(data: FormData): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const me = await getCurrentUser();
  if (me?.impersonating) return { ok: false, message: "Leave preview mode before checking a final file." };
  const submissionId = String(data.get("submissionId") ?? "");
  const mediaId = String(data.get("mediaId") ?? "");
  if (!submissionId || !mediaId) return { ok: false, message: "Choose the Aryeo video you checked." };
  const checks = FINAL_CHECK_KEYS.filter((k) => data.get(k) === "yes") as FinalCheckKey[];
  const duration = Number(data.get("duration"));
  const width = Number(data.get("width"));
  const height = Number(data.get("height"));
  const metadata = Number.isFinite(duration) && duration > 0 && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { duration, width, height } : null;
  const result = await recordListingCheck({ submissionId, mediaId, checks, metadata,
    actor: { id: me?.id ?? null, name: me?.realName ?? me?.name ?? "Office" } });
  if (result.ok) { revalidatePath("/"); revalidatePath("/ops"); }
  return result;
}

export async function finalFileChoicesAction(submissionId: string) {
  await requireAdmin();
  const me = await getCurrentUser();
  if (me?.impersonating) return { ok: false, message: "Leave preview mode before checking a final file.", choices: [] };
  return finalChoices(submissionId);
}

export async function recordFinalFileCheckAction(data: FormData): Promise<{ ok: boolean; message: string; outcome: "confirmed" | "refused" | "unknown" }> {
  await requireAdmin();
  const me = await getCurrentUser();
  if (!me || me.impersonating) return { ok: false, message: "Leave preview mode and sign in as office staff before checking a final file.", outcome: "refused" };
  const duration = Number(data.get("duration")), width = Number(data.get("width")), height = Number(data.get("height"));
  const metadata = [duration, width, height].every((v) => Number.isFinite(v) && v > 0) ? { duration, width, height } : null;
  try {
    const r = await recordFinalCheck({ submissionId: String(data.get("submissionId") ?? ""), mediaId: String(data.get("mediaId") ?? ""),
      attemptId: String(data.get("attemptId") ?? ""), checks: FINAL_CHECK_KEYS.filter((k) => data.get(k) === "yes"), metadata,
      actor: { id: me.id, name: me.realName ?? me.name ?? "Office" } });
    if (r.ok) { revalidatePath("/"); revalidatePath("/ops"); }
    return { ...r, outcome: r.ok ? "confirmed" : "refused" };
  } catch {
    return { ok: false, outcome: "unknown", message: "The final-check save is unconfirmed. It may have been recorded. Check this attempt’s receipt before any new save; your current form input is kept here." };
  }
}

export async function readFinalFileCheckReceiptAction(submissionId: string, attemptId: string) {
  await requireAdmin();
  const me = await getCurrentUser();
  if (!me || me.impersonating) return { ok: false, message: "Leave preview mode before reading a final-check receipt." };
  return finalCheckReceipt(submissionId, attemptId, me.id);
}
