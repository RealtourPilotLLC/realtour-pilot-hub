"use server";

import { requireRole } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type MsgResult = { ok: boolean; message: string };

// Editors post in the team thread from the editor queue, so allow all staff
// roles (photographers use the shoot-app messaging instead).
const requireStaff = () => requireRole(["OWNER", "ADMIN", "EDITOR"]);

// Post a message to a project's team thread. Author is picked from the roster
// in the UI (or left as a free name) so editors get attribution.
export async function postProjectMessage(
  projectId: string,
  authorId: string | null,
  body: string,
  mentionIds: string[] = [],
  replyToId?: string | null,
): Promise<MsgResult> {
  await requireStaff();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };

  let authorName: string | null = null;
  if (authorId) {
    const m = await prisma.teamMember.findUnique({ where: { id: authorId }, select: { name: true } });
    authorName = m?.name ?? null;
  }

  const mentions = Array.from(new Set(mentionIds.filter(Boolean)));
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
    // mentions (src/lib/mentions.ts): an editor's tm: row must drop PHOTOGRAPHER
    // (that role in the audience arms the ET-quiet-hours SMS bridge → 3am Manila
    // texts) and they're reached via their editor:<key> channel row instead,
    // with an href their role can actually open.
    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const { slugForName } = await import("@/lib/assignees");
    const editorTmIds = new Map<string, string>();
    for (const key of TEAM_MEMBER_EDITOR_KEYS) {
      const tmId = await editorTeamMemberId(key);
      if (tmId) editorTmIds.set(tmId, key);
    }
    for (const t of tagged) {
      const editorKey = editorTmIds.get(t.id) ?? null;
      const href =
        t.role === "PHOTOGRAPHER" ? `/shoot/${projectId}` : editorKey ? `/edit/${projectId}` : `/projects/${projectId}`;
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
        const targets: import("@/lib/notify").NotifyTarget[] = [
          {
            roles: editorKey ? ["OWNER", "ADMIN", "EDITOR"] : ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"],
            userKey: `tm:${t.id}`,
            href,
          },
        ];
        if (editorKey) targets.push({ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${projectId}` });
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

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/editing");
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
