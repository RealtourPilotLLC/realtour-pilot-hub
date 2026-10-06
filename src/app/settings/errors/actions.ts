"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------
// SETTINGS → ERRORS, the owner's three buttons (Oct 6 2026): Mark fixed,
// Ignore, Reopen. requireOwner refuses an admin and the owner while he is
// previewing someone else ("view as" is read-only). A FIXED error that happens
// again reopens itself (lib/errorTracker.ts) — Mark fixed is not a mute.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };

export async function setErrorStatusAction(input: { id: string; status: "OPEN" | "FIXED" | "IGNORED" }): Promise<Result> {
  try {
    await requireOwner();
    if (!["OPEN", "FIXED", "IGNORED"].includes(input.status) || typeof input.id !== "string" || !input.id) {
      return { ok: false, message: "That isn't a change this page can make." };
    }
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    const { setErrorStatus } = await import("@/lib/errorTracker");
    const done = await setErrorStatus(input.id, input.status, me?.email ?? "owner");
    if (!done) return { ok: false, message: "That error could not be found — it may have been removed. Reload the page." };
    revalidatePath("/settings/errors");
    const word = input.status === "FIXED" ? "Marked fixed — it will reopen and alert you if it happens again." : input.status === "IGNORED" ? "Ignored — it keeps counting quietly and never alerts." : "Reopened.";
    return { ok: true, message: word };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong." };
  }
}
