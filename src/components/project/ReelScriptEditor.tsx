"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { saveReelScript } from "@/app/editing/actions";

// The script block of ReelScriptCard, editable in place for owner/admin. Reads
// exactly like the static block until "Edit script" is pressed, so the crew's
// view of the card does not change at all.
export function ReelScriptEditor({ projectId, script }: { projectId: string; script: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(script);
  const [shown, setShown] = useState(script);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveReelScript(projectId, draft);
      setMsg(r.message);
      if (r.ok) { setShown(draft.trim()); setEditing(false); }
    });
  }

  if (!editing) {
    return (
      <div>
        <div className="max-h-80 overflow-y-auto scroll-thin rounded-xl bg-surface-2/50 p-3 leading-relaxed">
          <Markdown content={shown} />
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <button
            onClick={() => { setDraft(shown); setEditing(true); setMsg(null); }}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            <Pencil className="size-3" /> Edit script
          </button>
          {msg && <span className="text-[11px] text-muted">{msg}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={14}
        autoFocus
        className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={pending || !draft.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[13px] font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save script
        </button>
        <button
          onClick={() => { setEditing(false); setDraft(shown); }}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <X className="size-3.5" /> Cancel
        </button>
        <span className="text-[11px] text-muted-2">The editor cuts to whatever is saved here. Markdown is fine.</span>
      </div>
      {msg && <p className="text-[11px] text-muted">{msg}</p>}
    </div>
  );
}
