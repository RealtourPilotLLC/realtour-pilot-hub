"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ClipboardList, Loader2, MapPin, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { setSmartTaskStatus } from "@/app/actions";
import type { PhotographerTaskRow } from "@/lib/shoot";

// "Your tasks" — the photographer's own open task rows on My Shoots (mention
// pings, callbacks, work moved onto their plate). Rows arrive already
// creative-safe from listPhotographerTasks (money-scrubbed, no description /
// sourceDetail), so this card only renders and completes — the check button
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
  const [, start] = useTransition();

  if (tasks.length === 0) return null;

  const complete = (id: string) => {
    setDone((s) => new Set(s).add(id));
    setBusyId(id);
    start(async () => {
      try {
        await setSmartTaskStatus(id, "COMPLETED");
        router.refresh();
      } catch {
        // The guard said no (or the network dropped) — un-strike the row.
        setDone((s) => { const n = new Set(s); n.delete(id); return n; });
      } finally {
        setBusyId(null);
      }
    });
  };

  // Stable per mount — the overdue tint doesn't need to tick live, and an
  // impure Date.now() in render trips the React-compiler purity rule.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), []);

  return (
    <div className="rounded-2xl border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ClipboardList className="size-4 text-brand" /> Your tasks
        <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{tasks.length}</span>
      </h2>
      <ul className="mt-2.5 space-y-2.5">
        {tasks.map((t) => {
          const isDone = done.has(t.id);
          const overdue = t.dueAtISO != null && new Date(t.dueAtISO).getTime() < now;
          const noteHref = t.summary?.match(NOTE_LINK)?.[1] ?? null;
          const summaryText = noteHref ? (t.summary ?? "").replace(NOTE_LINK, "").trim() : t.summary;
          return (
            <li key={t.id} className="flex items-start gap-2.5">
              {!readOnly && (
                <button
                  onClick={() => complete(t.id)}
                  disabled={isDone}
                  aria-label={`Mark “${t.title}” done`}
                  title="Mark done"
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isDone
                      ? "border-success bg-success text-white"
                      : "border-border text-transparent hover:border-success hover:text-success",
                  )}
                >
                  {busyId === t.id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                </button>
              )}
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
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
