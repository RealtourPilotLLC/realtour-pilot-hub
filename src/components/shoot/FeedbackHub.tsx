"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight, Award, CheckCircle2, ChevronDown, ChevronUp, GraduationCap,
  RefreshCw, Star, TrendingDown, TrendingUp, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { etFullDate } from "@/lib/datetime";
import { NoteCard } from "@/components/shoot/ShootFeedback";
import type { FeedbackHub, HubGroup } from "@/lib/photographerFeedback";
import type { ReviewNote } from "@/lib/review";

// The photographer's QUALITY FEEDBACK hub — every capture note across every
// shoot (photos AND video), plus the "how am I doing" numbers. Frame.io-style
// receiving end: they reply and tick fixes off right here; Jordan's desk for
// LEAVING notes stays the project gallery / cut review. No money anywhere.

function Tile({ label, value, sub, tone }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "warn" | "good";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-3",
        tone === "warn" ? "border-warning/30 bg-warning/5" : tone === "good" ? "border-success/30 bg-success/5" : "border-border bg-surface",
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-2">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

// Notes-per-10-shoots trend vs the previous 90 days. Lower is better.
function Trend({ now, prev }: { now: number | null; prev: number | null }) {
  if (now == null || prev == null || now === prev) return null;
  const better = now < prev;
  const Icon = better ? TrendingDown : TrendingUp;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-medium", better ? "text-success" : "text-warning")}>
      <Icon className="size-3" /> was {prev}
    </span>
  );
}

function GroupCard({ group, readOnly }: { group: HubGroup; readOnly: boolean }) {
  // Local mirror per group so replies/mark-fixed land instantly (same pattern
  // as ShootFeedback); the actions revalidate behind us.
  const [notes, setNotes] = useState(group.notes);
  const patch = (id: string, fn: (n: ReviewNote) => ReviewNote) =>
    setNotes((ns) => ns.map((n) => (n.id === id ? fn(n) : n)));

  // Same ordering as EditFeedback: open fixes → fixed-awaiting-re-review →
  // open coaching → resolved (any kind).
  const rank = (n: ReviewNote) => {
    if (n.status === "OPEN" && n.kind === "fix") return 0;
    if (n.status === "FIXED") return 1;
    if (n.status === "OPEN") return 2; // coaching
    return 3; // resolved
  };
  const sorted = [...notes].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
  const open = sorted.filter((n) => n.status === "OPEN" && n.kind === "fix").length;

  return (
    <div className="overflow-hidden rounded-2xl border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{group.street}</span>
            {open > 0 && (
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                {open} to fix
              </span>
            )}
          </div>
          {group.shootDate && <div className="text-[11px] text-muted-2">Shot {etFullDate(group.shootDate)}</div>}
        </div>
        <Link
          href={`/shoot/${group.projectId}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          Open shoot <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="space-y-3 p-3 sm:p-4">
        {sorted.map((n) => (
          <NoteCard key={n.id} note={n} readOnly={readOnly} patch={patch} />
        ))}
      </div>
    </div>
  );
}

export function FeedbackHubView({ hub, readOnly }: { hub: FeedbackHub; readOnly: boolean }) {
  const [showResolved, setShowResolved] = useState(false);
  const k = hub.kpis;
  const firstName = hub.memberName.split(/\s+/)[0];

  return (
    <div className="space-y-5">
      {readOnly && (
        <p className="text-xs text-muted">
          Previewing {firstName}&rsquo;s quality feedback — read-only. Leave new notes from a project&rsquo;s media
          review or a cut review.
        </p>
      )}

      {/* KPI strip — how {firstName} is doing */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="To fix" value={k.openFixes} tone={k.openFixes > 0 ? "warn" : "good"} sub={k.openFixes === 0 ? "all clear" : "open fix notes"} />
        <Tile label="Awaiting re-review" value={k.awaitingReReview} sub={<span className="inline-flex items-center gap-1"><RefreshCw className="size-3" /> marked fixed</span>} />
        <Tile label="Coaching" value={k.openCoaching} sub="keep-in-mind notes" />
        <Tile
          label="Notes / 10 shoots"
          value={k.notesPerTenShoots ?? "—"}
          sub={
            k.notesPerTenShoots == null ? (
              `no shoots in ${k.windowDays}d`
            ) : k.prevNotesPerTenShoots != null && k.prevNotesPerTenShoots !== k.notesPerTenShoots ? (
              <>last {k.windowDays}d · <Trend now={k.notesPerTenShoots} prev={k.prevNotesPerTenShoots} /></>
            ) : (
              `last ${k.windowDays}d`
            )
          }
        />
        <Tile
          label="Clean streak"
          // The streak walk stops at 20 recent shoots — show that as "20+".
          value={k.cleanStreak >= 20 ? "20+" : k.cleanStreak}
          tone={k.cleanStreak >= 3 ? "good" : undefined}
          sub={<span className="inline-flex items-center gap-1"><Award className="size-3" /> shoots, zero notes</span>}
        />
        <Tile
          label="Client rating"
          value={k.avgRating != null ? <span className="inline-flex items-center gap-1">{k.avgRating}<Star className="size-4 fill-current text-warning" /></span> : "—"}
          sub={k.ratingCount > 0 ? `${k.ratingCount} rating${k.ratingCount === 1 ? "" : "s"}` : "none yet"}
        />
      </div>

      {/* Open feedback, grouped by shoot */}
      {hub.active.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface p-8 text-center">
          <CheckCircle2 className="mx-auto mb-2 size-8 text-success" />
          <p className="text-sm font-semibold">Nothing open — nice work.</p>
          <p className="mt-1 text-xs text-muted">
            When {readOnly ? `${firstName}'s` : "your"} delivered media gets reviewed, capture notes land here
            (and on the shoot itself).
          </p>
        </div>
      ) : (
        hub.active.map((g) => <GroupCard key={g.projectId} group={g} readOnly={readOnly} />)
      )}

      {/* Resolved history */}
      {hub.resolved.length > 0 && (
        <div>
          <button
            onClick={() => setShowResolved((s) => !s)}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground"
          >
            {showResolved ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showResolved ? "Hide resolved shoots" : `Resolved shoots (${hub.resolved.length})`}
          </button>
          {showResolved && (
            <div className="mt-2 space-y-3 opacity-80">
              {hub.resolved.map((g) => <GroupCard key={g.projectId} group={g} readOnly={readOnly} />)}
            </div>
          )}
        </div>
      )}

      {/* What the icons mean — same language as the per-shoot card */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-2">
        <span className="inline-flex items-center gap-1"><Wrench className="size-3" /> Fix = actionable on this job</span>
        <span className="inline-flex items-center gap-1"><GraduationCap className="size-3" /> Coaching = for the next shoot</span>
      </p>
    </div>
  );
}
