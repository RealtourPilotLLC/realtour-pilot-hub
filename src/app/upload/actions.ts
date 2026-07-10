"use server";

import { requireDeliverableAccess, requireShootAccess, requireUploadFileAccess } from "@/lib/auth/guards";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { ProjectStatus, DeliverableStatus, ActivityType } from "@prisma/client";
import { saveUpload, deleteFile } from "@/lib/storage";

/** Save one or more files, optionally tied to a deliverable, and mark it uploaded. */
export async function uploadFiles(
  projectId: string,
  deliverableId: string | null,
  formData: FormData,
) {
  await requireShootAccess(projectId);
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  const created = [];
  for (const file of files) {
    if (file.size === 0) continue;
    const meta = await saveUpload(projectId, file);
    const row = await prisma.uploadedFile.create({
      data: {
        projectId,
        deliverableId: deliverableId ?? undefined,
        originalName: meta.originalName,
        storedPath: meta.storedPath,
        size: meta.size,
        mimeType: meta.mimeType,
      },
    });
    created.push({ id: row.id, originalName: row.originalName, size: row.size });
  }

  if (deliverableId && created.length) {
    await prisma.deliverable.update({
      where: { id: deliverableId },
      data: { status: DeliverableStatus.UPLOADED },
    });
  }

  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return created;
}

export async function removeUpload(fileId: string) {
  await requireUploadFileAccess(fileId);
  const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
  if (!file) return;
  await deleteFile(file.storedPath);
  await prisma.uploadedFile.delete({ where: { id: fileId } });
  revalidatePath(`/upload/${file.projectId}`);
  revalidatePath(`/projects/${file.projectId}`);
}

/**
 * Tick a deliverable off the upload checklist. Photographers upload to Dropbox
 * directly (no in-app files), so this is the accountability signal that the raw
 * files for this item are in. Also nudges the deliverable status to UPLOADED so
 * the rest of the pipeline reflects it immediately.
 */
export async function markDeliverableUploaded(
  deliverableId: string,
  uploaded: boolean,
): Promise<{ ok: boolean }> {
  await requireDeliverableAccess(deliverableId);
  const d = await prisma.deliverable.findUnique({ where: { id: deliverableId }, select: { projectId: true, status: true } });
  if (!d) return { ok: false };
  await prisma.deliverable.update({
    where: { id: deliverableId },
    data: {
      uploadedAt: uploaded ? new Date() : null,
      // Only move PENDING → UPLOADED on tick; never downgrade work already in
      // progress / done, and clearing the tick leaves the status alone.
      ...(uploaded && d.status === DeliverableStatus.PENDING ? { status: DeliverableStatus.UPLOADED } : {}),
    },
  });
  revalidatePath(`/upload/${d.projectId}`);
  revalidatePath(`/projects/${d.projectId}`);
  return { ok: true };
}

export async function flagIssue(projectId: string, body: string) {
  await requireShootAccess(projectId);
  const trimmed = body.trim();
  if (!trimmed) return;
  await prisma.activity.create({
    data: { projectId, type: ActivityType.FLAG, body: trimmed },
  });
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
}

// The photographer's debrief on how the shoot went. "issues" routes it to ops
// as a FLAG + a Kyle to-do; "smooth" just logs a note on the timeline.
export async function submitAppointmentFeedback(
  projectId: string,
  wentWell: boolean,
  note: string,
): Promise<{ ok: boolean; message: string }> {
  await requireShootAccess(projectId);
  const trimmed = note.trim();
  const body = `Shoot debrief — ${wentWell ? "went smoothly" : "had issues"}${trimmed ? `: ${trimmed}` : "."}`;
  await prisma.activity.create({
    data: { projectId, type: wentWell ? ActivityType.NOTE : ActivityType.FLAG, body },
  });
  if (!wentWell) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, clientId: true } });
    const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
    await prisma.smartTask.upsert({
      where: { dedupeKey: `shoot-issue-${projectId}` },
      create: {
        taskType: "internal_instruction",
        title: `Shoot issue — ${project?.title ?? "a shoot"}`.slice(0, 120),
        summary: `The photographer flagged a problem during the shoot debrief on ${project?.title?.split(",")[0] ?? "this job"}: “${(trimmed || "Photographer flagged an issue.").slice(0, 200)}” — review and follow up.`.slice(0, 500),
        description: trimmed.slice(0, 400) || "Photographer flagged an issue on the shoot.",
        reasonCreated: "Photographer flagged a problem during the appointment debrief.",
        source: "manual",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 4 * 3600_000),
        ownerId: kyle?.id ?? null,
        projectId,
        clientId: project?.clientId ?? null,
        dedupeKey: `shoot-issue-${projectId}`,
      },
      update: { status: "OPEN", completedAt: null, description: trimmed.slice(0, 400) || "Photographer flagged an issue." },
    });
  }
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: wentWell ? "Thanks — logged." : "Logged and flagged for Kyle." };
}

/**
 * Finalize the guided upload: save the editor brief + per-item notes, advance the
 * project to "Shot / Uploaded", generate the editor PDF into the project folder,
 * and log it on the timeline.
 */
export async function finalizeUpload(
  projectId: string,
  data: { editorBrief: string; itemNotes?: Record<string, string>; force?: boolean },
): Promise<{ pdfPath?: string; needsConfirm?: boolean; warning?: string }> {
  await requireShootAccess(projectId);
  // First finalize or a re-submit? The raws-landed handoff below only fires on
  // the FIRST completed upload (the transition), never on edits/re-submits.
  const prior = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      uploadedAt: true,
      title: true,
      addressLine: true,
      shootDate: true,
      createdAt: true,
      client: { select: { name: true } },
      deliverables: { select: { type: true } },
    },
  });
  const firstFinalize = !prior?.uploadedAt;

  // SERVER-SIDE completeness check against the ORDER (the old client-side
  // confirm was honor-system only — July 2026 audit: "photos-only upload reads
  // as raws-in for a video job"). Compare what was ordered against what's
  // actually in the raw folders; a mismatch bounces back for an explicit
  // confirm instead of silently handing editors an empty folder. Dropbox
  // unreadable → don't block (unknown is not proof of absence).
  if (!data.force && prior) {
    try {
      const { projectFolderPaths, folderFileCount } = await import("@/lib/dropboxFolders");
      const paths = projectFolderPaths(prior);
      const wantsVideo = prior.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
      const wantsPhotos = prior.deliverables.some((d) => d.type === "PHOTOS" || d.type === "DRONE");
      const [rawPhotos, rawVideo] = await Promise.all([
        wantsPhotos ? folderFileCount(paths.rawPhotos) : Promise.resolve(null),
        wantsVideo ? folderFileCount(paths.rawVideo) : Promise.resolve(null),
      ]);
      const missing: string[] = [];
      if (wantsPhotos && rawPhotos === 0) missing.push("the RAW-Photos folder is empty");
      if (wantsVideo && rawVideo === 0) missing.push("the RAW-Video folder is empty (a video is ordered!)");
      if (missing.length > 0) {
        return {
          needsConfirm: true,
          warning: `Hold on — ${missing.join(" and ")}. If you already uploaded, give Dropbox a minute and re-check the folder name. Submit anyway?`,
        };
      }
    } catch { /* can't check → don't block the submit */ }
  }
  // Persist per-deliverable notes when provided (the simplified checklist portal
  // doesn't send these, but other callers may).
  for (const [deliverableId, note] of Object.entries(data.itemNotes ?? {})) {
    if (note?.trim()) {
      await prisma.deliverable.update({
        where: { id: deliverableId },
        data: { notes: note.trim() },
      });
    }
  }

  await prisma.project.update({
    where: { id: projectId },
    data: {
      // Only overwrite the brief when the finalize actually carries one — a
      // re-finalize with an empty field must not wipe the photographer's notes.
      ...(data.editorBrief.trim() ? { editorBrief: data.editorBrief.trim() } : {}),
      uploadedAt: new Date(),
    },
  });

  // Advance into the editing pipeline if still pre-shoot.
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (
    project &&
    (project.status === ProjectStatus.BOOKED ||
      project.status === ProjectStatus.SCHEDULED)
  ) {
    await prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.SHOT },
    });
  }

  // The editor brief PDF is generated on demand from the project data
  // (/api/projects/<id>/editor-brief) rather than written to disk — Vercel's
  // filesystem is ephemeral, and this way the brief always reflects the latest
  // details. Mark the link so the project + upload pages surface it.
  const pdfPath = `/api/projects/${projectId}/editor-brief`;
  await prisma.project.update({
    where: { id: projectId },
    data: { editorPdfPath: pdfPath },
  });

  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.FILE,
      body: "Photographer completed upload. Editor brief is ready for the editors.",
    },
  });

  // Raws are in → refresh the evidence and run the FULL editor handoff now
  // (bench ping + edit_video task + Luma dispatch + editorId), instead of
  // waiting up to an hour for the cron. The old wiring only pinged Slack and
  // never minted the editor's work item (July 2026 audit: "both photographer
  // 'done' buttons suppress the editor handoff"). syncProjectStatuses re-reads
  // Aryeo/Dropbox and calls the idempotent ensureEditorHandoff inside.
  if (firstFinalize) {
    try {
      const { syncProjectStatuses } = await import("@/lib/projectStatus");
      await syncProjectStatuses({ projectId });
    } catch {
      // Evidence sync failed (Dropbox blip?) — at least announce the raws; the
      // hourly sweep will complete the handoff.
      try {
        const { notifyRawsLanded } = await import("@/lib/tasks");
        await notifyRawsLanded(projectId);
      } catch { /* non-fatal */ }
    }
  }

  // Auto-create the Frame.io review project for VIDEO jobs (editors upload their
  // finished video there). Best-effort — never block the photographer's submit.
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { title: true, frameioProjectId: true, client: { select: { name: true } }, deliverables: { select: { type: true } } },
    });
    const isVideo = p?.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    if (p && isVideo && !p.frameioProjectId) {
      const { frameioConnected, createFrameioProject } = await import("@/lib/integrations/frameio");
      if (await frameioConnected()) {
        const street = (p.title || "").split(",")[0].trim() || p.title || "Project";
        const proj = await createFrameioProject(`${street} — ${p.client?.name ?? "Client"}`.slice(0, 250));
        await prisma.project.update({ where: { id: projectId }, data: { frameioProjectId: proj.id, frameioViewUrl: proj.viewUrl } });
      }
    }
  } catch { /* non-fatal */ }

  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
  return { pdfPath };
}
