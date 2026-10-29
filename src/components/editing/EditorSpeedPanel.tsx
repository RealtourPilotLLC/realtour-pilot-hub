import Link from "next/link";
import { durationWords, LEFT_RUNNING_HOURS, SPEED_WINDOWS, type EditorSpeedReport, type SpeedCell, type SpeedPace, type SpeedVideo, type SpeedWindow } from "@/lib/editorSpeed";
import { etDate } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// EDITOR SPEED (Jordan, Oct 27 2026: "I want to be able to keep track of what
// they are working on, and when they start and how long it took and the
// average time it takes for each edit, so that I can know when to hire other
// editors, and also make sure that they are hitting turnaround times").
// One card per editor: what they are on right now and for how long, then
// their averages over the last 30 or 90 days, all videos first and then each
// kind of video. The owner and the creative manager only (the Editing Room
// passes it to nobody else). Numbers from lib/editorSpeed.
//
// Oct 29 2026 (Jordan: "the average number of videos they get done per day,
// and how long it takes them from start to finish"): a 7-day window, videos a
// day, Start to sent beside the time on the clock and the fixing time, the
// sends with no Start, and every video in the window under "Each video".
// ---------------------------------------------------------------------------

export type SpeedNow = { key: string; street: string; outputTitle: string | null; sinceISO: string | null; firstStartedISO: string | null; projectId: string } | null;

const since = (iso: string | null, now: Date) => (iso ? durationWords((now.getTime() - new Date(iso).getTime()) / 3_600_000) : null);

function Cells({ cell }: { cell: SpeedCell }) {
  const onTime = cell.onTime.of ? `${Math.round((cell.onTime.hit / cell.onTime.of) * 100)}% (${cell.onTime.hit} of ${cell.onTime.of})` : "No due dates yet";
  return (
    <>
      <td className="px-3 py-2 tabular-nums">{cell.videos}</td>
      <td className="px-3 py-2">{durationWords(cell.assignedToStart.hours)}</td>
      <td className="px-3 py-2" data-speed-start-to-sent>{durationWords(cell.startToFirstCut.hours)}</td>
      <td className="px-3 py-2" data-speed-on-clock>{durationWords(cell.onClock.hours)}</td>
      <td className="px-3 py-2">{durationWords(cell.fixTime.hours)}</td>
      <td className="px-3 py-2">{durationWords(cell.toApproval.hours)}</td>
      <td className="px-3 py-2">{onTime}</td>
    </>
  );
}

/** "1.4 a weekday (7 sent over 5 weekdays) · 2.3 on the 3 days they sent one". Pure. */
export function paceWords(p: SpeedPace): string {
  if (!p.sent) return "No first versions sent.";
  const a = p.perWeekday === null ? `${p.sent} sent` : `${p.perWeekday} a weekday (${p.sent} sent over ${p.weekdays} weekday${p.weekdays === 1 ? "" : "s"})`;
  const b = p.perActiveDay === null ? "" : ` · ${p.perActiveDay} on the ${p.activeDays} day${p.activeDays === 1 ? "" : "s"} they sent one`;
  return `${a}${b}`;
}

const hrs = (h: number | null | undefined) => (typeof h === "number" ? durationWords(h) : "No Start");

function VideoList({ list, now }: { list: SpeedVideo[]; now: Date }) {
  if (!list.length) return null;
  return (
    <details className="mt-2" data-speed-list>
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-muted hover:text-foreground">Each video ({list.length})</summary>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="px-3 py-1.5 font-medium">Version 1 sent</th>
              <th className="px-3 py-1.5 font-medium">Video</th>
              <th className="px-3 py-1.5 font-medium">Start to sent</th>
              <th className="px-3 py-1.5 font-medium">On the clock</th>
              <th className="px-3 py-1.5 font-medium">Fixing</th>
              <th className="px-3 py-1.5 font-medium">Approved</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((v, i) => {
              const late = !!v.dueAt && (v.approvedAt ? v.approvedAt > v.dueAt : now > v.dueAt);
              return (
                <tr key={`${v.projectId}:${v.outputId ?? i}`} data-speed-video={v.outputId ?? v.projectId}>
                  <td className="px-3 py-2 whitespace-nowrap">{etDate(v.firstCutAt)}</td>
                  <td className="px-3 py-2">
                    {v.projectId ? <Link href={`/edit/${v.projectId}${v.outputId ? `?output=${v.outputId}` : ""}`} className="font-medium text-brand hover:underline">{v.street}</Link> : v.street}
                    <span className="block text-xs text-muted">{v.title} · {v.styleName}</span>
                  </td>
                  <td className="px-3 py-2">{v.startedAt ? durationWords(Math.max(0, (v.firstCutAt.getTime() - v.startedAt.getTime()) / 3_600_000)) : "No Start"}</td>
                  <td className="px-3 py-2">{hrs(v.workHours)}{v.leftRunning ? <span className="block text-xs text-warning">left running</span> : null}</td>
                  <td className="px-3 py-2">{v.fixHours?.length ? v.fixHours.map((h) => durationWords(h)).join(", ") : "None"}</td>
                  <td className={`px-3 py-2 ${late ? "text-warning" : ""}`}>{v.approvedAt ? etDate(v.approvedAt) : "Not yet"}{late ? " · late" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function EditorSpeedPanel({ report, now, working, days, hrefFor }: {
  report: EditorSpeedReport | null;
  now: Date;
  /** editor key → what they are on right now (the Start they pressed) */
  working: Record<string, SpeedNow>;
  days: SpeedWindow;
  hrefFor: (days: SpeedWindow) => string;
}) {
  return (
    <section id="editor-speed" aria-labelledby="editor-speed-heading" className="rounded-2xl border border-border bg-surface p-4 sm:p-5" data-editor-speed={days}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="editor-speed-heading" className="text-base font-semibold">Editor speed</h2>
          <p className="text-sm text-muted">Videos a day, and each video from handoff to Start, Start to sent, and on to approval, for videos whose version 1 was sent in the last {days} days.</p>
        </div>
        <nav aria-label="Period" className="flex gap-1">
          {SPEED_WINDOWS.map((d) => (
            <Link key={d} href={hrefFor(d)} aria-current={d === days ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-medium ${d === days ? "border-brand bg-brand-soft/40 text-brand" : "border-border text-muted hover:text-foreground"}`}>
              Last {d} days
            </Link>
          ))}
        </nav>
      </div>
      {!report ? (
        <p className="mt-3 text-sm text-warning">The numbers could not be read just now. Reload to try again.</p>
      ) : (
        <div className="mt-4 space-y-5">
          {report.rows.map((r) => {
            const on = working[r.editorKey] ?? null;
            return (
              <div key={r.editorKey} data-speed-editor={r.editorKey}>
                <h3 className="text-sm font-semibold">{r.name}</h3>
                <p className="mt-0.5 text-sm" data-speed-now>
                  {on ? (
                    <>
                      Working on{" "}
                      <Link href={`/edit/${on.projectId}`} className="font-medium text-brand hover:underline">{on.street}{on.outputTitle ? `, ${on.outputTitle}` : ""}</Link>
                      {since(on.firstStartedISO, now) ? <span className="text-muted"> · started {since(on.firstStartedISO, now)} ago</span> : null}
                      {since(on.sinceISO, now) ? <span className="text-muted"> · on it now for {since(on.sinceISO, now)}</span> : null}
                    </>
                  ) : (
                    <span className="text-muted">Not on anything right now.</span>
                  )}
                </p>
                {r.overall.videos > 0 && (
                  <p className="mt-0.5 text-sm" data-speed-pace><span className="text-muted">Videos a day:</span> {paceWords(r.pace)}</p>
                )}
                {r.overall.videos === 0 ? (
                  <p className="mt-1 text-sm text-muted">No first cuts in the last {days} days.</p>
                ) : (
                  <>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[48rem] text-left text-sm">
                      <thead className="text-xs text-muted">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">Kind of video</th>
                          <th className="px-3 py-1.5 font-medium">Videos</th>
                          <th className="px-3 py-1.5 font-medium">Handoff to Start</th>
                          <th className="px-3 py-1.5 font-medium">Start to sent</th>
                          <th className="px-3 py-1.5 font-medium">On the clock</th>
                          <th className="px-3 py-1.5 font-medium">Fixing</th>
                          <th className="px-3 py-1.5 font-medium">To approval</th>
                          <th className="px-3 py-1.5 font-medium">On time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        <tr className="font-medium"><td className="px-3 py-2">All videos</td><Cells cell={r.overall} /></tr>
                        {r.byType.length > 1 && r.byType.map((t) => (
                          <tr key={t.styleName} data-speed-type={t.styleName}><td className="px-3 py-2">{t.styleName}</td><Cells cell={t.cell} /></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(r.overall.startUnknown > 0 || r.overall.leftRunning > 0) && (
                    <p className="mt-1 text-xs text-muted" data-speed-gaps>
                      {r.overall.startUnknown > 0 ? `${r.overall.startUnknown} sent with no Start on that video (left out of Start to sent). ` : ""}
                      {r.overall.leftRunning > 0 ? `${r.overall.leftRunning} with a Start left running over ${LEFT_RUNNING_HOURS} h (left out of On the clock).` : ""}
                    </p>
                  )}
                  <VideoList list={r.list} now={now} />
                  </>
                )}
              </div>
            );
          })}
          <p className="text-xs text-muted">Videos a day: first versions sent, over the weekdays (Mon to Fri, Eastern) in the window, then over the days they sent one. Start to sent: their first Start on that video to version 1 sent. On the clock: the time between Start and Pause (or the send, or another job) on that video, added up. Fixing: a send-back to the next version sent. Averages leave out a step whose times are out of order (a Start pressed after the cut was in). On time means approved by the video&apos;s due date; a video still open counts once its due date has passed.</p>
        </div>
      )}
    </section>
  );
}
