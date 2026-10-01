import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Hourglass, ShieldAlert, Stamp } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn, nameColor } from "@/lib/utils";
import { contentHref } from "@/lib/contentNav";
import { overviewFacts, type OverviewException, type OverviewRow } from "@/lib/programOverview";
import { MonthJourney, VideoMeter, journeyFromOverview, monthJourneyLinks } from "@/components/content/MonthJourney";
import { BlockedChip, SESSION_TONE } from "@/components/content/OverviewRow";

// ---------------------------------------------------------------------------
// ONE CLIENT-MONTH, as a card (UI-02) — the roster's default view.
//
// It takes the SAME OverviewRow the dense table draws and reads it through the
// same overviewFacts(), so the card and the table cannot disagree: the Aug-25
// cards used to come from a second engine (getProgramRoster) and, by
// construction, showed different numbers from the rows beside them.
//
// Not one big link: the card holds two destinations (the client file, and the
// next action's own page), and a link inside a link is invalid HTML that
// browsers split unpredictably. The name opens the file; the button acts.
// ---------------------------------------------------------------------------

const EXCEPTION_ICON: Record<OverviewException["kind"], typeof AlertTriangle> = {
  overdue: Clock,
  failed_automation: ShieldAlert,
  needs_approval: Stamp,
  awaiting_client: Hourglass,
};

export function ClientMonthCard({ r }: { r: OverviewRow; showMonth: boolean }) {
  const f = overviewFacts(r);
  const ExIcon = f.exception ? EXCEPTION_ICON[f.exception.kind] : null;
  const loud = f.exception?.kind === "overdue" || f.exception?.kind === "failed_automation";
  return (
    <div
      className={cn(
        "panel-shadow flex flex-col gap-3 rounded-2xl border bg-surface p-4",
        loud ? "border-warning/50" : f.blocked === "us" && "border-warning/25",
      )}
    >
      <div className="flex items-center gap-2.5">
        <Avatar name={r.clientName} color={nameColor(r.clientName)} size={34} />
        <div className="min-w-0 flex-1">
          <Link href={contentHref(r.enrollmentId, { month: r.monthKey })} className="flex min-h-11 items-center rounded-lg text-sm font-semibold hover:text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            {r.clientName}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <PkgChip pkg={r.pkg} />
            {r.trial && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">Trial</span>}
            {r.enrollmentStatus !== "ACTIVE" && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{r.enrollmentStatus.toLowerCase()}</span>}
            <span className="text-ui-status text-muted">{r.monthName}</span>
          </div>
        </div>
      </div>

      {/* The compact month tracker — the same reader the client file's hero draws. */}
      <MonthJourney input={journeyFromOverview(r)} hrefs={monthJourneyLinks(r)} contextLabel={`${r.clientName}, ${r.monthName}`} />

      <VideoMeter delivered={f.delivered} owed={f.owed} inReview={r.production.awaitingInternalReview} unknown={f.countWarning} />

      <div className={cn("text-ui-status", SESSION_TONE[f.sessionTone])}>{f.sessionLabel}</div>

      {/* NEXT ACTION — what, who, by when, and the one button that does it. */}
      <div className="space-y-1.5 border-t border-border pt-2.5">
        <div className="flex items-start gap-2">
          <BlockedChip blocked={f.blocked} />
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">{r.nextAction.text}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-ui-status text-muted">
            {f.owner}
            {f.dueLabel ? ` · due ${f.dueLabel}` : ""}
          </span>
          <Link
            href={r.nextAction.href}
            className="inline-flex min-h-11 max-w-full items-center rounded-xl border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {r.nextAction.cta}
          </Link>
        </div>
      </div>

      {/* EXCEPTION — an icon and a word, so it reads without colour. */}
      {f.exception && ExIcon ? (
        <p className={cn("flex flex-wrap items-center gap-1.5 text-ui-status font-medium", loud ? "text-warning" : f.exception.kind === "awaiting_client" ? "text-muted" : "text-brand")}>
          <ExIcon className="size-3.5 shrink-0" aria-hidden /> {f.exception.label}
          {r.failures[0] && f.exception.kind === "failed_automation" && <span className="break-words font-normal text-muted">— {r.failures[0].title}</span>}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-ui-status text-success">
          <CheckCircle2 className="size-3.5" aria-hidden /> No exceptions
        </p>
      )}
    </div>
  );
}

export function PkgChip({ pkg }: { pkg: string }) {
  const color = pkg === "Pro" ? "#a78bfa" : pkg === "Starter" ? "#38bdf8" : "#f59e0b";
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: `${color}26`, color }}>
      {pkg}
    </span>
  );
}
