"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, Camera, Video, Image as ImageIcon, Check, Clock, PauseCircle,
  RotateCcw, Sparkles, Truck, StickyNote, CalendarClock,
} from "lucide-react";
import type { BoardJob, BlockerKind, DeliveryBoard } from "@/lib/deliveryBoard";

// KYLE'S BOARD. Three questions per card and nothing else: when is it due, what
// is holding it up, what was ordered. The blocker tag is the thing he scans for,
// so it's a coloured chip on its own line rather than another grey sentence.

const BLOCKER: Record<BlockerKind, { cls: string; icon: React.ElementType }> = {
  awaiting_upload: { cls: "bg-warning/15 text-warning border-warning/30", icon: Camera },
  // Footage in, editor not started (Sep 10) — quieter than "With the editor".
  ready_to_edit: { cls: "bg-brand/10 text-brand border-brand/20", icon: Video },
  editing: { cls: "bg-brand/15 text-brand border-brand/30", icon: Sparkles },
  qc: { cls: "bg-accent/15 text-accent border-accent/30", icon: Check },
  ready: { cls: "bg-success/15 text-success border-success/30", icon: Truck },
  revision: { cls: "bg-danger/15 text-danger border-danger/30", icon: RotateCcw },
  on_hold: { cls: "bg-surface-2 text-muted border-border", icon: PauseCircle },
  not_shot: { cls: "bg-surface-2 text-muted border-border", icon: CalendarClock },
  delivered: { cls: "bg-success/10 text-success border-success/20", icon: Check },
};

const UPLOAD: Record<string, { label: string; cls: string }> = {
  in: { label: "in", cls: "text-success" },
  some: { label: "partial", cls: "text-warning" },
  none: { label: "missing", cls: "text-danger" },
  "n/a": { label: "—", cls: "text-muted-2" },
};

// One media kind, in the two states that matter. "on Aryeo" is what the client
// can see; "in Dropbox" is only what we hold. A job can be either, both, or
// neither, and conflating them is what made a job with no delivered video read
// as finished.
function MediaState({
  icon, label, m, fallback,
}: {
  icon: React.ReactNode;
  label: string;
  m: { rawInDropbox: number; liveOnAryeo: number | null; ordered: boolean };
  fallback: string;
}) {
  if (!m.ordered) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-2">
        {icon} {label} <span className="font-semibold">—</span>
      </span>
    );
  }
  // No status check has run yet (a brand-new job): fall back to the old tick
  // rather than claiming nothing is anywhere.
  if (m.liveOnAryeo == null && m.rawInDropbox === 0) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {icon} {label} <span className={`font-semibold ${UPLOAD[fallback].cls}`}>{UPLOAD[fallback].label}</span>
      </span>
    );
  }
  const live = (m.liveOnAryeo ?? 0) > 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon} {label}{" "}
      {live ? (
        <span className="font-semibold text-success">on Aryeo ({m.liveOnAryeo})</span>
      ) : m.rawInDropbox > 0 ? (
        <span className="font-semibold text-warning" title={`${m.rawInDropbox} raw file${m.rawInDropbox === 1 ? "" : "s"} are in Dropbox, but nothing is live on Aryeo yet — the client cannot see this.`}>
          in Dropbox only — not on Aryeo
        </span>
      ) : (
        <span className="font-semibold text-danger">nothing yet</span>
      )}
      {live && m.rawInDropbox > 0 && <span className="text-muted-2">· raw in Dropbox</span>}
    </span>
  );
}

const dayLabel = (d: Date | null) => {
  if (!d) return "no date";
  return d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
};
const timeLabel = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric" });

// A job's notes can be the whole editor brief: 632 Greenridge carried Andrea's
// ~40-line "EDIT VISION" doc in raw **markdown**, and it pushed the six other
// Due-today cards off Kyle's screen (audit, Sep 8 2026). The card wants ONE
// short line — the brief itself lives on /edit/<id> — with the rest behind a
// "more" toggle. Bold/heading markers are display noise either way.
const NOTE_CLIP = 240;
const unmark = (s: string) => s.replace(/\*\*|__/g, "").replace(/^#+\s*/gm, "");
function JobNote({ notes }: { notes: string }) {
  const [open, setOpen] = useState(false);
  const line = unmark(notes).replace(/\s+/g, " ").trim();
  const long = line.length > NOTE_CLIP;
  const cut = line.lastIndexOf(" ", NOTE_CLIP);
  const clipped = long ? `${line.slice(0, cut > NOTE_CLIP / 2 ? cut : NOTE_CLIP).trimEnd()}…` : line;
  return (
    <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning/[0.08] px-2.5 py-1.5 text-sm leading-relaxed">
      <StickyNote className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className={`break-words ${open ? "whitespace-pre-line" : ""}`}>{open ? unmark(notes).trim() : clipped}</p>
        {long && (
          <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-xs font-medium text-brand hover:underline">
            {open ? "less" : "more"}
          </button>
        )}
      </div>
    </div>
  );
}

function JobCard({ j }: { j: BoardJob }) {
  const [open, setOpen] = useState(false);
  const b = BLOCKER[j.blocker];
  const BIcon = b.icon;

  return (
    <div
      className={`rounded-xl border bg-surface p-3.5 ${
        j.overdue ? "border-danger/50 bg-danger/[0.04]" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link href={`/projects/${j.id}`} className="text-base font-semibold leading-snug hover:underline">
            {j.title}
          </Link>
          <div className="text-sm text-muted">
            {j.client ?? "No client"}
            {j.photographer ? ` · ${j.photographer}` : ""}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {j.deliveredAt ? (
            <div className="text-sm font-medium text-success">{dayLabel(j.deliveredAt)}</div>
          ) : (
            <>
              <div className={`text-sm font-bold ${j.overdue ? "text-danger" : ""}`}>
                {j.overdue && "LATE · "}
                {dayLabel(j.dueAt)}
                {j.dueAt && ` ${timeLabel(j.dueAt)}`}
              </div>
              {j.dueTierLabel && <div className="text-xs text-muted-2">{j.dueTierLabel}</div>}
            </>
          )}
        </div>
      </div>

      {/* The tag Kyle is scanning for. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-semibold ${b.cls}`}>
          <BIcon className="size-4" /> {j.blockerLabel}
        </span>
        {!j.deliveredAt && j.dueFor && (
          // The date is the earliest promise the job STILL OWES (Sep 16): a
          // product already live on Aryeo no longer sets it, so a job whose
          // photos went out on time stopped reading LATE for the photos while
          // the video was the thing actually owed. When no line item names the
          // outstanding thing (a video inside "Standard Package"), this is the
          // category itself.
          <span className="text-sm text-muted" title="The earliest thing this job still owes. Products already delivered no longer set the date.">
            for <span className="font-medium text-foreground">{j.dueFor}</span>
          </span>
        )}
      </div>

      {/* WHERE the media is — two different facts, said separately. A bare
          "Video in" meant only that the deliverable had been ticked as
          uploaded, and Kyle reads that as "the client has it": on 439 Lake
          George the footage was in Dropbox (115 files) with nothing on Aryeo,
          and the row said "Video in". Raw-in-Dropbox and live-on-Aryeo are now
          two labels, because they are two different states of the job. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <MediaState icon={<ImageIcon className="size-4 text-muted-2" />} label="Photos" m={j.media.photos} fallback={j.photos} />
        <MediaState icon={<Video className="size-4 text-muted-2" />} label="Video" m={j.media.video} fallback={j.video} />
        {j.shootDate && (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Clock className="size-4 text-muted-2" /> Shot {dayLabel(j.shootDate)}
          </span>
        )}
      </div>

      {j.notes && <JobNote notes={j.notes} />}

      {j.items.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setOpen(!open)} className="text-sm text-muted-2 hover:text-foreground">
            {open ? "Hide" : `${j.items.length} product${j.items.length === 1 ? "" : "s"} ordered`}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1">
              {j.items.map((it, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 flex-1">
                    {it.quantity > 1 ? `${it.quantity}× ` : ""}
                    {it.title}
                  </span>
                  <span className="shrink-0 text-muted-2">
                    {it.tierLabel} · {dayLabel(it.dueAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: "today", label: "Due today" },
  { key: "tomorrow", label: "Due tomorrow" },
  { key: "upcoming", label: "Upcoming" },
  { key: "delivered", label: "Delivered" },
] as const;

export function DeliveryBoardView({ board }: { board: DeliveryBoard }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("today");
  const jobs = board[tab];

  return (
    <div className="space-y-4">
      {board.overdueCount > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/[0.07] px-4 py-3">
          <AlertTriangle className="size-5 shrink-0 text-danger" />
          <p className="text-base">
            <span className="font-bold text-danger">
              {board.overdueCount} past due
            </span>{" "}
            — these are in Due today, at the top.
          </p>
        </div>
      )}

      {/* Tabs carry their own count, so the shape of the day reads before you
          click anything. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const n = board[t.key].length;
          const active = tab === t.key;
          const late = t.key === "today" && board.overdueCount > 0;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 transition ${
                active ? "border-brand bg-brand/10" : "border-border bg-surface hover:bg-surface-2"
              }`}
            >
              <span className={`text-sm font-semibold ${active ? "text-brand" : ""}`}>{t.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-sm font-bold tabular-nums ${
                  late ? "bg-danger text-white" : active ? "bg-brand text-white" : "bg-surface-2 text-muted"
                }`}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {jobs.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-8 text-center text-base text-muted">
          {tab === "today"
            ? "Nothing due today. "
            : tab === "tomorrow"
              ? "Nothing due tomorrow. "
              : tab === "delivered"
                ? "Nothing delivered in the last 10 days."
                : "Nothing upcoming."}
          {(tab === "today" || tab === "tomorrow") && "Enjoy it."}
        </p>
      ) : (
        <div className="space-y-2.5">
          {jobs.map((j) => (
            <JobCard key={j.id} j={j} />
          ))}
        </div>
      )}
    </div>
  );
}
