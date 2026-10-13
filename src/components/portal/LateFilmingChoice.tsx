"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalChooseFilmingSessions } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { SaveStatus } from "@/components/ui/SaveStatus";

// ---------------------------------------------------------------------------
// ONE SESSION OR TWO (Oct 13 2026), on the late-session card of Your Month.
// Jordan: "I'd like to give the option to film 4 in one session if needing to
// catch up or 2 separate sessions." The client picks; the server decides
// whether it may change (monthLateSession.setLateCombined: Starter only, and
// only while neither month has a session booked or asked for). Two plain
// choices, the current one marked; disabled with the reason when it can't
// change. Client words, no em dashes.
// ---------------------------------------------------------------------------

export function LateFilmingChoice({ lateMonthId, combined, refusal, readOnly, words }: {
  lateMonthId: string;
  combined: boolean;
  /** Why it can't change right now, in the client's words (null = it can). */
  refusal: string | null;
  readOnly: boolean;
  words: { heading: string; combined: string; separate: string };
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const locked = readOnly || !!refusal;
  const choose = (want: boolean) => {
    if (locked || want === combined) return;
    start(async () => {
      const r = await portalChooseFilmingSessions(portalAuthFromLocation(), lateMonthId, want).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };
  const option = (want: boolean, label: string) => {
    const on = want === combined;
    return (
      <button
        type="button" role="radio" aria-checked={on} disabled={busy || (locked && !on)} onClick={() => choose(want)}
        className={cn(
          "flex min-h-12 w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed",
          on ? "border-brand bg-brand-soft/40 text-foreground" : "border-border bg-surface text-muted hover:text-foreground disabled:opacity-60",
        )}
      >
        {busy && !on ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : on ? <CheckCircle2 className="size-4 shrink-0 text-brand" aria-hidden /> : <Circle className="size-4 shrink-0" aria-hidden />}
        <span>{label}</span>
      </button>
    );
  };
  return (
    <div className="mt-3">
      <h4 id={`filming-choice-${lateMonthId}`} className="text-sm font-semibold">{words.heading}</h4>
      <div role="radiogroup" aria-labelledby={`filming-choice-${lateMonthId}`} className="mt-2 grid gap-2 sm:grid-cols-2">
        {option(true, words.combined)}
        {option(false, words.separate)}
      </div>
      {refusal && !readOnly && <p className="mt-1.5 text-xs text-muted">{refusal}</p>}
      {msg && <div className="mt-1.5"><SaveStatus state={msg.ok ? "info" : "error"} message={msg.text} /></div>}
    </div>
  );
}
