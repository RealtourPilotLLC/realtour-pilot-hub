import "server-only";
import { prisma } from "@/lib/prisma";
import { editorMeta } from "@/lib/editors";

// ---------------------------------------------------------------------------
// THE NAME A WRITE IS SIGNED WITH (Review Room attribution, Sep 28 2026).
//
// Every author stamp in the Review Room used to be `u.name ?? u.email`, so a
// login whose AppUser name box was left blank signed its notes and verdicts
// with an email address — while the roster (TeamMember) or the editor table
// had the person's real name the whole time. The ladder here is the one rule:
// the login's own name, then the roster row it is linked to, then the editor
// it is keyed to, and only then the email, because an email is the one
// identity a person with no name anywhere still has.
// ---------------------------------------------------------------------------

export type NamedLogin = {
  name?: string | null;
  email?: string | null;
  teamMemberId?: string | null;
  editorKey?: string | null;
};

export async function displayNameFor(u: NamedLogin | null | undefined): Promise<string | null> {
  if (!u) return null;
  const own = u.name?.trim();
  if (own) return own;
  if (u.teamMemberId) {
    const tm = await prisma.teamMember.findUnique({ where: { id: u.teamMemberId }, select: { name: true } }).catch(() => null);
    if (tm?.name?.trim()) return tm.name.trim();
  }
  const editor = editorMeta(u.editorKey ?? null)?.name?.trim();
  if (editor) return editor;
  return u.email?.trim() || null;
}

/**
 * The author keys that are THE OFFICE on a review thread (gap 19). The
 * "unanswered replies" chip counted a thread as answered only when its last
 * word was Jordan's — `authorKey === "owner"` — so James or Kyle answering a
 * creative left it reading "unanswered" for ever. The review desk is: the
 * owner key, every OWNER/ADMIN login (by its roster key and its own user
 * key), and every named review seat (James may hold a PHOTOGRAPHER login).
 * A photographer or an editor who is not a seat is still a creative.
 */
export async function reviewDeskAuthorKeys(): Promise<Set<string>> {
  const keys = new Set<string>(["owner"]);
  const office = await prisma.appUser
    .findMany({ where: { role: { in: ["OWNER", "ADMIN"] } }, select: { id: true, teamMemberId: true } })
    .catch(() => []);
  for (const u of office) {
    keys.add(`user:${u.id}`);
    if (u.teamMemberId) keys.add(`tm:${u.teamMemberId}`);
  }
  try {
    const { reviewerChain } = await import("@/lib/reviewerAssignment");
    for (const m of (await reviewerChain()).members) keys.add(`tm:${m.teamMemberId}`);
  } catch { /* no chain configured, or unreadable: the office logins still count */ }
  return keys;
}
