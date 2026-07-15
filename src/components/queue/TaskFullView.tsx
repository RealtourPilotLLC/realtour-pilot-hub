"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Mail, Maximize2, MessageSquare, Phone, Hash, X } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { getTaskConversation, type SourceMessage } from "@/app/queue/fullViewActions";
import type { QueueTask } from "@/components/queue/TaskCard";

// "Full view" for a task — a reading surface. The card keeps things scannable;
// this modal shows EVERYTHING: the complete summary + message text (nothing
// clamped) and, for owner/admin, the original conversation the task came from,
// pulled live (Gmail thread / text log / Slack) so the full context — not the
// snippet — is one tap away.

const CHANNEL_ICON: Record<string, typeof Mail> = {
  email: Mail,
  text: Phone,
  call: Phone,
  slack: Hash,
  note: MessageSquare,
};

export function TaskFullView({ task, editorView }: { task: QueueTask; editorView?: boolean }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [conv, setConv] = useState<SourceMessage[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [canSee, setCanSee] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || editorView) return;
    let alive = true;
    setLoading(true);
    void getTaskConversation(task.id)
      .then((r) => {
        if (!alive) return;
        if (!r.ok) {
          // Transient failure — show the section with a retry note, no data.
          setCanSee(true);
          setConv([]);
          setNote(r.message ?? "Couldn't load the conversation — try again.");
          return;
        }
        setCanSee(!!r.canSeeConversation);
        setConv(r.conversation ?? null);
        setNote(r.note ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setCanSee(true);
        setConv([]);
        setNote("Couldn't load the conversation — try again.");
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, editorView, task.id]);

  // While open: lock page scroll, take focus, close on Escape, keep Tab inside
  // (the portal sits at the end of <body>, so an uncontained Tab would land on
  // the card's Complete button behind the scrim).
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, a[href], [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panelRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      triggerRef.current?.focus();
    };
  }, [open]);

  const cameIn = task.createdAt ? etDateTime(new Date(task.createdAt)) : null;
  // Legacy rows stored description = summary + "\n\n" + message; show only the
  // part that isn't already on screen as "What happened".
  const summaryTrim = task.summary?.trim();
  const descTrim = task.description?.trim();
  const message =
    descTrim && summaryTrim && descTrim.startsWith(summaryTrim)
      ? descTrim.slice(summaryTrim.length).trim()
      : descTrim;
  const showConversation = !editorView && (loading || canSee);

  const modal = open
    ? createPortal(
        <div className="fixed inset-0 z-[1500] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={task.title}>
          <button aria-label="Close" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/60" />
          <div
            ref={panelRef}
            tabIndex={-1}
            className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl outline-none sm:rounded-2xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <h2 className="break-words text-sm font-semibold leading-snug">{task.title}</h2>
                <p className="mt-0.5 text-[11px] text-muted-2">
                  {[task.contactName ?? task.clientName, task.propertyAddress?.split(",")[0], cameIn ? `came in ${cameIn}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground" aria-label="Close full view">
                <X className="size-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
              {summaryTrim && (
                <section>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">What happened</h3>
                  <p className="whitespace-pre-line break-words text-sm text-foreground/90">{summaryTrim}</p>
                </section>
              )}
              {message && message !== summaryTrim && (
                <section>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">The message</h3>
                  <p className="whitespace-pre-line break-words rounded-xl border border-border bg-surface-2/40 p-3 text-sm text-foreground/85">{message}</p>
                </section>
              )}
              {task.reasonCreated && (
                <p className="text-[11px] text-muted-2">Why this task exists: {task.reasonCreated}</p>
              )}

              {/* Original conversation — owner/admin only (comms can carry pricing). */}
              {showConversation && (
                <section>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Original conversation</h3>
                  {loading ? (
                    <p className="flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Pulling the thread…</p>
                  ) : conv && conv.length > 0 ? (
                    <ul className="space-y-2">
                      {conv.map((m, i) => {
                        const Icon = CHANNEL_ICON[m.channel] ?? MessageSquare;
                        return (
                          <li key={i} className={`rounded-xl border p-2.5 text-sm ${m.fromUs ? "border-brand/25 bg-brand/5" : "border-border bg-surface-2/40"}`}>
                            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-2">
                              <Icon className="size-3" />
                              <span className="font-medium text-muted">{m.fromUs ? "Us" : m.from}</span>
                              <span>· {etDateTime(new Date(m.date))}</span>
                            </div>
                            {m.subject && <p className="text-xs font-medium text-foreground/80">{m.subject}</p>}
                            <p className="whitespace-pre-line break-words text-foreground/85">{m.body}</p>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-2">{note ?? "No conversation on record."}</p>
                  )}
                  {note && conv && conv.length > 0 && <p className="mt-1.5 text-[11px] text-muted-2">{note}</p>}
                </section>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(true)}
        title="Open the full task — complete message + original conversation"
        className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
      >
        <Maximize2 className="size-3.5" /> Full view
      </button>
      {modal}
    </>
  );
}
