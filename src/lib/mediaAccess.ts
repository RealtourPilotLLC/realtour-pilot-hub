import "server-only";
import { redirect } from "next/navigation";
import { canAccess, homeFor, isCreativeLead } from "@/lib/auth/access";
import { authEnforcedNow } from "@/lib/auth/enforced";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// WHO OPENS THE MEDIA LIBRARY (Oct 23 2026): the owner, the office (Kyle) and
// the creative manager (James), through the `media` page key (their role
// default; a per-person override can close it). Staff-only for now: a
// photographer or an editor is never let in, whatever a key says, until
// Jordan decides they should see other people's finished work. The pages and
// the file route ask the same question; a "view as" preview is answered for
// the previewed login, and nothing on these pages writes.
// ---------------------------------------------------------------------------

export function mayOpenMedia(u: { role: string; permissions?: string | null }): boolean {
  return isCreativeLead(u.role) && canAccess(u, "media");
}

/** The file route's gate: signed in, and both the login shown and the real one may open the library. */
export async function mediaRouteAccess(): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  if (!authEnforcedNow()) return { ok: true };
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { ok: false, status: 401, error: "Sign in to open this file." };
  if (!mayOpenMedia(me) || !isCreativeLead(me.realRole)) return { ok: false, status: 403, error: "The media library is open to the owner, the office and the creative manager." };
  return { ok: true };
}

/** The pages' gate (/media, /listings, /listings/<job>): bounces anyone else home. */
export async function requireMediaPage(next: string): Promise<CurrentUser | null> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    if (authEnforcedNow()) redirect(`/login?next=${encodeURIComponent(next)}`);
    return null;
  }
  if (!mayOpenMedia(me)) redirect(homeFor(me.role));
  return me;
}
