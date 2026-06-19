"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, Clock, MapPin, Loader2, Sparkles, Copy } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { setSmartTaskStatus, draftTaskReply } from "@/app/actions";

const DRAFTABLE = ["client_reply", "revision", "feedback_review", "delivery_text"];

export type QueueTask = {
  id: string;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  dueAt: string | null;
  reasonCreated: string | null;
  checklist: string[];
  source: string;
  projectId: string | null;
  clientName: string | null;
  propertyAddress: string | null;
};

const PRIORITY: Record<string, { color: string; soft: string }> = {
  URGENT: { color: "#dc2626", soft: "#fee2e2" },
  HIGH: { color: "#d97706", soft: "#fef3c7" },
  MEDIUM: { color: "#0ea5e9", soft: "#e0f2fe" },
  LOW: { color: "#64748b", soft: "var(--surface-2)" },
};

const STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_CLIENT",
  "WAITING_PHOTOGRAPHER",
  "WAITING_EDITOR",
  "WAITING_VENDOR",
  "WAITING_JORDAN",
  "BLOCKED",
  "CANCELLED",
];

function dueLabel(due: string | null) {
  if (!due) return null;
  const d = new Date(due);
  const now = new Date();
  const days = Math.round((d.getTime() - new Date(now.toDateString()).getTime()) / 86400000);
  const text = d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const overdue = d.getTime() < now.getTime();
  return { text, overdue, soon: days <= 1 };
}

export function TaskCard({ task }: { task: QueueTask }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ text?: string; error?: string } | null>(null);
  const [drafting, startDraft] = useTransition();
  const [copied, setCopied] = useState(false);
  const p = PRIORITY[task.priority] ?? PRIORITY.MEDIUM;
  const due = dueLabel(task.dueAt);
  const done = task.status === "COMPLETED";
  const canDraft = DRAFTABLE.includes(task.taskType);

  const run = (status: string) => start(async () => setSmartTaskStatus(task.id, status));
  const makeDraft = () =>
    startDraft(async () => {
      setCopied(false);
      setDraft(await draftTaskReply(task.id));
    });

  return (
    <div className={`rounded-2xl border bg-surface p-4 ${done ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge color={p.color} soft={p.soft}>
              {task.priority.toLowerCase()}
            </Badge>
            <span className="text-[11px] uppercase tracking-wide text-muted-2">{task.taskType.replace(/_/g, " ")}</span>
          </div>
          <div className="mt-1 text-sm font-semibold leading-snug">{task.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {task.clientName && <span>{task.clientName}</span>}
            {task.propertyAddress && (
              <span className="inline-flex items-center gap-0.5">
                <MapPin className="size-3" /> {task.propertyAddress}
              </span>
            )}
          </div>
        </div>
        {due && (
          <span className={`shrink-0 text-xs ${due.overdue ? "font-semibold text-danger" : due.soon ? "font-medium text-warning" : "text-muted"}`}>
            <Clock className="mr-0.5 inline size-3" />
            {due.overdue ? "Overdue" : due.text}
          </span>
        )}
      </div>

      {task.checklist.length > 0 && (
        <details className="mt-2" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-brand">
            <ChevronDown className="size-3.5" /> Checklist ({task.checklist.length})
          </summary>
          <ul className="mt-1.5 space-y-1">
            {task.checklist.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-foreground/80">
                <span className="mt-1 size-1 shrink-0 rounded-full bg-muted-2" /> {c}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
        <div className="flex items-center gap-2">
          {!done ? (
            <button
              onClick={() => run("COMPLETED")}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 px-2.5 py-1.5 text-xs font-medium text-success hover:bg-success/20 disabled:opacity-60"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
              Complete
            </button>
          ) : (
            <button onClick={() => run("OPEN")} disabled={pending} className="text-xs text-muted hover:underline">
              Reopen
            </button>
          )}
          {!done && (
            <select
              value={task.status}
              disabled={pending}
              onChange={(e) => run(e.target.value)}
              className="rounded-lg border bg-surface px-2 py-1.5 text-xs focus:outline-none"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ").toLowerCase()}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!done && canDraft && (
            <button
              onClick={makeDraft}
              disabled={drafting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-60"
            >
              {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              Draft reply
            </button>
          )}
          {task.projectId && (
            <Link href={`/projects/${task.projectId}`} className="text-xs text-muted hover:text-foreground">
              Open project →
            </Link>
          )}
        </div>
      </div>

      {draft && (
        <div className="mt-3 rounded-xl border bg-surface-2/60 p-3">
          {draft.error ? (
            <p className="text-xs text-danger">{draft.error}</p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Suggested reply</span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(draft.text ?? "");
                    setCopied(true);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
                >
                  <Copy className="size-3" /> {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="whitespace-pre-line text-sm text-foreground/90">{draft.text}</p>
              <p className="mt-2 text-[10px] text-muted-2">Review before sending. The hub never sends on its own.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
