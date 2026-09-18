"use server";

import { revalidatePath } from "next/cache";
// after(): run work once the response has gone out. Used for the one
// measurement in here that nobody is waiting on (finishCutUpload, below).
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireAdmin, requireTaskAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { editorForDeliverable, editorMeta, TEAM_MEMBER_EDITOR_KEYS, type EditorKey } from "@/lib/editors";
import { slugForName } from "@/lib/assignees";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { notifyInApp, type NotifyTarget } from "@/lib/notify";
// The 1080p export spec, from the one file that owns it (lib/videoStyles).
import { exportRefusalMessage, isOverExportSpec, resolutionLabel } from "@/lib/videoStyles";
// Type-only (erased at build): the shape the withdraw/move controls render.
import type { CutMoveOption, CutTakeBackInfo } from "@/components/review/types";

// ---------------------------------------------------------------------------
// Mutations for the STANDALONE Review Room (/review). The loop:
//   editor "Done — send to review"  → submitCutForReview(): find the newest
//     video in the project's FINAL Dropbox folder, mint a direct streaming
//     link, park a ReviewSubmission, flip the job to REVIEW, ring OWNER+ADMIN.
//   owner reviews at /review/<projectId> → addCutNote() drops timestamped
//     EDITOR-lane notes (or PHOTOGRAPHER-lane for capture problems) on the cut.
//   requestCutChanges() → puts the open EDITOR notes on the job's edit_video
//     card as the next ROUND (one card per cut — Jordan, Sep 8), rings the bell.
//   editor re-submits → NEW round; approveCut() → APPROVED + Kyle delivers.
//   A CLIENT's revision (comms.raiseRevision) rides the same loop: the
//   corrected cut's submit parks it "waiting on review", the approval closes
//   it — see reviewCuts.correctedCutSubmitted / correctedCutApproved.
// Reads live in src/lib/reviewRoom.ts. The per-asset PHOTO pin review stays in
// the project gallery (reviewActions.ts) — this file is the CUT loop.
// ---------------------------------------------------------------------------

const streetOf = (title?: string | null) => (title || "this job").split(",")[0].trim();
// A cut's identity across rounds: uploaded cuts by (deliverable, slot),
// legacy folder rows by file path — see reviewCuts.cutKeyOf.
const cutKeyOf = (s: { deliverableId?: string | null; slot?: number | null; assetPath?: string | null; id: string }) =>
  s.deliverableId ? `${s.deliverableId}:${s.slot ?? 1}` : (s.assetPath ?? s.id);

function refresh(projectId: string) {
  revalidatePath("/review");
  revalidatePath(`/review/${projectId}`);
  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
}

/**
 * Keep the per-video rows in step with the round that just moved (audit WF-02).
 *
 * DeliverableOutput carries the five facts a cut's own row cannot — who owns
 * this video, when it is promised, which version is current, what we approved,
 * whether the client has it. Both calls are derivations of rows that already
 * exist, so this is idempotent and never a second opinion: ensure mints the
 * slots cutSlots computes, refresh re-reads the rounds. Best-effort by design —
 * a verdict, an upload or a bounce must never fail over its own bookkeeping.
 */
async function syncOutputs(projectId: string): Promise<void> {
  try {
    const { ensureOutputsForProject, refreshOutputsForProject } = await import("@/lib/deliverableOutputs");
    await ensureOutputsForProject(projectId);
    await refreshOutputsForProject(projectId);
  } catch { /* the cut's own write already landed */ }
}

/** after(), except a missing request scope is never a reason an editor's
 *  action fails. Both callers below hand it the same kind of work — measuring
 *  what a cut actually was, for a report — and both are reachable from another
 *  server action (editing/actions presses Completed → submitCutForReview). If
 *  a script or a test ever calls one outside a request, the cut still goes to
 *  review and the row simply stays unmeasured. */
function afterSafe(fn: () => Promise<void>): void {
  try {
    after(fn);
  } catch {
    /* no request scope — skip the measurement, never the action */
  }
}

// Who's writing (same convention as reviewActions.sessionAuthor): resolve a
// photographer through the live roster-email fallback, and never alias a
// signed-in NON-owner to "owner" — that key is an identity in the thread-reply
// notifier (it suppresses Jordan's ping and can self-ping the addressee).
// authorTmId is the writer's OWN roster row (reviewer, Sep 15): the self-tag
// rule compares it exactly — so an editor keyed editor:<key> tagging
// themselves still counts as a self-tag, and a second owner login tagging
// "@Jordan" reaches Jordan. Only the sessionless dev fallback leaves it
// undefined and lets the "owner" key stand in for his row.
async function sessionAuthor(): Promise<{ authorKey: string; authorTmId?: string | null; authorName: string | null }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { authorKey: "owner", authorName: "Jordan" };
  const name = u.name ?? u.email;
  const { authorTeamMemberId } = await import("@/lib/mentions");
  const authorTmId = await authorTeamMemberId(u);
  if (u.role === "OWNER") return { authorKey: "owner", authorTmId, authorName: name };
  // An EDITOR is keyed editor:<key> FIRST — tm:<id> winning meant editor-
  // authored notes dodged every "authored by the editor" filter and their
  // submissions were credited to a tm: identity (Aug 18 audit).
  if (u.role === "EDITOR" && u.editorKey) return { authorKey: `editor:${u.editorKey}`, authorTmId, authorName: name };
  if (u.teamMemberId) return { authorKey: `tm:${u.teamMemberId}`, authorTmId, authorName: name };
  if (u.editorKey) return { authorKey: `editor:${u.editorKey}`, authorTmId, authorName: name };
  if (u.role === "PHOTOGRAPHER") {
    try {
      const { photographerMemberId } = await import("@/lib/shoot");
      const mid = await photographerMemberId(u);
      if (mid) return { authorKey: `tm:${mid}`, authorTmId: authorTmId ?? mid, authorName: name };
    } catch { /* fall through to the neutral key */ }
  }
  return { authorKey: `user:${u.id}`, authorTmId, authorName: name };
}

// Which editor a project's video work routes to — prefer who actually
// submitted the cut, fall back to the deliverable routing table.
async function projectEditorKey(projectId: string): Promise<string | null> {
  const latest = await prisma.reviewSubmission.findFirst({
    where: { projectId, submittedByKey: { not: null } },
    orderBy: { round: "desc" },
    select: { submittedByKey: true },
  });
  if (latest?.submittedByKey) return latest.submittedByKey;
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } }, client: { select: { socialClient: true } } },
  });
  if (!p) return null;
  const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL") ?? p.deliverables[0];
  // PROJECT-level monthly test — see isMonthlyContentJob (client flag alone
  // routed social clients' LISTING reels to the monthly-content lane).
  const { editorRouting } = await import("@/lib/settings");
  return editorForDeliverable(v?.type, v?.label, isMonthlyContentJob(p.deliverables), await editorRouting());
}

// Owner/admin, OR the editor an EDITOR-lane root note belongs to (they may
// reply + mark-fixed on their OWN feedback only). Mirrors requireNoteAccess in
// reviewActions.ts, with editorKey standing in for photographerId.
// `allowMentioned` widens the REPLY path only: a photographer @-tagged on the
// thread got a ping saying "reply on the note", whatever the note's lane — but
// status flips stay with the note's own addressee (callers don't pass it).
async function requireCutNoteAccess(
  root: { id: string; lane: string; editorKey: string | null; photographerId: string | null },
  opts?: { allowMentioned?: boolean },
): Promise<void> {
  if (!authEnforced()) return;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
  if (u.impersonating) throw new Error("You're previewing another user — exit the preview to make changes.");
  if (u.realRole === "OWNER" || u.realRole === "ADMIN") return;
  if (u.realRole === "EDITOR" && root.lane === "EDITOR" && u.editorKey && u.editorKey === root.editorKey) return;
  if (u.realRole === "PHOTOGRAPHER") {
    const { photographerMemberId } = await import("@/lib/shoot");
    const mid = await photographerMemberId(u);
    if (mid && root.lane === "PHOTOGRAPHER" && root.photographerId && mid === root.photographerId) return;
    if (mid && opts?.allowMentioned) {
      // isMentionedIn runs the SAME roster-aware matcher that minted the ping,
      // so the guard admits exactly the people who were told to come here.
      const thread = await prisma.mediaNote.findMany({
        where: { OR: [{ id: root.id }, { parentId: root.id }] },
        select: { body: true },
      });
      const { isMentionedIn } = await import("@/lib/mentions");
      if (await isMentionedIn(thread.map((n) => n.body), mid)) return;
    }
  }
  throw new Error("You don't have access to do that.");
}

// The editor's "Done — send to review". Everything sendEditToReview did, PLUS
// a ReviewSubmission row with a playable link so the owner reviews in-house at
// /review/<id> instead of hunting through Dropbox.
export async function submitCutForReview(
  projectId: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  // Scope to the SUBMITTING editor's own task: authorizing off the oldest open
  // task regardless of assignee let one editor's submit close ANOTHER editor's
  // work item (audit). Owner/admin submit-on-behalf keeps the wide net.
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  // An EDITOR with no editorKey mapped still needs scoping — their tasks are
  // assigned under their name slug (same fallback requireTaskAccess uses). A
  // bare null here would UNSCOPE the close below and let their submit complete
  // a co-editor's work item.
  const myEditorKey =
    me?.role === "EDITOR" ? (me.editorKey ?? (me.name ? slugForName(me.name) : null)) : null;
  const task = await prisma.smartTask.findFirst({
    where: {
      projectId,
      taskType: { in: ["edit_video", "revision"] },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      ...(myEditorKey ? { assignedKey: myEditorKey } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  try {
    // Access keys off the editor's open task (assignedKey = them); owner/admin
    // always pass. No open task → admin only.
    if (task) await requireTaskAccess(task.id);
    else await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, status: true, addressLine: true, shootDate: true, createdAt: true, deliveredAt: true,
      packageName: true, videosFilmed: true,
      client: { select: { name: true, socialClient: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } },
    },
  });
  if (!project) return { ok: false, message: "That project no longer exists." };
  const street = streetOf(project.title);

  const { authorKey, authorName } = await sessionAuthor();
  const editorKey = authorKey.startsWith("editor:") ? authorKey.slice("editor:".length) : await projectEditorKey(projectId);

  // The cut itself — the newest video in the Final folder that isn't in
  // review yet (monthly packages carry several; they go one at a time). One
  // shared discoverer with the hourly sweep: same folder resolution (the
  // job's REAL folder, not the convention path), same per-file identity, and
  // a playable link that doesn't depend on a sharing scope the Dropbox app
  // doesn't have (the old shared-link mint returned null on every submit).
  const { syncFinalCutsToReview, submittedDistinctCuts } = await import("@/lib/reviewCuts");
  const sync = await syncFinalCutsToReview(projectId, {
    mode: "button",
    onlyNewest: true,
    submittedByKey: editorKey,
    submittedByName: authorName ?? "Editor",
    note,
  });
  if (sync.unreadable) {
    return { ok: false, message: "Dropbox couldn't be read just now — try again in a minute." };
  }
  const made = sync.claimed ?? sync.created[0] ?? null;
  if (!made) {
    return {
      ok: false,
      message: sync.folderVideoCount === 0
        ? "No video file found in 05-Final-Video yet. Export the cut there, then send again."
        : "Every video in the Final folder is already in review (or approved). Drop the next finished file in 05-Final-Video, then send again.",
    };
  }
  // What the file actually was, measured off its header once this answer is
  // back with the editor (the 1080p export spec, Sep 16). Nothing here blocks
  // or bounces a cut that is already sitting in the Final folder — this door
  // has no browser in it to check anything BEFORE the work is done, so all it
  // can honestly do is record what came, which is what makes the spec
  // measurable on all of the cuts instead of the half that came up the panel.
  if (sync.created.length > 0) {
    afterSafe(async () => {
      const { measureFolderCuts } = await import("@/lib/reviewCuts");
      await measureFolderCuts(sync.created);
    });
  }
  const cut = {
    assetUrl: `/api/review/cut/${made.id}/stream`,
    assetPath: made.assetPath,
    fileName: made.fileName,
    isRedo: made.isRedo,
    folderVideoCount: sync.folderVideoCount,
  };

  // How many videos this job owes (deliverable quantities), and how many
  // distinct files have been through review — drives whether this submit
  // closes the editor's work item or leaves it open for the next video.
  // What the folder SHOWS beats what the order row says: monthly packages are
  // stored as quantity=1 (audit) yet the editor exports 2–5 videos — if 4
  // files sit in the Final folder, 4 videos are owed. max() so a listing job
  // with one file stays a one-video job.
  const quantityOwed = project.deliverables
    .filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
    .reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
  // The photographer's own count (upload wrap-up) is the truth for a monthly
  // session — the order row stores quantity=1 while the session really owes a
  // batch, so without this the editor's work item closed after cut #1 even
  // though the brief says "cut 4" (review). Fall back to the PLAN quota for
  // in-flight jobs submitted before the count existed.
  const { isMonthlyContentJob, monthlyVideoQuota } = await import("@/lib/pipeline");
  const monthlyOwed = isMonthlyContentJob(project.deliverables, project.packageName)
    ? project.videosFilmed ?? monthlyVideoQuota([project.packageName, ...project.deliverables.map((d) => d.label)])
    : 0;
  // NOT the folder's file count: editors export redos as new files (v1, v2,
  // v3), and counting them made a 2-video Starter owe 5 — the edit task could
  // never close. Owed = the order / the photographer's count / the plan.
  const videosOwed = Math.max(quantityOwed, monthlyOwed);
  // Distinct files now in review (the claimed/created row included).
  const distinctAfter = await submittedDistinctCuts(projectId);
  // TYPE-SCOPED (adversarial review): a REDO answers the client's revision
  // but must NOT close the edit_video item still covering unmade videos;
  // completing the SET closes edit_video but must not touch a revision on a
  // different cut. Single-video jobs and no-file submits keep the legacy
  // "this answers everything" behavior.
  const legacyClose = !cut.assetPath || videosOwed <= 1;
  const closeEdit = legacyClose || distinctAfter >= videosOwed;
  // A job the client already has: any file made after their ask is the
  // correction, even under a new name on a multi-video order (Sep 8 review —
  // an approved file's path is never eligible again, so the redo often IS a
  // new name).
  const answersRevision = legacyClose || cut.isRedo || !!project.deliveredAt;

  // Rounds are PER FILE (the helper computed it): video 2's first cut is
  // "Round 1", not "Round 2" because video 1 came before it.
  const submission = made
    ? { id: made.id, round: made.round }
    : await prisma.reviewSubmission.create({
        // No file could be attached (shouldn't happen past the guards above) —
        // keep the legacy no-file row so the submit is never silently lost.
        data: {
          projectId, kind: "video", round: 1, status: "PENDING",
          submittedByKey: editorKey, submittedByName: authorName,
          note: (note ?? "").trim().slice(0, 1000) || null,
        },
        select: { id: true, round: true },
      });

  // Close out the editor's open work item (edit_video). An editor's submit
  // closes ONLY their own task — never a co-editor's parallel work item. On a
  // multi-video package the edit task stays OPEN until the last video of the
  // set is in — sending video 1 of 4 is progress, not done.
  if (closeEdit) {
    await prisma.smartTask.updateMany({
      where: {
        projectId,
        taskType: "edit_video",
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        ...(myEditorKey ? { assignedKey: myEditorKey } : {}),
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  } else if (cut.isRedo) {
    // The set still owes cuts, but this redo answers the round on the card —
    // rewrite its "Round N — fix them" summary so it stops telling the editor
    // to fix a version they just sent (Sep 8 review).
    try {
      const { editCardCutSubmitted } = await import("@/lib/tasks");
      await editCardCutSubmitted(projectId, { round: submission.round, cutLabel: cut.fileName, close: false, editorKey: myEditorKey });
    } catch { /* best-effort — the cut is already in review */ }
  }

  // EDITING/SHOT → REVIEW (never demote a job already past review).
  // A submit is a human status write, and a human write ends the office's
  // status pin (Sep 13, editOverrides.ts) — the pin only ever holds off the
  // engines.
  if (project.status === "EDITING" || project.status === "SHOT") {
    await prisma.project.update({ where: { id: projectId }, data: { status: "REVIEW", statusPinnedAt: null } });
  } else if (answersRevision) {
    // Sep 8 (Jordan: "A revision should be changed to ready for review when an
    // editor marks it complete and submits it for review"): the client's
    // video-lane revision used to be COMPLETED here, before anyone had looked
    // at the redo. It now goes IN_PROGRESS "waiting on review" and closes on
    // the approval; a never-delivered job returns to Ready-for-review (stamp
    // cleared) once nothing stays OPEN in another lane, a delivered job keeps
    // Revisions until the verdict — see reviewCuts.correctedCutSubmitted.
    const { correctedCutSubmitted } = await import("@/lib/reviewCuts");
    await correctedCutSubmitted(projectId, { round: submission.round, isRedo: cut.isRedo || !!project.deliveredAt });
  }
  await prisma.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: `Cut submitted for review (round ${submission.round})${cut.fileName ? ` — ${cut.fileName}` : ""}.`,
    },
  });

  // Bell + the owner's text, deduped on the submission id (Sep 11) — the same
  // announcer the portal upload and the hourly discovery use. Only a row this
  // press CREATED announces: a row it CLAIMED was discovered and rung by the
  // sweep already — under whatever key that day's code used, and six pre-
  // Sep-11 rows (1033 Preserve Ln ×5, 38 E Gay St) still carry the old
  // `autocut-…` key, so a claim of one would otherwise ring and text a cut
  // that has sat in the Room since August (reviewer, Sep 11). The owner
  // pressing on an editor's behalf is not texted about his own press.
  if (!sync.claimed) {
    const { announceCutInReview } = await import("@/lib/reviewCuts");
    await announceCutInReview({
      kind: "review_submitted",
      projectId,
      submissionId: submission.id,
      round: submission.round,
      street,
      fileName: cut.fileName,
      editorKey,
      editorName: authorName,
      ownerActed: authorKey === "owner",
    });
  }

  await syncOutputs(projectId);
  refresh(projectId);
  const multiProgress =
    !closeEdit && cut.assetPath
      ? ` That's video ${distinctAfter} of ${videosOwed} — send the next one when it's ready.`
      : "";
  return {
    ok: true,
    message: cut.assetUrl
      ? `Sent for review — ${cut.fileName ?? "the cut"} is queued in the Review Room.${multiProgress}`
      : "Sent for review. Heads up: no video file was found in the Final folder yet, so upload it there if you haven't.",
  };
}

// Which cut a note thread hangs on (Sep 16, Kyle call). Cut notes are keyed by
// the cut's asset URL — or the synthetic "cut:<id>" when Dropbox couldn't mint
// a streamable one — so a reply can name the submission the thread belongs to.
// The tag/reply pings pass it as `cutId`, and the owner's link then opens the
// Review Room parked on that exact cut instead of the shoot-note page his
// PHOTOGRAPHER roster role used to send him to (his Sep 14 tag landed on
// /shoot/note/…). Best-effort: no match just means no ?cut= on the link.
async function cutIdForAsset(projectId: string, assetUrl: string | null): Promise<string | null> {
  if (!assetUrl) return null;
  if (assetUrl.startsWith("cut:")) return assetUrl.slice(4);
  const sub = await prisma.reviewSubmission
    .findFirst({ where: { projectId, assetUrl }, orderBy: { round: "desc" }, select: { id: true } })
    .catch(() => null);
  return sub?.id ?? null;
}

// Drop one timestamped note on the active cut. Owner/admin from the review
// desk — and the EDITOR on their OWN cut (Jordan: "I also want the video
// editor to be able to leave feedback"): they flag things for the reviewer
// ("music was the client's pick", "0:12 jump is intentional") right on the
// timeline, EDITOR lane only.
export async function addCutNote(input: {
  projectId: string;
  submissionId: string;
  body: string;
  lane: "EDITOR" | "PHOTOGRAPHER";
  kind: "fix" | "coaching";
  timeSec: number | null;
}): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireAdmin();
  } catch {
    const me = await getCurrentUser().catch(() => null);
    // "View as" is strictly READ-ONLY platform-wide — an owner previewing an
    // editor must not write notes under that editor's name. Gate on the REAL
    // role, never the impersonated one (adversarial review).
    if (!me || me.impersonating) {
      return { ok: false, message: me?.impersonating ? "You're previewing another user — exit the preview to make changes." : "Only the crew can note a cut." };
    }
    // THE PHOTOGRAPHER WHO SHOT IT (Jordan, Sep 17: tag James on the video and
    // he can "see the review room video and comment"). Their voice belongs in
    // the capture lane — that is what the lane is for, and it keeps a shooter
    // out of the editor lane, where a note is an instruction to someone else.
    // Same ownership test the page and the tag link use, so a person who can
    // open the cut can answer on it, and nobody else can.
    if (me.realRole === "PHOTOGRAPHER" && me.role === "PHOTOGRAPHER" && me.teamMemberId) {
      if (input.lane !== "PHOTOGRAPHER") {
        return { ok: false, message: "You can add a capture note on this video." };
      }
      const { photographerOwnsShoot } = await import("@/lib/shoot");
      const theirs = await photographerOwnsShoot(input.projectId, me.teamMemberId).catch(() => false);
      if (!theirs) return { ok: false, message: "You can only note a video from a shoot you worked." };
      const onJob = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId }, select: { projectId: true } });
      if (!onJob || onJob.projectId !== input.projectId) return { ok: false, message: "That video isn't on this job." };
    } else {
      const myKey = me.realRole === "EDITOR" && me.role === "EDITOR" ? (me.editorKey ?? (me.name ? slugForName(me.name) : null)) : null;
      if (!myKey || input.lane !== "EDITOR") {
        return { ok: false, message: "Only the crew can note a cut." };
      }
      const sub = await prisma.reviewSubmission.findUnique({
        where: { id: input.submissionId },
        select: { projectId: true, submittedByKey: true },
      });
      const ownsCut =
        !!sub &&
        sub.projectId === input.projectId &&
        (sub.submittedByKey ?? (await projectEditorKey(input.projectId))) === myKey;
      if (!ownsCut) return { ok: false, message: "You can only note your own cut." };
    }
  }
  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, message: "Write the note first." };
  if (input.lane !== "EDITOR" && input.lane !== "PHOTOGRAPHER") return { ok: false, message: "Bad lane." };

  const submission = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId } });
  if (!submission || submission.projectId !== input.projectId) return { ok: false, message: "That submission no longer exists." };

  const editorKey = input.lane === "EDITOR" ? (submission.submittedByKey ?? (await projectEditorKey(input.projectId))) : null;
  let photographerId: string | null = null;
  if (input.lane === "PHOTOGRAPHER") {
    const p = await prisma.project.findUnique({ where: { id: input.projectId }, select: { photographerId: true } });
    photographerId = p?.photographerId ?? null;
    if (!photographerId) {
      const appt = await prisma.appointment.findFirst({
        where: { projectId: input.projectId, assignedToId: { not: null } },
        orderBy: { startAt: "asc" },
        select: { assignedToId: true },
      });
      photographerId = appt?.assignedToId ?? null;
    }
  }
  const { authorKey, authorTmId, authorName } = await sessionAuthor();

  const note = await prisma.mediaNote.create({
    data: {
      projectId: input.projectId,
      // Cuts with no minted link thread notes under a synthetic key so
      // feedback still works when Dropbox couldn't serve a streamable URL.
      assetUrl: submission.assetUrl ?? `cut:${submission.id}`,
      assetType: "video",
      timeSec: input.timeSec,
      lane: input.lane,
      kind: input.lane === "EDITOR" && input.kind === "coaching" ? "coaching" : input.kind,
      body: body.slice(0, 2000),
      status: "OPEN",
      authorKey,
      authorName,
      editorKey,
      photographerId,
    },
  });
  {
    const { notifyMentions } = await import("@/lib/mentions");
    // cutId + surface: the owner reads a cut note in the Review Room, not on
    // /shoot (Sep 16) — and the surface says so even if the cut can't be named.
    await notifyMentions({ text: body, projectId: input.projectId, authorKey, authorTmId, authorName, context: "a cut note", noteId: note.id, cutId: input.submissionId, surface: "cut" });
  }
  refresh(input.projectId);
  return { ok: true };
}

// Threaded reply on a cut note — owner/admin, or the editor/photographer the
// root note is addressed to.
export async function replyCutNote(noteId: string, body: string): Promise<{ ok: boolean; message?: string }> {
  const text = (body ?? "").trim();
  if (!text) return { ok: false, message: "Write a reply first." };
  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  const root = note.parentId ? await prisma.mediaNote.findUnique({ where: { id: note.parentId } }) : note;
  if (!root) return { ok: false, message: "That note no longer exists." };
  try {
    // Replies also open to photographers @-tagged on the thread — their
    // mention ping says "reply on the note", so the guard must let them.
    await requireCutNoteAccess(root, { allowMentioned: true });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { authorKey, authorTmId, authorName } = await sessionAuthor();
  const reply = await prisma.mediaNote.create({
    data: {
      projectId: root.projectId,
      assetUrl: root.assetUrl,
      thumbUrl: root.thumbUrl,
      assetType: root.assetType,
      lane: root.lane,
      kind: root.kind,
      body: text.slice(0, 2000),
      status: "OPEN",
      authorKey,
      authorName,
      editorKey: root.editorKey,
      photographerId: root.photographerId,
      parentId: root.id,
    },
  });
  // Reply is saved — everything below is best-effort notification fan-out.
  // Mentions ring first (they carry the note deep-link); whoever they reached
  // is excluded from the thread-participant ping so nobody hears it twice;
  // and the job's editor hears the reply if neither ping reached them
  // (Jordan, Sep 15: "a message was sent on their project").
  {
    const { notifyMentions, notifyThreadReply, notifyProjectMessage } = await import("@/lib/mentions");
    // The cut this thread hangs on — the owner's link opens the Room on it (Sep 16).
    const cutId = await cutIdForAsset(root.projectId, root.assetUrl);
    const excludeTmIds = await notifyMentions({
      text,
      projectId: root.projectId,
      authorKey,
      authorTmId,
      authorName,
      context: "a cut-note comment",
      noteId: root.id,
      surface: "cut",
      ...(cutId ? { cutId } : {}),
    });
    const replied = await notifyThreadReply({
      rootId: root.id,
      replyId: reply.id,
      replierKey: authorKey,
      replierName: authorName,
      text,
      projectId: root.projectId,
      surface: "cut",
      ...(cutId ? { cutId } : {}),
      excludeTmIds,
    });
    await notifyProjectMessage({
      projectId: root.projectId,
      messageId: reply.id,
      authorTmId: authorTmId ?? null,
      authorKey,
      authorName,
      text,
      context: "a cut-note comment",
      excludeTmIds: [...excludeTmIds, ...replied],
    });
  }
  refresh(root.projectId);
  return { ok: true };
}

// OPEN → FIXED → RESOLVED on a cut note. Owner/admin set anything; the editor
// may mark THEIR OWN editor-lane notes FIXED (photographers likewise).
export async function setCutNoteStatus(
  noteId: string,
  status: "OPEN" | "FIXED" | "RESOLVED",
): Promise<{ ok: boolean; message?: string }> {
  if (status !== "OPEN" && status !== "FIXED" && status !== "RESOLVED") return { ok: false, message: "Bad status." };
  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  if (note.parentId) return { ok: false, message: "Replies don't have a status." };
  try {
    if (status === "FIXED") await requireCutNoteAccess(note);
    else await requireAdmin(); // reopen + approve stay with the owner's desk
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  await prisma.mediaNote.update({
    where: { id: noteId },
    data: {
      status,
      ...(status === "RESOLVED" ? { resolvedAt: new Date() } : status === "OPEN" ? { resolvedAt: null } : {}),
    },
  });
  refresh(note.projectId);
  return { ok: true };
}

// APPROVE the cut: verdict on the submission, praise bell to the editor, and a
// delivery nudge to ADMIN (Kyle ships it via the normal delivery flow).
export async function approveCut(submissionId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const submission = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    include: { project: { select: { title: true } } },
  });
  if (!submission) return { ok: false, message: "That submission no longer exists." };
  if (submission.status === "APPROVED") return { ok: true, message: "Already approved." };
  // A withdrawn cut has left the room (Sep 16) — there is nothing to rule on.
  if (submission.status === "WITHDRAWN") {
    return { ok: false, message: "That version was withdrawn — there's nothing to approve. The next version comes in on the same cut." };
  }

  const { authorName } = await sessionAuthor();
  await prisma.reviewSubmission.update({
    where: { id: submissionId },
    data: { status: "APPROVED", decidedAt: new Date(), decidedBy: authorName },
  });
  const street = streetOf(submission.project?.title);
  await prisma.activity.create({
    data: { projectId: submission.projectId, type: "SYSTEM", body: `Cut approved in review (round ${submission.round}).` },
  });

  // QC passed → the cut joins the client's portal library the same moment
  // (content-program jobs only; best-effort — approval never fails over it).
  try {
    const { addApprovedCutToLibrary } = await import("@/lib/portalLibrary");
    await addApprovedCutToLibrary(submissionId);
  } catch { /* library is best-effort */ }

  // Approved → the file goes to the job's Final folder on Dropbox and this
  // cut is COMPLETE (Jordan: "if it's approved, it automatically gets
  // uploaded to Dropbox, and it gets marked as complete for that cut").
  let copyNote = "";
  if (submission.blobUrl) {
    try {
      const { startDropboxCopy } = await import("@/lib/reviewCuts");
      const r = await startDropboxCopy(submissionId);
      copyNote = r.complete ? " Copied to the Final folder." : " Copying to the Final folder in the background.";
    } catch (e) {
      copyNote = ` Dropbox copy failed (${(e as Error).message.slice(0, 60)}) — it will be retried hourly.`;
    }
  }

  // ---- THE 1080p PASS ----------------------------------------------------
  // Jordan (Sep 16): "I want all videos to be ran through topaz when uploaded
  // and approved in ops hub." Approval QUEUES that render and nothing more —
  // one INSERT, guarded by a unique constraint on this submission id, which is
  // what makes re-approving, a double-click and two lambdas racing all land on
  // the same row instead of spending twice.
  //
  // It is deliberately AFTER the Dropbox copy above and deliberately wrapped:
  // a Topaz failure, a missing API key, an empty credit balance or Topaz being
  // down must never break or delay the approval, the copy of the editor's
  // original, or delivery. Approval stays instant and stays correct with the
  // 1080p pass switched off entirely — the render is an extra, not a step on
  // the critical path.
  let topazNote = "";
  try {
    const { queueTopazRender } = await import("@/lib/topazJobs");
    const q = await queueTopazRender(submissionId);
    // "Queued", not "being made now" (Sep 16 review). A freshly queued job can
    // legitimately wait — the lane is full, the month's credits are spent, the
    // balance is low, Topaz is unreachable — or be refused outright for being
    // over the per-video limit or over 500 MB, in which case no card ever
    // arrives and the sentence would have been a promise the hub did not keep.
    // "Queued" is true in every one of those cases, and the lane on Connections
    // says what happened next.
    if (q.queued) topazNote = " Queued for the 1080p pass — Kyle gets a card once it's done.";
  } catch { /* the 1080p pass never blocks an approval */ }

  // Multi-video sets: "Ready to deliver" is a SET verdict, not a per-cut one
  // (audit: Kyle was told to deliver on video 1 of 4). Count the cuts still
  // in flight — owed slots with no approved round yet, plus any legacy
  // file-keyed cuts whose latest round isn't approved.
  const { cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(submission.projectId).catch(() => []);
  const siblings = await prisma.reviewSubmission.findMany({
    where: { projectId: submission.projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } },
    orderBy: { round: "asc" },
    select: { id: true, assetPath: true, status: true, deliverableId: true, slot: true },
  });
  const latestPerCut = new Map<string, string>();
  for (const s of siblings) latestPerCut.set(cutKeyOf(s), s.status);
  const hasUploadRows = siblings.some((s) => !!s.deliverableId);
  const legacyEntries = [...latestPerCut.entries()].filter(([k]) => !k.includes(":"));
  const legacyApproved = legacyEntries.filter(([, st]) => st === "APPROVED").length;
  const legacyOpen = legacyEntries.filter(([, st]) => st !== "APPROVED").length;
  const uploadApproved = [...latestPerCut.entries()].filter(([k, st]) => k.includes(":") && st === "APPROVED").length;
  // Two eras on one job (review): legacy folder rows carry no deliverable, so
  // they can never satisfy an owed slot by key. Rule:
  //  · no uploads yet → the per-file verdict the room always had;
  //  · uploads exist  → owed cuts minus approved uploads minus approved legacy
  //    cuts (each counts for one); legacy cuts still awaiting a verdict no
  //    longer count — the upload era supersedes the folder era, otherwise a
  //    bounced folder row would be double-counted with its re-uploaded slot.
  const inFlight = hasUploadRows
    ? Math.max(0, slots.length - uploadApproved - legacyApproved)
    : legacyOpen;
  // Every owed cut approved → the editor's work item is done (never a
  // hand-assigned one — the assignedManually invariant).
  if (inFlight === 0) {
    await prisma.smartTask.updateMany({
      where: { projectId: submission.projectId, taskType: "edit_video", assignedManually: false, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    }).catch(() => {});
  }

  // Sep 8 (revision lifecycle): a cut newer than the client's ask answers it.
  // The video-lane revision closes whoever holds it (it used to close only
  // on the submitting editor's own key, and never on approval), and when no
  // lane is left open the job resolves the normal way — a delivered job back
  // to Delivered with the close-out and today's bells (resolveRevision).
  let revisionResolved = false;
  try {
    const { correctedCutApproved } = await import("@/lib/reviewCuts");
    // WHICH video was approved (WF-03). Without it the close falls back to
    // "nothing named is done", which holds the ask open — the row is right
    // here, so hand it over.
    revisionResolved = (
      await correctedCutApproved(submission.projectId, {
        cutCreatedAt: submission.createdAt,
        round: submission.round,
        cut: { id: submission.id, deliverableId: submission.deliverableId, slot: submission.slot, assetPath: submission.assetPath },
      })
    ).resolved;
  } catch { /* the approval itself already landed */ }

  try {
    const targets: NotifyTarget[] = [{ roles: ["ADMIN"] }];
    // Only Kim/Remar have logins that can see an editor:<key> row — a Luma/
    // vendor (or "editor:kyle") key would mint a row visible to NOBODY. The
    // ADMIN row above already keeps dispatch-managed cuts humanly visible.
    if (
      submission.submittedByKey &&
      (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(submission.submittedByKey)
    ) {
      targets.push({ roles: ["EDITOR"], userKey: `editor:${submission.submittedByKey}`, href: `/edit/${submission.projectId}` });
    }
    await notifyInApp({
      kind: "review_approved",
      title: `Cut approved — ${street}${submission.fileName ? ` (${submission.fileName})` : ""}`,
      body: inFlight > 0 ? `${inFlight} more video${inFlight === 1 ? "" : "s"} still in review — not ready to deliver yet.` : "Ready to deliver.",
      href: `/projects/${submission.projectId}`,
      targets,
      dedupeKey: `review-approved-${submissionId}`,
    });
  } catch { /* bell is best-effort */ }

  await syncOutputs(submission.projectId);
  refresh(submission.projectId);
  revalidatePath("/tasks");
  revalidatePath(`/projects/${submission.projectId}`);
  return {
    ok: true,
    message:
      (inFlight > 0
        ? `Approved — ${inFlight} more video${inFlight === 1 ? "" : "s"} still in review on ${street}.`
        : revisionResolved
          ? `Approved — the client's revision on ${street} is closed and the job is back where it stands.`
          : `Approved — every cut on ${street} is done; Kyle's been pinged to deliver.`) + copyNote + topazNote,
  };
}

// REQUEST CHANGES: put the open EDITOR-lane notes on this cut onto the job's
// edit_video card as the next ROUND (Jordan, Sep 8: "When a cut changes after
// a card is made, make it 1 card" — the separate cut-changes-* revision task
// this used to mint sat beside the edit card as a second card for one cut),
// flip the job to REVISION ("Revisions" on the queue), ring the bell. A
// client's revision the cut was answering goes back to OPEN — the job stays
// in Revisions and the client's ask stays open until a cut is approved.
export async function requestCutChanges(submissionId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const submission = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    include: { project: { select: { title: true, status: true, clientId: true } } },
  });
  if (!submission) return { ok: false, message: "That submission no longer exists." };
  if (submission.status === "WITHDRAWN") {
    return { ok: false, message: "That version was withdrawn — there's nothing to send back. The next version comes in on the same cut." };
  }

  const assetKey = submission.assetUrl ?? `cut:${submission.id}`;
  const open = await prisma.mediaNote.findMany({
    where: {
      projectId: submission.projectId,
      parentId: null,
      lane: "EDITOR",
      status: "OPEN",
      assetUrl: assetKey,
      // The EDITOR's own notes are context for the reviewer ("the 0:12 jump is
      // intentional") — they are NOT change requests and must not be bundled
      // into the work order sent back to them (adversarial review).
      NOT: { authorKey: { startsWith: "editor:" } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (open.length === 0) {
    return { ok: false, message: "Add at least one note first — the editor needs to know what to change." };
  }

  const street = streetOf(submission.project?.title);
  const s = open.length === 1 ? "" : "s";
  const fmtT = (t: number | null) =>
    t == null ? "" : `[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}] `;
  const lines = open.map((n) => `• ${fmtT(n.timeSec)}${n.body.trim()}`);
  // The round is on the edit card. The card keeps whoever holds it (the
  // assignedManually invariant); a job that never had one is minted through
  // the routing/pin rules, exactly like a first cut.
  const { addRoundToEditCard } = await import("@/lib/tasks");
  const { cutSlots, videoLaneRevisionWhere } = await import("@/lib/reviewCuts");
  // Which cut, in the words the editor's page uses ("Personal Branding Reel —
  // Video 2 of 4"); the file name for a legacy folder row.
  let which: string | null = submission.fileName ?? null;
  if (submission.deliverableId) {
    const slots = await cutSlots(submission.projectId).catch(() => []);
    which = slots.find((sl) => sl.deliverableId === submission.deliverableId && sl.slot === submission.slot)?.label ?? which;
  }
  const card = await addRoundToEditCard(submission.projectId, {
    round: submission.round + 1,
    notes: lines,
    reason: `sent back from the Review Room${which ? ` on ${which}` : ""} (version ${submission.round})`,
  });
  if (!card) {
    // No video deliverable on the job — nothing to hang a round on. Say so
    // rather than mint a card nobody will find.
    return { ok: false, message: "This job has no video deliverable on its order, so there is no edit card to send the notes to — add the video on the Editing Room first." };
  }
  // ONE owner for the round (Sep 8 review). Whoever holds the card gets the
  // bell. A card nobody holds and nobody pinned (personal-branding routing
  // is null by design) goes to the editor who made the cut — they are the
  // editor of record, so the card and the bell name the same person instead
  // of the card sitting in "Needs assigning" while the submitter is rung. A
  // card deliberately taken off every editor (Sep 7 unassign) stays that way
  // and Kyle is rung to pick someone.
  let editorKey = card.assignedKey as EditorKey | null;
  if (!editorKey && !card.assignedManually) {
    const maker = (submission.submittedByKey ?? (await projectEditorKey(submission.projectId))) as EditorKey | null;
    if (maker && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(maker)) {
      await prisma.smartTask.update({ where: { id: card.taskId }, data: { assignedKey: maker } }).catch(() => {});
      editorKey = maker;
    } else {
      editorKey = maker;
    }
  }
  // The client's revision this cut was answering is back with the editor —
  // the state sentence goes in front of the ask line, never over it.
  const { revisionStateSummary } = await import("@/lib/reviewCuts");
  const waiting = await prisma.smartTask.findMany({
    where: { ...videoLaneRevisionWhere(submission.projectId), status: "IN_PROGRESS" },
    select: { id: true, summary: true },
  });
  for (const t of waiting) {
    await prisma.smartTask.update({
      where: { id: t.id },
      data: {
        status: "OPEN",
        summary: revisionStateSummary(t.summary, `The corrected cut came back from review with ${open.length} note${s} — fix them (they are on the edit card) and upload the next version.`),
      },
    }).catch(() => {});
  }

  const { authorName } = await sessionAuthor();
  await prisma.reviewSubmission.update({
    where: { id: submissionId },
    // A copied-to-Dropbox cut that gets bounced is no longer complete; the
    // next approved version moves the old file aside (startDropboxCopy).
    data: { status: "CHANGES_REQUESTED", decidedAt: new Date(), decidedBy: authorName, completedAt: null },
  });
  // The job IS in revisions now (Jordan, Aug 27: "once we review the video and
  // I submit it for revisions, change the status to revisions"). The stamp
  // makes it sweep-proof — computeStatus honours an open revision, so the
  // hourly evidence engine can't flip it back off the old cut's files. The
  // editor's resubmit clears the stamp and returns a never-delivered job to
  // REVIEW; a delivered job still exits via resolveRevision, so the comms
  // engine's post-delivery meaning holds.
  const st = submission.project?.status;
  if (st === "REVIEW" || st === "EDITING" || st === "REVISION") {
    await prisma.project.update({
      where: { id: submission.projectId },
      // A bounce is a human status write, and a human write ends the office's
      // status pin (Sep 13, editOverrides.ts) — the pin only ever holds off
      // the engines.
      data: { status: "REVISION", revisionRequestedAt: new Date(), statusPinnedAt: null },
    });
  }
  await prisma.activity.create({
    data: {
      projectId: submission.projectId,
      type: "SYSTEM",
      body: `Changes requested on the round-${submission.round} cut (${open.length} note${s}).`,
    },
  });

  try {
    // Kim/Remar see their own editor:<key> row; a Luma/vendor key has no login
    // or channel, so the news goes to ADMIN instead — Kyle dispatches vendor
    // changes (same split as the manual-queue bell in editing/actions.ts).
    const isTeamEditor = !!editorKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(editorKey);
    await notifyInApp({
      kind: "review_changes",
      title: isTeamEditor
        ? `Changes requested — ${street}`
        : editorKey
          ? `Relay cut changes to ${editorMeta(editorKey)?.name ?? editorKey} — ${street}`
          : `Cut changes need an editor — ${street}`,
      body: `${open.length} note${s}: ${open[0].body}`.slice(0, 140),
      href: `/edit/${submission.projectId}`,
      // ADMIN always rides along: an editor:<key> row reaches NOBODY when that
      // editor has no login (Kim today), so a bounce could vanish silently —
      // the owner at least sees the cut came back (audit HIGH).
      targets: isTeamEditor
        ? [
            { roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${submission.projectId}` },
            { roles: ["ADMIN"], href: `/edit/${submission.projectId}` },
          ]
        : [{ roles: ["ADMIN"] }],
      dedupeKey: `review-changes-${submissionId}-${open[open.length - 1].id}`,
    });
  } catch { /* bell is best-effort */ }

  await syncOutputs(submission.projectId);
  refresh(submission.projectId);
  revalidatePath("/tasks");
  return {
    ok: true,
    message: editorKey
      ? `Sent ${open.length} change${s} to ${editorMeta(editorKey)?.name ?? editorKey} — round ${submission.round + 1} is on their edit card.`
      : `${open.length} change${s} added to the edit card as round ${submission.round + 1} — the job has no editor, so Kyle has been pinged; pick one on the job's row in the Editing Room (/editing) and the round goes to them.`,
  };
}


// ===========================================================================
// UPLOAD A CUT (the editor portal's "Upload version N"). Two halves around a
// direct browser → store transfer: start() reserves the row and the path,
// finish() verifies the bytes landed and puts the cut in the Review Room.
// ===========================================================================
// Who may upload on THIS project. Owner/admin: any job (vendor cuts). An
// EDITOR: only a job with an open edit_video/revision task assigned to them —
// the same scope submitCutForReview enforces, because an earlier audit found
// one editor's action closing ANOTHER editor's work item (review).
// `role` rides along because the export spec below has an override only
// OWNER/ADMIN may use, and the browser's word for who it is is worth nothing.
async function uploadAuthor(projectId: string): Promise<{ ok: true; key: string | null; name: string | null; role: string } | { ok: false; message: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (!me && !authEnforced()) return { ok: true, key: null, name: "Local dev", role: "OWNER" }; // same rule as requireRole
  if (!me) return { ok: false, message: "Sign in to upload a cut." };
  if (me.impersonating) return { ok: false, message: "You're previewing another user — exit the preview to upload." };
  if (!["OWNER", "ADMIN", "EDITOR"].includes(me.role)) return { ok: false, message: "Only editors, admins and the owner can upload cuts." };
  const key = me.role === "EDITOR" ? (me.editorKey ?? (me.name ? slugForName(me.name) : null)) : null;
  if (me.role === "EDITOR") {
    const mine = await prisma.smartTask.findFirst({
      where: {
        projectId,
        taskType: { in: ["edit_video", "revision"] },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        assignedKey: key ?? "__none__",
      },
      select: { id: true },
    });
    if (!mine) return { ok: false, message: "This job isn't on your queue — ask Kyle or Jordan to assign it to you first." };
  }
  return { ok: true, key, name: me.name ?? me.email ?? null, role: me.role };
}

/**
 * A stable key pair for pg_advisory_xact_lock, scoped to ONE cut slot. Two
 * FNV-1a passes with different seeds give the lock's two-int4 form: same slot →
 * same pair on every worker, different slots → different pairs, so two editors
 * uploading different videos never wait on each other. A collision across slots
 * would only ever cost a moment's waiting, never correctness. (Two int4s rather
 * than one int8 because the build targets below ES2020 — no BigInt literals.)
 */
function slotLockKey(projectId: string, deliverableId: string | null, slot: number): [number, number] {
  const str = `${projectId}|${deliverableId ?? "-"}|${slot}`;
  const fnv = (seed: number): number => {
    let h = seed;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0; // int4, which is what the two-key lock takes
  };
  return [fnv(0x811c9dc5), fnv(0x9e3779b9)];
}

export async function startCutUpload(input: {
  projectId: string;
  deliverableId: string;
  slot: number;
  fileName: string;
  sizeBytes: number;
  /** What the editor's browser measured off the file before sending a byte
   *  (CutUploader). Null/absent = it couldn't tell, which is NOT a refusal. */
  width?: number | null;
  height?: number | null;
  /** OWNER/ADMIN pressed "upload it anyway" on the over-spec dialog. */
  overrideExportSpec?: boolean;
  /**
   * Why an ALREADY APPROVED video is being replaced when no revision is open
   * (Jordan, Sep 18). Absent on every ordinary upload. The reason is the whole
   * difference between replacing a version and losing one, so it goes on the
   * timeline and to the office — see the approved-cut branch below.
   */
  reopenReason?: string | null;
}): Promise<{ ok: true; submissionId: string; pathname: string; round: number } | { ok: false; message: string; needsReason?: boolean }> {
  const who = await uploadAuthor(input.projectId);
  if (!who.ok) return who;
  const { cutSlots, uploadPathnameFor } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(input.projectId);
  const slot = slots.find((s) => s.deliverableId === input.deliverableId && s.slot === Math.floor(input.slot));
  if (!slot) return { ok: false, message: "That video isn't on this job's order any more — refresh the page." };
  if (!/\.(mp4|mov|m4v|webm|mkv)$/i.test(input.fileName)) return { ok: false, message: "Upload a video file (.mp4, .mov, .m4v, .webm)." };
  // ---- THE 1080p EXPORT SPEC (Jordan, Sep 16: "do not let them upload in 4K")
  // The browser measures the file before it sends a byte and draws the dialog
  // an editor actually reads (CutUploader); this is the same rule where it
  // can't be talked around, and the only place the ROLE that may override it is
  // knowable. Three things it deliberately does NOT do:
  //   · it never fires on a file we couldn't measure (isOverExportSpec fails
  //     open) — an exotic codec must not cost an editor their delivery;
  //   · it never guesses at the file on the server (that would mean downloading
  //     the thing we are trying not to upload);
  //   · it never lets an EDITOR past. Jordan and Kyle can wave one through,
  //     with their name on it, below.
  const overSpec = isOverExportSpec(input.width, input.height);
  const mayOverride = who.role === "OWNER" || who.role === "ADMIN";
  const waved = overSpec && mayOverride && input.overrideExportSpec === true;
  if (overSpec && !waved) return { ok: false, message: exportRefusalMessage(input.width, input.height) };
  // A WITHDRAWN round is not a version of this cut any more (Sep 16) — it is
  // skipped here, so the last word on the slot is the last version somebody
  // actually stands behind.
  const last = await prisma.reviewSubmission.findFirst({
    where: { projectId: input.projectId, deliverableId: input.deliverableId, slot: slot.slot, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
    orderBy: { round: "desc" },
    select: { round: true, status: true },
  });
  // An approved cut takes no more versions — UNLESS the client has since asked
  // for changes on the video lane (Sep 8 review): that is exactly the case
  // this rule used to lock out, and the corrected cut then had no way in
  // but a new file name in 05-Final-Video. The next round rides the same
  // slot; approval of the new version closes the ask (correctedCutApproved).
  if (last?.status === "APPROVED") {
    const { videoLaneRevisionWhere } = await import("@/lib/reviewCuts");
    const revisionOpen = (await prisma.smartTask.count({ where: videoLaneRevisionWhere(input.projectId) })) > 0;
    // A DELIBERATE REPLACEMENT, AFTER EVERYTHING (Jordan, Sep 18: "they need a
    // way to re upload content after it was already approved submitted and
    // delivered").
    //
    // The wall above is right by default: an approval is a decision, and a
    // silent new round would undo one nobody asked to undo. But the wall was
    // also the end of the conversation — an editor with a corrected file and no
    // open revision had no way in except a new file name dropped straight into
    // 05-Final-Video, which is exactly the hand-filing this system exists to
    // replace.
    //
    // So the wall stays and gains a door. The door needs a REASON, because that
    // is the whole difference between replacing a version and losing one: the
    // reason goes on the job's timeline under the name of whoever opened it,
    // the office is told, and the old version keeps its bytes, its round number
    // and its verdict. Nothing about this reaches the client — it does not
    // deliver, does not re-deliver, and does not message anybody outside the
    // hub. If the client already has the old file, somebody still has to send
    // the new one, and the Ready-to-send card is where that happens.
    const reason = (input.reopenReason ?? "").trim();
    if (!revisionOpen && !reason) {
      return {
        ok: false,
        message: `${slot.label} is already approved. If you need to replace it, say why and upload again — the approved version is kept.`,
        needsReason: true,
      };
    }
    if (!revisionOpen) {
      const sent = await prisma.reviewSubmission.findFirst({
        where: { projectId: input.projectId, deliverableId: input.deliverableId, slot: slot.slot, sentToClientAt: { not: null } },
        select: { sentToClientAt: true },
      });
      await prisma.activity.create({
        data: {
          projectId: input.projectId,
          type: "SYSTEM",
          body: `${who.name ?? "Somebody"} is replacing an approved ${slot.label}${sent ? " that had already gone to the client" : ""} — "${reason.slice(0, 200)}". The approved version is kept; the new one still has to be reviewed${sent ? " and re-sent" : ""}.`.slice(0, 500),
        },
      }).catch(() => {});
      // The office decides what a client is told, so it is told first.
      await import("@/lib/notify")
        .then(({ notifyInApp }) =>
          notifyInApp({
            kind: "cut_uploaded",
            title: `An approved video is being replaced — ${slot.label}`,
            body: `${who.name ?? "Somebody"}: "${reason.slice(0, 160)}"${sent ? " · this one had already gone to the client." : ""}`,
            href: `/review/${input.projectId}`,
            targets: [{ roles: ["OWNER", "ADMIN"] }],
            dedupeKey: `cut-reopen-${input.projectId}-${slot.slot}-${Date.now().toString(36)}`,
          }),
        )
        .catch(() => {});
    }
  }
  // Rounds count in-flight uploads too, so two tabs starting at once don't
  // both become "Version 1" (a failed one leaves a harmless gap). A WITHDRAWN
  // round FREES its number (Jordan, Sep 16: an editor who uploaded the wrong
  // file takes it back and sends the right one) — the corrected upload is
  // version 2, not version 3, and the editor's card and the Room agree.
  // READ-THEN-WRITE, SERIALISED PER SLOT (audit, Sep 17). Reading the highest
  // round and creating round+1 as two statements let two editors starting at
  // the same instant both become "Version 2" — two rows the Room cannot tell
  // apart, with notes and an approval landing on whichever one a later query
  // happened to return. A unique index is the wrong tool here because a
  // WITHDRAWN row keeps its number while FREEING it for reuse, so duplicates
  // are legal by design. Instead both statements run inside one transaction
  // behind an advisory lock on this slot alone: concurrent uploads to OTHER
  // slots and other jobs are unaffected, and the lock dies with the transaction
  // whatever happens next.
  const { round, row } = await prisma.$transaction(async (tx) => {
    const [lockA, lockB] = slotLockKey(input.projectId, input.deliverableId, slot.slot);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockA}, ${lockB})`;
    const highest = await tx.reviewSubmission.aggregate({
      where: { projectId: input.projectId, deliverableId: input.deliverableId, slot: slot.slot, status: { notIn: ["UPLOAD_FAILED", "WITHDRAWN"] } },
      _max: { round: true },
    });
    const next = (highest._max.round ?? 0) + 1;
    const created = await tx.reviewSubmission.create({
      data: {
        projectId: input.projectId,
        kind: "video",
        deliverableId: input.deliverableId,
        slot: slot.slot,
        round: next,
        status: "UPLOADING",
        source: "upload",
        fileName: input.fileName.slice(0, 200),
        sizeBytes: Number.isFinite(input.sizeBytes) ? Math.floor(input.sizeBytes) : null,
        // What arrived, as the browser measured it. finishCutUpload fills these
        // in from the file's own header when the browser couldn't.
        sourceWidth: Number.isFinite(Number(input.width)) && Number(input.width) > 0 ? Math.round(Number(input.width)) : null,
        sourceHeight: Number.isFinite(Number(input.height)) && Number(input.height) > 0 ? Math.round(Number(input.height)) : null,
        ...(waved ? { exportOverrideBy: who.name ?? "The office", exportOverrideAt: new Date() } : {}),
        submittedByKey: who.key,
        submittedByName: who.name,
      },
      select: { id: true },
    });
    return { round: next, row: created };
  });
  // An override is a decision, so it goes in the job's history in words — the
  // same place a removed cut leaves its one line. Best-effort: the upload is
  // already reserved, and a missing note must not cost the editor the upload.
  if (waved) {
    await prisma.activity.create({
      data: {
        projectId: input.projectId,
        type: "SYSTEM",
        body: `${who.name ?? "The office"} allowed an over-spec upload — ${resolutionLabel(input.width, input.height) ?? "larger than 1080p"}, ${input.fileName} (version ${round}). Cuts are meant to leave Final Cut at 1080p.`.slice(0, 500),
      },
    }).catch(() => {});
  }
  return { ok: true, submissionId: row.id, pathname: uploadPathnameFor(input.projectId, row.id, input.fileName), round };
}

export async function finishCutUpload(input: { submissionId: string; url: string; pathname: string }): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId }, select: { projectId: true, status: true, sourceWidth: true } });
  if (!row) return { ok: false, message: "That upload no longer exists." };
  const who = await uploadAuthor(row.projectId);
  if (!who.ok) return who;
  if (row.status !== "UPLOADING") return { ok: true, message: "Already in review." };
  // The blob must live in THIS store under THIS row's prefix — never attach a
  // foreign URL to a cut.
  if (!input.pathname.startsWith(`review-cuts/${row.projectId}/${input.submissionId}/`) || !/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//.test(input.url)) {
    return { ok: false, message: "That file doesn't belong to this cut." };
  }
  // Prove the bytes are really in the store before calling it a cut.
  let size: number | null = null;
  try {
    const { head } = await import("@vercel/blob");
    const meta = await head(input.url);
    size = meta.size;
    if (meta.pathname !== input.pathname) return { ok: false, message: "Upload mismatch — try again." };
  } catch {
    return { ok: false, message: "The file didn't land in the store — try the upload again." };
  }
  const { finalizeCutUpload } = await import("@/lib/reviewCuts");
  const r = await finalizeCutUpload(input.submissionId, { url: input.url, pathname: input.pathname, size });
  // Only when the browser came up empty — its measurement is the one the gate
  // acted on, and re-reading a file we already measured buys nothing.
  //
  // AFTER the response, not before it (Sep 16 review). The cut is already in
  // front of the reviewer by this line; awaiting the probe here only made the
  // editor watch "Checking the file…" for up to another six seconds for a
  // number that is nobody's blocker. Next's `after` runs the callback once the
  // response is finished and keeps the function alive to do it, which is
  // exactly the shape of this work (next/server — Next 16 docs, 04-functions/
  // after.md). Same reader the folder door uses (lib/reviewCuts) — one copy.
  if (r.ok && row.sourceWidth == null) {
    afterSafe(async () => {
      const { recordArrivedDimensions } = await import("@/lib/reviewCuts");
      await recordArrivedDimensions(input.submissionId, input.url, size);
    });
  }
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: input.submissionId }, select: { projectId: true } });
  if (sub) {
    await syncOutputs(sub.projectId);
    refresh(sub.projectId);
  }
  return r;
}

export async function abandonCutUpload(submissionId: string, blobUrl?: string | null): Promise<void> {
  const row = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true } });
  if (!row) return;
  const who = await uploadAuthor(row.projectId);
  if (!who.ok) return;
  await prisma.reviewSubmission.updateMany({
    where: { id: submissionId, status: "UPLOADING" },
    data: { status: "UPLOAD_FAILED" },
  }).catch(() => {});
  // Bytes that landed but never became a cut have no reason to stay public.
  if (blobUrl && /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/review-cuts\//.test(blobUrl)) {
    try {
      const { del } = await import("@vercel/blob");
      await del(blobUrl);
    } catch { /* the retention sweep catches strays */ }
  }
}


// ===========================================================================
// WRONG VIDEO — REMOVE / MOVE (Jordan, Sep 16 2026, in the order he said it):
//   1. "I want the editor to be able to remove the video from upload / for
//      review in case they mistakenly upload the wrong video or to the wrong
//      project." (…"it would also be cool if they could reassign that video to
//      a different project.")
//   2. "If I approved the cut - leave it and flag it with the option to remove
//      it if I want."
//   3. And, decisively, that evening: "When removing the cut, I want it to
//      remove completely."
//
// So this is no longer a withdrawal. REMOVE MEANS GONE:
//   · the file in the hub's store is deleted, the version's review notes are
//     deleted, and the ReviewSubmission row itself is deleted. The version
//     number frees because the row that held it no longer exists.
//   · THE ONE THING THAT SURVIVES is a single Activity line on the job —
//     who removed which version, of what file, and why. That is deliberate,
//     and it is the only trace kept: a client deliverable must never disappear
//     with no record of who removed it. (The client's own portal comments stay
//     too — they are the client's words on the job, not our record of the cut.)
//   · the job is released exactly as the withdrawal released it: a client's
//     revision the cut had parked "waiting on review" goes back to OPEN in the
//     client's own words, a job the cut had pushed to REVIEW steps back to
//     where it stood (reviewCuts.correctedCutWithdrawn), the round it had
//     superseded comes back to the Room, and the editor's card reopens.
//     A pinned or DELIVERED job is never moved.
//   · MOVE is unchanged, and is still the right answer when the video is fine
//     and the JOB is wrong: the same row, the same bytes, the same notes,
//     re-resolved to the target's own (deliverable × slot) and its next round.
//     The job it leaves is released the same way.
//   · AN APPROVED CUT IS STILL THE OFFICE'S CALL (rule 2 stands). Only
//     OWNER/ADMIN may remove one; the confirm names its file in the job's
//     Final folder and offers, defaulting OFF, to delete that too — the ONLY
//     Dropbox write in this batch. Left unticked (or if Dropbox refuses), the
//     file stays and the row that used to carry the flag is gone, so the
//     leftover is recorded as a SmartTask for the office instead, and said out
//     loud on the timeline line.
// ===========================================================================


/** Who is asking, and every key they are addressable by. `office` = the
 *  review desk (Jordan or Kyle); an EDITOR passes only for a cut THEY sent in.
 *  Same key resolution as requireTaskAccess — editor key, login-name slug,
 *  roster-name slug — so an editor renamed away from the roster spelling
 *  doesn't lose the ability to take their own cut back. */
type TakeBackActor = { office: boolean; owner: boolean; keys: Set<string>; name: string };

async function takeBackActor(): Promise<{ ok: true; actor: TakeBackActor } | { ok: false; message: string }> {
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    // Same rule as every other guard: local dev with auth off acts as the desk.
    if (!authEnforced()) return { ok: true, actor: { office: true, owner: true, keys: new Set(), name: "Local dev" } };
    return { ok: false, message: "Sign in to take a cut back." };
  }
  // "View as" is read-only platform-wide — a previewing owner must not withdraw
  // a cut under an editor's name.
  if (me.impersonating) return { ok: false, message: "You're previewing another user — exit the preview to make changes." };
  const office = me.realRole === "OWNER" || me.realRole === "ADMIN";
  if (!office && me.realRole !== "EDITOR") {
    return { ok: false, message: "Only the editor who sent this cut in, Jordan or Kyle can take it back." };
  }
  const keys = new Set<string>();
  if (me.editorKey) keys.add(me.editorKey);
  if (me.name) keys.add(slugForName(me.name));
  if (me.teamMemberId) {
    const tm = await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { name: true } }).catch(() => null);
    if (tm?.name) keys.add(slugForName(tm.name));
  }
  keys.delete("");
  return { ok: true, actor: { office, owner: me.realRole === "OWNER", keys, name: me.name ?? me.email ?? "Someone" } };
}

/** The refusals, in plain words (Jordan's rule 4). Null = go ahead.
 *
 *  Two modes, because the two actions don't refuse the same rows (Sep 16):
 *   · "remove" deletes the version. A SUPERSEDED round, or one of the legacy
 *     WITHDRAWN rows, is history nobody is waiting on — removing it is exactly
 *     the tidy-up Jordan asked for, so it is allowed.
 *   · "move" lands the version on another job as the cut waiting there. An old
 *     round has no business becoming that, so both stay refused — reassignCut
 *     behaves exactly as it did this afternoon. */
function whyNotTakeBack(
  sub: { status: string; submittedByKey: string | null; strandedFinalPath?: string | null },
  actor: TakeBackActor,
  mode: "remove" | "move",
): string | null {
  const verb = mode === "move" ? "move" : "remove";
  if (sub.status === "UPLOADING") return `That version is still uploading — wait for the upload to finish, then ${verb} it.`;
  if (sub.status === "UPLOAD_FAILED") return `That upload never finished, so there's nothing in review to ${verb}.`;
  if (mode === "move" && sub.status === "WITHDRAWN") return "That version was withdrawn — upload the file on the right job instead.";
  if (mode === "move" && sub.status === "SUPERSEDED") return "A newer version of this cut has replaced that one — move the newest version instead.";
  const mine = !!sub.submittedByKey && actor.keys.has(sub.submittedByKey);
  if (!actor.office && !mine) return `That cut was sent in by someone else — ask Jordan or Kyle to ${verb} it.`;
  // Jordan's call, in his words: an approved cut is his to pull, not the
  // editor's. Name the reviewer so the refusal tells them what to do next.
  if (sub.status === "APPROVED" && !actor.office) {
    return mode === "move"
      ? "Jordan has already approved this cut, so moving it is his call — message him or Kyle and they'll do it."
      : "Jordan has already approved this cut, so removing it is his call — message him or Kyle and they'll pull it.";
  }
  // A row that carries a stranded path WAS approved — one of the afternoon's
  // withdrawals, or an approved cut that has since been moved. Jordan's rule
  // follows the cut, not the status it ended in.
  //
  // REMOVE ONLY. Moving such a row is the same move it always was, and this
  // clause was quietly taking that away from the editor who holds the job —
  // and telling them "removing it for good is his call" while they were trying
  // to move it (reviewer, Sep 16). Move behaves exactly as it did at HEAD.
  if (mode === "remove" && !actor.office && sub.strandedFinalPath) {
    return "Jordan approved this cut before it was pulled, so removing it for good is his call — message him or Kyle.";
  }
  return null;
}

/** A cut's status in the words the Room uses, for the one message that has to
 *  say what changed under someone's hands. */
function cutStatusWords(status: string): string {
  switch (status) {
    case "PENDING": return "waiting on review";
    case "CHANGES_REQUESTED": return "in revisions";
    case "APPROVED": return "approved";
    case "SUPERSEDED": return "replaced by a newer version";
    case "WITHDRAWN": return "withdrawn";
    case "UPLOADING": return "still uploading";
    case "UPLOAD_FAILED": return "a failed upload";
    default: return status.toLowerCase().replace(/_/g, " ");
  }
}

/** Thrown inside the removal transaction when somebody else got there first,
 *  so the whole thing rolls back instead of half-deleting a version that is
 *  already gone. A plain sentinel — a "use server" file exports actions only. */
const LOST_THE_RACE = "cut-removal:lost-the-race";

/** THE REMOVAL ITSELF, and the record of it, in ONE transaction: the version's
 *  review notes, the row, and the single Activity line that outlives them.
 *  Either all three land or none do — a client deliverable must never
 *  disappear with no record of who removed it (Jordan, Sep 16).
 *
 *  GUARDED on the status we read: two tabs — or one double-click — both clear
 *  whyNotTakeBack, and an unguarded delete ran the whole release twice,
 *  writing two Activity lines and ringing two bells (ringRemoved's key carries
 *  its own timestamp, so the dedupe can't catch it). Exactly one caller wins;
 *  the loser is told it is already done.
 *
 *  On success: the Activity row's id, so the file cleanup below can fold "what
 *  is still there" into that same one line. Otherwise it says WHICH race was
 *  lost — the row is gone, or it is still there wearing a different status —
 *  because those two need different sentences and only one of them is "already
 *  removed" (reviewer, Sep 16). */
type CutRowRemoved = { activityId: string; notesRemoved: number; noteKeyKept: string | null };
type CutRowLost = { lost: "gone" } | { lost: "changed"; status: string };

async function deleteCutRow(
  sub: { id: string; projectId: string; status: string; assetUrl: string | null },
  line: string,
): Promise<CutRowRemoved | CutRowLost> {
  const { cutNoteKey, isOwnCutNoteKey } = await import("@/lib/reviewCuts");
  const key = cutNoteKey(sub);
  // A key that doesn't name THIS submission belongs to some other era and
  // could be shared with another round — leave those notes and say so.
  const own = isOwnCutNoteKey(key, sub.id);
  try {
    return await prisma.$transaction(async (tx) => {
      const gone = await tx.reviewSubmission.deleteMany({ where: { id: sub.id, status: sub.status } });
      if (gone.count === 0) throw new Error(LOST_THE_RACE);
      // This version's review notes — roots and their replies, which carry the
      // same key (replyCutNote copies it). Nothing keyed to another round can
      // match: the key contains this submission's own id.
      const notes = own
        ? await tx.mediaNote.deleteMany({ where: { projectId: sub.projectId, assetUrl: key } })
        : { count: 0 };
      const activity = await tx.activity.create({
        data: { projectId: sub.projectId, type: "SYSTEM", body: line.slice(0, 500) },
      });
      return { activityId: activity.id, notesRemoved: notes.count, noteKeyKept: own ? null : key };
    });
  } catch (e) {
    if ((e as Error)?.message === LOST_THE_RACE) {
      // Two very different things produce that zero, and the guard is on
      // (id, status) so BOTH land here: somebody else removed the row, or a
      // verdict / a bounce / a newer round landed on it between the read and
      // the delete. Telling the second one "already removed" would be a lie
      // about a version that is still very much there — re-read and say which
      // it was (reviewer, Sep 16).
      const now = await prisma.reviewSubmission
        .findUnique({ where: { id: sub.id }, select: { status: true } })
        .catch(() => null);
      return now ? { lost: "changed", status: now.status } : { lost: "gone" };
    }
    throw e;
  }
}

/** The leftover Dropbox file, once the row that used to carry the flag is
 *  gone (Jordan, Sep 16: leave the file if he doesn't tick the box — but the
 *  hub still has to remember it is there). One task for the office, keyed on
 *  the submission that used to hold the path, carrying the path itself in
 *  sourceDetail — which is now doing two jobs: removeStrandedFinal acts on it
 *  later, and reviewCuts.removedCutLeftovers reads it so the folder sweep and
 *  the editor's "Send for review" button stop re-discovering the very video
 *  that was pulled (reviewer, Sep 16). Written whenever a Dropbox file is left
 *  behind — not only for an approved cut's copy. */
async function strandedFinalTask(input: {
  projectId: string;
  submissionId: string;
  path: string;
  round: number;
  fileName: string | null;
  street: string;
  actorName: string;
  reason: string;
  /** what the file IS, because the two are not the same thing to whoever picks
   *  this up: "hub-copy" is the copy the hub itself placed when the cut was
   *  approved; "folder-source" is the editor's own export, which is where a
   *  folder-discovered row came from in the first place. */
  kind: "hub-copy" | "folder-source";
  dropboxRefused: boolean;
}): Promise<void> {
  // The house pattern for "whoever holds the office queue" — twenty-odd call
  // sites resolve Kyle exactly this way. The ROUTING rides on assignedKey,
  // which is a constant; this lookup only puts a face on the card, so it is
  // matched the careful way notify.ts does it: case-insensitive, and never a
  // roster row that has been deactivated.
  const kyle = await prisma.teamMember
    .findFirst({ where: { name: { contains: "Kyle", mode: "insensitive" }, active: true }, select: { id: true } })
    .catch(() => null);
  // The path whole is longer than a title should be; keep its tail (the folder
  // and the file are what identify it) and put the whole thing in the body.
  const parts = input.path.split("/").filter(Boolean);
  const shortPath = input.path.length <= 78 ? input.path : `…/${parts.slice(-2).join("/")}`;
  const whyItIsThere =
    input.kind === "folder-source"
      ? "That cut was discovered from a file the editor had already put in the job's Final folder, and that export is theirs, not a copy the hub made — so the hub left it exactly where it is: "
      : input.dropboxRefused
        ? "Dropbox wouldn't delete the finished file, so it is still in the job's Final folder: "
        : "The finished file was left in the job's Final folder on purpose: ";
  const data = {
    taskType: "internal_instruction", // the type Open Loops + /tasks triage read
    title: `A removed cut's file is still in Dropbox — ${shortPath}`.slice(0, 120),
    summary:
      `${input.actorName} removed version ${input.round}${input.fileName ? ` (${input.fileName})` : ""} on ${input.street} — “${input.reason}”. ` +
      whyItIsThere +
      input.path,
    description:
      `Delete it in Dropbox if it shouldn't be there:\n${input.path}\n\n` +
      "The version itself is gone from the hub — this file is all that is left of it.\n" +
      "While this task is here the hub will not pull that file back into the Review Room; a NEW export over the same path still comes in as a fresh cut.",
    reasonCreated: "A cut was removed and its Dropbox file was kept",
    source: "system",
    // The exact path, machine-readable: removeStrandedFinal reads it from here
    // once the ReviewSubmission that used to carry it no longer exists.
    sourceDetail: input.path,
    priority: "MEDIUM",
    assignedKey: "kyle",
    ownerId: kyle?.id ?? null,
    projectId: input.projectId,
    dedupeKey: `stranded-final-${input.submissionId}`,
  } as const;
  await prisma.smartTask
    .upsert({
      where: { dedupeKey: data.dedupeKey },
      // Removing the same cut twice is impossible (the row is gone), so an
      // existing row means a hand-closed task and a repeat of the same fact.
      update: { ...data, status: "OPEN", completedAt: null },
      create: data,
    })
    .catch(() => { /* the timeline line still names the file */ });
}

/** The job a cut has LEFT — identical for a removal and for a move (Jordan:
 *  the source job is left exactly as a withdrawal left it). Four writes, in
 *  this order, because each one reads what the last left behind:
 *   1. the round this one superseded comes back to the Room (so step 2 sees a
 *      cut still waiting and leaves the stage alone);
 *   2. the client's ask and the job's stage step back (correctedCutWithdrawn);
 *   3. the editor's work item reopens if the job now owes a video and nobody
 *      holds one — without it the editor has no door back in (BLOCKER, Sep 16);
 *   4. the Activity line.
 *  `line` is null when the caller already wrote its own — a removal writes
 *  the line in the same transaction as the delete, so the record can't be
 *  lost with the row. */
async function releaseSourceJob(
  projectId: string,
  cut: { id: string; deliverableId: string | null; slot: number | null; round: number; submittedByKey: string | null },
  line: string | null,
): Promise<{ status: string | null; restoredRound: number | null }> {
  const { correctedCutWithdrawn, restorePriorCutRound, reopenEditCardAfterTakeBack } = await import("@/lib/reviewCuts");
  const restoredRound = await restorePriorCutRound(projectId, cut).catch(() => null);
  const r = await correctedCutWithdrawn(projectId, { excludeSubmissionId: cut.id }).catch(() => ({ reopened: 0, status: null }));
  await reopenEditCardAfterTakeBack(projectId, cut.submittedByKey).catch(() => false);
  if (line) await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: line.slice(0, 500) } }).catch(() => {});
  return { status: r.status, restoredRound };
}

/** One bell to the review desk. NOT a re-announcement: announceCutInReview's
 *  row for this cut is already out and stays deduped on the submission id, so
 *  nobody is told twice that the video is ready — this is the correction,
 *  addressed to the people who were going to watch it. The kind stays
 *  `review_withdrawn` (a wire value, and deliberately unmapped in notifyPrefs,
 *  which makes it bell-only: a cut coming back out is worth a row on Jordan's
 *  bell, never a text) even though the words now say "removed".
 *
 *  The link goes to the JOB, not to `?cut=<id>` as it did while the row
 *  survived: the version is gone, so a deep link to it would land the reviewer
 *  on nothing (Sep 16). */
async function ringRemoved(input: {
  projectId: string;
  submissionId: string;
  sentence: string;
  title: string;
  /** the removal's own stamp — the key, so a double-click rings once */
  at: Date;
}): Promise<void> {
  try {
    await notifyInApp({
      kind: "review_withdrawn",
      title: input.title,
      body: input.sentence,
      href: `/review/${input.projectId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `cut-withdrawn-${input.submissionId}-${input.at.getTime()}`,
    });
  } catch { /* bell is best-effort */ }
}

// A take-back that fails must SAY so. These actions are called from a client
// dialog whose catch renders a bare "That didn't work — try again.", which is
// what Jordan saw on Sep 16 when a running server still held a Prisma client
// generated before the withdraw columns existed: the action threw, the dialog
// shrugged, and nothing in the message said the deploy was the problem. Any
// unexpected error now comes back as a sentence a person can act on, and the
// stack goes to the server log.
async function takeBackGuard<T extends { ok: boolean; message: string }>(
  what: string,
  run: () => Promise<T>,
): Promise<T | { ok: false; message: string }> {
  try {
    return await run();
  } catch (e) {
    const detail = (e as Error)?.message ?? "";
    console.error(`[review] ${what} failed`, e);
    const stale = /Unknown (field|arg(ument)?)|does not exist in the current database|PrismaClientValidationError/i.test(detail);
    return {
      ok: false,
      message: stale
        ? `Couldn't ${what} — this copy of the hub is running older code than the database. Reload the page; if it keeps happening, the site needs a redeploy.`
        : `Couldn't ${what} — nothing was changed. Tell Jordan or Kyle what you were doing so it can be looked at.`,
    };
  }
}

// ---------------------------------------------------------------------------
// 1 · REMOVE — Jordan, Sep 16: "When removing the cut, I want it to remove
//     completely." The file, the notes and the row all go; one Activity line
//     stays behind and that is the whole record.
// ---------------------------------------------------------------------------
export async function removeCut(
  submissionId: string,
  reason: string,
  /** APPROVED cuts only, office only: take the finished file in the job's
   *  Final folder with it. Defaults OFF — Jordan's rule 2 ("leave it and flag
   *  it") is still the default answer; ticking the box is the exception. */
  alsoDeleteDropboxFile = false,
): Promise<{ ok: boolean; message: string }> {
  return takeBackGuard("remove that version", () =>
    removeCutInner(submissionId, reason, alsoDeleteDropboxFile),
  ) as Promise<{ ok: boolean; message: string }>;
}

/** @deprecated Sep 16 — a take-back removes the version outright now. Kept
 *  ONLY so a tab still running this afternoon's bundle doesn't blow up on a
 *  missing export mid-deploy; delete it once nothing calls it.
 *
 *  It deliberately does NOT remove. That bundle's dialog is still on screen
 *  saying "Nothing is deleted — the file stays, and the next upload takes
 *  version N again", and its button calls this. Doing the new, permanent thing
 *  under the old words would delete a client deliverable that the person
 *  pressing the button was told would be kept (reviewer, Sep 16). A refusal
 *  keeps the deploy safe and costs them one reload. */
export async function withdrawCut(): Promise<{ ok: boolean; message: string }> {
  return {
    ok: false,
    message:
      "Reload the page — taking a cut back now REMOVES it for good, and this page is still showing the old words that promised the file would be kept.",
  };
}

async function removeCutInner(
  submissionId: string,
  reason: string,
  alsoDeleteDropboxFile: boolean,
): Promise<{ ok: boolean; message: string }> {
  const who = await takeBackActor();
  if (!who.ok) return { ok: false, message: who.message };
  const why = (reason ?? "").trim().slice(0, 300);
  // The reason carries more weight than it did: once the row is gone it is the
  // only thing on the timeline that explains the gap.
  if (!why) return { ok: false, message: "Say what went wrong in a few words — it's the only record left once the version is gone." };

  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true, projectId: true, round: true, status: true, fileName: true,
      assetUrl: true, blobUrl: true, blobPathname: true,
      // assetPath is the OTHER Dropbox file a cut can have — see the two kinds
      // below. Without it a folder-discovered cut was "removed" while its file
      // sat untouched in the Final folder and nothing said so (reviewer).
      assetPath: true, finalPath: true, strandedFinalPath: true,
      deliverableId: true, slot: true,
      submittedByKey: true,
      project: { select: { title: true } },
    },
  });
  if (!sub) return { ok: false, message: "That version no longer exists." };
  const refusal = whyNotTakeBack(sub, who.actor, "remove");
  if (refusal) return { ok: false, message: refusal };

  const street = streetOf(sub.project?.title);
  const wasApproved = sub.status === "APPROVED";

  // THE TWO DROPBOX FILES A CUT CAN HAVE, and they are not the same thing
  // (reviewer, Sep 16 — eleven of the twenty-five live rows are the second
  // kind, five of them PENDING, which is exactly what an editor pulls):
  //
  //  · hubCopyPath — finalPath, or strandedFinalPath on a row withdrawn or
  //    moved earlier. This is the copy THE HUB made when the cut was approved.
  //    Ours to delete, and the checkbox is Jordan's choice about it.
  //  · folderSourcePath — assetPath, a folder-discovered row's own source
  //    file: the editor's export, already sitting in 05-Final-Video, which is
  //    where the row came from. NOT ours to delete — Jordan authorised exactly
  //    one Dropbox write ("also delete the finished file"), and taking an
  //    editor's only copy of their work on a "remove the wrong upload" press
  //    is not that. It is always LEFT — but never silently: it is named in the
  //    message, on the timeline line and on the office's queue, and the task
  //    stops the folder sweep handing the same video straight back.
  //
  // (An upload row has assetPath nulled by finalizeCutUpload and a folder row
  // never gets a finalPath, so in practice a cut has at most one of them —
  // verified across every row in production. The code still reports both if a
  // row ever carried both, rather than quietly dropping one.)
  const hubCopyPath = sub.finalPath ?? sub.strandedFinalPath;
  const folderSourcePath = sub.assetPath && sub.assetPath !== hubCopyPath ? sub.assetPath : null;
  // Only the office may take the Dropbox file with it, and only the hub's own
  // copy — an editor ticking a box they can't see must never reach dbx.
  const takeDropboxToo = alsoDeleteDropboxFile && who.actor.office && !!hubCopyPath;
  const fileLabel = sub.fileName ?? (hubCopyPath ?? folderSourcePath)?.split("/").pop() ?? "no file name";

  // THE ONE THING THAT SURVIVES. Deliberate, and the only trace kept: a client
  // deliverable must never disappear with no record of who removed it. It goes
  // in the SAME transaction as the delete, so the row and its record can never
  // come apart; what the file cleanup below couldn't take is folded into this
  // same line rather than added as a second one.
  const line = `${who.actor.name} removed version ${sub.round} (${fileLabel}) — “${why}”.`;
  const done = await deleteCutRow(sub, line);
  if ("lost" in done) {
    return {
      ok: false,
      message: done.lost === "gone"
        ? "That version has already been removed."
        : `That version changed while you had this open — it's now ${cutStatusWords(done.status)}, so nothing was removed. Close this and open it again to see where it stands.`,
    };
  }
  const at = new Date();

  // THE JOB GOES FIRST, before any of the file cleanup below (reviewer,
  // Sep 16). Everything from here to the end is best-effort network work, and
  // a server-action timeout in the middle of it used to leave the row deleted
  // but the job still sitting in REVIEW, the client's ask still parked
  // "waiting on review" and the editor's card still closed — a half-state the
  // old withdrawal could never reach, because it released the moment it
  // flipped the status. Row gone, job released, then the files.
  const { status, restoredRound } = await releaseSourceJob(sub.projectId, sub, null);

  // A cut the client already had in their portal library goes out of it with
  // the row — it must not keep playing on /portal for a version that no longer
  // exists. Unconditional: only an approved cut is ever added (addApprovedCutToLibrary),
  // so this is a no-op on everything else, and it still catches a cut that was
  // approved, added, and later bounced. The hourly library sweep only ever
  // re-adds Aryeo-keyed rows, so this stays removed.
  await prisma.portalVideo.deleteMany({ where: { externalKey: `sub:${sub.id}` } }).catch(() => { /* library is best-effort */ });

  // THE FILES. Best-effort by design — a store that is down must not strand
  // the removal half-done — but nothing is silently left behind: every failure
  // is logged, said in the message, and written onto the timeline line.
  const leftBehind: string[] = [];
  let hubCopyDeleted = false;
  if (sub.blobUrl) {
    // The same shape check abandonCutUpload makes before it deletes: this path
    // may only ever delete cut bytes in THIS store, so a row carrying a URL
    // from anywhere else is left alone and said out loud rather than handed to
    // del() on trust (reviewer, Sep 16).
    if (!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/review-cuts\//.test(sub.blobUrl)) {
      console.error("[review] refused to delete a foreign blob url on removed cut", sub.id, sub.blobUrl);
      leftBehind.push(`Its video file isn't in the hub's cut store, so it was left where it is: ${sub.blobPathname ?? sub.blobUrl}.`);
    } else {
      try {
        const { del } = await import("@vercel/blob");
        await del(sub.blobUrl);
        hubCopyDeleted = true;
      } catch (e) {
        console.error("[review] blob delete failed for removed cut", sub.id, e);
        leftBehind.push(`The video file could not be deleted from the hub's store — it is still at ${sub.blobPathname ?? sub.blobUrl}.`);
      }
    }
  }
  // The hub's own copy in Dropbox — the only file the checkbox governs.
  let dropboxFileDeleted = false;
  if (hubCopyPath) {
    if (takeDropboxToo) {
      try {
        // The ONE Dropbox write in this batch: exactly the file recorded on
        // the row, nothing else.
        const { dropboxDelete } = await import("@/lib/integrations/dropbox");
        await dropboxDelete(hubCopyPath);
        dropboxFileDeleted = true;
      } catch (e) {
        console.error("[review] dropbox delete failed for removed cut", sub.id, e);
        leftBehind.push(`Dropbox wouldn't delete the finished file — it is still at ${hubCopyPath}.`);
      }
    } else {
      leftBehind.push(`The finished file is still in Dropbox: ${hubCopyPath}`);
    }
  }
  // The editor's own export, if that is what this row was discovered from.
  // Always kept, and never quiet.
  if (folderSourcePath) {
    leftBehind.push(`The file it was discovered from is still in the job's Final folder: ${folderSourcePath}`);
  }
  // ONE record of the leftover, on the office's own queue — the row that used
  // to carry the flag is gone, so this is where the hub remembers the file is
  // there, and it is also what stops the folder sweep and the editor's "Send
  // for review" button handing the same video straight back (reviewer).
  // A cut has at most one of the two paths (verified across production), so
  // one task is one file; if a row ever carried both, the hub's own copy is
  // the actionable one and the other is still named on the line above.
  const leftoverPath = dropboxFileDeleted ? null : (hubCopyPath ?? folderSourcePath);
  if (leftoverPath) {
    await strandedFinalTask({
      projectId: sub.projectId, submissionId: sub.id, path: leftoverPath,
      round: sub.round, fileName: sub.fileName, street,
      actorName: who.actor.name, reason: why,
      kind: leftoverPath === hubCopyPath ? "hub-copy" : "folder-source",
      dropboxRefused: takeDropboxToo,
    });
  }
  if (done.noteKeyKept) {
    // Never seen in production (every cut note is keyed to its own submission)
    // — but if a row ever threads notes under a key it doesn't own, they stay
    // rather than risk taking another round's feedback with them.
    leftBehind.push("Its review notes were left in place — they aren't keyed to this version alone.");
  }
  if (leftBehind.length > 0) {
    await prisma.activity
      .update({ where: { id: done.activityId }, data: { body: `${line} ${leftBehind.join(" ")}`.slice(0, 500) } })
      .catch(() => { /* the base line is already on the timeline */ });
  }

  await ringRemoved({
    projectId: sub.projectId,
    submissionId: sub.id,
    title: `Cut removed — ${street}`,
    sentence: `${who.actor.name} removed version ${sub.round}: “${why}”`,
    at,
  });

  // THE PER-VIDEO ROW HAS TO HEAR ABOUT THIS (reviewer, Sep 18). A removal
  // DELETES the submission row, so an output that pointed at it —
  // currentSubmissionId, and approvedSubmissionId/approvedAt on a cut Jordan
  // had signed off — is left naming a row that no longer exists and asserting
  // an approval nobody stands behind. refreshOutputsForProject re-derives every
  // stamp from the rounds that survive, including back to null; without this
  // call it never ran on the one event that can retract one.
  await syncOutputs(sub.projectId);
  refresh(sub.projectId);
  revalidatePath(`/projects/${sub.projectId}`);
  const stage =
    status === "REVISION" ? ` ${street} is back in Revisions with the client's ask open.` :
    status === "EDITING" ? ` ${street} is back in Editing.` : "";
  // The round this one had replaced is the newest version anybody stands
  // behind again, so say so — it is back in front of the reviewer.
  const restored = restoredRound ? ` Version ${restoredRound} is back in the Room in its place.` : "";
  const notes = done.notesRemoved > 0 ? ` ${done.notesRemoved} review note${done.notesRemoved === 1 ? "" : "s"} went with it.` : "";
  // Say only what actually went. The old wording promised "the version and its
  // file" every time, which was a lie on a folder-discovered cut — the row
  // went and the video stayed exactly where it was (reviewer, Sep 16).
  const alsoTheFile = hubCopyDeleted ? ", and its copy in the hub with it" : "";
  return {
    ok: true,
    message:
      `Removed — version ${sub.round} is gone${alsoTheFile}.${notes} Version ${sub.round} is free again for the right file.${stage}${restored}` +
      (dropboxFileDeleted
        ? ` The finished file was deleted from Dropbox too (${hubCopyPath!.split("/").pop()}).`
        : hubCopyPath
          ? ` The finished file is still in Dropbox (${hubCopyPath.split("/").pop()}) — it's on Kyle's queue with the full path.`
          : "") +
      (folderSourcePath
        ? ` The video itself is still in the job's Final folder (${folderSourcePath.split("/").pop()}) — that's the editor's own export, not a copy the hub made, so it was left there. It's on Kyle's queue with the full path, and it won't come back into the Room on its own.`
        : "") +
      (leftBehind.some((s) => s.startsWith("The video file") || s.startsWith("Its video file"))
        ? " The hub's copy couldn't be deleted — the timeline line says where it still is."
        : "") +
      // Pulling a cut Jordan signed off doesn't un-close what the approval
      // closed (correctedCutWithdrawn's note) — tell the office plainly rather
      // than let them assume the client's ask came back with it.
      (wasApproved ? " The client's revision that approval closed stays closed — raise it again if they still need the fix." : ""),
  };
}

// ---------------------------------------------------------------------------
// 2 · MOVE TO ANOTHER JOB
// ---------------------------------------------------------------------------
export async function reassignCut(
  submissionId: string,
  targetProjectId: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  return takeBackGuard("move that cut", () => reassignCutInner(submissionId, targetProjectId, note)) as Promise<{ ok: boolean; message: string }>;
}

async function reassignCutInner(
  submissionId: string,
  targetProjectId: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  const who = await takeBackActor();
  if (!who.ok) return { ok: false, message: who.message };

  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true, projectId: true, round: true, status: true, fileName: true, assetUrl: true, assetPath: true,
      finalPath: true, note: true, deliverableId: true, slot: true, submittedByKey: true, submittedByName: true,
      project: { select: { title: true } },
    },
  });
  if (!sub) return { ok: false, message: "That version no longer exists." };
  const refusal = whyNotTakeBack(sub, who.actor, "move");
  if (refusal) return { ok: false, message: refusal };
  if (!targetProjectId || targetProjectId === sub.projectId) {
    return { ok: false, message: "That's the job this cut is already on — pick a different one." };
  }

  const target = await prisma.project.findUnique({
    where: { id: targetProjectId },
    select: { id: true, title: true, status: true, statusPinnedAt: true },
  });
  if (!target) return { ok: false, message: "Pick a job to move it to." };
  const targetStreet = streetOf(target.title);
  if (target.status === "CANCELLED") return { ok: false, message: `${targetStreet} is cancelled — pick another job.` };
  // An editor may only move a cut onto a job they actually hold — the same
  // scope startCutUpload enforces, because an editor must never be able to
  // drop a video onto a co-editor's job.
  if (!who.actor.office) {
    const mine = await prisma.smartTask.findFirst({
      where: {
        projectId: target.id,
        taskType: { in: ["edit_video", "revision"] },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        assignedKey: { in: [...who.actor.keys] },
      },
      select: { id: true },
    });
    if (!mine) return { ok: false, message: `${targetStreet} isn't on your queue — ask Kyle or Jordan to move it there for you.` };
  }

  // Where it lands: the target's own (deliverable × slot) and its next round —
  // re-resolved through cutSlots/effectiveSlotCounts, so a 4-video month has
  // four places for it and the office's "videos owed" override still rules.
  const { pickCutSlotForMove, announceCutInReview } = await import("@/lib/reviewCuts");
  const pick = await pickCutSlotForMove(target.id);
  if (!pick.ok) {
    return {
      ok: false,
      message: pick.reason === "no-video"
        ? `${targetStreet} has no video on its order, so there's no cut for this video to become — add the video to the order first.`
        // Landing a new PENDING round on a signed-off slot would drop that
        // job's approved count and re-open its deliver gate (reviewer, Sep 16).
        : `Every cut on ${targetStreet} is already approved, so this video has nowhere to land there — pick another job, or add the video to that order first.`,
    };
  }
  const landing = pick.target;

  const movedAt = new Date();
  const sourceStreet = streetOf(sub.project?.title);
  const noteText = (note ?? "").trim().slice(0, 1000) || null;
  // An APPROVED cut's Dropbox copy belongs to the job it was approved on: it
  // stays in that folder, flagged, and this row stops calling itself complete.
  // (If Dropbox folder discovery is ever switched back on — Settings → Review
  // Room, off by default — that leftover file is discoverable on the SOURCE
  // job as a fresh cut until the office removes it with the flag's control.)
  const stranded = sub.status === "APPROVED" ? sub.finalPath : null;
  let moved = 0;
  try {
    // Guarded on the status we read, exactly like markWithdrawn: two presses
    // must not both run the source-job release.
    moved = (await prisma.reviewSubmission.updateMany({
      where: { id: sub.id, status: sub.status },
      data: {
        projectId: target.id,
        deliverableId: landing.deliverableId,
        slot: landing.slot,
        round: landing.round,
        status: "PENDING",
        decidedAt: null,
        decidedBy: null,
        ...(stranded ? { strandedFinalPath: stranded, finalPath: null, completedAt: null, dropboxJobId: null } : {}),
        movedFromProjectId: sub.projectId,
        movedAt,
        movedBy: who.actor.name,
        ...(noteText ? { note: noteText } : {}),
      },
    })).count;
  } catch (e) {
    // (projectId, assetPath, round) is unique — a folder-discovered cut from
    // the same file is already sitting on that job.
    if ((e as { code?: string })?.code === "P2002") {
      return { ok: false, message: `A cut from that same file is already on ${targetStreet} — nothing was moved.` };
    }
    throw e;
  }
  if (moved === 0) return { ok: false, message: "That version has already been moved or withdrawn." };
  // The cut keeps its notes: they are keyed by the cut's own asset URL, which
  // is unique per submission, so the whole thread (roots and replies) follows
  // the video to the job it now belongs to. The CLIENT's portal comments do
  // NOT follow — they are the source client's words on the source job.
  const assetKey = sub.assetUrl ?? `cut:${sub.id}`;
  await prisma.mediaNote.updateMany({ where: { projectId: sub.projectId, assetUrl: assetKey }, data: { projectId: target.id } }).catch(() => {});
  // An approved cut that moves also leaves the SOURCE client's portal library:
  // the row is keyed to this submission, so without this client B keeps
  // playing client A's video on /portal — which is exactly the "wrong project"
  // case Jordan is fixing (reviewer, Sep 16). The target re-adds it on its own
  // approval (addApprovedCutToLibrary), against the right enrollment.
  if (sub.status === "APPROVED") {
    await prisma.portalVideo.deleteMany({ where: { externalKey: `sub:${sub.id}` } }).catch(() => { /* library is best-effort */ });
  }

  // The job it left is left exactly as a withdrawal leaves it.
  await releaseSourceJob(
    sub.projectId,
    sub,
    `Cut moved to ${targetStreet} by ${who.actor.name} (was version ${sub.round}${sub.fileName ? ` — ${sub.fileName}` : ""}).${stranded ? ` The approved file is still in Dropbox: ${stranded}` : ""}`,
  );
  await prisma.activity.create({
    data: {
      projectId: target.id,
      type: "SYSTEM",
      body: `Cut moved here from ${sourceStreet} by ${who.actor.name} — ${landing.label}, version ${landing.round}${sub.fileName ? ` (${sub.fileName})` : ""}.`,
    },
  }).catch(() => {});

  // The target's stage, the same move an upload makes — and NOT a word about
  // the target's own revision lane: a cut that arrived from another job is not
  // automatically the correction to THIS client's ask, so correctedCutSubmitted
  // is deliberately not called. Whoever rules on it decides that.
  if (target.status === "EDITING" || target.status === "SHOT") {
    await prisma.project.update({ where: { id: target.id }, data: { status: "REVIEW", statusPinnedAt: null } }).catch(() => {});
  }

  // One announcement for the job it landed on. The key carries the move, or
  // the per-submission dedupe from the cut's FIRST trip into the Room would
  // swallow it and the reviewer would never hear the video arrived.
  await announceCutInReview({
    kind: "review_submitted",
    projectId: target.id,
    submissionId: sub.id,
    round: landing.round,
    street: targetStreet,
    fileName: sub.fileName,
    editorKey: sub.submittedByKey,
    editorName: sub.submittedByName,
    ownerActed: who.actor.owner,
    dedupeSuffix: `moved-${movedAt.getTime()}`,
  });

  // BOTH JOBS. The cut left one slot and landed on another, so the per-video
  // rows on both sides are out of date — the source's current/approved pointers
  // still name a round that is no longer its, and the target's name nothing
  // yet. Same reason removeCut syncs: a take-back is a cut event like any other
  // and refresh is a derivation, not a second opinion.
  await syncOutputs(sub.projectId);
  await syncOutputs(target.id);
  refresh(sub.projectId);
  refresh(target.id);
  revalidatePath(`/projects/${sub.projectId}`);
  revalidatePath(`/projects/${target.id}`);
  return {
    ok: true,
    message:
      `Moved to ${targetStreet} — it's in the Review Room there as ${landing.label}, version ${landing.round}.` +
      (landing.freeSlot ? "" : " That job's cuts were all taken, so it landed on the first one still open — move it again if that's wrong.") +
      (stranded ? ` The approved copy is still in ${sourceStreet}'s Dropbox folder — the flag on the cut has a control to remove it.` : ""),
  };
}

// ---------------------------------------------------------------------------
// 3 · THE LEFTOVER DROPBOX FILE — office only. The ONE Dropbox write on this
//     path: it deletes exactly the file that was recorded, nothing else.
//
//     Two places the path can live, and it keeps working from either (Sep 16):
//      · strandedFinalPath on the ReviewSubmission — what a cut WITHDRAWN this
//        afternoon carries, and the flag in the Review Room still acts on it;
//      · sourceDetail on the `stranded-final-<submissionId>` SmartTask — where
//        a REMOVED cut records it, because the row that used to hold the flag
//        no longer exists.
// ---------------------------------------------------------------------------
export async function removeStrandedFinal(submissionId: string): Promise<{ ok: boolean; message: string }> {
  return takeBackGuard("remove that file", () => removeStrandedFinalInner(submissionId)) as Promise<{ ok: boolean; message: string }>;
}

async function removeStrandedFinalInner(submissionId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, round: true, strandedFinalPath: true, movedFromProjectId: true },
  });
  const task = await prisma.smartTask
    .findUnique({ where: { dedupeKey: `stranded-final-${submissionId}` }, select: { id: true, projectId: true, sourceDetail: true, status: true } })
    .catch(() => null);
  const path = sub?.strandedFinalPath ?? task?.sourceDetail ?? null;
  if (!sub && !task) return { ok: false, message: "That version no longer exists." };
  if (!path) return { ok: true, message: "There's no leftover file to remove." };
  try {
    const { dropboxDelete } = await import("@/lib/integrations/dropbox");
    await dropboxDelete(path); // a path that is already gone counts as done
  } catch (e) {
    return { ok: false, message: `Dropbox wouldn't remove it (${(e as Error).message.slice(0, 80)}) — try again, or delete it in Dropbox yourself.` };
  }
  if (sub) await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { strandedFinalPath: null } }).catch(() => {});
  // The reminder has done its job — close it rather than leave the office
  // chasing a file that is gone.
  if (task && task.status !== "COMPLETED") {
    await prisma.smartTask.update({ where: { id: task.id }, data: { status: "COMPLETED", completedAt: new Date() } }).catch(() => {});
  }
  // The line goes on the job whose folder it was in — the source job when the
  // cut had since been moved somewhere else.
  const jobId = sub?.movedFromProjectId ?? sub?.projectId ?? task?.projectId ?? null;
  if (jobId) {
    await prisma.activity.create({
      data: { projectId: jobId, type: "SYSTEM", body: `Removed the pulled cut's file from Dropbox — ${path.split("/").pop() ?? path}.` },
    }).catch(() => {});
    refresh(jobId);
  }
  if (sub && sub.projectId !== jobId) refresh(sub.projectId);
  revalidatePath("/tasks");
  return { ok: true, message: `Removed ${path.split("/").pop() ?? "the file"} from Dropbox.` };
}

// ---------------------------------------------------------------------------
// 4 · READS FOR THE CONTROLS
// ---------------------------------------------------------------------------
/** Everything the "Wrong video?" control needs for one job's cuts, including
 *  whether THIS viewer may remove or move each. The editor portal's uploader
 *  asks for it (the /edit page it lives on doesn't carry these columns); the
 *  Review Room page builds the same shape server-side and hands it to
 *  CutReviewPanel, so the control is on both desks. */
export async function cutTakeBackFlags(projectId: string): Promise<CutTakeBackInfo[]> {
  const who = await takeBackActor();
  if (!who.ok) return [];
  const rows = await prisma.reviewSubmission.findMany({
    where: { projectId, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } },
    orderBy: { round: "asc" },
    select: {
      id: true, round: true, status: true, fileName: true, submittedByKey: true, finalPath: true, assetPath: true,
      withdrawnAt: true, withdrawnBy: true, withdrawnReason: true,
      strandedFinalPath: true, movedFromProjectId: true, movedAt: true, movedBy: true,
    },
  });
  const fromIds = [...new Set(rows.map((r) => r.movedFromProjectId).filter((x): x is string => !!x))];
  const froms = fromIds.length
    ? await prisma.project.findMany({ where: { id: { in: fromIds } }, select: { id: true, title: true } })
    : [];
  const streetById = new Map(froms.map((p) => [p.id, streetOf(p.title)]));
  return rows.map((r) => ({
    submissionId: r.id,
    round: r.round,
    status: r.status,
    fileName: r.fileName,
    // Two verdicts, not one (Sep 16): an old round can be removed but not
    // moved, so the dialog must know which tabs it may show.
    canRemove: whyNotTakeBack(r, who.actor, "remove") === null,
    canMove: whyNotTakeBack(r, who.actor, "move") === null,
    office: who.actor.office,
    // Named so the confirm can say exactly what goes from Dropbox — and,
    // separately, exactly what stays: assetPath is the editor's own export
    // behind a folder-discovered row, which a removal never deletes.
    finalPath: r.finalPath ?? null,
    folderSourcePath: r.assetPath && r.assetPath !== r.finalPath ? r.assetPath : null,
    withdrawnAt: r.withdrawnAt ? r.withdrawnAt.toISOString() : null,
    withdrawnBy: r.withdrawnBy,
    withdrawnReason: r.withdrawnReason,
    strandedFinalPath: r.strandedFinalPath,
    movedFromStreet: r.movedFromProjectId ? (streetById.get(r.movedFromProjectId) ?? null) : null,
    movedAt: r.movedAt ? r.movedAt.toISOString() : null,
    movedBy: r.movedBy,
  }));
}

/** The job picker behind "Move to another job": an editor sees only the jobs
 *  they hold, the office searches everything that isn't cancelled. Video jobs
 *  only — a cut has nowhere to land on a photos-only order. */
export async function cutMoveTargets(submissionId: string, query: string): Promise<CutMoveOption[]> {
  const who = await takeBackActor();
  if (!who.ok) return [];
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { projectId: true } });
  if (!sub) return [];
  const q = (query ?? "").trim().slice(0, 80);
  const held = who.actor.office
    ? null
    : (await prisma.smartTask.findMany({
        where: {
          taskType: { in: ["edit_video", "revision"] },
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          assignedKey: { in: [...who.actor.keys] },
          projectId: { not: null },
        },
        select: { projectId: true },
      })).map((t) => t.projectId!).filter(Boolean);
  if (held && held.length === 0) return [];
  const rows = await prisma.project.findMany({
    where: {
      id: { not: sub.projectId, ...(held ? { in: held } : {}) },
      status: { notIn: ["CANCELLED"] },
      deliverables: { some: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
      ...(q
        ? { OR: [{ title: { contains: q, mode: "insensitive" as const } }, { client: { name: { contains: q, mode: "insensitive" as const } } }] }
        : {}),
    },
    orderBy: [{ shootDate: "desc" }, { createdAt: "desc" }],
    take: 20,
    select: { id: true, title: true, status: true, shootDate: true, client: { select: { name: true } } },
  });
  return rows.map((p) => ({
    projectId: p.id,
    street: streetOf(p.title),
    clientName: p.client?.name ?? null,
    status: p.status,
    shootDateISO: p.shootDate ? p.shootDate.toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// THE 1080p PASS — the owner's controls, and Kyle's one tap.
//
// Server actions only. The card that calls these is a client component and must
// never import @/lib/topazJobs (or settings, or prisma) directly — that is the
// single most common way this repo breaks the production build while tsc stays
// quiet. Everything below is the door.
//
// Everything here is OWNER/ADMIN: Kyle is ADMIN and closes his own card; the
// spend controls are the owner's. No editor lane touches Topaz at all.
// ---------------------------------------------------------------------------

/** Kyle's one tap once the 1080p file is uploaded to Aryeo and the listing is
 *  delivered: closes his card and closes the loop in the hub. (Aryeo offers no
 *  way to do this step automatically — see ARYEO_MANUAL_NOTE.) */
export async function markTopazDeliveredAction(jobId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { markTopazDelivered } = await import("@/lib/topazJobs");
  const me = await getCurrentUser().catch(() => null);
  const r = await markTopazDelivered(jobId, me?.name ?? me?.email ?? null);
  revalidatePath("/tasks");
  revalidatePath("/review");
  return r;
}

/** Stop a 1080p job that is stuck, or that Jordan has changed his mind about.
 *  Cancels at Topaz too — the point is to stop paying for it. */
export async function cancelTopazJobAction(jobId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { cancelTopazJob } = await import("@/lib/topazJobs");
  const me = await getCurrentUser().catch(() => null);
  const r = await cancelTopazJob(jobId, me?.name ?? me?.email ?? null);
  revalidatePath("/connections");
  revalidatePath("/review");
  return r;
}

/** Put a failed or skipped 1080p job back in the queue. Reuses the same row, so
 *  one-render-per-cut still holds, and never re-runs a render whose credits
 *  were already committed — it asks Topaz what happened instead. */
export async function retryTopazJobAction(jobId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { retryTopazJob } = await import("@/lib/topazJobs");
  const r = await retryTopazJob(jobId);
  revalidatePath("/connections");
  revalidatePath("/review");
  return r;
}

/** Send an already-approved cut through the 1080p pass by hand — for the cuts
 *  approved before the pass was switched on, or after a skip that Jordan has
 *  decided he wants anyway. Same unique constraint: a cut that already has a
 *  job says so instead of making a second one. */
export async function queueTopazRenderAction(submissionId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { queueTopazRender } = await import("@/lib/topazJobs");
  const r = await queueTopazRender(submissionId);
  revalidatePath("/review");
  return r.queued
    ? { ok: true, message: "Queued — the 1080p version will be in Dropbox shortly." }
    : { ok: false, message: r.reason };
}
