"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { History, Loader2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { deleteCutNote, editCutNote, undoCutNoteDelete } from "@/app/review/noteEditActions";
import { byLine, whenET } from "@/lib/reviewAttribution";
import { clock } from "@/lib/noteEditCore";
import type { CutNoteEdit } from "@/lib/reviewRoom";

// ---------------------------------------------------------------------------
// EDIT AND DELETE A NOTE (Jordan, Oct 28 2026: "we need to be able to delete
// revision notes in the review room and also edit them"). One control for the
// Review Room's note list and the editor's own notes on /edit: Edit (words in
// place, Save / Cancel) and Delete (Undo for a day, from the "Deleted" lines
// the panel shows). The server decides who may (lib/noteEdits); `canChange`
// only stops offering what it would refuse. When the editor already has the
// note, the words say so before anything is saved.
// ---------------------------------------------------------------------------

const BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50";

export type EditableNote = {
  id: string;
  body: string;
  canChange?: boolean;
  sent?: boolean;
  editorName?: string | null;
  wasFixed?: boolean;
  edits?: CutNoteEdit[];
};

/** "edited" with the earlier words, for everyone who can see the note. */
export function NoteEditHistory({ edits }: { edits?: CutNoteEdit[] }) {
  if (!edits?.length) return null;
  const last = edits[edits.length - 1];
  return (
    <details className="mt-1 text-[13px] text-muted" data-note-edits>
      <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1.5">
        <History aria-hidden className="size-3.5" /> Edited by {byLine(last.by, last.atISO)}{edits.length > 1 ? ` (${edits.length} times)` : ""}. See the earlier version{edits.length > 1 ? "s" : ""}
      </summary>
      <ol className="mt-1 space-y-1 border-l-2 border-border pl-3">
        {edits.map((e, i) => (
          <li key={i} className="min-w-0 break-words">
            <span className="text-foreground/75">&ldquo;{e.before}&rdquo;</span>
            <span className="ml-1 text-[11px] text-muted-2">until {whenET(e.atISO)}, changed by {e.by}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function NoteEditControls({ note, label = "note", onChanged }: { note: EditableNote; label?: string; onChanged?: (message: string) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [words, setWords] = useState(note.body);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  if (!note.canChange) return null;
  const who = note.editorName ?? "The editor";

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) =>
    start(async () => {
      setErr(null);
      const r = await fn();
      if (!r.ok) { setErr(r.message); return; }
      after?.();
      onChanged?.(r.message);
      router.refresh();
    });

  if (editing) {
    return (
      <div className="mt-2 space-y-2" data-note-editing>
        <AutoTextarea
          autoFocus
          minRows={2}
          maxRows={10}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          aria-label={`Change this ${label}`}
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-base outline-none focus:border-brand sm:text-sm"
        />
        {note.sent && (
          <p className="text-[13px] text-warning">
            {who} already has this {label}. Saving tells them what changed{note.wasFixed ? ", and because they marked it fixed, it opens again for them" : ""}.
          </p>
        )}
        {!note.sent && note.wasFixed && <p className="text-[13px] text-warning">It was marked fixed. Saving opens it again.</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || !words.trim() || words.trim() === note.body.trim()}
            onClick={() => run(() => editCutNote(note.id, words), () => setEditing(false))}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />} Save
          </button>
          <button type="button" disabled={pending} onClick={() => { setEditing(false); setWords(note.body); setErr(null); }} className={BTN}>Cancel</button>
        </div>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2" data-note-controls>
      {confirmDelete ? (
        <div role="group" aria-label={`Delete this ${label}?`} className="space-y-2 rounded-lg border border-danger/30 bg-danger-soft/30 p-2.5">
          <p className="text-sm">{who} already has this {label}. Delete it and tell them it is no longer needed?</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => deleteCutNote(note.id), () => setConfirmDelete(false))} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-danger-action px-4 text-sm font-semibold text-white disabled:opacity-50">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete and tell {note.editorName ? note.editorName.split(/\s+/)[0] : "them"}
            </button>
            <button type="button" disabled={pending} onClick={() => setConfirmDelete(false)} className={BTN}>Keep it</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => { setWords(note.body); setEditing(true); }} className={BTN} data-note-edit>
            <Pencil aria-hidden className="size-4" /> Edit
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => (note.sent ? setConfirmDelete(true) : run(() => deleteCutNote(note.id)))}
            className={`${BTN} text-danger hover:bg-danger-soft/40`}
            data-note-delete
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 aria-hidden className="size-4" />} Delete
          </button>
        </div>
      )}
      {err && <p role="alert" className="mt-1 text-sm text-danger">{err}</p>}
    </div>
  );
}

export type DeletedNote = { changeId: string; body: string; timeSec: number | null; by: string; atISO: string; afterSend: boolean; canUndo: boolean; reply?: boolean };

/** The notes deleted from this cut lately: who, when, and Undo while it is open. */
export function DeletedNotes({ notes }: { notes: DeletedNote[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!notes.length) return null;
  return (
    <div className="rounded-2xl border border-dashed border-border px-3 py-2" data-deleted-notes>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-2">Deleted</p>
      <ul className="mt-1 divide-y divide-border">
        {notes.map((n) => (
          <li key={n.changeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
            <span className="min-w-0 flex-1 break-words text-muted">
              {n.reply && <span className="mr-1">Reply:</span>}
              {n.timeSec != null && <span className="mr-1 tabular-nums">{clock(n.timeSec)}</span>}
              <span className="line-through">&ldquo;{n.body.length > 160 ? `${n.body.slice(0, 159)}…` : n.body}&rdquo;</span>
              <span className="ml-1 text-[12px] text-muted-2">deleted by {byLine(n.by, n.atISO)}{n.afterSend ? ", the editor was told" : ""}</span>
            </span>
            {n.canUndo && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setBusy(n.changeId);
                  start(async () => {
                    setErr(null);
                    const r = await undoCutNoteDelete(n.changeId);
                    setBusy(null);
                    if (!r.ok) setErr(r.message);
                    else router.refresh();
                  });
                }}
                className={BTN}
                data-note-undo
              >
                {busy === n.changeId ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw aria-hidden className="size-4" />} Undo
              </button>
            )}
          </li>
        ))}
      </ul>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </div>
  );
}
