"use server";

import { requireAdmin, requireTaskAccess } from "@/lib/auth/guards";
import { deliveryStamp, outstandingForDelivery } from "@/lib/delivery";
import { owedPhrase } from "@/lib/statusEvidence";
import { appBase } from "@/lib/appUrl";

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
import { noteRevisionLanesClosed, resolveRevisionForTask, resolveRevisionWholeJob } from "@/lib/comms";
import { closeObsoleteTasks, CLOSED_BY_HAND, qcGateComplete, reopenedForCategories, qcCategoryOfRow } from "@/lib/tasks";
import { etEndOfDay } from "@/lib/datetime";
import { DISMISS_REASONS, DISMISSED_PREFIX, type DismissReason } from "@/lib/triage";

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

// Comms Checklist manual tick (Jordan, Sep 1): "handled it outside the hub"
// — completes the silent client_reply task for that client (creating a
// completed one when none exists), which the unanswered walks already honor.
//
// Sep 16 (Kyle: "there's no way to get rid of things I've already dealt
// with"): the tick now also works on a thread with NO client record — an
// unmatched number, a teammate's status text, a spam blast — by writing the
// thread-scoped cut the walk reads (replyQueue.ts threadAckKey). One call,
// three shapes:
//   markCommsHandled(clientId)                              — the client tick
//   markCommsHandled(clientId, "email", groupKey)           — one sender group
//   markCommsHandled(null, "phone", undefined, {            — any thread
//       threadKey: "p:6105550100", reason: "spam" })
// "spam" additionally MUTES the number so the same blaster doesn't need a tick
// a day. A teammate's number can never be muted — their texts are how the
// field talks to the office.
export async function markCommsHandled(
  clientId: string | null,
  family: "phone" | "email" = "phone",
  groupKey?: string,
  opts: { threadKey?: string | null; reason?: string | null } = {},
): Promise<{ ok: boolean; message?: string }> {
  const { requireAdmin } = await import("@/lib/auth/guards");
  try { await requireAdmin(); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Admins only." }; }
  const reason = (opts.reason ?? "").trim() || null;
  const threadKey = (opts.threadKey ?? "").trim() || null;

  // --- the thread-scoped cut: the exit every row now has ---------------------
  if (threadKey) {
    const { threadAckKey, commsMuteKey, ackValue } = await import("@/lib/replyQueue");
    const at = new Date();
    const key = threadAckKey(family, threadKey);
    const value = ackValue(at, reason);
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    if (reason === "spam") {
      const phone = threadKey.startsWith("p:") ? threadKey.slice(2) : null;
      if (phone && phone.length === 10) {
        // NEVER mute our own people. Harrison's "Photos uploaded" is a status
        // text, not spam, and a muted photographer is a silent field.
        const { phoneKey } = await import("@/lib/integrations/openphone");
        const team = await prisma.teamMember.findMany({ select: { phone: true } });
        if (team.some((t) => phoneKey(t.phone) === phone)) {
          revalidatePath("/communications");
          return { ok: true, message: "Cleared — but that's one of our own numbers, so it wasn't muted." };
        }
        const mk = commsMuteKey(phone);
        await prisma.appSetting.upsert({ where: { key: mk }, create: { key: mk, value }, update: { value } });
      }
    }
    // A client's own thread carries BOTH: the ack above (so the row goes
    // whether or not a reply task ever existed) and the task close below (so
    // the home's Open Loops and the pager clear with it).
    if (!clientId) {
      revalidatePath("/communications");
      revalidatePath("/tasks");
      revalidatePath("/ops");
      revalidatePath("/");
      return { ok: true };
    }
  }
  if (!clientId) return { ok: false, message: "Nothing to clear — no conversation was named." };

  if (family === "email") {
    // Email keeps its OWN ack marker — completing client_reply here would also
    // silence the phone board for a client who still owes a text reply. The
    // marker is scoped to the SENDER GROUP (review: two senders mis-filed
    // under one client record must never share one tick).
    const { emailAckKey } = await import("@/lib/commsBoard");
    const key = groupKey ? emailAckKey(clientId, groupKey) : `comms-ack-email-${clientId}`;
    const value = new Date().toISOString();
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    // The tick used to leave the gmail-born client_reply open until the 5-minute
    // Gmail sync noticed the ack (Marcee's 54-day reply task; audit, Sep 8).
    // Close only THIS sender group's gmail tasks — the phone branch below
    // deliberately excludes source "gmail", this is its mirror.
    const wasOpen = await prisma.smartTask.findMany({
      where: { clientId, taskType: "client_reply", source: "gmail", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    try {
      const { completeEmailReplyTasks } = await import("@/lib/integrations/google");
      await completeEmailReplyTasks(clientId, groupKey ?? null);
    } catch { /* the Gmail sync remains the backstop */ }
    // The tick is a person's close — stamp whichever of those rows it completed.
    if (wasOpen.length > 0) {
      const nowDone = await prisma.smartTask.findMany({ where: { id: { in: wasOpen.map((t) => t.id) }, status: "COMPLETED" }, select: { id: true } });
      const { getCurrentUser } = await import("@/lib/auth/user");
      const { stampHandledByHand } = await import("@/lib/opsDay");
      const me = await getCurrentUser().catch(() => null);
      for (const t of nowDone) await stampHandledByHand(t.id, me?.name ?? null, me?.email ?? null);
    }
  } else {
    // THE TICK RESOLVES WHAT THE PERSON WAS LOOKING AT (F10, Sep 20).
    //
    // It used to complete EVERY open client_reply on the record. That is right
    // for the usual shape — one client, one request, one conversation — and
    // wrong the moment a client has two properties running: on Sep 18 Renee
    // Ryan held "Check with editor on Church St ETA" (358 N Church St) and
    // "Apply credit for skipped aerial shots at Cardigan" (453 Cardigan
    // Terrace), and one tick on one card would have closed both, including the
    // one whose messages a later reply had already cleared off that card.
    // Nobody can decide about a question that was not on the screen.
    //
    // Four shapes, in order:
    //   · the card names its request (`c:<clientId>#<taskId>`, the per-request
    //     row the ledger now emits) and that request is open — close exactly
    //     that one;
    //   · the card names a request that somebody else has already closed — the
    //     tick has nothing to do. Say so and close NOTHING: falling through to
    //     the client-wide rule here would complete a DIFFERENT property's
    //     request on a click aimed at this one, which is the whole defect
    //     wearing a stale page as a disguise;
    //   · the client has one open request — close it, exactly as before;
    //   · the client has several — close the ones the conversation could be
    //     about and leave the rest standing, then cut the conversation itself
    //     so the row still clears. Gmail-born requests are excluded throughout:
    //     a phone tick answers texts, not email (review).
    // Still-open requests are named in the return message so the tick never
    // silently keeps work alive.
    const { requestTaskIdFrom, requestsOffThread, threadAckKey, ackValue } = await import("@/lib/replyQueue");
    const openRows = await prisma.smartTask.findMany({
      where: { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] }, source: { not: "gmail" } },
      select: { id: true, title: true, propertyAddress: true },
    });
    const named = requestTaskIdFrom(groupKey) ?? requestTaskIdFrom(threadKey);
    const onOneRequest = !!named && openRows.some((t) => t.id === named);
    if (named && !onOneRequest) {
      revalidatePath("/tasks");
      revalidatePath("/ops");
      revalidatePath("/communications");
      revalidatePath("/");
      return { ok: true, message: "That one was already handled, so nothing changed. Refresh and the row will be gone." };
    }
    let openIds = openRows.map((t) => t.id);
    let kept: { id: string; title: string; propertyAddress: string | null }[] = [];
    if (onOneRequest) {
      openIds = [named as string];
      kept = openRows.filter((t) => t.id !== named);
    } else if (openRows.length > 1) {
      // A request we replied around rather than replied to: its message sits
      // before our last text, so the card being ticked cannot have shown it.
      const offThread = new Set((await requestsOffThread(clientId)).map((r) => r.taskId));
      kept = openRows.filter((t) => offThread.has(t.id));
      openIds = openRows.filter((t) => !offThread.has(t.id)).map((t) => t.id);
    }
    const done = await prisma.smartTask.updateMany({
      where: { id: { in: openIds } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (openIds.length > 0) {
      // A person's tick — leave the trace "handled today" counts (audit, Sep 8).
      const { getCurrentUser } = await import("@/lib/auth/user");
      const { stampHandledByHand } = await import("@/lib/opsDay");
      const me = await getCurrentUser().catch(() => null);
      for (const id of openIds) await stampHandledByHand(id, me?.name ?? null, me?.email ?? null);
    }
    // A TICK THAT CLOSED NOTHING IS STILL A DECISION, and it always left this
    // row behind so "handled today" and the audit trail could see it. The
    // early return added on Sep 20 skipped straight past it, so a tick on a
    // client whose every open request was off the card left no trace at all
    // except an AppSetting — a person made a call and nothing recorded it.
    if (done.count === 0) {
      await prisma.smartTask.create({
        data: {
          taskType: "client_reply", title: "Client reply — handled outside the hub",
          summary: "Marked handled from the Comms Checklist.",
          reasonCreated: "Manual tick on the Comms Checklist.",
          source: "manual", status: "COMPLETED", completedAt: new Date(), clientId,
        },
      });
    }
    if (kept.length > 0) {
      // A tick on the CONVERSATION also has to clear the conversation, or it
      // looks broken when the request it closed was not the only one. It used
      // to ride on the closed task's own completedAt, which the live walk reads
      // as a client-wide cut — and that cut now stands down while the client
      // still has a request open (replyQueue), precisely so one property's row
      // cannot silence another property's message. So the tick says it plainly
      // instead, on the conversation's own ack key.
      //
      // It is only ever a CUT POINT, at the moment of the click: a message that
      // arrives after it is waiting again, and the requests left standing above
      // carry their own rows, which this does not reach (openObligations). A
      // tick on ONE REQUEST'S row writes nothing here — it was not a decision
      // about the messages on screen.
      if (!onOneRequest) {
        const key = threadAckKey("phone", `c:${clientId}`);
        const value = ackValue(new Date(), reason ?? "answered elsewhere");
        await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
      revalidatePath("/tasks");
      revalidatePath("/ops");
      revalidatePath("/communications");
      revalidatePath("/");
      const names = kept.map((t) => t.propertyAddress?.split(",")[0] || t.title).join(", ");
      return {
        ok: true,
        message:
          kept.length === 1
            ? `Cleared. One request is still open on ${names}, so it stays on the list until someone answers it.`
            : `Cleared. ${kept.length} requests are still open (${names}), so they stay on the list until someone answers them.`,
      };
    }
  }
  revalidatePath("/tasks");
  revalidatePath("/ops");
  revalidatePath("/communications");
  revalidatePath("/");
  return { ok: true };
}

/** Un-mute a number marked spam — the fold on the Replies tab. The mute was
 *  only ever an AppSetting row, so lifting it brings the conversation straight
 *  back (nothing was deleted to restore). */
export async function unmuteCommsNumber(phone: string): Promise<{ ok: boolean; message?: string }> {
  const { requireAdmin } = await import("@/lib/auth/guards");
  try { await requireAdmin(); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Admins only." }; }
  const key = (phone ?? "").replace(/\D/g, "").slice(-10);
  if (key.length !== 10) return { ok: false, message: "That doesn't look like a number." };
  const { commsMuteKey } = await import("@/lib/replyQueue");
  await prisma.appSetting.deleteMany({ where: { key: commsMuteKey(key) } });
  revalidatePath("/communications");
  revalidatePath("/");
  return { ok: true };
}

/** The muted list, for the Replies tab's fold. Read on demand (a click), so
 *  the page costs nothing when nobody has muted anything. */
export async function listMutedNumbers(): Promise<{ phone: string; since: string; reason: string | null }[]> {
  const { requireAdmin } = await import("@/lib/auth/guards");
  try { await requireAdmin(); } catch { return []; }
  const { mutedNumbers } = await import("@/lib/replyQueue");
  return mutedNumbers();
}

// ---------------------------------------------------------------------------
// "NOT NEEDED" — one dismissal, with a reason, on every task surface.
//
// Kyle's call (Sep 16): several rows describe work already done, and the only
// control that made them go away was the status dropdown's raw "cancelled",
// which recorded nothing. A cancelled row then vanished from every list (the
// Done tab listed COMPLETED only), so "I dealt with it" and "the 7-day sweep
// ate it" looked identical afterwards.
//
// A dismissal is now: CANCELLED + a summary that says who and why + the
// by-hand stamp (so "things handled today" counts it) + a line on the job's
// timeline. Nothing is deleted, and the Done tab shows it under "Dismissed".
// ---------------------------------------------------------------------------

// The reasons, the stamp prefix and its readers live in src/lib/triage.ts —
// a "use server" module may only export async functions, and the Done tab and
// the janitor need the same vocabulary.
export async function dismissTask(
  taskId: string,
  reason: DismissReason | string,
  duplicateOfId?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await requireTaskAccess(taskId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "No access." };
  }
  const base = (DISMISS_REASONS as readonly string[]).includes(reason) ? reason : "not needed";
  // "Duplicate" without the row it duplicates is a dead end — a month later
  // nobody can tell whether the work happened on the other row or nowhere. So
  // the id is required AND checked: a typo must fail loudly here rather than
  // be written onto the record as a reason that points at nothing (review).
  let why = base;
  if (base === "duplicate") {
    const other = duplicateOfId?.trim()
      ? await prisma.smartTask.findUnique({ where: { id: duplicateOfId.trim() }, select: { id: true } }).catch(() => null)
      : null;
    if (!other) return { ok: false, message: "I can’t find that row — paste the link from the task this duplicates." };
    if (other.id === taskId) return { ok: false, message: "That’s this same row." };
    why = `duplicate of ${other.id}`;
  }
  const t = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, status: true, summary: true, projectId: true, taskType: true },
  });
  if (!t) return { ok: false, message: "That task no longer exists." };
  if (t.status === "CANCELLED") return { ok: true, message: "Already dismissed." };
  // A row that was genuinely COMPLETED keeps its completion. Re-labelling it
  // as dismissed would null its completedAt and quietly remove it from every
  // "what got done" count — the opposite of the point.
  if (t.status === "COMPLETED") return { ok: true, message: "Already done — nothing to dismiss." };

  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? me?.email ?? "").trim() || "the office";
  const stamp = `${DISMISSED_PREFIX}${who} — ${why}.`;
  // Keep whatever the row already said underneath the stamp: the Slack quote,
  // the brain's detail, the client's own words. A dismissal adds a fact, it
  // never erases the one that was there.
  const prior = (t.summary ?? "").replace(/^Dismissed by [^\n]*\n?/, "").trim();
  const summary = (prior ? `${stamp}\n${prior}` : stamp).slice(0, 500);

  const done = await prisma.smartTask.updateMany({
    where: { id: taskId, status: { not: "CANCELLED" } },
    // CANCELLED, never COMPLETED, and no completedAt: nothing happened here —
    // every "what got done" count pairs COMPLETED with completedAt, and a
    // dismissal must not inflate them.
    data: { status: "CANCELLED", completedAt: null, summary },
  });
  if (done.count === 0) return { ok: true, message: "Already dismissed." };

  // A PERSON decided this. Same marker the Complete buttons write, so home's
  // "N things handled by hand today" counts a judgement call as work (it is).
  const { stampHandledByHand } = await import("@/lib/opsDay");
  await stampHandledByHand(taskId, who, me?.email ?? null);

  if (t.projectId) {
    await prisma.activity
      .create({
        data: {
          projectId: t.projectId,
          type: ActivityType.SYSTEM,
          body: `${who} dismissed a to-do (${why}): ${t.title.slice(0, 160)}`,
        },
      })
      .catch(() => {});
    // A dismissal takes a revision ask out of the open set exactly as a
    // Complete does, and nothing here ever told the job about it. That was
    // survivable while a Complete on ANY card cleaned the whole job up; it
    // stopped being survivable on Sep 20, when a Complete started correctly
    // holding the job while a sibling ask is open. "Hold on Kyle's photo card,
    // then dismiss the video ask that turned out to be a misread email" left
    // the job pinned in Revisions with no open ask on it and no card left to
    // press — the shape 204 Spring Ln and 358 N Church St are already stuck in
    // from other routes, and the only way out is an admin noticing and using
    // the project page. The last ask out of the open set resolves the job; an
    // earlier one holds it and says so, which is the same rule the Complete
    // button takes.
    if (t.taskType === "revision") {
      try {
        await resolveRevisionForTask(taskId, t.projectId, "dismissed");
        revalidatePath("/pipeline");
      } catch { /* the dismissal itself stands — this only lets the job move on */ }
    }
    revalidatePath(`/projects/${t.projectId}`);
  }
  revalidatePath("/tasks");
  revalidatePath("/queue");
  revalidatePath("/ops");
  revalidatePath("/");
  return { ok: true, message: `Dismissed — ${why}.` };
}

export async function setSmartTaskStatus(taskId: string, status: string) {
  // Owner/admin, or the editor this task is delegated to — editors must be able
  // to complete their own queue work (audit crack #28).
  await requireTaskAccess(taskId);
  if (!TASK_STATUSES.has(status)) return; // never write a free-form status
  // Read BEFORE the write: a QC close has to carry the closed-by-hand marker in
  // the SAME update, or the hourly reconciler wins the race and reopens it.
  const t = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { projectId: true, taskType: true, status: true, checklist: true, assignedKey: true, dedupeKey: true, title: true, propertyAddress: true, sourceDetail: true },
  });
  if (!t) return; // task no longer exists — no-op instead of throw
  // Every route into this action is a HUMAN pressing Complete (requireTaskAccess
  // above): the project page's button, a ?task= deep link, the queue card, the
  // Today feed, My Shoots. The reconciler in src/lib/tasks.ts reopens ANY
  // completed QC card whose checklist still shows unticked boxes — a guard
  // against auto-closes during a signal blip (audit crack #2) — and a human
  // close never ticks boxes, so until now only /ops' completeQcTask survived it.
  // Everywhere else, the card came back within the hour: 205 of 208 completed QC
  // cards carried no marker, and 65 re-closes are on record (238 Hudson Dr was
  // closed SEVEN times). Stamp the marker wherever the human is standing.
  // Reopening one by hand clears it again, so the marker can never outlive the
  // decision it records and shield a later auto-close.
  const qcMarker =
    t.taskType !== "media_qa"
      ? {}
      : status === "COMPLETED"
        ? { sourceDetail: CLOSED_BY_HAND }
        : t.sourceDetail === CLOSED_BY_HAND
          ? { sourceDetail: null }
          : {};
  const updated = await prisma.smartTask.updateMany({
    where: { id: taskId },
    data: { status, completedAt: status === "COMPLETED" ? new Date() : null, ...qcMarker },
  });
  if (updated.count === 0) return; // lost a race with a delete — nothing else to do
  // A person pressed Complete: leave the trace "handled today" counts (the
  // sweeps and the janitor close far more rows than people do — audit, Sep 8).
  if (status === "COMPLETED") {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { stampHandledByHand } = await import("@/lib/opsDay");
    const me = await getCurrentUser().catch(() => null);
    await stampHandledByHand(taskId, me?.name ?? null, me?.email ?? null);
  }
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
  //
  // Sep 20: THIS ROW, not the whole job. requireTaskAccess above authorised
  // exactly one task and then the bare resolveRevision closed every revision
  // ask on the project — so John's Complete on his video revision also stamped
  // Kyle's photo ask COMPLETED, silently, on a job the client was still owed
  // work on. resolveRevisionForTask runs the identical full resolve when this
  // was the last open ask and holds the job in Revisions when it was not
  // (comms.ts) — the same rule the Review Room approval and the /editing pill
  // have carried since Sep 8.
  //
  // Two conditions on that, both about which rows actually LEAVE the open set:
  //
  // · The row must not already have been closed. This updateMany matches on id
  //   alone, so pressing Complete on a finished card runs the whole branch
  //   again — harmless when it resolved (resolveRevision's writes are
  //   idempotent), but on a held job every extra press used to append another
  //   "still open on this job" line to the timeline Jordan reads a month
  //   later. The checklist path below has carried this guard all along.
  //
  // · CANCELLED counts as a close for this purpose and WAITING_* does not.
  //   Picking "Cancelled" from the card's status dropdown takes the ask out of
  //   the open set just as a dismissal does, so the job has to be told. Parking
  //   the card on WAITING_EDITOR does not: the ask is still open, and calling
  //   the resolver there would resolve the job off a row that is still owed —
  //   the count excludes the row being acted on.
  //
  // THE HOLD IS NOT VISIBLE TO THE PERSON WHO CAUSED IT, and it cannot be made
  // visible from this file. The explanation goes to the job's timeline, and the
  // one non-admin login that reaches a revision card is an editor, whose role
  // /projects bounces — so John presses Complete, the card disappears, and
  // nothing on his screen says the job is still in Revisions waiting on Kyle's
  // photos. The /editing pill answers the identical branch in words (Jordan,
  // Sep 11: "it didn't save"). Returning { heldInRevisions } from here looks
  // free because no caller reads it, but it is not: TaskCard.tsx:531 hands this
  // action straight to a React 19 transition, whose callback is typed
  // () => VoidOrUndefinedOnly | Promise<VoidOrUndefinedOnly>, and the build
  // fails on a file this fix may not touch. The sentence and the return belong
  // together in the card's own ticket.
  if (
    t?.taskType === "revision" &&
    t.projectId &&
    t.status !== "COMPLETED" &&
    (status === "COMPLETED" || status === "CANCELLED")
  ) {
    await resolveRevisionForTask(taskId, t.projectId, status === "CANCELLED" ? "dismissed" : "resolved");
    revalidatePath("/pipeline");
    revalidatePath("/");
  }
  // Ticking the "upload the 1080p video to Aryeo" card IS the delivery mark
  // (Sep 16 review). The card tells Kyle to press Done when it is delivered,
  // and pressing Done has to be the whole answer: the only other button wired
  // to markTopazDelivered lives on /connections, which is owner-only, so the
  // job stayed "waiting for Kyle" for every video he had already delivered and
  // the count on the dashboard only ever climbed. Aryeo gives us no way to
  // observe the upload, so his tick is the only evidence that exists — which
  // makes it worth carrying properly.
  if (status === "COMPLETED" && t?.dedupeKey?.startsWith("topaz-deliver-")) {
    try {
      const { markTopazDelivered } = await import("@/lib/topazJobs");
      const { getCurrentUser } = await import("@/lib/auth/user");
      const me = await getCurrentUser().catch(() => null);
      await markTopazDelivered(t.dedupeKey.slice("topaz-deliver-".length), me?.name ?? me?.email ?? null);
    } catch { /* the tick itself already stands — this only closes the loop */ }
  }
  // Closing an @mention companion task rings the TAGGER's bell — shared with
  // the Ops Day / Dashboard "Handled" button (src/lib/mentionDone.ts).
  if (status === "COMPLETED" && t?.dedupeKey?.startsWith("mention-")) {
    const { notifyMentionDone } = await import("@/lib/mentionDone");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const u = await getCurrentUser().catch(() => null);
    await notifyMentionDone({ id: taskId, title: t.title, projectId: t.projectId, propertyAddress: t.propertyAddress, dedupeKey: t.dedupeKey }, u?.name ?? null);
  }
  revalidatePath("/queue");
  revalidatePath("/history");
  // Photographers complete their assigned tasks from the My Shoots card.
  revalidatePath("/shoot");
  if (t?.projectId) revalidatePath(`/projects/${t.projectId}`);
}

// Add a to-do by hand from the Daily Tasks page. Optional: link to a job/client
// (matched by address then client name), a due date, a priority, and delegate it
// to an editor. Lands in "Needs Kyle → Replies & admin" unless delegated.
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
  // Store the picked owner as-is — "kyle" included. This used to squash "kyle"
  // to null (June: null literally meant "Kyle's default"), then "todo" joined
  // TRIAGE_TYPES on Jul 1 and null started meaning "nobody", so the form's
  // default assignee sent Kyle's own to-dos into "Needs assigning · Pick who
  // owns each" and onto home's "to-dos with nobody's name on them" (Sep 8
  // audit, F1). Every other minter and setTaskAssignee already write "kyle".
  // An omitted assignee is Kyle's, per the contract above; a key that isn't
  // on the roster stays null so a human picks in the triage pile.
  const ak = input.assignedKey ?? "kyle";
  const assignedKey = validKeys.has(ak) ? ak : null;

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

// "Look into this" for TASKS — DM a teammate on Slack about one task, with the
// description and a deep link that lands on (and highlights) the card. Sent AS
// the logged-in person (Jordan pings as Jordan); Slack id resolves from email
// on first use and is remembered; falls back to the ops channel so the ping
// never silently vanishes. Mirrors pingFeedbackOnSlack on the feedback board.
export async function pingTaskOnSlack(
  taskId: string,
  teamMemberId: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const [task, member, me] = await Promise.all([
    prisma.smartTask.findUnique({
      where: { id: taskId },
      select: { title: true, summary: true, description: true, source: true, sourceDetail: true, createdAt: true, client: { select: { name: true } } },
    }),
    prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { id: true, name: true, email: true, slackId: true } }),
    (await import("@/lib/auth/user")).getCurrentUser().catch(() => null),
  ]);
  if (!task || !member) return { ok: false, message: "Task or person not found." };
  const sender = me?.name?.split(/\s+/)[0] ?? "Jordan";
  const { etDateTime } = await import("@/lib/datetime");
  const { receivedByLabel } = await import("@/lib/taskSource");
  const receivedBy = receivedByLabel(task.source, task.sourceDetail);
  const base = appBase();
  const url = `${base}/tasks?tab=board&task=${taskId}`;
  const body = (task.summary ?? task.description ?? "").trim();
  const text =
    `👀 *${sender}* asked you to look into this task:\n` +
    `*${task.title}*${task.client?.name ? ` — ${task.client.name}` : ""}\n` +
    (body ? `> ${body.slice(0, 280).replace(/\n/g, "\n> ")}\n` : "") +
    `_Received ${etDateTime(task.createdAt)}${receivedBy ? ` on ${receivedBy}` : ""}_\n` +
    (note?.trim() ? `\n${sender}: ${note.trim().slice(0, 500)}\n` : "") +
    `\n${url}`;

  const { slackUserByEmail, slackDmUser, slackNotify } = await import("@/lib/integrations/slack");
  let slackId = member.slackId;
  if (!slackId) {
    slackId = await slackUserByEmail(member.email);
    if (slackId) await prisma.teamMember.update({ where: { id: member.id }, data: { slackId } });
  }
  if (slackId && (await slackDmUser(slackId, text))) {
    return { ok: true, message: `Pinged ${member.name.split(/\s+/)[0]} on Slack.` };
  }
  // No DM possible → the ops channel, addressed by name, so it still lands.
  const { alertDestination } = await import("@/lib/notify");
  const sent = await slackNotify(await alertDestination(), `@${member.name} ` + text).catch(() => false);
  return sent
    ? { ok: true, message: `No Slack DM for ${member.name.split(/\s+/)[0]} — posted to the ops channel instead.` }
    : { ok: false, message: "Couldn't reach Slack — is it still connected?" };
}

// Active teammates for the task ping picker (loaded lazily when the ping row opens).
export async function listTaskPingTargets(): Promise<{ id: string; name: string }[]> {
  try { await requireAdmin(); } catch { return []; }
  return prisma.teamMember.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
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
          href: t.projectId ? `/edit/${t.projectId}` : "/editing",
          targets: [{ roles: ["EDITOR"], userKey: `editor:${assignedKey}`, href: t.projectId ? `/edit/${t.projectId}` : "/editing" }],
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
    select: { checklist: true, status: true, projectId: true, taskType: true, assignedKey: true, sourceDetail: true, client: { select: { segment: true } } },
  });
  if (!t) return { ok: false, items: [], completed: false };
  const items = parseChecklist(t.checklist);
  if (index < 0 || index >= items.length) return { ok: false, items, completed: false };
  items[index] = { ...items[index], done: !items[index].done };
  // A QC card completes on its EVIDENCE rows (media live, gallery out); the
  // failure-mode ticks are optional notes, never a gate (Jordan, Sep 8:
  // "Ticking QC should be optional"). Every other checklist keeps all-ticked.
  // A reopened card (a category landed after a by-hand close) holds open until
  // THAT category's own rows are ticked — the same rule the reconciler applies
  // (tasks.ts allDone), or the first tick here would close a card that came
  // back precisely to be QC'd (B1 handover, Sep 16).
  const reopenedFor = new Set(reopenedForCategories(t.sourceDetail));
  const reopenedWorkLeft =
    reopenedFor.size > 0 &&
    items.some((i) => {
      const c = qcCategoryOfRow(i.label);
      return !i.done && !!c && reopenedFor.has(c);
    });
  const completed =
    t.taskType === "media_qa" ? qcGateComplete(items) && !reopenedWorkLeft : checklistComplete(items);
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
        ? { status: "COMPLETED", completedAt: new Date(), ...(t.taskType === "media_qa" ? { sourceDetail: CLOSED_BY_HAND } : {}) }
        // Unticking an OPTIONAL box on a finished QC card must not reopen it.
        : t.status === "COMPLETED" && t.taskType !== "media_qa"
          ? { status: "OPEN", completedAt: null }
          : {}),
    },
  });
  // Ticking the last step of a REVISION task ("Mark the revision resolved") is
  // a completion — it must run the same side effects as the Complete button,
  // or the project stays pinned in REVISION with its re-QC card frozen open
  // and the editor never gets the resolved ping.
  //
  // Which now includes the lane rule (Sep 20). Fixing the button and leaving
  // this alone would have left the identical cross-lane close one checkbox
  // away: this path is admin-only (requireAdmin above), and Kyle — who clears
  // the board fastest — reaches it every day.
  if (completed && t.status !== "COMPLETED" && t.taskType === "revision" && t.projectId) {
    await resolveRevisionForTask(taskId, t.projectId);
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
      // Same contract for the editor: a hand pick pins (the hourly handoff and
      // mint stop re-routing to the rules editor), clearing it unpins so the
      // automatic routing takes back over. Without this, the project-page pick
      // silently reverted within the hour while the queue-row pick stuck.
      ...(role === "editor" ? { editorManual: memberId != null } : {}),
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
      // A board move is a human status write, and a human write ends the
      // office's status pin (Sep 13, editOverrides.ts) — the board stays the
      // human's tool; the pin only ever holds off the engines.
      statusPinnedAt: null,
      // Stamp the delivery date ONCE. Hand-moving a job back to Delivered after
      // a client bounce used to overwrite the original date with today — and
      // four things read it as the day the client got their content: the
      // on-time %, the revenue month, the portal library order and every
      // "Delivered <date>" line. 74 stamps already sit more than a day after
      // the job's own first delivery marker (Sep 2 audit).
      ...(status === ProjectStatus.DELIVERED ? deliveryStamp(project.deliveredAt) : {}),
      // Moving a job to Delivered clears any open revision request.
      ...(status === ProjectStatus.DELIVERED
        ? { revisionRequestedAt: null, revisionNote: null }
        : {}),
      // Hand-picking Revisions must STAMP the request — without it the hourly
      // status sweep recomputed from evidence and silently reverted the pick
      // within the hour (audit Aug 25).
      ...(status === ProjectStatus.REVISION && !project.revisionRequestedAt
        ? { revisionRequestedAt: new Date() }
        : {}),
    },
  });

  // A board move off Waiting ends the office's Waiting hold (Sep 11,
  // queueWaiting.ts): the marker only bites on BOOKED/SCHEDULED, but left
  // behind it would re-arm under the old name and time the day the job is
  // dragged back to Scheduled. Delivered/Cancelled clear it inside
  // closeObsoleteTasks as well — harmless twice.
  if (status !== ProjectStatus.BOOKED && status !== ProjectStatus.SCHEDULED) {
    try {
      const { releaseWaitingHold } = await import("@/lib/queueWaiting");
      await releaseWaitingHold(projectId);
    } catch { /* hygiene only */ }
  }

  // Close out the revision task too when manually delivered.
  //
  // Whole-job on purpose, like the project page's Mark resolved: dragging the
  // card to Delivered is a statement about every ask on the job, not one lane.
  // What it did not do until Sep 20 was say which ones it took — of the three
  // paths that speak for the whole job this was the last silent one, and the
  // whole point of the lane split is that a photo ask belongs to Kyle while
  // the video ask belongs to the editor. The rows have to be read before the
  // close or there is nothing left to name.
  if (status === ProjectStatus.DELIVERED && project.revisionRequestedAt) {
    const openAsks = await prisma.smartTask.findMany({
      where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { title: true, dedupeKey: true, assignedKey: true },
    });
    await prisma.smartTask.updateMany({
      where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    const { getCurrentUser } = await import("@/lib/auth/user");
    const mover = await getCurrentUser().catch(() => null);
    const movedBy = (mover?.name ?? mover?.email ?? "").trim() || "The office";
    await noteRevisionLanesClosed(projectId, `${movedBy} moved the job to Delivered on the board`, openAsks);
  }

  // Clear obsolete production tasks when a job is delivered or cancelled.
  if (status === ProjectStatus.DELIVERED || status === ProjectStatus.CANCELLED) {
    await closeObsoleteTasks(projectId, status);
  }

  // SAY WHAT IS STILL MISSING (Kyle's call, Sep 16: photos delivered, video
  // never QC'd). This board move is the documented OVERRIDE — it deliberately
  // does not refuse — but a job moved to Delivered while the evidence still
  // names an ordered category that is live nowhere leaves no trace of that
  // fact anywhere. Now the timeline carries it, so the next person reading the
  // job can see the call that was made rather than guessing at it. Empty
  // evidence (a manual or non-Aryeo job) says nothing, as it should.
  // Sep 20 (F03): the read was `missing` only, which is "never made" — so a
  // board move on a job with four videos cut and none on the client's listing
  // left a timeline row saying nothing was missing. It now reads the same
  // union the gates and the card read, and it carries the count.
  const stillMissing = status === ProjectStatus.DELIVERED ? outstandingForDelivery(project.statusEvidence) : null;
  const missingClause = stillMissing && stillMissing.categories.length
    ? ` with ${owedPhrase(stillMissing)} still missing on Aryeo`
    : "";
  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.STATUS_CHANGE,
      body: `Moved from ${stageMeta(project.status).label} to ${stageMeta(status).label}${missingClause}.`,
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
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true } },
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
// Deliberately the WHOLE job, unlike the Complete button on a single card: an
// admin standing on the project pressing "Mark resolved" is speaking for every
// ask on it. Since Sep 20 it says so out loud — when it closed more than one
// lane the timeline names them, so a photo ask that went out alongside a video
// one is on the record instead of just missing off Kyle's board.
export async function resolveRevisionAction(projectId: string) {
  await requireAdmin();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  // Trimmed, not just null-checked: a saved name of "" is not a person, and
  // `??` would have put it on the timeline as a leading space (the same idiom
  // dismissTask above uses).
  await resolveRevisionWholeJob(projectId, (me?.name ?? me?.email ?? "").trim() || null);
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
