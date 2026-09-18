"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireRole, requireShootAccess } from "@/lib/auth/guards";
import { editorTeamMemberId, VIDEO_LANE_KEYS, type EditorKey } from "@/lib/editors";
import { deliveryStamp, outstandingForDelivery, outstandingMessage, VIDEO_CATEGORY } from "@/lib/delivery";
import { EDIT_PRIORITIES, EDIT_STATUS_LABELS, EDIT_TIERS, type EditOverrideInput, type EditTier } from "@/lib/editOverrideDefaults";
import {
  OVERRIDE_SELECT,
  anyOverrideSet,
  describeOverrides,
  effectiveDue,
  effectivePriority,
  effectiveTier,
  effectiveTypeDetail,
  effectiveVideosOwed,
  type OverrideSnapshot,
} from "@/lib/editOverrides";

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
// editor, and the SAME machinery runs (video deliverable → SHOT status, which
// the ladder reads as "Ready for editing" → edit_video task → editor bell).
// Sep 10 (Jordan: "the video projects should not automatically be in editing,
// it should say ready for editing and the editor should be able to change the
// status to in editing"): the add used to land the job straight on In editing;
// now nothing does — only the editor's own click on the queue pill
// (setQueueStatus "In editing") writes EDITING. The sweep's anti-demotion
// guard (shootHappened, projectStatus.ts) keeps a past-shoot SHOT job from
// sliding back to Scheduled/Booked.
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
      // A WITHDRAWN round is not a prior cut (Sep 16): the editor took it back,
      // so a manual add-to-queue after one starts on the fresh EDITING rail.
      _count: { select: { reviewSubmissions: { where: { status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } } } } },
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
//   · FRESH job (no prior cut anywhere) → SHOT ("Ready for editing") + an
//     edit_video task. The assignedManually flag keeps the editor choice and
//     blocks the evidence auto-close. The editor moves it to In editing
//     themselves (Sep 10).
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
      // A WITHDRAWN round is not a prior cut (Sep 16): the editor took it back,
      // so a manual add-to-queue after one starts on the fresh EDITING rail.
      _count: { select: { reviewSubmissions: { where: { status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } } } } },
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

  // ---- FRESH path: SHOT ("Ready for editing") + the standard edit_video work item. ----
  // Sep 10 (Jordan): a job never lands on In editing by itself — the editor
  // says so on the queue pill when they actually start.
  if (!QUEUE_STATUSES.includes(project.status)) {
    // A queue-add is a human status write, and a human write ends the
    // office's status pin (Sep 13, editOverrides.ts) — the pin only ever
    // holds off the engines.
    await prisma.project.update({ where: { id: projectId }, data: { status: "SHOT", statusPinnedAt: null } });
    await prisma.activity.create({
      data: { projectId, type: "STATUS_CHANGE", body: `Added to the Editing Room — ready for editing.` },
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
    //
    // …and a photographer may only rewrite THEIR OWN job (RTP-02, Sep 16).
    // The role gate alone let any photographer login post this action with any
    // projectId and overwrite the customer note and the editor brief on all
    // 1,427 jobs that are not theirs. The UI never offers it — /edit/<id>
    // redirects them to /shoot/<id> — but a "use server" action is reachable
    // by POST whatever the UI renders, which is what guards.ts exists for.
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const data: { notes?: string | null; editorBrief?: string | null } = {};
  if (notes.customer !== undefined) data.notes = notes.customer.trim().slice(0, 4000) || null;
  if (notes.shoot !== undefined) data.editorBrief = notes.shoot.trim().slice(0, 4000) || null;
  if (Object.keys(data).length === 0) return { ok: true, message: "Nothing to save." };

  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, notes: true, editorBrief: true } });
  if (!p) return { ok: false, message: "That job no longer exists." };
  await prisma.project.update({ where: { id: projectId }, data });

  // Leave a trace on the job's timeline (Kyle call, Sep 16): these edits left
  // no audit row at all, so nobody could tell who changed the editor's
  // Additional notes or when. One SYSTEM line per field that actually
  // changed, under the editor's own name when the login has a roster row.
  // Courtesy only — the save above must never fail over it.
  try {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    const who = me?.name?.trim() || me?.email || "the office";
    const lines: string[] = [];
    if (data.notes !== undefined && (data.notes ?? null) !== (p.notes ?? null)) lines.push(`Additional notes updated by ${who}.`);
    if (data.editorBrief !== undefined && (data.editorBrief ?? null) !== (p.editorBrief ?? null)) lines.push(`Shoot brief for the editor updated by ${who}.`);
    for (const body of lines) {
      await prisma.activity.create({ data: { projectId, type: "SYSTEM", body, authorId: me?.teamMemberId ?? null } });
    }
  } catch { /* the timeline line is a courtesy */ }

  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/projects/${projectId}`); // the Additional notes card renders there too (Sep 16)
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// THE SHOOTER ANSWERING THE EDITOR (Jordan, Sep 18: "They should also see the
// editing room and be able to make changes to their notes or instructions, but
// not full control like I do or Kyle does").
//
// The two fields THEY wrote, and nothing else on the job:
//   · Project.editorBrief      — "anything else for the editor" (upload page);
//   · Project.videoInstructions — the flow + vision, required on a video job.
// Deliberately NOT saveJobNotes above, which also writes Project.notes — the
// customer note is the office's record of what the client said, not the
// photographer's to rewrite, and a shared action is how a field quietly ends up
// writable by somebody it was never meant for.
//
// requireShootAccess is the whole authorization: owner/admin always, and a
// PHOTOGRAPHER only on a job they shot. RTP-02 (Sep 16) is the reason it is
// asked here rather than trusted from the page — a "use server" action is
// reachable by POST whatever the UI renders, and the role gate alone once let
// one photographer login overwrite the brief on all 1,427 jobs that were not
// theirs.
// ---------------------------------------------------------------------------
export async function saveShootBriefFields(
  projectId: string,
  fields: { shootBrief?: string; videoInstructions?: string },
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const data: { editorBrief?: string | null; videoInstructions?: string | null } = {};
  if (fields.shootBrief !== undefined) data.editorBrief = fields.shootBrief.trim().slice(0, 4000) || null;
  // 6000 is the upload portal's own cap on this column (upload/actions.ts) —
  // the same field must not have two different ceilings depending on which
  // screen it was typed into.
  if (fields.videoInstructions !== undefined) data.videoInstructions = fields.videoInstructions.trim().slice(0, 6000) || null;
  if (Object.keys(data).length === 0) return { ok: true, message: "Nothing to save." };

  const prior = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, editorBrief: true, videoInstructions: true },
  });
  if (!prior) return { ok: false, message: "That job no longer exists." };
  await prisma.project.update({ where: { id: projectId }, data });

  // A trace on the job, for the same reason saveJobNotes grew one on Sep 16:
  // an edit to the brief the editor is working from left no record of who
  // changed it or when. Courtesy only — never fails the save.
  try {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    const who = me?.name?.trim() || me?.email || "the photographer";
    const lines: string[] = [];
    if (data.editorBrief !== undefined && (data.editorBrief ?? null) !== (prior.editorBrief ?? null)) {
      lines.push(`Shoot brief for the editor updated by ${who}.`);
    }
    if (data.videoInstructions !== undefined && (data.videoInstructions ?? null) !== (prior.videoInstructions ?? null)) {
      lines.push(`Video instructions from the shoot updated by ${who}.`);
    }
    for (const body of lines) {
      await prisma.activity.create({ data: { projectId, type: "SYSTEM", body, authorId: me?.teamMemberId ?? null } });
    }
  } catch { /* the timeline line is a courtesy */ }

  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  revalidatePath(`/shoot/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: "Saved — the editor sees it on the job." };
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
  // The job's Epidemic Sound pick lives in the same JSON under `music`
  // (Sep 15, src/lib/musicPick.ts) and is written by the Music card, not this
  // form — carry it through so saving the spec never silently drops the track.
  const { readMusicPick } = await import("@/lib/musicPick");
  const existing = await prisma.project.findUnique({ where: { id: projectId }, select: { editSpec: true } });
  const music = readMusicPick(existing?.editSpec);
  const hasAny = Object.values(clean).some(Boolean) || !!music;
  await prisma.project.update({
    where: { id: projectId },
    data: { editSpec: hasAny ? JSON.stringify({ ...clean, ...(music ? { music } : {}) }) : null },
  });
  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: "Instructions saved." };
}


// The Slack tracker's status click. Evidence sets the bottom of the ladder
// (that is the fix for "Kyle forgets to update the tracker"): the raw folder
// flips Waiting → Ready for editing. The middle is human: the editor clicks In
// editing when they start and Ready for review when done, exactly like Slack.
// Owner/admin may set any selectable status; an EDITOR only on a job whose
// open edit task is theirs (requireTaskAccess does that matching).
// Sep 10 (Jordan: "I should be able to put them back to ready for editing"):
// "Ready for editing" IS settable — by the office only (OWNER/ADMIN). It
// writes SHOT, which is what the ladder has always read as Ready for editing.
// Sep 11 (Jordan: "I should also be able to change projects back to waiting
// but its blocked off"): "Waiting" is settable too — office only, from Ready
// for editing / In editing with nothing handed in. It writes SCHEDULED when
// the job has a shoot date, else BOOKED (the two statuses the ladder reads as
// Waiting) plus a HOLD marker (src/lib/queueWaiting.ts) that both sweeps
// honour — or the same raws would flip it straight back within the hour.
const QUEUE_STATUS: Record<string, "WAITING" | "SHOT" | "EDITING" | "REVIEW" | "REVISION" | "DELIVERED"> = {
  Waiting: "WAITING",
  "Ready for editing": "SHOT",
  "In editing": "EDITING",
  "Ready for review": "REVIEW",
  Revisions: "REVISION",
  Completed: "DELIVERED",
};

export async function setQueueStatus(projectId: string, label: string): Promise<{ ok: boolean; message: string }> {
  const target = QUEUE_STATUS[label];
  if (!target) return { ok: false, message: "That status is set automatically from upload/delivery evidence." };
  // The job's edit card comes first, the revision lane second: the card is
  // what the pill moves below, and its assignee is "the editor" the timeline
  // and the bell name — a photo-lane revision (Kyle's "remove the closets"
  // ask) must never be the row that decides who started editing (Sep 10
  // review). The access rule is unchanged: the assigned editor via
  // requireTaskAccess, or admin when nothing is open.
  let editCard: { id: string; assignedKey: string | null; status: string } | null = null;
  try {
    const open = await prisma.smartTask.findMany({
      where: { projectId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true, assignedKey: true, status: true, taskType: true },
    });
    editCard = open.find((t) => t.taskType === "edit_video") ?? null;
    const gate = editCard ?? open[0] ?? null;
    const { requireTaskAccess, requireAdmin: reqAdmin } = await import("@/lib/auth/guards");
    if (gate) await requireTaskAccess(gate.id);
    else await reqAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  // Putting a job BACK is the office's call, not the editor's (Jordan, Sep 10:
  // "I should be able to put them back to ready for editing"; Sep 11: "change
  // projects back to waiting"). Sign-in and view-as were already checked
  // above, so the only refusal left here is the role — say it in the editor's
  // words instead of the guard's generic line.
  if (target === "SHOT" || target === "WAITING") {
    try {
      await requireRole(["OWNER", "ADMIN"]);
    } catch {
      return { ok: false, message: `Only the office can put a job back to ${target === "WAITING" ? "Waiting" : "Ready for editing"}.` };
    }
  }
  // ONE read for everything below: the delivery gate, the once-only delivery
  // stamp, and the Revisions branch (which used to fire its own second query).
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      status: true, // In editing / Ready for editing / Waiting are idempotent — a re-click must not re-log or re-ring
      shootDate: true, // Waiting = SCHEDULED with a date, BOOKED without
      debriefSubmittedAt: true, // the photographer's real submit — decides whether Waiting clears the sweep's uploadedAt stamp
      clientId: true,
      deliveredAt: true,
      statusEvidence: true,
      revisionRequestedAt: true,
      editorId: true,
      editorManual: true,
      videosFilmed: true, // the videos-owed ladder for the Completed gate (Sep 13, effectiveVideosOwed)
      videosOwedOverride: true,
      editor: { select: { name: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } },
    },
  });
  if (!proj) return { ok: false, message: "That job no longer exists." };

  // Is the office holding this job in Waiting right now? One read, only on a
  // row that reads Waiting (BOOKED/SCHEDULED) — the marker is inert anywhere
  // else. Feeds the editor refusal just below and the Waiting branch's
  // idempotence check.
  const { loadWaitingHolds, stampWaitingHold, releaseWaitingHold, whyNotWaiting } = await import("@/lib/queueWaiting");
  const onWaiting = proj.status === "BOOKED" || proj.status === "SCHEDULED";
  const heldNow = onWaiting && (await loadWaitingHolds([projectId])).has(projectId);
  // A HELD job is the office's to move, full stop (Jordan, Sep 11: it stays
  // Waiting "until the photographer submits the upload page or the office
  // moves it on" — an editor is neither). The row still shows on the
  // editor's scoped queue (its edit card stays OPEN and assigned), so the
  // pill greys every option there and this is the guard behind the greying:
  // an editor's In editing / Ready for review on a held row would have
  // walked straight past the hold and deleted the office's marker (Sep 11
  // review).
  if (heldNow && target !== "WAITING" && target !== "SHOT") {
    try {
      await requireRole(["OWNER", "ADMIN"]);
    } catch {
      const street = (proj.title || "this job").split(",")[0].trim();
      return { ok: false, message: `${street} is held in Waiting by the office — it can't be started until the footage is in.` };
    }
  }

  // ---- WAITING (Jordan, Sep 11: "I should also be able to change projects
  // back to waiting but its blocked off"). Only from Ready for editing / In
  // editing with NOTHING handed in: a cut in the Review Room, a client
  // revision, a delivery — each is a reason the job can't be un-shot, and
  // each is said back in plain words (whyNotWaiting, shared with the probe).
  // The marker is written BEFORE the status: a Waiting nobody is holding
  // would be flipped back by the next recompute, which is the very thing this
  // fixes. The edit card stays, back on OPEN — the row reads Waiting so nobody
  // works it, and the release (upload-page submit, or the office moving it on)
  // finds the card where it was. Idempotent: a re-click on a job already held
  // refreshes nothing and logs nothing.
  if (target === "WAITING") {
    const street = (proj.title || "this job").split(",")[0].trim();
    const cuts = await prisma.reviewSubmission.count({
      where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "SUPERSEDED", "WITHDRAWN"] } },
    });
    const refusal = whyNotWaiting({ status: proj.status, street, cuts });
    if (refusal) return { ok: false, message: refusal };
    if (heldNow) return { ok: true, message: "Status updated." };
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    const actor = me?.name ?? me?.email ?? "The office";
    try {
      await stampWaitingHold(projectId, actor, me?.email ?? null);
    } catch {
      return { ok: false, message: `Couldn't hold ${street} in Waiting — try again.` };
    }
    if (!onWaiting) {
      await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: `Queue status set: ${label}` } }).catch(() => {});
    }
    // This line is load-bearing, so it is NOT best-effort: notifyRawsLanded
    // reads the newest "Put back to Waiting by" row to decide that the raws-in
    // bell is owed again once the hold releases (tasks.ts). Written before the
    // status so a failed log takes the marker back out and refuses — a held
    // job with no line would release into silence (Sep 11 review).
    try {
      await prisma.activity.create({
        data: {
          projectId,
          type: "SYSTEM",
          body: `Put back to Waiting by ${actor} — the hub holds it there until the photographer submits the upload page or the office moves it on.`,
        },
      });
    } catch {
      await releaseWaitingHold(projectId);
      return { ok: false, message: `Couldn't hold ${street} in Waiting — try again.` };
    }
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: proj.shootDate ? "SCHEDULED" : "BOOKED",
        // The pill is a human's status write, and a human write ends the
        // office's status pin (Sep 13, editOverrides.ts) — the hold below is
        // what keeps this Waiting, not the pin.
        statusPinnedAt: null,
        // The sweep's uploadedAt stamp goes with the status (Sep 11 review):
        // every Ready for editing job the office would hold already wears
        // one, off the same raws the office is saying are not this job's —
        // and that stamp is what reads "Uploaded" on /upload and opens the
        // photographer's page on "Submitted — you're good to go" with the
        // submit hidden, so nobody would learn the hub is waiting on them.
        // A real submit (debriefSubmittedAt) keeps its stamp: the office is
        // holding the job, not un-saying the photographer's word.
        ...(proj.debriefSubmittedAt ? {} : { uploadedAt: null }),
      },
    });
    await prisma.smartTask.updateMany({
      where: { projectId, taskType: "edit_video", status: "IN_PROGRESS" },
      data: { status: "OPEN" },
    }).catch(() => {});
    // Park the QC card the way the reconciler parks a re-shoot (Sep 11
    // review): the media_qa spec is emitted for SHOT/EDITING/REVIEW/REVISION
    // only, so on a held SCHEDULED job the hourly "no longer expected" sweep
    // would COMPLETE it — a QC pass in the Done ledger with no QcRecord, for
    // the length of the hold. CANCELLED + SHOOT_NOT_YET is the stamp that
    // sweep skips and the media_qa branch reopens the first pass after the
    // job reads Ready for editing again.
    try {
      const { SHOOT_NOT_YET } = await import("@/lib/tasks");
      await prisma.smartTask.updateMany({
        where: { projectId, taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: {
          status: "CANCELLED",
          sourceDetail: SHOOT_NOT_YET,
          summary: "Parked — the office put the job back to Waiting. This comes back on its own once the footage is in.",
        },
      });
    } catch { /* the card is best-effort — the hold itself already landed */ }
    // Rewrite the evidence NOW rather than in an hour (Sep 11 review): the
    // project page and the edit page read statusEvidence.reason, and until
    // the next sweep they would still say "Raw files uploaded to Dropbox —
    // awaiting editing." under a Waiting status. The hold is already on
    // file, so this single-project pass takes the held path and writes
    // "Held in Waiting by the office…" — the same code the hourly sweep runs.
    try {
      const { syncProjectStatuses } = await import("@/lib/projectStatus");
      await syncProjectStatuses({ projectId });
    } catch { /* the hourly sweep writes the same reason */ }
    revalidatePath("/editing");
    revalidatePath(`/edit/${projectId}`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, message: `${street} is back on Waiting — the hub holds it there until the photographer submits the upload page or you move it on.` };
  }
  const status = target;

  // "Ready for editing" is the undo of an "In editing" — or, since Sep 11,
  // the office moving a Waiting job on (which releases its hold below). On a
  // job with a revision open the SHOT write would be flipped straight back to
  // REVISION by the next recompute (the open ask keeps it there), leaving only
  // a stray "Put back…" line on the timeline — so it is refused here, the
  // same way the pill greys it out on every other row (Sep 10 review).
  if (status === "SHOT" && proj.status === "REVISION") {
    return { ok: false, message: "A revision is open on this job — it can't be put back to Ready for editing until the ask is answered." };
  }

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
    // The office's number, the photographer's count, then the order rows
    // (Sep 13, editOverrides.effectiveVideosOwed) — the same count the cut
    // slots and the queue cell owe against.
    const videosOwed = proj.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
      ? effectiveVideosOwed(proj, proj.deliverables)
      : 0;
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
  let officeClosedRevision = 0; // asks the office closed by marking Completed (Sep 11) — shapes the final message
  if (status === "DELIVERED" || status === "REVIEW") {
    const { videoLaneRevisionWhere, correctedCutSubmitted, correctedCutApproved, revisionStateSummary } = await import("@/lib/reviewCuts");
    const lane = await prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId), select: { id: true, createdAt: true, summary: true } });
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
        // A withdrawn round is not the corrected cut (Sep 16) — reading one here
        // would tell the editor their revision is waiting on Jordan when the
        // video has already been taken back.
        where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "SUPERSEDED", "WITHDRAWN"] }, createdAt: { gte: raisedAt } },
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
        // THE OFFICE CLOSES THE LOOP (Jordan, Sep 11: "When I change the
        // status to completed … it didn't save" — 1244 West Chester Pike).
        // Marcee's corrected videos were emailed to her by hand on Sep 9;
        // nothing ever went through the Review Room, so the rule below — the
        // Sep 8 rule for EDITORS, who hand a corrected cut to the Room and
        // wait for Jordan — refused the owner too, and the pill's refusal read
        // as "didn't save". The office IS the reviewer: its "Completed" says
        // the client's ask is answered. So it takes the same hand path as the
        // task's Complete button and the project-page button (resolveRevision):
        // close the open asks, clear the stamp, land back on Delivered with
        // the ORIGINAL delivery date, retire the re-QC card. Editors, and a
        // "view as" preview of one, keep the refusal. "Ready for review" with
        // nothing uploaded stays refused for everyone — there is nothing to
        // review.
        const { getCurrentUser } = await import("@/lib/auth/user");
        const { authEnforced } = await import("@/lib/auth/guards");
        const me = await getCurrentUser().catch(() => null);
        const office = me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced();
        if (!wantsReview && office) {
          const actor = me?.name ?? me?.email ?? "The office";
          const laneIds = lane.map((t) => t.id);
          const sentence = `Closed by the office (${actor}) — delivered outside the Review Room.`;
          const { stampHandledByHand } = await import("@/lib/opsDay");
          // Another lane still open (Kyle's photo ask on a mixed job): close
          // the video asks only and say so. A Delivered write here would be
          // flipped straight back by the recompute while the stamp stands.
          const otherOpen = await prisma.smartTask.count({
            where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] }, id: { notIn: laneIds } },
          });
          if (otherOpen > 0) {
            for (const t of lane) {
              await prisma.smartTask.update({
                where: { id: t.id },
                data: { status: "COMPLETED", completedAt: new Date(), summary: revisionStateSummary(t.summary, sentence) },
              }).catch(() => {});
              await stampHandledByHand(t.id, actor, me?.email ?? null);
            }
            const still = `${otherOpen} ask${otherOpen === 1 ? " is" : "s are"} still open in another lane`;
            await prisma.activity.create({
              data: { projectId, type: "SYSTEM", body: `${actor} closed the video revision on the queue — delivered outside the Review Room. ${still}, so the job stays in Revisions.` },
            }).catch(() => {});
            return done(false, `${street}: the video ask is closed, but ${still} — the job stays in Revisions until that is answered.`);
          }
          // Resolve FIRST, then describe: a resolve that fails must not leave
          // open asks wearing a "closed" sentence, and no Delivered write may
          // follow a half-done resolve (Sep 11 review).
          try {
            const { resolveRevision } = await import("@/lib/comms");
            await resolveRevision(projectId);
          } catch {
            return done(false, `Couldn't finish closing the revision on ${street} — check the job's timeline and try again.`);
          }
          for (const t of lane) {
            await prisma.smartTask.update({ where: { id: t.id }, data: { summary: revisionStateSummary(t.summary, sentence) } }).catch(() => {});
            await stampHandledByHand(t.id, actor, me?.email ?? null);
          }
          await prisma.activity.create({
            data: { projectId, type: "SYSTEM", body: `${actor} marked Completed on the queue — client revision closed as resolved (delivered outside the Review Room).` },
          }).catch(() => {});
          officeClosedRevision = lane.length;
          // fall through: the Delivered write, the "Queue status set" line and
          // the delivered close-out below are what a Completed click always does.
        } else {
          const { submitCutForReview } = await import("@/app/review/actions");
          const sent = await submitCutForReview(projectId).catch(() => ({ ok: false as const, message: "" }));
          if (sent.ok) {
            return done(wantsReview, `Sent to the Review Room — ${street} has a client revision open, so it reads Ready for review until Jordan rules and Completed once he approves the corrected cut.`);
          }
          return done(false, `${street} has a client revision open and nothing new has been uploaded since it came in. Press Upload version N on the edit page (it takes a new version even on an approved cut while the revision is open) — or drop a NEW file in 05-Final-Video and hit "Done — send to review" — and it reads Ready for review, then Completed once Jordan approves it.`);
        }
      }
    }
  }

  // Every forward write releases the office's Waiting hold (Sep 11): a human
  // moving the job on is the second of the two things that end it. After the
  // refusals above on purpose — a refused "Completed" must not quietly drop
  // the hold and let the next sweep flip the job. On a HELD row only the
  // office reaches this line (the guard above); a stale marker on a job that
  // is not on Waiting is deleted by whoever clicked, so it can't spring back
  // the day the office parks that job again by hand.
  const holdReleased = await releaseWaitingHold(projectId);

  await prisma.project.update({
    where: { id: projectId },
    // deliveryStamp, not `new Date()`: this click used to overwrite the
    // ORIGINAL delivery date every time (see the rule in src/lib/delivery.ts).
    // 4 of the 6 "Completed" clicks on record landed on a job that was already
    // delivered and moved its date by 1.8 to 18.0 days — 1023 Sycamore Mills
    // Rd was delivered Aug 10 and now reads Aug 28.
    // statusPinnedAt: a human's click on the pill ends the office's status
    // pin (Sep 13, editOverrides.ts) — the pill and the board stay the
    // human's tools; the pin only ever holds off the engines.
    data: { status, statusPinnedAt: null, ...(status === "DELIVERED" ? deliveryStamp(proj.deliveredAt) : {}) },
  });
  // This Activity row is load-bearing, not decoration: createDeliveryTextTask
  // reads "Queue status set: Completed" as the editor's override that releases
  // a monthly-content job's held-back delivery text. It must exist BEFORE the
  // closer below runs.
  // SAY WHAT IS STILL MISSING (Kyle's call, Sep 16). A "Completed" only gets
  // this far when the outstanding check above passed — either nothing was
  // owed, or an APPROVED Review-Room cut proved the video landed while the
  // hourly evidence read still says it is missing. That second case is exactly
  // the one worth writing down: the cut is in the job's Final folder, but
  // nothing has been published to Aryeo, which is precisely the gap Kyle hit
  // (photos out, video never QC'd or delivered). The evidence blob, unproven,
  // is what the line reports. Empty evidence says nothing.
  const stillMissing = status === "DELIVERED" ? outstandingForDelivery(proj.statusEvidence) : [];
  const missingClause = stillMissing.length
    ? ` — with ${stillMissing.map((c) => c.toLowerCase()).join(", ")} still missing on Aryeo`
    : "";
  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: `Queue status set: ${label}${missingClause}` },
  }).catch(() => {});

  // THE EDITOR STARTS IT / THE OFFICE PUTS IT BACK (Jordan, Sep 10). The job's
  // edit_video card follows the pill — IN_PROGRESS while the editor is in the
  // edit, back to OPEN when the office returns the job to Ready for editing —
  // so /tasks and the QC card agree with the queue. Everything else on the job
  // (the editor assignment, cuts in the Review Room, revision asks) is left
  // exactly as it was. The card move itself is idempotent; the timeline line
  // and the bell fire only when the job was NOT already started — judged by
  // the card as well as the status, because the status is not the only thing
  // that can move (the pipeline board, an engine) while the card keeps the
  // truth: a re-click, or an "In editing" on a job whose card already sits
  // IN_PROGRESS, must never re-ring the office for the same start (Sep 10
  // review). The revision lane is deliberately untouched: a revision task's
  // own IN_PROGRESS means "corrected cut submitted — waiting on review".
  if (status === "EDITING" || status === "SHOT") {
    const started = editCard?.status === "IN_PROGRESS";
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { editorMeta } = await import("@/lib/editors");
    const me = await getCurrentUser().catch(() => null);
    const actor = me?.name ?? me?.email ?? "The office";
    const street = (proj.title || "this job").split(",")[0].trim();
    if (status === "EDITING") {
      await prisma.smartTask.updateMany({
        where: { projectId, taskType: "edit_video", status: "OPEN" },
        data: { status: "IN_PROGRESS" },
      }).catch(() => {});
      if (proj.status !== "EDITING" && !started) {
        // "<Name> started editing." names the EDITOR: the click is usually
        // theirs, but when the office sets it on their behalf the edit card's
        // assignee is the person who actually started, not the one who typed it.
        const editorName = me?.role === "EDITOR" ? actor : editorMeta(editCard?.assignedKey)?.name ?? actor;
        await prisma.activity.create({
          data: { projectId, type: "SYSTEM", body: `${editorName} started editing.` },
        }).catch(() => {});
        try {
          const { notifyInApp } = await import("@/lib/notify");
          await notifyInApp({
            kind: "edit_started",
            title: `${editorName} started editing ${street}`,
            href: `/edit/${projectId}`,
            targets: [{ roles: ["OWNER", "ADMIN"] }],
            // No dedupeKey on purpose: a job put back and started again is news again.
          });
        } catch { /* bell is best-effort */ }
      }
    } else {
      await prisma.smartTask.updateMany({
        where: { projectId, taskType: "edit_video", status: "IN_PROGRESS" },
        data: { status: "OPEN" },
      }).catch(() => {});
      // From a Waiting row this is not an undo but the office moving the job
      // ON (Sep 11) — say so, and run the handoff now rather than in an hour:
      // ensureEditorHandoff is idempotent, and its raws-in bell rings again
      // after a hold (notifyRawsLanded keys off the "Put back to Waiting" line
      // and, as the fallback, any line carrying "Waiting hold released" — keep
      // that phrase if the wording ever changes).
      if (onWaiting) {
        await prisma.activity.create({
          data: { projectId, type: "SYSTEM", body: `Moved on to Ready for editing by ${actor}${holdReleased ? " — Waiting hold released" : ""}.` },
        }).catch(() => {});
        try {
          const { ensureEditorHandoff } = await import("@/lib/tasks");
          await ensureEditorHandoff(projectId);
        } catch { /* the hourly sweep is the backstop */ }
      } else if (proj.status !== "SHOT" || started) {
        await prisma.activity.create({
          data: { projectId, type: "SYSTEM", body: `Put back to Ready for editing by ${actor}.` },
        }).catch(() => {});
      }
    }
  }

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
        // Withdrawn rounds are free again (Sep 16), so the card asks for the
        // round the next upload will really be.
        where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "SUPERSEDED", "WITHDRAWN"] } },
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
  // The module-level import, not a function-scoped re-import: a `const`
  // re-import here shadowed it for the WHOLE function, so the `done()` helper
  // in the revision branch above (and the Waiting branch) reached a binding
  // that had not been declared yet (Sep 11).
  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  if (officeClosedRevision > 0) {
    const street = (proj.title || "this job").split(",")[0].trim();
    return { ok: true, message: `Completed — you closed the client's revision on ${street} as resolved (${officeClosedRevision} ask${officeClosedRevision === 1 ? "" : "s"}); the job is back on Delivered with its original delivery date.` };
  }
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

// ---------------------------------------------------------------------------
// THE OFFICE OVERRIDES A JOB (Jordan, Sep 13: "I want to be able to change the
// status, amount of deliverables, the due date and all other information for
// the edits in the editing room. I want to be able to override anything.").
//
// The pill above is deliberately guarded — it refuses a Completed with the
// video still missing, a Waiting with a cut handed in, an editor's Waiting at
// all. This is the other tool: the office's word over every rule, written to
// the hub-owned override columns on Project (src/lib/editOverrides.ts) that
// every reader prefers and no engine ever writes.
//   · a status = a DIRECT Project.status write that bypasses those guardrails
//     and PINS it (statusPinnedAt = now): the hourly status sweep, the folder
//     sweep, the per-project recheck and the Aryeo sync all leave it alone
//     until a human moves it (the pill, the board, this dialog's "Let the hub
//     manage the status again"), Aryeo cancels the order, or a client asks
//     for changes. It releases any Waiting hold (the pin is the stronger
//     grip), moves the edit card the way the pill would (IN_PROGRESS for In
//     editing, OPEN otherwise, COMPLETED through closeObsoleteTasks for
//     Completed — with deliveryStamp so an original delivery date stands),
//     and a Completed closes any open client revision the way the office's
//     Completed on the pill does (resolveRevision).
//   · editor = the same road as the row's select (setEditVideoEditor: pin,
//     card, bell, its own timeline line).
//   · due / videos owed / tier / video type / priority = the override
//     columns; null clears one back to the hub's value.
// One Activity row per save (describeOverrides) says exactly what moved.
// Idempotent: a re-save with nothing different writes nothing.
// ---------------------------------------------------------------------------

// Project.status ↔ the queue ladder's words, for the sentence and the write.
const OVERRIDE_STATUS_LABEL: Record<string, string> = {
  BOOKED: "Waiting",
  SCHEDULED: "Waiting",
  SHOT: "Ready for editing",
  EDITING: "In editing",
  REVIEW: "Ready for review",
  REVISION: "Revisions",
  DELIVERED: "Completed",
  ON_HOLD: "On hold",
  CANCELLED: "Cancelled",
};
const EDITOR_SELECT_KEYS = new Set<string>(["", "kim", "john", "external_agency"]);

export async function saveEditOverrides(projectId: string, input: EditOverrideInput): Promise<{ ok: boolean; message: string }> {
  try {
    await requireRole(["OWNER", "ADMIN"]);
  } catch {
    return { ok: false, message: "Only the office can override a job." };
  }

  // ---- Validate every field before touching anything. ----
  if (input.status != null && !(EDIT_STATUS_LABELS as readonly string[]).includes(input.status)) {
    return { ok: false, message: "Pick one of the six queue statuses." };
  }
  if (input.videosOwed != null && !(Number.isInteger(input.videosOwed) && input.videosOwed >= 1 && input.videosOwed <= 40)) {
    return { ok: false, message: "Videos owed has to be a whole number from 1 to 40." };
  }
  let dueAt: Date | null | undefined = undefined;
  if (input.dueAt !== undefined) {
    if (input.dueAt === null) dueAt = null;
    else {
      const d = new Date(input.dueAt);
      if (Number.isNaN(d.getTime())) return { ok: false, message: "That due date isn't a real date." };
      dueAt = d;
    }
  }
  if (input.priority != null && !(EDIT_PRIORITIES as readonly string[]).includes(input.priority)) {
    return { ok: false, message: "Priority has to be Low, Normal, High or Urgent." };
  }
  if (input.tier != null && !(EDIT_TIERS as readonly string[]).includes(input.tier)) {
    return { ok: false, message: "Tier has to be Standard, Premium or Personal Branding." };
  }
  const typeDetail = input.typeDetail === undefined ? undefined : (input.typeDetail ?? "").trim() || null;
  if (typeDetail && typeDetail.length > 120) return { ok: false, message: "Keep the video type under 120 characters." };
  const note = input.note === undefined ? undefined : input.note.trim() || null;
  if (note && note.length > 300) return { ok: false, message: "Keep the note under 300 characters." };
  const wantsEditor = input.editorKey != null;
  if (wantsEditor && !EDITOR_SELECT_KEYS.has(input.editorKey as string)) {
    return { ok: false, message: "Pick a video editor (Kim or John Mark), the external agency, or Unassigned." };
  }

  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      shootDate: true,
      deliveredAt: true,
      deliveryDue: true,
      revisionRequestedAt: true,
      editorManual: true,
      editorVendorKey: true,
      // Read for the timeline line below: an override to Completed says what
      // was still outstanding when the office forced it (Kyle's call, Sep 16).
      statusEvidence: true,
      editor: { select: { name: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } },
      ...OVERRIDE_SELECT,
    },
  });
  if (!proj) return { ok: false, message: "That job no longer exists." };
  if (proj.status === "CANCELLED") return { ok: false, message: "That job is cancelled — un-cancel it on the project page first." };
  const street = (proj.title || "this job").split(",")[0].trim();

  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const actor = me?.name ?? me?.email ?? "The office";
  const now = new Date();

  // ---- The job as it reads NOW (effective values), for the sentence. ----
  const { isMonthlyContentJob } = await import("@/lib/pipeline");
  const { videoTier } = await import("@/lib/projectStatus");
  const { editorMeta, editorKeyForTeamName } = await import("@/lib/editors");
  const videos = proj.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const monthly = isMonthlyContentJob(proj.deliverables);
  const computedTier: EditTier = monthly ? "branding" : videoTier(proj.deliverables) === "premium" ? "premium" : "standard";
  const computedTypeDetail = videos.map((d) => d.label || d.type).join(" · ");
  // Who has it: the open edit card, else the project's editor, else the vendor
  // pin — the queue row's own ladder.
  const card = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { assignedKey: true },
  });
  const currentEditorKey = card?.assignedKey ?? editorKeyForTeamName(proj.editor?.name) ?? proj.editorVendorKey ?? null;
  const currentEditorName = currentEditorKey ? editorMeta(currentEditorKey)?.name ?? currentEditorKey : proj.editor?.name ?? null;
  // The status the office SAW when it opened the dialog (the queue row's
  // cut-derived label, when the dialog passed it) rather than the stored
  // status's word — so the sentence can't read "Ready for review → Revisions"
  // for a row that already said Revisions (review, Sep 13). Sentence only;
  // the write and `statusChanged` still go off Project.status.
  const fromLabel = typeof input.fromLabel === "string" ? input.fromLabel.trim().slice(0, 40) : "";
  const before: OverrideSnapshot = {
    status: fromLabel || OVERRIDE_STATUS_LABEL[proj.status] || proj.status,
    pinned: !!proj.statusPinnedAt,
    editor: currentEditorName,
    dueAt: effectiveDue(proj, proj.deliveryDue),
    videosOwed: effectiveVideosOwed(proj, videos),
    tier: effectiveTier(proj, computedTier),
    typeDetail: effectiveTypeDetail(proj, computedTypeDetail),
    priority: effectivePriority(proj, proj.priority),
    note: proj.overrideNote,
  };

  // ---- What changes. ----
  const target = input.status ? QUEUE_STATUS[input.status] : null;
  const targetStatus: "BOOKED" | "SCHEDULED" | "SHOT" | "EDITING" | "REVIEW" | "REVISION" | "DELIVERED" | null =
    target === "WAITING" ? (proj.shootDate ? "SCHEDULED" : "BOOKED") : target;
  const statusChanged = !!targetStatus && targetStatus !== proj.status;
  const pinNow = !!targetStatus || input.pinStatus === true;
  const unpin = !targetStatus && input.pinStatus === false;
  const pinChanged = (pinNow && !proj.statusPinnedAt) || (unpin && !!proj.statusPinnedAt);
  const editorChanged = wantsEditor && (input.editorKey as string) !== (currentEditorKey ?? "");

  const merged = {
    dueOverrideAt: dueAt === undefined ? proj.dueOverrideAt : dueAt,
    videosOwedOverride: input.videosOwed === undefined ? proj.videosOwedOverride : input.videosOwed,
    tierOverride: input.tier === undefined ? proj.tierOverride : input.tier,
    typeDetailOverride: typeDetail === undefined ? proj.typeDetailOverride : typeDetail,
    priorityOverride: input.priority === undefined ? proj.priorityOverride : input.priority,
    overrideNote: note === undefined ? proj.overrideNote : note,
    statusPinnedAt: unpin ? null : pinNow ? now : proj.statusPinnedAt,
  };
  const sameInstant = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  const columnsChanged =
    !sameInstant(merged.dueOverrideAt, proj.dueOverrideAt) ||
    merged.videosOwedOverride !== proj.videosOwedOverride ||
    merged.tierOverride !== proj.tierOverride ||
    merged.typeDetailOverride !== proj.typeDetailOverride ||
    merged.priorityOverride !== proj.priorityOverride ||
    merged.overrideNote !== proj.overrideNote;
  if (!columnsChanged && !statusChanged && !pinChanged && !editorChanged) {
    return { ok: true, message: "Nothing changed." };
  }

  const nextEditorName = !wantsEditor
    ? currentEditorName
    : input.editorKey === ""
      ? null
      : editorMeta(input.editorKey as string)?.name ?? (input.editorKey as string);
  const after: OverrideSnapshot = {
    status: OVERRIDE_STATUS_LABEL[targetStatus ?? proj.status] ?? proj.status,
    pinned: !!merged.statusPinnedAt,
    editor: nextEditorName,
    dueAt: effectiveDue(merged, proj.deliveryDue),
    videosOwed: effectiveVideosOwed({ ...merged, videosFilmed: proj.videosFilmed }, videos),
    tier: effectiveTier(merged, computedTier),
    typeDetail: effectiveTypeDetail(merged, computedTypeDetail),
    priority: effectivePriority(merged, proj.priority),
    note: merged.overrideNote,
  };

  // ---- The editor, through the row's own road. A job that is Completed
  // refuses a reassign there (no live work to hand off), so when this save
  // also moves the job OFF Completed the editor step runs after the status
  // write instead. Nothing else has been written when a refusal returns here.
  const editorStep = async () => (editorChanged ? setEditVideoEditor(projectId, input.editorKey as string) : { ok: true, message: "" });
  const editorAfterStatus = editorChanged && proj.status === "DELIVERED" && statusChanged;
  if (editorChanged && !editorAfterStatus) {
    const r = await editorStep();
    if (!r.ok) return r;
  }

  // ---- The columns + the status, one write. Nothing left set, nothing
  // pinned and no note = no override on the job any more, so the who/when go
  // too (the timeline keeps the history). A note on its own STAYS (review,
  // Sep 13): it used to be written to the timeline and then cleared off the
  // row in the same save, so the chip never wore it and the office's words
  // were gone from the job.
  const nothingLeft = !anyOverrideSet(merged) && !merged.overrideNote;
  await prisma.project.update({
    where: { id: projectId },
    data: {
      dueOverrideAt: merged.dueOverrideAt,
      videosOwedOverride: merged.videosOwedOverride,
      tierOverride: merged.tierOverride,
      typeDetailOverride: merged.typeDetailOverride,
      priorityOverride: merged.priorityOverride,
      statusPinnedAt: merged.statusPinnedAt,
      overrideBy: nothingLeft ? null : actor,
      overrideAt: nothingLeft ? null : now,
      overrideNote: nothingLeft ? null : merged.overrideNote,
      ...(targetStatus
        ? {
            status: targetStatus,
            // The ORIGINAL delivery date stands on a re-delivery (delivery.ts rule 1).
            ...(targetStatus === "DELIVERED" ? deliveryStamp(proj.deliveredAt) : {}),
          }
        : {}),
    },
  });

  // THE OFFICE'S NUMBER IS A QUANTITY CHANGE (R06, review Sep 18). The other
  // of the two paths the review named. cutSlots reads videosOwedOverride —
  // 893 S Matlack owes sixteen because the office said so, not because Aryeo
  // did — and DeliverableOutput is materialised FROM cutSlots, so raising the
  // number here and not calling this left fifteen videos owed as an integer
  // and not as rows with an owner, a deadline and a review state. Lowering it
  // matters just as much: the rows above the new number are retired rather
  // than left on somebody's card. Staff should not have to wait for the hourly
  // repair sweep to catch up with a decision they just made.
  if (merged.videosOwedOverride !== proj.videosOwedOverride) {
    try {
      const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
      await ensureOutputsSafely(projectId, `office-videos-owed#${actor}`);
    } catch { /* the hourly sweep is the backstop; the override itself landed */ }
  }

  // ONE timeline row, before the close-outs below: createDeliveryTextTask
  // reads an "Override by … → Completed" line as the office's word that a
  // monthly batch is done (the same release the pill's "Queue status set:
  // Completed" gives), so it must exist before closeObsoleteTasks mints.
  // SAY WHAT IS STILL MISSING (Kyle's call, Sep 16). The override dialog is
  // the control that FORCES Completed past every check the pill makes, so it
  // is the one human path most likely to mark a job delivered while the
  // evidence still says a category never landed — Kyle's exact fault (photos
  // out, the video never QC'd or published). The line now carries what was
  // outstanding at the moment of the force, so the timeline shows it. Empty or
  // unreadable evidence says nothing (delivery.ts rule 2: we speak only on
  // positive proof that something is owed).
  const stillMissing = targetStatus === "DELIVERED" ? outstandingForDelivery(proj.statusEvidence) : [];
  const sentence =
    describeOverrides(before, after, actor) +
    (stillMissing.length ? ` — with ${stillMissing.map((c) => c.toLowerCase()).join(", ")} still missing on Aryeo` : "");
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: sentence } }).catch(() => {});

  // ---- A forced status: the hold, the card, the close-outs. ----
  if (targetStatus) {
    // The pin is the stronger grip — a Waiting hold under it would only
    // spring back the day the pin is lifted (queueWaiting.ts).
    try {
      const { releaseWaitingHold } = await import("@/lib/queueWaiting");
      await releaseWaitingHold(projectId);
    } catch { /* hygiene only */ }
    const EDIT_KEY = `edit-video-${projectId}`;
    if (targetStatus === "DELIVERED") {
      // Close any open client revision the way the office's Completed on the
      // pill does: asks closed, stamp cleared, re-QC card retired. The status
      // is already Delivered, so resolveRevision keeps it there (its landing
      // only moves a REVISION/REVIEW job) and runs the delivered close-out.
      const openAsks = await prisma.smartTask.count({ where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
      if (openAsks > 0 || proj.revisionRequestedAt) {
        try {
          const { resolveRevision } = await import("@/lib/comms");
          await resolveRevision(projectId);
        } catch { /* the close-out below still runs */ }
      }
      try {
        const { closeObsoleteTasks } = await import("@/lib/tasks");
        await closeObsoleteTasks(projectId, "DELIVERED");
      } catch { /* best-effort — the status write above already landed */ }
    } else {
      // Off Completed and back to work: the edit card the delivery closed is
      // real work again. assignedManually keeps whoever held it and stops the
      // reconciler's evidence close (the old cut is still live) from folding
      // it straight back — the assignedManually invariant every engine
      // respects. Then the standard refresh (due/priority off the overrides).
      if (proj.status === "DELIVERED") {
        await prisma.smartTask.updateMany({
          where: { dedupeKey: EDIT_KEY, status: { in: ["COMPLETED", "CANCELLED"] } },
          data: { status: "OPEN", completedAt: null, assignedManually: true },
        }).catch(() => {});
        try {
          const { mintEditTask } = await import("@/lib/tasks");
          await mintEditTask(projectId);
        } catch { /* the hourly handoff is the backstop */ }
      }
      if (targetStatus === "EDITING") {
        await prisma.smartTask.updateMany({ where: { dedupeKey: EDIT_KEY, status: "OPEN" }, data: { status: "IN_PROGRESS" } }).catch(() => {});
      } else {
        await prisma.smartTask.updateMany({ where: { dedupeKey: EDIT_KEY, status: "IN_PROGRESS" }, data: { status: "OPEN" } }).catch(() => {});
      }
      if (targetStatus === "SCHEDULED" || targetStatus === "BOOKED") {
        // Park the QC card the way the pill's Waiting does (Sep 11): on a
        // Waiting job the hourly "no longer expected" sweep would COMPLETE it
        // — a QC pass in the Done ledger with no QcRecord. CANCELLED +
        // SHOOT_NOT_YET is the stamp that sweep skips and the media_qa branch
        // reopens once the job reads Ready for editing again.
        try {
          const { SHOOT_NOT_YET } = await import("@/lib/tasks");
          await prisma.smartTask.updateMany({
            where: { projectId, taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
            data: { status: "CANCELLED", sourceDetail: SHOOT_NOT_YET, summary: "Parked — the office set the job back to Waiting. This comes back on its own once the job moves on." },
          });
        } catch { /* the card is best-effort — the status already landed */ }
      }
    }
    // Rewrite the evidence now rather than in an hour: the project page and
    // the edit page read statusEvidence.reason, and the pinned pass writes
    // "Status pinned by the office…" — the same code the hourly sweep runs.
    try {
      const { syncProjectStatuses } = await import("@/lib/projectStatus");
      await syncProjectStatuses({ projectId });
    } catch { /* the hourly sweep writes the same reason */ }
  } else if (dueAt !== undefined || input.priority !== undefined) {
    // A due / priority change alone: a LIVE edit card follows now, not at the
    // next hourly refresh (mintEditTask reads the same columns). Only a live
    // one — mintEditTask has no status gate and would CREATE an OPEN "Raws
    // are in — cut the video" card for any video job, so a due set ahead of
    // the shoot on an Upcoming row (or on a Done job that never had a card)
    // used to put a phantom job on the editor's board days before the raws
    // existed (review, Sep 13). A job with no card picks the override up
    // when ensureEditorHandoff mints it after the raws land.
    const live = await prisma.smartTask.findFirst({
      where: { dedupeKey: `edit-video-${projectId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    if (live) {
      try {
        const { mintEditTask } = await import("@/lib/tasks");
        await mintEditTask(projectId);
      } catch { /* the hourly refresh is the backstop */ }
    }
  }

  let editorNote = "";
  if (editorAfterStatus) {
    const r = await editorStep();
    if (!r.ok) editorNote = ` The editor didn't change: ${r.message}`;
  }

  for (const path of ["/editing", `/edit/${projectId}`, `/projects/${projectId}`, "/", "/pipeline"]) revalidatePath(path);
  const receipt = sentence.replace(/^Override by [^:]+: /, "");
  return {
    ok: !editorNote,
    message: `${street}: ${receipt}.${editorNote}`,
  };
}

// ---------------------------------------------------------------------------
// TAKE A JOB OFF THE EDITING ROOM, AND PUT IT BACK.
//
// Jordan, Sep 18 2026: "I'd like a way to delete the jobs from the editing
// room… I don't want it to delete anything other than the editing task. I don't
// want it to affect anything else in our system. Maybe keep it stored for 7
// days after being deleted with the ability to bring it back."
//
// The blast radius is written down in lib/queueRemoved and enforced here: a
// marker one query reads, and the edit task retired with its own state saved
// first. Not the project status, not a deliverable, not a cut, not a verdict,
// not a delivery stamp, not the Aryeo order, not the client. Nothing here
// leaves the building — no client message, no Aryeo write, no file moved.
// ---------------------------------------------------------------------------

/** Take a job off the Editing Room. Reversible for RESTORE_WINDOW_DAYS. */
export async function removeFromEditorQueue(projectId: string, note?: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const actor = me?.name ?? me?.email ?? "The office";

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true } });
  if (!project) return { ok: false, message: "That job no longer exists." };

  const { queueRemovedKey, removalFor, serialize } = await import("@/lib/queueRemoved");
  const already = await removalFor(projectId);
  if (already && !already.restoredAt) return { ok: true, message: "That job is already off the Editing Room." };

  // READ THE TASK BEFORE TOUCHING IT. The restore is only as good as what is
  // written down here, and `assignedManually` in particular cannot be
  // reconstructed afterwards — it is the difference between a human's choice
  // and a routing rule's, and every engine treats those differently.
  const task = await prisma.smartTask.findUnique({
    where: { dedupeKey: `edit-video-${projectId}` },
    select: { id: true, status: true, assignedKey: true, assignedManually: true },
  });
  const taskWas = task ? { status: task.status, assignedKey: task.assignedKey, assignedManually: task.assignedManually } : null;

  const at = new Date();
  const clean = (note ?? "").trim().slice(0, 300) || null;
  await prisma.appSetting.upsert({
    where: { key: queueRemovedKey(projectId) },
    create: { key: queueRemovedKey(projectId), value: serialize({ by: actor, at, note: clean, task: taskWas, restoredAt: null, restoredBy: null }) },
    update: { value: serialize({ by: actor, at, note: clean, task: taskWas, restoredAt: null, restoredBy: null }) },
  });

  // CANCELLED, not deleted, and only if it is still live — a task somebody has
  // already completed keeps its completion.
  if (task && !["COMPLETED", "CANCELLED"].includes(task.status)) {
    await prisma.smartTask
      .update({ where: { id: task.id }, data: { status: "CANCELLED", completedAt: at } })
      .catch(() => null);
  }

  const street = (project.title || "this job").split(",")[0].trim();
  await prisma.activity
    .create({
      data: {
        projectId,
        type: "SYSTEM",
        body: `${actor} took ${street} off the Editing Room${clean ? ` — "${clean}"` : ""}. The edit card is cancelled; nothing else about the job changed, and it can be brought back for 7 days.`.slice(0, 500),
      },
    })
    .catch(() => {});

  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: `${street} is off the Editing Room. You can bring it back for 7 days.` };
}

/** Put it back, exactly as it was. */
export async function restoreToEditorQueue(projectId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const actor = me?.name ?? me?.email ?? "The office";

  const { queueRemovedKey, removalFor, restorable, serialize, RESTORE_WINDOW_DAYS } = await import("@/lib/queueRemoved");
  const rec = await removalFor(projectId);
  if (!rec || rec.restoredAt) return { ok: false, message: "That job isn't off the Editing Room." };
  if (!restorable(rec)) {
    return {
      ok: false,
      message: `That was removed more than ${RESTORE_WINDOW_DAYS} days ago, so it can't be brought back from here. Add it to the queue again with "Add a job to the queue".`,
    };
  }

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true } });
  if (!project) return { ok: false, message: "That job no longer exists." };

  // The task first: a job back on the board with no card is the same
  // half-restored state the removal exists to avoid, in reverse.
  if (rec.task) {
    await prisma.smartTask
      .update({
        where: { dedupeKey: `edit-video-${projectId}` },
        data: {
          status: rec.task.status,
          assignedKey: rec.task.assignedKey,
          // Whoever held it still holds it. Re-deriving from the routing rules
          // here would quietly hand a job to a different editor than the one it
          // was taken from.
          assignedManually: rec.task.assignedManually,
          ...(["COMPLETED", "CANCELLED"].includes(rec.task.status) ? {} : { completedAt: null }),
        },
      })
      .catch(() => null);
  }

  const at = new Date();
  // The marker STAYS — who removed what and when is the record. `restoredAt` is
  // what takes the job off the hidden set (lib/queueRemoved.removedProjectIds).
  await prisma.appSetting
    .update({
      where: { key: queueRemovedKey(projectId) },
      data: { value: serialize({ by: rec.by, at: rec.at, note: rec.note, task: rec.task, restoredAt: at, restoredBy: actor }) },
    })
    .catch(() => null);

  const street = (project.title || "this job").split(",")[0].trim();
  await prisma.activity
    .create({
      data: { projectId, type: "SYSTEM", body: `${actor} brought ${street} back to the Editing Room.`.slice(0, 500) },
    })
    .catch(() => {});

  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: `${street} is back on the Editing Room.` };
}

/** The "Recently removed" list the Editing Room offers — removals still inside
 *  the undo window, newest first. Read-only. */
export async function recentlyRemovedFromQueue(): Promise<
  { projectId: string; street: string; by: string | null; atISO: string; note: string | null; expiresISO: string }[]
> {
  try {
    await requireAdmin();
  } catch {
    return [];
  }
  const { allRemovals, restorable, RESTORE_WINDOW_DAYS } = await import("@/lib/queueRemoved");
  const live = (await allRemovals()).filter((r) => restorable(r));
  if (live.length === 0) return [];
  const titles = new Map(
    (await prisma.project.findMany({ where: { id: { in: live.map((r) => r.projectId) } }, select: { id: true, title: true } }))
      .map((p) => [p.id, p.title] as const),
  );
  return live.map((r) => ({
    projectId: r.projectId,
    street: (titles.get(r.projectId) || "A job").split(",")[0].trim(),
    by: r.by,
    atISO: r.at.toISOString(),
    note: r.note,
    expiresISO: new Date(r.at.getTime() + RESTORE_WINDOW_DAYS * 86_400_000).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// MERGE TWO JOBS' WORK. See lib/projectMerge for why the two ROWS stay.
// ---------------------------------------------------------------------------

/** Move one job's owed work onto another. Money, orders and appointments stay
 *  exactly where they are. Reversible. */
export async function mergeProjectWork(
  fromId: string,
  intoId: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!fromId || !intoId || fromId === intoId) return { ok: false, message: "Pick two different jobs." };

  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const actor = me?.name ?? me?.email ?? "The office";
  const { mergeKey, mergeFrom, previewMerge, serializeMerge } = await import("@/lib/projectMerge");

  const [from, into] = await Promise.all([
    prisma.project.findUnique({ where: { id: fromId }, select: { id: true, title: true, clientId: true, status: true, client: { select: { name: true } } } }),
    prisma.project.findUnique({ where: { id: intoId }, select: { id: true, title: true, clientId: true, status: true, client: { select: { name: true } } } }),
  ]);
  if (!from || !into) return { ok: false, message: "One of those jobs no longer exists." };
  if (from.status === "CANCELLED" || into.status === "CANCELLED") {
    return { ok: false, message: "A cancelled job can't be merged — un-cancel it first." };
  }
  // DIFFERENT CLIENTS IS ALMOST ALWAYS A MISTAKE, and the one thing this action
  // could do that nobody could unpick by eye: a cut delivered to the wrong
  // agent. Refused rather than warned.
  if (from.clientId !== into.clientId) {
    return { ok: false, message: `Those belong to different clients (${from.client.name} and ${into.client.name}). Merging across clients isn't allowed.` };
  }
  if (await mergeFrom(fromId)) return { ok: false, message: "That job's work has already been merged somewhere." };
  if (await mergeFrom(intoId)) return { ok: false, message: "You can't merge INTO a job whose own work has been merged away." };

  const moved = await previewMerge(fromId);
  if (moved.deliverableIds.length === 0 && moved.submissionIds.length === 0) {
    return { ok: false, message: "That job has nothing owed to move." };
  }

  // ONE TRANSACTION. A half-merge — deliverables moved, cuts left behind — is
  // an orphaned cut pointing at a deliverable on another job, which no screen
  // in this codebase is built to render.
  await prisma.$transaction(async (tx) => {
    // Order matters only for readability; every row carries its own project id.
    await tx.deliverable.updateMany({ where: { id: { in: moved.deliverableIds } }, data: { projectId: intoId } });
    await tx.deliverableOutput.updateMany({ where: { id: { in: moved.outputIds } }, data: { projectId: intoId } });
    await tx.reviewSubmission.updateMany({ where: { id: { in: moved.submissionIds } }, data: { projectId: intoId } });
    await tx.smartTask.updateMany({ where: { id: { in: moved.taskIds } }, data: { projectId: intoId } });
    await tx.revisionBrief.updateMany({ where: { id: { in: moved.briefIds } }, data: { projectId: intoId } });
    await tx.topazJob.updateMany({ where: { id: { in: moved.topazIds } }, data: { projectId: intoId } });
    await tx.appSetting.upsert({
      where: { key: mergeKey(fromId) },
      create: { key: mergeKey(fromId), value: serializeMerge({ intoId, at: new Date(), by: actor, note: (note ?? "").trim().slice(0, 300) || null, moved, undoneAt: null, undoneBy: null }) },
      update: { value: serializeMerge({ intoId, at: new Date(), by: actor, note: (note ?? "").trim().slice(0, 300) || null, moved, undoneAt: null, undoneBy: null }) },
    });
  });

  // The per-video rows are minted from the SURVIVOR's cut slots, so they have
  // to be recomputed on both sides — the one that lost the work owes nothing
  // now, and the one that gained it owes more.
  try {
    const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
    await ensureOutputsSafely(intoId, `merge-from#${fromId}`);
    await ensureOutputsSafely(fromId, `merge-away#${intoId}`);
  } catch { /* the hourly sweep repairs it */ }

  const street = (t: string | null) => (t || "a job").split(",")[0].trim();
  const what = `${moved.deliverableIds.length} deliverable${moved.deliverableIds.length === 1 ? "" : "s"}${moved.submissionIds.length ? `, ${moved.submissionIds.length} cut${moved.submissionIds.length === 1 ? "" : "s"}` : ""}`;
  await Promise.all([
    prisma.activity.create({
      data: { projectId: fromId, type: "SYSTEM", body: `${actor} merged this job's work into ${street(into.title)} — ${what}. The order, the invoice, the shoot and the appointment stay here.${note ? ` "${note.trim().slice(0, 200)}"` : ""}`.slice(0, 500) },
    }).catch(() => {}),
    prisma.activity.create({
      data: { projectId: intoId, type: "SYSTEM", body: `${actor} merged ${street(from.title)}'s work into this job — ${what}. That job keeps its own order and invoice.${note ? ` "${note.trim().slice(0, 200)}"` : ""}`.slice(0, 500) },
    }).catch(() => {}),
  ]);

  revalidatePath("/editing");
  revalidatePath(`/projects/${fromId}`);
  revalidatePath(`/projects/${intoId}`);
  return { ok: true, message: `${what} moved to ${street(into.title)}. ${street(from.title)} keeps its order and invoice, and says where its work went.` };
}

/** Put a merged job's work back. */
export async function unmergeProjectWork(fromId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const actor = me?.name ?? me?.email ?? "The office";
  const { mergeKey, mergeFrom, serializeMerge } = await import("@/lib/projectMerge");

  const m = await mergeFrom(fromId);
  if (!m) return { ok: false, message: "That job's work isn't merged anywhere." };
  const moved = m.moved;

  // BY ID, not by shape. Anything created on the survivor SINCE the merge stays
  // on the survivor — only the rows this merge actually moved come back.
  await prisma.$transaction(async (tx) => {
    await tx.deliverable.updateMany({ where: { id: { in: moved.deliverableIds } }, data: { projectId: fromId } });
    await tx.deliverableOutput.updateMany({ where: { id: { in: moved.outputIds } }, data: { projectId: fromId } });
    await tx.reviewSubmission.updateMany({ where: { id: { in: moved.submissionIds } }, data: { projectId: fromId } });
    await tx.smartTask.updateMany({ where: { id: { in: moved.taskIds } }, data: { projectId: fromId } });
    await tx.revisionBrief.updateMany({ where: { id: { in: moved.briefIds } }, data: { projectId: fromId } });
    await tx.topazJob.updateMany({ where: { id: { in: moved.topazIds } }, data: { projectId: fromId } });
    await tx.appSetting.update({
      where: { key: mergeKey(fromId) },
      data: { value: serializeMerge({ ...m, undoneAt: new Date(), undoneBy: actor }) },
    });
  });

  try {
    const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
    await ensureOutputsSafely(fromId, `unmerge#${m.intoId}`);
    await ensureOutputsSafely(m.intoId, `unmerge-away#${fromId}`);
  } catch { /* the hourly sweep repairs it */ }

  const p = await prisma.project.findUnique({ where: { id: fromId }, select: { title: true } });
  const street = (p?.title || "that job").split(",")[0].trim();
  await prisma.activity.create({
    data: { projectId: fromId, type: "SYSTEM", body: `${actor} put this job's work back — it is no longer merged.`.slice(0, 500) },
  }).catch(() => {});

  revalidatePath("/editing");
  revalidatePath(`/projects/${fromId}`);
  revalidatePath(`/projects/${m.intoId}`);
  return { ok: true, message: `${street} has its work back.` };
}

/** The other jobs this one's work could merge into: the same client's, never
 *  cancelled, never already merged away. Newest shoot first — a second shoot
 *  almost always joins the listing's original job, which is the older one. */
export async function mergeCandidates(projectId: string): Promise<
  { id: string; street: string; status: string; shootISO: string | null; owes: number }[]
> {
  try {
    await requireAdmin();
  } catch {
    return [];
  }
  const me = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
  if (!me) return [];
  const rows = await prisma.project.findMany({
    where: { clientId: me.clientId, id: { not: projectId }, status: { not: "CANCELLED" } },
    select: {
      id: true, title: true, status: true, shootDate: true,
      _count: { select: { deliverables: { where: { removedFromOrderAt: null } } } },
    },
    orderBy: { shootDate: "desc" },
    take: 40,
  });
  const { allMerges } = await import("@/lib/projectMerge");
  const mergedAway = new Set((await allMerges()).filter((m) => !m.undoneAt).map((m) => m.fromId));
  return rows
    .filter((r) => !mergedAway.has(r.id))
    .map((r) => ({
      id: r.id,
      street: (r.title || "A job").split(",")[0].trim(),
      status: r.status,
      shootISO: r.shootDate?.toISOString() ?? null,
      owes: r._count.deliverables,
    }));
}

/** What a merge would move, for the dialog — read-only. */
export async function mergePreview(projectId: string): Promise<{ deliverables: number; cuts: number; cards: number; videos: number }> {
  try {
    await requireAdmin();
  } catch {
    return { deliverables: 0, cuts: 0, cards: 0, videos: 0 };
  }
  const { previewMerge } = await import("@/lib/projectMerge");
  const p = await previewMerge(projectId);
  return { deliverables: p.deliverableIds.length, cuts: p.submissionIds.length, cards: p.taskIds.length, videos: p.videos };
}
