"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// THE PROGRAM VIDEO WATCH, on the Project Tracker (Oct 15 2026,
// lib/programWatch). Two writes, both the office's: why a late video was
// late, and the watch's switches. Neither contacts anybody.
// ---------------------------------------------------------------------------

async function who(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return "the office";
  const { displayNameFor } = await import("@/lib/actorName");
  return (await displayNameFor(me).catch(() => null)) ?? me.email ?? "the office";
}

export async function recordMissCauseAction(input: { outputId: string; cause: string | null; note?: string | null }): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (typeof input?.outputId !== "string" || !input.outputId) return { ok: false, message: "No video was named." };
  const { recordMissCause } = await import("@/lib/programWatch");
  const r = await recordMissCause({ outputId: input.outputId, cause: input.cause, note: input.note ?? null, by: await who() });
  if (r.ok) revalidatePath("/pipeline");
  return r;
}

export async function saveProgramWatchRulesAction(next: {
  alerts?: boolean;
  chaseEscalation?: boolean;
  portalExpectedBy?: boolean;
  libraryRepoint?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const clean: Record<string, boolean> = {};
  for (const k of ["alerts", "chaseEscalation", "portalExpectedBy", "libraryRepoint"] as const) {
    if (typeof next?.[k] === "boolean") clean[k] = next[k] as boolean;
  }
  if (Object.keys(clean).length === 0) return { ok: false, message: "Nothing to change." };
  const { saveProgramWatchRules } = await import("@/lib/programWatch");
  const me = await getCurrentUser().catch(() => null);
  await saveProgramWatchRules(clean, me?.email ?? null);
  revalidatePath("/pipeline");
  return { ok: true, message: "Saved." };
}
