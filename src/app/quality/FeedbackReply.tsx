"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, Mail, Camera, Wrench, Split, Frown, Meh, Smile, Ban, Undo2, MessageSquareText } from "lucide-react";

import {
  draftFeedbackReply,
  sendFeedbackReply,
  setFeedbackAttribution,
  setFeedbackSentiment,
  dismissFeedback,
  undismissFeedback,
  type SentimentValue,
} from "./actions";
import { etDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WHOSE PROBLEM IT IS + THE REPLY TO THE AGENT (Jordan, Sep 7 2026).
//
// Two controls that belong together on one row: the call about whether a piece
// of feedback is the photographer's or ours, and the email that answers it.
// They share a row because they share a fact — an operations complaint gets an
// operations answer ("that one is on us in post-production"), and the draft is
// written from whichever way this chip is set.
//
// Sep 16 (Kyle call, item 10) — a third control underneath: correcting what the
// hub READ. "Reads as" re-reads the sentiment (Unhappy / Neutral / Happy) with
// who/when/why and keeps the hub's own read beside it; "Not feedback" dismisses
// a row that never was feedback (Jamie's "still waiting on 2844 Edgemont Dr"
// was a seller confirmation) with a reason and an undo. Nothing is deleted:
// the row stays, the words stay, and the provenance line says what changed.
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

// Order matches the badge at the top of the row: the unhappy one first, since
// that is the read an owner most often has to correct.
const SENTIMENT_CHIP: Record<SentimentValue, { label: string; hint: string; cls: string; Icon: typeof Frown }> = {
  NEGATIVE: {
    label: "Unhappy",
    hint: "A complaint — counts in Unhappy and lights the open tile until handled.",
    cls: "bg-danger/10 text-danger border-danger/30",
    Icon: Frown,
  },
  NEUTRAL: {
    label: "Neutral",
    hint: "Neither praise nor complaint — listed, not counted as unhappy.",
    cls: "bg-surface-2 text-foreground/80 border-border",
    Icon: Meh,
  },
  POSITIVE: {
    label: "Happy",
    hint: "Praise — reaches the photographer's creative-safe surfaces.",
    cls: "bg-success/10 text-success border-success/30",
    Icon: Smile,
  },
};

const sentimentLabel = (s: string | null | undefined) =>
  s === "NEGATIVE" ? "Unhappy" : s === "POSITIVE" ? "Happy" : s === "NEUTRAL" ? "Neutral" : null;

// Why a row is not feedback — the reason picker. Free text can be added.
const DISMISS_REASONS = ["Scheduling talk", "Spam", "Misfiled", "Other"] as const;

const first = (name: string | null | undefined) => (name ?? "").split(" ")[0] || "someone";

export function FeedbackReply({
  id,
  source,
  attribution,
  attributionWhy,
  attributionBy,
  sentiment,
  sentimentAuto,
  sentimentBy,
  sentimentAtISO,
  sentimentNote,
  dismissedAtISO,
  dismissedBy,
  dismissReason,
  conversationHref,
  conversationLabel,
  repliedAtISO,
  replyBy,
  hasEmail,
}: {
  id: string;
  source: string; // form | text | email
  attribution: Attribution | null;
  attributionWhy: string | null;
  attributionBy: string | null;
  sentiment: string | null;
  sentimentAuto: string | null;
  sentimentBy: string | null;
  sentimentAtISO: string | null;
  sentimentNote: string | null;
  dismissedAtISO: string | null;
  dismissedBy: string | null;
  dismissReason: string | null;
  conversationHref: string | null;
  conversationLabel: string | null;
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

  // --- Sep 16: the correction state. Optimistic like the chips above; the
  // server action is the truth and a rejection rolls it back with a reason.
  const [sent, setSent] = useState<{ value: string | null; by: string | null; atISO: string | null; note: string | null }>({
    value: sentiment, by: sentimentBy, atISO: sentimentAtISO, note: sentimentNote,
  });
  const [auto] = useState<string | null>(sentimentAuto ?? (sentimentBy ? null : sentiment));
  const [askWhy, setAskWhy] = useState<SentimentValue | null>(null);
  const [why, setWhy] = useState("");
  const [dismissed, setDismissed] = useState<{ atISO: string | null; by: string | null; reason: string | null }>({
    atISO: dismissedAtISO, by: dismissedBy, reason: dismissReason,
  });
  const [askDismiss, setAskDismiss] = useState(false);
  const [dismissPick, setDismissPick] = useState<(typeof DISMISS_REASONS)[number] | null>(null);
  const [dismissDetail, setDismissDetail] = useState("");

  function pick(next: Attribution) {
    if (next === attr) return;
    const prev = attr;
    setAttr(next); // optimistic — the chip is the whole point of the control
    start(async () => {
      const r = await setFeedbackAttribution(id, next);
      if (!r.ok) { setAttr(prev); setMsg(r.message ?? "Couldn't change that."); }
    });
  }

  // Picking a sentiment chip opens the one-line "why" — the note is the part a
  // later reader needs ("scheduling update, not feedback"), so it is asked for
  // before the write rather than bolted on after. Enter saves; it is optional.
  function chooseSentiment(next: SentimentValue) {
    setMsg(null);
    setAskWhy(next);
    setWhy("");
  }

  function saveSentiment() {
    const next = askWhy;
    if (!next) return;
    const prev = sent;
    const note = why.trim() || null;
    setSent({ value: next, by: "you", atISO: new Date().toISOString(), note });
    setAskWhy(null);
    start(async () => {
      try {
        const r = await setFeedbackSentiment(id, next, note);
        if (!r.ok) { setSent(prev); setMsg(r.message ?? "Couldn't change that."); }
      } catch {
        setSent(prev); setMsg("That didn't save — check your connection.");
      }
    });
  }

  function saveDismiss() {
    if (!dismissPick) return;
    const reason = dismissDetail.trim() ? `${dismissPick} — ${dismissDetail.trim()}` : dismissPick;
    const prev = dismissed;
    setDismissed({ atISO: new Date().toISOString(), by: "you", reason });
    setAskDismiss(false);
    start(async () => {
      try {
        const r = await dismissFeedback(id, reason);
        if (!r.ok) { setDismissed(prev); setMsg(r.message ?? "Couldn't dismiss that."); }
      } catch {
        setDismissed(prev); setMsg("That didn't save — check your connection.");
      }
    });
  }

  function undoDismiss() {
    const prev = dismissed;
    setDismissed({ atISO: null, by: null, reason: null });
    start(async () => {
      try {
        const r = await undismissFeedback(id);
        if (!r.ok) { setDismissed(prev); setMsg(r.message ?? "Couldn't undo that."); }
      } catch {
        setDismissed(prev); setMsg("That didn't save — check your connection.");
      }
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

  const isDismissed = !!dismissed.atISO;
  const overridden = !!sent.by;
  const autoLabel = sentimentLabel(auto);
  const nowLabel = sentimentLabel(sent.value);
  // "read as Unhappy by the hub · set to Neutral by Jordan, Sep 16 (why)".
  // Form rows that nobody has touched say nothing — their read came from the
  // stars, and a line under every 5-star response would be noise.
  const provenance = overridden
    ? `${autoLabel ? `Read as ${autoLabel} by the hub` : "No automatic read"} · set to ${nowLabel ?? "—"} by ${first(sent.by)}${
        sent.atISO ? `, ${etDate(sent.atISO)}` : ""
      }${sent.note ? ` (${sent.note})` : ""}`
    : source !== "form" && nowLabel
      ? `Read as ${nowLabel} by the hub from this ${source === "email" ? "email" : "text"}`
      : null;

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

      {/* Sep 16: correcting what the hub READ. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[11px] font-medium text-muted-2">Reads as</span>
        {(Object.keys(SENTIMENT_CHIP) as SentimentValue[]).map((k) => {
          const { label, hint, cls, Icon } = SENTIMENT_CHIP[k];
          const on = sent.value === k && !isDismissed;
          return (
            <button
              key={k}
              onClick={() => chooseSentiment(k)}
              disabled={pending || isDismissed}
              title={isDismissed ? "Undo the dismissal first" : hint}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50",
                on ? cls : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Icon className="size-3" /> {label}
            </button>
          );
        })}
        {isDismissed ? (
          <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <Ban className="size-3 text-muted-2" />
            <span className="font-medium text-foreground/80">Not feedback</span>
            {dismissed.reason ? ` — ${dismissed.reason}` : ""}
            {dismissed.by ? ` · dismissed by ${first(dismissed.by)}` : ""}
            {dismissed.atISO ? `, ${etDate(dismissed.atISO)}` : ""}
            <button
              onClick={undoDismiss}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted hover:text-foreground disabled:opacity-50"
            >
              <Undo2 className="size-3" /> Undo
            </button>
          </span>
        ) : (
          <button
            onClick={() => { setMsg(null); setAskDismiss((v) => !v); setDismissPick(null); setDismissDetail(""); }}
            disabled={pending}
            title="This row is not client feedback at all — a scheduling text, spam, something misfiled. Hidden from every count, kept here with an undo."
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
          >
            <Ban className="size-3" /> Not feedback
          </button>
        )}
        {conversationHref && (
          <Link
            href={conversationHref}
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
            title="Read the whole thread on the client's page"
          >
            <MessageSquareText className="size-3.5" /> {conversationLabel ?? "Open the conversation"}
          </Link>
        )}
      </div>

      {provenance && <p className="mt-1 text-[11px] text-muted-2">{provenance}</p>}

      {askWhy && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2/40 p-2.5">
          <span className="text-[11px] font-medium">Set to {sentimentLabel(askWhy)} — why?</span>
          <input
            autoFocus
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveSentiment(); if (e.key === "Escape") setAskWhy(null); }}
            placeholder="optional, one line — e.g. scheduling update, not a complaint"
            maxLength={300}
            className="min-w-56 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-[12px] text-foreground outline-none focus:border-brand"
          />
          <button
            onClick={saveSentiment}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            <Check className="size-3" /> Save
          </button>
          <button
            onClick={() => setAskWhy(null)}
            className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}

      {askDismiss && !isDismissed && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2/40 p-2.5">
          <span className="text-[11px] font-medium">Not feedback because</span>
          {DISMISS_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setDismissPick(r)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors",
                dismissPick === r ? "border-brand/30 bg-brand/12 text-brand" : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              {r}
            </button>
          ))}
          <input
            value={dismissDetail}
            onChange={(e) => setDismissDetail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveDismiss(); if (e.key === "Escape") setAskDismiss(false); }}
            placeholder="detail (optional)"
            maxLength={200}
            className="min-w-40 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-[12px] text-foreground outline-none focus:border-brand"
          />
          <button
            onClick={saveDismiss}
            disabled={pending || !dismissPick}
            className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            <Ban className="size-3" /> Dismiss
          </button>
          <button
            onClick={() => setAskDismiss(false)}
            className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            Cancel
          </button>
        </div>
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
