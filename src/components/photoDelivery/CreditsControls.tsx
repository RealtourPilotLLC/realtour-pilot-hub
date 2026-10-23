"use client";

import { useState, useTransition } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { checkBalanceAction, saveThresholdsAction, type ActionResult } from "@/app/ops/photo-delivery/actions";

// ---------------------------------------------------------------------------
// Credits page controls (plan 10.2, 10.4):
//   · "Check balance now" (owner or admin): one free read of AutoHDR's
//     balance, the ledger reconciled, the alert rules run (never buys);
//   · the owner-only thresholds form: warn, critical, the reset buffer that
//     stops a small refund from re-alerting, and dollars per credit.
// ---------------------------------------------------------------------------

function useRun() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      try {
        const r = await fn();
        setMsg({ ok: r.ok, text: r.message });
      } catch {
        setMsg({ ok: false, text: "The hub didn't answer. Reload the page to see the current balance." });
      }
    });
  return { pending, msg, run };
}

export function CheckBalanceButton({ connected }: { connected: boolean }) {
  const { pending, msg, run } = useRun();
  return (
    <div>
      <button
        type="button"
        disabled={pending || !connected}
        title={connected ? "Read the balance from AutoHDR now (free)" : "Connect the AutoHDR API first"}
        onClick={() => run(() => checkBalanceAction())}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 text-sm font-semibold hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden className="size-4" />} Check balance now
      </button>
      <p role="status" className={`mt-1 min-h-5 text-[13px] ${msg ? (msg.ok ? "text-success" : "text-warning") : ""}`}>{msg?.text ?? ""}</p>
    </div>
  );
}

const field = "min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-brand";

export function ThresholdsForm({ initial }: { initial: { warn: number; critical: number; resetBuffer: number; usdPerCredit: number; planCreditsPerMonth?: number | null } }) {
  const { pending, msg, run } = useRun();
  const [v, setV] = useState({ warn: String(initial.warn), critical: String(initial.critical), resetBuffer: String(initial.resetBuffer), usdPerCredit: String(initial.usdPerCredit), plan: initial.planCreditsPerMonth != null ? String(initial.planCreditsPerMonth) : "" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveThresholdsAction({ warn: Number(v.warn), critical: Number(v.critical), resetBuffer: Number(v.resetBuffer), usdPerCredit: Number(v.usdPerCredit), planCreditsPerMonth: v.plan.trim() ? Number(v.plan) : null }));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Warning below</span>
          <input type="number" inputMode="numeric" min={1} step={1} required value={v.warn} onChange={set("warn")} className={field} />
          <span className="mt-0.5 block text-[12px] text-muted">Amber chip, and one alert to Jordan and Kyle.</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Critical below</span>
          <input type="number" inputMode="numeric" min={1} step={1} required value={v.critical} onChange={set("critical")} className={field} />
          <span className="mt-0.5 block text-[12px] text-muted">Red chip, a banner on every page, and an alert that ignores quiet hours.</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Reset buffer</span>
          <input type="number" inputMode="numeric" min={1} step={1} required value={v.resetBuffer} onChange={set("resetBuffer")} className={field} />
          <span className="mt-0.5 block text-[12px] text-muted">Alerts re-arm only once the balance is this far above a level, so a small refund never re-alerts.</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Dollars per credit</span>
          <input type="number" inputMode="decimal" min={0.0001} step="0.0001" required value={v.usdPerCredit} onChange={set("usdPerCredit")} className={field} />
          <span className="mt-0.5 block text-[12px] text-muted">For the dollar estimates only you see (the Pro plan rate).</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Plan credits a month</span>
          <input type="number" inputMode="numeric" min={1} step={1} value={v.plan} onChange={set("plan")} placeholder="2000" className={field} />
          <span className="mt-0.5 block text-[12px] text-muted">The AutoHDR plan&rsquo;s monthly allowance, shown on this page. It does not change the fix budget (Settings).</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:opacity-50">
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden className="size-4" />} Save thresholds
        </button>
        <p role="status" className={`text-[13px] ${msg ? (msg.ok ? "text-success" : "text-warning") : ""}`}>{msg?.text ?? ""}</p>
      </div>
    </form>
  );
}
