"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireRole } from "@/lib/auth/guards";
import { editorTeamMemberId, VIDEO_LANE_KEYS, type EditorKey } from "@/lib/editors";
import { deliveryStamp, outstandingForDelivery, outstandingMessage, VIDEO_CATEGORY } from "@/lib/delivery";

// ---------------------------------------------------------------------------
// Server actions for the editor platform's /editing surface.
//   · setEditVideoEditor — owner/admin reassign a video job to a different
//     editor (one-click select on the tracker row). Updates the edit_video
//     task's assignedKey AND Project.editorId when the new editor maps to a
//     TeamMember (Kim/John); externals (Luma, the external agency) clear the
//     link, and "" takes the job off every editor's board.
// The editor's "Done — send to review" action moved to
// src/app/review/actions.ts (submitCutForReview) — see the note at the bottom.
// Fail-closed once auth is enforced (no-op in local dev).
// ---------------------------------------------------------------------------

// Reassign a video job to a different editor, right from the queue row.
// Owner/admin only. Works at ANY stage of the job's life:
//   · open edit/revision task → repoint it (assignedManually pins it) + bell
//     the new editor so the handoff is actually communicated;
//   · upcoming job, no task yet → pin the pick on the Project (editorManual);
//     mintEditTask honours the pin when the task mints at shoot time, and
//     ensureEditorHandoff stops auto-reverting editorId to the rules.
//
// Sep 7 (Jordan): two destinations that are not a person.
//   · "" = UNASSIGN. The task keeps its key null but gains assignedManually,
//     and the project is pinned to no editor (editorManual with editorId
//     null) — that PAIR is what stops every engine, and the queue's own
//     routing prediction, from putting John or Kim straight back on the row.
//     The job lands in "Needs assigning" on /tasks, where a human picks it up.
//   · "external_agency" = the outside shop. Same pin, plus the key on the
//     task so the row still says who has it. Like Luma, it has no login and
//     no bell, so the dispatch ping goes to the ADMIN (Kyle) who actually
//     hands the files over.
export async function setEditVideoEditor(projectId: string, editorKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const unassign = editorKey === "";
  const external = editorKey === EXTERNAL_EDITOR_KEY;
  if (!unassign && !external && !(VIDEO_EDITOR_KEYS as string[]).includes(editorKey)) {
    return { ok: false, message: "Pick a video editor (Kim or John Mark), the external agency, or Unassigned." };
  }
  const key = unassign ? null : (editorKey as EditorKey);
  const { editorMeta } = await import("@/lib/editors");
  const editorName = key ? editorMeta(key)?.name ?? key : "nobody";

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, status: true },
  });
  if (!project) return { ok: false, message: "That project no longer exists." };
  // A DELIVERED job has no live work to hand off — repointing it would only
  // rewrite the finished job's editor credit and lie "Assigned to X." with no
  // task and no ping. New cuts on finished jobs ride the revision rail.
  if (project.status === "DELIVERED") {
    return { ok: false, message: "This job is delivered — use “Add a job to the queue” to order a new cut." };
  }

  // Re-route the open VIDEO work: the edit task, plus revision tasks that are
  // in the video lane. Scoped on purpose — a mixed job's photo-retouch revision
  // is Kyle's and must not be hijacked onto a video editor.
  const moved = await prisma.smartTask.updateMany({
    where: {
      projectId,
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      OR: [{ taskType: "edit_video" }, { taskType: "revision", assignedKey: { in: VIDEO_LANE_KEYS } }],
    },
    // assignedManually either way — including on the unassign, where it is the
    // whole point: a null key WITHOUT the flag is just "not routed yet" and
    // mintEditTask would fill it back in on the next sweep.
    data: { assignedKey: key, assignedManually: true },
  });

  // Persist + pin the pick on the Project so every engine treats it as manual.
  // No TeamMember row AND no task moved = the pick would vanish (mint reads the
  // pin through Project.editor) — say so instead of pretending it stuck.
  const tmId = key ? await editorTeamMemberId(key) : null;
  if (tmId) {
    await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId, editorManual: true, editorVendorKey: null } });
  } else if (unassign || external) {
    // Nobody in-house holds it now. Clearing editorId with editorManual set is
    // the "pinned to nobody" pair ensureEditorHandoff already honours — it is
    // told not to fill editorId back in from the routing rules.
    // editorVendorKey is what an UPCOMING job (no task yet) remembers: the
    // agency has no TeamMember, so editorId cannot carry it.
    await prisma.project.update({
      where: { id: projectId },
      data: { editorId: null, editorManual: true, editorVendorKey: key === EXTERNAL_EDITOR_KEY ? EXTERNAL_EDITOR_KEY : null },
    });
  } else if (moved.count === 0) {
    return { ok: false, message: `Couldn't link ${editorName} — their Team row is missing. Add them on the People page first.` };
  }

  await prisma.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: unassign
        ? "Video edit unassigned from the queue — it is off every editor's board until someone is picked."
        : `Video edit reassigned to ${editorName} from the queue.`,
    },
  }).catch(() => {});

  // Live work changed hands → tell whoever now owns it. An upcoming job's pick
  // is silent on purpose: there's nothing to edit yet, the bell comes with
  // raws. An unassign rings nobody — there is nobody to ring.
  if (moved.count > 0 && key) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      const street = (project.title || "a job").split(",")[0].trim();
      await notifyInApp(
        external
          ? {
              // The agency has no hub login, so this is Kyle's cue to send the
              // files out — the same shape Luma dispatch has always used.
              kind: "edit_assigned",
              title: `Dispatch to the external agency — ${street}`,
              body: "This edit was handed to the outside shop — send them the footage and the brief.",
              href: `/edit/${projectId}`,
              targets: [{ roles: ["ADMIN"] }],
            }
          : {
              kind: "edit_assigned",
              title: `Reassigned to you — ${street}`,
              body: "This edit was moved to your queue.",
              href: `/edit/${projectId}`,
              targets: [{ roles: ["EDITOR"], userKey: `editor:${key}`, href: `/edit/${projectId}` }],
            },
      );
    } catch { /* bell is best-effort */ }
  }

  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  return {
    ok: true,
    message: unassign
      ? "Unassigned — it's off John's and Kim's queues and waiting in “Needs assigning”."
      : external
        ? // An upcoming job has no edit task to carry the agency's name yet,
          // so all we can truthfully record is "not one of ours". Say that
          // rather than claim a hand-off the row won't show.
          moved.count > 0
          ? "Handed to the external agency — it's off our editors' queues."
          : "Taken off our editors — there's no edit task on this job yet, so name the agency again once the raws land."
        : `Assigned to ${editorName}.`,
  };
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
// The outside shop. Not in VIDEO_EDITOR_KEYS: work never AUTO-routes there, a
// human hands it over (Jordan, Sep 7).
const EXTERNAL_EDITOR_KEY: EditorKey = "external_agency";

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
  const { editorRouting } = await import("@/lib/settings");
  const rules = await editorRouting();

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
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
      _count: { select: { reviewSubmissions: { where: { status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } } } } },
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
      suggestedEditor: editorForDeliverable(v?.type ?? "VIDEO", v?.label, monthly, rules),
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
      client: { select: { segment: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { id: true, type: true } },
      _count: { select: { reviewSubmissions: { where: { status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } } } } },
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
      // manual: the order reconcile only knows Aryeo line items and must never
      // retire a row a human added on purpose.
      data: { projectId, type: "VIDEO", label: "Video — added manually", manual: true },
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
        body: cleanNote ? cleanNote.slice(0, 140) : "Added to your queue from the Editing Room.",
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
    const revNote = cleanNote || `New cut requested — added to the Editing Room for ${editorName}.`;
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
      reasonCreated: "Owner added a finished job back to the Editing Room",
      source: "manual",
      // No due date (Jordan, Sep 8: "Revisions dont promise anything") — the
      // card reads its age from createdAt; HIGH, URGENT for a VIP/heavy client.
      priority: (await import("@/lib/tasks")).revisionPriority({ segment: project.client?.segment, ask: cleanNote }),
      dueAt: null,
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
      data: { projectId, type: "STATUS_CHANGE", body: `Moved to Editing — added to the Editing Room.` },
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
  // A manual queue-add is a human pick — pin it (editorManual) so the hourly
  // handoff can't revert it to the routing rules. Pin only with a real link:
  // a null editorId + pin would block the engines from ever filling it back in.
  await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId, editorManual: !!tmId } });
  await prisma.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: `Added to the Editing Room — routed to ${editorName}.${cleanNote ? ` Note: ${cleanNote}` : ""}`,
    },
  });
  await notifyQueued("edit_assigned", `New edit — ${street}`);
  return done(`${street} is in the queue — ${editorName} has it.`);
}


// The queue's two note boxes, made editable. Jordan (Aug 18): "we should also
// be able to adjust anything like customer notes and everything. Editors can
// not, but admins, owners, and photographers / creatives can."
//
// WHERE each one lands:
//   · customer → Project.notes, the per-JOB customer note. The Aryeo order
//     text shown beside it is NOT edited here — it's their system's record and
//     the next sync would overwrite any local change, so this is the note that
//     corrects or adds to it. Project.notes also feeds Kyle's delivery board
//     and the Hub's job context, so a correction travels with the job.
//   · shoot → Project.editorBrief, the same field the photographer writes at
//     upload, so fixing a garbled brief here is the same note, not a rival one.
export async function saveJobNotes(
  projectId: string,
  notes: { customer?: string; shoot?: string },
): Promise<{ ok: boolean; message: string }> {
  try {
    // Editors are deliberately absent: they READ the brief, they don't rewrite
    // what the customer or the photographer said.
    await requireRole(["OWNER", "ADMIN", "PHOTOGRAPHER"]);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const data: { notes?: string | null; editorBrief?: string | null } = {};
  if (notes.customer !== undefined) data.notes = notes.customer.trim().slice(0, 4000) || null;
  if (notes.shoot !== undefined) data.editorBrief = notes.shoot.trim().slice(0, 4000) || null;
  if (Object.keys(data).length === 0) return { ok: true, message: "Nothing to save." };

  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!p) return { ok: false, message: "That job no longer exists." };
  await prisma.project.update({ where: { id: projectId }, data });
  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: "Saved." };
}

// Per-job edit instructions (the Luma-form fields) — owner/admin write, the
// editor reads. Stored as JSON on Project.editSpec.
export async function saveEditSpec(
  projectId: string,
  spec: { musicType?: string; colorProfile?: string; desiredLength?: string; instructions?: string },
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const clean = {
    musicType: (spec.musicType ?? "").trim().slice(0, 120) || undefined,
    colorProfile: (spec.colorProfile ?? "").trim().slice(0, 120) || undefined,
    desiredLength: (spec.desiredLength ?? "").trim().slice(0, 60) || undefined,
    instructions: (spec.instructions ?? "").trim().slice(0, 4000) || undefined,
  };
  const hasAny = Object.values(clean).some(Boolean);
  await prisma.project.update({ where: { id: projectId }, data: { editSpec: hasAny ? JSON.stringify(clean) : null } });
  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: "Instructions saved." };
}


// The Slack tracker's status click. "Waiting" and "Ready for editing" are NOT
// settable — evidence flips them (that is the fix for "Kyle forgets to update
// the tracker"). The middle of the ladder is human: the editor clicks In
// editing when they start and Ready for review when done, exactly like Slack.
// Owner/admin may set any selectable status; an EDITOR only on a job whose
// open edit task is theirs (requireTaskAccess does that matching).
const QUEUE_STATUS: Record<string, "EDITING" | "REVIEW" | "REVISION" | "DELIVERED"> = {
  "In editing": "EDITING",
  "Ready for review": "REVIEW",
  Revisions: "REVISION",
  Completed: "DELIVERED",
};

export async function setQueueStatus(projectId: string, label: string): Promise<{ ok: boolean; message: string }> {
  const status = QUEUE_STATUS[label];
  if (!status) return { ok: false, message: "That status is set automatically from upload/delivery evidence." };
  try {
    const task = await prisma.smartTask.findFirst({
      where: { projectId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    const { requireTaskAccess, requireAdmin: reqAdmin } = await import("@/lib/auth/guards");
    if (task) await requireTaskAccess(task.id);
    else await reqAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  // ONE read for everything below: the delivery gate, the once-only delivery
  // stamp, and the Revisions branch (which used to fire its own second query).
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      deliveredAt: true,
      statusEvidence: true,
      revisionRequestedAt: true,
      editorId: true,
      editorManual: true,
      editor: { select: { name: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } },
    },
  });
  if (!proj) return { ok: false, message: "That job no longer exists." };

  // "Completed" is a claim about the CLIENT, not about the editor's evening.
  // Jordan's rule: delivered means everything ordered has landed, so a job
  // whose reel (or photos, floor plan, 3D tour) the hub can still see is
  // missing cannot be closed from here. However they got there, 24 DELIVERED
  // jobs carry evidence that names a missing category right now — 14 of them
  // the Video (Sep 2 probe). This button stops adding to that pile.
  if (status === "DELIVERED") {
    // Freshness counter-proof for the video lane only: the evidence read is
    // hourly, and the editor pressing this button may have finished minutes
    // ago. An APPROVED Review-Room cut for EVERY video owed is the cut
    // landing — approval copies the file into the job's 05-Final-Video folder
    // and stamps completedAt — so accept it before the sweep catches up.
    // Multi-video months need the whole set: cut 1 of 4 is progress, not done.
    const proven: string[] = [];
    const videosOwed = proj.deliverables
      .filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
      .reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
    if (videosOwed > 0) {
      try {
        const { approvedCutCount } = await import("@/lib/reviewCuts");
        if ((await approvedCutCount(projectId)) >= videosOwed) proven.push(VIDEO_CATEGORY);
      } catch { /* no counter-proof available → the evidence blob decides */ }
    }
    const outstanding = outstandingForDelivery(proj.statusEvidence, proven);
    if (outstanding.length > 0) return { ok: false, message: outstandingMessage(outstanding) };
  }

  // Sep 8 (Jordan: "A revision should be changed to ready for review when an
  // editor marks it complete and submits it for review"). While a client's
  // video-lane revision is open, neither "Completed" nor "Ready for review" is
  // a status the editor can simply type — the corrected cut has to reach the
  // Review Room and Jordan has to rule on it. So both labels run the same
  // rule: a corrected cut already in the Room → the revision reads "waiting
  // on review" (the row reads Ready for review off the PENDING cut itself);
  // nothing uploaded since the ask → try the Final-folder submit (the same
  // path as "Done — send to review") and otherwise refuse with the way
  // forward. Before this, "Completed" wrote DELIVERED, left the client's ask
  // OPEN + URGENT, rang the editor "Delivered ✓", and the next recompute
  // flipped the job straight back to REVISION (332 Ruth Ridge, 1956
  // Wetherhill — rev-open-after-complete); "Ready for review" wrote REVIEW
  // and the hourly sweep flipped it back the same way (Sep 8 review).
  // Project.status is deliberately NOT written here: a never-delivered job is
  // moved to REVIEW by correctedCutSubmitted, and a delivered job has to stay
  // REVISION until the verdict (see the note in reviewCuts). `ok` is true
  // only when the pill's label is what the row will read anyway; a refusal is
  // `ok: false` so the pill snaps back to what the cut says and shows the
  // message.
  if (status === "DELIVERED" || status === "REVIEW") {
    const { videoLaneRevisionWhere, correctedCutSubmitted, correctedCutApproved } = await import("@/lib/reviewCuts");
    const lane = await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId), select: { id: true, createdAt: true } });
    if (lane.length > 0) {
      const street = (proj.title || "this job").split(",")[0].trim();
      const wantsReview = status === "REVIEW";
      const done = (ok: boolean, message: string) => {
        revalidatePath("/editing");
        revalidatePath(`/edit/${projectId}`);
        return { ok, message };
      };
      const raisedAt = proj.revisionRequestedAt ?? new Date(Math.min(...lane.map((t) => t.createdAt.getTime())));
      const newest = await prisma.reviewSubmission.findFirst({
        where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "SUPERSEDED"] }, createdAt: { gte: raisedAt } },
        orderBy: { createdAt: "desc" },
        select: { status: true, round: true, createdAt: true },
      });
      let answeredByApproval = false;
      if (newest?.status === "APPROVED") {
        // Jordan already approved the corrected cut (a row from before this
        // rule): that approval answers the ask — close it; "Completed" then
        // goes on to deliver below, "Ready for review" has nothing left to do.
        answeredByApproval = (await correctedCutApproved(projectId, { cutCreatedAt: newest.createdAt, round: newest.round })).closed > 0;
        if (answeredByApproval && wantsReview) {
          return done(true, `Jordan already approved the corrected cut on ${street} — the client's revision is closed and the job is back where it stands.`);
        }
      }
      if (!answeredByApproval) {
        if (newest?.status === "PENDING") {
          // The click is the editor's word that this pending cut IS the
          // correction (isRedo), whatever slot it sits on.
          await correctedCutSubmitted(projectId, { round: newest.round, isRedo: true });
          return done(wantsReview, `${street} has a client revision open — the corrected cut is in the Review Room waiting on Jordan. It reads Ready for review until he rules, and Completed once he approves it.`);
        }
        if (newest?.status === "CHANGES_REQUESTED") {
          return done(false, `The corrected cut for ${street} came back with notes — fix them and press Upload version ${newest.round + 1} on the edit page; it goes back to the Review Room from there.`);
        }
        const { submitCutForReview } = await import("@/app/review/actions");
        const sent = await submitCutForReview(projectId).catch(() => ({ ok: false as const, message: "" }));
        if (sent.ok) {
          return done(wantsReview, `Sent to the Review Room — ${street} has a client revision open, so it reads Ready for review until Jordan rules and Completed once he approves the corrected cut.`);
        }
        return done(false, `${street} has a client revision open and nothing new has been uploaded since it came in. Press Upload version N on the edit page (it takes a new version even on an approved cut while the revision is open) — or drop a NEW file in 05-Final-Video and hit "Done — send to review" — and it reads Ready for review, then Completed once Jordan approves it.`);
      }
    }
  }

  await prisma.project.update({
    where: { id: projectId },
    // deliveryStamp, not `new Date()`: this click used to overwrite the
    // ORIGINAL delivery date every time (see the rule in src/lib/delivery.ts).
    // 4 of the 6 "Completed" clicks on record landed on a job that was already
    // delivered and moved its date by 1.8 to 18.0 days — 1023 Sycamore Mills
    // Rd was delivered Aug 10 and now reads Aug 28.
    data: { status, ...(status === "DELIVERED" ? deliveryStamp(proj.deliveredAt) : {}) },
  });
  // This Activity row is load-bearing, not decoration: createDeliveryTextTask
  // reads "Queue status set: Completed" as the editor's override that releases
  // a monthly-content job's held-back delivery text. It must exist BEFORE the
  // closer below runs.
  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: `Queue status set: ${label}` },
  }).catch(() => {});

  // "Completed" is the editor's explicit "the batch is done" — the human
  // override, and it stays. But it has to CLOSE THE JOB the way the automatic
  // delivery path does, which is closeObsoleteTasks: snapshot the QC card into
  // a QcRecord (so a bypassed QC pass stays measurable), ring the editors their
  // "Delivered ✓" receipt, complete the QC / delivery / edit_video / vendor
  // cards, resolve the open image flags, and mint Kyle's delivery text
  // (createDeliveryTextTask, dedupeKey-guarded, so a re-click is a no-op).
  // Before this the click wrote DELIVERED and nothing else — and BOTH hourly
  // engines skip delivered jobs (the status sweep and the task reconciler each
  // scan BOOKED..REVISION only), so the QC and edit cards survived until some
  // unrelated human action killed them: 7 Moreland Ave was clicked Aug 18 and
  // kept 4 open cards for 6.0 days; 1023 Sycamore Mills Rd kept its QC card 3.1.
  if (status === "DELIVERED") {
    try {
      const { closeObsoleteTasks } = await import("@/lib/tasks");
      await closeObsoleteTasks(projectId, "DELIVERED");
    } catch { /* best-effort — the status write above already landed */ }
  }

  // Flipping to Revisions IS a revision request — in Slack the flip only
  // recolored a cell; here it adds a ROUND to the job's edit_video card
  // (Jordan, Sep 8: "When a cut changes after a card is made, make it 1 card"
  // — the separate "Revisions — <street>" task this used to mint sat beside
  // the edit card as a second card for the same cut). The queue row reads
  // Revisions off that round: editorQueue counts an open edit card carrying
  // a "Round N — …" summary as the video lane's redo, the same way it counts
  // a bounced cut (Sep 8 review — the stamp alone never reached the row).
  // The editor's card says what round they are on and they get a bell. The
  // card keeps whoever holds it; a card that never
  // existed is minted through the pin/routing rules, where a deliberate
  // unassign (Sep 7) still lands it in "Needs assigning". Moving OFF
  // Revisions closes any straggler from the old queue-revision-* rail.
  const QUEUE_REV_KEY = `queue-revision-${projectId}`;
  if (status === "REVISION") {
    try {
      const street = (proj.title || "this job").split(",")[0].trim();
      const latest = await prisma.reviewSubmission.findFirst({
        where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "SUPERSEDED"] } },
        orderBy: { round: "desc" },
        select: { round: true },
      });
      const { addRoundToEditCard } = await import("@/lib/tasks");
      const card = await addRoundToEditCard(projectId, {
        round: (latest?.round ?? 1) + 1,
        notes: ["Flipped to Revisions on the Editing Room queue — check the review notes and the project chat for what to change, re-cut, and send it back to review."],
        reason: "flipped to Revisions on the queue",
      });
      const assignedKey = card?.assignedKey ?? null;
      // revisionRequestedAt keeps the status engine from demoting the manual
      // REVISION on its next sweep (computeStatus honours an open revision).
      if (!proj.revisionRequestedAt) {
        await prisma.project.update({ where: { id: projectId }, data: { revisionRequestedAt: new Date() } });
      }
      if (assignedKey === "kim" || assignedKey === "john") {
        try {
          const { notifyInApp } = await import("@/lib/notify");
          await notifyInApp({
            kind: "revision_raised",
            title: `Revisions — ${street}`,
            body: "The cut was flipped to Revisions on the queue — see the review notes.",
            href: `/edit/${projectId}`,
            targets: [{ roles: ["EDITOR"], userKey: `editor:${assignedKey}`, href: `/edit/${projectId}` }],
          });
        } catch { /* bell is best-effort */ }
      }
    } catch { /* the status write above already landed — the task is best-effort */ }
  } else {
    // Any other manual status closes a straggler from the retired
    // queue-revision-* rail (folded into the edit card on Sep 8; the
    // comms-raised revision task has its own dedupe key and lifecycle).
    await prisma.smartTask.updateMany({
      where: { dedupeKey: QUEUE_REV_KEY, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    }).catch(() => {});
    // If NO revision task remains open in any lane, clear the revision stamp —
    // otherwise the hourly status sweep reads revisionRequestedAt and flips
    // the job straight back to REVISION, silently reverting this click
    // (Aug 18 audit). This clear is now the ONLY thing holding a re-delivered
    // job at Delivered: the old code hid a surviving revision behind a fresh
    // deliveredAt (computeStatus treats a revision stamp older than the
    // delivery as already resolved), and keeping the original delivery date
    // takes that cover away. That is the point — a job with a client revision
    // still open in another lane is not delivered, and it should say so.
    try {
      const stillOpen = await prisma.smartTask.count({
        where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      });
      if (stillOpen === 0) {
        await prisma.project.update({ where: { id: projectId }, data: { revisionRequestedAt: null } });
      }
    } catch { /* stamp clear is best-effort */ }
  }
  const { revalidatePath } = await import("next/cache");
  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: "Status updated." };
}

// ---------------------------------------------------------------------------
// EDIT THE SCRIPT AFTER THE SHOOT (Jordan, Sep 7: "I should be able to edit the
// script in the editor brief after it's been submitted by the photographer on
// the upload portal"). The photographer's on-site confirm writes reelScript
// once; until now nothing could touch it afterwards except a fresh Studio sync.
// Owner/admin only — the editor cuts to this text, so changing it is a
// production decision, not an editing one. The on-site provenance note is kept
// UNDER the new one so nobody loses "typed by the photographer".
// ---------------------------------------------------------------------------
export async function saveReelScript(projectId: string, script: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const text = script.trim().slice(0, 20_000);
  if (!text) return { ok: false, message: "The script can't be empty — delete a line, not the whole thing." };
  const prior = await prisma.project.findUnique({ where: { id: projectId }, select: { reelScript: true, scriptConfirmNote: true, title: true } });
  if (!prior) return { ok: false, message: "That job is gone." };
  if ((prior.reelScript ?? "").trim() === text) return { ok: true, message: "No changes." };
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const who = me?.name ?? me?.email ?? "the office";
  const stamp = `Edited in the hub by ${who}`;
  const keptNote = (prior.scriptConfirmNote ?? "").replace(/^Edited in the hub by [^\n]*\n?/, "").trim();
  await prisma.project.update({
    where: { id: projectId },
    data: {
      reelScript: text,
      reelRecipeUpdatedAt: new Date(),
      scriptConfirmNote: keptNote ? `${stamp}\n${keptNote}`.slice(0, 2000) : stamp,
    },
  });
  await prisma.activity.create({
    data: { projectId, type: "NOTE", body: `Script edited in the editor brief by ${who} (${text.length} characters).` },
  }).catch(() => {});
  for (const p of [`/edit/${projectId}`, `/projects/${projectId}`, `/upload/${projectId}`, `/shoot/${projectId}`]) revalidatePath(p);
  return { ok: true, message: "Script saved — the editor sees this version." };
}
