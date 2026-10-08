import Link from "next/link";
import { CalendarClock, Camera, CheckCircle2, ChevronRight, Clock, MapPin, PenLine, Video } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalPlanning, PortalScheduleMonth, PortalSlotDay } from "@/lib/portal";
import { Card, CardTitle, LoadFailed, fmtDate, fmtTime, tzShort } from "@/components/portal/ui";
import { PortalScheduler } from "@/components/portal/PortalScheduler";
import { cn } from "@/lib/utils";

// SCHEDULE (spec §4): two separate appointments. "Schedule strategy call" —
// its status, local date/time, timezone, link and what the client may do —
// and "Schedule content session" (PortalScheduler: per program month, gated
// by the derived preparation window — 72 weekday hours after the answers are
// sent or the booked call ends — requests durable). "Plan without a
// call" appears ONLY when the enrollment is eligible, and it never cancels a
// booked call; the real cancellation lives on Calendly / the request row.
//
// §6.4 (Sep 25 2026): the route choice lives in Your Month's opening prompt.
// The call card shows where the month stands and links there (`routeHref`)
// instead of carrying its own buttons. (The old layout's in-card "plan
// without a call" buttons went with that layout, Oct 6 2026.)
export function ScheduleTab({ planning, planningFailed, months, scheduleFailed, slotDays, bookingUrl, sessions, perms, readOnly, topicsHref, topicsLabel, routeHref, selectedMonthId, selectedSessionIndex }: {
  planning: PortalPlanning | null;
  planningFailed: boolean;
  months: PortalScheduleMonth[];
  scheduleFailed: boolean;
  slotDays: PortalSlotDay[];
  bookingUrl: string;
  sessions: { id: string; shootDate: Date | null; title: string | null; addressLine: string | null; status: string }[];
  perms: { session: boolean };
  readOnly: boolean;
  /** Where the month's topics and questions are — Your Month. */
  topicsHref: string;
  /** What that page is called ("Your Month"). */
  topicsLabel: string;
  /** Your Month's route step — the one place the planning route is chosen. */
  routeHref: string;
  selectedMonthId?: string | null;
  selectedSessionIndex?: number | null;
}) {
  // The choice is made in Your Month; this card only links there.
  const switchLink = (label: string) => p?.noCallEligible && !readOnly && perms.session
    ? <Link href={routeHref} className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{label} <ChevronRight className="size-3" /></Link>
    : null;
  const p = planning;
  const tz = p?.timezone ?? "America/New_York";
  // Each time is labelled with its own date's zone (EST in late November),
  // never today's (Sep 28).
  const zoneOf = (iso: string | Date) => tzShort(tz, new Date(iso));
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
            {p.catchUp && <p className="font-medium text-brand">{p.catchUp.line}</p>}
            {p.catchUp?.nextCallISO && <p className="text-xs text-muted">Your call to plan the {p.catchUp.label} videos is booked for {fmtDate(p.catchUp.nextCallISO, tz)} at {fmtTime(p.catchUp.nextCallISO, tz)} {zoneOf(p.catchUp.nextCallISO)}.</p>}
            {p.clientPlanned && p.callStatus === "NOT_REQUIRED" ? (
              // Oct 8 2026: they plan their own videos and have no strategy call.
              <p className="text-muted">Your program doesn&rsquo;t include a strategy call — you plan your videos and we film them.</p>
            ) : p.planningMode === "WRITTEN" && !p.clientPlanned ? (
              <>
                <div className="flex items-center gap-1.5 font-medium"><PenLine className="size-4 text-brand" /> Planning in writing — no call this month</div>
                <p className="text-xs text-muted">{p.answersSubmitted ? "Your answers are in; session booking opened from there." : p.interviewsOpen ? <>{p.interviewsOpen} topic{p.interviewsOpen === 1 ? "" : "s"} still need{p.interviewsOpen === 1 ? "s" : ""} answers in <Link href={topicsHref} className="font-medium text-brand hover:underline">{topicsLabel}</Link>.</> : <>Pick your topics in <Link href={topicsHref} className="font-medium text-brand hover:underline">{topicsLabel}</Link> and answer the questions. You can book filming as soon as your answers are in, for a time at least three weekdays (72 weekday hours) later.</>}</p>
                {p.callStatus === "SCHEDULED" && p.callAtISO && <p className="text-xs text-muted">A call is still booked for {fmtDate(p.callAtISO, tz)} at {fmtTime(p.callAtISO, tz)} {zoneOf(p.callAtISO)} — cancel it on Calendly if you no longer need it.</p>}
                {/* Not a one-way door: the same eligibility that offered the
                    written path offers the call back (review, Sep 17). */}
                {switchLink("Change how you plan this month")}
              </>
            ) : p.callStatus === "COMPLETED" ? (
              <div className="flex items-center gap-1.5 text-success"><CheckCircle2 className="size-4" /> Held{p.callAtISO ? ` on ${fmtDate(p.callAtISO, tz)}` : ""} — the month is planned.</div>
            ) : p.callStatus === "SCHEDULED" && p.callAtISO ? (
              <>
                <div><span className="rounded-md bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">Booked</span></div>
                <div className="font-medium">{fmtDate(p.callAtISO, tz)}</div>
                <div className="flex items-center gap-1.5 text-muted"><Clock className="size-3.5" /> {fmtTime(p.callAtISO, tz)}{p.callEndISO ? `–${fmtTime(p.callEndISO, tz)}` : ""} {zoneOf(p.callAtISO)}</div>
                {p.meetLink ? <a href={p.meetLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"><Video className="size-3.5" /> Join on Google Meet</a> : <div className="text-xs text-muted-2">Video call — the link is in your calendar invite.</div>}
                <p className="text-xs text-muted">To reschedule or cancel, use the links in your Calendly confirmation email — the change shows here within the hour.</p>
                {/* §3: filming opens the moment the call is booked, measured from the call's end. */}
                <p className="text-xs text-muted">You can book filming now, before the call. Sessions start at least three weekdays (72 weekday hours) after the call ends.</p>
                {switchLink("Change how you plan this month")}
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
                  <a href={bookingUrl} target={/^https?:/.test(bookingUrl) ? "_blank" : undefined} rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Book one anyway <ChevronRight className="size-3.5" /></a>
                )}
              </>
            ) : (
              <>
                <div className="text-muted">Not booked yet — we plan {monthLabel(p.monthKey)} on this call, then film it.</div>
                {!readOnly && (
                  <a href={bookingUrl} target={/^https?:/.test(bookingUrl) ? "_blank" : undefined} rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-brand-action px-4 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Book the call <ChevronRight className="size-4" /></a>
                )}
                <p className="text-xs text-muted-2">Times show in your timezone on Calendly; it lands here as Booked once it&rsquo;s on the calendar.</p>
                {switchLink("Or choose your topics here instead")}
              </>
            )}
          </div>
        )}
      </Card>

      {/* Content session */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> Schedule content session</div>
        {scheduleFailed ? <LoadFailed what="your session months" /> : <PortalScheduler months={months} bookingUrl={bookingUrl} days={slotDays} readOnly={!perms.session || readOnly} timezone={tz} selectedMonthId={selectedMonthId} selectedSessionIndex={selectedSessionIndex} />}
      </div>

      {/* Sessions on the calendar */}
      <Card>
        <CardTitle icon={Camera}>Sessions · all program months</CardTitle>
        {sessions.filter((s) => s.shootDate).length === 0 ? (
          <p className="mt-2 text-sm text-muted">No sessions on the calendar yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sessions.filter((s) => s.shootDate).slice(0, 12).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="flex items-center gap-1.5"><CalendarClock className={cn("size-4", s.shootDate! >= now ? "text-brand" : "text-muted-2")} /> {fmtDate(s.shootDate!, tz)}</span>
                <span className="flex items-center gap-1.5 text-muted"><Clock className="size-4" /> {fmtTime(s.shootDate!, tz)} {zoneOf(s.shootDate!)}</span>
                {streetOf(s.title, s.addressLine) && <span className="flex items-center gap-1.5 text-muted"><MapPin className="size-4" /> {streetOf(s.title, s.addressLine)}</span>}
                {s.shootDate! >= now ? <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">upcoming</span> : s.status === "DELIVERED" ? <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span> : <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">held</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
