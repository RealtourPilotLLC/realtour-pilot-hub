"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Mail, Camera, Wrench, Split } from "lucide-react";

import { draftFeedbackReply, sendFeedbackReply, setFeedbackAttribution } from "./actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WHOSE PROBLEM IT IS + THE REPLY TO THE AGENT (Jordan, Sep 7 2026).
//
// Two controls that belong together on one row: the call about whether a piece
// of feedback is the photographer's or ours, and the email that answers it.
// They share a row because they share a fact — an operations complaint gets an
// operations answer ("that one is on us in post-production"), and the draft is
// written from whichever way this chip is set.
// ---------------------------------------------------------------------------

type Attribution = "ONSITE" | "OPERATIONS" | "MIXED";

const CHIP: Record<Attribution, { label: string; hint: string; cls: string; Icon: typeof Camera }> = {
  ONSITE: {
    label: "On-site",
    hint: "About the shoot itself — counts toward the photographer's score.",
    cls: "bg-brand/12 text-brand border-brand/30",
    Icon: Camera,
  },
  OPERATIONS: {
    label: "Operations",
    hint: "Editing, turnaround, delivery — after the shoot. Does NOT count toward the photographer's score.",
    cls: "bg-warning/12 text-warning border-warning/30",
    Icon: Wrench,
  },
  MIXED: {
    label: "Both",
    hint: "Some of each — only the photographer's own rating counts toward their score.",
    cls: "bg-surface-2 text-foreground/80 border-border",
    Icon: Split,
  },
};

export function FeedbackReply({
  id,
  attribution,
  attributionWhy,
  attributionBy,
  repliedAtISO,
  replyBy,
  hasEmail,
}: {
  id: string;
  attribution: Attribution | null;
  attributionWhy: string | null;
  attributionBy: string | null;
  repliedAtISO: string | null;
  replyBy: string | null;
  hasEmail: boolean;
}) {
  const [attr, setAttr] = useState<Attribution | null>(attribution);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sentAt, setSentAt] = useState<string | null>(repliedAtISO);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function pick(next: Attribution) {
    if (next === attr) return;
    const prev = attr;
    setAttr(next); // optimistic — the chip is the whole point of the control
    start(async () => {
      const r = await setFeedbackAttribution(id, next);
      if (!r.ok) { setAttr(prev); setMsg(r.message ?? "Couldn't change that."); }
    });
  }

  function openDraft() {
    setMsg(null);
    start(async () => {
      const r = await draftFeedbackReply(id);
      if (!r.ok) { setMsg(r.message ?? "Couldn't draft a reply."); return; }
      setTo(r.to ?? ""); setSubject(r.subject ?? ""); setBody(r.body ?? ""); setOpen(true);
    });
  }

  function send() {
    setMsg(null);
    start(async () => {
      const r = await sendFeedbackReply(id, body, to, subject);
      setMsg(r.message);
      if (r.ok) { setSentAt(new Date().toISOString()); setOpen(false); }
    });
  }

  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[11px] font-medium text-muted-2">Whose is it?</span>
        {(Object.keys(CHIP) as Attribution[]).map((k) => {
          const { label, hint, cls, Icon } = CHIP[k];
          const on = attr === k;
          return (
            <button
              key={k}
              onClick={() => pick(k)}
              disabled={pending}
              title={hint}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                on ? cls : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Icon className="size-3" /> {label}
            </button>
          );
        })}
        {attr === "OPERATIONS" && (
          <span className="text-[11px] text-muted">— not counted against the photographer</span>
        )}

        <span className="ml-auto">
          {sentAt ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
              <Check className="size-3.5" /> Replied{replyBy ? ` by ${replyBy.split(" ")[0]}` : ""}
            </span>
          ) : (
            <button
              onClick={openDraft}
              disabled={pending || !hasEmail}
              title={hasEmail ? "Write back to the agent" : "No email on this client's record"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}
              Reply to {`the agent`}
            </button>
          )}
        </span>
      </div>

      {/* Why it was classified that way — the reasoning, so an owner can
          disagree with something specific rather than a label. */}
      {attributionWhy && (
        <p className="mt-1 text-[11px] text-muted-2">
          {attributionBy ? `${attributionBy.split(" ")[0]} set this` : "Read automatically"} — {attributionWhy}
        </p>
      )}

      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-border bg-surface-2/40 p-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span>To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="min-w-56 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-[12px] text-foreground outline-none focus:border-brand"
            />
          </div>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px] font-medium outline-none focus:border-brand"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:border-brand"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={send}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[13px] font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />} Send it
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
            >
              Cancel
            </button>
            <span className="text-[11px] text-muted-2">Edit anything before it goes — nothing sends until you press Send.</span>
          </div>
        </div>
      )}

      {msg && <p className="mt-1.5 text-[11px] text-muted">{msg}</p>}
    </div>
  );
}
