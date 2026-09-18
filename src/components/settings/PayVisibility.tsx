"use client";

import { useState, useTransition } from "react";
import { savePayVisibility } from "@/app/settings/actions";

// ---------------------------------------------------------------------------
// The switch, and — more importantly — the card that stops the office chasing
// a bug that isn't one.
//
// The photographer's screen is meant to read as a failure. This one must read
// as a decision: what is paused, who paused it, how long it has been that way,
// and exactly what they are seeing. Without it the first report lands on Kyle,
// he opens the page himself (it works — he is an admin), and somebody spends an
// afternoon on it.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const since = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
  const stamp = d.toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric" });
  return days === 0 ? `since today (${stamp})` : `for ${days} day${days === 1 ? "" : "s"} (since ${stamp})`;
};

export function PayVisibilitySettings({
  initial,
  isOwner,
}: {
  initial: { paused: boolean; pausedAtISO: string | null; pausedBy: string | null };
  isOwner: boolean;
}) {
  const [paused, setPaused] = useState(initial.paused);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        What a <b>photographer</b> login is shown about their own pay. Nothing behind it stops: payroll
        still works out every shoot, KPIs still score, bonuses still accrue, and Finance → Payroll and
        /payouts are untouched. You and Kyle always see the real numbers.
      </p>

      <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Pause My Pay for photographers</p>
          <p className="text-[13px] text-muted">
            While this is on they see the ordinary “This page hit a problem” screen on My Pay, and the
            pay card is gone from their shoot screens. It is deliberately indistinguishable from a bad
            day — so nobody but you will know it is off, including Kyle.
          </p>
          {paused && initial.paused && (
            <p className="mt-1.5 text-[13px] font-medium text-warning">
              Paused {since(initial.pausedAtISO) ?? "now"}
              {initial.pausedBy ? ` · ${initial.pausedBy}` : ""}.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={paused}
          aria-label="Pause My Pay for photographers"
          disabled={busy || !isOwner}
          onClick={() =>
            start(async () => {
              const next = !paused;
              const res = await savePayVisibility(next).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
              if (res.ok) setPaused(next);
              setMsg(res.message);
            })
          }
          className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${paused ? "bg-warning" : "bg-surface-2 border border-border"}`}
        >
          <span className={`block size-5 rounded-full bg-white shadow transition-transform ${paused ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </div>

      {!isOwner && <p className="text-[13px] text-muted-2">Only Jordan can change this one.</p>}
      {msg && <p className="text-[13px] text-foreground/85">{msg}</p>}

      {paused && (
        <p className="rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2 text-[13px] leading-relaxed text-foreground/85">
          Worth knowing while it is on: their own KPI scorecard lives on that page too, so it is dark
          as well — and if one of them reports the “error”, Kyle will not be able to reproduce it.
        </p>
      )}
    </div>
  );
}
