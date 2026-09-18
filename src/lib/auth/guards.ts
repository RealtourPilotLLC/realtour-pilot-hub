import "server-only";
import { slugForName } from "@/lib/assignees";
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

// ---------------------------------------------------------------------------
// WHO THIS LOGIN IS, IN KEY SPACE — and which jobs it holds (RTP-01 / RTP-02,
// Sep 16). Three surfaces used to answer these questions three ways, and the
// loosest of the three answered "everything": a board that read a null editor
// scope as "no filter", a cut-stream route that asked only "is anyone signed
// in", and a file route that asked only "is the path ours". One resolution
// now, and every one of them FAILS CLOSED.
// ---------------------------------------------------------------------------

/**
 * The scope an EDITOR surface must filter by. Never null for an EDITOR: an
 * editor login that maps to no editor profile gets a sentinel that matches no
 * row, because null means "don't filter" to every caller downstream and that
 * handed a keyless editor the whole office board (RTP-01). A password-invited
 * editor with the name box left blank is exactly that account.
 */
export const EDITOR_SCOPE_NONE = "__none__";

/**
 * editorKey (kim/john/…), else their first-name slug, else the fail-closed
 * sentinel. null ONLY for a non-editor, where it correctly means "no editor
 * filter applies". The one definition — /tasks and /edit/<id> both read it.
 */
export function editorScopeOf(
  me: { role?: string | null; editorKey?: string | null; name?: string | null } | null | undefined,
): string | null {
  if (!me || me.role !== "EDITOR") return null;
  // AN ASSIGNED IDENTITY OR NOTHING (audit, Sep 17). This used to fall back to
  // the login name's slug, and slugForName keeps only the FIRST name — so an
  // EDITOR account created without an editorKey would silently inherit the task
  // board of any editor sharing that first name. An editorKey is set by Jordan
  // or Kyle; the name on an AppUser is free text the account holder can edit,
  // and the same reasoning already governs canViewProject below. Unlinked now
  // fails closed to the sentinel, which shows UNMAPPED_EDITOR_MESSAGE rather
  // than somebody else's work. (Verified Sep 17: both live editors — Kim and
  // John — carry explicit editorKeys, so this locks nobody out.)
  return me.editorKey || EDITOR_SCOPE_NONE;
}

/** True when a scope is the fail-closed sentinel (i.e. an unmapped editor). */
export const isUnmappedEditor = (scope: string | null): boolean => scope === EDITOR_SCOPE_NONE;

/** The message an unmapped editor sees in place of somebody else's work. */
export const UNMAPPED_EDITOR_MESSAGE =
  "Your account is not linked to an editor profile yet — ask Jordan or Kyle to finish the invite.";

type Viewer = Awaited<ReturnType<typeof getCurrentUser>>;

/**
 * Every assignment key this human is addressable by — their editor key and
 * their roster (TeamMember) name slug, else (and only else) the slug of the
 * name on their own login. Hoisted out of requireTaskAccess so the job
 * predicate below matches work the exact same way the task guard does. Never
 * contains "" and never contains the sentinel.
 *
 * WHY THE LOGIN NAME IS A LAST RESORT (review, Sep 16). An editorKey and a
 * roster row are ASSIGNED — Jordan or Kyle set them. The name on an AppUser is
 * free text the account holder can edit, and slugForName keeps only the first
 * name, so "Kyle Cabrera" slugs to `kyle`. That was tolerable while these keys
 * only decided who may tick their own task; since Sep 16 they also decide who
 * may STREAM a cut and fetch a job's files (canViewProject), and a first-name
 * collision would hand one person every job carrying the other's key. When an
 * assigned identity exists it is the whole answer; the login name only stands
 * in for an account that has neither, which is where it came from (an AppUser
 * renamed away from the roster spelling still acts on their own work — but
 * that case now resolves through the roster row, not around it).
 */
export async function addressableKeys(u: Viewer): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!u) return keys;
  if (u.role === "EDITOR" && u.editorKey) keys.add(u.editorKey);
  if (u.teamMemberId) {
    const { prisma } = await import("@/lib/prisma");
    const tm = await prisma.teamMember.findUnique({ where: { id: u.teamMemberId }, select: { name: true } });
    if (tm?.name) keys.add(slugForName(tm.name));
  }
  keys.delete("");
  keys.delete(EDITOR_SCOPE_NONE);
  // AN EDITOR GETS NO LOGIN-NAME FALLBACK (review, Sep 18). For every other role
  // these keys only decide who may tick their own task; for an EDITOR they are
  // the authorization — canViewProject reads them, and the cut-stream route
  // reads canViewProject, so a first-name collision hands one person another
  // editor's jobs AND their client's video bytes. editorScopeOf was already
  // closed against exactly this; addressableKeys was not, so the two disagreed:
  // an unlinked "John Example" got task scope __none__ and project keys [john].
  // An assigned identity or nothing.
  if (keys.size === 0 && u.name && u.role !== "EDITOR") {
    const slug = slugForName(u.name);
    if (slug && slug !== EDITOR_SCOPE_NONE) keys.add(slug);
  }
  return keys;
}

/**
 * Does an EDITOR hold this job? The Editing Room's truth ladder, read back:
 * the project's pinned editor (TeamMember or vendor key), an open/closed task
 * delegated to them on it, or a cut they themselves sent to review. The last
 * clause matters — a cut REASSIGNED to another job or another editor must not
 * lock the editor who CUT it out of their own review history (Review Room
 * batch), and WITHDRAWN rows count for the same reason.
 */
async function editorHoldsProject(projectId: string, keys: Set<string>): Promise<boolean> {
  if (keys.size === 0) return false;
  const { prisma } = await import("@/lib/prisma");
  const { editorKeyForTeamName } = await import("@/lib/editors");
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { editorVendorKey: true, editor: { select: { name: true } } },
  });
  if (!p) return false;
  if (p.editorVendorKey && keys.has(p.editorVendorKey)) return true;
  const teamName = p.editor?.name ?? null;
  if (teamName && (keys.has(slugForName(teamName)) || keys.has(editorKeyForTeamName(teamName) ?? ""))) return true;
  const list = [...keys];
  const [task, sub] = await Promise.all([
    prisma.smartTask.findFirst({ where: { projectId, assignedKey: { in: list } }, select: { id: true } }),
    prisma.reviewSubmission.findFirst({ where: { projectId, submittedByKey: { in: list } }, select: { id: true } }),
  ]);
  return !!task || !!sub;
}

/**
 * May the person asking SEE this job's material — its cuts, its uploaded
 * files, its thread? Owner/admin always; the editor who holds it; the
 * photographer who shot it. Everyone else: no. Read gate, so it answers for
 * the EFFECTIVE identity — an owner previewing as Kim sees what Kim sees,
 * which is the point of the preview.
 *
 * A no-op in local dev / pre-cutover ONLY, exactly like every guard above.
 */
export async function canViewProject(projectId: string, viewer?: Viewer): Promise<boolean> {
  if (!enforced()) return true;
  const u = viewer !== undefined ? viewer : await getCurrentUser().catch(() => null);
  if (!u) return false;
  if (u.role === "OWNER" || u.role === "ADMIN") return true;
  if (u.role === "PHOTOGRAPHER") {
    const { photographerMemberId, photographerOwnsShoot } = await import("@/lib/shoot");
    const mid = await photographerMemberId(u);
    return !!mid && (await photographerOwnsShoot(projectId, mid));
  }
  if (u.role === "EDITOR") return editorHoldsProject(projectId, await addressableKeys(u));
  return false;
}

/**
 * Is this deliverable part of this job? Guards the related-record writes that
 * ran a shoot-level check and then wrote whatever id the form sent (RTP-02).
 * ONE helper on purpose: when the "two Aryeo rows, one job" work lands, the
 * sibling leg is admitted HERE and every caller inherits it.
 */
export async function deliverableInProject(deliverableId: string, projectId: string): Promise<boolean> {
  const { prisma } = await import("@/lib/prisma");
  const d = await prisma.deliverable.findUnique({ where: { id: deliverableId }, select: { projectId: true } });
  return !!d && d.projectId === projectId;
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
  if (u.realRole === "EDITOR" || u.realRole === "PHOTOGRAPHER") {
    // The person a task is assigned to may act on THEIR OWN task, whatever
    // their role — a photographer with work moved onto their plate must be
    // able to complete it (audit: assigned-away tasks were act-on-able by
    // nobody but admins). Match against EVERY key this human is addressable
    // by — editor key, AppUser display-name slug, AND their roster
    // (TeamMember) name's slug — so an AppUser renamed away from the roster
    // spelling doesn't lose the ability to act on their own work.
    const { prisma } = await import("@/lib/prisma");
    // One resolution, shared with the job predicate above (Sep 16) so a task
    // guard and a job guard can never drift into disagreeing about who this is.
    const myKeys = await addressableKeys(u);
    if (myKeys.size > 0) {
      const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { assignedKey: true } });
      if (t?.assignedKey && myKeys.has(t.assignedKey)) return;
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

// ---------------------------------------------------------------------------
// One-line in-page access gate. Middleware's allow-path trusts the session
// claim (which can be stale for days); pages are the fresh-data authority —
// every top-level page calls this so a revoke applies on the next click
// (audit Aug 25: /communications had NO in-page guard, so a revoked override
// kept reading client threads until the login token expired).
// ---------------------------------------------------------------------------
export async function requirePageAccess(key: import("@/lib/auth/access").PageKey): Promise<void> {
  const { redirect } = await import("next/navigation");
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { canAccess, homeFor, PAGES } = await import("@/lib/auth/access");
  const me = await getCurrentUser().catch(() => null);
  const href = PAGES.find((p) => p.key === key)?.href ?? "/";
  if (!me && authEnforced()) redirect(`/login?next=${encodeURIComponent(href)}`);
  if (me && !canAccess(me, key)) redirect(homeFor(me.role));
}
