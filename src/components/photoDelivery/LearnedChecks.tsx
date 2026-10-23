"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { undoLessonAction } from "@/app/ops/photo-delivery/actions";

// ---------------------------------------------------------------------------
// WHAT THE CHECK HAS LEARNED (Oct 23 2026, Jordan and Kyle's huddle, item 5),
// owner only, on Photo Delivery settings. Each lesson: the check, what the
// office wrote when setting it aside (and how often, on how many jobs), what
// it changes, a photo or two it came from, and Undo. Lessons on checks Jordan
// always wants flagged (trash cans, cars on the driveway, lines, edit
// mistakes) are listed as "Not applied" (houseRules.learnedChecks).
// ---------------------------------------------------------------------------

export type LessonView = {
  key: string;
  label: string;
  reason: string;
  count: number;
  jobs: number;
  changes: string;
  active: boolean;
  alwaysFlagged: boolean;
  undone: string | null;
  examples: { href: string; label: string }[];
};

export function LearnedChecks({ lessons }: { lessons: LessonView[] }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!lessons.length) {
    return <p className="text-sm text-muted">Nothing learned yet. When the same reason is given 3 times on 2 different jobs, the check learns it here.</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-xl border border-border">
        {lessons.map((l) => (
          <li key={l.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5" data-lesson={l.key} data-lesson-active={l.active ? "yes" : "no"}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{l.label}</p>
              <p className="text-[13px]">
                &ldquo;{l.reason}&rdquo; <span className="text-muted">· {l.count} time{l.count === 1 ? "" : "s"} on {l.jobs} job{l.jobs === 1 ? "" : "s"}</span>
              </p>
              <p className={cn("text-[13px]", l.active ? "text-success" : "text-muted")}>{l.changes}{l.undone ? ` · ${l.undone}` : ""}</p>
              {l.examples.length > 0 && (
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-[12px]">
                  {l.examples.map((e) => (
                    <Link key={e.href} href={e.href} className="text-brand hover:underline">{e.label}</Link>
                  ))}
                </p>
              )}
            </div>
            {l.active && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setBusy(l.key);
                  start(async () => {
                    const r = await undoLessonAction(l.key).catch(() => ({ ok: false, message: "The hub didn't answer. Reload and try again." }));
                    setMsg({ ok: r.ok, text: r.message });
                    setBusy(null);
                  });
                }}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50"
              >
                {busy === l.key ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Undo2 aria-hidden className="size-3.5" />} Undo
              </button>
            )}
          </li>
        ))}
      </ul>
      {msg && <p role="status" className={msg.ok ? "text-[13px] text-success" : "text-[13px] text-danger"}>{msg.text}</p>}
    </div>
  );
}
