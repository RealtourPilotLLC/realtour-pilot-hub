"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Camera, CheckCircle2, Loader2, Lock, MapPin } from "lucide-react";
import { portalRequestSession } from "@/app/portal/actions";

// The scheduling card — strategy call first, always; the session scheduler
// unlocks once the call is on the books. Captures preferred times + the
// filming LOCATION in one place; the live-Aryeo slot picker replaces the
// free-text time field when it ships, same card.
export function PortalScheduler({
  token, callBooked, bookingUrl, hasUpcomingSession,
}: {
  token: string; callBooked: boolean; bookingUrl: string; hasUpcomingSession: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [location, setLocation] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

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
          {hasUpcomingSession ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5" /> Booked — details up top</p>
          ) : !callBooked ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-2"><Lock className="size-3.5" /> Unlocks after your strategy call is booked</p>
          ) : done ? (
            <p className="mt-1.5 text-xs font-medium text-success">{done}</p>
          ) : !open ? (
            <>
              <p className="mt-1.5 text-xs text-muted">Tell us when works and where we&rsquo;re filming.</p>
              <button onClick={() => setOpen(true)}
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                Schedule my session
              </button>
            </>
          ) : (
            <div className="mt-2 space-y-2">
              <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="Days/times that work — e.g. Tue or Thu afternoon"
                className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand" />
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5">
                <MapPin className="size-3.5 shrink-0 text-muted-2" />
                <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Filming location (address or area)"
                  className="w-full bg-transparent text-xs outline-none" />
              </div>
              <div className="flex gap-1.5">
                <button disabled={busy || !when.trim() || !location.trim()}
                  onClick={() => start(async () => {
                    const r = await portalRequestSession(token, { when, location }).catch(() => ({ ok: false, message: "That didn't send — try again." }));
                    if (r.ok) setDone(r.message); else setErr(r.message);
                  })}
                  className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {busy && <Loader2 className="size-3 animate-spin" />} Send
                </button>
                <button onClick={() => setOpen(false)} className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted">Cancel</button>
              </div>
              {err && <p className="text-[11px] text-danger">{err}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
