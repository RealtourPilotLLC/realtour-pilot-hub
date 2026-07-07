import "server-only";
import { getCurrentUser } from "./user";

type AppRole = "OWNER" | "ADMIN" | "EDITOR" | "PHOTOGRAPHER";

// Authorization for SERVER ACTIONS. Middleware only gates page navigation, not
// the POST that invokes a "use server" action — so sensitive actions must guard
// themselves. These are no-ops ONLY in local dev (open / pre-cutover mode) so
// dev keeps working, and fail-CLOSED once enforcement is on. Authorization
// uses the REAL (non-impersonated) role, and blocks mutations while an owner is
// previewing someone else ("view as" is read-only).
//
// FAIL CLOSED IN PROD: enforcement is ALWAYS on when running in production or
// on Vercel, regardless of AUTH_ENFORCE — losing/typo-ing the env var on a
// redeploy or an unscoped preview deployment must never turn every permission
// check into a no-op against the shared prod database (audit crack #26). The
// AUTH_ENFORCE flag remains only as a way to turn enforcement ON locally.
const enforced = () =>
  process.env.AUTH_ENFORCE === "true" ||
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.VERCEL);

// Exported for callers that need the same on/off signal without a fixed role
// requirement (e.g. Ask the Hub resolves a content TIER rather than a role, but
// must still refuse unauthenticated calls once enforcement is on).
export const authEnforced = enforced;

export async function requireRole(
  roles: AppRole[],
  opts: { allowImpersonation?: boolean } = {},
): Promise<void> {
  if (!enforced()) return;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
  if (u.impersonating && !opts.allowImpersonation) {
    throw new Error("You're previewing another user — exit the preview to make changes.");
  }
  if (!roles.includes(u.realRole as AppRole)) {
    throw new Error("You don't have access to do that.");
  }
}

export const requireOwner = () => requireRole(["OWNER"]);
export const requireAdmin = () => requireRole(["OWNER", "ADMIN"]);

// Owner/admin, OR the EDITOR a task is delegated to. Editors are DB-scoped to
// their own tasks on /queue, but the Complete/status/assign buttons behind it
// were admin-only — the day Kim/Remar get accounts they'd hit "You don't have
// access" on their own finished work (audit crack #28). Matches the task's
// assignedKey against their editorKey, else their first-name slug (the same
// resolution /queue uses to scope them). Photographers stay excluded — their
// field flow goes through requireShootAccess.
export async function requireTaskAccess(taskId: string): Promise<void> {
  if (!enforced()) return;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
  if (u.impersonating) {
    throw new Error("You're previewing another user — exit the preview to make changes.");
  }
  if (u.realRole === "OWNER" || u.realRole === "ADMIN") return;
  if (u.realRole === "EDITOR") {
    const { prisma } = await import("@/lib/prisma");
    const { slugForName } = await import("@/lib/assignees");
    const myKey = u.editorKey || (u.name ? slugForName(u.name) : null);
    if (myKey) {
      const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { assignedKey: true } });
      if (t?.assignedKey === myKey) return;
    }
  }
  throw new Error("You don't have access to do that.");
}

// Owner/admin, OR the photographer assigned to this shoot. Used by the field
// (/shoot, /upload) actions so a photographer can only act on their own jobs.
export async function requireShootAccess(projectId: string): Promise<void> {
  if (!enforced()) return;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
  // "View as" is read-only everywhere — a previewing owner tapping Send on the
  // shoot screen would REALLY text the client (audit: field actions were the
  // one guard family missing this block).
  if (u.impersonating) throw new Error("You're previewing another user — exit the preview to make changes.");
  if (u.realRole === "OWNER" || u.realRole === "ADMIN") return;
  if (u.realRole === "PHOTOGRAPHER") {
    const { photographerMemberId, photographerOwnsShoot } = await import("@/lib/shoot");
    const mid = await photographerMemberId(u);
    if (mid && (await photographerOwnsShoot(projectId, mid))) return;
  }
  throw new Error("You don't have access to that shoot.");
}

// Same as requireShootAccess but keyed by a deliverable / uploaded-file id —
// resolves the owning project first.
export async function requireDeliverableAccess(deliverableId: string): Promise<void> {
  if (!enforced()) return;
  const { prisma } = await import("@/lib/prisma");
  const d = await prisma.deliverable.findUnique({ where: { id: deliverableId }, select: { projectId: true } });
  if (!d) throw new Error("That item no longer exists.");
  return requireShootAccess(d.projectId);
}

export async function requireUploadFileAccess(fileId: string): Promise<void> {
  if (!enforced()) return;
  const { prisma } = await import("@/lib/prisma");
  const f = await prisma.uploadedFile.findUnique({ where: { id: fileId }, select: { projectId: true } });
  if (!f) throw new Error("That file no longer exists.");
  return requireShootAccess(f.projectId);
}
