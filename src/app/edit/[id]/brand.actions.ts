"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRole, canViewProject } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { acknowledgeBrandChanges } from "@/lib/brandProfile";

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
  try { await requireRole(["OWNER", "ADMIN", "EDITOR"]); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "You don't have access to do that." }; }
  const id = String(projectId ?? "");
  if (!/^[a-z0-9]{10,40}$/i.test(id) || !(await canViewProject(id))) return { ok: false, message: "That job isn't on your list." };
  const project = await prisma.project.findUnique({ where: { id }, select: { clientId: true } });
  if (!project) return { ok: false, message: "That job isn't on your list." };
  const me = await getCurrentUser().catch(() => null);
  const by = me?.editorKey || me?.name || me?.email || "editor";
  const r = await acknowledgeBrandChanges(project.clientId, by);
  try { revalidatePath(`/edit/${id}`); } catch { /* outside a request */ }
  return { ok: true, message: r.acked ? `Thanks — ${r.acked === 1 ? "the change is" : `${r.acked} changes are`} marked as seen.` : "Nothing new to acknowledge." };
}
