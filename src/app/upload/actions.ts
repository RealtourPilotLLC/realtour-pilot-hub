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
  // Mirror onto the Feedback & requests board — Jordan's review queue.
  const { fileFieldIssue } = await import("@/lib/fieldIssues");
  await fileFieldIssue({ projectId, note: trimmed, page: `/upload/${projectId}`, label: "Upload issue" });
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
    // Also into Jordan's review queue on the Feedback & requests board. The
    // debrief card re-renders on every portal visit, so re-submits refresh the
    // one open row (dedupe) instead of stacking duplicates.
    const { fileFieldIssue } = await import("@/lib/fieldIssues");
    await fileFieldIssue({
      projectId,
      note: trimmed || "Photographer flagged an issue on the shoot.",
      page: `/upload/${projectId}`,
      label: "Shoot debrief",
      dedupe: true,
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
  data: {
    editorBrief: string;
    itemNotes?: Record<string, string>;
    force?: boolean;
    // Shoot-debrief fields (upload portal rebuild, Aug 31 2026). The job is
    // not done until these are answered — enforced HERE, not just in the UI.
    cullingConfirmed?: boolean;
    removalNotes?: string;
    nothingToRemove?: boolean;
    videoInstructions?: string;
    scriptConfirm?: { state: "as-written" | "edited"; script?: string; note?: string } | null;
  },
): Promise<{ pdfPath?: string; needsConfirm?: boolean; warning?: string; blocked?: string }> {
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
      cullingConfirmedAt: true,
      removalNotes: true,
      videoInstructions: true,
      scriptConfirmedAt: true,
      reelScript: true,
      client: { select: { name: true } },
      deliverables: { select: { type: true } },
    },
  });
  const firstFinalize = !prior?.uploadedAt;

  // ---- The debrief gates (Jordan, Aug 31): the job is not done until the
  // cull is confirmed, removal notes are answered, and video jobs carry the
  // editor's instructions + a confirmed script. Prior answers survive
  // re-submits — nobody re-types a form to fix a typo in the brief.
  if (prior) {
    const wantsPhotosGate = prior.deliverables.some((d) => ["PHOTOS", "DRONE", "TWILIGHT"].includes(d.type));
    const wantsVideoGate = prior.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    if (wantsPhotosGate && !data.cullingConfirmed && !prior.cullingConfirmedAt) {
      return { blocked: "Confirm the cull first — the gallery must be at or under this home's photo cap, with extras in the Backup folder. Overages are deducted at $1/photo." };
    }
    if (wantsPhotosGate && !data.removalNotes?.trim() && !data.nothingToRemove && !prior.removalNotes) {
      return { blocked: "Answer the removal notes — list anything the editor needs to remove (pets, cans, vehicles, clutter), or tick “Nothing needs removal.”" };
    }
    if (wantsVideoGate && !data.videoInstructions?.trim() && !prior.videoInstructions) {
      return { blocked: "Video instructions are required — the flow and your vision for the edit. This can't be left blank; skipping it forfeits premium shoot assignments." };
    }
    if (wantsVideoGate && prior.reelScript && !data.scriptConfirm && !prior.scriptConfirmedAt) {
      return { blocked: "Confirm the script — delivered as written, or edited on site? The editor cuts to whatever you confirm here." };
    }
  }

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

  const scriptEdited = data.scriptConfirm?.state === "edited";
  await prisma.project.update({
    where: { id: projectId },
    data: {
      // Only overwrite the brief when the finalize actually carries one — a
      // re-finalize with an empty field must not wipe the photographer's notes.
      ...(data.editorBrief.trim() ? { editorBrief: data.editorBrief.trim() } : {}),
      ...(data.cullingConfirmed ? { cullingConfirmedAt: new Date() } : {}),
      ...(data.removalNotes?.trim()
        ? { removalNotes: data.removalNotes.trim().slice(0, 4000) }
        : data.nothingToRemove
          ? { removalNotes: "Nothing needs removal — confirmed by the photographer." }
          : {}),
      ...(data.videoInstructions?.trim() ? { videoInstructions: data.videoInstructions.trim().slice(0, 6000) } : {}),
      ...(data.scriptConfirm
        ? {
            scriptConfirmedAt: new Date(),
            scriptConfirmNote: scriptEdited
              ? `Edited on site${data.scriptConfirm.note?.trim() ? ` — ${data.scriptConfirm.note.trim().slice(0, 500)}` : ""}`
              : "Delivered as written",
            // An on-site edit replaces the working script — the editor must cut
            // to what was actually filmed, not what Studio drafted.
            ...(scriptEdited && data.scriptConfirm.script?.trim()
              ? { reelScript: data.scriptConfirm.script.trim().slice(0, 20_000), reelRecipeUpdatedAt: new Date() }
              : {}),
          }
        : {}),
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

  // (Frame.io auto-create removed Aug 25: the integration was retired Aug 14,
  // and every video finalize was still firing a doomed external call with a
  // July token, silently swallowed — audit. Review happens in the Review Room.)

  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
  return { pdfPath };
}
