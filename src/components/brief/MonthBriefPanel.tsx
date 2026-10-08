"use client";

import { useRef, useState, useTransition } from "react";
import { FileText, Loader2, Paperclip, Trash2 } from "lucide-react";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { portalRemoveBriefFile, portalSaveBriefNotes, staffRemoveBriefFile, staffSaveBriefNotes } from "@/app/portal/briefActions";
import { BRIEF_MAX_LABEL, BRIEF_NOTES_MAX, briefFileRefusal, fmtBriefSize, type BriefFileView } from "@/lib/monthBriefCore";

// ---------------------------------------------------------------------------
// THE MONTH'S CREATIVE BRIEF — add files, paste notes, take a file back
// (Oct 8 2026). One component for the client's portal (Your Month) and the
// staff client file; `mode` picks the door. Every action answers instantly
// (the row appears or goes at once) and the server's word replaces it.
// ---------------------------------------------------------------------------

type Row = BriefFileView & { state?: "uploading" | "failed"; message?: string };

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function MonthBriefPanel({ mode, monthId, files: initialFiles, notes: initialNotes, canEdit }: {
  mode: "portal" | "staff";
  monthId: string;
  files: BriefFileView[];
  notes: { text: string; byLabel: string; atISO: string } | null;
  canEdit: boolean;
}) {
  const [files, setFiles] = useState<Row[]>(initialFiles);
  const [text, setText] = useState(initialNotes?.text ?? "");
  const [savedText, setSavedText] = useState(initialNotes?.text ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  const patch = (id: string, p: Partial<Row>) => setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const send = (file: File, tempId: string) => {
    const form = new FormData();
    form.set("monthId", monthId);
    if (mode === "staff") form.set("as", "staff");
    else {
      const auth = portalAuthFromLocation();
      if (auth.token) form.set("token", auth.token);
      if (auth.enrollmentId) form.set("enrollmentId", auth.enrollmentId);
    }
    form.set("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/portal/brief");
    xhr.onerror = () => patch(tempId, { state: "failed", message: "That upload didn't go through — check your connection and try again." });
    xhr.onload = () => {
      let j: { ok?: boolean; message?: string; file?: { id: string; name: string; size: number; byKind: "client" | "staff"; byLabel: string; atISO: string; href: string } } = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status === 413) { patch(tempId, { state: "failed", message: `Files up to ${BRIEF_MAX_LABEL} upload here.` }); return; }
      if (!j.ok || !j.file) { patch(tempId, { state: "failed", message: j.message || "That upload didn't go through — try again." }); return; }
      const f = j.file;
      setFiles((cur) => cur.map((x) => (x.id === tempId ? { id: f.id, name: f.name, size: f.size, byKind: f.byKind, byLabel: f.byLabel, atISO: f.atISO, href: f.href } : x)));
    };
    xhr.send(form);
  };
  const pick = (list: FileList | null) => {
    if (!list || !list.length) return;
    setMsg(null);
    const next: Row[] = Array.from(list).slice(0, 6).map((file, i) => {
      const refusal = briefFileRefusal(file.name, file.size);
      return { id: `tmp-${Date.now()}-${i}`, name: file.name, size: file.size, byKind: mode === "staff" ? "staff" : "client", byLabel: "", atISO: new Date().toISOString(), href: "", state: refusal ? "failed" : "uploading", message: refusal ?? undefined };
    });
    setFiles((cur) => [...cur, ...next]);
    Array.from(list).slice(0, 6).forEach((file, i) => { if (next[i].state === "uploading") send(file, next[i].id); });
    if (input.current) input.current.value = "";
  };
  const remove = (f: Row) => {
    if (f.state) { setFiles((cur) => cur.filter((x) => x.id !== f.id)); return; }
    const before = files;
    setFiles((cur) => cur.filter((x) => x.id !== f.id)); // instant
    start(async () => {
      const r = mode === "staff" ? await staffRemoveBriefFile(monthId, f.id) : await portalRemoveBriefFile(portalAuthFromLocation(), monthId, f.id);
      if (!r.ok) { setFiles(before); setMsg({ ok: false, text: r.message }); }
    });
  };
  const saveNotes = () => {
    const was = savedText;
    setSavedText(text); // instant
    setMsg({ ok: true, text: text.trim() ? "Notes saved." : "Notes cleared." });
    start(async () => {
      const r = mode === "staff" ? await staffSaveBriefNotes(monthId, text) : await portalSaveBriefNotes(portalAuthFromLocation(), monthId, text);
      if (!r.ok) { setSavedText(was); setMsg({ ok: false, text: r.message }); }
    });
  };

  return (
    <div className="space-y-3 text-sm">
      {files.length > 0 && (
        <ul className="space-y-1.5" aria-label="Brief files">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              {f.href && !f.state
                ? <a href={f.href} target="_blank" rel="noopener noreferrer" className={`min-w-0 flex-1 basis-40 break-words font-medium text-brand hover:underline ${focusRing}`}>{f.name}</a>
                : <span className="min-w-0 flex-1 basis-40 break-words font-medium">{f.name}</span>}
              <span className="text-xs text-muted-2">{fmtBriefSize(f.size)}{mode === "staff" && f.byLabel ? ` · ${f.byKind === "staff" ? "added by" : "from"} ${f.byLabel}` : ""}</span>
              {f.state === "uploading" && <Loader2 className="size-4 animate-spin text-muted" aria-label="Uploading" />}
              {canEdit && (mode === "staff" || f.byKind === "client") && (
                <button type="button" onClick={() => remove(f)} disabled={busy} className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground ${focusRing}`} aria-label={`Remove ${f.name}`}>
                  <Trash2 className="size-4" aria-hidden />
                </button>
              )}
              {f.state === "failed" && f.message && <p role="alert" className="basis-full text-xs text-warning">{f.message}</p>}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div>
          <input ref={input} type="file" multiple className="sr-only" id={`brief-file-${monthId}`} accept=".pdf,.doc,.docx,.txt,.md,.rtf,.png,.jpg,.jpeg,.webp,.heic,.gif" onChange={(e) => pick(e.target.files)} />
          <label htmlFor={`brief-file-${monthId}`} className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-4 py-2 font-medium hover:bg-surface-2 ${focusRing}`}>
            <Paperclip className="size-4" aria-hidden /> Upload a document
          </label>
          <span className="ml-2 text-xs text-muted-2">PDF, Word, pictures or text · up to {BRIEF_MAX_LABEL} each</span>
        </div>
      )}
      <div>
        <label htmlFor={`brief-notes-${monthId}`} className="text-xs font-semibold uppercase tracking-wide text-muted-2">Notes</label>
        {canEdit ? (
          <>
            <textarea id={`brief-notes-${monthId}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={BRIEF_NOTES_MAX} rows={4}
              placeholder={mode === "staff" ? "Paste their plan for the month — topics, scripts, shots." : "Paste your plan for the month — topics, scripts, shots you want."}
              className={`mt-1 block w-full rounded-xl border border-border bg-surface px-3 py-2 text-base sm:text-sm ${focusRing}`} />
            <button type="button" onClick={saveNotes} disabled={busy || text === savedText} className={`mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 py-2 font-semibold text-white disabled:opacity-50 ${focusRing}`}>
              Save notes
            </button>
          </>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-sm">{savedText || <span className="text-muted">No notes.</span>}</p>
        )}
      </div>
      {msg && <p role="status" className={`text-xs ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </div>
  );
}
