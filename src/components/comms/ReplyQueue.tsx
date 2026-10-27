"use client";

import { etMonthDayTime } from "@/lib/datetime";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Sparkles, Loader2, Send, Copy, Check, MessageSquare, ChevronDown, ChevronUp,
  AlertTriangle, Wand2, User, Camera, Clock,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { cn } from "@/lib/utils";
import { generateReply, sendReply } from "@/app/communications/replyActions";
import { listMutedNumbers, unmuteCommsNumber } from "@/app/actions";
import { CommsDismissButton } from "@/components/tasks/ChecklistButtons";
import type { ReplyCard } from "@/lib/replyQueue";

// A TEXT REPLY, as Kyle sees it: what they sent, a reply already written, and
// a box where he can say what he actually wants to say and have it written
// properly. Since Oct 27 2026 (Jordan: "One queue") it is one conversation at
// a time, opened from its row on Messages · Waiting on us.
//
// Nothing here sends on its own. A human reads every message and clicks Send —
// the same rule every client-facing message in the hub follows.

// The phrases the 30-day comms review flagged: a promise with no time in it.
// Highlighted live in the editor, so the habit is visible while it's being
// typed rather than a month later in a report.
const VAGUE = /\b(should be|shortly|soon|asap|as soon as possible|in a bit|in a few|at some point|when it'?s ready)\b/i;

function waitLabel(hours: number): { text: string; tone: "ok" | "warn" | "bad" } {
  if (hours < 1) return { text: "just now", tone: "ok" };
  if (hours < 24) return { text: `${hours}h waiting`, tone: hours >= 4 ? "warn" : "ok" };
  const d = Math.round(hours / 24);
  return { text: `${d} day${d === 1 ? "" : "s"} waiting`, tone: "bad" };
}

// ET, date and time as two calls (datetime.ts: Safari joins a one-call
// date+time differently from Node — a hydration mismatch).
const fmtTime = (iso: string) => etMonthDayTime(iso);

/** A fresh outbox identity for a reply (outbox.manualKey). Only ever called
 *  from a Send press, never while rendering. */
const mintIntentId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `i${Date.now()}${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, "");

type CardState = {
  draft: string;
  instruction: string;
  /** "unconfirmed" (audit F3, Oct 20 2026): OpenPhone did not answer, so the
   *  reply may already be on the client's phone. Send is hidden, not reset. */
  status: "idle" | "drafting" | "sent" | "unconfirmed";
  note: string | null;
  error: string | null;
  showThread: boolean;
  copied: boolean;
  /** The outbox identity of THIS draft (outbox.manualKey), minted on the first
   *  press and kept until the words change: a second press on the same words
   *  collides in the outbox instead of texting the client twice. */
  intentId: string | null;
};

const blank = (): CardState => ({
  draft: "", instruction: "", status: "idle", note: null, error: null, showThread: false, copied: false, intentId: null,
});

type CardProps = {
  card: ReplyCard;
  state: CardState;
  patch: (p: Partial<CardState>) => void;
  onDraft: (instruction?: string) => void;
  onSend: () => void;
  /** the card cleared itself — drop it from the list without a round trip */
  onDismiss: (message: string | null) => void;
  /** opened from a Reply on Messages · Waiting on us: shown first, marked */
  focused?: boolean;
};

function ReplyCardView({ card, state: s, patch, onDraft, onSend, onDismiss, focused = false }: CardProps) {
  const wait = waitLabel(card.hoursWaiting);
  const vague = s.draft ? VAGUE.exec(s.draft) : null;
  const sent = s.status === "sent";
  const unconfirmed = s.status === "unconfirmed";
  const busy = s.status === "drafting";

  return (
    <div
      data-reply-card={card.key}
      aria-current={focused ? "true" : undefined}
      className={cn(
        "rounded-2xl border bg-surface transition",
        sent ? "border-success opacity-60" : wait.tone === "bad" && !card.likelyHandled ? "border-danger/40" : "border-border",
        focused && !sent && "ring-2 ring-brand",
      )}
    >
      {/* Who, and how long they've been waiting */}
      <div className="flex items-start gap-3 border-b border-border p-4">
        <Avatar name={card.displayName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {card.clientId ? (
              <Link href={`/clients/${card.clientId}`} className="text-sm font-semibold hover:underline">
                {card.displayName}
              </Link>
            ) : (
              <span className="text-sm font-semibold">{card.displayName}</span>
            )}
            {card.segment && <SegmentBadge segment={card.segment} />}
            {card.isTeam && (
              <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                <Camera className="size-2.5" /> our team
              </span>
            )}
            {!card.isClient && !card.isTeam && (
              <span className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                <User className="size-2.5" /> not a saved client
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                card.likelyHandled ? "text-muted" : wait.tone === "bad" ? "text-danger" : wait.tone === "warn" ? "text-warning" : "text-muted",
              )}
            >
              <Clock className="size-3" /> {wait.text}
            </span>
            <span>· {fmtTime(card.waitingSince)}</span>
            {card.propertyAddress && <span>· {card.propertyAddress.split(",")[0]}</span>}
          </div>
        </div>
      </div>

      <div className="p-4">
        {/* What they actually said */}
        <div className="rounded-xl bg-surface-2 p-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{card.lastInbound}</p>
        </div>
        {/* Oct 22 2026 (audit H4): our last word was a holding line, so the answer is still owed. */}
        {card.holding && (
          <p data-holding className="mt-2 text-xs text-muted">
            We said &ldquo;{card.holding.text}&rdquo; ({etMonthDayTime(card.holding.atISO)}). Answer due by {etMonthDayTime(card.holding.dueISO)}.
          </p>
        )}
        {card.schedulingAsks.length > 0 && (
          <p data-scheduling-asks className="mt-1 text-xs text-muted">
            Open scheduling request: {card.schedulingAsks[card.schedulingAsks.length - 1]}
            {card.schedulingAsks.length > 1 ? ` (and ${card.schedulingAsks.length - 1} more)` : ""}
          </p>
        )}

        {card.turns.length > 1 && (
          <button
            onClick={() => patch({ showThread: !s.showThread })}
            className="mt-2 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            {s.showThread ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            {s.showThread ? "Hide" : `Show the conversation (${card.turns.length} messages)`}
          </button>
        )}
        {s.showThread && (
          <div className="mt-2 space-y-1.5 rounded-xl border border-border p-3">
            {card.turns.map((t, i) => (
              <div key={i} className={cn("flex", t.role === "us" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed",
                    t.role === "us" ? "bg-brand-soft text-foreground" : "bg-surface-2",
                  )}
                >
                  <p className="whitespace-pre-wrap">{t.text}</p>
                  <p className="mt-0.5 text-[10px] text-muted-2">{fmtTime(t.at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* The reply */}
        {!s.draft && !sent && (
          <div className="mt-3">
            <button
              onClick={() => onDraft()}
              disabled={busy}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-brand transition hover:bg-surface-2 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {busy ? "Writing…" : "Write a reply"}
            </button>
          </div>
        )}

        {s.draft && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Your reply</span>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(s.draft).catch(() => {});
                  patch({ copied: true });
                  setTimeout(() => patch({ copied: false }), 1600);
                }}
                className="inline-flex min-h-9 items-center gap-1 text-xs text-muted hover:text-foreground"
              >
                {s.copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                {s.copied ? "Copied" : "Copy"}
              </button>
            </div>
            <AutoTextarea
              value={s.draft}
              onChange={(e) => patch({ draft: e.target.value })}
              disabled={sent || unconfirmed}
              className="w-full rounded-xl border border-border bg-background p-3 text-base leading-relaxed outline-none focus:border-brand sm:text-sm"
              minRows={3}
            />
            {vague && (
              <p className="mt-1.5 inline-flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>
                  &ldquo;{vague[0]}&rdquo; doesn&rsquo;t tell them when. Put a real time in it — that&rsquo;s the one
                  thing clients chase us about.
                </span>
              </p>
            )}
          </div>
        )}

        {/* Tailoring — the part that makes this Kyle's message, not the model's */}
        {!sent && !unconfirmed && (
          <div className="mt-3 rounded-xl border border-dashed border-border p-3">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              Tell it what to say
            </label>
            <AutoTextarea
              value={s.instruction}
              onChange={(e) => patch({ instruction: e.target.value })}
              placeholder={
                s.draft
                  ? "e.g. tell them Saturday 10am works but I need the lockbox code"
                  : "e.g. photos go out tonight by 8, video Thursday"
              }
              className="w-full rounded-lg border border-border bg-background p-2.5 text-base outline-none focus:border-brand sm:text-sm"
              minRows={2}
            />
            <button
              onClick={() => onDraft(s.instruction)}
              disabled={busy || !s.instruction.trim()}
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-sm font-medium transition hover:bg-surface disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
              {s.draft ? "Rewrite it this way" : "Write it"}
            </button>
            <p className="mt-1.5 text-xs text-muted-2">
              Say it however you like. It gets written properly, with their history and our policies already applied.
            </p>
          </div>
        )}

        {/* Send */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!sent && !unconfirmed && s.draft && (
            <button
              onClick={onSend}
              disabled={busy || !s.draft.trim() || !card.phone}
              title={card.phone ? undefined : "No number on file for this conversation"}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Send
            </button>
          )}
          {sent && (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success">
              <Check className="size-4" /> {s.note ?? "Sent."}
            </span>
          )}
          {card.clientId && (
            <Link
              href={`/clients/${card.clientId}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:text-foreground"
            >
              <MessageSquare className="size-4" /> Open the client
            </Link>
          )}
          {!card.phone && (
            <span className="text-xs text-warning">No number on file. Reply from the All tab.</span>
          )}
          {/* THE WAY OUT (Kyle, Sep 16: "there’s no way to get rid of things
              I’ve already dealt with"). Every row gets it — a client, an
              unmatched number, one of our own photographers, a blast. It is a
              cut point, not a delete: the conversation stays in the Inbox, and
              a NEW message from them puts the row back. */}
          {!sent && (
            <CommsDismissButton
              threadKey={card.key}
              family={card.family}
              clientId={card.clientId}
              onCleared={onDismiss}
            />
          )}
        </div>

        {s.error && <p className="mt-2 text-xs text-danger">{s.error}</p>}
        {unconfirmed && s.note && (
          <p role="status" className="mt-2 text-xs text-warning">
            {s.note} Check the conversation on the All tab before writing to them again.
          </p>
        )}
        {s.note && !sent && !unconfirmed && !s.error && <p className="mt-2 text-xs text-muted">{s.note}</p>}
      </div>
    </div>
  );
}

// ONE CONVERSATION'S REPLY SCREEN (Jordan, Oct 27 2026: "One queue"). The
// queue itself is Messages · Waiting on us; a text's Reply there opens this
// with that one conversation, its messages open and a reply ready to write.
// The list this used to be (Draft all, the Everyone / Clients only filter,
// the thank-yous fold) was the second queue, and is gone with it. The card
// stays put after a send or a dismiss so its "Sent" can be read.
export function ReplyQueue({
  cards: initial,
  focusKey = null,
}: {
  cards: ReplyCard[];
  /** the conversation a Reply on Messages · Waiting on us opened: marked,
   *  its conversation open */
  focusKey?: string | null;
}) {
  const [cards] = useState(initial);
  const [state, setState] = useState<Record<string, CardState>>(() => (focusKey ? { [focusKey]: { ...blank(), showThread: true } } : {}));
  const [, startWork] = useTransition();

  const get = (k: string) => state[k] ?? blank();
  // New words are a new message: a changed draft drops the old send identity.
  const patch = (k: string, p: Partial<CardState>) =>
    setState((s) => {
      const prev = s[k] ?? blank();
      const fresh = p.draft !== undefined && p.draft !== prev.draft && !("intentId" in p) ? { intentId: null } : {};
      return { ...s, [k]: { ...prev, ...p, ...fresh } };
    });

  const draftOne = (card: ReplyCard, instruction?: string) => {
    patch(card.key, { status: "drafting", error: null, note: null });
    startWork(async () => {
      const r = await generateReply(card.key, instruction ?? null);
      if (r.ok && r.draft) patch(card.key, { draft: r.draft, status: "idle", note: r.message, instruction: "" });
      else patch(card.key, { status: "idle", error: r.message });
    });
  };

  const send = (card: ReplyCard) => {
    const s = get(card.key);
    if (!s.draft.trim()) return;
    // R4: the identity of THIS message (see outbox.manualKey). Kept on the card
    // until the words change (audit F3, Oct 20 2026): a press that came back
    // unanswered and is pressed again collides instead of sending twice.
    const intentId = s.intentId ?? mintIntentId();
    patch(card.key, { status: "drafting", error: null, intentId });
    startWork(async () => {
      const r = await sendReply(card.key, s.draft, intentId).catch(() => ({ ok: false as const, pending: false, message: "Couldn't reach the hub. Press Send again: the same reply can't go twice." }));
      if (r.ok) {
        patch(card.key, { status: "sent", note: r.message, error: null });
      } else if (r.pending) {
        // A03: the provider did not answer, so this is neither sent nor failed.
        // The card STAYS (somebody has to look), but it is not reset to "idle"
        // with a red error — that reads as "it didn't go" and invites the
        // second press that puts the message on the client's phone twice.
        // F3 (Oct 20 2026): nor to "idle" with the note, which left a live
        // Send button beside "give it a minute". Send stays hidden until a
        // person has looked.
        patch(card.key, { status: "unconfirmed", note: r.message, error: null });
      } else {
        patch(card.key, { status: "idle", error: r.message });
      }
    });
  };

  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <ReplyCardView
          key={card.key}
          card={card}
          state={get(card.key)}
          patch={(p) => patch(card.key, p)}
          onDraft={(instruction) => draftOne(card, instruction)}
          onSend={() => send(card)}
          onDismiss={() => {}}
          focused={!!focusKey && card.key === focusKey}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbers marked spam. A mute nobody can see is a mute nobody can undo, and
// a wrongly-muted number is a client we never hear from again — so the list
// lives right here, one click away, and un-muting brings the conversation
// straight back (nothing was ever deleted). Loaded on demand: the page costs
// nothing when nobody has muted anything, which is the normal case.
// Oct 27 2026: also at the foot of Messages · Waiting on us, the one queue.
// ---------------------------------------------------------------------------
export function MutedNumbers() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ phone: string; since: string; reason: string | null }[] | null>(null);
  // F18 (Oct 20 2026): a refused or failed read/un-mute says so, rather than
  // "Nothing is muted" or a row that vanishes without being un-muted.
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const fmtPhone = (k: string) => (k.length === 10 ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : k);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null) {
      start(async () => {
        const r = await listMutedNumbers().catch(() => ({ ok: false as const, message: "Couldn't read the muted list. Try again." }));
        if (r.ok) { setRows(r.rows); setErr(null); }
        else { setErr(r.message); setOpen(false); }
      });
    }
  };

  return (
    <div className="pt-2">
      <button
        onClick={toggle}
        className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-muted-2 hover:text-foreground"
      >
        {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        Muted numbers
        {busy && <Loader2 className="size-3 animate-spin" />}
      </button>
      {err && <p role="alert" className="mt-1 text-xs text-danger">{err}</p>}
      {open && (
        <div className="mt-2 rounded-xl border border-border p-3">
          {rows === null ? (
            <p className="text-xs text-muted">Checking…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted">Nothing is muted. Marking a conversation as spam mutes that number until you un-mute it here.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((m) => (
                <li key={m.phone} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{fmtPhone(m.phone)}</span>
                  <span className="text-muted-2">muted {fmtTime(m.since)}</span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      start(async () => {
                        const r = await unmuteCommsNumber(m.phone).catch(() => ({ ok: false, message: "Couldn't un-mute it. Try again." }));
                        if (r.ok) { setErr(null); setRows((rs) => (rs ?? []).filter((x) => x.phone !== m.phone)); }
                        else setErr(r.message ?? "Couldn't un-mute it. Try again.");
                      })
                    }
                    className="inline-flex min-h-9 items-center rounded-lg border border-border px-2 py-1 font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
                  >
                    Un-mute
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
