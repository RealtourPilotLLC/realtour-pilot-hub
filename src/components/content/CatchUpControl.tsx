"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Loader2, Undo2 } from "lucide-react";
import { catchUpMonthAction, undoCatchUpAction } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// "Catch up a missed month here" (Oct 7 2026) — on the client file's Overview.
// Pick an earlier open month that was missed, confirm, and this month owes one
// more filming session and that month's videos; the missed month closes as
// caught up. Undo puts both back while the extra session isn't booked yet.
// Owner/admin only (the page renders it for them; the actions check again).
// ---------------------------------------------------------------------------

export type CatchUpControlProps = {
  monthId: string;
  monthName: string;
  sessionsNow: number;
  videosNow: number;
  carrying: { missedLabel: string; extraSessions: number; extraVideos: number; by: string | null; at: string; undoRefusal: string | null } | null;
  refusal: string | null;
  /** This month was closed by a later month's catch-up — said once, with who and when. */
  caughtUpNote?: string | null;
  options: { monthId: string; label: string; videosOwed: number; refusal: string | null }[];
};

const control = "inline-flex min-h-11 max-w-full items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-muted whitespace-normal hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const primary = "inline-flex min-h-11 max-w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white whitespace-normal hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const fmt = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : ""; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function CatchUpControl(p: CatchUpControlProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) { setOpen(false); setPick(null); router.refresh(); }
    } catch { setMsg({ ok: false, text: "That wasn't confirmed — reload to see where the months stand." }); }
  });

  if (p.carrying) {
    const c = p.carrying;
    return (
      <div className="rounded-xl border border-brand/30 bg-brand-soft/30 p-3 text-sm">
        <p className="font-medium">
          {p.monthName} includes the {c.missedLabel} catch-up: {plural(p.sessionsNow, "filming session")} and {plural(p.videosNow, "video")} this month.
        </p>
        <p className="mt-0.5 text-[13px] text-muted">
          Added {plural(c.extraSessions, "session")} and {plural(c.extraVideos, "video")}{c.by ? ` · by ${c.by}` : ""}{c.at ? ` on ${fmt(c.at)}` : ""}. {c.missedLabel} is closed as caught up here.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={control} disabled={busy || !!c.undoRefusal} onClick={() => run(() => undoCatchUpAction(p.monthId))}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Undo2 className="size-3.5" aria-hidden />} Undo catch-up
          </button>
          {c.undoRefusal && <span className="text-[13px] text-muted">{c.undoRefusal}</span>}
        </div>
        {msg && <p role="status" className={`mt-2 text-[13px] ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
      </div>
    );
  }

  if (p.caughtUpNote) return <p className="rounded-xl border border-border bg-surface-2/40 p-3 text-sm text-muted">{p.caughtUpNote}</p>;
  // Nothing earlier is open: no control at all (most months).
  if (p.refusal || p.options.length === 0) return null;
  const usable = p.options.filter((o) => !o.refusal);
  const chosen = p.options.find((o) => o.monthId === pick && !o.refusal) ?? null;
  return (
    <div className="text-sm">
      {!open ? (
        <button type="button" className={control} onClick={() => { setOpen(true); setMsg(null); }}>
          <CalendarPlus className="size-3.5" aria-hidden /> Catch up a missed month here
        </button>
      ) : (
        <div className="rounded-xl border border-border bg-surface-2/40 p-3">
          <p className="font-medium">Which month did they miss?</p>
          <ul className="mt-2 space-y-1.5">
            {p.options.map((o) => (
              <li key={o.monthId}>
                <label className={`flex items-start gap-2 ${o.refusal ? "text-muted" : "cursor-pointer"}`}>
                  <input type="radio" name={`catch-up-${p.monthId}`} className="mt-1" disabled={!!o.refusal || busy} checked={pick === o.monthId} onChange={() => setPick(o.monthId)} />
                  <span>
                    <span className="font-medium">{o.label}</span> · {plural(o.videosOwed, "video")}
                    {o.refusal && <span className="block text-[13px]">{o.refusal}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {chosen && (
            <p className="mt-3 rounded-lg border border-border bg-surface p-2 text-[13px]">
              {p.monthName} will owe {plural(p.sessionsNow + 1, "filming session")} and {plural(p.videosNow + chosen.videosOwed, "video")}. {chosen.label} closes as caught up in {p.monthName}, and its reminders stop. The client&rsquo;s portal shows both sessions to book. You can undo this until the extra session is booked.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={primary} disabled={busy || !chosen} onClick={() => chosen && run(() => catchUpMonthAction(p.monthId, chosen.monthId))}>
              {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} {chosen ? `Catch up ${chosen.label} in ${p.monthName}` : usable.length ? "Pick a month" : "Nothing to catch up"}
            </button>
            <button type="button" className={control} disabled={busy} onClick={() => { setOpen(false); setPick(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={`mt-2 text-[13px] ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </div>
  );
}
