"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CLOSED_BY_HAND, qcGateComplete, recordQcCompletion, reopenedForCategories } from "@/lib/tasks";
import { stampHandledByHand } from "@/lib/opsDay";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { notifyMentionDone } from "@/lib/mentionDone";
import { parseChecklist, serializeChecklist, type ChecklistItem } from "@/lib/checklist";
import { parseEvidence } from "@/lib/statusEvidence";
import { isQcEvidenceRow, qcCategoryOfRow, qcNotLiveMessage, QC_CATEGORIES, type QcCategory } from "@/lib/qcCategories";
import { ActivityType } from "@prisma/client";

/**
 * Close a QC card by hand with a reason (Jordan, Sep 1). The hub waits on
 * evidence from Aryeo, so a deliverable REMOVED from the order (195 Woodhill's
 * floor plan, discounted $50) leaves the card open forever with nothing a
 * human can do. This is the override — and it records WHY, because a silent
 * close is how work disappears.
 */
export async function completeQcTask(taskId: string, note: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, taskType: true, status: true },
  });
  if (!task) return { ok: false, message: "That card no longer exists." };
  if (task.status === "COMPLETED") return { ok: true, message: "Already done." };

  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? "").trim();
  const reason = note.trim().slice(0, 300);

  const done = await prisma.smartTask.updateMany({
    where: { id: taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    // "closed-by-hand" is what stops the hourly reconciler from reopening
    // this card: it reopens any COMPLETED QC whose checklist still has
    // unticked boxes (a guard against auto-closes during signal blips), and a
    // human close never ticks boxes — so 195 Woodhill and 632 Greenridge came
    // back every hour after Kyle closed them with a reason (Sep 1 2026).
    data: { status: "COMPLETED", completedAt: new Date(), sourceDetail: CLOSED_BY_HAND },
  });
  if (done.count === 0) return { ok: true, message: "Already handled." };

  // The by-hand stamp above says a person closed this; the marker says WHO.
  // handledByPeopleToday already counts the stamp, so this adds nothing to
  // today's number — it is the attribution a per-person "you handled" needs
  // once the board's close writes it too (review, Sep 8; the board's
  // setSmartTaskStatus is out of this file set and still leaves no name).
  await stampHandledByHand(taskId, who, me?.email ?? null); // the count is a courtesy — never fail the close over it

  if (task.projectId) {
    await prisma.activity
      .create({
        data: {
          projectId: task.projectId,
          type: ActivityType.SYSTEM,
          body: `QC marked complete by hand${who ? ` by ${who}` : ""}${reason ? `: ${reason}` : " (no reason given)"}.`,
        },
      })
      .catch(() => {});
  }
  revalidatePath("/"); // the merged home renders the same QC card (audit, Sep 8)
  revalidatePath("/ops");
  revalidatePath("/tasks");
  if (task.projectId) revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: "QC closed." };
}

/**
 * "Photos done" — one press that says a CATEGORY is QC'd and out, while the
 * job stays open for what it still owes (Kyle call, Sep 16: he QCs and
 * delivers the photos on the day, then the card sits in the morning block for
 * two more days reading "8 optional checks" because the video is owed; his
 * only button closed the WHOLE card and took the video's QC with it).
 *
 * It ticks that category's optional rows — the same shape toggleTaskChecklistItem
 * writes, and the reconciler merges ticks by label, so they survive every sync.
 * If that press happens to finish the card (everything ordered live, the gallery
 * out) it closes it, exactly as the last tick on /tasks does; otherwise the card
 * stays OPEN. It NEVER writes Project.status or deliveredAt: whether
 * the job is delivered is the status engine's call off Aryeo evidence, and a
 * hand-written DELIVERED is exactly how an owed video disappears (six live
 * jobs carry a missing category under a Delivered pill today). The evidence
 * rows ("QC Video") are not ours to tick either — they are what Aryeo says.
 *
 * Refuses when the category is not live on Aryeo: "done" has to mean he looked
 * at the media.
 */
export async function acknowledgeQcCategory(
  taskId: string,
  category: string,
): Promise<{ ok: boolean; message: string; items: ChecklistItem[] }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message, items: [] };
  }
  if (!QC_CATEGORIES.includes(category as QcCategory)) {
    return { ok: false, message: "Unknown QC category.", items: [] };
  }
  const cat = category as QcCategory;
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: {
      id: true, projectId: true, taskType: true, status: true, checklist: true,
      sourceDetail: true, assignedKey: true,
      project: { select: { statusEvidence: true, status: true } },
      client: { select: { segment: true } },
    },
  });
  if (!task) return { ok: false, message: "That card no longer exists.", items: [] };
  if (task.taskType !== "media_qa") return { ok: false, message: "That isn't a QC card.", items: [] };
  const items = parseChecklist(task.checklist);
  if (task.status === "COMPLETED" || task.status === "CANCELLED") {
    return { ok: true, message: "That card is already closed.", items };
  }

  // The status engine's word on what is live — the same list the card's
  // "Live on Aryeo" line reads. No evidence at all (a job the sweep has never
  // checked) counts as not live: better a "not on Aryeo yet" than a tick that
  // says a human QC'd media nobody can see.
  const present = parseEvidence(task.project?.statusEvidence)?.present ?? [];
  if (!present.includes(cat)) {
    return { ok: false, message: `${qcNotLiveMessage(cat)} Nothing to check off yet.`, items };
  }

  // Kyle's rows for this category. Evidence rows ("QC Photos") are Aryeo's
  // tick, never Kyle's — leave them. isQcEvidenceRow is the shared rule the
  // card counts by; an inline /^QC\s/ here disagreed with it on the
  // revision-injected "QC Reel (revision)" row, which the card COUNTS and the
  // action skipped — so after a revision "Video done" could never finish the
  // category and the button never went away (review, Sep 16).
  const mine = (i: { label: string; done?: boolean }) =>
    !i.done && qcCategoryOfRow(i.label) === cat && !isQcEvidenceRow(i.label);
  if (!items.some(mine)) return { ok: true, message: `${cat} was already checked off.`, items };
  const next: ChecklistItem[] = items.map((i) => (mine(i) ? { ...i, done: true } : i));

  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? "").trim();
  // Does this press finish the whole card? The gate is the evidence rows, not
  // the ticks (qcGateComplete) — so on a job where everything is already live,
  // pressing through the categories leaves nothing to hold the card open and
  // it would sit on the home until the next hourly pass (review). Close it
  // the way the last tick on /tasks does, with two carve-outs:
  //  · a card the reconciler REOPENED holds until the categories it came back
  //    for are ticked — closing on the evidence that reopened it is the loop
  //    that rule exists to prevent;
  //  · never mid-revision — every "done" signal there describes the previous
  //    accepted cut (tasks.ts: closes belong to the tick path or resolveRevision).
  const stillReopened = (() => {
    const back = new Set(reopenedForCategories(task.sourceDetail));
    if (back.size === 0) return false;
    return next.some((i) => {
      const c = qcCategoryOfRow(i.label);
      return !i.done && !!c && back.has(c);
    });
  })();
  const finishes = qcGateComplete(next) && !stillReopened && task.project?.status !== "REVISION";
  // Before the flip, so a throw can't leave a closed card with no record —
  // recordQcCompletion is deduped and swallows (same as the tick path).
  if (finishes && task.projectId) {
    await recordQcCompletion({
      projectId: task.projectId,
      items: next,
      clientSegment: task.client?.segment ?? null,
      completedBy: task.assignedKey ?? "kyle",
    }).catch(() => {});
  }
  // Project.status and deliveredAt are untouched either way: whether the job is
  // delivered is the status engine's call off Aryeo evidence. When the card
  // does NOT finish it stays OPEN and keeps carrying the video (opsDay buckets
  // it as "waiting" now that nothing live is unticked).
  const saved = await prisma.smartTask.updateMany({
    where: { id: taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: {
      checklist: serializeChecklist(next),
      // CLOSED_BY_HAND, like every human close: it tells the reconciler a
      // person decided, and it is what lets a category landing LATER bring
      // this card back (tasks.ts, the reopen rule).
      ...(finishes ? { status: "COMPLETED", completedAt: new Date(), sourceDetail: CLOSED_BY_HAND } : {}),
    },
  });
  if (saved.count === 0) return { ok: true, message: "That card just closed.", items };

  // It is real work by a real person — the home's "N things you handled today"
  // counts these stamps, and it counted the whole-card close before this
  // existed (opsDay.handledByPeopleToday; one stamp per card either way).
  await stampHandledByHand(taskId, who, me?.email ?? null);

  if (task.projectId) {
    await prisma.activity
      .create({
        data: {
          projectId: task.projectId,
          type: ActivityType.SYSTEM,
          body: `${cat} QC'd and delivered${who ? ` by ${who}` : ""}.`,
        },
      })
      .catch(() => {});
  }
  revalidatePath("/");
  revalidatePath("/ops");
  revalidatePath("/tasks");
  if (task.projectId) revalidatePath(`/projects/${task.projectId}`);
  return {
    ok: true,
    message: finishes
      ? `${cat} checked off — that was the last of it, so the card is closed.`
      : `${cat} checked off — the card stays open for the rest.`,
    items: next,
  };
}

/**
 * Close an open loop (follow-up / instruction / callback / reply owed) from
 * Ops Day or the Dashboard — Jordan (Sep 1): "a button to view and a button
 * to mark as handled." Status + completedAt only: these rows carry their own
 * source markers (rebook-<projectId>, orphan stand-downs) that the sweeps key
 * on, so nothing else is touched. A human Done sticks — the sweeps that mint
 * these only re-open on a NEWER trigger.
 */
export async function markLoopHandled(taskId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, title: true, status: true, dedupeKey: true, propertyAddress: true },
  });
  if (!task) return { ok: false, message: "That follow-up no longer exists." };
  if (task.status === "COMPLETED") return { ok: true, message: "Already handled." };

  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? "").trim();
  const done = await prisma.smartTask.updateMany({
    where: { id: taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  if (done.count === 0) return { ok: true, message: "Already handled." };

  // Leave a trace that a PERSON closed this. Home's "N things you handled
  // today" counts exactly these (opsDay.ts handledByPeopleToday); before it,
  // the greeting counted sweeps and webhooks as Kyle's work (audit5 F19,
  // Sep 8). The marker lives in AppSetting, not on the row: sourceDetail is
  // where a loop keeps its provenance (the Slack channel the source chip
  // reads, the Gmail thread a reply needs), and a stamp there would erase it.
  await stampHandledByHand(taskId, who, me?.email ?? null); // the count is a courtesy — never fail the close over it

  // An @mention companion task closed here must ring the tagger exactly as it
  // does from the task board (review: the tag loop opened with a bell and
  // closed with none).
  await notifyMentionDone(task, who || null);

  if (task.projectId) {
    await prisma.activity
      .create({
        data: {
          projectId: task.projectId,
          type: ActivityType.SYSTEM,
          body: `Follow-up marked handled${who ? ` by ${who}` : ""}: ${task.title.slice(0, 160)}`,
        },
      })
      .catch(() => {});
  }
  revalidatePath("/ops");
  revalidatePath("/");
  revalidatePath("/tasks");
  if (task.projectId) revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: "Handled." };
}
