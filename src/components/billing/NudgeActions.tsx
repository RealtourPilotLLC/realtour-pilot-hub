"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2, Copy, Send, CheckCircle2, BellRing } from "lucide-react";
import { draftPaymentNudge, sendPaymentNudge, markBillingNudged } from "@/app/billing/actions";
import { etDaysAgo } from "@/lib/datetime";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// Per-row AR follow-up actions for /billing: AI-draft a friendly payment
// reminder (review → copy or send via OpenPhone — a human always taps send),
// plus a "Followed up" marker so the list shows when each balance was last
// chased. Same draft-panel pattern as the queue's TaskCard.
export function NudgeActions({ projectId, lastNudgedAt }: { projectId: string; lastNudgedAt: string | null }) {
  const [draft, setDraft] = useState<{ text?: string; error?: string } | null>(null);
  const [text, setText] = useState("");
  const [drafting, startDraft] = useTransition();
  const [sending, startSend] = useTransition();
  const [marking, startMark] = useTransition();
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const nudgedDays = lastNudgedAt ? etDaysAgo(new Date(lastNudgedAt)) : null;

  const makeDraft = () =>
    startDraft(async () => {
      setCopied(false);
      setMsg(null);
      const r = await draftPaymentNudge(projectId);
      setDraft(r);
      if (r.ok && r.text) setText(r.text);
    });

  const send = () =>
    startSend(async () => {
      const r = await sendPaymentNudge(projectId, text);
      setMsg(r.message);
      if (r.ok) setDraft(null);
    });

  const markNudged = () =>
    startMark(async () => {
      const r = await markBillingNudged(projectId);
      setMsg(r.ok ? null : r.message);
    });

  return (
    <>
      <button
        onClick={makeDraft}
        disabled={drafting}
        title="AI-draft a friendly payment reminder text"
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1.5 font-medium text-brand hover:bg-brand/20 disabled:opacity-60"
      >
        {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        Draft nudge
      </button>
      <button
        onClick={markNudged}
        disabled={marking}
        title="Mark this balance as followed up (chased outside the hub)"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2 disabled:opacity-60"
      >
        {marking ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
        Followed up
      </button>
      {nudgedDays != null && (
        <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted" title="When this balance was last chased">
          <BellRing className="size-3" />
          {nudgedDays <= 0 ? "Nudged today" : `Nudged ${nudgedDays} day${nudgedDays === 1 ? "" : "s"} ago`}
        </span>
      )}
      {msg && <span className="text-[11px] text-muted">{msg}</span>}

      {draft && (
        <div className="mt-1 w-full rounded-xl border bg-surface-2/60 p-3">
          {draft.error ? (
            <p className="text-xs text-danger">{draft.error}</p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Payment reminder draft</span>
                <button
                  onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setCopied(true); }}
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
                >
                  <Copy className="size-3" /> {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <AutoTextarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                minRows={4}
                className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={send}
                  disabled={sending || !text.trim()}
                  title="Send via OpenPhone"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  Send via OpenPhone
                </button>
                <button onClick={() => setDraft(null)} className="text-xs text-muted hover:text-foreground">Cancel</button>
              </div>
              <p className="mt-2 text-[10px] text-muted-2">Review before sending. The hub never sends on its own.</p>
            </>
          )}
        </div>
      )}
    </>
  );
}
