import Link from "next/link";
import { CalendarClock, Camera, ChevronRight, Clock, MapPin, Video } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalPlanning, PortalScheduleMonth } from "@/lib/portal";
import { portalMonthHref } from "@/lib/portalScheduling";
import { SESSION_WORDS, type Word } from "@/lib/portalWords";
import { StatusChip, fmtDate, fmtTime, tzShort } from "@/components/portal/ui";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// COMING UP (Oct 21 2026). The read-only list of booked strategy calls and
// filming sessions (and filming asked for, while we confirm it), soonest
// first, each linking to the Your Month step where it is changed or
// cancelled, then the months still to book.
//
// It was the Schedule page (C14, Oct 13 2026). Jordan, Oct 21: Messages takes
// Schedule's place in the portal's bottom bar, and this list folds into Home
// (every booked call and session, in the month card, where Home showed only
// this month's; booking stays Home's next step) and Your Month (the OTHER
// months, with what is still to book, below this month's steps, which
// already show its own call and sessions), so nothing appears twice on one
// page. Booking, changing and cancelling stay in Your
// Month; More links there too. No slots are loaded and nothing here writes.
// ---------------------------------------------------------------------------

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const PENDING = new Set(["REQUESTED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"]);

type Item = {
  key: string;
  kind: "call" | "filming";
  title: string;
  word: Word;
  atISO: string | null;
  details: string[];
  /** Where we film, when on file. */
  place?: string | null;
  meet?: string | null;
  href: string | null;
  hrefLabel: string;
};

export type ComingUpProps = {
  planning: PortalPlanning | null;
  months: PortalScheduleMonth[];
  perms: { session: boolean };
  readOnly: boolean;
  /** Where the month is planned and booked — Your Month. */
  topicsHref: string;
  /** What that page is called ("Your Month"). */
  topicsLabel: string;
  /** Your Month: the months whose steps (or late-session card) already show their call and filming. */
  excludeMonthIds?: string[];
  /** Home lists the planning month's strategy call too; Your Month's call step already shows it. */
  includeCall?: boolean;
  /** Your Month lists the other months still to book; Home leaves booking to its next step. */
  showToBook?: boolean;
};

/** What is coming up, as data: the booked items soonest first, and the months with filming still to book. */
export function comingUpItems({ planning: p, months, perms, readOnly, topicsHref, topicsLabel, excludeMonthIds = [], includeCall = true, showToBook = true }: ComingUpProps): { items: Item[]; toBook: PortalScheduleMonth[] } {
  const now = new Date().getTime();
  const canChange = perms.session && !readOnly;
  const monthName = (key: string) => monthLabel(key).split(" ")[0];
  const skip = new Set(excludeMonthIds);
  // A late month's session is booked from its host month's card (#step-late).
  const filmingHref = (m: PortalScheduleMonth) => m.late ? `${portalMonthHref(topicsHref, m.late.hostMonthKey)}#step-late` : `${portalMonthHref(topicsHref, m.monthKey)}#step-filming`;

  const items: Item[] = [];
  if (includeCall && p && p.callStatus === "SCHEDULED" && p.callAtISO && Date.parse(p.callAtISO) > now - 3600_000) {
    items.push({
      key: "call", kind: "call", title: "Strategy call", word: SESSION_WORDS.BOOKED, atISO: p.callAtISO,
      details: [`To plan your ${monthName(p.monthKey)} videos`, p.meetLink ? "" : "Video call. The link is in your calendar invite."].filter(Boolean),
      meet: p.meetLink ?? null,
      href: canChange ? `${portalMonthHref(topicsHref, p.monthKey)}#step-call` : null, hrefLabel: "Change or cancel",
    });
  }
  if (includeCall && p?.catchUp?.nextCallISO && Date.parse(p.catchUp.nextCallISO) > now - 3600_000) {
    items.push({ key: "catch-up-call", kind: "call", title: "Strategy call", word: SESSION_WORDS.BOOKED, atISO: p.catchUp.nextCallISO, details: [`To plan your ${p.catchUp.label} videos`], href: null, hrefLabel: "" });
  }
  const shown = months.filter((m) => !skip.has(m.monthId));
  for (const m of shown) {
    const forWhat = m.late?.combined ? `For your ${monthName(m.monthKey)} and ${monthName(m.late.hostMonthKey)} videos` : `For your ${monthName(m.monthKey)} videos`;
    m.sessions.forEach((s, i) => {
      if (s.state !== "BOOKED" && s.state !== "CONFIRMING") return;
      if (s.startISO && Date.parse(s.startISO) < now) return;
      items.push({
        key: `s:${m.monthId}:${s.key}`, kind: "filming",
        title: m.sessionsRequired > 1 ? `Filming session ${s.sessionIndex ?? i + 1} of ${m.sessionsRequired}` : "Filming session",
        word: SESSION_WORDS[s.state], atISO: s.startISO,
        place: [s.area, s.addressNote].filter(Boolean).join(" · ") || null,
        details: [forWhat, s.kyleConfirming ? "Kyle will confirm your filming time with you." : "", s.addressNeeded ? `We still need the exact address. Add it in ${topicsLabel}.` : ""].filter(Boolean),
        href: canChange ? filmingHref(m) : null, hrefLabel: s.addressNeeded ? "Add the address" : "Change or cancel",
      });
    });
    for (const r of m.requests) {
      if (!PENDING.has(r.status) || (r.status === "REQUESTED" && r.bookingState === "CONFLICT")) continue;
      items.push({
        key: `r:${r.id}`, kind: "filming", title: "Filming session", word: { ...SESSION_WORDS.REQUESTED, label: r.label }, atISO: r.slotStartISO,
        details: [forWhat], place: r.locationText,
        href: canChange && r.canChange ? filmingHref(m) : null, hrefLabel: "Change or cancel",
      });
    }
  }
  items.sort((a, b) => (a.atISO ?? "9999").localeCompare(b.atISO ?? "9999"));
  // Months with filming still to book. Your Month says why one is not open yet.
  const toBook = !showToBook ? [] : shown.filter((m) => m.sessionsMissing > 0 && m.capacity.remaining > 0 && !m.requests.some((r) => PENDING.has(r.status) && !(r.status === "REQUESTED" && r.bookingState === "CONFLICT")));
  return { items, toBook };
}

/** The list itself. Renders nothing when nothing is booked and nothing is left to book. */
export function ComingUpList(props: ComingUpProps) {
  const { items, toBook } = comingUpItems(props);
  if (items.length === 0 && toBook.length === 0) return null;
  const tz = props.planning?.timezone ?? "America/New_York";
  // Each time is labelled with its own date's zone (EST in late November), never today's (Sep 28).
  const zoneOf = (iso: string) => tzShort(tz, new Date(iso));
  const when = (iso: string) => `${fmtDate(iso, tz)} at ${fmtTime(iso, tz)} ${zoneOf(iso)}`;
  const canChange = props.perms.session && !props.readOnly;
  const monthHref = (m: PortalScheduleMonth) => m.late ? `${portalMonthHref(props.topicsHref, m.late.hostMonthKey)}#step-late` : `${portalMonthHref(props.topicsHref, m.monthKey)}#step-filming`;
  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <ul className="space-y-3" aria-label="Coming up">
          {items.map((it) => {
            const Icon = it.kind === "call" ? CalendarClock : Camera;
            return (
              <li key={it.key} className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-semibold">{it.title}</span>
                    <StatusChip word={it.word} />
                  </p>
                  <p className={cn("mt-0.5 flex items-center gap-1.5 text-sm", it.atISO ? "font-medium" : "text-muted")}>
                    <Clock className="size-3.5 shrink-0 text-muted-2" aria-hidden /> {it.atISO ? when(it.atISO) : "Time to be confirmed"}
                  </p>
                  {it.place && <p className="mt-0.5 flex items-start gap-1.5 text-xs text-muted"><MapPin className="mt-0.5 size-3 shrink-0" aria-hidden /> {it.place}</p>}
                  {it.details.map((line, i) => <p key={i} className="mt-0.5 text-xs text-muted">{line}</p>)}
                  {(it.meet || it.href) && (
                    <div className="flex flex-wrap items-center gap-x-4">
                      {it.meet && <a href={it.meet} target="_blank" rel="noopener noreferrer" className={cn("inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline", focusRing)}><Video className="size-3.5" aria-hidden /> Join on Google Meet</a>}
                      {it.href && <Link href={it.href} className={cn("inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline", focusRing)}>{it.hrefLabel} <ChevronRight className="size-3.5" aria-hidden /></Link>}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {toBook.length > 0 && (
        <div className={items.length > 0 ? "border-t border-border pt-3" : ""}>
          <div className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" aria-hidden /> Still to book</div>
          <ul className="mt-1 space-y-0.5">
            {toBook.map((m) => (
              <li key={m.monthId} className="flex flex-wrap items-center gap-x-2 text-sm">
                <span>{m.tabLabel ?? `${monthLabel(m.monthKey)} filming`}{m.sessionsRequired > 1 ? ` (${m.sessionsMissing} of ${m.sessionsRequired} sessions)` : ""}</span>
                {canChange && <Link href={monthHref(m)} className={cn("inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline", focusRing)}>Book in {props.topicsLabel} <ChevronRight className="size-3.5" aria-hidden /></Link>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
