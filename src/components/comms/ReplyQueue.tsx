"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  Sparkles, Loader2, Send, Copy, Check, MessageSquare, ChevronDown, ChevronUp,
  AlertTriangle, Wand2, User, Camera, Clock, Inbox,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { cn } from "@/lib/utils";
import { generateReply, generateAllReplies, sendReply } from "@/app/communications/replyActions";
import { listMutedNumbers, unmuteCommsNumber } from "@/app/actions";
import { CommsDismissButton } from "@/components/tasks/ChecklistButtons";
import type { ReplyCard } from "@/lib/replyQueue";

// THE REPLY QUEUE, as Kyle sees it. Every inbound text still owed an answer,
// each with a reply already written, plus a box where he can say what he
// actually wants to say and have it written properly.
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

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

type CardState = {
  draft: string;
  instruction: string;
  status: "idle" | "drafting" | "sent";
  note: string | null;
  error: string | null;
  showThread: boolean;
  copied: boolean;
};

const blank = (): CardState => ({
  draft: "", instruction: "", status: "idle", note: null, error: null, showThread: false, copied: false,
});

type CardProps = {
  card: ReplyCard;
  state: CardState;
  patch: (p: Partial<CardState>) => void;
  onDraft: (instruction?: string) => void;
  onSend: () => void;
  /** the card cleared itself — drop it from the list without a round trip */
  onDismiss: () => void;
};

function ReplyCardView({ card, state: s, patch, onDraft, onSend, onDismiss }: CardProps) {
  const wait = waitLabel(card.hoursWaiting);
  const vague = s.draft ? VAGUE.exec(s.draft) : null;
  const sent = s.status === "sent";
  const busy = s.status === "drafting";

  return (
    <div
      className={cn(
        "rounded-2xl border bg-surface transition",
        sent ? "border-success opacity-60" : wait.tone === "bad" && !card.likelyHandled ? "border-danger/40" : "border-border",
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

        {card.turns.length > 1 && (
          <button
            onClick={() => patch({ showThread: !s.showThread })}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-brand transition hover:bg-surface-2 disabled:opacity-50"
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
                className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
              >
                {s.copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                {s.copied ? "Copied" : "Copy"}
              </button>
            </div>
            <AutoTextarea
              value={s.draft}
              onChange={(e) => patch({ draft: e.target.value })}
              disabled={sent}
              className="w-full rounded-xl border border-border bg-bg p-3 text-sm leading-relaxed outline-none focus:border-brand"
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
        {!sent && (
          <div className="mt-3 rounded-xl border border-dashed border-border p-3">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              Tell it what to say
            </label>
            <AutoTextarea
              value={s.instruction}
              onChange={(e) => patch({ instruction: e.target.value })}
              placeholder={
                s.draft
                  ? "e.g. tell her Saturday 10am works but I need the lockbox code"
                  : "e.g. photos go out tonight by 8, video Thursday"
              }
              className="w-full rounded-lg border border-border bg-bg p-2.5 text-sm outline-none focus:border-brand"
              minRows={2}
            />
            <button
              onClick={() => onDraft(s.instruction)}
              disabled={busy || !s.instruction.trim()}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-sm font-medium transition hover:bg-surface disabled:opacity-40"
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
          {!sent && s.draft && (
            <button
              onClick={onSend}
              disabled={busy || !s.draft.trim() || !card.phone}
              title={card.phone ? undefined : "No number on file for this conversation"}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:text-foreground"
            >
              <MessageSquare className="size-4" /> Open the client
            </Link>
          )}
          {!card.phone && (
            <span className="text-xs text-warning">No number on file — reply from the Inbox tab.</span>
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
        {s.note && !sent && !s.error && <p className="mt-2 text-xs text-muted">{s.note}</p>}
      </div>
    </div>
  );
}

export function ReplyQueue({
  cards: initial,
  handled: initialHandled = [],
}: {
  cards: ReplyCard[];
  handled?: ReplyCard[];
}) {
  const [cards, setCards] = useState(initial);
  const [handled, setHandled] = useState(initialHandled);
  const [state, setState] = useState<Record<string, CardState>>({});
  const [filter, setFilter] = useState<"all" | "clients">("all");
  const [showHandled, setShowHandled] = useState(false);
  const [bulk, startBulk] = useTransition();
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  const get = (k: string) => state[k] ?? blank();
  const patch = (k: string, p: Partial<CardState>) =>
    setState((s) => ({ ...s, [k]: { ...(s[k] ?? blank()), ...p } }));

  const visible = useMemo(
    () => (filter === "clients" ? cards.filter((c) => c.isClient) : cards),
    [cards, filter],
  );

  // Generate every visible draft at once. This is what turns the page from a
  // list of chores into a stack of decisions.
  const draftAll = () => {
    const todo = visible.filter((c) => !get(c.key).draft && get(c.key).status !== "sent").map((c) => c.key);
    if (todo.length === 0) return;
    todo.forEach((k) => patch(k, { status: "drafting", error: null }));
    setBulkNote(`Writing ${todo.length} replies…`);
    startBulk(async () => {
      const r = await generateAllReplies(todo);
      todo.forEach((k) => {
        const d = r.drafts[k];
        patch(k, d ? { draft: d, status: "idle" } : { status: "idle", error: "Couldn't draft this one — try it on its own." });
      });
      setBulkNote(r.message);
    });
  };

  const draftOne = (card: ReplyCard, instruction?: string) => {
    patch(card.key, { status: "drafting", error: null, note: null });
    startBulk(async () => {
      const r = await generateReply(card.key, instruction ?? null);
      if (r.ok && r.draft) patch(card.key, { draft: r.draft, status: "idle", note: r.message, instruction: "" });
      else patch(card.key, { status: "idle", error: r.message });
    });
  };

  const send = (card: ReplyCard) => {
    const s = get(card.key);
    if (!s.draft.trim()) return;
    patch(card.key, { status: "drafting", error: null });
    startBulk(async () => {
      const r = await sendReply(card.key, s.draft);
      if (r.ok) {
        patch(card.key, { status: "sent", note: r.message, error: null });
        // Drop it after a beat so Kyle sees the confirmation land.
        setTimeout(() => {
          setCards((cs) => cs.filter((c) => c.key !== card.key));
          setHandled((cs) => cs.filter((c) => c.key !== card.key));
        }, 1400);
      } else {
        patch(card.key, { status: "idle", error: r.message });
      }
    });
  };

  const drop = (key: string) => {
    setCards((cs) => cs.filter((c) => c.key !== key));
    setHandled((cs) => cs.filter((c) => c.key !== key));
  };

  const cardProps = (card: ReplyCard): CardProps => ({
    card,
    state: get(card.key),
    patch: (p) => patch(card.key, p),
    onDraft: (instruction) => draftOne(card, instruction),
    onSend: () => send(card),
    // Dismissing leaves the confirmation on screen for a beat, same as a send,
    // so nothing blinks out from under the click.
    onDismiss: () => setTimeout(() => drop(card.key), 1400),
  });

  if (cards.length === 0 && handled.length === 0) {
    return (
      <div>
        <div className="rounded-2xl border border-border bg-surface p-10 text-center">
          <Inbox className="mx-auto mb-3 size-8 text-success" />
          <p className="text-base font-semibold">Everyone has been answered.</p>
          <p className="mt-1 text-sm text-muted">
            Nothing inbound is waiting on a reply. New messages land here automatically.
          </p>
        </div>
        {/* The un-mute list has to be reachable from the empty state too, or a
            number muted by mistake is a client we never hear from again. */}
        <MutedNumbers />
      </div>
    );
  }

  const pendingDraftable = visible.filter((c) => !get(c.key).draft && get(c.key).status !== "sent").length;

  return (
    <div className="space-y-3">
      {/* Controls */}
      {cards.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={draftAll}
            disabled={bulk || pendingDraftable === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {bulk ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {pendingDraftable === 0 ? "All drafted" : `Draft all ${pendingDraftable}`}
          </button>
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            {(["all", "clients"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition",
                  filter === f ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground",
                )}
              >
                {f === "all" ? `Everyone (${cards.length})` : `Clients only (${cards.filter((c) => c.isClient).length})`}
              </button>
            ))}
          </div>
          {bulkNote && <span className="text-xs text-muted">{bulkNote}</span>}
        </div>
      )}

      {cards.length === 0 ? (
        <div className="rounded-2xl border border-success/40 bg-surface p-6 text-center">
          <Check className="mx-auto mb-2 size-6 text-success" />
          <p className="text-sm font-semibold">Nothing needs an answer.</p>
          <p className="mt-1 text-sm text-muted">The only unanswered messages are thank-yous.</p>
        </div>
      ) : (
        visible.map((card) => <ReplyCardView key={card.key} {...cardProps(card)} />)
      )}

      {/* Courtesy closers and OUR OWN TEAM — technically unanswered, not a
          client sitting on a reply. Kept visible (Kyle may well want to answer
          a photographer, and every card here can be dismissed) but out of the
          count, which is what made the Replies badge disagree with the Comms
          tab and the home pill until Sep 16. */}
      {handled.length > 0 && (
        <div className="pt-2">
          <button
            onClick={() => setShowHandled(!showHandled)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-foreground"
          >
            {showHandled ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            {handled.length} more that probably need nothing
            <span className="text-xs text-muted-2">(thank-yous, confirmations, and our own team)</span>
          </button>
          {showHandled && (
            <div className="mt-3 space-y-3">
              {handled.map((card) => <ReplyCardView key={card.key} {...cardProps(card)} />)}
            </div>
          )}
        </div>
      )}

      <MutedNumbers />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbers marked spam. A mute nobody can see is a mute nobody can undo, and
// a wrongly-muted number is a client we never hear from again — so the list
// lives right here, one click away, and un-muting brings the conversation
// straight back (nothing was ever deleted). Loaded on demand: the page costs
// nothing when nobody has muted anything, which is the normal case.
// ---------------------------------------------------------------------------
function MutedNumbers() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ phone: string; since: string; reason: string | null }[] | null>(null);
  const [busy, start] = useTransition();

  const fmtPhone = (k: string) => (k.length === 10 ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : k);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null) start(async () => setRows(await listMutedNumbers().catch(() => [])));
  };

  return (
    <div className="pt-2">
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-2 hover:text-foreground"
      >
        {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        Muted numbers
        {busy && <Loader2 className="size-3 animate-spin" />}
      </button>
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
                        await unmuteCommsNumber(m.phone).catch(() => {});
                        setRows((r) => (r ?? []).filter((x) => x.phone !== m.phone));
                      })
                    }
                    className="rounded-lg border border-border px-2 py-1 font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
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
