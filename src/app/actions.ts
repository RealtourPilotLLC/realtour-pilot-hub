"use server";

import { requireAdmin, requireTaskAccess } from "@/lib/auth/guards";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import {
  ProjectStatus,
  Priority,
  ActivityType,
  DeliverableStatus,
} from "@prisma/client";
import { stageMeta } from "@/lib/pipeline";
import { Aryeo } from "@/lib/integrations/aryeo";
import { getSecret } from "@/lib/integrations/connections";
import { resolveRevision } from "@/lib/comms";
import { closeObsoleteTasks } from "@/lib/tasks";
import { etEndOfDay } from "@/lib/datetime";

export type ApptResult = { ok: boolean; message: string };

// Refresh one appointment from Aryeo into our DB (after a write).
async function refreshAppointment(aryeoId: string, projectId: string) {
  try {
    const a = await Aryeo.appointment(aryeoId);
    await prisma.appointment.update({
      where: { aryeoId },
      data: {
        startAt: a.start_at ? new Date(a.start_at) : null,
        endAt: a.end_at ? new Date(a.end_at) : null,
        status: a.status ?? null,
        canCancel: a.can_cancel ?? false,
        canReschedule: a.can_reschedule ?? false,
        rescheduledAt: a.rescheduled_at ? new Date(a.rescheduled_at) : null,
        previousStartAt: a.previous_start_at ? new Date(a.previous_start_at) : null,
        rawJson: JSON.stringify(a),
      },
    });
    // Keep the project's shoot date / status in sync with a scheduled appt.
    if ((a.status || "").toUpperCase() === "SCHEDULED" && a.start_at) {
      await prisma.project.update({ where: { id: projectId }, data: { shootDate: new Date(a.start_at) } });
    }
  } catch {
    /* best-effort */
  }
}

/** Reschedule an appointment in Aryeo, then refresh locally. */
export async function rescheduleAppointmentAction(
  appointmentId: string,
  startAtISO: string,
  notifyCustomer: boolean,
): Promise<ApptResult> {
  await requireAdmin();
  if (!(await getSecret("aryeo"))) return { ok: false, message: "Aryeo is not connected." };
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) return { ok: false, message: "Appointment not found." };
  if (!appt.canReschedule) return { ok: false, message: "Aryeo says this appointment can't be rescheduled." };

  const start = new Date(startAtISO);
  if (isNaN(start.getTime())) return { ok: false, message: "Invalid date/time." };
  const end = new Date(start.getTime() + (appt.durationMin ?? 60) * 60000);

  try {
    await Aryeo.rescheduleAppointment(appt.aryeoId, {
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      notify_customer: notifyCustomer,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Reschedule failed." };
  }

  await refreshAppointment(appt.aryeoId, appt.projectId);
  await prisma.activity.create({
    data: {
      projectId: appt.projectId,
      type: ActivityType.SYSTEM,
      body: `Appointment rescheduled to ${start.toLocaleString()}${notifyCustomer ? " (customer notified)" : ""}.`,
    },
  });
  revalidatePath(`/projects/${appt.projectId}`);
  revalidatePath("/schedule");
  revalidatePath("/pipeline");
  return { ok: true, message: "Appointment rescheduled." };
}

/** Cancel an appointment in Aryeo, then refresh locally. */
export async function cancelAppointmentAction(
  appointmentId: string,
  notifyCustomer: boolean,
): Promise<ApptResult> {
  await requireAdmin();
  if (!(await getSecret("aryeo"))) return { ok: false, message: "Aryeo is not connected." };
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) return { ok: false, message: "Appointment not found." };
  if (!appt.canCancel) return { ok: false, message: "Aryeo says this appointment can't be cancelled." };

  try {
    await Aryeo.cancelAppointment(appt.aryeoId, { notify_customer: notifyCustomer });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Cancel failed." };
  }

  await refreshAppointment(appt.aryeoId, appt.projectId);
  await prisma.activity.create({
    data: {
      projectId: appt.projectId,
      type: ActivityType.FLAG,
      body: `Appointment cancelled${notifyCustomer ? " (customer notified)" : ""}.`,
    },
  });
  revalidatePath(`/projects/${appt.projectId}`);
  revalidatePath("/schedule");
  revalidatePath("/pipeline");
  return { ok: true, message: "Appointment cancelled." };
}

/** Update a SmartTask's status (and stamp completion). */
const TASK_STATUSES = new Set([
  "OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR",
  "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED", "COMPLETED", "CANCELLED",
]);

export async function setSmartTaskStatus(taskId: string, status: string) {
  // Owner/admin, or the editor this task is delegated to — editors must be able
  // to complete their own queue work (audit crack #28).
  await requireTaskAccess(taskId);
  if (!TASK_STATUSES.has(status)) return; // never write a free-form status
  const updated = await prisma.smartTask.updateMany({
    where: { id: taskId },
    data: { status, completedAt: status === "COMPLETED" ? new Date() : null },
  });
  if (updated.count === 0) return; // task no longer exists — no-op instead of throw
  const t = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { projectId: true, taskType: true, checklist: true, assignedKey: true, dedupeKey: true, title: true, propertyAddress: true },
  });
  // Completing the QC card via the status button (not the checklist) must still
  // write the QcRecord — this was the third no-record completion path the July
  // 2026 audit found (30 deliveries, 0 QcRecords, owner quality dial empty).
  if (status === "COMPLETED" && t?.taskType === "media_qa" && t.projectId) {
    try {
      const { recordQcCompletion } = await import("@/lib/tasks");
      const { parseChecklist } = await import("@/lib/checklist");
      const seg = await prisma.project.findUnique({
        where: { id: t.projectId },
        select: { client: { select: { segment: true } } },
      });
      await recordQcCompletion({
        projectId: t.projectId,
        items: parseChecklist(t.checklist),
        clientSegment: seg?.client?.segment ?? null,
        completedBy: t.assignedKey ?? "kyle",
      });
    } catch { /* analytics only — never block the completion */ }
  }
  // Completing a revision task from the queue (Kyle's habit) must ALSO clear the
  // project's revision flag — only the project-page button called resolveRevision,
  // so the hourly sync re-pinned the job as REVISION forever (audit crack #10).
  // resolveRevision also returns the job to DELIVERED and closes its now-moot
  // re-QC / delivery tasks.
  if (status === "COMPLETED" && t?.taskType === "revision" && t.projectId) {
    await resolveRevision(t.projectId);
    revalidatePath("/pipeline");
    revalidatePath("/");
  }
  // Closing an @mention companion task rings the TAGGER's bell (bell-only —
  // "mention_done" is deliberately not in SMS_KINDS): the loop that opened with
  // "@James check this" closes with "James finished your tag".
  if (status === "COMPLETED" && t?.dedupeKey?.startsWith("mention-")) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      const { getCurrentUser } = await import("@/lib/auth/user");
      const u = await getCurrentUser();
      const completer = (u?.name ?? "They").split(/\s+/)[0];
      const street = t.propertyAddress?.split(",")[0]?.trim() ?? t.title.split("—").pop()?.trim() ?? "a job";
      const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
      // The tagger's name is embedded in the title ("<author> tagged you — …");
      // an exact roster match adds their personal row on top of the desk row.
      const author = t.title.split(" tagged you")[0]?.trim();
      if (author) {
        const tagger = await prisma.teamMember.findFirst({ where: { name: author, active: true }, select: { id: true } });
        if (tagger) targets.push({ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${tagger.id}` });
      }
      await notifyInApp({
        kind: "mention_done",
        title: `${completer} finished your tag — ${street}`,
        href: t.projectId ? `/projects/${t.projectId}` : "/tasks",
        targets,
        // Minute-bucketed: a re-tagged task completes again later and must
        // ring again (the companion task deliberately reopens under ONE
        // dedupeKey, so a taskId-only key would silence every round but the
        // first); double-submits within the same minute still collapse.
        dedupeKey: `mention-done-${taskId}-${new Date().toISOString().slice(0, 16)}`,
      });
    } catch { /* the close itself must never fail on a ping */ }
  }
  revalidatePath("/queue");
  revalidatePath("/history");
  // Photographers complete their assigned tasks from the My Shoots card.
  revalidatePath("/shoot");
  if (t?.projectId) revalidatePath(`/projects/${t.projectId}`);
}

// Add a to-do by hand from the Daily Tasks page. Optional: link to a job/client
// (matched by address then client name), a due date, a priority, and delegate it
// to an editor. Lands in "Needs you → Replies & admin" unless delegated.
export async function createManualTask(input: {
  title: string;
  notes?: string;
  link?: string;
  dueDate?: string; // YYYY-MM-DD (Eastern)
  priority?: string;
  assignedKey?: string;
}): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const title = (input.title || "").trim();
  if (!title) return { ok: false, message: "Give the task a title." };

  // Optional link → a project (by address) or, failing that, a client (by name).
  let projectId: string | null = null, clientId: string | null = null, propertyAddress: string | null = null;
  const link = (input.link || "").trim();
  if (link) {
    const p = await prisma.project.findFirst({
      where: { title: { contains: link, mode: "insensitive" }, status: { not: "CANCELLED" } },
      orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }],
      select: { id: true, title: true, clientId: true },
    });
    if (p) { projectId = p.id; clientId = p.clientId; propertyAddress = p.title; }
    else {
      const c = await prisma.client.findFirst({ where: { name: { contains: link, mode: "insensitive" } }, select: { id: true } });
      if (c) clientId = c.id;
    }
  }

  const priIn = (input.priority || "MEDIUM").toUpperCase();
  const priority = ["URGENT", "HIGH", "MEDIUM", "LOW"].includes(priIn) ? priIn : "MEDIUM";

  const { listAssignees } = await import("@/lib/assignees");
  const validKeys = new Set((await listAssignees()).map((a) => a.key));
  const ak = input.assignedKey;
  const assignedKey = ak && ak !== "kyle" && validKeys.has(ak) ? ak : null;

  let dueAt: Date | null = null;
  const dd = (input.dueDate || "").trim();
  // 5pm ET on that day. A literal -04:00 is only right for eight months of
  // the year; in winter it silently becomes a 4pm deadline.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dd)) dueAt = etEndOfDay(dd);

  const notes = input.notes?.trim() || null;
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } });
  await prisma.smartTask.create({
    data: {
      taskType: "todo",
      title: title.slice(0, 140),
      summary: notes,
      description: notes,
      reasonCreated: "Added by hand",
      source: "manual",
      priority,
      dueAt,
      assignedKey,
      projectId,
      clientId,
      propertyAddress,
      ownerId: kyle?.id ?? null,
    },
  });
  revalidatePath("/queue");
  revalidatePath("/");
  return { ok: true, message: "Task added." };
}

// Delegate a task to an editor (or clear it back to "Needs you"). Pass "" / "kyle"
// to un-delegate. Keys validated against the editor roster (src/lib/editors.ts).
export async function setTaskAssignee(taskId: string, key: string) {
  // Owner/admin, or the editor this task is currently assigned to (so an editor
  // can hand a task back to Kyle) — audit crack #28.
  await requireTaskAccess(taskId);
  const { listAssignees, slugForName } = await import("@/lib/assignees");
  const validKeys = new Set((await listAssignees()).map((a) => a.key));
  const assignedKey = key && validKeys.has(key) ? key : null;
  const prev = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { assignedKey: true } });
  const t = await prisma.smartTask.update({
    where: { id: taskId },
    data: { assignedKey },
    select: { projectId: true, title: true },
  });
  // Work must never move onto someone's plate SILENTLY (audit critical: tasks
  // assigned to Jordan/photographers vanished with no ping). Editors get their
  // channel row; everyone else a person-addressed bell (photographers also get
  // the SMS bridge via the task_assigned kind). Vendors have no channel — the
  // human dispatch task is the handoff there.
  if (assignedKey && assignedKey !== prev?.assignedKey && assignedKey !== "kyle") {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      const { TEAM_MEMBER_EDITOR_KEYS } = await import("@/lib/editors");
      const VENDOR_KEYS = new Set(["luma", "autohdr", "cubicasa"]);
      const title = `Task for you — ${t.title}`.slice(0, 90);
      if ((TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(assignedKey)) {
        await notifyInApp({
          kind: "edit_assigned",
          title,
          href: t.projectId ? `/edit/${t.projectId}` : "/tasks",
          targets: [{ roles: ["EDITOR"], userKey: `editor:${assignedKey}`, href: t.projectId ? `/edit/${t.projectId}` : "/tasks" }],
          dedupeKey: `assign-${taskId}-${assignedKey}`,
        });
      } else if (!VENDOR_KEYS.has(assignedKey)) {
        const members = await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true, role: true } });
        const m = members.find((x) => slugForName(x.name) === assignedKey);
        if (m) {
          const href =
            m.role === "PHOTOGRAPHER"
              ? t.projectId ? `/shoot/${t.projectId}` : "/shoot"
              : t.projectId ? `/projects/${t.projectId}` : "/tasks?tab=board";
          await notifyInApp({
            kind: "task_assigned",
            title,
            href,
            // PHOTOGRAPHER in the audience arms the SMS bridge — only actual
            // photographers should be texted; Jordan/admins get the bell.
            targets: [
              {
                roles: m.role === "PHOTOGRAPHER" ? ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"] : ["OWNER", "ADMIN", "EDITOR"],
                userKey: `tm:${m.id}`,
                href,
              },
            ],
            dedupeKey: `assign-${taskId}-${assignedKey}`,
          });
        }
      }
    } catch { /* notification is best-effort — the assignment itself stands */ }
  }
  revalidatePath("/queue");
  if (t.projectId) revalidatePath(`/projects/${t.projectId}`);
}

/**
 * Toggle one checklist item on a task. Low-friction completion: when every item
 * is checked the task auto-completes; unchecking an item on a completed task
 * reopens it. Returns the new checklist + whether the task is now complete.
 */
export async function toggleTaskChecklistItem(
  taskId: string,
  index: number,
): Promise<{ ok: boolean; items: { label: string; done: boolean }[]; completed: boolean }> {
  await requireAdmin();
  const { parseChecklist, serializeChecklist, checklistComplete } = await import("@/lib/checklist");
  const t = await prisma.smartTask.findUnique({
    where: { id: taskId },
    // taskType/assignedKey + the client's segment let us log a QcRecord when a
    // media_qa card completes via ticking (the owner's quality dial).
    select: { checklist: true, status: true, projectId: true, taskType: true, assignedKey: true, client: { select: { segment: true } } },
  });
  if (!t) return { ok: false, items: [], completed: false };
  const items = parseChecklist(t.checklist);
  if (index < 0 || index >= items.length) return { ok: false, items, completed: false };
  items[index] = { ...items[index], done: !items[index].done };
  const completed = checklistComplete(items);
  // Log a QC pass when this tick is the one that finishes a media_qa card (and it
  // wasn't already complete). recordQcCompletion snapshots the ticks, counts the
  // misses, and is deduped/best-effort so it can't double-write vs the reconciler
  // or break completion.
  if (completed && t.status !== "COMPLETED" && t.taskType === "media_qa" && t.projectId) {
    try {
      const { recordQcCompletion } = await import("@/lib/tasks");
      await recordQcCompletion({
        projectId: t.projectId,
        items,
        clientSegment: t.client?.segment ?? null,
        completedBy: t.assignedKey ?? "kyle",
      });
    } catch { /* dial is analytics-only — never block the tick */ }
  }
  await prisma.smartTask.update({
    where: { id: taskId },
    data: {
      checklist: serializeChecklist(items),
      // All boxes ticked → done. If they uncheck one on a completed task, reopen.
      ...(completed
        ? { status: "COMPLETED", completedAt: new Date() }
        : t.status === "COMPLETED"
          ? { status: "OPEN", completedAt: null }
          : {}),
    },
  });
  // Ticking the last step of a REVISION task ("Mark the revision resolved") is
  // a completion — it must run the same side effects as the Complete button,
  // or the project stays pinned in REVISION with its re-QC card frozen open
  // and the editor never gets the resolved ping.
  if (completed && t.status !== "COMPLETED" && t.taskType === "revision" && t.projectId) {
    await resolveRevision(t.projectId);
    revalidatePath("/pipeline");
    revalidatePath("/");
  }
  revalidatePath("/queue");
  revalidatePath("/history");
  revalidatePath("/tasks");
  if (t.projectId) revalidatePath(`/projects/${t.projectId}`);
  return { ok: true, items, completed };
}

/** Assign (or clear) a team member for a role on a project. */
export async function assignMember(
  projectId: string,
  role: "photographer" | "editor" | "va",
  memberId: string | null,
) {
  await requireAdmin();
  const field = role === "photographer" ? "photographerId" : role === "editor" ? "editorId" : "vaId";
  const [member, project] = await Promise.all([
    memberId ? prisma.teamMember.findUnique({ where: { id: memberId } }) : null,
    prisma.project.findUnique({ where: { id: projectId }, select: { source: true } }),
  ]);
  await prisma.project.update({
    where: { id: projectId },
    data: {
      [field]: memberId,
      // Tug-of-war guard: on Aryeo jobs the hourly sync auto-fills photographerId
      // from the appointment assignee, silently reverting any hand assignment
      // within the hour. The flag tells the sync a human chose this photographer;
      // clearing the assignment hands control back to Aryeo.
      ...(role === "photographer" && project?.source === "ARYEO"
        ? { photographerManual: memberId != null }
        : {}),
    },
  });
  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.ASSIGNMENT,
      body: member ? `${role[0].toUpperCase() + role.slice(1)} set to ${member.name}.` : `${role} unassigned.`,
    },
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/schedule");
}

/**
 * Set (or clear) a project's photo-culling budget. `null` restores the computed
 * default (50, or 80 for homes >= 3500 sq ft). The budget drives the field guide,
 * the upload chip, the cull task, and Kyle's deliver guardrail — so the owner can
 * override it per home (e.g. an unusually photogenic estate that warrants more).
 */
export async function setPhotoTarget(projectId: string, target: number | null) {
  await requireAdmin();
  // Clamp to a sane range so a fat-fingered value can't mint absurd budgets.
  const value = target == null ? null : Math.max(1, Math.min(500, Math.round(target)));
  await prisma.project.update({ where: { id: projectId }, data: { photoTarget: value } });
  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.SYSTEM,
      body: value == null ? "Photo budget reset to the automatic default." : `Photo budget set to ${value} photos.`,
    },
  });
  revalidatePath(`/projects/${projectId}`);
}

/** Move a project to a new pipeline stage and log it on the timeline. */
export async function moveProjectStatus(projectId: string, status: ProjectStatus) {
  await requireAdmin();
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.status === status) return;

  await prisma.project.update({
    where: { id: projectId },
    data: {
      status,
      deliveredAt:
        status === ProjectStatus.DELIVERED ? new Date() : project.deliveredAt,
      // Moving a job to Delivered clears any open revision request.
      ...(status === ProjectStatus.DELIVERED
        ? { revisionRequestedAt: null, revisionNote: null }
        : {}),
    },
  });

  // Close out the revision task too when manually delivered.
  if (status === ProjectStatus.DELIVERED && project.revisionRequestedAt) {
    await prisma.smartTask.updateMany({
      where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  }

  // Clear obsolete production tasks when a job is delivered or cancelled.
  if (status === ProjectStatus.DELIVERED || status === ProjectStatus.CANCELLED) {
    await closeObsoleteTasks(projectId, status);
  }

  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.STATUS_CHANGE,
      body: `Moved from ${stageMeta(project.status).label} to ${stageMeta(status).label}.`,
    },
  });

  revalidatePath("/pipeline");
  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`);
}

// Draft a client reply in Jordan's voice for a comm task. DRAFT ONLY — returns
// the suggested text for a human to review and send; the hub never sends.
export async function draftTaskReply(
  taskId: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  await requireAdmin();
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) {
    return { ok: false, error: "Connect the AI Assistant in Connections first." };
  }
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    include: {
      client: {
        select: {
          name: true, segment: true, socialClient: true, socialPlan: true,
          projects: { orderBy: { orderedAt: { sort: "desc", nulls: "last" } }, take: 6, select: { title: true, status: true } },
        },
      },
    },
  });
  if (!task) return { ok: false, error: "Task not found." };

  const channel = task.source === "gmail" ? "email" : "text";
  const message = task.description || task.title;

  try {
    // Read the actual back-and-forth (OpenPhone + Gmail + Slack all land in
    // CommLog) so the draft answers the real conversation, not just the task line.
    type Turn = { role: "client" | "us"; text: string; at?: string | null; sender?: string | null };
    let transcript: Turn[] = [];
    if (task.clientId) {
      const comms = await prisma.commLog.findMany({
        where: { clientId: task.clientId },
        orderBy: { occurredAt: "desc" },
        take: 16,
        select: { direction: true, body: true, subject: true, occurredAt: true, contactName: true },
      });
      transcript = comms.reverse().map((c) => ({
        role: c.direction === "out" ? ("us" as const) : ("client" as const),
        text: [c.subject, c.body].filter(Boolean).join("\n").slice(0, 600),
        at: c.occurredAt ? c.occurredAt.toISOString() : null,
        sender: c.direction === "out" ? null : c.contactName || task.client?.name || null,
      }));
    }
    // Make sure there's a client turn to answer (leads / sparse threads).
    if (!transcript.some((t) => t.role === "client")) {
      transcript.push({ role: "client", text: message, at: null, sender: task.client?.name ?? null });
    }

    // If they're asking about scheduling, pull REAL open dates from Aryeo so the
    // draft offers actual openings instead of inventing them.
    let availability: string | null = null;
    const askText = `${message} ${transcript.filter((t) => t.role === "client").map((t) => t.text).join(" ")}`;
    if (/\b(availab|when can|what (day|days|time|times)|schedul|book|come out|opening|calendar|times? work|soonest|reschedul)\b/i.test(askText)) {
      try {
        const { getSchedulingAvailability } = await import("@/lib/integrations/aryeo");
        const { etDate } = await import("@/lib/datetime");
        const slots = await getSchedulingAvailability({ limit: 6 });
        if (slots?.length) availability = slots.map((s) => etDate(new Date(`${s.date}T12:00:00Z`))).join(", ");
      } catch { /* draft without availability */ }
    }

    // Our taught policies (fees, weather/drone, scheduling) so the reply follows
    // them and never promises something against policy (e.g. a free weather return).
    const { relevantPolicies } = await import("@/lib/policies");
    const policies = await relevantPolicies(askText);

    const { draftReplyWithContext } = await import("@/lib/integrations/ai");
    const text = await draftReplyWithContext({
      channel,
      clientName: task.client?.name ?? null,
      segment: task.client?.segment ?? null,
      socialPlan: task.client?.socialClient ? (task.client?.socialPlan ?? "yes") : null,
      propertyAddress: task.propertyAddress,
      projects: task.client?.projects ?? [],
      transcript,
      availability,
      policies,
      note: task.reasonCreated,
    });
    if (/^\s*NO_REPLY_NEEDED\s*$/i.test(text)) {
      return { ok: false, error: "This thread looks handled — nothing new to reply to. Write a note if you still want to reach out." };
    }
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Draft failed." };
  }
}

// Send the smart delivery text (what was delivered + what's still in production)
// to the client via OpenPhone. Human-initiated from a delivery_text to-do.
export async function sendDeliveryText(taskId: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const task = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!task?.projectId) return { ok: false, message: "No project linked to this task." };
  const project = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: { id: true, title: true, statusEvidence: true, client: { select: { name: true, phone: true } } },
  });
  if (!project) return { ok: false, message: "Project not found." };
  if (!project.client.phone) return { ok: false, message: "No phone number on file for this client." };

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  const { deliveryMessage } = await import("@/lib/delivery");
  const body = deliveryMessage(project);
  try {
    await OpenPhone.sendMessage(from, `+1${k}`, body);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `Delivery text sent to ${project.client.name}: ${body.slice(0, 160)}` },
  });
  await prisma.smartTask.update({ where: { id: taskId }, data: { status: "COMPLETED", completedAt: new Date() } });
  revalidatePath("/");
  revalidatePath("/queue");
  revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: "Delivery text sent." };
}

// Send the day-before confirmation text to the client via OpenPhone.
// Human-initiated from a confirmation_text to-do. Sends the freshly-rendered
// message (so the shoot time/photographer are current), logs it, and completes
// the task.
export async function sendConfirmationText(taskId: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const task = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!task?.projectId) return { ok: false, message: "No project linked to this task." };
  const project = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: {
      id: true, title: true, shootDate: true,
      client: { select: { name: true, phone: true } },
      photographer: { select: { name: true } },
      deliverables: { select: { type: true } },
    },
  });
  if (!project) return { ok: false, message: "Project not found." };
  if (!project.client.phone) return { ok: false, message: "No phone number on file for this client." };

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  const { confirmationMessage } = await import("@/lib/delivery");
  const body = confirmationMessage({
    title: project.title,
    shootDate: project.shootDate,
    client: { name: project.client.name },
    photographer: project.photographer,
    deliverables: project.deliverables,
  });
  try {
    await OpenPhone.sendMessage(from, `+1${k}`, body);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `Confirmation text sent to ${project.client.name}: ${body.slice(0, 160)}` },
  });
  await prisma.smartTask.update({ where: { id: taskId }, data: { status: "COMPLETED", completedAt: new Date() } });
  revalidatePath("/");
  revalidatePath("/queue");
  revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: "Confirmation text sent." };
}

// Mark a revision request resolved (handled or dismissed as a false alarm).
export async function resolveRevisionAction(projectId: string) {
  await requireAdmin();
  await resolveRevision(projectId);
  revalidatePath("/pipeline");
  revalidatePath("/queue");
  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`);
}

export async function toggleChecklistItem(itemId: string, done: boolean) {
  await requireAdmin();
  const item = await prisma.checklistItem.update({
    where: { id: itemId },
    data: { done },
  });
  revalidatePath(`/projects/${item.projectId}`);
  revalidatePath("/pipeline");
}

export async function addNote(
  projectId: string,
  body: string,
  type: ActivityType = ActivityType.NOTE,
) {
  await requireAdmin();
  const trimmed = body.trim();
  if (!trimmed) return;
  await prisma.activity.create({
    data: { projectId, body: trimmed, type },
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function setProjectPriority(projectId: string, priority: Priority) {
  await requireAdmin();
  await prisma.project.update({ where: { id: projectId }, data: { priority } });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
}

export async function assignTeamMember(
  projectId: string,
  field: "photographerId" | "editorId" | "vaId",
  memberId: string | null,
) {
  await requireAdmin();
  await prisma.project.update({
    where: { id: projectId },
    data: { [field]: memberId },
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
}

export async function setDeliverableStatus(
  deliverableId: string,
  status: DeliverableStatus,
) {
  await requireAdmin();
  const d = await prisma.deliverable.update({
    where: { id: deliverableId },
    data: { status },
  });
  revalidatePath(`/projects/${d.projectId}`);
}

// Re-run the smart status cross-check for ONE project, on demand. Kyle fixes a
// missing deliverable and the red flag kept screaming for up to an hour — the
// only manual re-check lived on the owner-only Connections page (audit crack
// #41). Admin-or-owner; the owner-wide Connections recompute stays owner-only.
export async function recheckProjectStatus(
  projectId: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  try {
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    const r = await syncProjectStatuses({ projectId });
    // Refresh the project's tasks too, so a now-complete category retires its
    // QC/delivery work at the same moment the flag clears.
    const { generateTasksForProject } = await import("@/lib/tasks");
    await generateTasksForProject(projectId);
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/pipeline");
    revalidatePath("/queue");
    revalidatePath("/");
    return {
      ok: true,
      message: r.changed > 0 ? "Re-checked — status updated." : "Re-checked — no change.",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Re-check failed." };
  }
}
