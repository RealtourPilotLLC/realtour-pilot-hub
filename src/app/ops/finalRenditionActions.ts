"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { FINAL_CHECK_KEYS, listingChoices, recordListingCheck, type FinalCheckKey } from "@/lib/finalRendition";

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
