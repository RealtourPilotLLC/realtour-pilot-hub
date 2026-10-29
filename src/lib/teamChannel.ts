import "server-only";
import { formatDistanceToNow } from "date-fns";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { messageExtras } from "@/lib/messageExtras";
import { filesLine } from "@/lib/messageFiles";
import type { LatestMsg } from "@/lib/editorQueue";
import type { ProjectMsg } from "@/components/project/ProjectMessages";

// ---------------------------------------------------------------------------
// THE TEAM CHANNEL (Jordan, Oct 28 2026: "Please also add a team messages
// channel so all team members can message"). One conversation for every
// active hub login: Jordan, Kyle, James, the photographers and the editors.
// It sits at the top of the message center's list in every entry (the
// office's Messages → Team, the Editing Room's Messages, and the
// photographers' messages icon), with an unread dot and a place in the
// messages icon's Team count, like a job thread.
//
// Read state: ThreadRead, keyed "team:channel" (ThreadRead.projectId is a
// plain string; the client inbox's "msg:" marks live there the same way).
// Your own post never reads as unread to you.
//
// Who is told: an @mention reaches that person by their usual route (the
// bell, plus Slack or a text as their row on Settings → Team notifications
// says), and a reply reaches the person answered. A plain post to everyone
// is unread for everyone and texts or Slacks nobody.
// ---------------------------------------------------------------------------

export const TEAM_CHANNEL_ID = "team";
export const TEAM_CHANNEL_READ_KEY = "team:channel";
/** The newest this many load; older ones stay in the table. */
export const TEAM_CHANNEL_LOAD = 150;

/** Where this person reads the channel: the office in Messages → Team, everyone else in the Editing Room's messages. */
export function teamChannelHref(user: { role: string; permissions?: string | null } | null, messageId?: string | null): string {
  const base = user && canAccess({ role: user.role, permissions: user.permissions ?? null }, "communications")
    ? "/communications?tab=team&t=team"
    : "/editing/messages?t=team";
  return messageId ? `${base}#msg-${messageId}` : base;
}

/** The channel's newest message, for the list row. */
export async function latestChannelMessage(): Promise<LatestMsg | null> {
  const m = await prisma.teamChannelMessage
    .findFirst({
      where: { channel: TEAM_CHANNEL_ID },
      orderBy: { createdAt: "desc" },
      select: { id: true, body: true, authorName: true, createdAt: true, attachments: { select: { contentType: true } } },
    })
    .catch(() => null);
  if (!m) return null;
  const images = m.attachments.filter((a) => a.contentType.startsWith("image/")).length;
  return { id: m.id, body: m.body || filesLine(m.attachments.length, images) || "Shared a page", authorName: m.authorName ?? "Someone", createdAt: m.createdAt };
}

/** Has someone else posted since this person last read the channel? */
export async function teamChannelUnread(userKey: string | null | undefined): Promise<boolean> {
  if (!userKey) return false;
  const [last, read] = await Promise.all([
    prisma.teamChannelMessage
      .findFirst({
        where: { channel: TEAM_CHANNEL_ID, OR: [{ authorUserId: null }, { authorUserId: { not: userKey } }] },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      })
      .catch(() => null),
    prisma.threadRead.findUnique({ where: { userKey_projectId: { userKey, projectId: TEAM_CHANNEL_READ_KEY } }, select: { seenAt: true } }).catch(() => null),
  ]);
  return !!last && (!read || last.createdAt > read.seenAt);
}

/** Move this person's channel mark forward to `at` (never back). */
export async function markTeamChannelSeen(userKey: string, at: Date): Promise<void> {
  const where = { userKey, projectId: TEAM_CHANNEL_READ_KEY };
  const existing = await prisma.threadRead.findUnique({ where: { userKey_projectId: where }, select: { seenAt: true } });
  if (!existing) {
    try {
      await prisma.threadRead.create({ data: { ...where, seenAt: at } });
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "P2002") throw e;
      await prisma.threadRead.updateMany({ where: { ...where, seenAt: { lt: at } }, data: { seenAt: at } });
    }
  } else if (existing.seenAt < at) {
    await prisma.threadRead.updateMany({ where: { ...where, seenAt: { lt: at } }, data: { seenAt: at } });
  }
}

/** The channel as this viewer reads it: the newest messages, oldest first,
 *  with their files and links (each link checked for this viewer). */
export async function loadTeamChannel(viewer: CurrentUser | null): Promise<ProjectMsg[]> {
  const rows = await prisma.teamChannelMessage
    .findMany({
      where: { channel: TEAM_CHANNEL_ID },
      orderBy: { createdAt: "desc" },
      take: TEAM_CHANNEL_LOAD,
      include: { replyTo: { select: { authorName: true, body: true } } },
    })
    .then((r) => r.reverse());
  const extra = await messageExtras(rows, viewer, { channel: true });
  return rows.map((m) => ({
    id: m.id,
    authorId: m.authorId,
    authorName: m.authorName,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    ago: formatDistanceToNow(m.createdAt, { addSuffix: true }),
    replyTo: m.replyTo ? { authorName: m.replyTo.authorName, body: m.replyTo.body } : null,
    ...extra(m.id),
  }));
}
