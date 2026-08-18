"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, FileImage, FolderOpen, Loader2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

// One client's asset shelf (logos, endcards, brand kit) — rendered on the edit
// page's "Client assets" section and per client on /clients/assets. The badge
// is the folder truth: files → "Assets available", empty/missing → "No assets".
// Upload goes through /api/client-assets/upload (owner/admin/editor).

export type AssetFileView = { name: string; url: string | null };

export function ClientAssetsCard({
  clientId,
  files,
  folderUrl,
  canUpload,
  compact = false,
}: {
  clientId: string;
  files: AssetFileView[];
  folderUrl: string | null;
  canUpload: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const onPick = (list: FileList | null) => {
    const file = list?.[0];
    if (!file || pending) return;
    start(async () => {
      setMsg(null);
      try {
        const form = new FormData();
        form.set("clientId", clientId);
        form.set("file", file);
        const res = await fetch("/api/client-assets/upload", { method: "POST", body: form });
        const j = (await res.json()) as { ok: boolean; message?: string };
        setMsg(j.message ?? (j.ok ? "Uploaded." : "Upload failed."));
        if (j.ok) router.refresh();
      } catch {
        setMsg("Upload failed — try again.");
      } finally {
        if (inputRef.current) inputRef.current.value = "";
      }
    });
  };

  return (
    <div className={compact ? "" : "space-y-2"}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
            files.length > 0 ? "bg-success/10 text-success" : "bg-surface-2 text-muted",
          )}
        >
          {files.length > 0 ? `Assets available (${files.length})` : "No assets"}
        </span>
        {canUpload && (
          <>
            <input ref={inputRef} type="file" className="hidden" onChange={(e) => onPick(e.target.files)} />
            <button
              onClick={() => inputRef.current?.click()}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Upload asset
            </button>
          </>
        )}
        {folderUrl && (
          <a
            href={folderUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground"
          >
            <FolderOpen className="size-3.5" /> Open folder <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f) =>
            f.url ? (
              <li key={f.name}>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground/85 hover:border-brand"
                >
                  <FileImage className="size-3.5 text-muted" /> {f.name}
                </a>
              </li>
            ) : (
              <li key={f.name} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-muted">
                <FileImage className="size-3.5" /> {f.name}
              </li>
            ),
          )}
        </ul>
      )}
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}
