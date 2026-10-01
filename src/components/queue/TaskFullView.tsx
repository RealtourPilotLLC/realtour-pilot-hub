"use client";

import { useEffect, useState } from "react";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { CheckSquare, Loader2, Mail, Maximize2, MessageSquare, Phone, Hash, Square, X } from "lucide-react";
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

  useEffect(() => {
    if (!open || editorView) return;
    let alive = true;
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
    ? (
        <ModalDialog label={`Source context: ${task.title}`} onCancel={() => setOpen(false)} className="max-h-[90dvh] w-[min(96vw,48rem)] p-0 sm:p-0">
          <div className="flex max-h-[88dvh] flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <h2 className="break-words text-sm font-semibold leading-snug">{task.title}</h2>
                <p className="mt-0.5 text-[11px] text-muted-2">
                  {[task.contactName ?? task.clientName, task.propertyAddress?.split(",")[0], cameIn ? `came in ${cameIn}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button type="button" data-modal-initial-focus onClick={() => setOpen(false)} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand" aria-label="Close full view">
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
              {/* The task's checklist — read-only here (ticking lives on the card;
                  this modal is purely a reading surface). */}
              {task.deliverables.length > 0 && (
                <section>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Steps</h3>
                  <ul className="space-y-1">
                    {task.deliverables.map((d, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-foreground/85">
                        {d.done ? (
                          <CheckSquare className="mt-0.5 size-4 shrink-0 text-success" />
                        ) : (
                          <Square className="mt-0.5 size-4 shrink-0 text-muted-2" />
                        )}
                        <span className={d.done ? "text-muted line-through decoration-muted-2/60" : ""}>{d.label}</span>
                      </li>
                    ))}
                  </ul>
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
        </ModalDialog>
      )
    : null;

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => { setLoading(!editorView); setOpen(true); }}
        title="Open the full task — complete message + original conversation"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
      >
        <Maximize2 className="size-3.5" /> Full view
      </button>
      {modal}
    </>
  );
}
