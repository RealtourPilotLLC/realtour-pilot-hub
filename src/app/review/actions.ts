"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireAdmin, requireTaskAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { dbx, dropboxSharedLink, DropboxError } from "@/lib/integrations/dropbox";
import { projectFolderPaths } from "@/lib/dropboxFolders";
import { editorForDeliverable, editorMeta, type EditorKey } from "@/lib/editors";
import { notifyInApp, type NotifyTarget } from "@/lib/notify";

// ---------------------------------------------------------------------------
// Mutations for the STANDALONE Review Room (/review). The loop:
//   editor "Done — send to review"  → submitCutForReview(): find the newest
//     video in the project's FINAL Dropbox folder, mint a direct streaming
//     link, park a ReviewSubmission, flip the job to REVIEW, ring OWNER+ADMIN.
//   owner reviews at /review/<projectId> → addCutNote() drops timestamped
//     EDITOR-lane notes (or PHOTOGRAPHER-lane for capture problems) on the cut.
//   requestCutChanges() → bundles the open EDITOR notes into ONE revision task
//     back on the editor's plate (their EditorDay Do-Now), rings their bell.
//   editor re-submits → NEW round; approveCut() → APPROVED + Kyle delivers.
// Reads live in src/lib/reviewRoom.ts. The per-asset PHOTO pin review stays in
// the project gallery (reviewActions.ts) — this file is the CUT loop.
// ---------------------------------------------------------------------------

const streetOf = (title?: string | null) => (title || "this job").split(",")[0].trim();
const CUT_CHANGES_KEY = (projectId: string) => `cut-changes-${projectId}`;

function refresh(projectId: string) {
  revalidatePath("/review");
  revalidatePath(`/review/${projectId}`);
  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
}

// Who's writing (same convention as reviewActions.sessionAuthor).
async function sessionAuthor(): Promise<{ authorKey: string; authorName: string | null }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { authorKey: "owner", authorName: "Jordan" };
  const name = u.name ?? u.email;
  if (u.role === "OWNER") return { authorKey: "owner", authorName: name };
  if (u.teamMemberId) return { authorKey: `tm:${u.teamMemberId}`, authorName: name };
  if (u.editorKey) return { authorKey: `editor:${u.editorKey}`, authorName: name };
  return { authorKey: "owner", authorName: name };
}

// Which editor a project's video work routes to — prefer who actually
// submitted the cut, fall back to the deliverable routing table.
async function projectEditorKey(projectId: string): Promise<string | null> {
  const latest = await prisma.reviewSubmission.findFirst({
    where: { projectId, submittedByKey: { not: null } },
    orderBy: { round: "desc" },
    select: { submittedByKey: true },
  });
  if (latest?.submittedByKey) return latest.submittedByKey;
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { deliverables: { select: { type: true, label: true } }, client: { select: { socialClient: true } } },
  });
  if (!p) return null;
  const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL") ?? p.deliverables[0];
  return editorForDeliverable(v?.type, v?.label, !!p.client?.socialClient);
}

// Owner/admin, OR the editor an EDITOR-lane root note belongs to (they may
// reply + mark-fixed on their OWN feedback only). Mirrors requireNoteAccess in
// reviewActions.ts, with editorKey standing in for photographerId.
async function requireCutNoteAccess(root: { lane: string; editorKey: string | null; photographerId: string | null }): Promise<void> {
  if (!authEnforced()) return;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
  if (u.impersonating) throw new Error("You're previewing another user — exit the preview to make changes.");
  if (u.realRole === "OWNER" || u.realRole === "ADMIN") return;
  if (u.realRole === "EDITOR" && root.lane === "EDITOR" && u.editorKey && u.editorKey === root.editorKey) return;
  if (u.realRole === "PHOTOGRAPHER" && root.lane === "PHOTOGRAPHER" && root.photographerId) {
    const { photographerMemberId } = await import("@/lib/shoot");
    const mid = await photographerMemberId(u);
    if (mid && mid === root.photographerId) return;
  }
  throw new Error("You don't have access to do that.");
}

// Scan the project's FINAL video folder for the newest cut and mint a direct
// streaming link. Best-effort: Dropbox down / folder empty → nulls, and the
// review room degrades to folder links + manual-timestamp notes.
async function findLatestCut(project: {
  title: string;
  addressLine: string | null;
  shootDate: Date | null;
  createdAt: Date;
  client: { name: string };
}): Promise<{ assetUrl: string | null; assetPath: string | null; fileName: string | null }> {
  try {
    const path = projectFolderPaths(project).finalVideo;
    const res = await dbx<{ entries: { ".tag": string; name: string; path_display?: string; server_modified?: string }[] }>(
      "files/list_folder",
      { path },
    );
    const vids = (res.entries ?? [])
      .filter((e) => e[".tag"] === "file" && /\.(mp4|mov|m4v|webm)$/i.test(e.name))
      .sort((a, b) => (b.server_modified ?? "").localeCompare(a.server_modified ?? ""));
    const newest = vids[0];
    if (!newest?.path_display) return { assetUrl: null, assetPath: null, fileName: null };
    const url = await dropboxSharedLink(newest.path_display);
    return { assetUrl: url, assetPath: newest.path_display, fileName: newest.name };
  } catch (e) {
    if (!(e instanceof DropboxError)) console.warn("findLatestCut failed", e);
    return { assetUrl: null, assetPath: null, fileName: null };
  }
}

// The editor's "Done — send to review". Everything sendEditToReview did, PLUS
// a ReviewSubmission row with a playable link so the owner reviews in-house at
// /review/<id> instead of hunting through Dropbox/Frame.io.
export async function submitCutForReview(
  projectId: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  const task = await prisma.smartTask.findFirst({
    where: { projectId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  try {
    // Access keys off the editor's open task (assignedKey = them); owner/admin
    // always pass. No open task → admin only.
    if (task) await requireTaskAccess(task.id);
    else await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, status: true, addressLine: true, shootDate: true, createdAt: true,
      client: { select: { name: true, socialClient: true } },
      deliverables: { select: { type: true, label: true } },
    },
  });
  if (!project) return { ok: false, message: "That project no longer exists." };
  const street = streetOf(project.title);

  const { authorKey, authorName } = await sessionAuthor();
  const editorKey = authorKey.startsWith("editor:") ? authorKey.slice("editor:".length) : await projectEditorKey(projectId);

  // The cut itself — newest video in the FINAL folder, direct-streamable.
  const cut = await findLatestCut(project);

  const lastRound = await prisma.reviewSubmission.findFirst({
    where: { projectId },
    orderBy: { round: "desc" },
    select: { round: true },
  });
  const submission = await prisma.reviewSubmission.create({
    data: {
      projectId,
      kind: "video",
      assetUrl: cut.assetUrl,
      assetPath: cut.assetPath,
      fileName: cut.fileName,
      round: (lastRound?.round ?? 0) + 1,
      status: "PENDING",
      submittedByKey: editorKey,
      submittedByName: authorName,
      note: (note ?? "").trim().slice(0, 1000) || null,
    },
  });

  // Close out the editor's open work item (first submit = edit_video; a
  // re-submit after changes = the bundled revision task).
  await prisma.smartTask.updateMany({
    where: { projectId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  // EDITING/SHOT → REVIEW (never demote a job already past review).
  if (project.status === "EDITING" || project.status === "SHOT") {
    await prisma.project.update({ where: { id: projectId }, data: { status: "REVIEW" } });
  }
  await prisma.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: `Cut submitted for review (round ${submission.round})${cut.fileName ? ` — ${cut.fileName}` : ""}.`,
    },
  });

  try {
    await notifyInApp({
      kind: "review_submitted",
      title: `Cut ready to review — ${street}`,
      body: cut.fileName ?? undefined,
      href: `/review/${projectId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `review-sub-${submission.id}`,
    });
  } catch { /* bell is best-effort */ }

  refresh(projectId);
  return {
    ok: true,
    message: cut.assetUrl
      ? "Sent for review — the cut is queued in the Review Room."
      : "Sent for review. Heads up: no video file was found in the Final folder yet, so upload it there if you haven't.",
  };
}

// Drop one timestamped note on the active cut. Owner/admin only (the review
// desk); the editor responds via reply / re-submission.
export async function addCutNote(input: {
  projectId: string;
  submissionId: string;
  body: string;
  lane: "EDITOR" | "PHOTOGRAPHER";
  kind: "fix" | "coaching";
  timeSec: number | null;
}): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, message: "Write the note first." };
  if (input.lane !== "EDITOR" && input.lane !== "PHOTOGRAPHER") return { ok: false, message: "Bad lane." };

  const submission = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId } });
  if (!submission || submission.projectId !== input.projectId) return { ok: false, message: "That submission no longer exists." };

  const editorKey = input.lane === "EDITOR" ? (submission.submittedByKey ?? (await projectEditorKey(input.projectId))) : null;
  let photographerId: string | null = null;
  if (input.lane === "PHOTOGRAPHER") {
    const p = await prisma.project.findUnique({ where: { id: input.projectId }, select: { photographerId: true } });
    photographerId = p?.photographerId ?? null;
    if (!photographerId) {
      const appt = await prisma.appointment.findFirst({
        where: { projectId: input.projectId, assignedToId: { not: null } },
        orderBy: { startAt: "asc" },
        select: { assignedToId: true },
      });
      photographerId = appt?.assignedToId ?? null;
    }
  }
  const { authorKey, authorName } = await sessionAuthor();

  await prisma.mediaNote.create({
    data: {
      projectId: input.projectId,
      // Cuts with no minted link thread notes under a synthetic key so
      // feedback still works when Dropbox couldn't serve a streamable URL.
      assetUrl: submission.assetUrl ?? `cut:${submission.id}`,
      assetType: "video",
      timeSec: input.timeSec,
      lane: input.lane,
      kind: input.lane === "EDITOR" && input.kind === "coaching" ? "coaching" : input.kind,
      body: body.slice(0, 2000),
      status: "OPEN",
      authorKey,
      authorName,
      editorKey,
      photographerId,
    },
  });
  refresh(input.projectId);
  return { ok: true };
}

// Threaded reply on a cut note — owner/admin, or the editor/photographer the
// root note is addressed to.
export async function replyCutNote(noteId: string, body: string): Promise<{ ok: boolean; message?: string }> {
  const text = (body ?? "").trim();
  if (!text) return { ok: false, message: "Write a reply first." };
  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  const root = note.parentId ? await prisma.mediaNote.findUnique({ where: { id: note.parentId } }) : note;
  if (!root) return { ok: false, message: "That note no longer exists." };
  try {
    await requireCutNoteAccess(root);
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
      status: "OPEN",
      authorKey,
      authorName,
      editorKey: root.editorKey,
      photographerId: root.photographerId,
      parentId: root.id,
    },
  });
  refresh(root.projectId);
  return { ok: true };
}

// OPEN → FIXED → RESOLVED on a cut note. Owner/admin set anything; the editor
// may mark THEIR OWN editor-lane notes FIXED (photographers likewise).
export async function setCutNoteStatus(
  noteId: string,
  status: "OPEN" | "FIXED" | "RESOLVED",
): Promise<{ ok: boolean; message?: string }> {
  if (status !== "OPEN" && status !== "FIXED" && status !== "RESOLVED") return { ok: false, message: "Bad status." };
  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  if (note.parentId) return { ok: false, message: "Replies don't have a status." };
  try {
    if (status === "FIXED") await requireCutNoteAccess(note);
    else await requireAdmin(); // reopen + approve stay with the owner's desk
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  await prisma.mediaNote.update({
    where: { id: noteId },
    data: {
      status,
      ...(status === "RESOLVED" ? { resolvedAt: new Date() } : status === "OPEN" ? { resolvedAt: null } : {}),
    },
  });
  refresh(note.projectId);
  return { ok: true };
}

// APPROVE the cut: verdict on the submission, praise bell to the editor, and a
// delivery nudge to ADMIN (Kyle ships it via the normal delivery flow).
export async function approveCut(submissionId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const submission = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    include: { project: { select: { title: true } } },
  });
  if (!submission) return { ok: false, message: "That submission no longer exists." };
  if (submission.status === "APPROVED") return { ok: true, message: "Already approved." };

  const { authorName } = await sessionAuthor();
  await prisma.reviewSubmission.update({
    where: { id: submissionId },
    data: { status: "APPROVED", decidedAt: new Date(), decidedBy: authorName },
  });
  const street = streetOf(submission.project?.title);
  await prisma.activity.create({
    data: { projectId: submission.projectId, type: "SYSTEM", body: `Cut approved in review (round ${submission.round}).` },
  });

  try {
    const targets: NotifyTarget[] = [{ roles: ["ADMIN"] }];
    if (submission.submittedByKey && editorMeta(submission.submittedByKey)) {
      targets.push({ roles: ["EDITOR"], userKey: `editor:${submission.submittedByKey}`, href: `/edit/${submission.projectId}` });
    }
    await notifyInApp({
      kind: "review_approved",
      title: `Cut approved — ${street}`,
      body: "Ready to deliver.",
      href: `/projects/${submission.projectId}`,
      targets,
      dedupeKey: `review-approved-${submissionId}`,
    });
  } catch { /* bell is best-effort */ }

  refresh(submission.projectId);
  return { ok: true, message: `Approved — Kyle's been pinged to deliver ${street}.` };
}

// REQUEST CHANGES: bundle the open EDITOR-lane notes on this cut into ONE
// revision task on the editor's plate (their EditorDay Do-Now shows it with a
// red Revision chip), flip the job back to EDITING, ring their bell. Re-sending
// reopens + refreshes the same task instead of duplicating.
export async function requestCutChanges(submissionId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const submission = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    include: { project: { select: { title: true, status: true, clientId: true } } },
  });
  if (!submission) return { ok: false, message: "That submission no longer exists." };

  const assetKey = submission.assetUrl ?? `cut:${submission.id}`;
  const open = await prisma.mediaNote.findMany({
    where: { projectId: submission.projectId, parentId: null, lane: "EDITOR", status: "OPEN", assetUrl: assetKey },
    orderBy: { createdAt: "asc" },
  });
  if (open.length === 0) {
    return { ok: false, message: "Add at least one note first — the editor needs to know what to change." };
  }

  const editorKey = (submission.submittedByKey ?? (await projectEditorKey(submission.projectId))) as EditorKey | null;
  if (!editorKey) return { ok: false, message: "No editor is routed to this job — assign one on the Editor Queue first." };

  const street = streetOf(submission.project?.title);
  const s = open.length === 1 ? "" : "s";
  const fmtT = (t: number | null) =>
    t == null ? "" : `[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}] `;
  const lines = open.map((n) => `• ${fmtT(n.timeSec)}${n.body.trim()}`);
  const key = CUT_CHANGES_KEY(submission.projectId);
  const data = {
    taskType: "revision",
    title: `Cut changes — ${street}`.slice(0, 120),
    summary: `${open.length} change${s} requested on the round-${submission.round} cut:\n${lines.slice(0, 3).join("\n")}${open.length > 3 ? `\n…and ${open.length - 3} more` : ""}`.slice(0, 500),
    description: lines.join("\n").slice(0, 1500),
    reasonCreated: "Owner requested changes in the Review Room",
    source: "system",
    priority: "HIGH" as const,
    dueAt: new Date(Date.now() + 24 * 3600_000),
    assignedKey: editorKey,
    projectId: submission.projectId,
    clientId: submission.project?.clientId ?? null,
    propertyAddress: submission.project?.title ?? null,
    dedupeKey: key,
  };
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }

  const { authorName } = await sessionAuthor();
  await prisma.reviewSubmission.update({
    where: { id: submissionId },
    data: { status: "CHANGES_REQUESTED", decidedAt: new Date(), decidedBy: authorName },
  });
  // Back to the cutting room (REVIEW → EDITING); REVISION stays reserved for
  // client-requested post-delivery changes so the comms engine's meaning holds.
  if (submission.project?.status === "REVIEW") {
    await prisma.project.update({ where: { id: submission.projectId }, data: { status: "EDITING" } });
  }
  await prisma.activity.create({
    data: {
      projectId: submission.projectId,
      type: "SYSTEM",
      body: `Changes requested on the round-${submission.round} cut (${open.length} note${s}).`,
    },
  });

  try {
    await notifyInApp({
      kind: "review_changes",
      title: `Changes requested — ${street}`,
      body: `${open.length} note${s}: ${open[0].body}`.slice(0, 140),
      href: `/edit/${submission.projectId}`,
      targets: [{ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${submission.projectId}` }],
      dedupeKey: `review-changes-${submissionId}-${open[open.length - 1].id}`,
    });
  } catch { /* bell is best-effort */ }

  refresh(submission.projectId);
  return { ok: true, message: `Sent ${open.length} change${s} to ${editorMeta(editorKey)?.name ?? editorKey}.` };
}
