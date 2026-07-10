"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Upload,
  CheckCircle2,
  Circle,
  AlertTriangle,
  Star,
  Flag,
  FileText,
  Loader2,
} from "lucide-react";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { markDeliverableUploaded, flagIssue, finalizeUpload } from "@/app/upload/actions";
import { cn } from "@/lib/utils";
import type { DeliverableType, DeliverableStatus } from "@prisma/client";
import { etDateTime } from "@/lib/datetime";

type Deliverable = {
  id: string;
  type: DeliverableType;
  quantity: number;
  status: DeliverableStatus;
  uploadedAt: string | null;
};

// A deliverable counts as already-uploaded if the photographer ticked it, or the
// hub already detected its files in Dropbox (status moved past PENDING).
const DETECTED: DeliverableStatus[] = ["UPLOADED", "IN_PROGRESS", "DONE"];
function initialUploaded(d: Deliverable): boolean {
  return d.uploadedAt != null || DETECTED.includes(d.status);
}

export function UploadPortal({
  project,
  deliverables,
  specialRequests,
  flags: initialFlags,
}: {
  project: {
    id: string;
    title: string;
    addressLine: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    packageName: string | null;
    shootDate: string | null;
    status: string;
    editorBrief: string | null;
    uploadedAt: string | null;
    editorPdfPath: string | null;
    clientName: string;
    editingPreferences: string | null;
    photographerName: string | null;
  };
  deliverables: Deliverable[];
  specialRequests: string[];
  flags: string[];
}) {
  const [uploaded, setUploaded] = useState<Record<string, boolean>>(
    Object.fromEntries(deliverables.map((d) => [d.id, initialUploaded(d)])),
  );
  const [editorBrief, setEditorBrief] = useState(project.editorBrief ?? "");
  const [flags, setFlags] = useState(initialFlags);
  const [flagInput, setFlagInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [, startToggle] = useTransition();
  const [done, setDone] = useState(project.uploadedAt != null);
  const [pdfPath, setPdfPath] = useState<string | null>(project.editorPdfPath);
  const [err, setErr] = useState<string | null>(null);

  const addr = [project.addressLine, project.city, project.state, project.zip].filter(Boolean).join(", ");

  const total = deliverables.length;
  const doneCount = Object.values(uploaded).filter(Boolean).length;
  const remaining = deliverables.filter((d) => !uploaded[d.id]);

  function toggle(id: string) {
    const next = !uploaded[id];
    setUploaded((u) => ({ ...u, [id]: next }));
    startToggle(async () => {
      try {
        await markDeliverableUploaded(id, next);
      } catch {
        setUploaded((u) => ({ ...u, [id]: !next })); // roll back on failure
        setErr("Couldn’t save that — check your connection and try again.");
      }
    });
  }

  function submitFlag() {
    const body = flagInput.trim();
    if (!body) return;
    setFlags((prev) => [body, ...prev]);
    setFlagInput("");
    startTransition(async () => {
      await flagIssue(project.id, body);
    });
  }

  function finalize() {
    if (remaining.length > 0) {
      const ok = window.confirm(
        `${remaining.length} item${remaining.length === 1 ? " isn’t" : "s aren’t"} checked off yet ` +
          `(${remaining.map((d) => DELIVERABLE_META[d.type].label).join(", ")}).\n\nSubmit to editors anyway?`,
      );
      if (!ok) return;
    }
    setErr(null);
    startTransition(async () => {
      try {
        // The server cross-checks the ORDER against the raw folders (a video
        // job with an empty RAW-Video folder bounces back here) — one explicit
        // confirm, then force through.
        let res = await finalizeUpload(project.id, { editorBrief });
        if (res.needsConfirm) {
          const proceed = window.confirm(res.warning ?? "Some ordered items look missing. Submit anyway?");
          if (!proceed) return;
          res = await finalizeUpload(project.id, { editorBrief, force: true });
        }
        if (res.pdfPath) setPdfPath(res.pdfPath);
        setDone(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {
        setErr("Couldn’t submit — the editors were NOT notified. Please try again.");
      }
    });
  }

  return (
    <div className="mt-3 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
        <div className="mt-1 text-sm text-muted">
          {addr && <span>{addr} · </span>}
          {project.clientName}
          {project.shootDate && <span> · {etDateTime(project.shootDate)}</span>}
        </div>
        {project.packageName && <div className="mt-1 text-xs text-muted">{project.packageName}</div>}
      </div>

      {/* Success banner */}
      {done && (
        <div className="rounded-2xl border border-success/30 bg-success-soft/50 p-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="size-5" />
            <span className="font-semibold">Submitted — editors notified</span>
          </div>
          <p className="mt-1 text-sm text-foreground/80">
            Thanks! The editors know the files are in Dropbox, and the editor brief is ready for them.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {pdfPath && (
              <a
                href={pdfPath}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
              >
                <FileText className="size-4" /> View editor brief
              </a>
            )}
            <Link
              href={`/projects/${project.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg hover:opacity-90"
            >
              View project
            </Link>
          </div>
        </div>
      )}

      {/* Special requests reminder */}
      {specialRequests.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-warning">
            <Star className="size-4" /> Special requests for this shoot
          </div>
          <ul className="ml-6 list-disc space-y-0.5 text-sm text-foreground/85">
            {specialRequests.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {project.editingPreferences && (
            <p className="mt-2 text-xs text-muted">Editing preferences: {project.editingPreferences}</p>
          )}
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="font-medium">{err}</div>
        </div>
      )}

      {/* Upload checklist */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Upload checklist</h2>
          <span className="text-xs text-muted-2">{doneCount}/{total} in Dropbox</span>
        </div>
        <p className="-mt-1 text-xs text-muted">
          Drop each item’s raw files into the Dropbox folders above, then check it off here. Submit to the editors once everything’s in.
        </p>
        {deliverables.map((d) => {
          const meta = DELIVERABLE_META[d.type];
          const on = uploaded[d.id];
          return (
            <button
              key={d.id}
              onClick={() => toggle(d.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                on ? "border-success/40 bg-success-soft/30" : "bg-surface hover:bg-surface-2",
              )}
            >
              {on ? (
                <CheckCircle2 className="size-6 shrink-0 text-success" />
              ) : (
                <Circle className="size-6 shrink-0 text-muted-2" />
              )}
              <span className="flex-1">
                <span className="block text-sm font-semibold">
                  {meta.label}
                  {d.quantity > 1 && <span className="text-muted"> ×{d.quantity}</span>}
                </span>
                <span className="block text-xs text-muted">
                  {on ? "Uploaded to Dropbox" : "Not uploaded yet"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Flag an issue */}
      <div className="rounded-2xl border bg-surface p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Flag className="size-4 text-danger" /> Flag an issue
        </div>
        <div className="flex gap-2">
          <input
            value={flagInput}
            onChange={(e) => setFlagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitFlag()}
            placeholder="e.g. Couldn’t shoot the garage, missing a bedroom — heads up for the editor."
            className="flex-1 rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <button
            onClick={submitFlag}
            className="rounded-lg border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
          >
            Flag
          </button>
        </div>
        {flags.length > 0 && (
          <ul className="mt-2 space-y-1">
            {flags.map((f, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-lg bg-danger-soft/60 px-2.5 py-1.5 text-xs text-danger"
              >
                <AlertTriangle className="size-3.5" /> {f}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editor brief */}
      <div className="rounded-2xl border bg-surface p-4">
        <label className="mb-1 block text-sm font-semibold">Brief for the editor</label>
        <p className="mb-2 text-xs text-muted">
          Anything the editor should know about this edit — goes on the brief. (Optional.)
        </p>
        <textarea
          value={editorBrief}
          onChange={(e) => setEditorBrief(e.target.value)}
          rows={3}
          placeholder="e.g. House faces west so exteriors are backlit — recover sky. Seller wants the pool emphasized. Skip the cluttered office. Best reel clips at 0:10–0:40."
          className="w-full resize-none rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </div>

      {/* Submit */}
      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border bg-surface p-4 shadow-lg">
        <div className="text-sm text-muted">
          {doneCount}/{total} uploaded
          {project.photographerName && ` · ${project.photographerName}`}
        </div>
        <button
          onClick={finalize}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {done ? "Re-submit to editors" : "Submit to editors"}
        </button>
      </div>
    </div>
  );
}
