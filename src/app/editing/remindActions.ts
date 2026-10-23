"use server";

import { revalidatePath } from "next/cache";
import { authEnforced } from "@/lib/auth/guards";
import { isCreativeLead } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";
import type { RemindOutcome } from "@/lib/remindPhotographer";

// ---------------------------------------------------------------------------
// "Remind photographer" on an Editing Room row (Oct 23 2026, lib/
// remindPhotographer has the rule). Who may press: the office (owner, admin)
// and the creative manager, by their REAL login, never through "view as".
// Editors and photographers may not. Fail-closed once auth is enforced, a
// no-op gate in local dev exactly like requireRole (except a preview, which is
// refused everywhere).
// ---------------------------------------------------------------------------
export async function remindPhotographerAction(projectId: string): Promise<RemindOutcome> {
  if (typeof projectId !== "string" || !projectId.trim()) return { ok: false, message: "No job was named." };
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: "You're viewing the hub as someone else. Exit the preview to send a reminder." };
  if (authEnforced()) {
    if (!me) return { ok: false, message: "Please sign in to do that." };
    if (!isCreativeLead(me.realRole)) return { ok: false, message: "Only the office and the creative manager can remind a photographer." };
  }
  const { displayNameFor } = await import("@/lib/actorName");
  const name = (await displayNameFor(me)) ?? "The office";
  const { remindPhotographer } = await import("@/lib/remindPhotographer");
  const r = await remindPhotographer(projectId.trim(), { name, teamMemberId: me?.teamMemberId ?? null }).catch(
    (e): RemindOutcome => ({ ok: false, message: `That didn't go through (${e instanceof Error ? e.message : "error"}). Try again.` }),
  );
  if (r.last) revalidatePath("/editing");
  return r;
}
