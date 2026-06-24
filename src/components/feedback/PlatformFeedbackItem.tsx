"use client";

import { useTransition } from "react";
import { Bug, Sparkles, MessageSquare, Check, X, RotateCcw, Loader2, CheckCircle2 } from "lucide-react";
import { decidePlatformFeedback } from "@/app/feedback/actions";
import { etDateTime } from "@/lib/datetime";

export type FeedbackRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  submittedBy: string | null;
  status: string;
  createdAt: string;
  screenshot: string | null;
  page: string | null;
};

const KIND_META: Record<string, { icon: typeof Bug; label: string; cls: string }> = {
  bug: { icon: Bug, label: "Bug", cls: "text-danger bg-danger/10" },
  feature: { icon: Sparkles, label: "Feature", cls: "text-brand bg-brand-soft" },
  feedback: { icon: MessageSquare, label: "Feedback", cls: "text-muted bg-surface-2" },
};

export function PlatformFeedbackItem({ row }: { row: FeedbackRow }) {
  const [pending, start] = useTransition();
  const meta = KIND_META[row.kind] ?? KIND_META.feature;
  const Icon = meta.icon;
  const decide = (s: "APPROVED" | "DECLINED" | "DONE" | "NEW") => start(async () => decidePlatformFeedback(row.id, s));

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>
          <Icon className="size-3" /> {meta.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">{row.title}</div>
          {row.body && <p className="mt-0.5 whitespace-pre-line text-xs text-muted">{row.body}</p>}
          {row.screenshot && (
            <a href={row.screenshot} target="_blank" rel="noopener noreferrer" className="mt-1.5 block w-fit overflow-hidden rounded-lg border border-border hover:opacity-90" title="Open full screenshot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={row.screenshot} alt="screenshot" className="max-h-40 max-w-full object-contain" />
            </a>
          )}
          <div className="mt-1 text-[11px] text-muted-2">
            {row.submittedBy ? `${row.submittedBy} · ` : ""}{etDateTime(row.createdAt)}
            {row.page ? ` · ${row.page}` : ""}
          </div>
        </div>
        {pending && <Loader2 className="size-4 shrink-0 animate-spin text-muted" />}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
        {row.status === "NEW" && (
          <>
            <button onClick={() => decide("APPROVED")} disabled={pending} className="inline-flex items-center gap-1 rounded-lg bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 disabled:opacity-50">
              <Check className="size-3.5" /> Approve
            </button>
            <button onClick={() => decide("DECLINED")} disabled={pending} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50">
              <X className="size-3.5" /> Decline
            </button>
          </>
        )}
        {row.status === "APPROVED" && (
          <>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><Check className="size-3.5" /> Approved — queued for build</span>
            <button onClick={() => decide("DONE")} disabled={pending} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-50">
              <CheckCircle2 className="size-3.5" /> Mark shipped
            </button>
          </>
        )}
        {row.status === "DONE" && <span className="inline-flex items-center gap-1 text-xs text-muted"><CheckCircle2 className="size-3.5 text-success" /> Shipped</span>}
        {row.status === "DECLINED" && (
          <>
            <span className="text-xs text-muted-2">Declined</span>
            <button onClick={() => decide("NEW")} disabled={pending} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50">
              <RotateCcw className="size-3.5" /> Reopen
            </button>
          </>
        )}
      </div>
    </div>
  );
}
