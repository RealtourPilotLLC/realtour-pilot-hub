"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil } from "lucide-react";
import { saveJobNotes } from "@/app/editing/actions";
import { Markdown } from "@/components/ui/Markdown";

// An editable job note. Reads as plain text until you click it, so the brief
// stays a briefing and only becomes a form when someone means to change
// something. Read-only for anyone without permission (editors). Lived inside
// the queue's expanded row until Aug 27 — Jordan: "the notes can be inside the
// edit page" — so now it renders on /edit/<id> where the editor already works.
export function JobNoteEditor({
  projectId, field, value, canEdit, label, placeholder, empty,
}: {
  projectId: string;
  field: "customer" | "shoot";
  value: string | null;
  canEdit: boolean;
  label: string;
  placeholder: string;
  empty: string;
}) {
  const [text, setText] = useState(value ?? "");
  const [saved, setSaved] = useState<string | null>(value);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  function save() {
    const next = text.trim();
    startSave(async () => {
      const r = await saveJobNotes(projectId, { [field]: next });
      if (r.ok) { setSaved(next || null); setOpen(false); setErr(null); }
      else setErr(r.message);
    });
  }

  if (!open) {
    return (
      <div className="group">
        {label && saved && <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">{label}</div>}
        {/* Read mode renders the note as light markdown — people write these
            with **bold** section names, bullets and a pasted example link, and
            the raw text read as one blob (Jordan, Sep 10: 632 Greenridge). */}
        {saved ? (
          <Markdown content={saved} className="text-sm leading-relaxed text-foreground/85" />
        ) : (
          <p className="text-sm leading-relaxed text-muted-2">{empty}</p>
        )}
        {canEdit && (
          <button
            onClick={() => { setText(saved ?? ""); setOpen(true); }}
            className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <Pencil className="size-2.5" />
            {saved ? "Edit" : "Add a note"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={5}
        className="w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm leading-relaxed outline-none focus:border-brand"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {saving && <Loader2 className="size-3 animate-spin" />}
          Save
        </button>
        <button
          onClick={() => { setOpen(false); setText(saved ?? ""); setErr(null); }}
          className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2"
        >
          Cancel
        </button>
      </div>
      {err && <p className="mt-1 text-[10px] text-danger">{err}</p>}
    </div>
  );
}
