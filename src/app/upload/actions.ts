"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { ProjectStatus, DeliverableStatus, ActivityType } from "@prisma/client";
import { saveUpload, writeFile, deleteFile } from "@/lib/storage";
import { buildEditorBriefPdf } from "@/lib/editor-pdf";
import { getProject } from "@/lib/queries";

/** Save one or more files, optionally tied to a deliverable, and mark it uploaded. */
export async function uploadFiles(
  projectId: string,
  deliverableId: string | null,
  formData: FormData,
) {
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
  const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
  if (!file) return;
  await deleteFile(file.storedPath);
  await prisma.uploadedFile.delete({ where: { id: fileId } });
  revalidatePath(`/upload/${file.projectId}`);
  revalidatePath(`/projects/${file.projectId}`);
}

export async function flagIssue(projectId: string, body: string) {
  const trimmed = body.trim();
  if (!trimmed) return;
  await prisma.activity.create({
    data: { projectId, type: ActivityType.FLAG, body: trimmed },
  });
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
}

/**
 * Finalize the guided upload: save the editor brief + per-item notes, advance the
 * project to "Shot / Uploaded", generate the editor PDF into the project folder,
 * and log it on the timeline.
 */
export async function finalizeUpload(
  projectId: string,
  data: { editorBrief: string; itemNotes: Record<string, string> },
) {
  // Persist per-deliverable notes.
  for (const [deliverableId, note] of Object.entries(data.itemNotes)) {
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
      editorBrief: data.editorBrief.trim() || null,
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

  // Generate the editor brief PDF from the fully-loaded project.
  const full = await getProject(projectId);
  let pdfPath: string | null = null;
  if (full) {
    const bytes = await buildEditorBriefPdf(full);
    pdfPath = await writeFile(projectId, "editor-brief.pdf", bytes);
    await prisma.project.update({
      where: { id: projectId },
      data: { editorPdfPath: pdfPath },
    });
  }

  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.FILE,
      body: "Photographer completed upload. Editor brief PDF generated and added to the project folder.",
    },
  });

  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
  return { pdfPath };
}
