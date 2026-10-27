import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn, nameColor } from "@/lib/utils";
import { contentHref } from "@/lib/contentNav";
import { overviewFacts, type OverviewRow as Row, type OverviewFacts } from "@/lib/programOverview";
import { StatusNotes, StatusSentence } from "@/components/content/ClientStatus";
import { SendReminderButton } from "@/components/content/SendReminderButton";

// ---------------------------------------------------------------------------
// ONE CLIENT-MONTH, as a row of the Monthly Content table (spec §16).
//
// Oct 27 2026 (Jordan: "all of these little chips here are really, pretty,
// overwhelming ... easy to identify where people are at and what they're
// waiting on"; "The table looks okay"). The row is now: who, ONE status line
// saying who it waits on and for what (contentStatusLine.ts), the videos
// delivered, and one button. Unread messages, what is overdue and the booking
// reminder sit in one quiet line under it; everything else (owners, the call,
// the sessions, the counts) is folded under "Details". The row is tinted only
// when something is really wrong (overdue or a failed automation), never for
// ordinary work in progress.
//
// The row never invents a reading: the reminder line is the ledger's last
// send, and a production count the library has not caught up with says so.
// ---------------------------------------------------------------------------

const fmt = (isoStr: string | null | undefined) =>
  isoStr ? new Date(isoStr).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : null;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// The session words and the delivered/owner/due readings come from
// programOverview.overviewFacts: the card view (ClientMonthCard) and the
// client file's Overview draw the very same object (UI-02).
export const SESSION_TONE: Record<OverviewFacts["sessionTone"], string> = {
  warning: "text-warning", brand: "text-brand", foreground: "text-foreground", success: "text-success",
};

export function OverviewRow({ r, showMonth, now = new Date(), canRemind = false }: { r: Row; showMonth: boolean; now?: Date; canRemind?: boolean }) {
  const f = overviewFacts(r);
  const alarm = r.overdue?.kind === "over" || r.failures.length > 0;
  const remindable = canRemind && !!r.monthId && r.waiting.them.some((x) => x.key === "book_session");
  return (
    <div className={cn("border-b border-border px-3 py-3.5 last:border-b-0 sm:px-5", alarm && "bg-warning-soft/20")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Avatar name={r.clientName} color={nameColor(r.clientName)} size={30} />
        <div className="min-w-0 flex-1 basis-56 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {/* The name opens the client file on this row's month; the button on the right is the next step. */}
            <Link href={contentHref(r.enrollmentId, { month: r.monthKey })} className="text-[15px] font-semibold hover:text-brand hover:underline">{r.clientName}</Link>
            <span className="text-xs text-muted-2">
              {r.pkg}
              {r.trial ? " · trial" : ""}
              {r.enrollmentStatus !== "ACTIVE" ? ` · ${r.enrollmentStatus.toLowerCase()}` : ""}
              {showMonth ? ` · ${r.monthName}` : ""}
            </span>
          </div>
          <StatusSentence r={r} />
          <StatusNotes r={r} now={now} reminderAction={remindable ? <SendReminderButton monthId={r.monthId!} clientName={r.clientName} /> : null} />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* Videos delivered vs owed: the one number that says whether the month landed. */}
          <span className={cn("text-sm tabular-nums", f.deliveredDone ? "font-semibold text-success" : "text-muted")} title={f.countWarning ?? "videos delivered of the videos owed this month"}>
            {f.delivered}/{f.owed} <span className="text-xs">videos</span>
            {r.production.libraryBehind && <span className="ml-0.5 text-warning">*</span>}
            {r.production.libraryAhead && <span className="ml-0.5 text-warning">!</span>}
          </span>
          <Link href={r.nextAction.href} className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground/85 hover:bg-surface-2">
            {r.nextAction.cta}
          </Link>
        </div>
      </div>

      {/* DETAILS: every stage, folded (BRIEF-LOOM: fold secondary detail). */}
      <details className="group mt-1.5 pl-[42px]">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-2 hover:text-foreground">
          <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" aria-hidden /> Details
        </summary>
        <RowDetails r={r} f={f} />
      </details>
    </div>
  );
}

/** The month's facts, as labelled lines (shared by the row and the card). */
export function RowDetails({ r, f }: { r: Row; f: OverviewFacts }) {
  const lines: { label: string; value: React.ReactNode }[] = [];
  if (r.waiting.them.length) lines.push({ label: "Waiting on them", value: r.waiting.them.map((x) => x.text).join("; ") });
  if (r.waiting.us.length) lines.push({ label: "Waiting on us", value: r.waiting.us.map((x) => x.text).join("; ") });
  // Oct 27 2026 (Jordan: "something here for brand discovery call only when
  // they're a new client"): a new client's line is the discovery call; after
  // that it is the month's strategy call.
  if (r.newClient) {
    lines.push({ label: "Brand discovery call", value: r.newClient.discovery === "needed" ? "not booked yet" : r.newClient.discovery === "booked" ? `booked for ${fmt(r.newClient.atISO) ?? "a date to confirm"}` : "held, strategy being built" });
  } else if (r.planning.callMode !== "NOT_INCLUDED" && !r.clientPlanned) {
    const st = (r.strategyCall.status ?? r.planning.callStatus).toLowerCase().replace(/_/g, " ");
    lines.push({ label: "Strategy call", value: <>{r.strategyCall.atISO ? `${fmt(r.strategyCall.atISO)}, ` : ""}{st === "not scheduled" ? (r.planning.callMode === "REQUIRED" ? "not booked" : "optional, not booked") : st}{r.strategyCall.problem ? <span className="text-warning">. {r.strategyCall.problem}</span> : null}</> });
  }
  lines.push({ label: "Filming", value: <>{r.forfeited ? "forfeited, nothing owed" : `${r.session.confirmed} of ${plural(r.session.required, "session")} booked`}{r.session.dateISO ? `, ${fmt(r.session.dateISO)}` : ""}{r.session.state === "COMPLETED" ? ", filmed" : ""}</> });
  if (!r.clientPlanned) lines.push({ label: "Topics and scripts", value: `${r.work.topicsSelected} topic${r.work.topicsSelected === 1 ? "" : "s"} picked, ${r.work.scriptsApproved} script${r.work.scriptsApproved === 1 ? "" : "s"} approved` });
  else lines.push({ label: "Planning", value: "the client plans their own videos" });
  lines.push({
    label: "Videos",
    value: <>{r.production.delivered} of {r.production.owed} delivered{r.production.filmed > 0 ? `, ${r.production.filmed} filmed` : ""}{r.production.editing > 0 ? `, ${r.production.editing} in editing` : ""}{r.production.clientReview > 0 ? `, ${r.production.clientReview} with the client` : ""}{f.countWarning ? <span className="block text-warning">Check the count: {f.countWarning}</span> : null}</>,
  });
  lines.push({ label: "Owners", value: `Strategy and scripts: ${r.owners.STRATEGY.label}. Scheduling: ${r.owners.SCHEDULING.label}. Delivery: ${r.owners.DELIVERY.label}.` });
  if (f.dueLabel && !f.closed) lines.push({ label: "Due", value: f.dueLabel });
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1.5 rounded-xl bg-surface-2/40 px-3 py-2.5 text-ui-status sm:grid-cols-[10rem_1fr]">
      {lines.map((l) => (
        <div key={l.label} className="contents">
          <dt className="text-muted-2">{l.label}</dt>
          <dd className="text-foreground/85">{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}
