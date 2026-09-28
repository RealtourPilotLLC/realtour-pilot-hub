"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, PlayCircle } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { etDayKey, etMonthDay, etTime } from "@/lib/datetime";
import type { EditorLine, EditorsTodayView } from "@/lib/editorActivity";

// ---------------------------------------------------------------------------
// EDITORS TODAY (§7.1, reworded Sep 28). One line per editor, worded on the
// server (lib/editorActivity editorLines):
//
//   ● green   On 107 E Old Baltimore Pike since 12:40pm      — pressed Start
//   ○ violet  Paused 107 E Old Baltimore Pike at 12:45pm     — pressed Pause
//   ○ amber   Last action 12:14pm — uploaded a version of …  — did something
//             · hasn't pressed Start today                     in the hub today,
//                                                              no Start
//   ● grey    Nothing in the hub today                         — what the hub
//             saw, not a claim about their day: editing on their own computer
//             shows nowhere until they upload or press Start
//
// Jordan, Sep 28: "It says Kim is not working on anything, but I believe he
// is!" The old panel printed "Not on anything" for an editor with three
// uploads that morning. Only Start still says someone is working (§7.1) — the
// amber line is evidence, shown as evidence, never as "working now".
//
// Honest about its own freshness. The page re-reads every minute
// (AutoRefresh); the header says when it read, says so when that read is more
// than three minutes old (a refresh that failed leaves the old page up), and a
// read that FAILED says it could not read — never an empty "nobody is
// working". A stale read changes the header, never the lines.
// ---------------------------------------------------------------------------

const STALE_MS = 3 * 60_000;

const clock = (iso: string | null, now: Date) => {
  if (!iso) return "";
  const d = new Date(iso);
  const t = etTime(d).replace(/\s?([AP])M$/i, (_m, x: string) => `${x.toLowerCase()}m`);
  return etDayKey(d) === etDayKey(now) ? t : `${etMonthDay(d)} ${t}`;
};

/**
 * How fresh this read is, for the header — pure, so a drill can pin the clock.
 * FAILED: the server could not read (ok:false) — never "nobody is working".
 * STALE: the last good read is more than three minutes old, i.e. the page's
 * one-minute refresh has stopped landing; the lines stay, the header warns.
 * Never navigator.onLine or presence: only the read's own timestamp.
 */
export function readFreshness(view: { ok: boolean; readAt: string }, now: Date): { state: "fresh" | "stale" | "failed"; words: string } {
  if (!view.ok) return { state: "failed", words: `Couldn’t read who is working — last attempt ${clock(view.readAt, now)}.` };
  const stale = now.getTime() - new Date(view.readAt).getTime() > STALE_MS;
  return stale
    ? { state: "stale", words: `may be out of date — read ${clock(view.readAt, now)}` }
    : { state: "fresh", words: `as of ${clock(view.readAt, now)}` };
}

function Dot({ tone }: { tone: EditorLine["tone"] }) {
  if (tone === "unknown") return <AlertTriangle className="size-3.5 shrink-0 self-center text-warning" aria-label="Couldn't read" />;
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 self-center rounded-full",
        tone === "on" && "bg-success",
        tone === "paused" && "border-[1.5px] border-[#8b5cf6] bg-transparent",
        tone === "evidence" && "border-[1.5px] border-warning bg-transparent",
        tone === "idle" && "bg-muted-2/40",
      )}
    />
  );
}

function Line({ l }: { l: EditorLine }) {
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="w-24 shrink-0 text-sm font-medium text-foreground">{l.name}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-sm">
          <Dot tone={l.tone} />
          <span className={cn(l.tone === "idle" || l.tone === "unknown" ? "text-muted" : "text-foreground")}>{l.lead}</span>
          {l.job && (
            <Link href={l.job.href} className="font-medium text-foreground hover:underline">
              {l.job.street}
            </Link>
          )}
          {l.tail && <span className={cn("text-[12px]", l.tone === "evidence" ? "text-warning" : "text-muted-2")}>{l.tail}</span>}
        </span>
        {l.details.length > 0 && (
          <details className="group basis-full text-xs sm:basis-auto">
            <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-2 hover:text-foreground">details</summary>
            <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-muted">
              {l.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

export function WorkingNowPanel({ view }: { view: EditorsTodayView }) {
  // A clock of our own, so "as of" can turn into "may be out of date" while the
  // page sits there without a successful refresh.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const fresh = readFreshness(view, now);

  if (!view.ok) {
    return (
      <Section icon={PlayCircle} title="Editors today" tone="warning">
        <p className="flex items-center gap-2 text-sm text-foreground">
          <AlertTriangle className="size-4 text-warning" />
          {fresh.words} This is not &ldquo;nobody is working&rdquo;; refresh to try again.
        </p>
      </Section>
    );
  }

  return (
    <Section
      icon={PlayCircle}
      title="Editors today"
      count={fresh.words}
      tone={fresh.state === "stale" ? "warning" : "default"}
      flush
    >
      <div className="divide-y divide-border">
        {view.lines.map((l) => <Line key={l.key} l={l} />)}
      </div>
      <div className="space-y-1 border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-muted-2">
        <p className="flex flex-wrap items-center gap-x-1.5">
          <Dot tone="on" /> pressed Start
          <span aria-hidden>·</span>
          <Dot tone="evidence" /> did something in the hub today, no Start
          <span aria-hidden>·</span>
          <Dot tone="idle" /> nothing in the hub today
        </p>
        <details>
          <summary className="cursor-pointer select-none font-medium text-muted hover:text-foreground">How this works</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>Green means the editor pressed Start. Only Start says someone is working.</li>
            <li>
              Amber means no Start, but they did something today — uploaded a version, did the review check, wrote a note or posted in a
              job&rsquo;s chat. That&rsquo;s activity, not a claim they&rsquo;re working now.
            </li>
            <li>
              Editing on their own computer (Premiere, Dropbox) doesn&rsquo;t show here until they upload or press Start — &ldquo;nothing
              in the hub&rdquo; is not &ldquo;not working&rdquo;.
            </li>
            <li>Today = since 12am Eastern. Opening a page never counts.</li>
            <li>Start and Pause are what the editor says — not a timer, not used for pay.</li>
            <li>Paused jobs and old &ldquo;In editing&rdquo; marks are under each editor&rsquo;s details.</li>
          </ul>
        </details>
      </div>
    </Section>
  );
}
