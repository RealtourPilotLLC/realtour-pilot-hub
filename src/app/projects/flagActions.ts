"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { IMAGE_FLAG_TAGS } from "@/lib/imageFlags";

export type FlaggedImage = {
  id: string;
  imageUrl: string;
  thumbUrl: string | null;
  caption: string | null;
  note: string | null;
  tags: string[];
  createdAt: string;
};

export type FlagResult = { ok: boolean; message: string; created?: FlaggedImage[] };

const TASK_KEY = (projectId: string) => `image_fixes-${projectId}`;

// Rebuild (or close) the single "fix flagged photos" task for a project from its
// currently-OPEN flags. Many flagged images → ONE 24-hour task for Kyle.
async function syncFixTask(projectId: string) {
  const open = await prisma.imageFlag.findMany({
    where: { projectId, status: "OPEN" },
    orderBy: { createdAt: "asc" },
    select: { note: true, tags: true },
  });
  const key = TASK_KEY(projectId);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });

  if (open.length === 0) {
    // Nothing left to fix → complete the task if it exists.
    if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    }
    return;
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, clientId: true } });
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });

  // Aggregate the tags + notes across all flagged images.
  const tagCounts = new Map<string, number>();
  const notes: string[] = [];
  for (const f of open) {
    try { (JSON.parse(f.tags) as string[]).forEach((t) => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)); } catch { /* ignore */ }
    if (f.note?.trim()) notes.push(`• ${f.note.trim()}`);
  }
  const tagSummary = [...tagCounts.entries()].map(([t, n]) => (n > 1 ? `${t} (${n})` : t)).join(", ");
  const street = (project?.title ?? "project").split(",")[0];
  const description = [`${open.length} photo${open.length === 1 ? "" : "s"} flagged: ${tagSummary || "see notes"}.`, ...notes].join("\n").slice(0, 1500);

  const data = {
    taskType: "image_fixes",
    title: `Fix ${open.length} flagged photo${open.length === 1 ? "" : "s"} — ${street}`.slice(0, 120),
    summary: `${open.length} photo${open.length === 1 ? "" : "s"} on ${street} flagged for fixes${tagSummary ? ` (${tagSummary})` : ""}. Make the edits, re-upload to Aryeo, and mark each flag fixed — the task closes once none remain.`.slice(0, 500),
    description,
    reasonCreated: "Photos flagged for editing fixes",
    checklist: JSON.stringify([
      "Review each flagged photo + its note/tags",
      "Make the fixes (item removal, perspective, color, etc.)",
      "Re-upload corrected photos to Aryeo",
      "Mark each flag fixed here",
    ]),
    source: "system",
    priority: "HIGH" as const,
    dueAt: new Date(Date.now() + 24 * 3600_000), // fix within 24h
    projectId,
    clientId: project?.clientId ?? null,
    propertyAddress: project?.title ?? null,
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };
  if (existing) await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  else await prisma.smartTask.create({ data });
}

// Flag one or more images on a project with a shared note + tags. Builds the
// labeled dataset and rolls up into the single 24-hour fix task.
export async function flagImages(
  projectId: string,
  images: { url: string; thumb?: string | null; caption?: string | null }[],
  note: string,
  tags: string[],
): Promise<FlagResult> {
  const imgs = images.filter((i) => i.url);
  if (imgs.length === 0) return { ok: false, message: "Select at least one photo." };
  const cleanTags = tags.filter((t) => (IMAGE_FLAG_TAGS as readonly string[]).includes(t));
  if (cleanTags.length === 0 && !note.trim()) return { ok: false, message: "Add a tag or a note." };

  const rows = await Promise.all(
    imgs.map((i) =>
      prisma.imageFlag.create({
        data: {
          projectId,
          imageUrl: i.url,
          thumbUrl: i.thumb ?? null,
          caption: i.caption ?? null,
          note: note.trim() || null,
          tags: JSON.stringify(cleanTags),
        },
      }),
    ),
  );
  await syncFixTask(projectId);
  revalidatePath(`/projects/${projectId}`);
  const created: FlaggedImage[] = rows.map((f) => ({
    id: f.id,
    imageUrl: f.imageUrl,
    thumbUrl: f.thumbUrl,
    caption: f.caption,
    note: f.note,
    tags: cleanTags,
    createdAt: f.createdAt.toISOString(),
  }));
  return { ok: true, message: `Flagged ${imgs.length} photo${imgs.length === 1 ? "" : "s"} for Kyle.`, created };
}

// Mark a single flag fixed (and close the task if none remain).
export async function resolveImageFlag(flagId: string): Promise<FlagResult> {
  const flag = await prisma.imageFlag.update({
    where: { id: flagId },
    data: { status: "FIXED", resolvedAt: new Date() },
    select: { projectId: true },
  });
  await syncFixTask(flag.projectId);
  revalidatePath(`/projects/${flag.projectId}`);
  return { ok: true, message: "Marked fixed." };
}

// Mark every open flag on a project fixed.
export async function resolveAllImageFlags(projectId: string): Promise<FlagResult> {
  await prisma.imageFlag.updateMany({
    where: { projectId, status: "OPEN" },
    data: { status: "FIXED", resolvedAt: new Date() },
  });
  await syncFixTask(projectId);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "All fixes marked done." };
}
