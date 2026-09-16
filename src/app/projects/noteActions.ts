"use server";

import { revalidatePath } from "next/cache";
import { ActivityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// The project page's composer posts HERE (Kyle call, Sep 16). Three things
// were wrong with the old addNote in src/app/actions.ts: it never stamped an
// author (0 of 41 notes all-time carried one — every row read "System"), it
// rang nobody, and nothing on the page said which audience each type
// reaches. So: the author comes off the login exactly the way the team chat
// resolves its writer (messageActions.ts postProjectMessage), and a REQUEST —
// the one type that fans out to the shoot screen, the upload page and the
// editor brief (SPECIAL_REQUEST, src/lib/shoot.ts / src/app/edit/[id]) — also
// pings the assigned photographer and the current editor through the bell
// bridge, so their own row on /settings → Team notifications decides whether
// it is a text, a Slack DM, or the bell alone. A NOTE stays office-only; a
// FLAG is an issue on the job. addNote itself is left as it was for its other
// callers.

export type NoteResult = { ok: boolean; message: string };

const COMPOSER_TYPES: ActivityType[] = [ActivityType.SPECIAL_REQUEST, ActivityType.NOTE, ActivityType.FLAG];

export async function addProjectNote(
  projectId: string,
  body: string,
  type: ActivityType = ActivityType.SPECIAL_REQUEST,
): Promise<NoteResult> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write something first." };
  // Only the composer's three kinds are human rows; everything else on the
  // enum is machine-written (STATUS_CHANGE, FILE, SYSTEM…).
  if (!COMPOSER_TYPES.includes(type)) type = ActivityType.NOTE;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      photographerId: true,
      appointments: {
        where: { status: { not: "CANCELED" } },
        orderBy: { startAt: "asc" },
        select: { assignedToId: true },
        take: 1,
      },
    },
  });
  if (!project) return { ok: false, message: "That job no longer exists." };

  const me = await getCurrentUser().catch(() => null);
  const author = await resolveAuthor(me);

  const activity = await prisma.activity.create({
    data: { projectId, body: text.slice(0, 4000), type, authorId: author.id },
  });

  // A closed job rings nobody (the proposal's rule): a request typed on a
  // delivered or cancelled listing is a record, not a job for the crew — the
  // words still land on every surface, the phones stay quiet.
  const closed = project.status === "DELIVERED" || project.status === "CANCELLED";
  if (type === ActivityType.SPECIAL_REQUEST && !closed) {
    await notifyRequest({
      projectId,
      activityId: activity.id,
      title: project.title,
      text,
      author,
      photographerId: project.photographerId ?? project.appointments[0]?.assignedToId ?? null,
    });
  }

  revalidatePath(`/projects/${projectId}`);
  // The request renders on every crew surface — refresh the ones that cache.
  if (type === ActivityType.SPECIAL_REQUEST) {
    revalidatePath(`/shoot/${projectId}`);
    revalidatePath(`/upload/${projectId}`);
    revalidatePath(`/edit/${projectId}`);
    revalidatePath("/ops");
  }
  return {
    ok: true,
    message:
      type === ActivityType.SPECIAL_REQUEST
        ? closed
          ? "Request posted — this job is closed, so nobody was pinged."
          : "Request posted — the photographer and the editor have it."
        : type === ActivityType.FLAG
          ? "Flagged."
          : "Note added (office only).",
  };
}

// The writer's roster row — the SAME ladder the team chat uses for its author
// (messageActions.ts, Sep 15): the login's linked Team row first, then the
// exact display name, then the roster email, then the first name. A login
// with no roster row still posts under their own name in the ping; the
// timeline can only name a TeamMember (Activity.authorId), so such a row
// keeps reading "System" there until the person is on the roster.
async function resolveAuthor(
  me: { teamMemberId: string | null; name: string | null; email: string } | null,
): Promise<{ id: string | null; name: string | null }> {
  if (!me) return { id: null, name: null };
  const select = { id: true, name: true };
  const myName = me.name?.trim();
  const first = myName?.split(/\s+/)[0];
  try {
    const tm =
      (me.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select }) : null) ??
      (myName ? await prisma.teamMember.findFirst({ where: { name: { equals: myName, mode: "insensitive" } }, select }) : null) ??
      (me.email
        ? await prisma.teamMember.findFirst({ where: { email: { equals: me.email, mode: "insensitive" }, active: true }, select })
        : null) ??
      (first ? await prisma.teamMember.findFirst({ where: { name: { contains: first, mode: "insensitive" } }, select }) : null);
    return { id: tm?.id ?? null, name: tm?.name ?? myName ?? me.email ?? null };
  } catch {
    return { id: null, name: myName ?? me.email ?? null };
  }
}

// A Request rings the two people who have to act on it. Both rows go through
// notifyInApp so the bridge (src/lib/notify.ts) reads each person's matrix:
// James and Harrison default to a text on "Shoot changes", John and Kim to a
// Slack DM on "Job pings" (src/lib/notifyPrefDefaults.ts). The kinds are the
// two that already map onto those switches in notifyPrefs.ts KIND_TO_EVENT —
// task_assigned → shoot_change ("someone put a job on YOUR name"),
// edit_assigned → job_ping — an unmapped kind would be bell-only by design.
// The sentence is the brief's: "📌 <author> added a request on <street> —
// <first 160 chars>" and the link; money scrubbed for anyone but the owner.
// The author's own row is skipped (Kyle adding a request on Kyle's job
// doesn't need a text about it). Best-effort by contract: the activity row is
// already saved, so nothing here may throw past it.
async function notifyRequest(opts: {
  projectId: string;
  activityId: string;
  title: string;
  text: string;
  author: { id: string | null; name: string | null };
  photographerId: string | null;
}): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const { currentEditorForProject } = await import("@/lib/mentions");
    const { ownerTeamMemberIds } = await import("@/lib/smsPrefs");
    const { appBase } = await import("@/lib/appUrl");
    const { clip, escapeSlack, scrubMoney, stripInvisible } = await import("@/lib/text");

    const street = opts.title.split(",")[0]?.trim() || "a job";
    const authorName = opts.author.name ?? "The office";
    const oneLine = stripInvisible(opts.text).replace(/\s+/g, " ").trim();
    const owners = await ownerTeamMemberIds().catch(() => [] as string[]);
    const sentence = (href: string, ownerRecipient: boolean) => {
      const summary = clip(ownerRecipient ? oneLine : scrubMoney(oneLine), 160);
      return `${escapeSlack(`📌 ${authorName} added a request on ${street} — ${summary}`)}\n${appBase()}${href}`;
    };
    const title = `${authorName} added a request — ${street}`.slice(0, 90);
    const body = clip(scrubMoney(oneLine), 140); // auto-nulled by the money clamp on creative rows

    // The assigned photographer — the project's, else the appointment's
    // assignee (a second shooter's job has no photographerId).
    const pid = opts.photographerId;
    if (pid && pid !== opts.author.id) {
      const href = `/shoot/${opts.projectId}`;
      await notifyInApp({
        kind: "task_assigned",
        title,
        body,
        href,
        targets: [{ roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"], userKey: `tm:${pid}`, href, slackDm: sentence(href, owners.includes(pid)) }],
        dedupeKey: `request-${opts.activityId}-${pid}`,
      });
    }

    // The current editor — the open edit card's holder, else the editor of
    // record (mentions.ts currentEditorForProject; a vendor lane has nobody).
    const editor = await currentEditorForProject(opts.projectId);
    if (editor && editor.tmId !== opts.author.id && editor.tmId !== pid) {
      const href = `/edit/${opts.projectId}`;
      const slackDm = sentence(href, owners.includes(editor.tmId));
      await notifyInApp({
        kind: "edit_assigned",
        title,
        body,
        href,
        targets: [
          { roles: ["OWNER", "ADMIN", "EDITOR"], userKey: `tm:${editor.tmId}`, href, slackDm },
          // The row the EDITOR login sees — notify.ts delivers ONCE per person.
          { roles: ["EDITOR"], userKey: `editor:${editor.editorKey}`, href, slackDm },
        ],
        dedupeKey: `request-${opts.activityId}-${editor.tmId}`,
      });
    }
  } catch (e) {
    console.warn("addProjectNote: request ping failed (the request itself is saved)", e);
  }
}
