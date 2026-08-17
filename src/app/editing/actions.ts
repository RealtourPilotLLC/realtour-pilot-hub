"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { editorTeamMemberId, EDITOR_KEYS, type EditorKey } from "@/lib/editors";

// ---------------------------------------------------------------------------
// Server actions for the editor platform's /editing surface.
//   · setEditVideoEditor — owner/admin reassign a video job to a different
//     editor (one-click select on the tracker row). Updates the edit_video
//     task's assignedKey AND Project.editorId when the new editor maps to a
//     TeamMember (Kim/John); externals (Luma) clear the link.
// The editor's "Done — send to review" action moved to
// src/app/review/actions.ts (submitCutForReview) — see the note at the bottom.
// Fail-closed once auth is enforced (no-op in local dev).
// ---------------------------------------------------------------------------

// Reassign a video job to a different editor. Owner/admin only.
export async function setEditVideoEditor(projectId: string, editorKey: string): Promise<void> {
  await requireAdmin();
  if (!(EDITOR_KEYS as string[]).includes(editorKey)) throw new Error("Unknown editor.");
  const key = editorKey as EditorKey;

  // Re-route the open edit_video task to the new editor (there's one per project,
  // deduped edit-video-<projectId>). If none is open (e.g. already delivered),
  // this is a no-op — we still repoint the Project link below. assignedManually
  // makes the choice stick: the hourly handoff/mint refresh won't route it back.
  await prisma.smartTask.updateMany({
    where: { projectId, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { assignedKey: key, assignedManually: true },
  });

  // Persist Project.editorId when the new editor is a linkable person; clear it
  // for externals/vendors (Luma) so the tracker doesn't show a stale name.
  const tmId = await editorTeamMemberId(key);
  await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId } });

  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: `Video edit reassigned to ${key}.` },
  });

  revalidatePath("/editing");
}

// The editor's "Done — send to review" now lives in src/app/review/actions.ts
// (submitCutForReview): it does everything the old action here did PLUS parks
// the actual cut (a streamable Dropbox link) in the owner's Review Room at
// /review, so the reviewer watches it in-house instead of hunting folders.

// ---------------------------------------------------------------------------
// MANUAL "add a job to the editor queue" (owner/admin). The queue is normally
// fed automatically (Aryeo order → raws land → ensureEditorHandoff), but some
// jobs never trip it: video added after booking, old footage without a fresh
// shoot, non-Aryeo work. This is the human override: pick a project, pick the
// editor, and the SAME machinery runs (video deliverable → EDITING status →
// edit_video task → editor bell). The status sweep never demotes a manual
// EDITING (guard in projectStatus.ts), so the add sticks.
// ---------------------------------------------------------------------------

const QUEUE_STATUSES = ["SHOT", "EDITING", "REVIEW", "REVISION"];
const VIDEO_EDITOR_KEYS: EditorKey[] = ["kim", "john"];

export type QueueCandidate = {
  id: string;
  street: string;
  clientName: string;
  status: string;
  shootDate: string | null;
  deliverables: string[];
  hasVideo: boolean;
  inQueue: boolean; // already visible on the owner tracker (queue status + video)
  priorCut: boolean; // a cut already exists → the add rides the revision rail
  suggestedEditor: EditorKey | null; // where the routing rules would send it (null = manual, e.g. personal branding)
};

// Find projects to add — by street or client name. Owner/admin only.
export async function searchQueueCandidates(q: string): Promise<QueueCandidate[]> {
  await requireAdmin();
  const query = (q ?? "").trim();
  if (query.length < 2) return [];

  const { editorForDeliverable } = await import("@/lib/editors");
  const { isMonthlyContentJob } = await import("@/lib/pipeline");

  const projects = await prisma.project.findMany({
    where: {
      status: { not: "CANCELLED" },
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { client: { name: { contains: query, mode: "insensitive" } } },
      ],
    },
    orderBy: [{ shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 8,
    select: {
      id: true,
      title: true,
      status: true,
      shootDate: true,
      statusEvidence: true,
      client: { select: { name: true } },
      deliverables: { select: { type: true, label: true } },
      _count: { select: { reviewSubmissions: true } },
    },
  });

  return projects.map((p) => {
    const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    const monthly = isMonthlyContentJob(p.deliverables);
    let videoEvidence = false;
    try {
      const ev = p.statusEvidence
        ? (JSON.parse(p.statusEvidence) as { present?: string[]; dropbox?: { finalVideo?: number } | null })
        : {};
      videoEvidence = (ev.present ?? []).includes("Video") || (ev.dropbox?.finalVideo ?? 0) > 0;
    } catch { /* none */ }
    return {
      id: p.id,
      street: (p.title || "Untitled job").split(",")[0].trim(),
      clientName: p.client?.name ?? "",
      status: p.status,
      shootDate: p.shootDate ? p.shootDate.toISOString() : null,
      deliverables: p.deliverables.map((d) => d.label || d.type).slice(0, 5),
      hasVideo: !!v,
      inQueue: !!v && QUEUE_STATUSES.includes(p.status),
      priorCut: p.status === "DELIVERED" || p._count.reviewSubmissions > 0 || videoEvidence,
      suggestedEditor: editorForDeliverable(v?.type ?? "VIDEO", v?.label, monthly),
    };
  });
}

// Put a project in the editor queue for the CHOSEN editor. Two paths, so the
// hourly engines never fight the add (the adversarial review proved they would):
//   · FRESH job (no prior cut anywhere) → EDITING + an edit_video task. The
//     assignedManually flag keeps the editor choice and blocks the evidence
//     auto-close; the widened sweep guard keeps the EDITING stage.
//   · PRIOR-CUT job (delivered / a past Review-Room round / a final video on
//     file) → the REVISION machinery instead: revisionRequestedAt pins the
//     stage (computeStatus honours revisionOpen), and revision tasks are never
//     swept by the DELIVERED close. Mirrors comms.raiseRevision minus the
//     QC-miss stamp — a new-cut request is NOT a QC bounce on Kyle's dial.
export async function addToEditorQueue(
  projectId: string,
  editorKey: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!(VIDEO_EDITOR_KEYS as string[]).includes(editorKey)) {
    return { ok: false, message: "Pick a video editor (Kim or John Mark)." };
  }
  const key = editorKey as EditorKey;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      clientId: true,
      statusEvidence: true,
      revisionRequestedAt: true,
      deliverables: { select: { id: true, type: true } },
      _count: { select: { reviewSubmissions: true } },
    },
  });
  if (!project) return { ok: false, message: "That project no longer exists." };
  if (project.status === "CANCELLED") return { ok: false, message: "That job is cancelled — un-cancel it first." };
  const street = (project.title || "this job").split(",")[0].trim();
  const cleanNote = (note ?? "").trim().slice(0, 1000);
  const editorName = (await import("@/lib/editors")).editorMeta(key)?.name ?? key;

  // 1. The queue is video-only — a job whose order had no video gets a manual
  // video deliverable so every engine (tasks, SLA, tracker) sees it.
  const hasVideo = project.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (!hasVideo) {
    await prisma.deliverable.create({
      data: { projectId, type: "VIDEO", label: "Video — added manually" },
    });
  }

  // Has a cut for this job ever existed? Same three evidences the task
  // reconciler's auto-close reads — if ANY is true, an edit_video task would be
  // completed by the next hourly sweep, so the job must ride the revision rail.
  let videoEvidence = false;
  try {
    const ev = project.statusEvidence
      ? (JSON.parse(project.statusEvidence) as { present?: string[]; dropbox?: { finalVideo?: number } | null })
      : {};
    videoEvidence = (ev.present ?? []).includes("Video") || (ev.dropbox?.finalVideo ?? 0) > 0;
  } catch { /* unreadable evidence → treat as none */ }
  const priorCut = project.status === "DELIVERED" || project._count.reviewSubmissions > 0 || videoEvidence;

  // Who gets pinged: Kim/John directly (their channel bridge); Luma is an
  // external vendor with no login/phone — Kyle dispatches Luma work, so the
  // bell goes to ADMIN instead of a row nobody can see.
  const notifyQueued = async (kind: string, title: string) => {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      const isExternal = key === "luma";
      await notifyInApp({
        kind,
        title: isExternal ? `Dispatch to Luma — ${street}` : title,
        body: cleanNote ? cleanNote.slice(0, 140) : "Added to your queue from the Editor Queue page.",
        href: `/edit/${projectId}`,
        targets: isExternal
          ? [{ roles: ["ADMIN"] }]
          : [{ roles: ["EDITOR"], userKey: `editor:${key}`, href: `/edit/${projectId}` }],
        // No dedupeKey on purpose: every manual add is news, including a re-add.
      });
    } catch { /* bell is best-effort */ }
  };

  const done = (message: string) => {
    revalidatePath("/editing");
    revalidatePath("/pipeline");
    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/edit/${projectId}`);
    return { ok: true, message };
  };

  // ---- PRIOR-CUT path: a new cut on a finished job = a revision. ----
  if (priorCut) {
    const revNote = cleanNote || `New cut requested — added to the editor queue for ${editorName}.`;
    await prisma.project.update({
      where: { id: projectId },
      data: {
        revisionRequestedAt: project.revisionRequestedAt ?? new Date(),
        revisionNote: revNote.slice(0, 300),
        ...(project.status === "DELIVERED" ? { status: "REVISION" } : {}),
      },
    });
    // Reopen the QC card WITH revision framing (HIGH, due now, re-QC row) —
    // the comms revision path does this via raiseRevision; without it the
    // reconciler hands Kyle back a weeks-overdue delivery-era "QC & deliver"
    // card with no re-QC gate.
    try {
      const { reflectRevisionInQc } = await import("@/lib/tasks");
      await reflectRevisionInQc(projectId, [], revNote);
    } catch { /* framing is best-effort — the revision task below is the work item */ }

    // One open revision per project — same dedupeKey scheme as comms.ts.
    const crypto = await import("crypto");
    const revKey = crypto.createHash("sha1").update(`${projectId}|revision`).digest("hex").slice(0, 24);
    const taskData = {
      taskType: "revision",
      title: `New cut — ${street}`.slice(0, 120),
      summary: `The owner queued a new edit on this finished job for ${editorName}: “${revNote.slice(0, 220)}”. Cut it, drop it in 05-Final-Video, and send it to review.`,
      description: revNote,
      reasonCreated: "Owner added a finished job back to the editor queue",
      source: "manual",
      priority: "HIGH" as const,
      dueAt: new Date(Date.now() + 24 * 3600_000),
      assignedKey: key,
      assignedManually: true,
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      dedupeKey: revKey,
    };
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: revKey } });
    if (existing) {
      await prisma.smartTask.update({
        where: { id: existing.id },
        data: { ...taskData, status: "OPEN", completedAt: null },
      });
    } else {
      await prisma.smartTask.create({ data: taskData });
    }

    const tmId = await editorTeamMemberId(key);
    await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId } });
    await prisma.activity.create({
      data: {
        projectId,
        type: "SYSTEM",
        body: `Queued a new cut (as a revision) — routed to ${editorName}.${cleanNote ? ` Note: ${cleanNote}` : ""}`,
      },
    });
    await notifyQueued("revision_raised", `New cut — ${street}`);
    return done(`${street} is queued as a new cut — ${editorName} has it.`);
  }

  // ---- FRESH path: EDITING stage + the standard edit_video work item. ----
  if (!QUEUE_STATUSES.includes(project.status)) {
    await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
    await prisma.activity.create({
      data: { projectId, type: "STATUS_CHANGE", body: `Moved to Editing — added to the editor queue.` },
    });
  }

  // Mint via the standard machinery, claim it for the chosen editor, then mint
  // again: the second pass refreshes summary/due/priority for a task that was
  // COMPLETED before the reopen (mint #1 early-returns on those), and it
  // respects assignedManually so the chosen editor survives the refresh.
  const { mintEditTask } = await import("@/lib/tasks");
  await mintEditTask(projectId);
  await prisma.smartTask.updateMany({
    where: { dedupeKey: `edit-video-${projectId}` },
    data: {
      assignedKey: key,
      assignedManually: true,
      status: "OPEN",
      completedAt: null,
      ...(cleanNote ? { description: cleanNote } : {}),
    },
  });
  await mintEditTask(projectId);

  const tmId = await editorTeamMemberId(key);
  await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId } });
  await prisma.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: `Added to the editor queue — routed to ${editorName}.${cleanNote ? ` Note: ${cleanNote}` : ""}`,
    },
  });
  await notifyQueued("edit_assigned", `New edit — ${street}`);
  return done(`${street} is in the queue — ${editorName} has it.`);
}
