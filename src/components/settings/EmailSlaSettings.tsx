"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { loadEmailSla, saveEmailSla } from "@/components/settings/emailSla.actions";
import type { EmailSlaRules } from "@/lib/commsSla";
import { cn } from "@/lib/utils";

// Unanswered client email (O06, Sep 26 2026) — Jordan: "bell only, counting
// covered hours only; Kyle's bell after 4, mine after 9; an unhappy client at
// 4; never nights or weekends." Sits inside the Internal alerts card, under
// Coverage, because the coverage window is the clock it counts on. It loads and
// saves on its own (the house rule on this page: one bad edit can't take the
// rest with it).

function Hours({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        aria-label={label}
        inputMode="decimal"
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^\d.]/g, ""));
          if (!Number.isNaN(n)) onChange(Math.min(45, Math.max(1, n)));
        }}
        className="w-16 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand"
      />
      <span className="text-xs text-muted">covered hours</span>
    </span>
  );
}

export function EmailSlaSettings() {
  const [r, setR] = useState<EmailSlaRules | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    loadEmailSla()
      .then((d) => { setR(d.rules); setSince(d.since); })
      .catch(() => setFailed(true));
  }, []);
  const set = (patch: Partial<EmailSlaRules>) => { setR((p) => (p ? { ...p, ...patch } : p)); setMsg(null); };

  if (failed) return <p className="rounded-lg border border-border p-3 text-[13px] text-muted">The email reply alert settings could not be read just now — reload to try again.</p>;
  if (!r) return <p className="rounded-lg border border-border p-3 text-[13px] text-muted"><Loader2 className="mr-1.5 inline size-3.5 animate-spin" />Loading email reply alerts…</p>;

  const sinceWords = since
    ? new Date(since).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Unanswered client email</p>
          <p className="text-[13px] text-muted">
            Unanswered client email is always listed on Tasks → Comms → Email. When this is on, it also rings Kyle&rsquo;s
            bell after {r.kyleCoveredHours} covered hours and yours after {r.ownerCoveredHours} ({r.unhappyCoveredHours} when the client
            sounds unhappy). Bell only — never a text or a Slack message — and it never rings outside covered hours.
          </p>
        </div>
        <button
          type="button" role="switch" aria-checked={r.enabled} aria-label="Unanswered client email alerts"
          onClick={() => set({ enabled: !r.enabled })}
          className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", r.enabled ? "bg-success" : "bg-surface-2 ring-1 ring-border")}
        >
          <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", r.enabled ? "left-[22px]" : "left-0.5")} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <span className="text-[13px] text-muted">Kyle after</span>
        <Hours label="Kyle's bell after" value={r.kyleCoveredHours} onChange={(n) => set({ kyleCoveredHours: n })} />
        <span className="text-[13px] text-muted">· Jordan after</span>
        <Hours label="Jordan's bell after" value={r.ownerCoveredHours} onChange={(n) => set({ ownerCoveredHours: n })} />
        <span className="text-[13px] text-muted">· unhappy client after</span>
        <Hours label="Unhappy client after" value={r.unhappyCoveredHours} onChange={(n) => set({ unhappyCoveredHours: n })} />
      </div>
      {r.ownerCoveredHours < r.kyleCoveredHours && (
        <p className="mt-2 text-[13px] text-warning">Jordan&rsquo;s bell comes after Kyle&rsquo;s — a lower number is saved as the default instead.</p>
      )}
      <p className="mt-2 text-[12px] text-muted-2">
        {r.enabled && sinceWords
          ? `Ringing since ${sinceWords} ET. Email that was already waiting before then is listed, never rung.`
          : "Email already waiting when this is switched on is listed, never rung."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => start(async () => {
            const res = await saveEmailSla(r).catch(() => ({ ok: false, message: "Couldn’t save — try again.", rules: undefined }));
            setMsg(res.message);
            if (res.ok && res.rules) {
              setR(res.rules);
              const again = await loadEmailSla().catch(() => null);
              if (again) setSince(again.since);
            }
          })}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
        </button>
        {msg && <span className="text-[13px] font-medium text-muted">{msg}</span>}
      </div>
    </div>
  );
}
