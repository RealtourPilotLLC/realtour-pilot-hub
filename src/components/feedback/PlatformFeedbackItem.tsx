"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Bug, Sparkles, MessageSquare, Check, X, RotateCcw, Undo2, Loader2, CheckCircle2, Flag, Send, ExternalLink } from "lucide-react";
import { decidePlatformFeedback, pingFeedbackOnSlack, type FeedbackDecision } from "@/app/feedback/actions";
import { etDateTime } from "@/lib/datetime";

export type FeedbackRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  submittedBy: string | null;
  status: string;
  createdAt: string;
  /** An image URL the browser can open — /api/feedback/<id>/screenshot on the
   *  board. Never the stored data: URL (browsers refuse to open those in a new
   *  tab, which is why clicking a screenshot did nothing). */
  screenshot: string | null;
  page: string | null;
};

const KIND_META: Record<string, { icon: typeof Bug; label: string; cls: string }> = {
  bug: { icon: Bug, label: "Bug", cls: "text-danger bg-danger/10" },
  feature: { icon: Sparkles, label: "Feature", cls: "text-brand bg-brand-soft" },
  feedback: { icon: MessageSquare, label: "Feedback", cls: "text-muted bg-surface-2" },
  // Flags raised from the field — shoot screen, upload portal, debrief.
  field_issue: { icon: Flag, label: "Field issue", cls: "text-warning bg-warning/10" },
};

export function PlatformFeedbackItem({ row, canModerate = true, pingTargets = [], onDecide, saving = false, error = null }: {
  row: FeedbackRow; canModerate?: boolean; pingTargets?: { id: string; name: string }[];
  /** The board owns the decision (it moves the card between sections at once
   *  and puts it back if the server says no). Without it the card decides on
   *  its own, the same optimistic way. */
  onDecide?: (status: FeedbackDecision) => void;
  saving?: boolean;
  error?: string | null;
}) {
  const [localStatus, setLocalStatus] = useState(row.status);
  const [localSaving, setLocalSaving] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const status = onDecide ? row.status : localStatus;
  const busy = onDecide ? saving : localSaving;
  const err = onDecide ? error : localErr;
  const meta = KIND_META[row.kind] ?? KIND_META.feature;
  const Icon = meta.icon;
  const [pingTo, setPingTo] = useState("");
  const [pingNote, setPingNote] = useState("");
  const [pingMsg, setPingMsg] = useState<string | null>(null);
  const [pinging, startPing] = useTransition();

  // Every decision is owner-only in the action, and it now ANSWERS (ok or a
  // reason) instead of throwing. The card flips at once; a refusal puts it
  // back with the reason. The spinner ends with the server's answer — it is
  // not tied to any page refresh.
  const decide = (s: FeedbackDecision) => {
    if (onDecide) { onDecide(s); return; }
    if (localSaving) return;
    const prev = localStatus;
    setLocalStatus(s);
    setLocalErr(null);
    setLocalSaving(true);
    decidePlatformFeedback(row.id, s)
      .then(
        (r) => { if (!r.ok) { setLocalStatus(prev); setLocalErr(r.message); } },
        () => { setLocalStatus(prev); setLocalErr("Couldn't confirm that saved. Reload the board to check."); },
      )
      .finally(() => setLocalSaving(false));
  };

  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setViewing(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>
          <Icon className="size-3" /> {meta.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">{row.title}</div>
          {row.body && <p className="mt-0.5 whitespace-pre-line text-xs text-muted [overflow-wrap:anywhere]">{row.body}</p>}
          {row.screenshot && (
            <button
              type="button"
              onClick={() => setViewing(true)}
              className="mt-1.5 block w-fit cursor-zoom-in overflow-hidden rounded-lg border border-border hover:opacity-90"
              title="Open the screenshot full size"
              aria-label={`Open the screenshot for “${row.title}” full size`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={row.screenshot} alt="Screenshot" loading="lazy" className="max-h-40 max-w-full object-contain" />
            </button>
          )}
          <div className="mt-1 text-[11px] text-muted-2 [overflow-wrap:anywhere]">
            Received {etDateTime(row.createdAt)}{row.submittedBy ? ` · from ${row.submittedBy}` : ""}
            {row.page &&
              // In-app paths only — "//host" would be a protocol-relative
              // external URL, so it stays plain text like full https:// values.
              (row.page.startsWith("/") && !row.page.startsWith("//") ? (
                <>
                  {" · "}
                  <Link href={row.page} className="text-brand hover:underline">
                    {row.kind === "field_issue" ? "Open where it was flagged →" : "Open page →"}
                  </Link>
                </>
              ) : (
                ` · ${row.page}`
              ))}
          </div>
        </div>
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-muted" aria-label="Saving" />}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
        {status === "NEW" && (canModerate ? (
          <>
            <button onClick={() => decide("APPROVED")} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 disabled:opacity-50">
              <Check className="size-3.5" /> Approve
            </button>
            <button onClick={() => decide("DECLINED")} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50">
              <X className="size-3.5" /> Decline
            </button>
          </>
        ) : (
          <span className="text-xs text-muted-2">Waiting on Jordan&rsquo;s review</span>
        ))}
        {status === "APPROVED" && (
          <>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <Check className="size-3.5" /> Approved — queued for build
            </span>
            {canModerate && (
              <div className="ml-auto flex items-center gap-2">
                {/* Approving was a one-way door: the only way out was to declare
                    it shipped, which is a lie about work nobody did. */}
                <button
                  onClick={() => decide("NEW")}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
                >
                  <Undo2 className="size-3.5" /> Un-approve
                </button>
                <button
                  onClick={() => decide("DECLINED")}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-danger disabled:opacity-50"
                >
                  <X className="size-3.5" /> Decline
                </button>
                <button
                  onClick={() => decide("DONE")}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-50"
                >
                  <CheckCircle2 className="size-3.5" /> Mark shipped
                </button>
              </div>
            )}
          </>
        )}
        {status === "DONE" && (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <CheckCircle2 className="size-3.5 text-success" /> Shipped
            </span>
            {canModerate && (
              <button
                onClick={() => decide("APPROVED")}
                disabled={busy}
                className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
              >
                <RotateCcw className="size-3.5" /> Back to building
              </button>
            )}
          </>
        )}
        {status === "DECLINED" && (
          <>
            <span className="text-xs text-muted-2">Declined</span>
            {canModerate && (
              <button onClick={() => decide("NEW")} disabled={busy} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50">
                <RotateCcw className="size-3.5" /> Reopen
              </button>
            )}
          </>
        )}
      </div>
      {/* "Look into this" — DM a teammate on Slack about this item, sent AS
          the logged-in person (Jordan pings as Jordan). */}
      {canModerate && pingTargets.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
          <select value={pingTo} onChange={(e) => setPingTo(e.target.value)}
            className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
            <option value="">Ask someone to look into this…</option>
            {pingTargets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {pingTo && (
            <>
              <input value={pingNote} onChange={(e) => setPingNote(e.target.value)} placeholder="optional note…"
                className="min-w-32 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand" />
              <button disabled={pinging} onClick={() => startPing(async () => {
                try {
                  const r = await pingFeedbackOnSlack(row.id, pingTo, pingNote);
                  setPingMsg(r.message);
                  if (r.ok) { setPingTo(""); setPingNote(""); }
                } catch {
                  setPingMsg("Couldn't reach the hub. Try again.");
                }
              })} className="inline-flex items-center gap-1 rounded-lg bg-brand-action px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                {pinging ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Ping on Slack
              </button>
            </>
          )}
          {pingMsg && <span className="text-[11px] text-muted">{pingMsg}</span>}
        </div>
      )}
      {err && <p role="alert" className="mt-1.5 text-xs text-danger">{err}</p>}

      {viewing && row.screenshot && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Screenshot for “${row.title}”`}
          onClick={() => setViewing(false)}
          className="fixed inset-0 z-[1500] flex flex-col items-center justify-center gap-3 bg-black/85 p-4"
        >
          <div className="flex w-full max-w-5xl items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
            <a href={row.screenshot} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/20">
              <ExternalLink className="size-3.5" /> Open in a new tab
            </a>
            <button type="button" onClick={() => setViewing(false)} className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/20" aria-label="Close">
              <X className="size-3.5" /> Close
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={row.screenshot} alt={`Screenshot for “${row.title}”`} onClick={(e) => e.stopPropagation()} className="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl" />
        </div>
      )}
    </div>
  );
}
