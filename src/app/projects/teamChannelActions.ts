"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { parseHubUrl, sanitizeLinkTargets, hubLinkPath, type HubLinkRef } from "@/lib/hubLinks";
import { filesLine, isMessageImage, parseConversationKey, type PendingMessageFile } from "@/lib/messageFiles";
import type { ShareableSearch } from "@/lib/hubLinkAccess";

export type ChannelResult = { ok: boolean; message: string };

// THE TEAM CHANNEL'S ACTIONS (Jordan, Oct 28 2026: "a team messages channel
// so all team members can message"), and the composer's two link helpers,
// which serve the job threads too. Every login on the team may read and post
// in the channel; "view as" previews may not post (requireRole refuses them).
// See lib/teamChannel for who is told, and lib/hubLinkAccess for the link rule.
const TEAM = ["OWNER", "ADMIN", "CREATIVE_MANAGER", "EDITOR", "PHOTOGRAPHER"] as const;
const requireTeam = () => requireRole([...TEAM]);

function revalidateCenters() {
  revalidatePath("/communications");
  revalidatePath("/editing/messages");
  revalidatePath("/editing");
}

export async function postTeamChannelMessage(
  body: string,
  mentionIds: string[] = [],
  replyToId?: string | null,
  extras: { files?: PendingMessageFile[]; links?: unknown } = {},
): Promise<ChannelResult> {
  await requireTeam();
  const text = (body ?? "").trim().slice(0, 2000);
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  const pendingFiles = Array.isArray(extras.files) ? extras.files : [];
  const targets = sanitizeLinkTargets(extras.links);
  if (!text && pendingFiles.length === 0 && targets.length === 0) return { ok: false, message: "Write a message first." };

  // Links first: a page somebody here can't open is refused by name.
  const { checkHubLinks } = await import("@/lib/hubLinkAccess");
  const linkCheck = await checkHubLinks({ kind: "team" }, targets);
  if (!linkCheck.ok) return { ok: false, message: linkCheck.message };
  const { acceptMessageFiles, attachmentRows } = await import("@/lib/messageAttachments");
  const fileCheck = await acceptMessageFiles({ kind: "team" }, me?.id ?? null, pendingFiles);
  if (!fileCheck.ok) return { ok: false, message: fileCheck.message };

  const { resolveMessageAuthor } = await import("@/lib/messageAuthor");
  const { authorId, authorName } = await resolveMessageAuthor(me, null, authEnforced());
  // A reply answers a message IN THE CHANNEL; anything else is dropped, the message kept.
  const parent = replyToId
    ? await prisma.teamChannelMessage.findUnique({ where: { id: replyToId }, select: { id: true, channel: true, authorId: true } }).catch(() => null)
    : null;
  const parentId = parent && parent.channel === "team" ? parent.id : null;

  const { matchMentions } = await import("@/lib/mentions");
  const roster = text.includes("@")
    ? await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true } }).catch(() => [])
    : [];
  const mentions = Array.from(new Set([...(mentionIds ?? []).filter((id) => typeof id === "string" && id), ...matchMentions(text, roster).map((p) => p.id)]));

  const msg = await prisma.teamChannelMessage.create({
    data: {
      channel: "team",
      authorId,
      authorUserId: me?.id ?? null,
      authorName,
      body: text,
      mentions: mentions.length ? JSON.stringify(mentions) : null,
      links: linkCheck.refs.length ? JSON.stringify(linkCheck.refs) : null,
      replyToId: parentId,
      attachments: fileCheck.files.length ? { create: attachmentRows({ kind: "team" }, me?.id ?? null, fileCheck.files) } : undefined,
    },
  });
  // Your own post is read by you.
  if (me && !me.impersonating) {
    const { markTeamChannelSeen } = await import("@/lib/teamChannel");
    await markTeamChannelSeen(me.id, msg.createdAt).catch(() => {});
  }

  // WHO IS TOLD. A plain post: nobody beyond the unread dot (Jordan, Oct 28
  // 2026: everyone can read it; the whole team is not texted). A tag: that
  // person, by their own route. A reply: the person answered. Best-effort:
  // the message is saved whatever a ping does.
  const said = text || filesLine(fileCheck.files.length, fileCheck.files.filter((f) => isMessageImage(f.contentType)).length) || "Shared a hub page";
  try {
    await tellChannelPeople({ messageId: msg.id, authorId, authorName: authorName ?? "A teammate", text: said, mentions, parentAuthorId: parentId ? parent?.authorId ?? null : null });
  } catch (e) {
    console.warn("[team channel] ping failed", e);
  }
  revalidateCenters();
  return { ok: true, message: mentions.length ? "Posted & tagged." : "Posted." };
}

async function tellChannelPeople(p: { messageId: string; authorId: string | null; authorName: string; text: string; mentions: string[]; parentAuthorId: string | null }) {
  const reach = Array.from(new Set([...p.mentions, ...(p.parentAuthorId ? [p.parentAuthorId] : [])])).filter((id) => id !== p.authorId);
  if (reach.length === 0) return;
  const [members, logins, owners, { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId }, { slackMentionDm }, { notifyInApp }, { teamChannelHref }] = await Promise.all([
    prisma.teamMember.findMany({ where: { id: { in: reach }, active: true }, select: { id: true, name: true } }),
    prisma.appUser.findMany({ where: { teamMemberId: { in: reach }, status: "ACTIVE" }, select: { teamMemberId: true, role: true, permissions: true } }),
    import("@/lib/smsPrefs").then((m) => m.ownerTeamMemberIds()).catch(() => [] as string[]),
    import("@/lib/editors"),
    import("@/lib/mentions"),
    import("@/lib/notify"),
    import("@/lib/teamChannel"),
  ]);
  const editorKeyOf = new Map<string, string>();
  for (const key of TEAM_MEMBER_EDITOR_KEYS) {
    const tmId = await editorTeamMemberId(key);
    if (tmId) editorKeyOf.set(tmId, key);
  }
  for (const m of members) {
    const login = logins.find((l) => l.teamMemberId === m.id) ?? null;
    const href = teamChannelHref(login, p.messageId);
    const isReply = !p.mentions.includes(m.id);
    const editorKey = editorKeyOf.get(m.id) ?? null;
    const slackDm = slackMentionDm({
      author: p.authorName,
      street: "the team channel",
      context: "everyone on the team reads it",
      text: p.text,
      href,
      reply: isReply,
      ownerRecipient: owners.includes(m.id),
    });
    const targets: import("@/lib/notify").NotifyTarget[] = [
      { roles: editorKey ? ["OWNER", "ADMIN", "EDITOR"] : ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${m.id}`, href, slackDm },
    ];
    if (editorKey) targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: teamChannelHref({ role: "EDITOR" }, p.messageId), slackDm });
    const first = p.authorName.split(/\s+/)[0];
    await notifyInApp({
      kind: isReply ? "note_reply" : "mention",
      title: isReply ? `${first} replied to you in the team channel` : `${first} mentioned you in the team channel`,
      body: p.text.slice(0, 140),
      href,
      targets,
      dedupeKey: `channel-${isReply ? "reply" : "mention"}-${p.messageId}-${m.id}`,
    });
  }
}

export async function markTeamChannelRead(lastMessageId: string): Promise<ChannelResult> {
  await requireTeam();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser();
  if (!me || me.impersonating) return { ok: false, message: "Sign in to mark the channel read." };
  const last = await prisma.teamChannelMessage.findUnique({ where: { id: lastMessageId }, select: { channel: true, createdAt: true } });
  if (!last || last.channel !== "team") return { ok: false, message: "That message is not in the team channel." };
  const { markTeamChannelSeen } = await import("@/lib/teamChannel");
  await markTeamChannelSeen(me.id, last.createdAt);
  revalidateCenters();
  return { ok: true, message: "Channel marked read." };
}

/** May the person asking use this conversation's composer? */
async function composerConversation(key: string) {
  await requireTeam();
  const conv = parseConversationKey(key);
  if (!conv) throw new Error("That conversation doesn't exist.");
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const { canReadConversation } = await import("@/lib/hubLinkAccess");
  if (!(await canReadConversation(me, conv))) throw new Error("You can only add pages to conversations you are in.");
  return conv;
}

/** Before a file uploads: the folder this login's files for this conversation
 *  go in (the token route signs nothing outside it), or why files can't be
 *  sent here. */
export async function messageUploadStart(conversation: string): Promise<{ ok: true; prefix: string } | { ok: false; message: string }> {
  try {
    const conv = await composerConversation(conversation);
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    if (!me) return { ok: false, message: "Sign in to send files." };
    const { messageFileStore, NO_FILE_STORE } = await import("@/lib/messageAttachments");
    if (!messageFileStore()) return { ok: false, message: NO_FILE_STORE };
    const { messageFilePrefix } = await import("@/lib/messageFiles");
    return { ok: true, prefix: messageFilePrefix(conv, me.id) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Files can't be sent here." };
  }
}

/** "Link a hub page": pages matching the search that EVERYONE in this
 *  conversation can open, and a count of the ones someone can't. */
export async function searchHubPages(conversation: string, q: string): Promise<ShareableSearch> {
  const conv = await composerConversation(conversation);
  const { searchShareableLinks } = await import("@/lib/hubLinkAccess");
  return searchShareableLinks(conv, String(q ?? ""));
}

/** A pasted hub URL, checked against everyone in the conversation. */
export async function checkHubPage(conversation: string, url: string): Promise<{ ok: true; link: HubLinkRef & { href: string } } | { ok: false; message: string }> {
  const conv = await composerConversation(conversation);
  const parsed = parseHubUrl(String(url ?? ""));
  if ("error" in parsed) return { ok: false, message: parsed.error };
  const { checkHubLinks } = await import("@/lib/hubLinkAccess");
  const r = await checkHubLinks(conv, [parsed]);
  if (!r.ok) return r;
  const link = r.refs[0];
  return { ok: true, link: { ...link, href: hubLinkPath(link) } };
}
