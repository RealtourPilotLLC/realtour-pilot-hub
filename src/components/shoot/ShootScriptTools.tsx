"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, MessageSquare, PencilLine, Send } from "lucide-react";
import { editScriptOnSite, scriptsTextDraft, textScriptsToAgent } from "@/app/shoot/actions";
import { ScriptWordsEditor, type EditableParts } from "@/components/script/ScriptWordsEditor";

// ---------------------------------------------------------------------------
// SCRIPTS ON THE SHOOT SCREEN (Oct 14 2026, Jordan: photographers "edit each
// individual script on site and also download the PDF and also text the PDF of
// the scripts to the agent"). Per script: Download PDF and Edit the wording.
// For the session: Download all, and Text the scripts to the agent (the text
// is drafted with the link, shown, editable, then sent by the photographer).
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-foreground hover:border-brand/40 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";

export function ScriptCardTools({ projectId, scriptId, versionId, parts, canEdit }: { projectId: string; scriptId: string; versionId: string; parts: EditableParts | null; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="mt-3">
      {!editing && (
        <div className="flex flex-wrap items-center gap-2">
          <a href={`/api/portal/scripts/shoot/${projectId}?script=${scriptId}`} className={btn}><Download className="size-4" /> Download PDF</a>
          {canEdit && parts && <button type="button" onClick={() => { setEditing(true); setNote(null); }} className={btn}><PencilLine className="size-4" /> Edit the wording</button>}
        </div>
      )}
      {editing && parts && (
        <ScriptWordsEditor
          parts={parts}
          intro="Change the wording with the agent. It saves as a new version: the agent's page, the editor's brief and the PDF all get it."
          onSave={(w) => editScriptOnSite(projectId, scriptId, versionId, w)}
          onCancel={() => setEditing(false)}
          onSaved={(m) => { setEditing(false); setNote(m); router.refresh(); }}
        />
      )}
      {note && <p role="status" className="mt-2 text-sm text-success">{note}</p>}
    </div>
  );
}

export function ShootScriptsBar({ projectId, agentFirst, count, canText }: { projectId: string; agentFirst: string; count: number; canText: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const open = () =>
    start(async () => {
      setMsg(null);
      const r = await scriptsTextDraft(projectId).catch(() => ({ ok: false, message: "That didn't work. Try again.", text: undefined }));
      if (r.ok && r.text) setDraft(r.text);
      else setMsg({ ok: false, text: r.message ?? "That didn't work." });
    });
  const send = () =>
    start(async () => {
      const r = await textScriptsToAgent(projectId, draft ?? "").catch((e) => ({ ok: false, message: e instanceof Error ? e.message : "That didn't send." }));
      setMsg({ ok: r.ok, text: r.ok ? `Sent to ${agentFirst}.` : r.message });
      if (r.ok) setDraft(null);
    });
  return (
    <div className="rounded-xl border border-brand/25 bg-brand-soft/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={`/api/portal/scripts/shoot/${projectId}`} className={btn}><Download className="size-4" /> Download {count === 1 ? "the script" : `all ${count} scripts`} (PDF)</a>
        {canText && draft == null && (
          <button type="button" onClick={open} disabled={busy} className={btn}>{busy ? <Loader2 className="size-4 animate-spin" /> : <MessageSquare className="size-4" />} Text the scripts to {agentFirst}</button>
        )}
      </div>
      {draft != null && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs font-semibold" htmlFor={`scripts-text-${projectId}`}>The text {agentFirst} gets (edit it if you like, keep the link)</label>
          <textarea id={`scripts-text-${projectId}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className="block w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={send} disabled={busy || !draft.trim()} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send</button>
            <button type="button" onClick={() => setDraft(null)} disabled={busy} className="min-h-11 rounded-xl border border-border px-4 text-sm text-muted hover:text-foreground disabled:opacity-50">Cancel</button>
          </div>
          <p className="text-[11px] text-muted">The link opens the PDF on their phone, no sign-in, and always shows the latest wording.</p>
        </div>
      )}
      {msg && <p role="status" className={`mt-2 text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}
