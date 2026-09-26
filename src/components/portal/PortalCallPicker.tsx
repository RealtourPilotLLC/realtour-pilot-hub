"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalBookCall, portalCallScheduled, portalCallSlots, portalRefreshCall } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { CalendlyInline, type CalendlyScheduled } from "@/components/portal/CalendlyInline";
import { TEXT_KYLE_START } from "@/lib/portalWords";
import type { BookCallResult, CallSlot, PortalCallBookingView } from "@/lib/callBooking";

// ---------------------------------------------------------------------------
// BOOK YOUR STRATEGY CALL — inside the portal (W03, Sep 25 2026). One of:
//   EMBED  the mapped Calendly page, prefilled and tokened; when it says
//          "scheduled" the server re-reads the booking and files it at once;
//   API    open times from Calendly, a week at a time, each showing when
//          filming could start if the call were then (the call's END plus the
//          preparation window — the same number the filming step will show);
//   NONE   no monthly booking page is set up: Kyle's number.
// A booked call offers its own Change / Cancel pages (Calendly's, embedded).
// Everything the client is told comes back from the server.
// ---------------------------------------------------------------------------

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const btn = cn("inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold sm:min-h-9", focusRing);

type Msg = { ok: boolean; text: string } | null;

export function PortalCallPicker({ view }: { view: PortalCallBookingView }) {
  const router = useRouter();
  const tz = view.timezone || "America/New_York";
  const [mode, setMode] = useState(view.mode);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, start] = useTransition();
  const [panel, setPanel] = useState<"reschedule" | "cancel" | null>(null);
  const toEmbed = useCallback(() => setMode("EMBED"), []);

  const afterScheduled = useCallback((s: CalendlyScheduled) => {
    setMsg({ ok: true, text: "Checking your booking…" });
    start(async () => {
      const r: BookCallResult = await portalCallScheduled(portalAuthFromLocation(), { eventUri: s.eventUri }).catch(() => ({ ok: false, state: "PENDING" as const, message: "Thanks. Your booking will show here within the hour." }));
      setMsg({ ok: r.ok || r.state === "PENDING", text: r.ok ? withFilming(r.message, r.filmingFromISO ?? null, tz) : r.message });
      if (r.ok) { setPanel(null); router.refresh(); }
    });
  }, [router, tz]);

  if (!view.canBook && !view.booked) return null;

  if (view.booked) {
    const b = view.booked;
    return (
      <div className="mt-2 space-y-2">
        {view.canBook && (b.rescheduleUrl || b.cancelUrl) && (
          <div className="flex flex-wrap gap-2">
            {b.rescheduleUrl && <button type="button" onClick={() => setPanel(panel === "reschedule" ? null : "reschedule")} className={cn(btn, "border border-border text-foreground hover:bg-surface")} aria-expanded={panel === "reschedule"}>Change the time</button>}
            {b.cancelUrl && <button type="button" onClick={() => setPanel(panel === "cancel" ? null : "cancel")} className={cn(btn, "border border-border text-muted hover:bg-surface")} aria-expanded={panel === "cancel"}>Cancel the call</button>}
          </div>
        )}
        {panel === "reschedule" && b.rescheduleUrl && <CalendlyInline url={b.rescheduleUrl} title="Change your strategy call" onScheduled={afterScheduled} />}
        {panel === "cancel" && b.cancelUrl && (
          <div className="space-y-2">
            <CalendlyInline url={b.cancelUrl} title="Cancel your strategy call" />
            <button type="button" disabled={busy} onClick={() => start(async () => {
              const r = await portalRefreshCall(portalAuthFromLocation(), view.monthId).catch(() => ({ ok: false, message: "We couldn't reach the calendar. Your change will show here within the hour." }));
              setMsg({ ok: r.ok, text: r.message });
              if (r.ok) { setPanel(null); router.refresh(); }
            })} className={cn(btn, "bg-brand text-white hover:opacity-90 disabled:opacity-50")}>{busy && <Loader2 className="size-3.5 animate-spin" />} I&rsquo;ve cancelled it. Update my page</button>
          </div>
        )}
        {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
      </div>
    );
  }

  if (mode === "NONE") {
    return <p className="mt-2 text-xs text-muted">{TEXT_KYLE_START} and we&rsquo;ll book your strategy call with you.</p>;
  }

  return (
    <div className="mt-3 space-y-2">
      {mode === "API"
        ? <SlotPicker view={view} tz={tz} onFallback={toEmbed} />
        : view.embedUrl && <CalendlyInline url={view.embedUrl} fallbackUrl={view.linkUrl} onScheduled={afterScheduled} />}
      {busy && mode !== "API" && <p className="flex items-center gap-1.5 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Saving your booking…</p>}
      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

function withFilming(message: string, filmingFromISO: string | null, tz: string): string {
  if (!filmingFromISO) return message;
  return `${message} You can book filming now, for ${new Date(filmingFromISO).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} or later.`;
}

function SlotPicker({ view, tz, onFallback }: { view: PortalCallBookingView; tz: string; onFallback: () => void }) {
  const router = useRouter();
  const [page, setPage] = useState<{ fromISO: string | null; slots: CallSlot[]; next: string | null; prev: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState<CallSlot | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, start] = useTransition();

  // One week of open times. State is written only when the answer is back, so
  // the first page can be asked for from an effect; paging also clears the
  // pick and shows "loading" first.
  const [from, setFrom] = useState<{ iso: string | null; n: number }>({ iso: null, n: 0 });
  useEffect(() => {
    let alive = true;
    portalCallSlots(portalAuthFromLocation(), view.monthId, from.iso)
      .catch(() => ({ ok: false as const, message: "We couldn't load the open times just now. Try again in a minute." }))
      .then((r) => {
        if (!alive) return;
        setLoading(false);
        if (!r.ok) {
          if ("fallback" in r && r.fallback === "EMBED") { onFallback(); return; }
          setMsg({ ok: false, text: r.message });
          return;
        }
        setMsg(null);
        setPage({ fromISO: r.fromISO, slots: r.slots, next: r.nextFromISO, prev: r.prevFromISO });
      });
    return () => { alive = false; };
  }, [view.monthId, from, onFallback]);
  const load = (fromISO: string | null) => { setLoading(true); setPick(null); setFrom((f) => ({ iso: fromISO, n: f.n + 1 })); };

  const days = useMemo(() => {
    const out = new Map<string, CallSlot[]>();
    for (const s of page?.slots ?? []) {
      const key = new Date(s.startISO).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
      out.set(key, [...(out.get(key) ?? []), s]);
    }
    return [...out.entries()];
  }, [page, tz]);
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const tzName = new Date().toLocaleTimeString("en-US", { timeZone: tz, timeZoneName: "short" }).split(" ").pop();

  const book = () => pick && start(async () => {
    const r: BookCallResult = await portalBookCall(portalAuthFromLocation(), view.monthId, pick.startISO).catch(() => ({ ok: false, state: "PENDING" as const, message: "We're confirming your booking with the calendar. This page will update in a minute." }));
    setMsg({ ok: r.ok || r.state === "PENDING", text: r.ok ? withFilming(r.message, r.filmingFromISO ?? null, tz) : r.message });
    if (r.ok) router.refresh();
    else if (r.state === "FAILED") void load(page?.fromISO ?? null);
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button type="button" disabled={!page?.prev || loading} onClick={() => void load(page?.prev ?? null)} className={cn("inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:text-foreground disabled:opacity-40 sm:min-h-0", focusRing)}><ChevronLeft className="size-3.5" aria-hidden /> Earlier</button>
        <span className="text-[11px] text-muted-2">Times in {tzName}</span>
        <button type="button" disabled={!page?.next || loading} onClick={() => void load(page?.next ?? null)} className={cn("inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:text-foreground disabled:opacity-40 sm:min-h-0", focusRing)}>Later <ChevronRight className="size-3.5" aria-hidden /></button>
      </div>
      {loading ? (
        <p className="flex items-center gap-1.5 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Loading open times…</p>
      ) : days.length === 0 ? (
        <p className="text-xs text-muted">No open times this week. Try later dates.</p>
      ) : (
        <ul className="space-y-2" aria-label="Open call times">
          {days.map(([day, slots]) => (
            <li key={day}>
              <div className="text-xs font-semibold">{day}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {slots.map((s) => (
                  <button key={s.startISO} type="button" onClick={() => setPick(s)} aria-pressed={pick?.startISO === s.startISO}
                    className={cn("min-h-11 rounded-lg border px-3 text-sm tabular-nums sm:min-h-8", focusRing, pick?.startISO === s.startISO ? "border-brand bg-brand text-white" : "border-border bg-surface hover:border-brand/50")}>
                    {time(s.startISO)}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {pick && (
        <div className="rounded-xl border border-brand/30 bg-brand-soft/30 p-3 text-sm">
          <div className="flex items-center gap-1.5 font-medium"><CalendarClock className="size-4 text-brand" aria-hidden /> {when(pick.startISO)}</div>
          <p className="mt-0.5 text-xs text-muted">With this call, filming can be booked for {when(pick.filmingFromISO)} or later.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={book} disabled={busy} className={cn(btn, "bg-brand text-white hover:opacity-90 disabled:opacity-50")}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-4" aria-hidden />} Book this time</button>
            <button type="button" onClick={() => setPick(null)} className={cn(btn, "border border-border text-muted hover:bg-surface")}>Pick another</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}
