"use client";

import { useEffect, useState } from "react";
import { ExternalLink, FileText, Loader2 } from "lucide-react";
import { etDateTime } from "@/lib/datetime";

// The photographer's instructions as a file in the job's Dropbox folder (Oct
// 22 2026), on the editor brief's "From the shoot". Open goes through
// /api/instructions/<projectId> (a Dropbox temporary link behind the brief's
// own access rule); a .txt, .md, .docx or .pdf is also read out here so the
// editor does not have to leave the brief.
const INLINE_RE = /\.(txt|md|docx|pdf)$/i;

export function DropboxInstructionsFile({ projectId, file }: { projectId: string; file: { name: string; atISO: string | null; by: string | null } }) {
  const inline = INLINE_RE.test(file.name);
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "failed">(inline ? "loading" : "idle");
  const href = `/api/instructions/${encodeURIComponent(projectId)}`;

  useEffect(() => {
    if (!inline) return;
    let live = true;
    fetch(`${href}?as=text`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { text: string | null }) => { if (live) { setText(j.text); setState("done"); } })
      .catch(() => { if (live) setState("failed"); });
    return () => { live = false; };
  }, [href, inline]);

  return (
    <div className="rounded-lg border border-brand/30 bg-brand-soft/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2">Instructions in Dropbox</div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <FileText aria-hidden className="size-4 shrink-0 text-brand" />
            <span className="truncate">{file.name}</span>
          </p>
          {(file.by || file.atISO) && (
            <p className="text-xs text-muted">Added {file.by ? `by ${file.by}` : ""}{file.atISO ? ` · ${etDateTime(file.atISO)}` : ""}</p>
          )}
        </div>
        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium hover:bg-surface-2">
          <ExternalLink aria-hidden className="size-3.5" /> Open
        </a>
      </div>
      {state === "loading" && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted"><Loader2 aria-hidden className="size-3.5 animate-spin" /> Reading the file…</p>}
      {state === "done" && text && <p className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap border-t border-border pt-2 text-sm leading-relaxed text-foreground/85">{text}</p>}
      {state === "failed" && <p className="mt-2 text-xs text-muted">Couldn&apos;t read it here. Press Open to see the file in Dropbox.</p>}
    </div>
  );
}
