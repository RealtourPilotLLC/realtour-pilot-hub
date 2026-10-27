import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn, nameColor } from "@/lib/utils";
import { contentHref } from "@/lib/contentNav";
import { overviewFacts, type OverviewRow } from "@/lib/programOverview";
import { VideoMeter } from "@/components/content/MonthJourney";
import { RowDetails } from "@/components/content/OverviewRow";
import { StatusNotes, StatusSentence } from "@/components/content/ClientStatus";
import { SendReminderButton } from "@/components/content/SendReminderButton";

// ---------------------------------------------------------------------------
// ONE CLIENT-MONTH, as a card (UI-02): the roster's other layout.
//
// It takes the SAME OverviewRow the table draws and reads it through the same
// overviewFacts(), so the card and the table cannot disagree.
//
// Oct 27 2026 (Jordan: "all of these little chips here are really, pretty,
// overwhelming"): the card is now a calm one: the name, ONE line saying who
// the month waits on and for what, the videos meter, the quiet notes (unread
// message, overdue and why, the booking reminder) and one button. The five
// stage chips, the "we owe this" pill and the "No exceptions" line are gone;
// the month's facts fold under "Details".
//
// Not one big link: the card holds two destinations (the client file, and the
// next step's own page), and a link inside a link is invalid HTML.
// ---------------------------------------------------------------------------

export function ClientMonthCard({ r, showMonth, now = new Date(), canRemind = false }: { r: OverviewRow; showMonth: boolean; now?: Date; canRemind?: boolean }) {
  const f = overviewFacts(r);
  const alarm = r.overdue?.kind === "over" || r.failures.length > 0;
  const remindable = canRemind && !!r.monthId && r.waiting.them.some((x) => x.key === "book_session");
  return (
    <div className={cn("panel-shadow flex flex-col gap-3 rounded-2xl border bg-surface p-4", alarm && "border-warning/50")}>
      <div className="flex items-center gap-2.5">
        <Avatar name={r.clientName} color={nameColor(r.clientName)} size={34} />
        <div className="min-w-0 flex-1">
          <Link href={contentHref(r.enrollmentId, { month: r.monthKey })} className="block truncate text-[15px] font-semibold hover:text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            {r.clientName}
          </Link>
          <p className="text-xs text-muted-2">
            {r.pkg}{r.trial ? " · trial" : ""}{r.enrollmentStatus !== "ACTIVE" ? ` · ${r.enrollmentStatus.toLowerCase()}` : ""}{showMonth ? ` · ${r.monthName}` : ""}
          </p>
        </div>
      </div>

      <StatusSentence r={r} />
      <StatusNotes r={r} now={now} reminderAction={remindable ? <SendReminderButton monthId={r.monthId!} clientName={r.clientName} /> : null} />

      <VideoMeter delivered={f.delivered} owed={f.owed} inReview={r.production.awaitingInternalReview} unknown={f.countWarning} />

      <details className="group mt-auto border-t border-border pt-2.5">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-2 hover:text-foreground">
          <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" aria-hidden /> Details
        </summary>
        <RowDetails r={r} f={f} />
      </details>
      <div className="flex justify-end">
        <Link
          href={r.nextAction.href}
          className="inline-flex min-h-10 max-w-full items-center rounded-xl border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {r.nextAction.cta}
        </Link>
      </div>
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
