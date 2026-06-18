"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Upload,
  Paperclip,
  X,
  CheckCircle2,
  AlertTriangle,
  Star,
  Flag,
  FileText,
  Plus,
  Loader2,
  Package,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { DELIVERABLE_META, DELIVERABLE_STATUS_META } from "@/lib/pipeline";
import { uploadFiles, removeUpload, flagIssue, finalizeUpload } from "@/app/upload/actions";
import { cn } from "@/lib/utils";
import type { DeliverableType, DeliverableStatus } from "@prisma/client";
import { format } from "date-fns";

type FileRow = { id: string; originalName: string; size: number };
type Deliverable = {
  id: string;
  type: DeliverableType;
  quantity: number;
  status: DeliverableStatus;
  notes: string | null;
  uploads: FileRow[];
};

// Deliverables that should prompt the photographer for editor notes.
const NEEDS_NOTES: DeliverableType[] = ["VIDEO", "SOCIAL_REEL", "DRONE", "MATTERPORT_3D"];

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadPortal({
  project,
  deliverables: initialDeliverables,
  extraUploads: initialExtra,
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
  extraUploads: FileRow[];
  specialRequests: string[];
  flags: string[];
}) {
  const [deliverables, setDeliverables] = useState(initialDeliverables);
  const [extra, setExtra] = useState(initialExtra);
  const [itemNotes, setItemNotes] = useState<Record<string, string>>(
    Object.fromEntries(initialDeliverables.map((d) => [d.id, d.notes ?? ""])),
  );
  const [editorBrief, setEditorBrief] = useState(project.editorBrief ?? "");
  const [flags, setFlags] = useState(initialFlags);
  const [flagInput, setFlagInput] = useState("");
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(project.uploadedAt != null);
  const [pdfPath, setPdfPath] = useState<string | null>(project.editorPdfPath);

  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const addr = [project.addressLine, project.city, project.state, project.zip]
    .filter(Boolean)
    .join(", ");

  async function handleFiles(deliverableId: string | null, files: FileList | null) {
    if (!files || files.length === 0) return;
    const key = deliverableId ?? "__extra__";
    setBusyTarget(key);
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    const created = await uploadFiles(project.id, deliverableId, fd);
    if (deliverableId) {
      setDeliverables((prev) =>
        prev.map((d) =>
          d.id === deliverableId
            ? { ...d, status: "UPLOADED", uploads: [...d.uploads, ...created] }
            : d,
        ),
      );
    } else {
      setExtra((prev) => [...prev, ...created]);
    }
    setBusyTarget(null);
  }

  function handleRemove(fileId: string, deliverableId: string | null) {
    startTransition(async () => {
      await removeUpload(fileId);
      if (deliverableId) {
        setDeliverables((prev) =>
          prev.map((d) =>
            d.id === deliverableId
              ? { ...d, uploads: d.uploads.filter((u) => u.id !== fileId) }
              : d,
          ),
        );
      } else {
        setExtra((prev) => prev.filter((u) => u.id !== fileId));
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
    startTransition(async () => {
      const res = await finalizeUpload(project.id, { editorBrief, itemNotes });
      setPdfPath(res.pdfPath);
      setDone(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  const missing = deliverables.filter((d) => d.uploads.length === 0);

  return (
    <div className="mt-3 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
        <div className="mt-1 text-sm text-muted">
          {addr && <span>{addr} · </span>}
          {project.clientName}
          {project.shootDate && (
            <span> · {format(new Date(project.shootDate), "EEE MMM d, h:mm a")}</span>
          )}
        </div>
        {project.packageName && (
          <div className="mt-1 text-xs text-muted">{project.packageName}</div>
        )}
      </div>

      {/* Success banner */}
      {done && (
        <div className="rounded-2xl border border-success/30 bg-success-soft/50 p-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="size-5" />
            <span className="font-semibold">Upload complete — editors notified</span>
          </div>
          <p className="mt-1 text-sm text-foreground/80">
            Your content and notes are in. The editor brief PDF was generated and added
            to the project folder.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {pdfPath && (
              <a
                href={`/api/file?path=${encodeURIComponent(pdfPath)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
              >
                <FileText className="size-4" /> View editor brief PDF
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
            <p className="mt-2 text-xs text-muted">
              Editing preferences: {project.editingPreferences}
            </p>
          )}
        </div>
      )}

      {/* Smart reminder */}
      {!done && missing.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent" />
          <div>
            <span className="font-medium">Still to upload:</span>{" "}
            {missing.map((d) => DELIVERABLE_META[d.type].label).join(", ")}.
          </div>
        </div>
      )}

      {/* Deliverables */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Ordered items</h2>
        {deliverables.map((d) => {
          const meta = DELIVERABLE_META[d.type];
          const statusMeta = DELIVERABLE_STATUS_META[d.status];
          const needsNotes = NEEDS_NOTES.includes(d.type);
          const hasFiles = d.uploads.length > 0;
          const busy = busyTarget === d.id;
          return (
            <div
              key={d.id}
              className={cn(
                "rounded-2xl border bg-surface p-4",
                hasFiles ? "border-success/40" : "border-border",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg",
                      hasFiles ? "bg-success-soft text-success" : "bg-surface-2 text-muted",
                    )}
                  >
                    {hasFiles ? <CheckCircle2 className="size-5" /> : <Package className="size-5" />}
                  </span>
                  <div>
                    <div className="text-sm font-semibold">
                      {meta.label}
                      {d.quantity > 1 && <span className="text-muted"> ×{d.quantity}</span>}
                    </div>
                    <Badge color={statusMeta.color} soft={statusMeta.soft}>
                      {statusMeta.label}
                    </Badge>
                  </div>
                </div>
                <button
                  onClick={() => fileInputs.current[d.id]?.click()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                  Add files
                </button>
                <input
                  ref={(el) => {
                    fileInputs.current[d.id] = el;
                  }}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFiles(d.id, e.target.files)}
                />
              </div>

              {/* Uploaded files */}
              {d.uploads.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {d.uploads.map((u) => (
                    <li
                      key={u.id}
                      className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs"
                    >
                      <Paperclip className="size-3.5 text-muted" />
                      <span className="flex-1 truncate">{u.originalName}</span>
                      <span className="text-muted-2">{formatBytes(u.size)}</span>
                      <button
                        onClick={() => handleRemove(u.id, d.id)}
                        className="text-muted-2 hover:text-danger"
                        aria-label="Remove file"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Notes prompt */}
              {(needsNotes || hasFiles) && (
                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-muted">
                    Notes for editor{needsNotes && <span className="text-warning"> · recommended</span>}
                  </label>
                  <textarea
                    value={itemNotes[d.id] ?? ""}
                    onChange={(e) =>
                      setItemNotes((prev) => ({ ...prev, [d.id]: e.target.value }))
                    }
                    rows={2}
                    placeholder={
                      needsNotes
                        ? "e.g. Best clips at 0:10–0:40, skip the kitchen pan, music: upbeat."
                        : "Anything the editor should know about these files…"
                    }
                    className="w-full resize-none rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Extra files */}
      <div className="rounded-2xl border bg-surface p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Other files</div>
            <div className="text-xs text-muted">
              Anything not tied to a specific item (RAWs, brackets, references)
            </div>
          </div>
          <button
            onClick={() => fileInputs.current["__extra__"]?.click()}
            disabled={busyTarget === "__extra__"}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          >
            {busyTarget === "__extra__" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add files
          </button>
          <input
            ref={(el) => {
              fileInputs.current["__extra__"] = el;
            }}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(null, e.target.files)}
          />
        </div>
        {extra.length > 0 && (
          <ul className="mt-3 space-y-1">
            {extra.map((u) => (
              <li
                key={u.id}
                className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs"
              >
                <Paperclip className="size-3.5 text-muted" />
                <span className="flex-1 truncate">{u.originalName}</span>
                <span className="text-muted-2">{formatBytes(u.size)}</span>
                <button
                  onClick={() => handleRemove(u.id, null)}
                  className="text-muted-2 hover:text-danger"
                  aria-label="Remove file"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
            placeholder="e.g. Lockbox code didn't work, couldn't shoot the garage."
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
        <label className="mb-1 block text-sm font-semibold">
          Overall brief for the editor
        </label>
        <p className="mb-2 text-xs text-muted">
          The big picture — anything that applies to the whole edit. This goes on the PDF.
        </p>
        <textarea
          value={editorBrief}
          onChange={(e) => setEditorBrief(e.target.value)}
          rows={3}
          placeholder="e.g. House faces west so exteriors are backlit — recover sky. Seller wants the pool emphasized. Skip the cluttered office."
          className="w-full resize-none rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </div>

      {/* Finalize */}
      <div className="sticky bottom-4 flex items-center justify-between rounded-2xl border bg-surface p-4 shadow-lg">
        <div className="text-sm text-muted">
          {deliverables.filter((d) => d.uploads.length > 0).length}/{deliverables.length} items have files
          {project.photographerName && ` · ${project.photographerName}`}
        </div>
        <button
          onClick={finalize}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {done ? "Re-submit & regenerate PDF" : "Submit to editors"}
        </button>
      </div>
    </div>
  );
}
