"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, FolderOpen, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { clearInstructionsInDropbox, listDropboxInstructionFiles, markInstructionsInDropbox } from "@/app/upload/instructionsActions";
import type { InstructionCandidate } from "@/lib/dropboxInstructions";

// ---------------------------------------------------------------------------
// "Instructions added to Dropbox" (Oct 22 2026, Jordan: "so the editor knows
// and we know the instructions are added, just in Dropbox"). Pick the file
// from the job's folder (or type where it is); saved at once, shown back as
// "Instructions added to Dropbox: <file> · <who> · <when>". It stands in for
// the typed flow and vision (the page's gate and the handoff both read it).
// ---------------------------------------------------------------------------

export type DropboxInstructionsView = { path: string; name: string; atISO: string | null; by: string | null } | null;

const choiceBtn = "inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors";

export function DropboxInstructions({ projectId, current, readOnly }: { projectId: string; current: DropboxInstructionsView; readOnly?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<InstructionCandidate[] | null>(null);
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      setOpen(true);
      setMsg(null);
      const r = await listDropboxInstructionFiles(projectId).catch(() => ({ ok: false as const, message: "Couldn't read the folder. Type where the file is instead." }));
      if (r.ok) setFiles(r.files);
      else { setFiles([]); setMsg({ tone: "err", text: r.message }); }
    });

  const save = (path: string) =>
    start(async () => {
      const r = await markInstructionsInDropbox(projectId, path).catch(() => ({ ok: false, message: "Couldn't save. Try again." }));
      setMsg({ tone: r.ok ? "ok" : "err", text: r.message });
      if (r.ok) { setOpen(false); setTyped(""); router.refresh(); }
    });

  const remove = () =>
    start(async () => {
      const r = await clearInstructionsInDropbox(projectId).catch(() => ({ ok: false, message: "Couldn't remove. Try again." }));
      setMsg({ tone: r.ok ? "ok" : "err", text: r.message });
      if (r.ok) router.refresh();
    });

  return (
    <div className="mb-4 border-b border-border pb-3.5" id="instructions-in-dropbox">
      <p className="text-[13px] font-medium text-muted">Edit instructions</p>
      {current && !open ? (
        <div className="mt-1.5 rounded-xl border border-success/40 bg-success/10 px-3 py-2.5">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            <span>
              <span className="font-semibold">Instructions added to Dropbox:</span> {current.name}
              <span className="text-muted">{current.by ? ` · ${current.by}` : ""}{current.atISO ? ` · ${etDateTime(current.atISO)}` : ""}</span>
            </span>
          </p>
          <p className="mt-1 pl-6 text-xs text-muted">The editor sees this file on the brief. You don&apos;t need to type the instructions again below.</p>
          {!readOnly && (
            <div className="mt-2 flex flex-wrap gap-2 pl-6">
              <button type="button" className={cn(choiceBtn, "border-border hover:bg-surface-2")} disabled={pending} onClick={load}>Change</button>
              <button type="button" className={cn(choiceBtn, "border-border text-danger hover:bg-danger/10")} disabled={pending} onClick={remove}>Remove</button>
            </div>
          )}
        </div>
      ) : !open ? (
        <div className="mt-1.5">
          {!readOnly && (
            <button type="button" className={cn(choiceBtn, "border-border bg-surface hover:border-brand/50")} disabled={pending} onClick={load}>
              {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <FolderOpen aria-hidden className="size-4" />}
              Instructions added to Dropbox
            </button>
          )}
          <p className="mt-1.5 text-xs text-muted-2">Wrote them in a file in this job&apos;s Dropbox folder? Press this and pick the file instead of typing them here.</p>
        </div>
      ) : (
        <div className="mt-1.5 space-y-2 rounded-xl border border-border bg-surface-2/50 p-3">
          <p className="text-sm font-medium">Which file has the instructions?</p>
          {files === null ? (
            <p className="flex items-center gap-2 text-sm text-muted"><Loader2 aria-hidden className="size-4 animate-spin" /> Looking in the job&apos;s folder…</p>
          ) : files.length === 0 ? (
            <p className="text-sm text-muted">No document or notes file found in the job&apos;s folder. Type where it is below.</p>
          ) : (
            <ul className="space-y-1.5">
              {files.map((f) => (
                <li key={f.path}>
                  <button type="button" disabled={pending} onClick={() => save(f.path)} className={cn(choiceBtn, "w-full justify-start border-border bg-surface text-left font-normal hover:border-brand/50")}>
                    <FileText aria-hidden className="size-4 shrink-0 text-brand" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{f.name}</span>
                      <span className="block truncate text-xs text-muted">{f.folder}{f.modifiedISO ? ` · ${etDateTime(f.modifiedISO)}` : ""}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Phone layout (Jordan, Oct 28 2026): Save and Cancel wrap under the box instead of squeezing it. */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Not listed? e.g. 02-RAW-Video/edit notes.docx"
              className="min-h-11 min-w-0 flex-1 basis-48 rounded-lg border border-border bg-surface px-3 text-sm"
              aria-label="Where the instructions file is in the job's folder"
            />
            <button type="button" className={cn(choiceBtn, "border-brand bg-brand-soft text-brand")} disabled={pending || !typed.trim()} onClick={() => save(typed)}>Save</button>
            <button type="button" className={cn(choiceBtn, "border-border hover:bg-surface-2")} disabled={pending} onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className={cn("mt-1.5 text-xs", msg.tone === "ok" ? "text-success" : "text-danger")} role="status">{msg.text}</p>}
    </div>
  );
}
