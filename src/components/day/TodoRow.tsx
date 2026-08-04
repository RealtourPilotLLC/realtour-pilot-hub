"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Check, CalendarPlus, CalendarMinus, Brain, X, Loader2 } from "lucide-react";
import { completeOwnerTodo, planOwnerTodo, dropOwnerTodo } from "@/app/day/actions";

export type TodoRowData = {
  id: string;
  title: string;
  notes: string | null;
  priority: string;
  energy: string;
  estimateMin: number;
  dueAt: Date | null;
  plannedFor: string | null;
  project: { id: string; title: string } | null;
  client: { id: string; name: string } | null;
  sourceNote: string | null;
};

const dueLabel = (d: Date | null) =>
  d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;

export function TodoRow({ t, todayKey, overdue }: { t: TodoRowData; todayKey: string; overdue?: boolean }) {
  const [pending, start] = useTransition();
  const onToday = t.plannedFor === todayKey;

  return (
    <div className={`group flex items-start gap-2.5 px-3 py-2 ${pending ? "opacity-50" : ""}`}>
      {/* One tap to finish — the most-used control, so it is the biggest target. */}
      <button
        onClick={() => start(async () => { await completeOwnerTodo(t.id); })}
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border border-border text-transparent transition hover:border-success hover:text-success"
        title="Done"
      >
        {pending ? <Loader2 className="size-3 animate-spin text-muted" /> : <Check className="size-3.5" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm">{t.title}</span>
          {t.energy === "DEEP" && (
            <span className="inline-flex items-center gap-0.5 rounded bg-brand/12 px-1 text-[10px] font-medium text-brand">
              <Brain className="size-2.5" /> deep
            </span>
          )}
          <span className="text-[10px] text-muted-2">{t.estimateMin < 60 ? `${t.estimateMin}m` : `${t.estimateMin / 60}h`}</span>
          {t.dueAt && (
            <span className={`text-[10px] ${overdue ? "font-semibold text-danger" : "text-muted-2"}`}>
              due {dueLabel(t.dueAt)}
            </span>
          )}
        </div>
        {t.notes && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-2">{t.notes}</p>}
        {(t.project || t.client) && (
          <div className="mt-0.5 text-[11px] text-muted-2">
            {t.project && (
              <Link href={`/projects/${t.project.id}`} className="hover:underline">
                {t.project.title.split(",")[0]}
              </Link>
            )}
            {t.project && t.client && " · "}
            {t.client && (
              <Link href={`/clients/${t.client.id}`} className="hover:underline">
                {t.client.name}
              </Link>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        <button
          onClick={() => start(async () => { await planOwnerTodo(t.id, onToday ? null : todayKey); })}
          className="rounded p-1 text-muted-2 hover:bg-surface-2 hover:text-foreground"
          title={onToday ? "Take it out of today" : "Put it in today"}
        >
          {onToday ? <CalendarMinus className="size-3.5" /> : <CalendarPlus className="size-3.5" />}
        </button>
        <button
          onClick={() => start(async () => { await dropOwnerTodo(t.id); })}
          className="rounded p-1 text-muted-2 hover:bg-surface-2 hover:text-danger"
          title="Not doing this"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
