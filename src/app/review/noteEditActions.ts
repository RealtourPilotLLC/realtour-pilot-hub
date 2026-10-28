"use server";

import { revalidatePath } from "next/cache";
import type { NoteResult } from "@/lib/noteEdits";

// ---------------------------------------------------------------------------
// EDIT AND DELETE A REVIEW ROOM NOTE (Jordan, Oct 28 2026: "we need to be able
// to delete revision notes in the review room and also edit them"). Thin doors
// onto lib/noteEdits, which holds the rules: who may (the note's author, plus
// the owner, the office and the creative manager on any staff note; only the
// desk on a client's note), and what the editor is told once they have it.
// "View as" writes nothing, as everywhere in the Review Room.
// ---------------------------------------------------------------------------

async function noteActor() {
  const { noteActorFromSession } = await import("@/lib/noteEdits");
  return noteActorFromSession();
}

async function refreshFor(projectId: string | null): Promise<void> {
  revalidatePath("/review");
  revalidatePath("/editing");
  if (projectId) {
    revalidatePath(`/review/${projectId}`);
    revalidatePath(`/edit/${projectId}`);
  }
}

async function projectOfNote(kind: "MEDIA_NOTE" | "PORTAL_COMMENT" | "CHANGE", id: string): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");
  if (kind === "MEDIA_NOTE") return (await prisma.mediaNote.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null))?.projectId ?? null;
  if (kind === "PORTAL_COMMENT") return (await prisma.portalComment.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null))?.projectId ?? null;
  return (await prisma.noteChange.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null))?.projectId ?? null;
}

const bad = (id: unknown) => typeof id !== "string" || !/^[a-z0-9_-]{6,64}$/i.test(id);

/** Change a Review Room note's words. */
export async function editCutNote(noteId: string, body: string): Promise<NoteResult> {
  if (bad(noteId) || typeof body !== "string") return { ok: false, message: "That note isn't there." };
  const a = await noteActor();
  if (!a.ok) return a;
  const { editStaffNote } = await import("@/lib/noteEdits");
  const r = await editStaffNote(noteId, body, a.actor);
  if (r.ok) await refreshFor(await projectOfNote("MEDIA_NOTE", noteId));
  return r;
}

/** Delete a Review Room note (Undo for a day: undoCutNoteDelete). */
export async function deleteCutNote(noteId: string): Promise<NoteResult> {
  if (bad(noteId)) return { ok: false, message: "That note isn't there." };
  const a = await noteActor();
  if (!a.ok) return a;
  const projectId = await projectOfNote("MEDIA_NOTE", noteId);
  const { deleteStaffNote } = await import("@/lib/noteEdits");
  const r = await deleteStaffNote(noteId, a.actor);
  if (r.ok) await refreshFor(projectId);
  return r;
}

/** Put a deleted note back. */
export async function undoCutNoteDelete(changeId: string): Promise<NoteResult> {
  if (bad(changeId)) return { ok: false, message: "There is nothing to undo here." };
  const a = await noteActor();
  if (!a.ok) return a;
  const { undoNoteDelete } = await import("@/lib/noteEdits");
  const r = await undoNoteDelete(changeId, a.actor);
  if (r.ok) await refreshFor(await projectOfNote("CHANGE", changeId));
  return r;
}

/** A client's note: hold it back from the editor (before it is sent). */
export async function holdBackClientNoteAction(commentId: string): Promise<NoteResult> {
  if (bad(commentId)) return { ok: false, message: "That note isn't there." };
  const a = await noteActor();
  if (!a.ok) return a;
  const { holdBackClientNote } = await import("@/lib/noteEdits");
  const r = await holdBackClientNote(commentId, a.actor);
  if (r.ok) await refreshFor(await projectOfNote("PORTAL_COMMENT", commentId));
  return r;
}

/** A client's note: change what the editor gets (before or after it is sent). */
export async function rewordClientNoteAction(commentId: string, words: string): Promise<NoteResult> {
  if (bad(commentId) || typeof words !== "string") return { ok: false, message: "That note isn't there." };
  const a = await noteActor();
  if (!a.ok) return a;
  const { rewordClientNote } = await import("@/lib/noteEdits");
  const r = await rewordClientNote(commentId, words, a.actor);
  if (r.ok) await refreshFor(await projectOfNote("PORTAL_COMMENT", commentId));
  return r;
}

/** A client's note: take it off the editor's list (after it is sent). */
export async function removeClientNoteAction(commentId: string): Promise<NoteResult> {
  if (bad(commentId)) return { ok: false, message: "That note isn't there." };
  const a = await noteActor();
  if (!a.ok) return a;
  const { removeClientNoteFromList } = await import("@/lib/noteEdits");
  const r = await removeClientNoteFromList(commentId, a.actor);
  if (r.ok) await refreshFor(await projectOfNote("PORTAL_COMMENT", commentId));
  return r;
}

/** Undo any of the three above. */
export async function undoClientNoteChangeAction(changeId: string): Promise<NoteResult> {
  if (bad(changeId)) return { ok: false, message: "There is nothing to undo here." };
  const a = await noteActor();
  if (!a.ok) return a;
  const { undoClientNoteChange } = await import("@/lib/noteEdits");
  const r = await undoClientNoteChange(changeId, a.actor);
  if (r.ok) await refreshFor(await projectOfNote("CHANGE", changeId));
  return r;
}
