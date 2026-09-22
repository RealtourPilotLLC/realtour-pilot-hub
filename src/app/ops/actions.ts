"use server";

import { revalidatePath } from "next/cache";
import type { SentResult } from "@/lib/readyToSend";
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
    select: {
      id: true, projectId: true, title: true, status: true, dedupeKey: true, propertyAddress: true,
      // taskType/source/clientId are here for the per-request marker below, not
      // for the close itself (follow-up repair, Sep 20 2026).
      taskType: true, source: true, clientId: true,
    },
  });
  if (!task) return { ok: false, message: "That follow-up no longer exists." };
  if (task.status === "COMPLETED") return { ok: true, message: "Already handled." };

  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? "").trim();
  // A LOOP MARKED HANDLED ON ONE PROPERTY'S ROW IS NOT A DECISION ABOUT THE
  // WHOLE CONVERSATION (follow-up repair, Sep 20 2026). `client_reply` is in
  // BOARD_HIDDEN_TYPES, so this card is the ONLY surface those rows render on
  // — and a bare COMPLETED here is read by the live walk as a cut across the
  // client's entire phone thread. Kyle pressing Handled on "Apply credit for
  // skipped aerial shots at Cardigan" therefore dropped a Church St question
  // that arrived two minutes earlier off the Replies tab, the /tasks comms
  // board, the /ops pill and findUnansweredInbound, which is what the
  // five-minute SLA sweep pages on. Renee Ryan holds exactly those two rows
  // today, both with orders, both rendering here.
  //
  // Same marker discipline markCommsHandled uses, and scoped the same way: ONLY
  // a phone-lane client_reply that names an order (isPerRequestReply). A
  // comms_followup, a callback or an internal instruction marked handled is a
  // statement about the conversation and still cuts it — restoring that cut is
  // what the last pass had to do after an over-correction threw 29 real closes
  // away. The marker goes down BEFORE the completion so no walk can read the
  // close without it.
  const { stampRequestTick } = await import("@/lib/replyQueue");
  await stampRequestTick(task, "handled on the request's own row from Ops Day");
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

/**
 * "Mark as sent" on the Ready-to-send card: Kyle has uploaded the file to Aryeo
 * and delivered the listing, and this is him telling the hub so.
 *
 * It records; it never sends. Aryeo has no upload and no delivery endpoint, so
 * the client-facing act happens in Aryeo, by hand, before this button is
 * pressed. Nothing here messages a client.
 *
 * OWNER/ADMIN only, checked HERE — a server action is a public endpoint, and
 * the card being hidden from an editor proves nothing. requireAdmin is the same
 * gate the QC closes above use (Kyle is ADMIN); no editor or photographer lane
 * reaches a client delivery surface.
 */
export async function markVideoSentAction(submissionId: string): Promise<SentResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const me = await getCurrentUser().catch(() => null);
  const { markVideoSent } = await import("@/lib/readyToSend");
  const r = await markVideoSent(submissionId, me?.name ?? me?.email ?? null);
  // R5 (follow-up audit, Sep 22 2026) — TWO THINGS HERE USED TO SWALLOW THE
  // BACKEND'S OWN "press it again" AND MAKE IT IMPOSSIBLE TO DO.
  //
  //   · The return type narrowed to { ok, message, already }, so `incomplete`
  //     never reached the component even though markVideoSent sets it.
  //   · A partial settle is `ok: true`, so this revalidated `/` and `/ops` —
  //     the two routes the Ready-to-send card renders on. Next updates the UI
  //     of a revalidated path immediately from a Server Function, so the row
  //     (now carrying sentToClientAt, and therefore off the board) unmounted
  //     under the operator's finger. Gating MarkSent alone would have been
  //     inert: the button was gone either way.
  //
  // The send happened and its stamp is permanent. What is withheld on an
  // incomplete settle is the REFRESH, so the row stays on screen with a live
  // button and the repair is one press away.
  if (r.ok && !r.incomplete?.length) {
    revalidatePath("/");
    revalidatePath("/ops");
    revalidatePath("/tasks");
  }
  return r;
}

// ---------------------------------------------------------------------------
// recordCutDownloadedAction LIVED HERE, AND IT IS GONE (review, Sep 21 2026).
//
// WHAT IT DID. "Download" on the Ready-to-send card fired it from the button's
// onClick, and it stamped downloadedAt/downloadedBy on the cut so the row could
// say who has the file and since when. That answer is still wanted — three
// approved videos had sat unsent for up to three days (5 Raymond Cir, 453
// Cardigan Terrace, 5642 Limeport Rd) and a row somebody had picked up two
// minutes ago looked exactly like a row nobody had ever opened.
//
// WHY IT COULD NOT STAY. A press is not a hand-off. Both download routes have
// real failure exits — 409 the 1080p file is not filed yet, 404 it was moved or
// renamed in Dropbox, 502 Dropbox refused — and on every one of them this wrote
// "Downloaded by Kyle" for a file nobody had. 322 N 62nd St, whose Final Video
// folder was emptied out from under its own pointer, is that 404. First press
// wins, so nothing could ever correct it, and the card's four-hour quiet period
// then suppressed the red "waiting 3 days" on the one row whose file was
// actually missing.
//
// WHERE IT WENT. Into the two routes that KNOW, once Dropbox has handed over a
// link or the store has started returning bytes: /api/topaz/download/[id] and
// /api/review/cut/[id]/stream (stampHandOff there, which also insists on
// download intent, no portal token, and a real OWNER or ADMIN). Both call the
// same lib/readyToSend markCutDownloaded. Nothing should bring a
// press-triggered version of this back: the way to know a person has a file is
// to have given them one.
// ---------------------------------------------------------------------------
