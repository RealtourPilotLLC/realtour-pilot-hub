"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { etAt } from "@/lib/datetime";

// "Draft update" on a promise at risk (AU-24 / F5, Sep 26 2026). Owner or
// admin — the people who answer clients. The action DRAFTS: it calls the model
// once, with the recorded promise and the time the person typed, and files the
// words on one task for Kyle. It never sends; see lib/atRiskUpdates.ts.

/** "2026-09-29T17:00" (a datetime-local value) read as Eastern wall-clock time. */
function etLocal(v: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec((v ?? "").trim());
  if (!m) return null;
  const d = etAt(m[1], Number(m[2]), Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

export async function draftAtRiskUpdateAction(input: {
  projectId: string;
  outputId: string | null;
  mode: "newTime" | "confirmBy";
  /** datetime-local value, Eastern */
  when: string;
}): Promise<{ ok: boolean; message: string; draft?: string; taskId?: string; warning?: string | null }> {
  try {
    await requireAdmin();
    const me = await getCurrentUser().catch(() => null);
    const when = etLocal(input.when);
    if (!when) return { ok: false, message: "Pick a date and time." };
    const { draftAtRiskUpdate } = await import("@/lib/atRiskUpdates");
    const r = await draftAtRiskUpdate({
      projectId: input.projectId,
      outputId: input.outputId,
      newTime: input.mode === "newTime" ? when : null,
      confirmBy: input.mode === "confirmBy" ? when : null,
      actor: me?.name ?? me?.email ?? "the office",
    });
    if (!r.ok) return { ok: false, message: r.message };
    revalidatePath("/tasks");
    return {
      ok: true,
      draft: r.draft,
      taskId: r.taskId,
      warning: r.dateWarning,
      message: r.created ? "Drafted and put on Kyle's list. Nothing was sent." : "Draft updated on the same task. Nothing was sent.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not draft — try again." };
  }
}
