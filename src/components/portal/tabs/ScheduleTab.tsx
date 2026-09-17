import Link from "next/link";
import { CalendarClock, Camera, CheckCircle2, ChevronRight, Clock, MapPin, PenLine, Video } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalPlanning, PortalScheduleMonth, PortalSlotDay } from "@/lib/portal";
import { Card, CardTitle, LoadFailed, fmtDate, fmtTime, tzShort } from "@/components/portal/ui";
import { PortalScheduler } from "@/components/portal/PortalScheduler";
import { PlanWithCall, PlanWithoutCall } from "@/components/portal/PlanningChoice";
import { cn } from "@/lib/utils";

// SCHEDULE (spec §4): two separate appointments. "Schedule strategy call" —
// its status, local date/time, timezone, link and what the client may do —
// and "Schedule content session" (PortalScheduler: per program month, gated
// by the derived preparation window, requests durable). "Plan without a
// call" appears ONLY when the enrollment is eligible, and it never cancels a
// booked call; the real cancellation lives on Calendly / the request row.
export function ScheduleTab({ planning, planningFailed, months, scheduleFailed, slotDays, bookingUrl, sessions, perms, readOnly, topicsHref }: {
  planning: PortalPlanning | null;
  planningFailed: boolean;
  months: PortalScheduleMonth[];
  scheduleFailed: boolean;
  slotDays: PortalSlotDay[];
  bookingUrl: string;
  sessions: { id: string; shootDate: Date | null; title: string | null; addressLine: string | null; status: string }[];
  perms: { session: boolean };
  readOnly: boolean;
  /** Where "Video Topics" points — the tab link the rest of the portal uses. */
  topicsHref: string;
}) {
  const p = planning;
  const tz = p?.timezone ?? "America/New_York";
  const tzName = tzShort(tz);
  const now = new Date();
  const streetOf = (title: string | null, addressLine: string | null) => (addressLine || (title ?? "").split(",")[0] || "").trim();
  return (
    <div className="mt-6 space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Schedule</h1>

      {/* Strategy call */}
      <Card>
        <CardTitle icon={CalendarClock}>Schedule strategy call</CardTitle>
        {planningFailed ? (
          <div className="mt-2"><LoadFailed what="your planning state" /></div>
        ) : !p ? (
          <p className="mt-2 text-sm text-muted">Your next program month isn&rsquo;t open yet — we&rsquo;ll set it up and it will show here.</p>
        ) : (
          <div className="mt-2 space-y-1.5 text-sm">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">{monthLabel(p.monthKey)}</div>
            {p.planningMode === "WRITTEN" ? (
              <>
                <div className="flex items-center gap-1.5 font-medium"><PenLine className="size-4 text-brand" /> Planning in writing — no call this month</div>
                <p className="text-xs text-muted">{p.answersSubmitted ? "Your answers are in; session booking opened from there." : p.interviewsOpen ? <>{p.interviewsOpen} topic{p.interviewsOpen === 1 ? "" : "s"} still need{p.interviewsOpen === 1 ? "s" : ""} answers under <Link href={topicsHref} className="font-medium text-brand hover:underline">Video Topics</Link>.</> : <>Pick your topics under <Link href={topicsHref} className="font-medium text-brand hover:underline">Video Topics</Link> and answer the questions — session booking opens a few business days after.</>}</p>
                {p.callStatus === "SCHEDULED" && p.callAtISO && <p className="text-xs text-muted">A call is still booked for {fmtDate(p.callAtISO, tz)} at {fmtTime(p.callAtISO, tz)} {tzName} — cancel it on Calendly if you no longer need it.</p>}
                {/* Not a one-way door: the same eligibility that offered the
                    written path offers the call back (review, Sep 17). */}
                {p.noCallEligible && !readOnly && perms.session && <PlanWithCall monthId={p.monthId} />}
              </>
            ) : p.callStatus === "COMPLETED" ? (
              <div className="flex items-center gap-1.5 text-success"><CheckCircle2 className="size-4" /> Held{p.callAtISO ? ` on ${fmtDate(p.callAtISO, tz)}` : ""} — the month is planned.</div>
            ) : p.callStatus === "SCHEDULED" && p.callAtISO ? (
              <>
                <div><span className="rounded-md bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">Booked</span></div>
                <div className="font-medium">{fmtDate(p.callAtISO, tz)}</div>
                <div className="flex items-center gap-1.5 text-muted"><Clock className="size-3.5" /> {fmtTime(p.callAtISO, tz)}{p.callEndISO ? `–${fmtTime(p.callEndISO, tz)}` : ""} {tzName}</div>
                {p.meetLink ? <a href={p.meetLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"><Video className="size-3.5" /> Join on Google Meet</a> : <div className="text-xs text-muted-2">Video call — the link is in your calendar invite.</div>}
                <p className="text-xs text-muted">To reschedule or cancel, use the links in your Calendly confirmation email — the change shows here within the hour.</p>
                {p.noCallEligible && !readOnly && perms.session && <PlanWithoutCall monthId={p.monthId} callBooked />}
              </>
            ) : p.callStatus === "NOT_REQUIRED" ? (
              // NOT_REQUIRED = the program has no strategy call at all.
              <p className="text-muted">Your program doesn&rsquo;t include a strategy call — we plan the month from your topics and answers.</p>
            ) : p.callStatus === "SKIPPED" ? (
              // SKIPPED = no call exists for THIS month. A card headed
              // "Schedule strategy call" that offers no way to schedule one is
              // a dead end — the scheduler 40px below already keeps the link
              // reachable in this exact state, and so does this card now.
              <>
                <p className="text-muted">No strategy call this month.</p>
                {!readOnly && (
                  <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Book one anyway <ChevronRight className="size-3.5" /></a>
                )}
              </>
            ) : (
              <>
                <div className="text-muted">Not booked yet — we plan {monthLabel(p.monthKey)} on this call, then film it.</div>
                {!readOnly && (
                  <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Book the call <ChevronRight className="size-4" /></a>
                )}
                <p className="text-xs text-muted-2">Times show in your timezone on Calendly; it lands here as Booked once it&rsquo;s on the calendar.</p>
                {p.noCallEligible && !readOnly && perms.session && <PlanWithoutCall monthId={p.monthId} callBooked={false} />}
              </>
            )}
          </div>
        )}
      </Card>

      {/* Content session */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> Schedule content session</div>
        {scheduleFailed ? <LoadFailed what="your session months" /> : <PortalScheduler months={months} bookingUrl={bookingUrl} days={slotDays} readOnly={!perms.session || readOnly} timezone={tz} />}
      </div>

      {/* Sessions on the calendar */}
      <Card>
        <CardTitle icon={Camera}>Sessions</CardTitle>
        {sessions.filter((s) => s.shootDate).length === 0 ? (
          <p className="mt-2 text-sm text-muted">No sessions on the calendar yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sessions.filter((s) => s.shootDate).slice(0, 12).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="flex items-center gap-1.5"><CalendarClock className={cn("size-4", s.shootDate! >= now ? "text-brand" : "text-muted-2")} /> {fmtDate(s.shootDate!, tz)}</span>
                <span className="flex items-center gap-1.5 text-muted"><Clock className="size-4" /> {fmtTime(s.shootDate!, tz)} {tzName}</span>
                {streetOf(s.title, s.addressLine) && <span className="flex items-center gap-1.5 text-muted"><MapPin className="size-4" /> {streetOf(s.title, s.addressLine)}</span>}
                {s.shootDate! >= now ? <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">upcoming</span> : s.status === "DELIVERED" ? <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span> : <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">filmed</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
