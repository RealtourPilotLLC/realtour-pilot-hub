import Link from "next/link";
import { ClipboardList, ArrowRight } from "lucide-react";
import type { ProjectBrief } from "@/lib/projectBrief";

// ---------------------------------------------------------------------------
// The one summary (R08). Nine cards' worth of facts, said once, at the top, in
// the order somebody asks for them: what was sold, how far along it is, what
// was promised, what the client last asked for, what is in the way, whose move
// it is, and the one next thing. Nothing here is new information — see
// lib/projectBrief for why it cannot become a tenth opinion.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const day = (d: Date | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric" }) : null;

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 px-5 py-2">
      <span className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-2">{label}</span>
      <span className="min-w-0 flex-1 text-[13px] text-foreground/85">{children}</span>
    </div>
  );
}

export function ProjectBriefCard({ brief }: { brief: ProjectBrief }) {
  const { outputs, outputsDone, outputsOwed } = brief;
  const promiseWord =
    brief.promiseSource === "frozen" ? "promised" :
    brief.promiseSource === "office" ? "set by the office" :
    brief.promiseSource === "computed" ? "on the standard turnaround" : null;
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-5 py-2.5">
        <ClipboardList className="size-4 shrink-0 text-brand" />
        <h2 className="text-[15px] font-semibold text-foreground">Where this job is</h2>
        <span className="text-xs text-muted">{brief.tone.headline}</span>
      </div>

      <div className="divide-y divide-border">
        {brief.scope.length > 0 && <Line label="Ordered">{brief.scope.join(" · ")}</Line>}

        {outputsOwed > 0 && (
          <Line label="Videos">
            <span className="font-medium">{outputsDone} of {outputsOwed}</span> with the client
            {brief.currentVersion && <span className="text-muted"> · furthest along: {brief.currentVersion}</span>}
            {outputs.length > 0 && (
              <span className="mt-1 flex flex-wrap gap-1">
                {outputs.slice(0, 16).map((o) => (
                  <span
                    key={o.key}
                    title={`${o.label} — ${o.detail}`}
                    className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
                      o.state === "sent" ? "bg-success/15 text-success"
                      : o.state === "approved" ? "bg-brand-soft text-brand"
                      : o.state === "in_review" ? "bg-warning/15 text-warning"
                      : o.state === "in_revisions" ? "bg-danger/10 text-danger"
                      : o.state === "waived" ? "bg-surface-2 text-muted-2 line-through"
                      : "bg-surface-2 text-muted"
                    }`}
                  >
                    {o.index}
                    {o.round ? `·v${o.round}` : ""}
                  </span>
                ))}
                {outputs.length > 16 && <span className="text-[10px] text-muted-2">+{outputs.length - 16}</span>}
              </span>
            )}
          </Line>
        )}

        {brief.promisedAt && (
          <Line label="Promise">
            <span className={brief.overdue ? "font-medium text-danger" : ""}>{day(brief.promisedAt)}</span>
            {promiseWord && <span className="text-muted"> — {promiseWord}</span>}
            {brief.targetAt && <span className="text-muted-2"> · internal target {day(brief.targetAt)}</span>}
            {brief.overdue && <span className="font-medium text-danger"> · past it</span>}
          </Line>
        )}

        {brief.latestRequest && (
          <Line label="Client asked">
            <span className="text-muted-2">{day(brief.latestRequest.at)}</span>{" — "}
            {brief.latestRequest.text}
          </Line>
        )}

        {brief.blocker && (
          <Line label="In the way"><span className="font-medium text-warning">{brief.blocker}</span></Line>
        )}

        <Line label="Whose move">
          <span className="font-medium">{brief.owner.who}</span>
          <span className="text-muted"> — {brief.nextAction}</span>
        </Line>
      </div>

      <Link
        href={`/edit/${brief.projectId}`}
        className="flex items-center gap-1.5 border-t border-border px-5 py-2 text-xs font-medium text-brand hover:bg-surface-2/60"
      >
        Open the edit tracker
        <ArrowRight className="size-3.5" />
      </Link>
    </section>
  );
}
