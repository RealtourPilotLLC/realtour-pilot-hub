"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, PlayCircle } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { etDayKey, etMonthDay, etTime } from "@/lib/datetime";
import type { DeskItem, WorkingNow } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// WORKING NOW (§7.1). What each editor has SAID they are on — pressed Start on
// — since when, the last change, and what they have paused. The queue below is
// the backlog; this is the desk.
//
// Honest about its own freshness. The page re-reads every minute
// (AutoRefresh); the panel prints when it read, says so if that read is more
// than three minutes old (a refresh that failed leaves the old page up), and
// a read that FAILED says it could not read — never an empty "nobody is
// working". Browser presence and inactivity are not evidence of anything and
// are not used.
// ---------------------------------------------------------------------------

const STALE_MS = 3 * 60_000;

const clock = (iso: string | null, now: Date) => {
  if (!iso) return "";
  const d = new Date(iso);
  const t = etTime(d).replace(/\s?([AP])M$/i, (_m, x: string) => `${x.toLowerCase()}m`);
  return etDayKey(d) === etDayKey(now) ? t : `${etMonthDay(d)} ${t}`;
};
const KIND_WORD: Record<string, string> = {
  START: "started",
  RESUME: "resumed",
  PAUSE: "paused",
  AUTO_PAUSE: "paused (switched jobs)",
  CONFIRM: "confirmed",
  CONFIRM_PAUSED: "confirmed paused",
};

function Item({ it, now, paused }: { it: DeskItem; now: Date; paused?: boolean }) {
  return (
    <Link href={`/edit/${it.projectId}`} className="group inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 hover:underline">
      <span className={cn("font-medium", paused ? "text-foreground/80" : "text-foreground")}>{it.street}</span>
      {it.outputTitle && <span className="text-muted">· {it.outputTitle}</span>}
      {it.revisionOpen && <span className="rounded bg-warning-soft px-1 text-[10px] font-semibold text-warning">revision</span>}
      {paused && it.sinceISO && <span className="text-[11px] text-muted-2">paused {clock(it.sinceISO, now)}</span>}
      {paused && it.dueISO && <span className="text-[11px] text-muted-2">· due {etMonthDay(new Date(it.dueISO))}</span>}
    </Link>
  );
}

export function WorkingNowPanel({ data }: { data: WorkingNow }) {
  // A clock of our own, so "as of" can turn into "may be out of date" while the
  // page sits there without a successful refresh.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const readAt = new Date(data.readAt);
  const stale = now.getTime() - readAt.getTime() > STALE_MS;

  if (!data.ok) {
    return (
      <Section icon={PlayCircle} title="Working now" tone="warning">
        <p className="flex items-center gap-2 text-sm text-foreground">
          <AlertTriangle className="size-4 text-warning" />
          Couldn&rsquo;t read who is working — last attempt {clock(data.readAt, now)}. This is not &ldquo;nobody is working&rdquo;; refresh to try again.
        </p>
      </Section>
    );
  }

  const anyone = data.editors.some((e) => e.active || e.paused.length || e.unconfirmed.length);
  return (
    <Section
      icon={PlayCircle}
      title="Working now"
      count={stale ? `may be out of date — read ${clock(data.readAt, now)}` : `as of ${clock(data.readAt, now)}`}
      tone={stale ? "warning" : "default"}
      flush
    >
      <div className="divide-y divide-border">
        {data.editors.map((e) => (
          <div key={e.key} className="px-5 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="w-24 shrink-0 text-sm font-medium text-foreground">{e.name}</span>
              {e.active ? (
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="size-2 shrink-0 self-center rounded-full bg-[#8b5cf6]" />
                  <Item it={e.active} now={now} />
                  <span className="text-[11px] text-muted-2">
                    since {clock(e.active.sinceISO, now)}
                    {e.active.firstStartedISO && e.active.firstStartedISO !== e.active.sinceISO ? ` · first started ${clock(e.active.firstStartedISO, now)}` : ""}
                    {e.active.lastEventKind ? ` · last update: ${KIND_WORD[e.active.lastEventKind] ?? e.active.lastEventKind.toLowerCase()} ${clock(e.active.lastEventISO, now)}` : ""}
                    {e.active.onBehalfBy ? ` by ${e.active.onBehalfBy} (office correction)` : ""}
                  </span>
                </span>
              ) : (
                <span className="flex-1 text-sm text-muted">Not on anything{e.unconfirmed.length ? " confirmed" : ""}</span>
              )}
            </div>
            {e.paused.length > 0 && (
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-0 text-xs sm:pl-[108px]">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Paused</span>
                {e.paused.map((p) => <Item key={p.projectId} it={p} now={now} paused />)}
              </div>
            )}
            {e.unconfirmed.length > 0 && (
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-0 text-xs sm:pl-[108px]">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-warning">Claimed in editing — not confirmed</span>
                {e.unconfirmed.map((c) => (
                  <Link key={c.projectId} href={`/edit/${c.projectId}`} className="text-foreground/80 hover:underline">
                    {c.street}
                    <span className="ml-1 text-[11px] text-muted-2">{c.claimedAt ? `claimed ${clock(c.claimedAt, now)}` : "no start time on record"}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-muted-2">
        {anyone ? "" : "Nobody has pressed Start on anything right now. "}
        What each editor has said they&rsquo;re on — Start, Pause, Resume — not a timer and not used for pay. The table below is the backlog: everything owed, whoever holds it.
      </p>
    </Section>
  );
}
