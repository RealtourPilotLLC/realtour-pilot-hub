import Link from "next/link";
import { durationWords, type EditorSpeedReport, type SpeedCell } from "@/lib/editorSpeed";

// ---------------------------------------------------------------------------
// EDITOR SPEED (Jordan, Oct 27 2026: "I want to be able to keep track of what
// they are working on, and when they start and how long it took and the
// average time it takes for each edit, so that I can know when to hire other
// editors, and also make sure that they are hitting turnaround times").
// One card per editor: what they are on right now and for how long, then
// their averages over the last 30 or 90 days, all videos first and then each
// kind of video. The owner and the creative manager only (the Editing Room
// passes it to nobody else). Numbers from lib/editorSpeed.
// ---------------------------------------------------------------------------

export type SpeedNow = { key: string; street: string; outputTitle: string | null; sinceISO: string | null; firstStartedISO: string | null; projectId: string } | null;

const since = (iso: string | null, now: Date) => (iso ? durationWords((now.getTime() - new Date(iso).getTime()) / 3_600_000) : null);

function Cells({ cell }: { cell: SpeedCell }) {
  const onTime = cell.onTime.of ? `${Math.round((cell.onTime.hit / cell.onTime.of) * 100)}% (${cell.onTime.hit} of ${cell.onTime.of})` : "No due dates yet";
  return (
    <>
      <td className="px-3 py-2 tabular-nums">{cell.videos}</td>
      <td className="px-3 py-2">{durationWords(cell.assignedToStart.hours)}</td>
      <td className="px-3 py-2">{durationWords(cell.startToFirstCut.hours)}</td>
      <td className="px-3 py-2">{durationWords(cell.toApproval.hours)}</td>
      <td className="px-3 py-2">{onTime}</td>
    </>
  );
}

export function EditorSpeedPanel({ report, now, working, days, hrefFor }: {
  report: EditorSpeedReport | null;
  now: Date;
  /** editor key → what they are on right now (the Start they pressed) */
  working: Record<string, SpeedNow>;
  days: 30 | 90;
  hrefFor: (days: 30 | 90) => string;
}) {
  return (
    <section id="editor-speed" aria-labelledby="editor-speed-heading" className="rounded-2xl border border-border bg-surface p-4 sm:p-5" data-editor-speed={days}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="editor-speed-heading" className="text-base font-semibold">Editor speed</h2>
          <p className="text-sm text-muted">From handoff to Start, Start to first cut, and the whole way to approval, for videos whose first cut came in during the last {days} days.</p>
        </div>
        <nav aria-label="Period" className="flex gap-1">
          {([30, 90] as const).map((d) => (
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
                {r.overall.videos === 0 ? (
                  <p className="mt-1 text-sm text-muted">No first cuts in the last {days} days.</p>
                ) : (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[36rem] text-left text-sm">
                      <thead className="text-xs text-muted">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">Kind of video</th>
                          <th className="px-3 py-1.5 font-medium">Videos</th>
                          <th className="px-3 py-1.5 font-medium">Handoff to Start</th>
                          <th className="px-3 py-1.5 font-medium">Start to first cut</th>
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
                )}
              </div>
            );
          })}
          <p className="text-xs text-muted">Averages leave out a step whose times are out of order (a Start pressed after the cut was in). On time means approved by the video&apos;s due date; a video still open counts once its due date has passed.</p>
        </div>
      )}
    </section>
  );
}
