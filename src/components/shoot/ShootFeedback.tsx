"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  CheckCircle2, ChevronDown, ChevronUp, GraduationCap, Loader2,
  MessageSquare, Play, Reply, Send, Video, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Section } from "@/components/ui/Section";
import { Badge } from "@/components/ui/Badge";
import { MentionTextarea } from "@/components/mentions/MentionTextarea";
import { NotePreview, clockLabel, videoSrcAt } from "@/components/shoot/NotePreview";
import { PALETTE } from "@/lib/palette";
import { etDate } from "@/lib/datetime";
import { acknowledgeMediaNote, replyMediaNote, setMediaNoteStatus, shareShootFeedback } from "@/app/projects/reviewActions";
import type { ReviewNote } from "@/lib/review";

// "Feedback on this shoot" — the photographer's lane of the media review room.
// Jordan drops pin-point capture notes while reviewing delivered media; this
// card is where the photographer sees them, talks back, and ticks fixes off.
// The tone stays friendly on purpose: this is coaching + a short punch list,
// not a write-up. No money anywhere near this card.

// The app's warning token (globals.css --warning) as hex — Badge derives its
// tint from a hex, and "Fix needed" should read in the warning color, not a
// rotation hue from the chip palette.
const WARNING_HEX = "#fbbf24";

// Actionable first: open fixes → fixes waiting on Jordan's re-review →
// coaching. (Resolved notes never reach this ranking — they live in the
// collapsed history below.) Stable sort keeps newest-first inside each bucket.
const rank = (n: ReviewNote) => (n.kind === "fix" ? (n.status === "OPEN" ? 0 : 1) : 2);

const timeLabel = clockLabel;

export function ShootFeedback({ notes: initial, readOnly, replyOnly, photographerName, projectId }: {
  notes: ReviewNote[];
  /** Owner/admin (and "view as") previews are look-don't-touch — the server
      actions would reject their writes anyway, so don't offer the buttons. */
  readOnly: boolean;
  /** @-mentioned viewer (not the addressee): thread + reply box only. */
  replyOnly?: boolean;
  photographerName: string | null;
  /** When set (shoot page), the owner preview gets the "text them the link" share button. */
  projectId?: string;
}) {
  // Local mirror so replies / "mark fixed" land instantly on a phone in the
  // field; the actions revalidate the route behind us, so a refresh reconverges.
  const [notes, setNotes] = useState(initial);
  const [showResolved, setShowResolved] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [sharing, startShare] = useTransition();

  const active = notes.filter((n) => n.status !== "RESOLVED").sort((a, b) => rank(a) - rank(b));
  const resolved = notes.filter((n) => n.status === "RESOLVED");
  const openFixes = active.filter((n) => n.kind === "fix" && n.status === "OPEN").length;

  const patch = (id: string, fn: (n: ReviewNote) => ReviewNote) =>
    setNotes((ns) => ns.map((n) => (n.id === id ? fn(n) : n)));

  // Receipts for the owner's preview: has the creative actually READ this?
  const lastShared = notes.reduce<string | null>((m, n) => (n.sharedAt && (!m || n.sharedAt > m) ? n.sharedAt : m), null);
  const lastSeen = notes.reduce<string | null>((m, n) => (n.seenAt && (!m || n.seenAt > m) ? n.seenAt : m), null);
  const firstName = photographerName?.split(/\s+/)[0] ?? "the photographer";

  const share = () =>
    startShare(async () => {
      if (!projectId) return;
      setShareMsg(null);
      const r = await shareShootFeedback(projectId);
      setShareMsg(r.message);
    });

  return (
    <Section
      icon={MessageSquare}
      title="Feedback on this shoot"
      count={openFixes > 0 ? `${openFixes} to fix` : undefined}
      bodyClassName="space-y-3"
    >
      <p className="text-xs text-muted">
        {readOnly
          ? `Previewing ${firstName}’s capture feedback — read-only.`
          : "Notes from the review of your delivered media — quick wins for this job and the next one. Reply if anything’s unclear, and tick fixes off once they’re handled."}
      </p>

      {/* Owner's loop-closer: text them the link, then watch the receipts. */}
      {readOnly && projectId && notes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2/40 p-2.5">
          <button
            onClick={share}
            disabled={sharing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
            title={`Text ${firstName} a link to this feedback`}
          >
            {sharing ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Text {firstName} the feedback
          </button>
          <span className="text-[11px] text-muted-2">
            {lastShared ? `Shared ${etDate(lastShared)}` : "Not shared yet"}
            {" · "}
            {lastSeen ? (
              <span className="font-medium text-success">Seen {etDate(lastSeen)}</span>
            ) : (
              <span className="text-warning">Not opened yet</span>
            )}
          </span>
          {shareMsg && <span className="w-full text-[11px] font-medium text-foreground/85 sm:w-auto">{shareMsg}</span>}
        </div>
      )}

      {active.map((n) => (
        <NoteCard key={n.id} note={n} readOnly={readOnly} replyOnly={replyOnly} patch={patch} />
      ))}

      {active.length === 0 && resolved.length > 0 && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-success">
          <CheckCircle2 className="size-4" /> All feedback on this shoot is resolved — nice work.
        </p>
      )}

      {resolved.length > 0 && (
        <div>
          <button
            onClick={() => setShowResolved((s) => !s)}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground"
          >
            {showResolved ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showResolved ? "Hide resolved" : `Show resolved (${resolved.length})`}
          </button>
          {showResolved && (
            <div className="mt-2 space-y-3 opacity-75">
              {resolved.map((n) => (
                <NoteCard key={n.id} note={n} readOnly={readOnly} replyOnly={replyOnly} patch={patch} />
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

// Exported for the cross-shoot feedback hub (/shoot/feedback), which renders
// the same note rows grouped by shoot.
export function NoteCard({ note, readOnly, replyOnly, patch }: {
  note: ReviewNote;
  readOnly: boolean;
  /** A viewer admitted by @-mention (not the note's addressee): they can reply
   *  on the thread, but Mark-fixed / Got-it belong to the addressee alone —
   *  the server rejects them anyway, so don't offer buttons that only error. */
  replyOnly?: boolean;
  patch: (id: string, fn: (n: ReviewNote) => ReviewNote) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [fixing, startFix] = useTransition();
  const fix = note.kind === "fix";

  function markFixed() {
    startFix(async () => {
      setErr(null);
      const r = await setMediaNoteStatus(note.id, "FIXED");
      if (r.ok) patch(note.id, (n) => ({ ...n, status: "FIXED" }));
      else setErr(r.message ?? "Couldn’t save — try again.");
    });
  }

  function acknowledge() {
    startFix(async () => {
      setErr(null);
      const r = await acknowledgeMediaNote(note.id);
      if (r.ok) patch(note.id, (n) => ({ ...n, acknowledgedAt: new Date().toISOString() }));
      else setErr(r.message ?? "Couldn’t save — try again.");
    });
  }

  return (
    <div className="rounded-xl border bg-surface-2/30 p-3">
      <div className="flex gap-3">
        <Thumb note={note} onOpen={() => setPreview(true)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {fix ? (
              <Badge color={WARNING_HEX}><Wrench className="size-3" /> Fix needed</Badge>
            ) : (
              <Badge color={PALETTE.blue}><GraduationCap className="size-3" /> Coaching</Badge>
            )}
            {!fix && note.acknowledgedAt ? (
              <Badge color={PALETTE.green}>Got it ✓</Badge>
            ) : (
              fix && <StatusChip status={note.status} />
            )}
            {readOnly && note.seenAt && (
              <span className="text-[10px] font-medium text-success" title="They opened this feedback">
                Seen {etDate(note.seenAt)}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm leading-snug text-foreground/90">{note.body}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-2">
            <span>{note.authorName ?? "RealTour"} · {etDate(note.createdAt)}</span>
            <button onClick={() => setPreview(true)} className="font-medium text-brand hover:underline">
              {note.assetType === "video"
                ? note.timeSec != null ? `Watch at ${timeLabel(note.timeSec)} →` : "Watch the video →"
                : "See the spot →"}
            </button>
          </div>
        </div>
      </div>

      {preview && <NotePreview note={note} onClose={() => setPreview(false)} />}

      {note.replies.length > 0 && (
        <div className="mt-2.5 space-y-2 border-t pt-2.5">
          {note.replies.map((r) => (
            <div key={r.id} className="pl-2 text-sm">
              <span className="text-xs font-medium">{r.authorName ?? "Reply"}</span>{" "}
              <span className="text-[11px] text-muted-2">{etDate(r.createdAt)}</span>
              <p className="text-foreground/85">{r.body}</p>
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="mt-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            {!replyOnly && fix && note.status === "OPEN" && (
              <button
                onClick={markFixed}
                disabled={fixing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
              >
                {fixing ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Mark fixed
              </button>
            )}
            {!replyOnly && !fix && !note.acknowledgedAt && (
              <button
                onClick={acknowledge}
                disabled={fixing}
                title="Tell the reviewer you've read this and you're on it"
                className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-1.5 text-xs font-semibold text-success hover:bg-success/20 disabled:opacity-50"
              >
                {fixing ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Got it
              </button>
            )}
            <ReplyBox
              noteId={note.id}
              onAdded={(body) =>
                patch(note.id, (n) => ({
                  ...n,
                  // Optimistic append — the revalidated payload swaps in the
                  // real row (with the proper author name) on next render.
                  replies: [...n.replies, { id: `local-${Date.now()}`, body, authorName: "You", createdAt: new Date().toISOString() }],
                }))
              }
            />
          </div>
          {err && <span className="text-xs text-danger">{err}</span>}
        </div>
      )}
    </div>
  );
}

// The photo the note was pinned on, with the reviewer's pin dot overlaid at
// the same normalized 0..1 coords the review room saved. Video notes show the
// FRAME AT THE NOTED TIMESTAMP (a paused <video> parked on "#t=<sec>") so the
// thumbnail previews the exact moment. Tapping opens the full preview.
function Thumb({ note, onOpen }: { note: ReviewNote; onOpen: () => void }) {
  const [frameBroken, setFrameBroken] = useState(false);
  // The frame preview costs real bytes per note (video metadata + one frame) —
  // on the cross-shoot hub that's dozens of videos, so only mount each <video>
  // once its thumb nears the viewport (photographers open this on cell data).
  const ref = useRef<HTMLButtonElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || note.assetType !== "video") return;
    const io = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && setInView(true),
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [note.assetType]);
  const src = note.thumbUrl ?? (note.assetType === "image" ? note.assetUrl : null);
  const videoFrame = note.assetType === "video" && !frameBroken && inView;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      title={note.assetType === "video" ? "Open the video at this moment" : "Open the photo at this spot"}
      className="group relative w-[120px] shrink-0 self-start overflow-hidden rounded-lg border bg-surface-2 transition-shadow hover:ring-2 hover:ring-brand/60"
    >
      {videoFrame ? (
        <video
          src={videoSrcAt(note.assetUrl, note.timeSec)}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          onError={() => setFrameBroken(true)}
          className="pointer-events-none aspect-[3/2] w-full object-cover"
        />
      ) : src ? (
        <img src={src} alt="" loading="lazy" className="aspect-[3/2] w-full object-cover" />
      ) : (
        <div className="flex aspect-[3/2] w-full items-center justify-center text-muted-2">
          <Video className="size-5" />
        </div>
      )}
      {note.assetType === "video" && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/50 p-1.5 text-white transition-transform group-hover:scale-110">
            <Play className="size-4 fill-current" />
          </span>
        </span>
      )}
      {note.x != null && note.y != null && (
        <span
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{
            left: `${note.x * 100}%`,
            top: `${note.y * 100}%`,
            backgroundColor: note.kind === "fix" ? "var(--warning)" : PALETTE.blue,
          }}
        />
      )}
      {note.timeSec != null && (
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] font-medium text-white">
          {timeLabel(note.timeSec)}
        </span>
      )}
    </button>
  );
}

function StatusChip({ status }: { status: ReviewNote["status"] }) {
  if (status === "FIXED") return <Badge color={PALETTE.teal}>Marked fixed</Badge>;
  if (status === "RESOLVED") return <Badge color={PALETTE.green}>Resolved</Badge>;
  return <Badge color={PALETTE.gray}>Open</Badge>;
}

// PayFlag-style inline reply: a quiet text button that opens a small composer.
function ReplyBox({ noteId, onAdded }: { noteId: string; onAdded: (body: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const send = () =>
    start(async () => {
      setErr(null);
      const r = await replyMediaNote(noteId, text);
      if (r.ok) { onAdded(text.trim()); setText(""); setOpen(false); }
      else setErr(r.message ?? "Couldn’t send — try again.");
    });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground"
      >
        <Reply className="size-3.5" /> Reply
      </button>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      <MentionTextarea
        value={text}
        onChange={setText}
        rows={2}
        placeholder="e.g. Got it — I’ll grab that angle on the reshoot… (@ to tag someone)"
        className="w-full resize-none rounded-xl border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={send}
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-xs font-semibold hover:bg-surface-2 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send reply
        </button>
        <button onClick={() => { setOpen(false); setErr(null); }} className="text-xs text-muted hover:text-foreground">Cancel</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}
