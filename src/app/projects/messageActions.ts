"use server";

import { requireRole } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type MsgResult = { ok: boolean; message: string };

// Editors post in the team thread from the editor queue, so allow all staff
// roles (photographers use the shoot-app messaging instead).
const requireStaff = () => requireRole(["OWNER", "ADMIN", "EDITOR"]);

// Post a message to a project's team thread. The author is WHOEVER IS LOGGED
// IN — Jordan: "the project chat should not have the name selector and just be
// the name of the person who is logged in." The session name resolves to a
// TeamMember for the avatar/mention machinery; a session with no Team row
// still posts under their own name. The client-passed authorId only matters
// in sessionless local dev (auth off), where there's no identity to derive.
export async function postProjectMessage(
  projectId: string,
  clientAuthorId: string | null,
  body: string,
  mentionIds: string[] = [],
  replyToId?: string | null,
): Promise<MsgResult> {
  await requireStaff();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };

  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  let authorId: string | null = null;
  let authorName: string | null = null;
  const myName = me?.name?.trim();
  if (me) {
    // The login's LINKED Team row first (reviewer, Sep 15: the self-tag and
    // self-reply rules below compare this id exactly, so it has to be the
    // writer's own row, not a name lookalike), then the exact display name,
    // then the roster email, then the first name. A logged-in user with no
    // row still posts as THEMSELVES (name or email), never as a client-chosen
    // TeamMember — the passed authorId is a spoof vector once a session
    // exists (adversarial review).
    const select = { id: true, name: true };
    const first = myName?.split(/\s+/)[0];
    const tm =
      (me.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select }) : null) ??
      (myName ? await prisma.teamMember.findFirst({ where: { name: { equals: myName, mode: "insensitive" } }, select }) : null) ??
      (me.email
        ? await prisma.teamMember.findFirst({ where: { email: { equals: me.email, mode: "insensitive" }, active: true }, select })
        : null) ??
      (first ? await prisma.teamMember.findFirst({ where: { name: { contains: first, mode: "insensitive" } }, select }) : null);
    authorId = tm?.id ?? null;
    authorName = tm?.name ?? myName ?? me.email ?? "Team";
  } else if (!authEnforced() && clientAuthorId) {
    // Sessionless local dev only — no identity exists to derive.
    const m = await prisma.teamMember.findUnique({ where: { id: clientAuthorId }, select: { name: true } });
    authorId = m ? clientAuthorId : null;
    authorName = m?.name ?? null;
  }

  // The composer resolves only the full names it inserted itself ("@John
  // Mark"); a hand-typed "@John" posted without picking rang nobody. Jordan,
  // Sep 15: "if I type at John or at Kyle, a notification is sent to them" —
  // so the roster-aware matcher the note surfaces use runs here too (an
  // ambiguous first name still needs the full name; "info@kim…" is not Kim).
  const { matchMentions } = await import("@/lib/mentions");
  const roster = text.includes("@")
    ? await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true } }).catch(() => [])
    : [];
  const mentions = Array.from(new Set([...mentionIds.filter(Boolean), ...matchMentions(text, roster).map((p) => p.id)]));
  const msg = await prisma.projectMessage.create({
    data: {
      projectId,
      authorId: authorId || null,
      authorName,
      body: text.slice(0, 2000),
      mentions: mentions.length ? JSON.stringify(mentions) : null,
      replyToId: replyToId || null,
    },
  });

  // Notify each tagged teammate with a to-do so the mention isn't missed. One open
  // "you were tagged on this job" task per (project, member) — a later tag
  // refreshes it (and reopens if they'd closed it) instead of piling up dupes.
  if (mentions.length) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, clientId: true } });
    const tagged = await prisma.teamMember.findMany({ where: { id: { in: mentions } }, select: { id: true, name: true, role: true } });
    const street = project?.title?.split(",")[0] ?? "a project";
    // Editor resolution + role-aware routing — the SAME shape as the note-comment
    // mentions (src/lib/mentions.ts): an editor gets their tm: row plus the
    // editor:<key> row their login sees, with an href their role can actually
    // open. Roles are visibility only (Sep 15) — which channels a row goes out
    // on is the person's row on /settings → Team notifications (notify.ts).
    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const { slugForName } = await import("@/lib/assignees");
    const editorTmIds = new Map<string, string>();
    for (const key of TEAM_MEMBER_EDITOR_KEYS) {
      const tmId = await editorTeamMemberId(key);
      if (tmId) editorTmIds.set(tmId, key);
    }
    // The owner's roster row(s): a DM TO the owner keeps money in its quote
    // (Sep 15), so the loop needs to know who he is whoever is writing (read
    // every time, cached ten minutes). They also stand in for the writer on
    // a SESSIONLESS request (dev) that named nobody.
    const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
    // A tag of himself in his own message rings the bell and nothing more
    // (reviewer, Sep 11) — decided by the writer's OWN row, exactly, now that
    // authorId comes off the login's linked row (reviewer, Sep 15: a second
    // owner login with no Team row tagging "@Jordan" is not Jordan tagging
    // himself, and must reach him). The owners inference only when nothing
    // identified the writer at all.
    const inferOwner = !me && !authorId;
    for (const t of tagged) {
      const editorKey = editorTmIds.get(t.id) ?? null;
      const selfTag = t.id === authorId || (inferOwner && owners.includes(t.id));
      // A tagged photographer who doesn't own this shoot gets bounced off
      // /shoot/<id> to the bare list — send them to the list directly (their
      // tag task carries the context); the owning shooter still deep-links.
      let photogHref = `/shoot/${projectId}`;
      if (t.role === "PHOTOGRAPHER") {
        try {
          const { photographerOwnsShoot } = await import("@/lib/shoot");
          if (!(await photographerOwnsShoot(projectId, t.id))) photogHref = "/shoot";
        } catch { /* keep the deep link on lookup hiccups */ }
      }
      const href =
        t.role === "PHOTOGRAPHER" ? photogHref : editorKey ? `/edit/${projectId}` : `/projects/${projectId}`;
      const data = {
        taskType: "internal_instruction",
        title: `${authorName ?? "Team"} tagged you — ${street}`.slice(0, 120),
        summary: `${authorName ?? "A teammate"} tagged you in the ${street} team thread: “${text.slice(0, 200)}”. Take any needed action and reply in the thread.`.slice(0, 500),
        description: text.slice(0, 400),
        reasonCreated: "You were tagged in a team message",
        source: "team",
        priority: "HIGH" as const,
        dueAt: new Date(Date.now() + 4 * 3600_000),
        projectId,
        clientId: project?.clientId ?? null,
        ownerId: t.id,
        // On the tagged person's OWN board (editor boards filter by editor key;
        // everyone else by name slug) — ownerId alone is write-only and shows
        // on no surface (audit: invisible @mention tasks).
        assignedKey: editorKey ?? slugForName(t.name),
        dedupeKey: `mention-${projectId}-${t.id}`,
      };
      const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: data.dedupeKey } });
      if (existing) await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } }).catch(() => {});
      else await prisma.smartTask.create({ data }).catch(() => {});
      // Bell mirror: the tagged person (whatever their role), keyed per message
      // so every new tag rings even when the task above just refreshed. The
      // money clamp strips the body for creative roles automatically.
      try {
        const { notifyInApp } = await import("@/lib/notify");
        const { slackMentionDm } = await import("@/lib/mentions");
        // The sentence (Jordan, Sep 15: "if I type at John or at Kyle, a
        // notification is sent to them directly in Slack with a link to the
        // message and a summary"): who, where, the first ~240 characters, and
        // the same link the bell row carries — the Slack DM, and the text in
        // plain-text form (James and Harrison's default; the owner's Sep 11
        // text rides it too). Off on a self-tag = bell only.
        const slackDm = selfTag
          ? null
          : slackMentionDm({
              author: authorName ?? "A teammate",
              street,
              context: "the job's team chat",
              text,
              href,
              ownerRecipient: owners.includes(t.id),
            });
        const targets: import("@/lib/notify").NotifyTarget[] = [
          {
            roles: editorKey ? ["OWNER", "ADMIN", "EDITOR"] : ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"],
            userKey: `tm:${t.id}`,
            href,
            ...(slackDm ? { slackDm } : {}),
          },
        ];
        // The row the EDITOR login sees carries the same sentence — notify.ts
        // delivers ONCE per person, whichever of the two rows is new first.
        if (editorKey) targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${projectId}`, ...(slackDm ? { slackDm } : {}) });
        await notifyInApp({
          kind: "mention",
          title: `${authorName ?? "Team"} mentioned you — ${street}`,
          body: text.slice(0, 140),
          href,
          targets,
          dedupeKey: `mention-${msg.id}-${t.id}`,
        });
      } catch { /* bell is best-effort */ }
    }
  }

  // A reply answers a PERSON — reach them (Jordan, Sep 15). Until now the
  // reply arrow only quoted the parent; the author heard nothing unless the
  // reply also @-tagged them. The tagged people above already got their ping
  // (and DM), so they are excluded here. Best-effort: the message is saved.
  const reached = new Set(mentions);
  if (replyToId) {
    try {
      const { notifyMessageReply } = await import("@/lib/mentions");
      for (const id of await notifyMessageReply({
        projectId,
        messageId: msg.id,
        replyToId,
        replierTmId: authorId,
        inferOwnerReplier: !me && !authorId,
        replierName: authorName,
        text,
        excludeTmIds: mentions,
      })) reached.add(id);
    } catch { /* the reply ping is best-effort */ }
  }

  // …and the job's EDITOR hears every message on their job (Jordan, Sep 15:
  // "a message was sent on their project"), once — unless they wrote it or
  // were already reached above. Their row on /settings decides the channel.
  try {
    const { notifyProjectMessage } = await import("@/lib/mentions");
    await notifyProjectMessage({
      projectId,
      messageId: msg.id,
      authorTmId: authorId,
      authorKey: me?.editorKey ? `editor:${me.editorKey}` : null,
      authorName,
      text,
      context: "the job's team chat",
      excludeTmIds: [...reached],
    });
  } catch { /* the job-message ping is best-effort */ }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/editing");
  revalidatePath("/editing/messages"); // the message center renders these threads too
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: mentions.length ? "Posted & tagged." : "Posted." };
}

// Leave a note from a task — it posts into that task's project team-message
// thread (so notes live with the job, visible to the crew).
export async function addTaskNote(taskId: string, note: string): Promise<MsgResult> {
  await requireStaff();
  const text = note.trim();
  if (!text) return { ok: false, message: "Write a note first." };
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { projectId: true, title: true },
  });
  if (!task?.projectId) return { ok: false, message: "This task isn't tied to a project." };
  await prisma.projectMessage.create({
    data: {
      projectId: task.projectId,
      authorName: "Note",
      body: `📝 ${task.title}\n${text}`.slice(0, 2000),
    },
  });
  revalidatePath(`/projects/${task.projectId}`);
  revalidatePath("/queue");
  return { ok: true, message: "Note added to project messages." };
}
