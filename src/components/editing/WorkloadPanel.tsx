import Link from "next/link";
import { Gauge, AlertTriangle, CalendarOff } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { LANES, LANE_LABEL, LANE_OWNER, type WorkloadView, type EditorLoad } from "@/lib/editorWorkload";
import type { CapacityChip, CapacityWindows } from "@/lib/capacity";

// ---------------------------------------------------------------------------
// WHAT IS ON WHOSE DESK (R08, review Sep 18; condensed Sep 28).
//
// "8 open" told a reader nothing about whether anybody could do anything about
// it. Four lanes, with whose move each one is, and a rate that came from this
// database rather than from an assumption — see lib/editorWorkload for why
// there are no invented hours anywhere in here.
//
// ONE LINE PER EDITOR (Jordan, Sep 28: "there is just a lot of information to
// look at, and they get confused"). The line keeps what a person acts on — how
// much is owed, how much is late, when the next one is due, and time off in
// force now. The lanes, the rate, the fit and next week's time off are one tap
// away under "details", and the method notes under "How these numbers work".
// Nothing was dropped; it was folded.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric" }) : null;

function LaneChip({ label, jobs, videos, owner }: { label: string; jobs: number; videos: number; owner: string }) {
  if (jobs === 0) return null;
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded-lg bg-surface-2 px-2 py-1 text-[11px] text-muted"
      title={`${label} — ${owner === "editor" ? "the editor's move" : owner === "office" ? "the office's move" : "waiting on the field"}`}
    >
      <span className="font-semibold text-foreground/85">{videos}</span>
      {label}
      {jobs !== videos && <span className="text-muted-2">({jobs} job{jobs === 1 ? "" : "s"})</span>}
    </span>
  );
}

/** A recorded capacity fact (§10, lib/capacity.ts): "Time off · until Fri
 *  5:00 PM". In force now reads amber; coming up this week reads quiet. It is a
 *  sentence for a person to weigh — nothing on the panel is recomputed from it. */
function CapacityChipView({ c, now }: { c: CapacityChip; now: boolean }) {
  return (
    <span
      title={[c.note, `recorded by ${c.recordedBy}`].filter(Boolean).join(" · ")}
      className={`inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-medium ${now ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted"}`}
    >
      <CalendarOff className="size-3" />
      {c.label} · {c.when}
    </span>
  );
}

/** One editor's line: how much they owe, how much of it is late, when the next
 *  one is due, and any time off in force now. The rest is under "details". */
function EditorRow({ e, cap }: { e: EditorLoad; cap?: CapacityWindows }) {
  const unassigned = e.kind === "unassigned";
  const rate =
    e.perWeek == null
      ? `no rate yet (${e.sampleCuts} finished cut${e.sampleCuts === 1 ? "" : "s"} in the sample)`
      : `about ${e.perWeek} a week (${e.sampleCuts} in the sample)`;
  // A QUEUE THAT DOES NOT FIT DOES NOT NEED A DECIMAL POINT. Kim's lane on the
  // board today divides out at ninety-two weeks, which is a true number and a
  // useless sentence: past a quarter's work the only fact that matters is that
  // it does not fit, and printing "92.1" invites an argument about the decimal
  // instead of about the backlog. Both raw numbers stay in the details either way.
  const fit =
    e.weeksOfWork == null ? null
    : e.weeksOfWork > 13 ? "far more than that rate can absorb"
    : `roughly ${e.weeksOfWork} week${e.weeksOfWork === 1 ? "" : "s"} at that rate`;
  const owed = e.activeVideos > 0 ? `${e.activeVideos} to edit` : "nothing to edit";
  const hasLanes = LANES.some((lane) => e.lanes[lane].jobs > 0);
  return (
    <div className={`px-5 py-2.5 ${unassigned && e.activeVideos > 0 ? "bg-warning-soft/40" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        {unassigned ? (
          <span className="font-medium text-foreground">
            Nobody yet
            <span className="font-normal text-muted"> · {e.activeVideos > 0 ? `${e.activeVideos} to edit — needs an editor` : "nothing to edit"}</span>
          </span>
        ) : (
          <span className="font-medium text-foreground">
            {e.name}
            {e.kind === "external" && <span className="font-normal text-muted-2"> (outside shop)</span>}
            <span className="font-normal text-muted"> · {owed}</span>
          </span>
        )}
        {e.overdue > 0 && (
          <span className="inline-flex items-center gap-1 rounded-lg bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger">
            <AlertTriangle className="size-3" />
            {e.overdue} late
          </span>
        )}
        {e.activeVideos > 0 && e.nextDueISO && <span className="text-[11px] text-muted-2">next due {day(e.nextDueISO)}</span>}
        {/* Time off IN FORCE NOW stays on the line: it changes what a person
            can expect today. Next week's is in the details. */}
        {cap?.now.map((c) => <CapacityChipView key={c.id} c={c} now />)}
        <details className="basis-full text-[11px] sm:basis-auto">
          <summary className="cursor-pointer select-none font-medium text-muted-2 hover:text-foreground">details</summary>
          <div className="mt-1.5 space-y-1.5 text-muted">
            {hasLanes && (
              <div className="flex flex-wrap gap-1.5">
                {LANES.map((lane) => (
                  <LaneChip key={lane} label={LANE_LABEL[lane]} jobs={e.lanes[lane].jobs} videos={e.lanes[lane].videos} owner={LANE_OWNER[lane]} />
                ))}
              </div>
            )}
            {!unassigned && <p>{rate}{fit ? ` · ${fit}` : ""}</p>}
            {e.overdue === 0 && e.dueSoon > 0 && <p className="text-warning">{e.dueSoon} due within 2 days</p>}
            {e.worstOverdueDays != null && e.worstOverdueDays > 0 && <p className="text-danger">worst {e.worstOverdueDays}d late</p>}
            {cap && cap.next7d.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {cap.next7d.map((c) => <CapacityChipView key={c.id} c={c} now={false} />)}
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

export function WorkloadPanel({ view, mine }: { view: WorkloadView; mine?: boolean }) {
  const { totals } = view;
  const editing = totals.editing.videos;
  const elsewhere = totals.in_review.videos + totals.awaiting_send.videos;
  return (
    <Section
      icon={Gauge}
      title={mine ? "Your workload" : "Who is holding what"}
      count={`${editing} to edit`}
      flush
      tone={view.unassignedActive > 0 || view.overdue > 0 ? "warning" : "default"}
    >
      <div className="divide-y divide-border">
        {view.editors.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nothing in the room.</p>}
        {view.editors.map((e) => <EditorRow key={e.key ?? "__none__"} e={e} cap={e.key ? view.capacity?.[e.key] : undefined} />)}
      </div>
      {/* §10 capacity: the register where time off, training and blocked time
          are written down. An editor can record their own "offline" or
          "blocked" there; the office records anything for anyone. */}
      <div className="border-t border-border px-5 py-2 text-[11px]">
        <Link href="/people/capacity" className="font-medium text-brand hover:underline">
          {mine ? "Offline or stuck? Tell the office →" : "Time off, training and blocked time →"}
        </Link>
      </div>
      {/* WHERE EVERY NUMBER CAME FROM. A capacity figure nobody can trace is
          worse than none, so the sample is printed beside it — one tap away. */}
      <details className="border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-muted-2">
        <summary className="cursor-pointer select-none font-medium text-muted hover:text-foreground">How these numbers work</summary>
        {/* §7.1: these lanes are the PILE, not the desk. "Owed to the editor"
            used to read "In editing" and swallowed every Ready-for-editing and
            Revisions row, so the office read a backlog as work in progress. */}
        <p className="mt-1">
          Work owed, not work happening now{mine ? " — what you're on is the banner above." : " — who is on what is in Editors today, above."}
        </p>
        <p className="mt-1">
          <span className="font-medium text-muted">{editing}</span> video{editing === 1 ? "" : "s"} an editor can move right now;{" "}
          <span className="font-medium text-muted">{elsewhere}</span> waiting on the office (a verdict or a send), and{" "}
          <span className="font-medium text-muted">{totals.waiting_footage.videos}</span> with no footage in yet.
          {" "}Rates are approved cuts per editor over the last {view.sampleWeeks} weeks — a small sample, and the line says so when it is too small to divide by.
          {view.medianFirstCutHours != null && (
            <>
              {" "}Shoot to first cut has been running about{" "}
              <span className="font-medium text-muted">{Math.round(view.medianFirstCutHours / 24)} days</span>{" "}
              (median of {view.firstCutSamples}) — elapsed time, not hours at a desk.
            </>
          )}
        </p>
      </details>
    </Section>
  );
}
