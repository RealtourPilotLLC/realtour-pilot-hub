"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDayKey, etMonthDay, etTime } from "@/lib/datetime";
import { confirmCurrentWorkAction, pauseEditingAction } from "@/app/editing/workActions";
import type { UnconfirmedClaim } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// THE EDITOR'S OWN DESK, above their queue (§7.1).
//
//   · "You're working on 12 Oak St since 10:02am · Pause" — what they told the
//     hub, with the one button that ends it.
//   · Once, for the jobs the old pill left on "In editing": "Which one are you
//     on right now?" Nothing was backfilled and no start time was invented —
//     the hub cannot know which of three claimed jobs is the real one, so it
//     asks the only person who does. Their answer starts that one and marks
//     the rest paused; "None of them" pauses them all.
// ---------------------------------------------------------------------------

const clock = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const t = etTime(d).replace(/\s?([AP])M$/i, (_m, x: string) => `${x.toLowerCase()}m`);
  return etDayKey(d) === etDayKey(new Date()) ? t : `${etMonthDay(d)} ${t}`;
};
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function EditorDesk({
  active,
  unconfirmed,
}: {
  active: { projectId: string; street: string; sinceISO: string | null; outputTitle: string | null } | null;
  unconfirmed: UnconfirmedClaim[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inflight = useRef<{ what: string; id: string } | null>(null);

  const run = (what: string, fn: (requestId: string) => Promise<{ ok: boolean; message: string }>) => {
    // The same click retried reuses its id; a different click gets a new one.
    const id = inflight.current?.what === what ? inflight.current.id : newId();
    inflight.current = { what, id };
    setMsg(null);
    start(async () => {
      try {
        const r = await fn(id);
        inflight.current = null;
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setMsg({ ok: false, text: "That didn't reach the hub — press it again to retry (it won't be logged twice)." });
      }
    });
  };

  if (!active && unconfirmed.length === 0 && !msg) return null;
  const btn = "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50";

  return (
    <div className="space-y-3">
      {active && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-[#8b5cf6]/40 bg-[#8b5cf6]/10 px-4 py-3">
          <span className="size-2 shrink-0 rounded-full bg-[#8b5cf6]" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            You&rsquo;re working on{" "}
            <Link href={`/edit/${active.projectId}`} className="font-semibold underline-offset-2 hover:underline">
              {active.street}
            </Link>
            {active.outputTitle ? ` · ${active.outputTitle}` : ""}
            {active.sinceISO ? <span className="text-muted"> since {clock(active.sinceISO)}</span> : null}
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(`pause:${active.projectId}`, (requestId) => pauseEditingAction({ projectId: active.projectId, requestId }))}
            className={cn(btn, "border border-border bg-surface text-foreground hover:bg-surface-2")}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
            Pause
          </button>
        </div>
      )}

      {unconfirmed.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning-soft/40 px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Which one are you on right now?</p>
          <p className="mt-0.5 text-xs text-muted">
            {unconfirmed.length === 1 ? "This job is" : `These ${unconfirmed.length} jobs are`} marked &ldquo;In editing&rdquo; from before the
            Start button, and nobody has pressed Start on {unconfirmed.length === 1 ? "it" : "them"} since — so the hub can&rsquo;t tell which one
            you&rsquo;re actually cutting. Pick it once — the rest are marked paused, and nothing else about them changes.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {unconfirmed.map((c) => (
              <button
                key={c.projectId}
                type="button"
                disabled={pending}
                onClick={() => run(`confirm:${c.projectId}`, (requestId) => confirmCurrentWorkAction({ projectId: c.projectId, requestId }))}
                className={cn(btn, "border border-border bg-surface text-foreground hover:bg-surface-2")}
                title={c.claimedAt ? `Set to In editing ${clock(c.claimedAt)}` : "Set to In editing — when isn't on record"}
              >
                <Play className="size-3.5 text-[#8b5cf6]" />
                {c.street}
                <span className="font-normal text-muted-2">{c.claimedAt ? `claimed ${clock(c.claimedAt)}` : "claimed — date not on record"}</span>
              </button>
            ))}
            <button
              type="button"
              disabled={pending}
              onClick={() => run("confirm:none", (requestId) => confirmCurrentWorkAction({ projectId: null, requestId }))}
              className={cn(btn, "text-muted hover:text-foreground")}
            >
              None of them
            </button>
            {pending && <Loader2 className="size-4 animate-spin self-center text-muted" />}
          </div>
        </div>
      )}

      {msg && (
        <p className={cn("text-xs", msg.ok ? "text-success" : "text-warning")} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
