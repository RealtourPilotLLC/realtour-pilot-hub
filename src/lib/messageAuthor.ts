import "server-only";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth/user";

/**
 * WHO WROTE THIS TEAM MESSAGE: whoever is logged in (Jordan: "the project chat
 * should not have the name selector and just be the name of the person who is
 * logged in"). Shared by the job threads and the team channel (Oct 28 2026).
 *
 * The login's LINKED Team row first (the self-tag and self-reply rules compare
 * this id exactly, so it has to be the writer's own row, not a name
 * lookalike), then the exact display name, then the roster email. A logged-in
 * person with no row still posts as THEMSELVES (name or email), never as a
 * client-chosen TeamMember: the passed id is a spoof vector once a session
 * exists. THREE RUNGS, NOT FOUR (review, Sep 16): a first-name "contains"
 * match attributed "Kim" to "Kimberly Vance"; a guess must not decide whose
 * tag closes or who a reply rings. The client-passed id only matters in
 * sessionless local dev (auth off), where there's no identity to derive.
 */
export async function resolveMessageAuthor(
  me: CurrentUser | null,
  clientAuthorId: string | null,
  authEnforced: boolean,
): Promise<{ authorId: string | null; authorName: string | null }> {
  const myName = me?.name?.trim();
  if (me) {
    const select = { id: true, name: true };
    const tm =
      (me.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select }) : null) ??
      (myName ? await prisma.teamMember.findFirst({ where: { name: { equals: myName, mode: "insensitive" } }, select }) : null) ??
      (me.email
        ? await prisma.teamMember.findFirst({ where: { email: { equals: me.email, mode: "insensitive" }, active: true }, select })
        : null);
    return { authorId: tm?.id ?? null, authorName: tm?.name ?? myName ?? me.email ?? "Team" };
  }
  if (!authEnforced && clientAuthorId) {
    const m = await prisma.teamMember.findUnique({ where: { id: clientAuthorId }, select: { name: true } });
    return { authorId: m ? clientAuthorId : null, authorName: m?.name ?? null };
  }
  return { authorId: null, authorName: null };
}
