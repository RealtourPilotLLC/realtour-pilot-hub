"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Copy, Loader2, Reply, Send, Sparkles, X } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { prepareEmailReply, sendEmailThreadReply, type EmailReplyTarget } from "@/app/emailActions";

// ---------------------------------------------------------------------------
// THE EMAIL REPLY BOX (Jordan, Oct 27 2026: "I want to be able to respond to
// emails in the hub"). On a Messages · Email thread and the client page's
// Email card. Opening it reads who the reply goes to (from the Gmail thread
// itself) and whether that mailbox may send; the AI draft, when there is one,
// is only the starting text. NOTHING SENDS until a person presses Send, and
// Send is the one place sendEmailThreadReply is called: no effect, timer or
// draft ever calls it. Afterwards it says "Sent" and the thread refreshes.
// ---------------------------------------------------------------------------

/** A fresh identity for one reply (app/emailActions: one press, one email).
 *  Only ever minted from a Send press, never while rendering. */
const mintIntentId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `i${Date.now()}${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, "");

type Draft = () => Promise<{ ok: boolean; message: string; draft?: string }>;

export function EmailReplyBox({
  target,
  draft,
  startOpen = false,
  onSent,
}: {
  target: EmailReplyTarget;
  /** the AI draft for this thread; its text becomes the box's starting text */
  draft?: Draft | null;
  /** opened from a Reply on Waiting on us */
  startOpen?: boolean;
  /** after a successful send (the client card reloads its Gmail list) */
  onSent?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState("");
  const [head, setHead] = useState<{ to?: string; from?: string; subject?: string; error?: string; blocked?: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, startLoad] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [sending, startSend] = useTransition();
  const targetKey = JSON.stringify(target);

  // Opening the box reads who it goes to. A READ: nothing is sent here.
  useEffect(() => {
    if (!open || head) return;
    let alive = true;
    startLoad(async () => {
      const r = await prepareEmailReply(JSON.parse(targetKey) as EmailReplyTarget).catch(() => ({ ok: false as const, message: "Couldn't reach the hub. Try again.", to: undefined, from: undefined, subject: undefined, needsReconnect: false }));
      if (!alive) return;
      setHead(r.ok ? { to: r.to, from: r.from, subject: r.subject } : { to: r.to, from: r.from, subject: r.subject, error: r.message, blocked: true });
    });
    return () => { alive = false; };
  }, [open, head, targetKey]);

  const write = (v: string) => {
    setText(v);
    setIntentId(null); // new words are a new email
    setError(null);
  };

  const makeDraft = () => {
    if (!draft) return;
    setError(null);
    setNote(null);
    startDraft(async () => {
      const r = await draft().catch(() => ({ ok: false, message: "Couldn't draft a reply. Try again.", draft: undefined }));
      if (r.ok && r.draft) { write(r.draft); setNote(r.message); }
      else setError(r.message);
    });
  };

  // THE SEND. Only this button's press.
  const send = () => {
    const body = text.trim();
    if (!body) { setError("Write the reply first. Nothing was sent."); return; }
    const id = intentId ?? mintIntentId();
    setIntentId(id);
    setError(null);
    startSend(async () => {
      const r = await sendEmailThreadReply(target, body, id, head?.to ?? null).catch(() => ({
        ok: false as const,
        message: "Couldn't reach the hub. Press Send again: the same reply can't go twice.",
        to: undefined,
        needsReconnect: false,
      }));
      if (r.ok) {
        setSent(r.message);
        onSent?.();
        router.refresh();
      } else {
        setError(r.message);
      }
    });
  };

  if (sent) {
    return (
      <p role="status" data-email-reply-sent className="inline-flex items-center gap-1.5 text-sm font-semibold text-success">
        <Check aria-hidden className="size-4" /> {sent}
      </p>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-semibold text-white hover:opacity-90"
        >
          <Reply aria-hidden className="size-4" /> Reply
        </button>
        {/* One press to the AI draft, in the open box (it only fills the box). */}
        {draft && (
          <button
            type="button"
            onClick={() => { setOpen(true); makeDraft(); }}
            title="AI-draft a reply (uses our scheduling availability when they ask)"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-brand hover:bg-surface-2"
          >
            <Sparkles aria-hidden className="size-4" /> Draft a reply
          </button>
        )}
      </div>
    );
  }

  const blocked = !!head?.blocked;
  return (
    <div data-email-reply className="rounded-xl border border-brand/30 bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {loading && !head ? (
          <span className="inline-flex items-center gap-1.5"><Loader2 aria-hidden className="size-3.5 animate-spin" /> Checking who this goes to…</span>
        ) : head?.to ? (
          <span>
            To <strong className="font-semibold text-foreground">{head.to}</strong>
            {head.from ? <> from {head.from}</> : null}
            {head.subject ? <> · {head.subject}</> : null}
          </span>
        ) : null}
        <button type="button" onClick={() => setOpen(false)} aria-label="Close the reply" className="ml-auto inline-flex min-h-9 items-center rounded-lg px-2 text-muted hover:text-foreground">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      {head?.error && (
        <p role="alert" className="mb-2 flex items-start gap-1.5 text-xs text-warning">
          <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" /> {head.error}
        </p>
      )}
      <AutoTextarea
        value={text}
        onChange={(e) => write(e.target.value)}
        aria-label="Your reply"
        placeholder="Write your reply"
        disabled={sending}
        minRows={4}
        className="w-full rounded-lg border border-border bg-background p-2.5 text-base leading-relaxed outline-none focus:border-brand sm:text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={sending || drafting || blocked || !text.trim() || !head?.to}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {sending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />} Send
        </button>
        {draft && (
          <button
            type="button"
            onClick={makeDraft}
            disabled={drafting || sending}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-brand hover:bg-surface-2 disabled:opacity-50"
          >
            {drafting ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Sparkles aria-hidden className="size-4" />}
            {text.trim() ? "Draft it again" : "Draft a reply"}
          </button>
        )}
        {text.trim() && (
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setCopied(true); }}
            className="inline-flex min-h-11 items-center gap-1 px-1 text-xs text-muted hover:text-foreground"
          >
            <Copy aria-hidden className="size-3.5" /> {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      {note && !error && <p className="mt-2 text-xs text-muted">{note}</p>}
      <p className="mt-2 text-[11px] text-muted-2">Nothing goes until you press Send. It goes into the same Gmail thread.</p>
    </div>
  );
}
