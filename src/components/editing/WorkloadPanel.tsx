import { Gauge, AlertTriangle } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { LANES, LANE_LABEL, LANE_OWNER, type WorkloadView, type EditorLoad } from "@/lib/editorWorkload";

// ---------------------------------------------------------------------------
// WHAT IS ON WHOSE DESK (R08, review Sep 18).
//
// "8 open" told a reader nothing about whether anybody could do anything about
// it. Four lanes, with whose move each one is, and a rate that came from this
// database rather than from an assumption — see lib/editorWorkload for why
// there are no invented hours anywhere in here.
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

/** One editor's line: what they can work, how fast they have actually been
 *  going, and how much of it is already late. */
function EditorRow({ e }: { e: EditorLoad }) {
  const unassigned = e.kind === "unassigned";
  const rate =
    e.perWeek == null
      ? `no rate yet (${e.sampleCuts} finished cut${e.sampleCuts === 1 ? "" : "s"} in the sample)`
      : `about ${e.perWeek} a week (${e.sampleCuts} in the sample)`;
  // A QUEUE THAT DOES NOT FIT DOES NOT NEED A DECIMAL POINT. Kim's lane on the
  // board today divides out at ninety-two weeks, which is a true number and a
  // useless sentence: past a quarter's work the only fact that matters is that
  // it does not fit, and printing "92.1" invites an argument about the decimal
  // instead of about the backlog. Both raw numbers stay on the line either way.
  const fit =
    e.weeksOfWork == null ? null
    : e.weeksOfWork > 13 ? "far more than that rate can absorb"
    : `roughly ${e.weeksOfWork} week${e.weeksOfWork === 1 ? "" : "s"} at that rate`;
  return (
    <div className={`px-5 py-3 ${unassigned && e.activeVideos > 0 ? "bg-warning-soft/40" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">{unassigned ? "Nobody yet" : e.name}</span>
          {e.kind === "external" && <span className="text-[11px] text-muted-2">outside shop</span>}
          {e.overdue > 0 && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger">
              <AlertTriangle className="size-3" />
              {e.overdue} overdue
              {e.worstOverdueDays != null && e.worstOverdueDays > 0 && ` · worst ${e.worstOverdueDays}d`}
            </span>
          )}
          {e.overdue === 0 && e.dueSoon > 0 && (
            <span className="rounded-lg bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">{e.dueSoon} due within 2 days</span>
          )}
        </div>
        <div className="text-[11px] text-muted-2">
          {e.activeVideos > 0 ? (
            <>
              <span className="font-medium text-muted">{e.activeVideos} video{e.activeVideos === 1 ? "" : "s"} to edit</span>
              {" · "}
              {rate}
              {fit && ` · ${fit}`}
              {e.nextDueISO && ` · next due ${day(e.nextDueISO)}`}
            </>
          ) : (
            "nothing to edit"
          )}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {LANES.map((lane) => (
          <LaneChip key={lane} label={LANE_LABEL[lane]} jobs={e.lanes[lane].jobs} videos={e.lanes[lane].videos} owner={LANE_OWNER[lane]} />
        ))}
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
        {view.editors.map((e) => <EditorRow key={e.key ?? "__none__"} e={e} />)}
      </div>
      {/* WHERE EVERY NUMBER CAME FROM. A capacity figure nobody can trace is
          worse than none, so the sample is printed beside it. */}
      <div className="border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-muted-2">
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
      </div>
    </Section>
  );
}
