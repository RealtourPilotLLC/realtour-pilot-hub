import { Suspense } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { WorkStateBar } from "@/components/editing/WorkStateBar";
import type { BriefSummary } from "@/lib/editorBriefGate";
import type { WorkBar } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// THE SUMMARY BEFORE START (Jordan, Oct 29 2026: "they see a brief project
// summary, and to see all details and instructions, they press start").
// What Kim or John Mark sees on /edit/<id> until they press Start: the
// client, the property, each video with its kind, due date and state, and the
// Start button (the same WorkStateBar the brief uses, so the one-job rule and
// the refusals are the server's). Start refreshes the page into the whole
// brief. Built from lib/editorBriefGate's summary only: the page never reads
// the instructions, script, notes, links, files or messages for this view.
// ---------------------------------------------------------------------------

const CARD = "min-w-0 rounded-2xl border border-border bg-surface p-4 sm:p-5";

/** What opens on Start, in a line. */
export const WAITING_BEHIND_START =
  "The edit instructions, script, footage and brand files, client notes and team messages open when you press Start.";

export function EditorStartGate({
  summary,
  bar,
  backHref,
  backPreferHref,
  selectedOutputId,
}: {
  summary: BriefSummary;
  bar: WorkBar | null;
  backHref: string;
  backPreferHref: boolean;
  selectedOutputId: string | null;
}) {
  const several = summary.videos.length > 1;
  return (
    <div data-brief-gate="summary">
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href={backHref} label="Editing Room" preferHref={backPreferHref} />
      </div>
      <div className="mx-auto w-full max-w-3xl min-w-0 space-y-4 p-4 sm:p-6">
        <header className={CARD}>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{summary.client}</p>
          <h1 className="mt-0.5 break-words text-xl font-semibold leading-snug tracking-tight">{summary.street}</h1>
          {summary.address && summary.address !== summary.street && <p className="mt-0.5 break-words text-sm text-muted">{summary.address}</p>}
          {summary.dueWords && <p className="mt-2 text-sm" data-gate-due><span className="text-muted">This job is</span> <span className="font-medium">{summary.dueWords}</span></p>}
          {!summary.videos.length && summary.kinds.length > 0 && (
            <p className="mt-1 text-sm"><span className="text-muted">What to make:</span> <span className="font-semibold">{summary.kinds.join(", ")}</span></p>
          )}
        </header>

        <section className={CARD} aria-labelledby="gate-start-heading">
          <h2 id="gate-start-heading" className="flex items-center gap-1.5 text-base font-semibold">
            <Lock aria-hidden className="size-4 text-muted" /> Press Start to open the brief
          </h2>
          <p className="mt-1 text-sm text-muted" data-gate-waiting>{WAITING_BEHIND_START}</p>
          <p className="mt-1 text-sm text-muted">{several ? "Start names the video picked beside it. " : ""}Sending a video for review stops its clock; press Start again for the next video or a revision.</p>
          <div className="mt-3">
            {bar ? (
              <Suspense fallback={null}>
                <WorkStateBar bar={bar} tz={summary.tz} selectedOutputId={selectedOutputId} />
              </Suspense>
            ) : (
              <p className="text-sm text-warning">Start could not be loaded just now. Reload the page to try again.</p>
            )}
          </div>
        </section>

        {summary.videos.length > 0 && (
          <section className={CARD} aria-labelledby="gate-videos-heading">
            <h2 id="gate-videos-heading" className="text-base font-semibold">{several ? `${summary.videos.length} videos on this job` : "The video"}</h2>
            <ul className="mt-2 divide-y divide-border">
              {summary.videos.map((v) => {
                const selected = v.id === selectedOutputId;
                return (
                  <li key={v.id} className="py-2" data-gate-video={v.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className="min-w-0 flex-1 basis-48 break-words text-sm font-medium">
                        {several ? `${v.number} · ` : ""}{v.title}
                      </p>
                      <p className="text-sm text-muted">{v.state}</p>
                    </div>
                    <p className="mt-0.5 text-sm text-muted">
                      {v.kind}{v.dueWords ? ` · ${v.dueWords}` : ""}
                    </p>
                    {several && v.state !== "Approved" && (
                      <Link
                        href={`/edit/${summary.projectId}?output=${v.id}`}
                        aria-current={selected ? "true" : undefined}
                        className={`mt-1 inline-flex min-h-11 items-center text-sm font-medium ${selected ? "text-foreground" : "text-brand hover:underline"}`}
                      >
                        {selected ? "Picked for Start" : "Pick this video"}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
