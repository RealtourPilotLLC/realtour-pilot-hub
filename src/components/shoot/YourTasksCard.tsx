"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ClipboardList, Loader2, MapPin, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { setSmartTaskStatus } from "@/app/actions";
import type { PhotographerTaskRow } from "@/lib/shoot";

// "Your tasks": the photographer's own open task rows on My Shoots (mention
// pings, callbacks, work moved onto their plate). Rows arrive already
// creative-safe from listPhotographerTasks (money-scrubbed, no description /
// sourceDetail), so this card only renders and completes: the Done button
// reuses setSmartTaskStatus, whose requireTaskAccess admits the assignee.
// Mobile-first: it lives above the calendar on a phone in the field.

// A mention task embeds its note deep-link in the summary ("Open the note:
// /shoot/note/<id>") — surface it as a real link and keep the prose clean.
const NOTE_LINK = /\s*(?:Open the note:\s*)?(\/shoot\/note\/[A-Za-z0-9_-]+)/;

export function YourTasksCard({ tasks, readOnly }: {
  tasks: PhotographerTaskRow[];
  /** Owner/admin "view as" previews are look-don't-touch — hide the done button. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  // Optimistic strikethrough: done ids render struck immediately; the refresh
  // behind the action drops the row from the server payload for real.
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  // Why a Done didn't take (a brand confirmation still waiting on editors, a
  // delivery card that moved): said under that row, never silently struck.
  const [said, setSaid] = useState<Record<string, string>>({});
  const [, start] = useTransition();
  // EVERY hook runs before the empty-list return below. A photographer whose
  // last task closes goes 1 row -> 0 rows inside one mount, and a hook placed
  // after that return changes the hook count between renders, which React
  // throws on (audit, Sep 17). Hooks first, then the early exit. The overdue
  // clock that used to live here as a Date.now() memo now arrives on the row
  // from the server, which is the only place in the hub that reads the time.
  if (tasks.length === 0) return null;

  const complete = (id: string) => {
    setDone((s) => new Set(s).add(id));
    setBusyId(id);
    setSaid((m) => { const n = { ...m }; delete n[id]; return n; });
    const undo = (why: string) => {
      setDone((s) => { const n = new Set(s); n.delete(id); return n; });
      setSaid((m) => ({ ...m, [id]: why }));
    };
    start(async () => {
      try {
        const r = await setSmartTaskStatus(id, "COMPLETED");
        if (r && !r.ok) undo(r.message);
        else router.refresh();
      } catch {
        // The guard said no (or the network dropped): un-strike the row.
        undo("That didn't save. Try again.");
      } finally {
        setBusyId(null);
      }
    });
  };

  return (
    <div className="rounded-2xl border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ClipboardList className="size-4 text-brand" /> Your tasks
        <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{tasks.length}</span>
      </h2>
      <ul className="mt-2.5 space-y-2.5">
        {tasks.map((t) => {
          const isDone = done.has(t.id);
          const overdue = t.overdue;
          const noteHref = t.summary?.match(NOTE_LINK)?.[1] ?? null;
          const summaryText = noteHref ? (t.summary ?? "").replace(NOTE_LINK, "").trim() : t.summary;
          return (
            <li key={t.id} className="flex items-start gap-2.5" data-your-task={t.id}>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium leading-snug", isDone && "text-muted line-through")}>
                  {t.title}
                </p>
                {summaryText && (
                  <p className={cn("mt-0.5 line-clamp-2 text-xs leading-snug text-muted", isDone && "line-through")}>
                    {summaryText}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                  {t.dueAtISO && (
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5",
                        overdue && !isDone ? "bg-danger/10 text-danger" : "bg-surface-2 text-muted",
                      )}
                    >
                      Due {etDateTime(t.dueAtISO)}
                    </span>
                  )}
                  {t.street && t.projectId && (
                    <Link
                      href={`/shoot/${t.projectId}`}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-muted hover:text-foreground"
                    >
                      <MapPin className="size-3" /> {t.street}
                    </Link>
                  )}
                  {t.street && !t.projectId && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-muted">
                      <MapPin className="size-3" /> {t.street}
                    </span>
                  )}
                  {noteHref && (
                    <Link
                      href={noteHref}
                      className="inline-flex items-center gap-1 text-brand hover:underline"
                    >
                      <MessageSquare className="size-3" /> Open the note
                    </Link>
                  )}
                </div>
                {said[t.id] && <p role="status" className="mt-1 text-xs text-danger" data-task-said>{said[t.id]}</p>}
              </div>
              {/* A REAL DONE BUTTON (Jordan, Oct 28 2026: "make sure every task and
                  assignment has an actionable button"). It was a 20px empty
                  circle a thumb in the field could miss: now a labelled 44px
                  button on the right. */}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => complete(t.id)}
                  disabled={isDone}
                  aria-label={`Mark “${t.title}” done`}
                  data-task-done={t.id}
                  className={cn(
                    "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border px-3 text-sm font-medium transition-colors",
                    isDone
                      ? "border-success-action bg-success-action text-white"
                      : "border-border text-foreground hover:border-success hover:text-success",
                  )}
                >
                  {busyId === t.id ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />}
                  Done
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
