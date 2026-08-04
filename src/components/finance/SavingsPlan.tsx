"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PiggyBank, ChevronDown, Check, X, RotateCcw, Loader2 } from "lucide-react";
import { setSavingsStatusAction } from "@/app/sales/savingsActions";

export type SavingsItemView = {
  id: string; rank: number; title: string; detail: string | null;
  savesPerMonth: number; tier: string; status: string;
};

const m0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const TIER_LABEL: Record<string, string> = {
  instant: "do now", setting: "one setting", habit: "habit", decision: "your call",
};
const TIER_CLS: Record<string, string> = {
  instant: "bg-success/15 text-success", setting: "bg-[#6ba3d6]/15 text-[#6ba3d6]",
  habit: "bg-warning/15 text-warning", decision: "bg-[#b389d6]/15 text-[#b389d6]",
};

// The $5k/month savings plan as a living checklist — tick items off, watch the
// reclaimed monthly total climb. Items came from the verified cost audit.
export function SavingsPlan({ items }: { items: SavingsItemView[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const active = items.filter((i) => i.status !== "SKIPPED");
  const done = active.filter((i) => i.status === "DONE");
  const reclaimed = done.reduce((s, i) => s + i.savesPerMonth, 0);
  const potential = active.reduce((s, i) => s + i.savesPerMonth, 0);
  const target = 5000;
  const pct = Math.min(100, (reclaimed / target) * 100);
  const remaining = items.filter((i) => i.status === "PENDING").length;

  const set = (id: string, status: "PENDING" | "DONE" | "SKIPPED") =>
    start(async () => { await setSavingsStatusAction(id, status); router.refresh(); });

  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <PiggyBank className="size-4 text-brand" /> Savings plan
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">{remaining} to go</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold tabular-nums text-success">{m0(reclaimed)}/mo reclaimed</span>
          <ChevronDown className={`size-4 text-muted-2 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-2">
        Goal: {m0(target)}/mo · menu holds {m0(potential)}/mo. Tick items as you do them — this is your scoreboard.
      </p>

      {open && (
        <div className="mt-3 divide-y divide-border/60">
          {items.map((i) => (
            <div key={i.id} className={`flex items-start gap-3 py-2.5 ${i.status === "SKIPPED" ? "opacity-45" : ""}`}>
              <button
                disabled={pending}
                onClick={() => set(i.id, i.status === "DONE" ? "PENDING" : "DONE")}
                className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border ${i.status === "DONE" ? "border-success bg-success text-white" : "border-border bg-surface-2 hover:border-success"}`}
                title={i.status === "DONE" ? "Mark not done" : "Mark done"}
              >
                {i.status === "DONE" && <Check className="size-3.5" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-sm font-medium ${i.status === "DONE" ? "text-muted line-through" : ""}`}>{i.title}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TIER_CLS[i.tier] ?? "bg-surface-2 text-muted"}`}>{TIER_LABEL[i.tier] ?? i.tier}</span>
                </div>
                {i.detail && <p className="mt-0.5 text-[11px] text-muted-2">{i.detail}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm font-semibold tabular-nums">{i.savesPerMonth > 0 ? `${m0(i.savesPerMonth)}/mo` : "—"}</span>
                {i.status !== "SKIPPED" ? (
                  <button disabled={pending} onClick={() => set(i.id, "SKIPPED")} title="Skip — not doing this one" className="text-muted-2 hover:text-danger"><X className="size-3.5" /></button>
                ) : (
                  <button disabled={pending} onClick={() => set(i.id, "PENDING")} title="Un-skip" className="text-muted-2 hover:text-foreground"><RotateCcw className="size-3.5" /></button>
                )}
              </div>
            </div>
          ))}
          {pending && <div className="flex items-center gap-2 py-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> saving…</div>}
        </div>
      )}
    </section>
  );
}
