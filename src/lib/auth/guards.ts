import "server-only";
import { getCurrentUser } from "./user";

type AppRole = "OWNER" | "ADMIN" | "EDITOR" | "PHOTOGRAPHER";

// Authorization for SERVER ACTIONS. Middleware only gates page navigation, not
// the POST that invokes a "use server" action — so sensitive actions must guard
// themselves. These are no-ops in open / pre-cutover mode (AUTH_ENFORCE off) so
// local dev keeps working, and fail-CLOSED once enforcement is on. Authorization
// uses the REAL (non-impersonated) role, and blocks mutations while an owner is
// previewing someone else ("view as" is read-only).
const enforced = () => process.env.AUTH_ENFORCE === "true";

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

// Owner/admin, OR the photographer assigned to this shoot. Used by the field
// (/shoot, /upload) actions so a photographer can only act on their own jobs.
export async function requireShootAccess(projectId: string): Promise<void> {
  if (!enforced()) return;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
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
