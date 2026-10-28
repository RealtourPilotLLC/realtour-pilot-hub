import "server-only";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { LOCAL_DEV_AUTHOR, PREVIEW_REFUSED, whenET } from "@/lib/reviewAttribution";
import { editorMeta, TEAM_MEMBER_EDITOR_KEYS } from "@/lib/editors";
import type { CutNote } from "@/lib/reviewRoom";
import {
  NOTE_UNDO_HOURS, bumpRoundCount, cardBullet, clock, deletedBullet, editedBullet, editorChangeLine,
  editorBellTitle, mayChangeNote, mayCorrectClientNote, replaceCardBullet, undoOpen, type EditorBellAction, type NoteChanger,
} from "@/lib/noteEditCore";

// ---------------------------------------------------------------------------
// EDIT AND DELETE A REVIEW ROOM NOTE (Jordan, Oct 28 2026: "we need to be able
// to delete revision notes in the review room and also edit them").
//
// A STAFF NOTE (MediaNote on a cut): its author, or the owner, the office or
// the creative manager (noteEditCore.mayChangeNote).
//   · Before it went to the editor (the cut was not sent back with it): an
//     edit changes the words, a delete takes it away. Its fix item on the
//     editor's list (RevisionIssue) follows: new words, or "not needed".
//   · After it went (the cut was sent back with it on the edit card): the
//     same, plus the bullet on the edit card's round text is rewritten, the
//     card's "N notes to fix" moves, and the editor is told in one line on
//     their bell, the way a send-back reaches them (kind review_changes:
//     their own row, or the office's when an outside editor has the job).
//   · A note the editor already marked fixed: an edit opens it again (they
//     fixed the old words, not the new ones) and says so; a delete takes it
//     off their list as not needed, never counted against them.
//   · Every delete keeps the whole note and its replies (NoteChange.snapshot),
//     is written on the job's timeline (who, when), and can be undone for
//     NOTE_UNDO_HOURS: the note comes back with the same id, its item back to
//     where it was. An edit keeps the earlier words: staff see "edited".
//
// A CLIENT'S NOTE (PortalComment): the portal is theirs, so their words are
// never rewritten. The desk may
//   · before it is sent: hold it back from the editor (it is resolved by our
//     team, exactly as setCommentResolved does from the portal, so the
//     15-minute auto-send and a later Request changes both pass it over), or
//     change what the editor gets (the sent line then carries our wording
//     with the client's words beside it: clientDecisions.attributedNoteLines);
//   · after it is sent: change what the editor gets, or take it off the
//     editor's list, on the work-order item it became.
// ---------------------------------------------------------------------------

export type NoteActor = { name: string; userId: string | null; tmId: string | null; changer: NoteChanger | null };
export type NoteResult = { ok: boolean; message: string; changeId?: string };

const FIX_STATES_LIVE = ["OPEN", "REOPENED", "ADDRESSED"];
const street = (title: string | null | undefined) => (title || "this job").split(",")[0].trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** A cut note's key names its submission ("cut:<id>" or the stream URL). */
export function submissionIdOfNoteKey(assetUrl: string | null | undefined): string | null {
  if (!assetUrl) return null;
  if (assetUrl.startsWith("cut:")) return assetUrl.slice(4) || null;
  const m = /\/api\/review\/cut\/([^/]+)\/stream/.exec(assetUrl);
  return m ? m[1] : null;
}

type NoteRow = NonNullable<Awaited<ReturnType<typeof prisma.mediaNote.findUnique>>>;
type SubRow = { id: string; projectId: string; status: string; decidedAt: Date | null; round: number; submittedByKey: string | null; fileName: string | null };

async function cutOf(note: { projectId: string; assetUrl: string }): Promise<SubRow | null> {
  const select = { id: true, projectId: true, status: true, decidedAt: true, round: true, submittedByKey: true, fileName: true } as const;
  const id = submissionIdOfNoteKey(note.assetUrl);
  if (id) return prisma.reviewSubmission.findUnique({ where: { id }, select }).catch(() => null);
  return prisma.reviewSubmission.findFirst({ where: { projectId: note.projectId, assetUrl: note.assetUrl }, orderBy: { round: "desc" }, select }).catch(() => null);
}

/**
 * Has the editor already been sent this note? Only an editor-lane root written
 * by someone other than the editor rides a send-back, and it rode THIS one when
 * the cut was sent back after it was written (and it was not already resolved
 * by then): requestCutChanges bundles exactly the open ones.
 */
export function wasSent(note: Pick<NoteRow, "parentId" | "lane" | "authorKey" | "createdAt" | "status" | "statusAt">, sub: Pick<SubRow, "status" | "decidedAt"> | null): boolean {
  if (note.parentId || note.lane !== "EDITOR" || (note.authorKey ?? "").startsWith("editor:")) return false;
  if (!sub?.decidedAt || !["CHANGES_REQUESTED", "SUPERSEDED"].includes(sub.status)) return false;
  if (note.createdAt.getTime() > sub.decidedAt.getTime()) return false;
  // Only OPEN notes are bundled: one resolved or marked fixed before the send-back stayed behind.
  if ((note.status === "RESOLVED" || note.status === "FIXED") && note.statusAt && note.statusAt.getTime() <= sub.decidedAt.getTime()) return false;
  return true;
}

/** Who has this job's video work: the edit card's holder, else whoever made the cut. */
async function editorOf(projectId: string, sub: SubRow | null, fallback: string | null): Promise<string | null> {
  const card = await prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${projectId}` }, select: { assignedKey: true } }).catch(() => null);
  return card?.assignedKey ?? sub?.submittedByKey ?? fallback;
}

export function editorNameOf(key: string | null): string | null {
  return key ? editorMeta(key)?.name ?? key : null;
}

/**
 * The editor's one line, on their bell (or the office's, to relay to an
 * outside editor). An editor's row keeps only its title (lib/notify drops a
 * creative's body, and their Slack/text sends the title), so the title is the
 * line itself: editorBellTitle. The full sentence rides as the body for the
 * office's rows and sits under the item on the editor's page.
 */
async function tellEditor(input: {
  projectId: string; submissionId: string | null; editorKey: string | null; line: string;
  change: { action: EditorBellAction; by: string; timeSec: number | null; wasFixed?: boolean };
  dedupeKey: string; actorTmId: string | null; kind?: string;
}): Promise<void> {
  try {
    const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { title: true } });
    const where = street(project?.title);
    const href = `/edit/${input.projectId}${input.submissionId ? `?cut=${input.submissionId}` : ""}`;
    const isTeam = !!input.editorKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(input.editorKey);
    const { notifyInApp } = await import("@/lib/notify");
    if (isTeam) {
      await notifyInApp({
        kind: input.kind ?? "review_changes",
        title: editorBellTitle(input.change, where),
        body: clip(input.line, 280),
        href,
        targets: [{ roles: ["EDITOR"], userKey: `editor:${input.editorKey}`, href }],
        dedupeKey: input.dedupeKey,
        actorTeamMemberId: input.actorTmId,
      });
      return;
    }
    // An outside editor (no login) hears it from the office, the same way the
    // send-back reached them (review/actions requestCutChanges' relay).
    const outside = editorNameOf(input.editorKey);
    await notifyInApp({
      kind: input.kind ?? "review_changes",
      title: outside ? `Tell ${outside}: a note changed on ${where}`.slice(0, 90) : editorBellTitle(input.change, where),
      body: clip(input.line, 280),
      href,
      targets: [{ roles: ["ADMIN"], href }],
      dedupeKey: input.dedupeKey,
      actorTeamMemberId: input.actorTmId,
    });
  } catch (e) {
    console.error("[noteEdits] could not tell the editor", input.dedupeKey, e);
  }
}

async function timeline(projectId: string, body: string, authorTmId: string | null): Promise<void> {
  const data = { projectId, type: "SYSTEM" as const, body: clip(body, 900) };
  if (authorTmId && (await prisma.activity.create({ data: { ...data, authorId: authorTmId } }).then(() => true, () => false))) return;
  await prisma.activity.create({ data }).catch(() => {});
}

async function issueEvent(issueId: string, kind: string, actor: NoteActor, from: string | null, to: string | null, note: string | null): Promise<void> {
  await prisma.revisionIssueEvent
    .create({ data: { issueId, kind, fromValue: from, toValue: to, actorName: actor.name.slice(0, 120), actorUserId: actor.userId, note: note ? note.slice(0, 500) : null } })
    .catch(() => {});
}

/**
 * The edit card's round text, one bullet rewritten under the card's own lock
 * (tasks.addRoundToEditCard). The summary's "N notes to fix" moves only when
 * it is still the round this note rode (version `version`, sent back as round
 * version + 1): a later round's count is about other notes.
 */
async function rewriteCard(projectId: string, oldBullet: string, newBullet: string, countDelta: number, version: number | null = null): Promise<boolean> {
  const card = await prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${projectId}` }, select: { id: true } }).catch(() => null);
  if (!card) return false;
  const { editCardLockKey } = await import("@/lib/tasks");
  const [a, b] = editCardLockKey(card.id);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a}::int4, ${b}::int4)`;
      const fresh = await tx.smartTask.findUnique({ where: { id: card.id }, select: { description: true, summary: true } });
      const next = replaceCardBullet(fresh?.description ?? "", oldBullet, newBullet);
      if (next === null) return false;
      await tx.smartTask.update({
        where: { id: card.id },
        data: { description: next, ...(countDelta && fresh?.summary && sameRound(fresh.summary, version) ? { summary: bumpRoundCount(fresh.summary, countDelta) } : {}) },
      });
      return true;
    });
  } catch (e) {
    console.error("[noteEdits] edit card not rewritten", projectId, e);
    return false;
  }
}

const sameRound = (summary: string, version: number | null) =>
  version != null && summary.startsWith(`Round ${version + 1} — `) && summary.includes(`(version ${version})`);

type Snapshot = {
  note: Record<string, unknown>;
  replies: Record<string, unknown>[];
  issue: { id: string; state: string; addressedAt: string | null; addressedBy: string | null; addressedInSubmissionId: string | null; verifiedAt: string | null; verifiedBy: string | null; verifiedInSubmissionId: string | null } | null;
  /** the bullet the edit card carried before this change, so Undo can put it back */
  cardBefore?: string | null;
  cardAfter?: string | null;
  countDelta?: number;
  editorKey?: string | null;
};

/** The bullet the edit card carries for this note now: the last one a change wrote, else the send-back's. */
async function currentCardBullet(note: { id: string; timeSec: number | null; body: string }): Promise<string> {
  const last = await prisma.noteChange.findFirst({
    where: { noteKind: "MEDIA_NOTE", noteId: note.id, action: "EDITED", afterSend: true },
    orderBy: { at: "desc" },
    select: { snapshotJson: true },
  });
  try {
    const s = last?.snapshotJson ? (JSON.parse(last.snapshotJson) as { cardAfter?: string | null }) : null;
    if (s?.cardAfter) return s.cardAfter;
  } catch { /* fall through */ }
  return cardBullet(note.timeSec, note.body);
}

// ---------------------------------------------------------------------------
// WHO IS ASKING
// ---------------------------------------------------------------------------

/** The signed-in person as a note changer: their real role and every key their notes are written under. */
export async function noteActorFromSession(): Promise<{ ok: true; actor: NoteActor } | { ok: false; message: string }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) {
    if (authEnforced()) return { ok: false, message: "Please sign in to do that." };
    // Local dev with auth off: the same stand-in author the Review Room writes under.
    return { ok: true, actor: { name: LOCAL_DEV_AUTHOR, userId: null, tmId: null, changer: { realRole: "OWNER", impersonating: false, userId: null, authorKeys: ["owner"] } } };
  }
  if (u.impersonating) return { ok: false, message: PREVIEW_REFUSED };
  const { displayNameFor } = await import("@/lib/actorName");
  const { authorTeamMemberId } = await import("@/lib/mentions");
  const name = (await displayNameFor(u)) ?? u.email;
  const tmId = await authorTeamMemberId(u).catch(() => null);
  // The keys review/actions sessionAuthor writes a note under, all of them, so
  // a person's own note is theirs whichever branch keyed it.
  const keys = new Set<string>([`user:${u.id}`]);
  if (u.role === "OWNER") keys.add("owner");
  if (u.editorKey) keys.add(`editor:${u.editorKey}`);
  if (u.teamMemberId) keys.add(`tm:${u.teamMemberId}`);
  if (tmId) keys.add(`tm:${tmId}`);
  if (u.role === "PHOTOGRAPHER") {
    const { photographerMemberId } = await import("@/lib/shoot");
    const mid = await photographerMemberId(u).catch(() => null);
    if (mid) keys.add(`tm:${mid}`);
  }
  const changer: NoteChanger = { realRole: u.realRole, impersonating: false, userId: u.id, authorKeys: [...keys] };
  return { ok: true, actor: { name, userId: u.id, tmId, changer } };
}

/** The changer for a page render (no write): what the panel offers is what the actions accept. */
export async function noteChangerForViewer(): Promise<NoteChanger | null> {
  const a = await noteActorFromSession();
  return a.ok ? a.actor.changer : null;
}

// ---------------------------------------------------------------------------
// STAFF NOTES
// ---------------------------------------------------------------------------

export async function editStaffNote(noteId: string, body: string, actor: NoteActor): Promise<NoteResult> {
  const words = (body ?? "").trim();
  if (!words) return { ok: false, message: "Write the note first. To take it away, use Delete." };
  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note || note.assetType !== "video") return { ok: false, message: "That note no longer exists." };
  if (!mayChangeNote(actor.changer, note)) return { ok: false, message: "Only the person who wrote this note, the office or the creative manager can change it." };
  const next = words.slice(0, 2000);
  if (next === note.body.trim()) return { ok: true, message: "Nothing changed." };
  const sub = await cutOf(note);
  const sent = wasSent(note, sub);
  const issue = !note.parentId
    ? await prisma.revisionIssue.findUnique({ where: { sourceKind_sourceId: { sourceKind: "REVIEW_NOTE", sourceId: note.id } } }).catch(() => null)
    : null;
  const wasFixed = note.status === "FIXED" || issue?.state === "ADDRESSED";
  const at = new Date();
  // Compare-and-set on the words this person saw: two people editing the same
  // note never silently overwrite each other.
  const won = await prisma.mediaNote.updateMany({
    where: { id: note.id, body: note.body },
    data: { body: next, ...(wasFixed && note.status === "FIXED" ? { status: "OPEN", statusBy: actor.name, statusAt: at, resolvedAt: null } : {}) },
  });
  if (won.count === 0) return { ok: false, message: "Someone changed this note a moment ago. Reload to see it, then edit again." };

  if (issue) {
    await prisma.revisionIssue.update({
      where: { id: issue.id },
      data: {
        originalText: next.slice(0, 4000),
        ...(issue.summary && norm(issue.summary) === norm(note.body) ? { summary: next.slice(0, 300) } : {}),
        // The editor fixed the old words; the new ones are open again.
        ...(issue.state === "ADDRESSED" ? { state: "OPEN", addressedAt: null, addressedBy: null, addressedInSubmissionId: null } : {}),
      },
    }).catch(() => {});
    await issueEvent(issue.id, "NOTE_EDITED", actor, note.body, next, sent ? "changed after it went to the editor" : null);
    if (issue.state === "ADDRESSED") await issueEvent(issue.id, "REOPENED_BY_EDIT", actor, "ADDRESSED", "OPEN", "the note was changed after the editor marked it fixed; not a miss");
  }

  let cardBefore: string | null = null;
  let cardAfter: string | null = null;
  if (sent) {
    cardBefore = await currentCardBullet(note);
    cardAfter = editedBullet(note.timeSec, next, actor.name, whenET(at));
    if (!(await rewriteCard(note.projectId, cardBefore, cardAfter, 0))) cardAfter = null;
  }
  const editorKey = sent ? await editorOf(note.projectId, sub, note.editorKey) : null;
  const change = await prisma.noteChange.create({
    data: {
      noteKind: "MEDIA_NOTE", noteId: note.id, projectId: note.projectId, submissionId: sub?.id ?? null, action: "EDITED",
      beforeBody: note.body, afterBody: next, afterSend: sent, actorName: actor.name.slice(0, 120), actorUserId: actor.userId, at,
      snapshotJson: JSON.stringify({ cardBefore, cardAfter, editorKey, wasFixed }),
    },
  });
  if (sent) {
    const line = editorChangeLine({ action: "EDITED", by: actor.name, timeSec: note.timeSec, before: note.body, after: next, wasFixed });
    await tellEditor({ projectId: note.projectId, submissionId: sub?.id ?? null, editorKey, line, change: { action: "EDITED", by: actor.name, timeSec: note.timeSec, wasFixed }, dedupeKey: `review-note-change-${change.id}`, actorTmId: actor.tmId });
    await timeline(note.projectId, `${actor.name} changed a Review Room note${note.timeSec != null ? ` at ${clock(note.timeSec)}` : ""} after it went to the editor${sub ? ` (version ${sub.round})` : ""}. It said: "${clip(note.body, 200)}". It now says: "${clip(next, 200)}".`, actor.tmId);
  }
  const who = editorNameOf(editorKey) ?? "The editor";
  return {
    ok: true,
    changeId: change.id,
    message: sent ? `Saved. ${who} has been told what changed${wasFixed ? ", and it is open again for them" : ""}.` : wasFixed ? "Saved. It was marked fixed, so it is open again." : "Saved.",
  };
}

export async function deleteStaffNote(noteId: string, actor: NoteActor): Promise<NoteResult> {
  const note = await prisma.mediaNote.findUnique({ where: { id: noteId }, include: { replies: { orderBy: { createdAt: "asc" } } } });
  if (!note || note.assetType !== "video") return { ok: false, message: "That note is already gone." };
  if (!mayChangeNote(actor.changer, note)) return { ok: false, message: "Only the person who wrote this note, the office or the creative manager can delete it." };
  const sub = await cutOf(note);
  const sent = wasSent(note, sub);
  const issue = !note.parentId
    ? await prisma.revisionIssue.findUnique({ where: { sourceKind_sourceId: { sourceKind: "REVIEW_NOTE", sourceId: note.id } } }).catch(() => null)
    : null;
  const wasFixed = note.status === "FIXED" || issue?.state === "ADDRESSED";
  const at = new Date();
  const editorKey = sent ? await editorOf(note.projectId, sub, note.editorKey) : null;
  const cardBefore = sent ? await currentCardBullet(note) : null;
  const cardAfter = sent ? deletedBullet(note.timeSec, note.body, actor.name, whenET(at)) : null;
  const { replies, ...row } = note;
  const snap: Snapshot = {
    note: row as unknown as Record<string, unknown>,
    replies: replies as unknown as Record<string, unknown>[],
    issue: issue
      ? {
          id: issue.id, state: issue.state,
          addressedAt: issue.addressedAt?.toISOString() ?? null, addressedBy: issue.addressedBy, addressedInSubmissionId: issue.addressedInSubmissionId,
          verifiedAt: issue.verifiedAt?.toISOString() ?? null, verifiedBy: issue.verifiedBy, verifiedInSubmissionId: issue.verifiedInSubmissionId,
        }
      : null,
    cardBefore, cardAfter, countDelta: sent && !note.parentId ? -1 : 0, editorKey,
  };
  // The record first, then the delete, in one transaction: a note is never
  // gone without the copy Undo needs.
  let changeId: string;
  try {
    changeId = await prisma.$transaction(async (tx) => {
      const c = await tx.noteChange.create({
        data: {
          noteKind: "MEDIA_NOTE", noteId: note.id, projectId: note.projectId, submissionId: sub?.id ?? null, action: "DELETED",
          beforeBody: note.body, afterSend: sent, actorName: actor.name.slice(0, 120), actorUserId: actor.userId, at, snapshotJson: JSON.stringify(snap),
        },
        select: { id: true },
      });
      const gone = await tx.mediaNote.deleteMany({ where: { id: note.id, body: note.body } });
      if (gone.count === 0) throw new Error("changed");
      return c.id;
    });
  } catch {
    return { ok: false, message: "Someone changed this note a moment ago. Reload, then try again." };
  }
  if (issue && issue.state !== "NOT_APPLICABLE" && issue.state !== "DUPLICATE") {
    const off = await prisma.revisionIssue.updateMany({ where: { id: issue.id, state: issue.state }, data: { state: "NOT_APPLICABLE" } });
    if (off.count) await issueEvent(issue.id, "NOTE_DELETED", actor, issue.state, "NOT_APPLICABLE", `the note was deleted${wasFixed ? " after the editor marked it fixed" : ""}; not counted against anyone`);
  }
  if (sent && cardBefore && cardAfter) await rewriteCard(note.projectId, cardBefore, cardAfter, snap.countDelta ?? 0, sub?.round ?? null);
  const where = note.timeSec != null ? ` at ${clock(note.timeSec)}` : "";
  await timeline(note.projectId, `${actor.name} deleted a Review Room note${where}${sub ? ` on version ${sub.round}` : ""}${sent ? " after it went to the editor" : ""}: "${clip(note.body, 240)}".`, actor.tmId);
  if (sent) {
    const line = editorChangeLine({ action: "DELETED", by: actor.name, timeSec: note.timeSec, before: note.body, after: null, wasFixed });
    await tellEditor({ projectId: note.projectId, submissionId: sub?.id ?? null, editorKey, line, change: { action: "DELETED", by: actor.name, timeSec: note.timeSec }, dedupeKey: `review-note-change-${changeId}`, actorTmId: actor.tmId });
  }
  const who = editorNameOf(editorKey) ?? "The editor";
  return { ok: true, changeId, message: sent ? `Deleted. ${who} has been told it is no longer needed.` : "Deleted." };
}

/** Put a deleted note back, with the same id, its replies and its fix item as they were. */
export async function undoNoteDelete(changeId: string, actor: NoteActor, now: Date = new Date()): Promise<NoteResult> {
  const c = await prisma.noteChange.findUnique({ where: { id: changeId } });
  if (!c || c.noteKind !== "MEDIA_NOTE" || c.action !== "DELETED") return { ok: false, message: "There is nothing to undo here." };
  if (c.undoneAt) return { ok: true, message: "It is already back." };
  const mine = !!actor.userId && actor.userId === c.actorUserId;
  if (!mayChangeNote(actor.changer, { authorKey: null, authorUserId: mine ? actor.userId : null })) return { ok: false, message: "Only the person who deleted it, the office or the creative manager can put it back." };
  if (!undoOpen(c.at, now)) return { ok: false, message: `Undo is only offered for ${NOTE_UNDO_HOURS} hours after a delete. Add the note again instead.` };
  let snap: Snapshot;
  try { snap = JSON.parse(c.snapshotJson ?? "") as Snapshot; } catch { return { ok: false, message: "That delete can't be undone (nothing was kept)." }; }
  if (c.submissionId && !(await prisma.reviewSubmission.count({ where: { id: c.submissionId } }))) {
    return { ok: false, message: "That version was removed, so its note can't come back." };
  }
  const revive = (r: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...r };
    for (const k of ["createdAt", "resolvedAt", "statusAt", "sharedAt", "seenAt", "acknowledgedAt"]) if (typeof out[k] === "string") out[k] = new Date(out[k] as string);
    return out;
  };
  const note = revive(snap.note);
  if (note.parentId && !(await prisma.mediaNote.count({ where: { id: note.parentId as string } }))) {
    return { ok: false, message: "The note this reply was on is gone, so the reply can't come back." };
  }
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.noteChange.updateMany({ where: { id: c.id, undoneAt: null }, data: { undoneAt: now, undoneBy: actor.name.slice(0, 120) } });
      if (claimed.count === 0) throw new Error("already");
      await tx.mediaNote.create({ data: note as never });
      for (const r of snap.replies) await tx.mediaNote.create({ data: revive(r) as never });
    });
  } catch (e) {
    if ((e as Error).message === "already") return { ok: true, message: "It is already back." };
    return { ok: false, message: "It couldn't be put back. Reload and try again." };
  }
  if (snap.issue) {
    const i = snap.issue;
    const back = await prisma.revisionIssue.updateMany({
      where: { id: i.id, state: "NOT_APPLICABLE" },
      data: {
        state: i.state,
        addressedAt: i.addressedAt ? new Date(i.addressedAt) : null, addressedBy: i.addressedBy, addressedInSubmissionId: i.addressedInSubmissionId,
        verifiedAt: i.verifiedAt ? new Date(i.verifiedAt) : null, verifiedBy: i.verifiedBy, verifiedInSubmissionId: i.verifiedInSubmissionId,
      },
    });
    if (back.count) await issueEvent(i.id, "NOTE_RESTORED", actor, "NOT_APPLICABLE", i.state, "the deleted note was put back");
  }
  const body = String(snap.note.body ?? c.beforeBody ?? "");
  const timeSec = typeof snap.note.timeSec === "number" ? (snap.note.timeSec as number) : null;
  if (c.afterSend && snap.cardBefore && snap.cardAfter) {
    const version = c.submissionId ? (await prisma.reviewSubmission.findUnique({ where: { id: c.submissionId }, select: { round: true } }).catch(() => null))?.round ?? null : null;
    await rewriteCard(c.projectId, snap.cardAfter, snap.cardBefore, -(snap.countDelta ?? 0), version);
  }
  await timeline(c.projectId, `${actor.name} put back the Review Room note${timeSec != null ? ` at ${clock(timeSec)}` : ""} that ${c.actorName} deleted: "${clip(body, 240)}".`, actor.tmId);
  if (c.afterSend) {
    const line = editorChangeLine({ action: "RESTORED", by: actor.name, timeSec, before: null, after: body });
    await tellEditor({ projectId: c.projectId, submissionId: c.submissionId, editorKey: snap.editorKey ?? null, line, change: { action: "RESTORED", by: actor.name, timeSec }, dedupeKey: `review-note-restore-${c.id}`, actorTmId: actor.tmId });
  }
  return { ok: true, message: c.afterSend ? "Put back, and the editor has been told." : "Put back." };
}

// ---------------------------------------------------------------------------
// READS for the screens
// ---------------------------------------------------------------------------

export type NoteEditView = { before: string; after: string; by: string; atISO: string };
export type DeletedNoteView = { changeId: string; body: string; timeSec: number | null; by: string; atISO: string; afterSend: boolean; canUndo: boolean; reply: boolean };

/** Each note's earlier words, oldest first. */
export async function noteEditsFor(noteIds: string[]): Promise<Map<string, NoteEditView[]>> {
  const out = new Map<string, NoteEditView[]>();
  if (!noteIds.length) return out;
  const rows = await prisma.noteChange
    .findMany({ where: { noteKind: "MEDIA_NOTE", noteId: { in: noteIds }, action: "EDITED" }, orderBy: { at: "asc" }, select: { noteId: true, beforeBody: true, afterBody: true, actorName: true, at: true } })
    .catch(() => []);
  for (const r of rows) out.set(r.noteId, [...(out.get(r.noteId) ?? []), { before: r.beforeBody ?? "", after: r.afterBody ?? "", by: r.actorName, atISO: r.at.toISOString() }]);
  return out;
}

/**
 * The cut notes a screen shows, with what this viewer may do and what changed.
 * `canChange` is decided here, on the server, by the same rule the actions
 * enforce; `sent` says the editor already has it (the confirm words differ).
 */
export async function decorateCutNotes(notes: CutNote[], changer: NoteChanger | null): Promise<CutNote[]> {
  if (!notes.length) return notes;
  const ids = [...notes.map((n) => n.id), ...notes.flatMap((n) => n.replies.map((r) => r.id))];
  const [rows, edits] = await Promise.all([
    prisma.mediaNote.findMany({ where: { id: { in: ids } }, select: { id: true, projectId: true, parentId: true, lane: true, authorKey: true, authorUserId: true, createdAt: true, status: true, statusAt: true, editorKey: true } }).catch(() => []),
    noteEditsFor(ids),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const subs = new Map<string, SubRow | null>();
  for (const n of notes) if (!subs.has(n.assetUrl)) subs.set(n.assetUrl, byId.get(n.id) ? await cutOf({ projectId: byId.get(n.id)!.projectId, assetUrl: n.assetUrl }) : null);
  const projectId = rows[0]?.projectId ?? null;
  const holder = projectId ? await editorOf(projectId, null, null) : null;
  return notes.map((n) => {
    const r = byId.get(n.id);
    const sub = subs.get(n.assetUrl) ?? null;
    const sent = !!r && wasSent(r, sub);
    return {
      ...n,
      canChange: !!r && mayChangeNote(changer, r),
      sent,
      editorName: editorNameOf(holder ?? sub?.submittedByKey ?? r?.editorKey ?? null),
      wasFixed: r?.status === "FIXED",
      edits: edits.get(n.id) ?? [],
      replies: n.replies.map((x) => ({ ...x, canChange: !!byId.get(x.id) && mayChangeNote(changer, byId.get(x.id)!), edits: edits.get(x.id) ?? [] })),
    };
  });
}

/** Notes and replies deleted from this cut in the last week: the panel's "Deleted" lines, Undo while it is open. */
export async function deletedNotesOn(submissionId: string, changer: NoteChanger | null, viewerUserId: string | null, now: Date = new Date()): Promise<DeletedNoteView[]> {
  const rows = await prisma.noteChange
    .findMany({
      where: { noteKind: "MEDIA_NOTE", action: "DELETED", submissionId, undoneAt: null, at: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
      orderBy: { at: "desc" },
      take: 20,
    })
    .catch(() => []);
  return rows.map((r) => {
    let reply = false;
    let timeSec: number | null = null;
    try {
      const s = JSON.parse(r.snapshotJson ?? "{}") as Snapshot;
      reply = !!s.note?.parentId;
      timeSec = typeof s.note?.timeSec === "number" ? (s.note.timeSec as number) : null;
    } catch { /* shown without a time */ }
    const mine = !!viewerUserId && viewerUserId === r.actorUserId;
    return {
      changeId: r.id, body: r.beforeBody ?? "", timeSec, by: r.actorName, atISO: r.at.toISOString(), afterSend: r.afterSend, reply,
      canUndo: undoOpen(r.at, now) && mayChangeNote(changer, { authorKey: null, authorUserId: mine ? viewerUserId : null }),
    };
  });
}

// ---------------------------------------------------------------------------
// CLIENT NOTES (PortalComment): the client's words stay theirs
// ---------------------------------------------------------------------------

export type ClientNoteChangeView = {
  /** held back from the editor by our team, with the change to undo it */
  heldBack: { by: string; atISO: string; changeId: string | null } | null;
  /** what the editor gets instead of the client's words */
  reworded: { words: string; by: string; atISO: string; changeId: string; afterSend: boolean } | null;
  /** taken off the editor's list after it was sent */
  removed: { by: string; atISO: string; changeId: string } | null;
};

/** Every live change our team made to these client notes. */
export async function clientNoteChangesFor(commentIds: string[]): Promise<Map<string, ClientNoteChangeView>> {
  const out = new Map<string, ClientNoteChangeView>();
  if (!commentIds.length) return out;
  const rows = await prisma.noteChange
    .findMany({ where: { noteKind: "PORTAL_COMMENT", noteId: { in: commentIds }, undoneAt: null }, orderBy: { at: "asc" } })
    .catch(() => []);
  for (const r of rows) {
    const cur = out.get(r.noteId) ?? { heldBack: null, reworded: null, removed: null };
    if (r.action === "HELD_BACK") cur.heldBack = { by: r.actorName, atISO: r.at.toISOString(), changeId: r.id };
    if (r.action === "REWORDED" && r.afterBody) cur.reworded = { words: r.afterBody, by: r.actorName, atISO: r.at.toISOString(), changeId: r.id, afterSend: r.afterSend };
    if (r.action === "REMOVED") cur.removed = { by: r.actorName, atISO: r.at.toISOString(), changeId: r.id };
    out.set(r.noteId, cur);
  }
  return out;
}

/** The wording the editor gets for each client note that our team changed before it was sent. */
export async function pendingClientRewords(commentIds: string[]): Promise<Map<string, { words: string; by: string }>> {
  const out = new Map<string, { words: string; by: string }>();
  if (!commentIds.length) return out;
  const rows = await prisma.noteChange
    .findMany({ where: { noteKind: "PORTAL_COMMENT", noteId: { in: commentIds }, action: "REWORDED", undoneAt: null }, orderBy: { at: "asc" }, select: { noteId: true, afterBody: true, actorName: true } })
    .catch(() => []);
  for (const r of rows) if (r.afterBody) out.set(r.noteId, { words: r.afterBody, by: r.actorName });
  return out;
}

type ClientNote = { id: string; submissionId: string; projectId: string; status: string; decisionId: string | null; parentId: string | null; body: string; timeSec: number | null; resolvedAt: Date | null; resolvedByKind: string | null };

async function clientNote(commentId: string): Promise<ClientNote | null> {
  return prisma.portalComment
    .findUnique({ where: { id: commentId }, select: { id: true, submissionId: true, projectId: true, status: true, decisionId: true, parentId: true, body: true, timeSec: true, resolvedAt: true, resolvedByKind: true } })
    .catch(() => null);
}

type BriefItem = { id: string; ask: string; quote?: string | null; [k: string]: unknown };
type ItemHit = { briefId: string; taskId: string | null; index: number; item: BriefItem; doc: Record<string, unknown> & { items: BriefItem[] } };

/** The work-order item(s) a sent client note became: its request's briefs, matched on the note's own words. */
async function itemsOfClientNote(c: ClientNote): Promise<ItemHit[]> {
  if (!c.decisionId) return [];
  const briefs = await prisma.revisionBrief.findMany({ where: { decisionId: c.decisionId }, select: { id: true, taskId: true, itemsJson: true } });
  const key = norm(c.body).slice(0, 120);
  if (key.length < 2) return [];
  const hits: ItemHit[] = [];
  for (const b of briefs) {
    let doc: (Record<string, unknown> & { items: BriefItem[] }) | null = null;
    try { doc = JSON.parse(b.itemsJson ?? "null"); } catch { doc = null; }
    if (!doc || !Array.isArray(doc.items)) continue;
    doc.items.forEach((item, index) => {
      if (typeof item?.ask !== "string") return;
      if (norm(item.ask).includes(key) || (typeof item.quote === "string" && norm(item.quote).includes(key))) hits.push({ briefId: b.id, taskId: b.taskId, index, item, doc: doc! });
    });
  }
  return hits;
}

async function clientNoteEditor(hits: ItemHit[], projectId: string): Promise<string | null> {
  const taskId = hits.find((h) => h.taskId)?.taskId;
  if (taskId) {
    const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { assignedKey: true } }).catch(() => null);
    if (t?.assignedKey) return t.assignedKey;
  }
  return editorOf(projectId, null, null);
}

/**
 * The fix items (RevisionIssue) one work-order item became: one per video it is
 * about, keyed "<brief>:<item>:<cut key>" (or ":job"), as
 * revisionIssues.ingestBriefItems writes them.
 */
async function issuesOfItem(briefId: string, itemId: string): Promise<{ id: string; state: string; summary: string | null; originalText: string }[]> {
  return prisma.revisionIssue
    .findMany({
      where: { sourceKind: "BRIEF_ITEM", OR: [{ sourceId: `${briefId}:${itemId}` }, { sourceId: { startsWith: `${briefId}:${itemId}:` } }] },
      select: { id: true, state: true, summary: true, originalText: true },
    })
    .catch(() => []);
}

const CANT_MATCH = "This note went to the editor inside a longer request, so it can't be matched to one item. Change it on the job's fix list on the editor brief instead.";

/** Hold a client's unsent note back from the editor: resolved by our team, the client's words untouched. */
export async function holdBackClientNote(commentId: string, actor: NoteActor): Promise<NoteResult> {
  if (!mayCorrectClientNote(actor.changer)) return { ok: false, message: "Only the owner, the office or the creative manager can change what the editor gets from a client." };
  const c = await clientNote(commentId);
  if (!c || c.parentId) return { ok: false, message: "That note isn't there any more." };
  if (c.status !== "OPEN" || c.decisionId) return { ok: false, message: c.status === "SENT" ? "It has already gone to the editor. Use Take off the editor's list instead." : "This note isn't waiting to be sent." };
  const at = new Date();
  const won = await prisma.portalComment.updateMany({ where: { id: c.id, status: "OPEN", decisionId: null }, data: { status: "RESOLVED", resolvedAt: at, resolvedBy: actor.name.slice(0, 120), resolvedByKind: "STAFF" } });
  if (won.count === 0) return { ok: false, message: "It was sent a moment ago. Reload to see it." };
  const change = await prisma.noteChange.create({ data: { noteKind: "PORTAL_COMMENT", noteId: c.id, projectId: c.projectId, submissionId: c.submissionId, action: "HELD_BACK", beforeBody: c.body, actorName: actor.name.slice(0, 120), actorUserId: actor.userId, at } });
  await timeline(c.projectId, `${actor.name} held back a client's note from the editor${c.timeSec != null ? ` (at ${clock(c.timeSec)})` : ""}: "${clip(c.body, 240)}". The client's note stays on their page.`, actor.tmId);
  return { ok: true, changeId: change.id, message: "Held back. It won't go to the editor, and the client's note stays on their page." };
}

/** Change what the editor gets from a client's note, before or after it is sent. */
export async function rewordClientNote(commentId: string, words: string, actor: NoteActor): Promise<NoteResult> {
  if (!mayCorrectClientNote(actor.changer)) return { ok: false, message: "Only the owner, the office or the creative manager can change what the editor gets from a client." };
  const text = (words ?? "").trim().slice(0, 1000);
  if (text.length < 3) return { ok: false, message: "Write what the editor should get." };
  const c = await clientNote(commentId);
  if (!c || c.parentId) return { ok: false, message: "That note isn't there any more." };
  const at = new Date();
  if (c.status === "OPEN" && !c.decisionId) {
    // Not sent yet: kept, and used when it is sent (clientDecisions.attributedNoteLines).
    await prisma.noteChange.updateMany({ where: { noteKind: "PORTAL_COMMENT", noteId: c.id, action: "REWORDED", undoneAt: null }, data: { undoneAt: at, undoneBy: `${actor.name.slice(0, 100)} (reworded again)` } });
    const change = await prisma.noteChange.create({ data: { noteKind: "PORTAL_COMMENT", noteId: c.id, projectId: c.projectId, submissionId: c.submissionId, action: "REWORDED", beforeBody: c.body, afterBody: text, actorName: actor.name.slice(0, 120), actorUserId: actor.userId, at } });
    return { ok: true, changeId: change.id, message: "Saved. When the note goes to the editor, they get your wording with the client's words beside it." };
  }
  if (!c.decisionId) return { ok: false, message: "This note was resolved without going to the editor, so there is nothing to change." };
  const hits = await itemsOfClientNote(c);
  if (!hits.length) return { ok: false, message: CANT_MATCH };
  const ask = `${c.timeSec != null ? `[${clock(c.timeSec)}] ` : ""}${text}`;
  const before = hits.map((h) => ({ briefId: h.briefId, index: h.index, ask: h.item.ask, quote: h.item.quote ?? null }));
  for (const h of hits) {
    const items = [...h.doc.items];
    items[h.index] = { ...h.item, ask, quote: h.item.quote ?? h.item.ask, reworded: { by: actor.name.slice(0, 120), at: at.toISOString() } };
    await prisma.revisionBrief.update({ where: { id: h.briefId }, data: { itemsJson: JSON.stringify({ ...h.doc, items }) } });
    for (const issue of await issuesOfItem(h.briefId, h.item.id)) {
      await prisma.revisionIssue.update({ where: { id: issue.id }, data: { summary: text.slice(0, 300) } });
      await issueEvent(issue.id, "NOTE_REWORDED", actor, issue.summary ?? issue.originalText, text, "our wording for the client's note; their words are kept");
    }
  }
  const change = await prisma.noteChange.create({
    data: { noteKind: "PORTAL_COMMENT", noteId: c.id, projectId: c.projectId, submissionId: c.submissionId, action: "REWORDED", beforeBody: hits[0].item.ask, afterBody: text, afterSend: true, actorName: actor.name.slice(0, 120), actorUserId: actor.userId, at, snapshotJson: JSON.stringify({ before }) },
  });
  const editorKey = await clientNoteEditor(hits, c.projectId);
  const line = editorChangeLine({ action: "REWORDED", by: actor.name, timeSec: c.timeSec, before: c.body, after: text });
  await tellEditor({ projectId: c.projectId, submissionId: c.submissionId, editorKey, line, change: { action: "REWORDED", by: actor.name, timeSec: c.timeSec }, dedupeKey: `client-note-change-${change.id}`, actorTmId: actor.tmId, kind: "revision_addendum" });
  await timeline(c.projectId, `${actor.name} changed how a client's note reads for the editor. The client wrote: "${clip(c.body, 200)}". The editor now gets: "${clip(text, 200)}".`, actor.tmId);
  return { ok: true, changeId: change.id, message: `Saved. ${editorNameOf(editorKey) ?? "The editor"} has been told what changed. The client's words stay on their page and beside the item.` };
}

/** Take a sent client note off the editor's list (its item set aside, its issue not needed). */
export async function removeClientNoteFromList(commentId: string, actor: NoteActor): Promise<NoteResult> {
  if (!mayCorrectClientNote(actor.changer)) return { ok: false, message: "Only the owner, the office or the creative manager can change what the editor gets from a client." };
  const c = await clientNote(commentId);
  if (!c || c.parentId) return { ok: false, message: "That note isn't there any more." };
  if (!c.decisionId) return { ok: false, message: "It hasn't gone to the editor. Use Hold back instead." };
  const hits = await itemsOfClientNote(c);
  if (!hits.length) return { ok: false, message: CANT_MATCH };
  const at = new Date();
  const kept: { briefId: string; index: number; item: BriefItem; issues: { id: string; state: string }[] }[] = [];
  // Per brief, highest index first, so earlier indexes stay where they are.
  for (const h of [...hits].sort((a, b) => b.index - a.index)) {
    const fresh = await prisma.revisionBrief.findUnique({ where: { id: h.briefId }, select: { itemsJson: true } });
    let doc: (Record<string, unknown> & { items: BriefItem[]; setAside?: unknown[] }) | null = null;
    try { doc = JSON.parse(fresh?.itemsJson ?? "null"); } catch { doc = null; }
    if (!doc || !Array.isArray(doc.items)) continue;
    const index = doc.items.findIndex((it) => it.id === h.item.id);
    if (index === -1) continue;
    const [item] = doc.items.splice(index, 1);
    const setAside = Array.isArray(doc.setAside) ? doc.setAside : [];
    setAside.push({ ...item, setAsideBy: actor.name.slice(0, 120), setAsideAt: at.toISOString() });
    await prisma.revisionBrief.update({ where: { id: h.briefId }, data: { itemsJson: JSON.stringify({ ...doc, setAside }) } });
    const issues: { id: string; state: string }[] = [];
    for (const issue of await issuesOfItem(h.briefId, item.id)) {
      if (!FIX_STATES_LIVE.concat("VERIFIED").includes(issue.state)) continue;
      const off = await prisma.revisionIssue.updateMany({ where: { id: issue.id, state: issue.state }, data: { state: "NOT_APPLICABLE" } });
      if (!off.count) continue;
      await issueEvent(issue.id, "NOTE_REMOVED", actor, issue.state, "NOT_APPLICABLE", "taken off the editor's list by our team; the client's words are kept");
      issues.push({ id: issue.id, state: issue.state });
    }
    kept.push({ briefId: h.briefId, index, item, issues });
  }
  if (!kept.length) return { ok: false, message: CANT_MATCH };
  const change = await prisma.noteChange.create({
    data: { noteKind: "PORTAL_COMMENT", noteId: c.id, projectId: c.projectId, submissionId: c.submissionId, action: "REMOVED", beforeBody: c.body, afterSend: true, actorName: actor.name.slice(0, 120), actorUserId: actor.userId, at, snapshotJson: JSON.stringify({ kept }) },
  });
  const editorKey = await clientNoteEditor(hits, c.projectId);
  const line = editorChangeLine({ action: "REMOVED", by: actor.name, timeSec: c.timeSec, before: c.body, after: null });
  await tellEditor({ projectId: c.projectId, submissionId: c.submissionId, editorKey, line, change: { action: "REMOVED", by: actor.name, timeSec: c.timeSec }, dedupeKey: `client-note-change-${change.id}`, actorTmId: actor.tmId, kind: "revision_addendum" });
  await timeline(c.projectId, `${actor.name} took a client's note off the editor's list: "${clip(c.body, 240)}". The client's note stays on their page.`, actor.tmId);
  return { ok: true, changeId: change.id, message: `Taken off the list. ${editorNameOf(editorKey) ?? "The editor"} has been told. The client's note stays on their page.` };
}

/** Undo a change our team made to a client's note (held back, reworded, taken off the list). */
export async function undoClientNoteChange(changeId: string, actor: NoteActor, now: Date = new Date()): Promise<NoteResult> {
  if (!mayCorrectClientNote(actor.changer)) return { ok: false, message: "Only the owner, the office or the creative manager can do that." };
  const ch = await prisma.noteChange.findUnique({ where: { id: changeId } });
  if (!ch || ch.noteKind !== "PORTAL_COMMENT") return { ok: false, message: "There is nothing to undo here." };
  if (ch.undoneAt) return { ok: true, message: "Already undone." };
  if (!undoOpen(ch.at, now)) return { ok: false, message: `Undo is only offered for ${NOTE_UNDO_HOURS} hours.` };
  const c = await clientNote(ch.noteId);
  if (!c) return { ok: false, message: "That note isn't there any more." };
  // Our wording from before the send already went to the editor in those
  // words: "undo" would change nothing they have. Word it again instead.
  if (ch.action === "REWORDED" && !ch.afterSend && (!!c.decisionId || c.status === "SENT")) {
    return { ok: false, message: "It already went to the editor in these words. Use Change what the editor gets to word it differently." };
  }
  const claimed = await prisma.noteChange.updateMany({ where: { id: ch.id, undoneAt: null }, data: { undoneAt: now, undoneBy: actor.name.slice(0, 120) } });
  if (claimed.count === 0) return { ok: true, message: "Already undone." };
  if (ch.action === "HELD_BACK") {
    const back = await prisma.portalComment.updateMany({ where: { id: c.id, status: "RESOLVED", decisionId: null, resolvedByKind: "STAFF" }, data: { status: "OPEN", resolvedAt: null, resolvedBy: null, resolvedByKind: null } });
    await timeline(c.projectId, `${actor.name} let a client's note go to the editor after all: "${clip(c.body, 200)}".`, actor.tmId);
    return { ok: true, message: back.count ? "Undone. The note goes to the editor with the others." : "Undone on our side, but the note had already changed on the client's page." };
  }
  if (ch.action === "REWORDED" && !ch.afterSend) return { ok: true, message: "Undone. The editor will get the client's own words." };
  const editorKey = await editorOf(c.projectId, null, null);
  if (ch.action === "REWORDED") {
    let before: { briefId: string; index: number; ask: string; quote: string | null }[] = [];
    try { before = (JSON.parse(ch.snapshotJson ?? "{}") as { before?: typeof before }).before ?? []; } catch { before = []; }
    for (const b of before) {
      const brief = await prisma.revisionBrief.findUnique({ where: { id: b.briefId }, select: { itemsJson: true } });
      let doc: (Record<string, unknown> & { items: BriefItem[] }) | null = null;
      try { doc = JSON.parse(brief?.itemsJson ?? "null"); } catch { doc = null; }
      const item = doc?.items?.[b.index];
      if (!doc || !item) continue;
      const items = [...doc.items];
      const { reworded: _r, ...rest } = item as BriefItem & { reworded?: unknown };
      void _r;
      items[b.index] = { ...rest, ask: b.ask, quote: b.quote };
      await prisma.revisionBrief.update({ where: { id: b.briefId }, data: { itemsJson: JSON.stringify({ ...doc, items }) } });
      for (const issue of await issuesOfItem(b.briefId, item.id)) {
        // Back to the work order's own wording for it.
        await prisma.revisionIssue.update({ where: { id: issue.id }, data: { summary: b.ask.slice(0, 300) } });
        await issueEvent(issue.id, "NOTE_REWORD_UNDONE", actor, ch.afterBody, b.ask, null);
      }
    }
    await tellEditor({ projectId: c.projectId, submissionId: c.submissionId, editorKey, line: `${actor.name.split(/\s+/)[0]} put the client's own words back on their note: "${clip(c.body, 160)}".`, change: { action: "REWORD_UNDONE", by: actor.name, timeSec: c.timeSec }, dedupeKey: `client-note-undo-${ch.id}`, actorTmId: actor.tmId, kind: "revision_addendum" });
    await timeline(c.projectId, `${actor.name} put the client's own words back on a note for the editor.`, actor.tmId);
    return { ok: true, message: "Undone. The editor has the client's own words again." };
  }
  if (ch.action === "REMOVED") {
    let kept: { briefId: string; index: number; item: BriefItem; issues?: { id: string; state: string }[] }[] = [];
    try { kept = (JSON.parse(ch.snapshotJson ?? "{}") as { kept?: typeof kept }).kept ?? []; } catch { kept = []; }
    for (const k of [...kept].sort((a, b) => a.index - b.index)) {
      const brief = await prisma.revisionBrief.findUnique({ where: { id: k.briefId }, select: { itemsJson: true } });
      let doc: (Record<string, unknown> & { items: BriefItem[]; setAside?: { id?: string }[] }) | null = null;
      try { doc = JSON.parse(brief?.itemsJson ?? "null"); } catch { doc = null; }
      if (!doc || !Array.isArray(doc.items) || doc.items.some((it) => it.id === k.item.id)) continue;
      const items = [...doc.items];
      items.splice(Math.min(k.index, items.length), 0, k.item);
      const setAside = (Array.isArray(doc.setAside) ? doc.setAside : []).filter((x) => x?.id !== k.item.id);
      await prisma.revisionBrief.update({ where: { id: k.briefId }, data: { itemsJson: JSON.stringify({ ...doc, items, setAside }) } });
      for (const i of k.issues ?? []) {
        const back = await prisma.revisionIssue.updateMany({ where: { id: i.id, state: "NOT_APPLICABLE" }, data: { state: i.state } });
        if (back.count) await issueEvent(i.id, "NOTE_RESTORED", actor, "NOT_APPLICABLE", i.state, "the client's note is back on the editor's list");
      }
    }
    await tellEditor({ projectId: c.projectId, submissionId: c.submissionId, editorKey, line: `${actor.name.split(/\s+/)[0]} put the client's note back on your list: "${clip(c.body, 160)}".`, change: { action: "REMOVE_UNDONE", by: actor.name, timeSec: c.timeSec }, dedupeKey: `client-note-undo-${ch.id}`, actorTmId: actor.tmId, kind: "revision_addendum" });
    await timeline(c.projectId, `${actor.name} put a client's note back on the editor's list: "${clip(c.body, 200)}".`, actor.tmId);
    return { ok: true, message: "Undone. It is back on the editor's list, and they have been told." };
  }
  return { ok: true, message: "Undone." };
}
