"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Camera, CheckCircle2, ChevronRight, Clock, Loader2, Lock, MapPin, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalRequestSession } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { PortalSlotDay, PortalScheduleMonth } from "@/lib/portal";

// The scheduling card, clean (Jordan, Aug 28): finished states collapse to
// slim ✓ rows; the live picker gets room — big day pills, a real time grid,
// then location, then one full-width book button naming the exact slot.
// Slots are live Aryeo availability; the desk confirms the booking in Aryeo.
//
// Since Sep 17 the card is PER PROGRAM MONTH: the client picks which month
// the session is for (this month by default), and each month carries its own
// gate (3 business days after the call was held — or the answers sent),
// capacity and the requests already made. A request is a durable row, so
// "Requested, awaiting confirmation" is what the page says after a reload,
// not a green tick that vanished (SYNTHESIS §4). The server re-render after a
// send (router.refresh) is what puts the new row on the page.

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const whenLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const monthLabel = (monthKey: string) => {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
};

const OPEN = new Set(["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"]);

function StatusRow({ icon: Icon, tone, children }: { icon: typeof CheckCircle2; tone: "ok" | "muted" | "pending" | "bad"; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2 text-sm", tone === "ok" ? "text-success" : tone === "pending" ? "text-brand" : tone === "bad" ? "text-danger" : "text-muted-2")}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** One request, in the client's words: what they asked for and where it stands. */
function RequestRow({ r }: { r: PortalScheduleMonth["requests"][number] }) {
  const tone = r.status === "CONFIRMED" ? "ok" : r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED" || r.status === "CANCEL_REQUESTED" ? "pending" : r.status === "DECLINED" ? "bad" : "muted";
  const Icon = tone === "ok" ? CheckCircle2 : tone === "pending" ? Clock : tone === "bad" ? XCircle : Clock;
  const preferred = /^Preferred:\s*(.+)$/m.exec(r.notes ?? "")?.[1];
  return (
    <li className="rounded-xl border border-border bg-surface px-3.5 py-2.5">
      <StatusRow icon={Icon} tone={tone}>
        <span className="font-semibold">{r.label}</span>
        <span className="block text-xs text-muted">
          {r.slotStartISO ? `${whenLabel(r.slotStartISO)} ET` : preferred ? `Preferred: ${preferred}` : "Time to be confirmed"}
          {r.locationText ? ` · ${r.locationText}` : ""}
        </span>
      </StatusRow>
    </li>
  );
}

export function PortalScheduler({
  months, bookingUrl, days = [], readOnly = false,
}: {
  /** This month and the open ones after it — each with its gate, capacity and requests. Empty = no open month yet. */
  months: PortalScheduleMonth[];
  bookingUrl: string;
  /** Company-wide Aryeo availability; filtered here by the chosen month's earliest moment. */
  days?: PortalSlotDay[];
  /** A paused/ended program or a viewer-only seat: no booking, no requests. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  // Land on the first month that still has something to do — an open request
  // to watch, or room to book. A month whose session is filmed (or fully
  // requested) gives way to the next one, so late in the month the client sees
  // next month's picker instead of a finished card.
  const initial = months.find((m) => m.requests.some((r) => OPEN.has(r.status)) || m.capacity.remaining > 0) ?? months[0] ?? null;
  const [monthId, setMonthId] = useState<string | null>(initial?.monthId ?? null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [when, setWhen] = useState("");
  const [location, setLocation] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const month = months.find((m) => m.monthId === monthId) ?? months[0] ?? null;
  // Slots this month may actually take: on or after its earliest moment.
  const earliest = month?.earliestISO ? new Date(month.earliestISO).getTime() : Infinity;
  const monthDays = month && !month.locked
    ? days.map((d) => ({ date: d.date, slots: d.slots.filter((s) => new Date(s).getTime() >= earliest) })).filter((d) => d.slots.length > 0).slice(0, 6)
    : [];
  const activeDay = monthDays.find((d) => d.date === day) ?? monthDays[0] ?? null;

  const pickMonth = (id: string) => { setMonthId(id); setDay(null); setSlot(null); setDone(null); setErr(null); };

  const send = () =>
    start(async () => {
      if (!month) return;
      setErr(null);
      const r = await portalRequestSession(
        portalAuthFromLocation(),
        slot ? { monthId: month.monthId, slotISO: slot, location } : { monthId: month.monthId, when, location },
      ).catch(() => ({ ok: false, message: "That didn't send — try again." }));
      if (r.ok) {
        setDone(r.message);
        setSlot(null);
        // The request is a row now: re-render from the server so the list
        // below carries it (and keeps carrying it after any reload).
        router.refresh();
      } else setErr(r.message);
    });

  const openRequests = month ? month.requests.filter((r) => OPEN.has(r.status)) : [];
  const booked = !!month && (!!month.bookedShootISO || month.requests.some((r) => r.status === "CONFIRMED"));
  const filmed = !!month?.bookedShootISO && new Date(month.bookedShootISO) < new Date();
  const callBooked = !!month && month.callStatus !== "NOT_SCHEDULED";
  const writtenPath = !!month && month.planningMode === "WRITTEN";
  const monthFull = !!month && month.capacity.remaining <= 0;
  const showPicker = !!month && !readOnly && !month.locked && !monthFull && !done;

  return (
    <div className="rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Scheduling</div>
        {months.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Which month">
            {months.map((m) => (
              <button key={m.monthId} type="button" role="tab" aria-selected={m.monthId === month?.monthId} onClick={() => pickMonth(m.monthId)}
                className={cn("rounded-lg border px-2.5 py-1 text-xs font-semibold", m.monthId === month?.monthId ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground")}>
                {monthLabel(m.monthKey)}
              </button>
            ))}
          </div>
        )}
      </div>

      {!month ? (
        <p className="mt-3 text-sm text-muted">Your next program month isn&rsquo;t open yet — we&rsquo;ll set it up and it will show here.</p>
      ) : (
        <>
          {months.length === 1 && <div className="mt-1 text-sm font-semibold">{monthLabel(month.monthKey)}</div>}

          {/* Strategy call / planning — a slim row when handled, a clear CTA when not. */}
          <div className="mt-3">
            {writtenPath ? (
              <StatusRow icon={month.locked ? Clock : CheckCircle2} tone={month.locked ? "muted" : "ok"}>
                {month.locked ? "Planning in writing — send us your answers and session booking opens" : "Planning in writing — answers received"}
              </StatusRow>
            ) : month.callStatus === "COMPLETED" ? (
              <StatusRow icon={CheckCircle2} tone="ok">Strategy call — held{month.callAtISO ? ` ${new Date(month.callAtISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}</StatusRow>
            ) : month.callStatus === "SCHEDULED" ? (
              <StatusRow icon={CheckCircle2} tone="ok">Strategy call — booked{month.callAtISO ? ` for ${whenLabel(month.callAtISO)} ET` : " for this month"}</StatusRow>
            ) : callBooked ? (
              <StatusRow icon={CheckCircle2} tone="ok">Strategy call — on the books for this month</StatusRow>
            ) : readOnly ? (
              <StatusRow icon={Lock} tone="muted">Strategy calls resume when your program does</StatusRow>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/25 bg-brand-soft/30 p-3.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CalendarClock className="size-4 shrink-0 text-brand" /> We plan your month on a strategy call — book it first.
                </div>
                <a href={bookingUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                  Book the call <ChevronRight className="size-4" />
                </a>
              </div>
            )}
          </div>

          {/* Filming session */}
          <div className="mt-3 border-t border-border pt-3">
            {booked ? (
              <StatusRow icon={CheckCircle2} tone="ok">
                {filmed ? `Filming session — filmed ${whenLabel(month.bookedShootISO!)} ET` : `Filming session — booked${month.bookedShootISO ? ` for ${whenLabel(month.bookedShootISO)} ET` : ""}`}
              </StatusRow>
            ) : month.locked ? (
              <StatusRow icon={Lock} tone="muted">{month.reason}</StatusRow>
            ) : monthFull && openRequests.length === 0 ? (
              <StatusRow icon={CheckCircle2} tone="ok">Filming session — this month&rsquo;s is in the can</StatusRow>
            ) : null}

            {month.requests.length > 0 && (
              <ul className="mt-2 space-y-2">
                {month.requests.map((r) => <RequestRow key={r.id} r={r} />)}
              </ul>
            )}
            {done && <div className="mt-2"><StatusRow icon={CheckCircle2} tone="ok">{done}</StatusRow></div>}

            {showPicker && (
              <div className="mt-2">
                <div className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> {openRequests.length ? "Request another time" : "Book your filming session"}</div>

                {monthDays.length > 0 ? (
                  <>
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-2">Pick a day</div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {monthDays.map((d) => (
                        <button key={d.date} type="button" onClick={() => { setDay(d.date); setSlot(null); }}
                          className={cn(
                            "rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors",
                            activeDay?.date === d.date ? "border-brand bg-brand text-white shadow" : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground",
                          )}>
                          {dayLabel(d.date)}
                        </button>
                      ))}
                    </div>
                    {activeDay && (
                      <>
                        <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-2">Pick a time</div>
                        <div className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-4">
                          {activeDay.slots.map((s) => (
                            <button key={s} type="button" onClick={() => setSlot(s)}
                              className={cn(
                                "rounded-xl border px-2 py-2 text-sm font-medium tabular-nums transition-colors",
                                slot === s ? "border-brand bg-brand-soft font-semibold text-brand" : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground",
                              )}>
                              {timeLabel(s)}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <label className="mt-3 block">
                    <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">When works?</span>
                    <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. Tuesday or Thursday afternoon"
                      className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-brand" />
                    {month.earliestISO && (
                      <span className="mt-1 block text-xs text-muted">Sessions start on or after {new Date(month.earliestISO).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" })}.</span>
                    )}
                  </label>
                )}

                <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-2">Where are we filming?</div>
                <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2.5 focus-within:border-brand">
                  <MapPin className="size-4 shrink-0 text-muted-2" />
                  <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Address or area — your office, a listing, a coffee shop…"
                    className="w-full bg-transparent text-sm outline-none" />
                </div>

                <button
                  type="button"
                  disabled={busy || !location.trim() || (monthDays.length > 0 ? !slot : !when.trim())}
                  onClick={send}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90 disabled:opacity-40"
                >
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {slot && activeDay ? `Request ${dayLabel(activeDay.date)} at ${timeLabel(slot)}` : "Send my request"}
                </button>
                <p className="mt-1.5 text-xs text-muted">We confirm every session by hand — it shows as &ldquo;awaiting confirmation&rdquo; until it&rsquo;s on the calendar.</p>
                {err && <p className="mt-2 text-xs text-danger">{err}</p>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
