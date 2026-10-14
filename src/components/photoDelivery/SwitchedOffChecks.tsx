"use client";

import { useState, useTransition } from "react";
import { Eye, Loader2 } from "lucide-react";
import { resumeCheckAction } from "@/app/ops/photo-delivery/actions";

// ---------------------------------------------------------------------------
// Checks the owner switched off for every shoot (Oct 14 2026, houseRules.ts):
// what, why, who and when, and a way to check it again.
// ---------------------------------------------------------------------------

export type SwitchedOffView = { ruleId: string; label: string; reason: string; by: string; when: string };

export function SwitchedOffChecks({ rules }: { rules: SwitchedOffView[] }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!rules.length) return <p className="text-sm text-muted">Every check is on. Use “Stop flagging this” on an issue to switch one off for every shoot.</p>;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-xl border border-border">
        {rules.map((r) => (
          <li key={r.ruleId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{r.label}</p>
              <p className="text-[13px] text-muted">{r.reason} · {r.by}, {r.when}</p>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setBusy(r.ruleId);
                start(async () => {
                  const res = await resumeCheckAction(r.ruleId).catch(() => ({ ok: false, message: "The hub didn't answer. Reload and try again." }));
                  setMsg({ ok: res.ok, text: res.message });
                  setBusy(null);
                });
              }}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              {busy === r.ruleId ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Eye aria-hidden className="size-3.5" />} Check again
            </button>
          </li>
        ))}
      </ul>
      {msg && <p role="status" className={msg.ok ? "text-[13px] text-success" : "text-[13px] text-danger"}>{msg.text}</p>}
    </div>
  );
}
