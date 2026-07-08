"use server";

import { authEnforced, requireAdmin } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { notifyInApp } from "@/lib/notify";

// ---------------------------------------------------------------------------
// Mutations for the in-house media review room (Frame.io-style). The owner
// drops pin-point notes on delivered assets in two lanes — EDIT (Kyle fixes
// it) and PHOTOGRAPHER (capture feedback to whoever shot it; kind "fix" is
// actionable, "coaching" is do-better-next-time and never mints a task).
// Statuses flow OPEN → FIXED (the creative marks it done) → RESOLVED (owner
// approves). "Send to lane" bundles the open notes into ONE deduped task —
// same many-notes-one-task philosophy as flagActions' 24h fix task — and rings
// the right bell. Reads live in src/lib/review.ts.
//
// The bundled tasks use taskType "todo", NOT "image_fixes": image_fixes is in
// tasks.ts DELIVERED_CLOSE_TYPES, so closeObsoleteTasks(projectId,"DELIVERED")
// — which re-fires whenever a revision resolves on a delivered job (comms.ts)
// or the status flaps back to DELIVERED — would silently blanket-complete the
// review task while notes were still open. Review happens ON delivered jobs,
// so that sweep would fight our own closer (last EDIT note FIXED → complete).
// "todo" is swept by nothing; with assignedKey set it also never lands in the
// "Needs assigning" triage pile (src/lib/triage.ts).
// ---------------------------------------------------------------------------

export type NoteLane = "EDIT" | "PHOTOGRAPHER";
export type NoteKind = "fix" | "coaching";

const EDIT_TASK_KEY = (projectId: string) => `review-edit-${projectId}`;
const PHOTOG_TASK_KEY = (projectId: string) => `review-photog-${projectId}`;

const streetOf = (title?: string | null) => (title || "project").split(",")[0].trim();
const firstNameOf = (name?: string | null) => (name || "").trim().split(/\s+/)[0] || "the photographer";

function refresh(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/shoot/${projectId}`);
}

// Who's writing — authorKey follows the MediaNote convention ("owner" |
// "tm:<teamMemberId>" | "editor:<key>"). Sessionless local dev (enforcement
// off, no cookie) falls back to the owner so the room still works pre-login.
async function sessionAuthor(): Promise<{ authorKey: string; authorName: string | null }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { authorKey: "owner", authorName: "Jordan" };
  const name = u.name ?? u.email;
  if (u.role === "OWNER") return { authorKey: "owner", authorName: name };
  if (u.teamMemberId) return { authorKey: `tm:${u.teamMemberId}`, authorName: name };
  if (u.editorKey) return { authorKey: `editor:${u.editorKey}`, authorName: name };
  return { authorKey: "owner", authorName: name };
}

// Whose capture feedback a PHOTOGRAPHER-lane note is: the project's assigned
// photographer, else the earliest appointment assignee (same resolution order
// the shoot pages use).
async function projectPhotographerId(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { photographerId: true } });
  if (p?.photographerId) return p.photographerId;
  const appt = await prisma.appointment.findFirst({
    where: { projectId, assignedToId: { not: null } },
    orderBy: { startAt: "asc" },
    select: { assignedToId: true },
  });
  return appt?.assignedToId ?? null;
}

// Owner/admin, OR the photographer the ROOT note is addressed to (they may
// only touch their own capture feedback). Mirrors requireShootAccess: no-op
// until enforcement is on, fail-closed after, "view as" is read-only.
async function requireNoteAccess(rootPhotographerId: string | null): Promise<string | null> {
  if (!authEnforced()) return null;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
  if (u.impersonating) throw new Error("You're previewing another user — exit the preview to make changes.");
  if (u.realRole === "OWNER" || u.realRole === "ADMIN") return null;
  if (u.realRole === "PHOTOGRAPHER") {
    const { photographerMemberId } = await import("@/lib/shoot");
    const mid = await photographerMemberId(u);
    if (mid && rootPhotographerId && mid === rootPhotographerId) return mid;
  }
  throw new Error("You don't have access to do that.");
}

// Drop one pin-point note on an asset. Owner/admin only — the review room is
// the owner's desk; creatives respond via reply / mark-fixed, never new pins.
export async function addMediaNote(input: {
  projectId: string;
  assetUrl: string;
  thumbUrl?: string | null;
  assetType: "image" | "video";
  x?: number | null;
  y?: number | null;
  timeSec?: number | null;
  lane: NoteLane;
  kind: NoteKind;
  body: string;
}): Promise<{ ok: boolean; id?: string; message?: string }> {
  try {
    await requireAdmin(); // blocks "view as" + non-owner/admin roles
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, message: "Write the note first." };
  if (input.lane !== "EDIT" && input.lane !== "PHOTOGRAPHER") return { ok: false, message: "Bad lane." };
  if (input.kind !== "fix" && input.kind !== "coaching") return { ok: false, message: "Bad note kind." };
  if (!input.assetUrl) return { ok: false, message: "No asset to note." };

  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
  if (!project) return { ok: false, message: "That project no longer exists." };

  // PHOTOGRAPHER lane: pin the feedback to whoever shot it (scopes their view).
  const photographerId = input.lane === "PHOTOGRAPHER" ? await projectPhotographerId(input.projectId) : null;
  const { authorKey, authorName } = await sessionAuthor();

  const note = await prisma.mediaNote.create({
    data: {
      projectId: input.projectId,
      assetUrl: input.assetUrl,
      thumbUrl: input.thumbUrl ?? null,
      assetType: input.assetType === "video" ? "video" : "image",
      x: input.x ?? null,
      y: input.y ?? null,
      timeSec: input.timeSec ?? null,
      lane: input.lane,
      kind: input.lane === "PHOTOGRAPHER" ? input.kind : "fix", // EDIT lane is always actionable
      body: body.slice(0, 2000),
      status: "OPEN",
      authorKey,
      authorName,
      photographerId,
    },
  });
  refresh(input.projectId);
  return { ok: true, id: note.id };
}

// Threaded reply under a root note. Owner/admin, or the photographer the root
// note is addressed to (they can talk back on their own feedback only).
// Replies inherit the root's asset/lane/kind, carry no pin, and are never
// counted in rollups (those filter parentId null).
export async function replyMediaNote(noteId: string, body: string): Promise<{ ok: boolean; message?: string }> {
  const text = (body ?? "").trim();
  if (!text) return { ok: false, message: "Write a reply first." };

  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  // Replying to a reply re-roots onto the thread's root note.
  const root = note.parentId ? await prisma.mediaNote.findUnique({ where: { id: note.parentId } }) : note;
  if (!root) return { ok: false, message: "That note no longer exists." };

  try {
    await requireNoteAccess(root.photographerId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { authorKey, authorName } = await sessionAuthor();

  await prisma.mediaNote.create({
    data: {
      projectId: root.projectId,
      assetUrl: root.assetUrl,
      thumbUrl: root.thumbUrl,
      assetType: root.assetType,
      lane: root.lane,
      kind: root.kind,
      body: text.slice(0, 2000),
      status: "OPEN", // status is meaningless on replies; rollups skip them
      authorKey,
      authorName,
      photographerId: root.photographerId,
      parentId: root.id,
    },
  });
  refresh(root.projectId);
  return { ok: true };
}

// Flip a root note OPEN → FIXED → RESOLVED. Owner/admin set anything; a
// photographer may only mark THEIR OWN photographer-lane notes FIXED. When the
// LAST open EDIT note flips to FIXED, Kyle's bundled review task auto-completes
// and the owner gets a "Ready for re-review" bell.
export async function setMediaNoteStatus(
  noteId: string,
  status: "OPEN" | "FIXED" | "RESOLVED",
): Promise<{ ok: boolean; message?: string }> {
  if (status !== "OPEN" && status !== "FIXED" && status !== "RESOLVED") return { ok: false, message: "Bad status." };

  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  if (note.parentId) return { ok: false, message: "Replies don't have a status." };

  try {
    if (status === "FIXED" && note.lane === "PHOTOGRAPHER") {
      await requireNoteAccess(note.photographerId); // owner/admin OR that photographer
    } else {
      await requireAdmin(); // reopen + approve stay with the owner's desk
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  await prisma.mediaNote.update({
    where: { id: noteId },
    data: {
      status,
      // RESOLVED stamps the approval; reopening clears it; FIXED leaves it be.
      ...(status === "RESOLVED" ? { resolvedAt: new Date() } : status === "OPEN" ? { resolvedAt: null } : {}),
    },
  });

  // Kyle just fixed the LAST open edit note → close his bundled task and ring
  // the owner for a re-review pass. Best-effort: a bell/task hiccup must never
  // fail the status flip itself.
  if (status === "FIXED" && note.lane === "EDIT") {
    try {
      const stillOpen = await prisma.mediaNote.count({
        where: { projectId: note.projectId, parentId: null, lane: "EDIT", status: "OPEN" },
      });
      if (stillOpen === 0) {
        const task = await prisma.smartTask.findUnique({ where: { dedupeKey: EDIT_TASK_KEY(note.projectId) } });
        if (task && task.status !== "COMPLETED" && task.status !== "CANCELLED") {
          await prisma.smartTask.update({
            where: { id: task.id },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        }
        const [project, fixedCount] = await Promise.all([
          prisma.project.findUnique({ where: { id: note.projectId }, select: { title: true } }),
          prisma.mediaNote.count({ where: { projectId: note.projectId, parentId: null, lane: "EDIT", status: "FIXED" } }),
        ]);
        await notifyInApp({
          kind: "review_ready",
          title: `Ready for re-review — ${streetOf(project?.title)}`,
          href: `/projects/${note.projectId}`,
          targets: [{ roles: ["OWNER"] }],
          // FIXED count in the key = one bell per review round, not per click.
          dedupeKey: `review-ready-${note.projectId}-${fixedCount}`,
        });
      }
    } catch (e) {
      console.warn("review re-review rollup failed", e);
    }
  }

  refresh(note.projectId);
  return { ok: true };
}

// Quick per-asset verdict while arrowing through the gallery. Upsert; null
// clears it back to "unreviewed".
export async function setMediaVerdict(
  projectId: string,
  assetUrl: string,
  verdict: "APPROVED" | "NEEDS_WORK" | null,
): Promise<{ ok: boolean }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false };
  }
  if (!assetUrl) return { ok: false };
  if (verdict === null) {
    await prisma.mediaVerdict.deleteMany({ where: { projectId, assetUrl } });
  } else if (verdict === "APPROVED" || verdict === "NEEDS_WORK") {
    await prisma.mediaVerdict.upsert({
      where: { projectId_assetUrl: { projectId, assetUrl } },
      update: { verdict },
      create: { projectId, assetUrl, verdict },
    });
  } else {
    return { ok: false };
  }
  refresh(projectId);
  return { ok: true };
}

// Bundle a lane's OPEN notes and hand them off: EDIT → ONE deduped 24h task on
// Kyle's plate (+ admin bell); PHOTOGRAPHER → "fix" notes become ONE follow-up
// task on Jordan's plate, and the photographer gets a bell (+ SMS via the
// notify bridge — "review_feedback" is in SMS_KINDS) pointing at their shoot
// page. Re-sending reopens + refreshes the same task instead of duplicating.
export async function sendReviewToLane(projectId: string, lane: NoteLane): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (lane !== "EDIT" && lane !== "PHOTOGRAPHER") return { ok: false, message: "Bad lane." };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, clientId: true },
  });
  if (!project) return { ok: false, message: "That project no longer exists." };
  const street = streetOf(project.title);

  const open = await prisma.mediaNote.findMany({
    where: { projectId, lane, status: "OPEN", parentId: null },
    orderBy: { createdAt: "asc" },
  });
  if (open.length === 0) {
    return { ok: false, message: lane === "EDIT" ? "No open edit notes to send." : "No open photographer notes to send." };
  }
  const s = open.length === 1 ? "" : "s";
  const preview = open.slice(0, 3).map((n) => `• ${n.body.trim()}`).join("\n");
  const description = open.map((n) => `• ${n.body.trim()}`).join("\n").slice(0, 1500);
  const latestId = open[open.length - 1].id;

  if (lane === "EDIT") {
    const key = EDIT_TASK_KEY(projectId);
    const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
    const data = {
      taskType: "todo", // NOT image_fixes — see header comment (DELIVERED sweep would eat it)
      title: `Review fixes — ${street}`.slice(0, 120),
      summary: `${open.length} fix note${s} from the ${street} media review:\n${preview}${open.length > 3 ? `\n…and ${open.length - 3} more` : ""}`.slice(0, 500),
      description,
      reasonCreated: "Owner left fix notes in the media review room",
      source: "system",
      priority: "HIGH" as const,
      dueAt: new Date(Date.now() + 24 * 3600_000), // fix within 24h, same clock as flagActions
      assignedKey: "kyle",
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    };
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
    if (existing) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
    } else {
      await prisma.smartTask.create({ data });
    }
    await notifyInApp({
      kind: "review_feedback",
      title: `Review fixes — ${street}`,
      body: `${open.length} note${s}: ${open[0].body}`.slice(0, 140),
      href: `/projects/${projectId}`,
      targets: [{ roles: ["ADMIN"] }],
      // Latest note id in the key = each fresh send announces once.
      dedupeKey: `review-fb-edit-${projectId}-${latestId}`,
    });
    refresh(projectId);
    return { ok: true, message: `Sent ${open.length} note${s} to Kyle.` };
  }

  // PHOTOGRAPHER lane — feedback goes to whoever shot it.
  const photographerId = open.find((n) => n.photographerId)?.photographerId ?? (await projectPhotographerId(projectId));
  if (!photographerId) return { ok: false, message: "No photographer on this job to send feedback to." };
  const member = await prisma.teamMember.findUnique({ where: { id: photographerId }, select: { name: true } });
  const first = firstNameOf(member?.name);

  // Only "fix" notes are actionable enough for a task; coaching rides the bell.
  const fixes = open.filter((n) => n.kind === "fix");
  if (fixes.length > 0) {
    const key = PHOTOG_TASK_KEY(projectId);
    const fs = fixes.length === 1 ? "" : "s";
    const data = {
      taskType: "todo",
      title: `Capture fixes — ${street} (${first})`.slice(0, 120),
      summary: `${fixes.length} capture fix note${fs} for ${first} from the ${street} media review:\n${fixes.slice(0, 3).map((n) => `• ${n.body.trim()}`).join("\n")}${fixes.length > 3 ? `\n…and ${fixes.length - 3} more` : ""}`.slice(0, 500),
      description: fixes.map((n) => `• ${n.body.trim()}`).join("\n").slice(0, 1500),
      reasonCreated: "Owner flagged capture issues in the media review room",
      source: "system",
      priority: "HIGH" as const,
      dueAt: new Date(Date.now() + 24 * 3600_000),
      assignedKey: "jordan", // owner follows up on capture quality personally
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      dedupeKey: key,
    };
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
    if (existing) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
    } else {
      await prisma.smartTask.create({ data });
    }
  }

  // One bell for ALL open notes (fix + coaching). The SMS bridge sends TITLE +
  // link only, so keep the title short + money-free; the body would carry the
  // note text but the clamp nulls bodies on creative-visible rows anyway.
  await notifyInApp({
    kind: "review_feedback",
    title: `Shoot feedback — ${street}`,
    body: `${open.length} note${s}: ${open[0].body}`.slice(0, 140),
    href: `/shoot/${projectId}`,
    targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${photographerId}`, href: `/shoot/${projectId}` }],
    dedupeKey: `review-fb-photog-${projectId}-${latestId}`,
  });
  refresh(projectId);
  return { ok: true, message: `Sent ${open.length} note${s} to ${first}.` };
}
