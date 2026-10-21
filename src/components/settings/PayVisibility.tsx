"use client";

import { useState, useTransition } from "react";
import { savePayVisibility } from "@/app/settings/actions";

// ---------------------------------------------------------------------------
// The switch, and the card that says exactly what it does: who is paused,
// since when, and what they see instead.
//
// Oct 20 2026 (audit G7): the copy still described the Sep 18 version (a fake
// "page hit a problem" screen, photographers only, "you and Kyle see the real
// numbers"). Since Oct 14 the switch covers every login but the owner, those
// logins get My Performance, and nobody but the owner sees money. Reading the
// old words, turning it off looked like "bring back the scorecard", when it
// actually re-shows dollar pay to Harrison and James.
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
        My Pay or My Performance, for <b>every login but you</b> (Harrison and James included). Nothing
        behind it stops: payroll still works out every shoot, KPIs still score, bonuses still accrue, and
        Finance → Payroll is untouched. Only you ever see the team&rsquo;s dollar figures.
      </p>

      <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Hide pay from everyone but you</p>
          <p className="text-[13px] text-muted">
            While this is on, My Pay becomes My Performance for them: their quarterly scorecard and the
            bonus it is tracking toward, with no shoot pay or mileage. The pay card is also gone from their
            shoot screens. Turning it off shows each of them their own dollar pay again.
          </p>
          {paused && initial.paused && (
            <p className="mt-1.5 text-[13px] font-medium text-warning">
              Hidden {since(initial.pausedAtISO) ?? "now"}
              {initial.pausedBy ? ` · ${initial.pausedBy}` : ""}.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={paused}
          aria-label="Hide pay from everyone but you"
          disabled={busy || !isOwner}
          onClick={() =>
            start(async () => {
              const next = !paused;
              const res = await savePayVisibility(next).catch(() => ({ ok: false, message: "Couldn’t save. Try again." }));
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

      {!paused && (
        <p className="rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2 text-[13px] leading-relaxed text-foreground/85">
          Pay is showing: every login with a My Pay page sees their own shoot pay and mileage, and the
          pay card is back on their shoot screens.
        </p>
      )}
    </div>
  );
}
