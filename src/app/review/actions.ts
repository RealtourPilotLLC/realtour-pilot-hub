"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireAdmin, requireTaskAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { dbx, dropboxSharedLink, DropboxError } from "@/lib/integrations/dropbox";
import { projectFolderPaths } from "@/lib/dropboxFolders";
import { editorForDeliverable, editorMeta, TEAM_MEMBER_EDITOR_KEYS, type EditorKey } from "@/lib/editors";
import { slugForName } from "@/lib/assignees";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { notifyInApp, type NotifyTarget } from "@/lib/notify";

// ---------------------------------------------------------------------------
// Mutations for the STANDALONE Review Room (/review). The loop:
//   editor "Done — send to review"  → submitCutForReview(): find the newest
//     video in the project's FINAL Dropbox folder, mint a direct streaming
//     link, park a ReviewSubmission, flip the job to REVIEW, ring OWNER+ADMIN.
//   owner reviews at /review/<projectId> → addCutNote() drops timestamped
//     EDITOR-lane notes (or PHOTOGRAPHER-lane for capture problems) on the cut.
//   requestCutChanges() → bundles the open EDITOR notes into ONE revision task
//     back on the editor's plate (their scoped queue on /editing), rings their bell.
//   editor re-submits → NEW round; approveCut() → APPROVED + Kyle delivers.
// Reads live in src/lib/reviewRoom.ts. The per-asset PHOTO pin review stays in
// the project gallery (reviewActions.ts) — this file is the CUT loop.
// ---------------------------------------------------------------------------

const streetOf = (title?: string | null) => (title || "this job").split(",")[0].trim();
// Per-CUT, not per-project: monthly packages have several cuts in flight, and
// a per-project key made "request changes on video 2" OVERWRITE video 1's
// still-open change list (adversarial review). Keyed by assetPath so a redo of
// the same video reuses (reopens) its own task; submission id when no file.
const CUT_CHANGES_KEY = (projectId: string, cutKey: string) => {
  const h = crypto.createHash("sha1").update(cutKey).digest("hex").slice(0, 10);
  return `cut-changes-${projectId}-${h}`;
};

function refresh(projectId: string) {
  revalidatePath("/review");
  revalidatePath(`/review/${projectId}`);
  revalidatePath("/editing");
  revalidatePath(`/edit/${projectId}`);
}

// Who's writing (same convention as reviewActions.sessionAuthor): resolve a
// photographer through the live roster-email fallback, and never alias a
// signed-in NON-owner to "owner" — that key is an identity in the thread-reply
// notifier (it suppresses Jordan's ping and can self-ping the addressee).
async function sessionAuthor(): Promise<{ authorKey: string; authorName: string | null }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { authorKey: "owner", authorName: "Jordan" };
  const name = u.name ?? u.email;
  if (u.role === "OWNER") return { authorKey: "owner", authorName: name };
  // An EDITOR is keyed editor:<key> FIRST — tm:<id> winning meant editor-
  // authored notes dodged every "authored by the editor" filter and their
  // submissions were credited to a tm: identity (Aug 18 audit).
  if (u.role === "EDITOR" && u.editorKey) return { authorKey: `editor:${u.editorKey}`, authorName: name };
  if (u.teamMemberId) return { authorKey: `tm:${u.teamMemberId}`, authorName: name };
  if (u.editorKey) return { authorKey: `editor:${u.editorKey}`, authorName: name };
  if (u.role === "PHOTOGRAPHER") {
    try {
      const { photographerMemberId } = await import("@/lib/shoot");
      const mid = await photographerMemberId(u);
      if (mid) return { authorKey: `tm:${mid}`, authorName: name };
    } catch { /* fall through to the neutral key */ }
  }
  return { authorKey: `user:${u.id}`, authorName: name };
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
    select: { deliverables: { select: { type: true, label: true } }, client: { select: { socialClient: true } } },
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

// Scan the project's FINAL video folder for the newest cut and mint a direct
// streaming link. Best-effort: Dropbox down / folder empty → nulls, and the
// review room degrades to folder links + manual-timestamp notes.
// The NEXT cut to submit: the newest video in the Final folder that isn't
// already sitting in review (or approved). Monthly personal-branding packages
// carry 2–5 videos, and Jordan wants them sent ONE BY ONE — so each "send to
// review" picks up the next new file, and a file whose review came back
// CHANGES_REQUESTED is eligible again (that's the re-submit). `nothingNew` =
// every video present is already pending/approved, so a second click can't
// double-submit the same cut.
async function findNextCut(
  project: {
    title: string;
    addressLine: string | null;
    shootDate: Date | null;
    createdAt: Date;
    client: { name: string };
  },
  projectId: string,
): Promise<{ assetUrl: string | null; assetPath: string | null; fileName: string | null; isRedo: boolean; nothingNew: boolean; folderVideoCount: number }> {
  const none = { assetUrl: null, assetPath: null, fileName: null, isRedo: false, nothingNew: false, folderVideoCount: 0 };
  try {
    const path = projectFolderPaths(project).finalVideo;
    const res = await dbx<{ entries: { ".tag": string; name: string; path_display?: string; server_modified?: string }[] }>(
      "files/list_folder",
      { path },
    );
    const vids = (res.entries ?? [])
      .filter((e) => e[".tag"] === "file" && /\.(mp4|mov|m4v|webm)$/i.test(e.name))
      .sort((a, b) => (b.server_modified ?? "").localeCompare(a.server_modified ?? ""));
    if (vids.length === 0) return none;

    const prior = await prisma.reviewSubmission.findMany({
      where: { projectId, assetPath: { not: null } },
      orderBy: { round: "asc" },
      select: { assetPath: true, status: true },
    });
    const latestByPath = new Map<string, string>(); // path → latest status
    for (const p of prior) latestByPath.set(p.assetPath!, p.status);

    const eligible = vids.filter((v) => {
      const st = v.path_display ? latestByPath.get(v.path_display) : undefined;
      return !st || st === "CHANGES_REQUESTED";
    });
    if (eligible.length === 0) return { ...none, nothingNew: true, folderVideoCount: vids.length };
    const newest = eligible[0];
    if (!newest.path_display) return none;
    const url = await dropboxSharedLink(newest.path_display);
    return {
      assetUrl: url,
      assetPath: newest.path_display,
      fileName: newest.name,
      isRedo: latestByPath.has(newest.path_display),
      nothingNew: false,
      folderVideoCount: vids.length,
    };
  } catch (e) {
    if (!(e instanceof DropboxError)) console.warn("findNextCut failed", e);
    return none;
  }
}

// The editor's "Done — send to review". Everything sendEditToReview did, PLUS
// a ReviewSubmission row with a playable link so the owner reviews in-house at
// /review/<id> instead of hunting through Dropbox/Frame.io.
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
      deliverables: { select: { type: true, label: true, quantity: true } },
    },
  });
  if (!project) return { ok: false, message: "That project no longer exists." };
  const street = streetOf(project.title);

  const { authorKey, authorName } = await sessionAuthor();
  const editorKey = authorKey.startsWith("editor:") ? authorKey.slice("editor:".length) : await projectEditorKey(projectId);

  // The cut itself — the next UNSUBMITTED video in the Final folder (monthly
  // packages carry several; they go to review one at a time).
  const cut = await findNextCut(project, projectId);
  if (cut.nothingNew) {
    return {
      ok: false,
      message: "Every video in the Final folder is already in review (or approved). Drop the next finished file in 05-Final-Video, then send again.",
    };
  }

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
  const videosOwed = Math.max(quantityOwed, cut.folderVideoCount, monthlyOwed);
  const priorPaths = new Set(
    (
      await prisma.reviewSubmission.findMany({
        where: { projectId, assetPath: { not: null } },
        select: { assetPath: true },
      })
    ).map((s) => s.assetPath!),
  );
  const distinctAfter = priorPaths.size + (cut.assetPath && !priorPaths.has(cut.assetPath) ? 1 : 0);
  // TYPE-SCOPED closes (adversarial review): a REDO closes the revision task
  // (the bounce is answered) but must NOT close the edit_video item still
  // covering unmade videos; completing the SET closes edit_video but must not
  // eat an outstanding revision on a different cut. Single-video jobs and
  // no-file submits keep the legacy close-everything behavior.
  const legacyClose = !cut.assetPath || videosOwed <= 1;
  const closeEdit = legacyClose || distinctAfter >= videosOwed;
  const closeRevision = legacyClose || cut.isRedo;

  const lastRound = await prisma.reviewSubmission.findFirst({
    where: { projectId },
    orderBy: { round: "desc" },
    select: { round: true },
  });
  const submission = await prisma.reviewSubmission.create({
    data: {
      projectId,
      kind: "video",
      assetUrl: cut.assetUrl,
      assetPath: cut.assetPath,
      fileName: cut.fileName,
      round: (lastRound?.round ?? 0) + 1,
      status: "PENDING",
      submittedByKey: editorKey,
      submittedByName: authorName,
      note: (note ?? "").trim().slice(0, 1000) || null,
    },
  });

  // Close out the editor's open work item (first submit = edit_video; a
  // re-submit after changes = the bundled revision task). An editor's submit
  // closes ONLY their own tasks — never a co-editor's parallel work item.
  // On a multi-video package the edit task stays OPEN until the last video of
  // the set is in — sending video 1 of 4 is progress, not done.
  const closeTypes = [...(closeEdit ? ["edit_video"] : []), ...(closeRevision ? ["revision"] : [])];
  if (closeTypes.length) {
    await prisma.smartTask.updateMany({
      where: {
        projectId,
        taskType: { in: closeTypes },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        ...(myEditorKey ? { assignedKey: myEditorKey } : {}),
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  }

  // EDITING/SHOT → REVIEW (never demote a job already past review).
  if (project.status === "EDITING" || project.status === "SHOT") {
    await prisma.project.update({ where: { id: projectId }, data: { status: "REVIEW" } });
  } else if (project.status === "REVISION" && !project.deliveredAt) {
    // A NEVER-delivered job bounced in the Review Room (Jordan, Aug 27:
    // requesting changes flips it to Revisions) — the redo landing sends it
    // back to Ready-for-review, but only when this submit closed the LAST
    // open revision ask (a photo-lane ask on the same job keeps it in
    // Revisions), and clear the stamp so the hourly sweep can't flip it
    // straight back. A delivered job's revision keeps its lifecycle:
    // resolveRevision is what returns it to DELIVERED.
    const stillOpen = await prisma.smartTask.count({
      where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    });
    if (stillOpen === 0) {
      await prisma.project.update({
        where: { id: projectId },
        data: { status: "REVIEW", revisionRequestedAt: null },
      });
    }
  }
  await prisma.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: `Cut submitted for review (round ${submission.round})${cut.fileName ? ` — ${cut.fileName}` : ""}.`,
    },
  });

  try {
    await notifyInApp({
      kind: "review_submitted",
      title: `Cut ready to review — ${street}`,
      body: cut.fileName ?? undefined,
      href: `/review/${projectId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `review-sub-${submission.id}`,
    });
  } catch { /* bell is best-effort */ }

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
  const { authorKey, authorName } = await sessionAuthor();

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
    await notifyMentions({ text: body, projectId: input.projectId, authorName, context: "a cut note", noteId: note.id });
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
  const { authorKey, authorName } = await sessionAuthor();
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
  // is excluded from the thread-participant ping so nobody hears it twice.
  {
    const { notifyMentions, notifyThreadReply } = await import("@/lib/mentions");
    const excludeTmIds = await notifyMentions({
      text,
      projectId: root.projectId,
      authorName,
      context: "a cut-note comment",
      noteId: root.id,
    });
    await notifyThreadReply({
      rootId: root.id,
      replyId: reply.id,
      replierKey: authorKey,
      replierName: authorName,
      text,
      projectId: root.projectId,
      surface: "cut",
      excludeTmIds,
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

  // Multi-video sets: "Ready to deliver" is a SET verdict, not a per-cut one
  // (audit: Kyle was told to deliver on video 1 of 4). Count the cuts still
  // in flight (latest round per file that isn't APPROVED yet).
  const siblings = await prisma.reviewSubmission.findMany({
    where: { projectId: submission.projectId },
    orderBy: { round: "asc" },
    select: { id: true, assetPath: true, status: true },
  });
  const latestPerCut = new Map<string, string>();
  for (const s of siblings) latestPerCut.set(s.assetPath ?? s.id, s.status);
  const inFlight = [...latestPerCut.values()].filter((st) => st !== "APPROVED").length;

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

  refresh(submission.projectId);
  return {
    ok: true,
    message:
      inFlight > 0
        ? `Approved — ${inFlight} more video${inFlight === 1 ? "" : "s"} still in review on ${street}.`
        : `Approved — Kyle's been pinged to deliver ${street}.`,
  };
}

// REQUEST CHANGES: bundle the open EDITOR-lane notes on this cut into ONE
// revision task on the editor's plate (their scoped queue on /editing shows it as a
// red Revision chip), flip the job to REVISION ("Revisions" on the queue),
// ring their bell. Re-sending reopens + refreshes the same task instead of
// duplicating.
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

  const editorKey = (submission.submittedByKey ?? (await projectEditorKey(submission.projectId))) as EditorKey | null;
  if (!editorKey) return { ok: false, message: "No editor is routed to this job — assign one on the Editor Queue first." };

  const street = streetOf(submission.project?.title);
  const s = open.length === 1 ? "" : "s";
  const fmtT = (t: number | null) =>
    t == null ? "" : `[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}] `;
  const lines = open.map((n) => `• ${fmtT(n.timeSec)}${n.body.trim()}`);
  const key = CUT_CHANGES_KEY(submission.projectId, submission.assetPath ?? submission.id);
  const data = {
    taskType: "revision",
    title: `Cut changes — ${street}`.slice(0, 120),
    summary: `${open.length} change${s} requested on the round-${submission.round} cut:\n${lines.slice(0, 3).join("\n")}${open.length > 3 ? `\n…and ${open.length - 3} more` : ""}`.slice(0, 500),
    description: lines.join("\n").slice(0, 1500),
    reasonCreated: "Owner requested changes in the Review Room",
    source: "system",
    priority: "HIGH" as const,
    dueAt: new Date(Date.now() + 24 * 3600_000),
    assignedKey: editorKey,
    projectId: submission.projectId,
    clientId: submission.project?.clientId ?? null,
    propertyAddress: submission.project?.title ?? null,
    dedupeKey: key,
  };
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }

  const { authorName } = await sessionAuthor();
  await prisma.reviewSubmission.update({
    where: { id: submissionId },
    data: { status: "CHANGES_REQUESTED", decidedAt: new Date(), decidedBy: authorName },
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
      data: { status: "REVISION", revisionRequestedAt: new Date() },
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
    const isTeamEditor = (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(editorKey);
    await notifyInApp({
      kind: "review_changes",
      title: isTeamEditor
        ? `Changes requested — ${street}`
        : `Relay cut changes to ${editorMeta(editorKey)?.name ?? editorKey} — ${street}`,
      body: `${open.length} note${s}: ${open[0].body}`.slice(0, 140),
      href: `/edit/${submission.projectId}`,
      targets: isTeamEditor
        ? [{ roles: ["EDITOR"], userKey: `editor:${editorKey}`, href: `/edit/${submission.projectId}` }]
        : [{ roles: ["ADMIN"] }],
      dedupeKey: `review-changes-${submissionId}-${open[open.length - 1].id}`,
    });
  } catch { /* bell is best-effort */ }

  refresh(submission.projectId);
  return { ok: true, message: `Sent ${open.length} change${s} to ${editorMeta(editorKey)?.name ?? editorKey}.` };
}
