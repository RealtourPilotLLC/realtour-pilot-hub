"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Undo2, Loader2, ChevronDown, X } from "lucide-react";
import { restoreOwnerTodo } from "@/app/day/actions";

// WHAT YOU FINISHED — and the way back out of it.
//
// The one-tap checkbox is the most-used control on the page, which makes a
// mis-tap inevitable. If the only way to recover is to retype the to-do, people
// stop trusting the checkbox and stop ticking things off. So: everything closed
// in the last two months stays here, and one tap puts it back.

export type FinishedRow = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  doneAt: Date | null;
  energy: string;
  estimateMin: number;
  project: { id: string; title: string } | null;
  client: { id: string; name: string } | null;
};

const dayLabel = (d: Date | null) => {
  if (!d) return "";
  const key = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const today = key(new Date());
  const yest = key(new Date(Date.now() - 86_400_000));
  const k = key(d);
  if (k === today) return "Today";
  if (k === yest) return "Yesterday";
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
};

function Row({ t }: { t: FinishedRow }) {
  const [busy, start] = useTransition();
  const dropped = t.status === "DROPPED";

  return (
    <div className={`group flex items-start gap-2.5 px-3 py-2 ${busy ? "opacity-50" : ""}`}>
      {dropped ? (
        <X className="mt-0.5 size-4 shrink-0 text-muted-2" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm text-muted line-through decoration-border">{t.title}</span>
          {dropped && <span className="text-[10px] uppercase tracking-wide text-muted-2">dropped</span>}
        </div>
        <div className="text-[11px] text-muted-2">
          {dayLabel(t.doneAt)}
          {t.project && (
            <>
              {" · "}
              <Link href={`/projects/${t.project.id}`} className="hover:underline">
                {t.project.title.split(",")[0]}
              </Link>
            </>
          )}
          {t.client && (
            <>
              {" · "}
              <Link href={`/clients/${t.client.id}`} className="hover:underline">
                {t.client.name}
              </Link>
            </>
          )}
        </div>
      </div>
      <button
        onClick={() => start(async () => { await restoreOwnerTodo(t.id); })}
        disabled={busy}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted opacity-0 transition hover:border-brand hover:text-brand group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
        title="Put it back on the list"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
        Put it back
      </button>
    </div>
  );
}

export function FinishedList({ rows }: { rows: FinishedRow[] }) {
  // Collapsed by default: this is a safety net, not a thing to read every day.
  const [open, setOpen] = useState(false);
  const done = rows.filter((r) => r.status !== "DROPPED").length;

  if (rows.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-center gap-1.5 py-1 text-[11px] text-muted-2 hover:text-foreground"
      >
        <CheckCircle2 className="size-3.5 text-success" />
        {done} finished
        {rows.length > done ? `, ${rows.length - done} dropped` : ""} in the last 60 days
        <ChevronDown className={`size-3 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-1 divide-y divide-border/60 rounded-xl border border-border bg-surface">
          {rows.map((t) => (
            <Row key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
