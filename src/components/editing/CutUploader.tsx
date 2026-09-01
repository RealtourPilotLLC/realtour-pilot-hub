"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { CheckCircle2, CloudUpload, Loader2, RotateCcw, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { startCutUpload, finishCutUpload, abandonCutUpload } from "@/app/review/actions";

// ---------------------------------------------------------------------------
// "Upload version N" — the editor's way into the Review Room (Jordan, Sep 1:
// cuts come in through the editor portal as Version 1, get reviewed, come
// back with revisions marked, and on approval go to Dropbox and get marked
// complete — per deliverable). One row per cut the job owes.
//
// The file goes straight from this browser to the hub's store in resumable
// parts (nothing large touches a server); the server only hands out a
// path-scoped token and records the result.
// ---------------------------------------------------------------------------

export type CutRow = {
  deliverableId: string;
  slot: number;
  label: string;
  latest: { id: string; round: number; status: string; fileName: string | null; completedAt: string | null } | null;
  openNotes: number;
};

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);

function StatusPill({ latest }: { latest: CutRow["latest"] }) {
  if (!latest) return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">Not uploaded yet</span>;
  if (latest.status === "APPROVED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
        <CheckCircle2 className="size-3" /> Approved{latest.completedAt ? " · in Dropbox" : " · copying to Dropbox"}
      </span>
    );
  }
  if (latest.status === "CHANGES_REQUESTED") {
    return <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger"><Undo2 className="size-3" /> Changes requested on v{latest.round}</span>;
  }
  return <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">v{latest.round} in review</span>;
}

export function CutUploader({ projectId, cuts, canUpload }: { projectId: string; cuts: CutRow[]; canUpload: boolean }) {
  const router = useRouter();
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [busy, setBusy] = useState<Record<string, { pct: number; label: string }>>({});
  const [err, setErr] = useState<Record<string, string>>({});

  async function send(cut: CutRow, file: File) {
    const key = `${cut.deliverableId}:${cut.slot}`;
    setErr((e) => ({ ...e, [key]: "" }));
    setBusy((b) => ({ ...b, [key]: { pct: 0, label: "Starting…" } }));
    const started = await startCutUpload({ projectId, deliverableId: cut.deliverableId, slot: cut.slot, fileName: file.name, sizeBytes: file.size })
      .catch(() => ({ ok: false as const, message: "Couldn't start the upload — try again." }));
    if (!started.ok) {
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setErr((e) => ({ ...e, [key]: started.message }));
      return;
    }
    let landed: string | null = null;
    try {
      const blob = await upload(started.pathname, file, {
        access: "public",
        handleUploadUrl: "/api/review/upload",
        clientPayload: JSON.stringify({ submissionId: started.submissionId }),
        multipart: true,
        contentType: file.type || "application/octet-stream",
        onUploadProgress: ({ percentage }) => setBusy((b) => ({ ...b, [key]: { pct: percentage, label: `Uploading ${fmtBytes(file.size)}…` } })),
      });
      landed = blob.url;
      setBusy((b) => ({ ...b, [key]: { pct: 100, label: "Checking the file…" } }));
      const done = await finishCutUpload({ submissionId: started.submissionId, url: blob.url, pathname: blob.pathname });
      if (!done.ok) throw new Error(done.message);
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      router.refresh();
    } catch (e) {
      await abandonCutUpload(started.submissionId, landed).catch(() => {});
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setErr((er) => ({ ...er, [key]: e instanceof Error ? e.message : "The upload failed — try again." }));
    }
  }

  if (cuts.length === 0) return null;
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-brand/25 bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <CloudUpload className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Cuts to deliver</h2>
        <span className="text-xs text-muted">
          {cuts.filter((c) => c.latest?.status === "APPROVED").length} of {cuts.length} approved
        </span>
      </div>
      <ul className="divide-y divide-border">
        {cuts.map((c) => {
          const key = `${c.deliverableId}:${c.slot}`;
          const b = busy[key];
          const next = (c.latest?.status === "APPROVED") ? null : (c.latest ? c.latest.round + 1 : 1);
          const isRedo = c.latest?.status === "CHANGES_REQUESTED";
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.label}</span>
                  <StatusPill latest={c.latest} />
                  {c.openNotes > 0 && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">{c.openNotes} note{c.openNotes === 1 ? "" : "s"} to fix</span>
                  )}
                </div>
                {c.latest?.fileName && <p className="mt-0.5 truncate text-xs text-muted-2">{c.latest.fileName}</p>}
                {b && (
                  <div className="mt-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.max(2, b.pct)}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted">{b.label} {b.pct > 0 && b.pct < 100 ? `${Math.round(b.pct)}%` : ""}</p>
                  </div>
                )}
                {err[key] && <p className="mt-1 text-xs text-danger">{err[key]}</p>}
              </div>
              {canUpload && next && (
                <>
                  <input
                    ref={(el) => { inputs.current[key] = el; }}
                    type="file"
                    accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void send(c, f); }}
                  />
                  <button
                    type="button"
                    disabled={!!b}
                    onClick={() => inputs.current[key]?.click()}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60",
                      isRedo ? "bg-danger hover:opacity-90" : "bg-brand hover:opacity-90",
                    )}
                  >
                    {b ? <Loader2 className="size-4 animate-spin" /> : isRedo ? <RotateCcw className="size-4" /> : <CloudUpload className="size-4" />}
                    {b ? "Uploading" : `Upload version ${next}`}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-2 sm:px-5">
        The file goes straight to the hub in resumable parts and lands in the Review Room as the next version. Once a cut is approved it is copied to the job&apos;s Final folder in Dropbox automatically.
      </p>
    </section>
  );
}
