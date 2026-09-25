import Link from "next/link";
import {
  AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, Clapperboard, Clock, FileText, Lightbulb, MessageSquare, Phone, Users,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn, nameColor } from "@/lib/utils";
import { contentHref } from "@/lib/contentNav";
import { overviewFacts, type OverviewRow as Row, type OverviewFacts } from "@/lib/programOverview";

// ---------------------------------------------------------------------------
// ONE CLIENT-MONTH, as a row (spec §16). Server-rendered on purpose: it is a
// <details> element, so the expandable detail costs no client JavaScript and
// behaves identically at 375px, where the summary collapses to
// name + next action and everything else moves inside.
//
// The row never invents a reading. An empty communication column says "no
// reminder has ever been sent"; a production count that the library has not
// caught up with says so beside the number instead of showing a confident 0.
// ---------------------------------------------------------------------------

const fmt = (isoStr: string | null | undefined) =>
  isoStr ? new Date(isoStr).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;
const fmtFull = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;

// The session words and the delivered/owner/due readings come from
// programOverview.overviewFacts — the card view (ClientMonthCard) and the
// client file's Overview draw the very same object (UI-02).
export const SESSION_TONE: Record<OverviewFacts["sessionTone"], string> = {
  warning: "text-warning", brand: "text-brand", foreground: "text-foreground", success: "text-success",
};

export function BlockedChip({ blocked }: { blocked: Row["nextAction"]["blocked"] }) {
  // "We owe work" and "waiting on the client" are different problems and must
  // never be one amber blob (Jordan's rule).
  if (blocked === "client") return <span className="shrink-0 rounded-full bg-[#8b93e6]/20 px-2 py-0.5 text-[10px] font-semibold text-[#8b93e6]">waiting on them</span>;
  if (blocked === "us") return <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">we owe this</span>;
  return <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">on track</span>;
}

function Cell({ icon: Icon, label, children }: { icon: typeof Users; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">
        <Icon className="size-3" /> {label}
      </div>
      <div className="space-y-0.5 text-[12px] leading-snug text-foreground/85">{children}</div>
    </div>
  );
}

export function OverviewRow({ r, showMonth }: { r: Row; showMonth: boolean }) {
  const worry = r.nextAction.blocked === "us" || r.flags.includes("overdue") || r.failures.length > 0;
  const f = overviewFacts(r);
  return (
    <details className={cn("group border-b border-border last:border-b-0", worry && "bg-warning-soft/20")}>
      {/* SUMMARY — at 375px this is the whole row: who, and what is next. */}
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-3 hover:bg-surface-2/60 sm:px-5">
        <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
        <Avatar name={r.clientName} color={nameColor(r.clientName)} size={26} />
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex items-center gap-1.5">
            {/* The name opens the client file on this row's month; the button on the right is the next action. */}
            <Link href={contentHref(r.enrollmentId, { month: r.monthKey })} className="truncate text-[13px] font-semibold hover:text-brand hover:underline">{r.clientName}</Link>
            {r.trial && <span className="shrink-0 rounded bg-brand-soft px-1 text-[10px] font-medium text-brand">Trial</span>}
            {r.enrollmentStatus !== "ACTIVE" && <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] font-medium text-muted-2">{r.enrollmentStatus.toLowerCase()}</span>}
          </div>
          <div className="truncate text-[11px] text-muted-2">
            {r.pkg}
            {showMonth && ` · ${r.monthName}`}
            {` · ${f.sessionLabel}`}
            {` · ${f.owner.split(" ")[0]}`}
            {f.dueLabel && ` · due ${f.dueLabel}`}
          </div>
        </div>
        {/* Videos delivered vs owed — the one number that says whether the month landed. */}
        <span className={cn("shrink-0 text-[12px] font-semibold tabular-nums", f.deliveredDone ? "text-success" : "text-muted")} title={f.countWarning ?? undefined}>
          {f.delivered}/{f.owed}
          {r.production.libraryBehind && <span className="ml-0.5 text-warning">*</span>}
          {r.production.libraryAhead && <span className="ml-0.5 text-warning">!</span>}
        </span>
        <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto sm:flex-1">
          <BlockedChip blocked={r.nextAction.blocked} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/80">{r.nextAction.text}</span>
        </div>
        <Link
          href={r.nextAction.href}
          className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          {r.nextAction.cta}
        </Link>
      </summary>

      {/* DETAIL — every stage, in the order the month runs. */}
      <div className="grid gap-x-5 gap-y-3 border-t border-border/70 bg-surface-2/30 px-3 py-3 sm:grid-cols-2 sm:px-5 lg:grid-cols-3">
        <Cell icon={Users} label="Owners">
          <div>strategy &amp; scripts: <span className="font-medium">{r.owners.STRATEGY.label}</span>{r.owners.STRATEGY.scope !== "DEFAULT" && <span className="text-muted-2"> (override)</span>}</div>
          <div>scheduling: <span className="font-medium">{r.owners.SCHEDULING.label}</span></div>
          <div>delivery: <span className="font-medium">{r.owners.DELIVERY.label}</span></div>
        </Cell>

        <Cell icon={Lightbulb} label="Planning">
          <div>{r.planning.requirementWord}</div>
          <div className="text-muted">
            path: {r.planning.planningMode === "CALL" ? "strategy call" : r.planning.planningMode === "WRITTEN" ? "written, no call" : "not chosen yet"}
          </div>
          <div className={cn(r.planning.complete ? "text-success" : "text-muted")}>preparation: {r.planning.preparationWord}</div>
        </Cell>

        <Cell icon={Phone} label="Strategy call">
          <div>{r.strategyCall.atISO ? fmt(r.strategyCall.atISO) : "—"} {r.strategyCall.status ? `· ${r.strategyCall.status.toLowerCase()}` : `· ${r.planning.callStatus.toLowerCase().replace(/_/g, " ")}`}</div>
          <div className="text-muted">evidence: {r.strategyCall.evidence ?? "nothing recorded"}</div>
          {r.strategyCall.processing && <div className="text-muted">{r.strategyCall.processing}</div>}
          {r.strategyCall.problem && <div className="text-warning">{r.strategyCall.problem}</div>}
        </Cell>

        <Cell icon={CalendarDays} label="Content session">
          <div className={SESSION_TONE[f.sessionTone]}>{f.sessionLabel}{r.session.dateISO ? ` · ${fmt(r.session.dateISO)}` : ""}</div>
          {r.session.detail && <div className="text-muted">{r.session.detail}</div>}
          {r.session.requestedCount > 0 && <div className="text-muted-2">{r.session.requestedCount} request{r.session.requestedCount === 1 ? "" : "s"} on record</div>}
        </Cell>

        <Cell icon={FileText} label="Topics & scripts">
          <div>{r.work.topicsSelected} topic{r.work.topicsSelected === 1 ? "" : "s"} selected{r.work.topicsNeeded > 0 ? ` · ${r.work.topicsNeeded} still to pick` : ""}</div>
          {r.work.answersOutstanding > 0 && <div className="text-[#8b93e6]">{r.work.answersOutstanding} waiting on their answers</div>}
          <div className="text-muted">
            scripts: {r.work.scriptsDrafting} drafting · {r.work.scriptsReviewNeeded} need approval · {r.work.scriptsApproved} approved
          </div>
          {r.work.strategyReviewNeeded > 0 && <div className="text-warning">{r.work.strategyReviewNeeded} strategy version awaiting approval</div>}
        </Cell>

        <Cell icon={Clapperboard} label="Production">
          <div>
            {r.production.delivered} of {r.production.owed} delivered
            {r.production.carriedIn > 0 && <span className="text-muted-2"> · {r.production.carriedIn} carried in</span>}
          </div>
          <div className="text-muted">{r.production.filmed} filmed · {r.production.editing} editing · {r.production.clientReview} with the client</div>
          {r.production.libraryBehind && (
            <div className="text-warning">
              the pipeline says {r.production.pipelineDelivered} delivered — the video library has {r.production.libraryRows} row{r.production.libraryRows === 1 ? "" : "s"} for this month, so the count above is understated
            </div>
          )}
          {r.production.libraryAhead && (
            <div className="text-warning">
              the library counts {r.production.delivered} delivered but the attached orders carry {r.production.pipelineDelivered} — check this month for a video counted twice
            </div>
          )}
        </Cell>

        <Cell icon={Clock} label="Next action">
          <div className="font-medium">{r.nextAction.text}</div>
          <div className="text-muted">
            {f.blocked === "client" ? "waiting on the client" : f.blocked === "us" ? "we owe this" : "nothing blocked"} · {f.owner} ({f.ownerDuty})
          </div>
          {f.dueLabel && <div className="text-muted-2">by {f.dueLabel}</div>}
        </Cell>

        <Cell icon={MessageSquare} label="Communication">
          {r.comms.everSent ? (
            <div>last: {r.comms.lastAction?.toLowerCase().replace(/_/g, " ")} · {fmtFull(r.comms.lastAt)}</div>
          ) : (
            <div className="text-muted">no reminder has ever been sent</div>
          )}
          {r.comms.nextEligibleAt && <div className="text-muted">next eligible {fmtFull(r.comms.nextEligibleAt)}</div>}
          {r.comms.suppressionReason && <div className="text-muted-2">suppressed: {r.comms.suppressionReason.replace(/_/g, " ")}</div>}
          {r.comms.failure && <div className="text-warning">failed: {r.comms.failure.slice(0, 90)}</div>}
        </Cell>

        <Cell icon={AlertTriangle} label="Automation">
          {r.failures.length === 0 ? (
            <div className="flex items-center gap-1 text-success"><CheckCircle2 className="size-3" /> nothing has failed</div>
          ) : (
            r.failures.slice(0, 3).map((f) => (
              <div key={f.ref} className="text-warning">
                <Link href={f.href} className="hover:underline">{f.title}</Link>
                <span className="block text-[11px] text-muted-2">{f.error.slice(0, 90)}</span>
              </div>
            ))
          )}
        </Cell>
      </div>
    </details>
  );
}
