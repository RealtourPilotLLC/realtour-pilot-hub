"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { setMonthPlanningAction, type MonthPlanningChoice } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// "Planning: strategy call / client picks topics / we planned it" (Oct 12
// 2026). Jordan: Arielle would rather pick topics than book a call. When a
// client tells us how they want a month planned, the office records it here.
// It writes what the portal's own choice writes (choosePlanningMode); the
// action refuses a switch that would orphan work (a held call, a booking)
// with the plain reason. Owner/admin only.
// ---------------------------------------------------------------------------

const OPTIONS: { key: MonthPlanningChoice; label: string }[] = [
  { key: "CALL", label: "Strategy call" },
  { key: "TOPICS", label: "Client picks topics" },
  { key: "OFFICE", label: "We planned it" },
];

export function MonthPlanningControl({ monthId, current }: { monthId: string; current: MonthPlanningChoice | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [shown, setShown] = useState<MonthPlanningChoice | null>(current);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const choose = (k: MonthPlanningChoice) => {
    if (k === shown) return;
    const before = shown;
    setShown(k); setMsg(null);
    start(async () => {
      try {
        const r = await setMonthPlanningAction(monthId, k);
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh(); else setShown(before);
      } catch { setShown(before); setMsg({ ok: false, text: "That wasn't saved. Reload and try again." }); }
    });
  };
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="How this month is planned">
        <span className="text-[12px] text-muted-2">Planning:</span>
        {OPTIONS.map((o) => (
          <button key={o.key} type="button" aria-pressed={shown === o.key} disabled={busy} onClick={() => choose(o.key)}
            className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-2.5 py-1 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60 ${shown === o.key ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-2 hover:text-foreground"}`}>
            {busy && shown === o.key && <Loader2 className="size-3 animate-spin" aria-hidden />}{o.label}
          </button>
        ))}
        {!shown && <span className="text-[12px] text-muted-2">not chosen yet</span>}
      </div>
      {msg && <p role="status" className={`mt-1 text-[12px] ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </div>
  );
}
