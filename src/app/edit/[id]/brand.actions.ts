"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRole, canViewProject } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { acknowledgeBrandChanges, overrideBrandChanges } from "@/lib/brandProfile";

// ---------------------------------------------------------------------------
// "Got it" on the brief's brand-update banner (CP-06, Sep 24 2026).
//
// The editor saying they have the change is what closes Kyle's confirmation
// task — so it must be the real editor (or the office), on a job they may see:
//   · requireRole(OWNER, ADMIN, EDITOR) refuses a photographer and refuses an
//     owner's "view as" preview (that is read-only, not the editor speaking);
//   · canViewProject proves the job is theirs (an editor holding another
//     client's work cannot clear this client's banner).
// The acknowledgement is recorded against the client — the change is the
// client's brand, not one job's — with who pressed it.
// ---------------------------------------------------------------------------

export async function acknowledgeBrandChangesAction(projectId: string): Promise<{ ok: boolean; message: string }> {
  try { await requireRole(["EDITOR"]); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." }; }
  const id = String(projectId ?? "");
  if (!/^[a-z0-9]{10,40}$/i.test(id) || !(await canViewProject(id))) return { ok: false, message: "That job isn't on your list." };
  const project = await prisma.project.findUnique({ where: { id }, select: { clientId: true } });
  if (!project) return { ok: false, message: "That job isn't on your list." };
  const me = await getCurrentUser().catch(() => null);
  if (!me?.editorKey || me.impersonating) return { ok: false, message: "Only the assigned editor can record their own receipt." };
  const r = await acknowledgeBrandChanges(project.clientId, me.editorKey);
  try { revalidatePath(`/edit/${id}`); } catch { /* outside a request */ }
  return { ok: true, message: r.acked ? `Your receipt is recorded for ${r.acked} change${r.acked === 1 ? "" : "s"}.` : "Nothing new for you to acknowledge." };
}

export async function overrideBrandChangesAction(projectId: string, reason: string): Promise<{ ok: boolean; message: string }> {
  try { await requireRole(["OWNER", "ADMIN"]); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." }; }
  const id = String(projectId ?? "");
  if (!/^[a-z0-9]{10,40}$/i.test(id) || !(await canViewProject(id))) return { ok: false, message: "That job isn't on your list." };
  const me = await getCurrentUser().catch(() => null);
  if (!me || me.impersonating) return { ok: false, message: "Sign in as yourself to record an office override." };
  const project = await prisma.project.findUnique({ where: { id }, select: { clientId: true } });
  if (!project) return { ok: false, message: "That job isn't on your list." };
  try {
    const result = await overrideBrandChanges(project.clientId, me.name || me.email || me.id, reason);
    try { revalidatePath(`/edit/${id}`); } catch { /* outside a request */ }
    return { ok: true, message: result.overridden ? `Office override recorded with your reason for ${result.overridden} receipt${result.overridden === 1 ? "" : "s"}.` : "No unresolved brand changes remain." };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "The override did not save." }; }
}
