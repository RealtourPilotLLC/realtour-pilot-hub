"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Camera, CheckCircle2, ChevronRight, Loader2, Lock, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalRequestSession } from "@/app/portal/actions";
import type { PortalSlotDay } from "@/lib/portal";

// The scheduling card, clean (Jordan, Aug 28): finished states collapse to
// slim ✓ rows; the live picker gets room — big day pills, a real time grid,
// then location, then one full-width book button naming the exact slot.
// Slots are live Aryeo availability, already past the 3-business-day prep
// window; the desk confirms the booking in Aryeo.

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

function StatusRow({ icon: Icon, tone, children }: { icon: typeof CheckCircle2; tone: "ok" | "muted"; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-center gap-2 text-sm", tone === "ok" ? "text-success" : "text-muted-2")}>
      <Icon className="size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function PortalScheduler({
  token, callBooked, bookingUrl, hasUpcomingSession, monthDone = false, days = [],
}: {
  token: string; callBooked: boolean; bookingUrl: string; hasUpcomingSession: boolean;
  monthDone?: boolean;
  days?: PortalSlotDay[];
}) {
  const [day, setDay] = useState<string | null>(days[0]?.date ?? null);
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
  const showPicker = callBooked && !hasUpcomingSession && !monthDone && !done;

  return (
    <div className="rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur sm:p-5">
      <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Scheduling</div>

      {/* Strategy call — a slim row when handled, a clear CTA when not. */}
      <div className="mt-3">
        {callBooked ? (
          <StatusRow icon={CheckCircle2} tone="ok">Strategy call — on the books for this month</StatusRow>
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
        {monthDone ? (
          <StatusRow icon={CheckCircle2} tone="ok">Filming session — this month&rsquo;s is in the can</StatusRow>
        ) : hasUpcomingSession ? (
          <StatusRow icon={CheckCircle2} tone="ok">Filming session — booked, details up top</StatusRow>
        ) : !callBooked ? (
          <StatusRow icon={Lock} tone="muted">Session booking unlocks after your strategy call</StatusRow>
        ) : done ? (
          <StatusRow icon={CheckCircle2} tone="ok">{done}</StatusRow>
        ) : null}

        {showPicker && (
          <div className="mt-1">
            <div className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> Book your filming session</div>

            {days.length > 0 ? (
              <>
                <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-2">Pick a day</div>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {days.map((d) => (
                    <button key={d.date} onClick={() => { setDay(d.date); setSlot(null); }}
                      className={cn(
                        "rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors",
                        day === d.date ? "border-brand bg-brand text-white shadow" : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground",
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
                        <button key={s} onClick={() => setSlot(s)}
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
              </label>
            )}

            <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-2">Where are we filming?</div>
            <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2.5 focus-within:border-brand">
              <MapPin className="size-4 shrink-0 text-muted-2" />
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Address or area — your office, a listing, a coffee shop…"
                className="w-full bg-transparent text-sm outline-none" />
            </div>

            <button
              disabled={busy || !location.trim() || (days.length > 0 ? !slot : !when.trim())}
              onClick={send}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90 disabled:opacity-40"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {slot && day ? `Book ${dayLabel(day)} at ${timeLabel(slot)}` : "Send my request"}
            </button>
            {err && <p className="mt-2 text-xs text-danger">{err}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
