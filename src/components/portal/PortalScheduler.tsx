"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Camera, CheckCircle2, Loader2, Lock, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalRequestSession } from "@/app/portal/actions";
import type { PortalSlotDay } from "@/lib/portal";

// The scheduling card — strategy call first, always; the session picker
// unlocks once the call is on the books and shows REAL Aryeo availability,
// already filtered past the 3-business-day prep window. The desk gets the
// exact slot to confirm in Aryeo.

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

export function PortalScheduler({
  token, callBooked, bookingUrl, hasUpcomingSession, monthDone = false, days = [],
}: {
  token: string; callBooked: boolean; bookingUrl: string; hasUpcomingSession: boolean;
  monthDone?: boolean;
  days?: PortalSlotDay[];
}) {
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [when, setWhen] = useState("");
  const [location, setLocation] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const send = () =>
    start(async () => {
      const r = await portalRequestSession(token, slot ? { slotISO: slot, location } : { when, location }).catch(() => ({ ok: false, message: "That didn't send — try again." }));
      if (r.ok) setDone(r.message);
      else setErr(r.message);
    });

  const activeDay = days.find((d) => d.date === day) ?? null;

  return (
    <div className="rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
      <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Scheduling</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {/* Strategy call */}
        <div className="rounded-xl border border-border bg-surface-2/50 p-3.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold"><CalendarClock className="size-4 text-brand" /> Strategy call</div>
          {callBooked ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5" /> On the books for this month</p>
          ) : (
            <>
              <p className="mt-1.5 text-xs text-muted">We plan your month on this call — book it first.</p>
              <a href={bookingUrl} target="_blank" rel="noopener noreferrer"
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                Book the call
              </a>
            </>
          )}
        </div>

        {/* Content session */}
        <div className="rounded-xl border border-border bg-surface-2/50 p-3.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold"><Camera className="size-4 text-brand" /> Filming session</div>
          {monthDone ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5" /> Filmed — this month&rsquo;s session is in the can</p>
          ) : hasUpcomingSession ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5" /> Booked — details up top</p>
          ) : !callBooked ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-2"><Lock className="size-3.5" /> Unlocks after your strategy call is booked</p>
          ) : done ? (
            <p className="mt-1.5 text-xs font-medium text-success">{done}</p>
          ) : (
            <div className="mt-2 space-y-2">
              {days.length > 0 ? (
                <>
                  <p className="text-[11px] text-muted-2">Live availability — pick a day, then a time:</p>
                  <div className="flex flex-wrap gap-1">
                    {days.map((d) => (
                      <button key={d.date} onClick={() => { setDay(d.date); setSlot(null); }}
                        className={cn("rounded-lg border px-2 py-1 text-[11px] font-semibold",
                          day === d.date ? "border-brand bg-brand text-white" : "border-border text-muted hover:bg-surface")}>
                        {dayLabel(d.date)}
                      </button>
                    ))}
                  </div>
                  {activeDay && (
                    <div className="flex flex-wrap gap-1">
                      {activeDay.slots.map((s) => (
                        <button key={s} onClick={() => setSlot(s)}
                          className={cn("rounded-lg border px-2 py-1 text-[11px] font-medium tabular-nums",
                            slot === s ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface")}>
                          {timeLabel(s)}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="Days/times that work — e.g. Tue or Thu afternoon"
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand" />
              )}
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5">
                <MapPin className="size-3.5 shrink-0 text-muted-2" />
                <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Filming location (address or area)"
                  className="w-full bg-transparent text-xs outline-none" />
              </div>
              <button disabled={busy || !location.trim() || (days.length > 0 ? !slot : !when.trim())}
                onClick={send}
                className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                {busy && <Loader2 className="size-3 animate-spin" />} {slot ? `Book ${timeLabel(slot)}` : "Send"}
              </button>
              {err && <p className="text-[11px] text-danger">{err}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
