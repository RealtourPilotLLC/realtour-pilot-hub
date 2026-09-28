"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// The AutoHDR batch register's two buttons (§10 A53, Sep 26). The office only
// — the owner and Kyle run AutoHDR. Neither button uploads, re-runs or pays for
// anything: one looks at Dropbox again, the other writes the ledger line that
// says a person is re-running the batch, after its own fresh look.

export type BatchActionResult = { ok: boolean; message: string };

async function actor(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "local-dev";
}

export async function refreshPhotoBatch(projectId: string): Promise<BatchActionResult> {
  await requireRole(["OWNER", "ADMIN"]);
  const { countProjectPhotos } = await import("@/lib/photoCount");
  const r = await countProjectPhotos(projectId);
  revalidatePath(`/projects/${projectId}`);
  return r ? { ok: true, message: "Looked again — the register is current." } : { ok: false, message: "Dropbox couldn't be read just now (or the shoot hasn't happened). Nothing changed." };
}

export async function recordPhotoBatchRerun(projectId: string, reason: string): Promise<BatchActionResult> {
  await requireRole(["OWNER", "ADMIN"]);
  const { recordResubmission } = await import("@/lib/photoEditBatches");
  const r = await recordResubmission(projectId, await actor(), reason);
  revalidatePath(`/projects/${projectId}`);
  return { ok: r.ok, message: r.message };
}
