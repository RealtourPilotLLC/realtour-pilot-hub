"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Camera, CheckCircle2, ChevronRight, Clock, Info, Loader2, Lock, MapPin, MoveRight, Phone, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalRequestSession, portalRescheduleSession, portalSaveSessionPlanAddress, portalSessionSlots, portalSubmitSessionAddress } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { PortalSlotDay, PortalScheduleMonth } from "@/lib/portal";
import type { SessionSlotsResult, TravelLabel, TravelSlotDay } from "@/lib/sessionTravel";
import { CancelRequestButton } from "@/components/portal/PlanningChoice";

// The scheduling card, clean (Jordan, Aug 28): finished states collapse to
// slim ✓ rows; the live picker gets room — big day pills, a real time grid,
// then location, then one full-width book button naming the exact slot.
// Slots are live Aryeo availability for the client's own package.
//
// Since Sep 17 the card is PER PROGRAM MONTH: the client picks which month
// the session is for (this month by default), and each month carries its own
// gate (the preparation window after the call, or the answers sent),
// capacity and the requests already made. A request is a durable row, so
// "Requested, awaiting confirmation" is what the page says after a reload,
// not a green tick that vanished (SYNTHESIS §4). The server re-render after a
// send (router.refresh) is what puts the new row on the page.
//
// CP-04 / CP-05 (Sep 24 2026):
//   · REQUESTED AND BOOKED ARE DIFFERENT ROWS. "Booked" comes only from the
//     month's distinct sessions (the month-progress reader), one per session,
//     so a Pro month with one of two on the calendar reads "1 of 2 booked" —
//     never "booked" because ANY request confirmed.
//   · Each slot names who films it (Aryeo's own assignment to the product);
//     with more than one free, the client picks.
//   · Inside 24 hours is a phone call: the line under the picker says so, and
//     the server refuses those slots with the same number.
//   · How the booking happens is said plainly: desk-assisted (Kyle books it by
//     hand) unless the hub books this client itself.
//   · A session booked with only an area asks for the exact address, per session.
//
// §6.6 W02 (Sep 25 2026) — EXACT ADDRESS FIRST. Booking a session is now three
// steps, per session (Pro picks "Session 1" or "Session 2" first): where
// (portalSaveSessionPlanAddress — a structured street address, saved on the
// session's plan, so "Schedule later" keeps it), then the times FROM that
// address (portalSessionSlots — live availability with the drive from and to
// the videographer's other shoots already checked), then who and Book. A time
// whose drive could not be checked says "Kyle confirms" and is requested, never
// booked by the hub on its own. The `days` prop is no longer the list offered:
// it is the package's base availability, kept for callers that still pass it.

/** Kyle's line. A literal because this is a client component; the server's is
 *  reviewWindows.URGENT_CONTACT, and the two must say the same thing. */
const KYLE = { display: "(215) 645-4889", e164: "+12156454889" };

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
// The client's own timezone (enrollment.timezone, ET by default) — every
// time on this card is printed in it and labelled with it.
const tzName = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "ET";
const timeLabel = (iso: string, tz: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const whenLabel = (iso: string, tz: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
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

function KyleLine() {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
      <Phone className="size-3.5" /> Need something in the next 24 hours? Call or text Kyle at
      <a href={`tel:${KYLE.e164}`} className="font-semibold text-brand hover:underline">{KYLE.display}</a>
      <span aria-hidden>·</span>
      <a href={`sms:${KYLE.e164}`} className="font-semibold text-brand hover:underline">text</a>
    </p>
  );
}

/** One request, in the client's words: what they asked for and where it stands. */
function RequestRow({ r, readOnly, tz, selfBooking, onMove, moving }: { r: PortalScheduleMonth["requests"][number]; readOnly: boolean; tz: string; selfBooking: boolean; onMove: (id: string) => void; moving: boolean }) {
  const conflict = r.status === "REQUESTED" && r.bookingState === "CONFLICT";
  const tone = r.status === "CONFIRMED" ? "ok" : conflict || r.status === "DECLINED" ? "bad" : OPEN.has(r.status) ? "pending" : "muted";
  const Icon = tone === "ok" ? CheckCircle2 : tone === "bad" ? XCircle : Clock;
  const preferred = /^Preferred:\s*(.+)$/m.exec(r.notes ?? "")?.[1];
  return (
    <li className={cn("rounded-xl border bg-surface px-3.5 py-2.5", moving ? "border-brand" : "border-border")}>
      <StatusRow icon={Icon} tone={tone}>
        <span className="font-semibold">{r.label}</span>
        <span className="block text-xs text-muted">
          {r.slotStartISO ? `${whenLabel(r.slotStartISO, tz)} ${tzName(tz)}` : preferred ? `Preferred: ${preferred}` : "Time to be confirmed"}
          {r.creativeName ? ` · with ${r.creativeName}` : ""}
          {r.locationText ? ` · ${r.locationText}` : ""}
        </span>
      </StatusRow>
      {!readOnly && r.canChange && !conflict && (
        <div className="mt-1 flex items-center gap-3">
          <button type="button" onClick={() => onMove(r.id)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-2 hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
            <MoveRight className="size-3" /> {moving ? "Pick the new time below" : "Change time"}
          </button>
          <CancelRequestButton requestId={r.id} confirmed={r.status === "CONFIRMED"} selfBooked={selfBooking && r.status === "CONFIRMED"} />
        </div>
      )}
    </li>
  );
}

/** The exact address for one session (CP-05) — the portal's copy of the emailed link's form. */
function AddressForm({ sessionKey, onDone }: { sessionKey: string; onDone: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ street: "", unit: "", city: "", state: "", zip: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const go = () => start(async () => {
    const r = await portalSubmitSessionAddress(portalAuthFromLocation(), sessionKey, f).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { onDone(); router.refresh(); }
  });
  const input = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand";
  return (
    <div className="mt-2 grid gap-2 rounded-xl border border-border bg-surface-2/40 p-3 sm:grid-cols-6">
      <input aria-label="Street address" placeholder="Street address (117 Kyle Lane)" value={f.street} onChange={set("street")} className={cn(input, "sm:col-span-4")} />
      <input aria-label="Unit" placeholder="Unit (optional)" value={f.unit} onChange={set("unit")} className={cn(input, "sm:col-span-2")} />
      <input aria-label="City" placeholder="City" value={f.city} onChange={set("city")} className={cn(input, "sm:col-span-3")} />
      <input aria-label="State" placeholder="State" maxLength={2} value={f.state} onChange={set("state")} className={cn(input, "sm:col-span-1")} />
      <input aria-label="ZIP" placeholder="ZIP" inputMode="numeric" maxLength={10} value={f.zip} onChange={set("zip")} className={cn(input, "sm:col-span-2")} />
      <div className="flex items-center gap-2 sm:col-span-6">
        <button type="button" onClick={go} disabled={busy || !f.street.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {busy && <Loader2 className="size-3 animate-spin" />} Save the address
        </button>
        {msg && <span role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</span>}
      </div>
    </div>
  );
}

/** §6.6 W02: step one of booking a session — its exact address, saved on the session's plan. */
function PlanAddressStep({ monthId, sessionIndex, lead, onSaved, onCancel }: { monthId: string; sessionIndex: number; lead: string | null; onSaved: () => void; onCancel: (() => void) | null }) {
  const [f, setF] = useState({ street: "", unit: "", city: "", state: "", zip: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const go = () => start(async () => {
    const r = await portalSaveSessionPlanAddress(portalAuthFromLocation(), monthId, sessionIndex, f).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) onSaved();
  });
  const input = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand";
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Where are we filming?</div>
      {lead && <p className="mt-1 text-xs text-muted">{lead}</p>}
      <div className="mt-1.5 grid gap-2 rounded-xl border border-border bg-surface-2/40 p-3 sm:grid-cols-6">
        <input aria-label="Street address" placeholder="Street address (117 Kyle Lane)" autoComplete="address-line1" value={f.street} onChange={set("street")} className={cn(input, "sm:col-span-4")} />
        <input aria-label="Unit" placeholder="Unit (optional)" autoComplete="address-line2" value={f.unit} onChange={set("unit")} className={cn(input, "sm:col-span-2")} />
        <input aria-label="City" placeholder="City" autoComplete="address-level2" value={f.city} onChange={set("city")} className={cn(input, "sm:col-span-3")} />
        <input aria-label="State" placeholder="State" maxLength={2} autoComplete="address-level1" value={f.state} onChange={set("state")} className={cn(input, "sm:col-span-1")} />
        <input aria-label="ZIP" placeholder="ZIP" inputMode="numeric" maxLength={10} autoComplete="postal-code" value={f.zip} onChange={set("zip")} className={cn(input, "sm:col-span-2")} />
        <div className="flex flex-wrap items-center gap-2 sm:col-span-6">
          <button type="button" onClick={go} disabled={busy || !f.street.trim() || !f.city.trim() || !f.zip.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 className="size-3 animate-spin" />} Save and see times
          </button>
          {onCancel && <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-foreground">Keep the saved address</button>}
          {msg && <span role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</span>}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">We need the exact address to check the drive from your videographer&rsquo;s other shoots before we offer a time.</p>
    </div>
  );
}

export function PortalScheduler({
  months, bookingUrl, days = [], readOnly = false, timezone = "America/New_York", embedded = false,
}: {
  /** This month and the open ones after it — each with its gate, capacity and requests. Empty = no open month yet. */
  months: PortalScheduleMonth[];
  bookingUrl: string;
  /** The package's Aryeo availability; filtered here by the chosen month's earliest moment. */
  days?: PortalSlotDay[];
  /** A paused/ended program or a viewer-only seat: no booking, no requests. */
  readOnly?: boolean;
  /** IANA zone every time on the card is printed in. */
  timezone?: string;
  /**
   * Your Month's "Book filming" step (§6.4): the same picker, the same data and
   * the same server actions, without the card's own planning row — the steps
   * above it already say where the call and the answers stand.
   */
  embedded?: boolean;
}) {
  const tz = timezone;
  const router = useRouter();
  // Land on the first month that still has something to do — an open request
  // to watch, or room to book. A month whose session is filmed (or fully
  // requested) gives way to the next one, so late in the month the client sees
  // next month's picker instead of a finished card.
  const initial = months.find((m) => m.requests.some((r) => OPEN.has(r.status)) || m.capacity.remaining > 0) ?? months[0] ?? null;
  const [monthId, setMonthId] = useState<string | null>(initial?.monthId ?? null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [creative, setCreative] = useState<string | null>(null);
  const [when, setWhen] = useState("");
  const [moving, setMoving] = useState<string | null>(null);
  const [addressFor, setAddressFor] = useState<string | null>(null);
  // §6.6 W02: which session is being booked, and its times from its address.
  const [sessionPick, setSessionPick] = useState<number | null>(null);
  const [slotsRes, setSlotsRes] = useState<{ key: string; res: SessionSlotsResult } | null>(null);
  const [editAddress, setEditAddress] = useState(false);
  const [reload, setReload] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const month = months.find((m) => m.monthId === monthId) ?? months[0] ?? null;
  void days; // the package's base availability; the offer is per session, from its address (below)
  // The session this picker books: the one picked, else the next still to book.
  // Booked sessions AND every session already held (a pending ask, a hand
  // booking): the server refuses a second live ask for any of them.
  const bookedIndexes = new Set([...(month?.sessions ?? []).map((x) => x.sessionIndex), ...(month?.takenIndexes ?? [])]);
  const pickIdx = sessionPick ?? month?.sessionIndex ?? 1;
  const slotsKey = month ? `${month.monthId}:${pickIdx}:${moving ?? ""}:${reload}` : "";
  const res = slotsRes && slotsRes.key === slotsKey ? slotsRes.res : null;
  // Slots this session may actually take: the server already applied its gate
  // (which carries the 24-hour floor — those are a phone call, see KyleLine).
  const monthDays: TravelSlotDay[] = month && !month.locked && res?.ok ? res.days.slice(0, 6) : [];
  const activeDay = monthDays.find((d) => d.date === day) ?? monthDays[0] ?? null;
  const slotCreatives = slot && activeDay?.slotCreatives?.[slot] ? activeDay.slotCreatives[slot] : [];
  const chosenCreative = slotCreatives.length === 1 ? slotCreatives[0].teamMemberId : creative;
  const chosenTravel: TravelLabel | null = slot && activeDay ? (chosenCreative ? activeDay.slotCreativeTravel[slot]?.[chosenCreative] ?? null : activeDay.slotTravel[slot] ?? null) : null;
  const needsAddress = !moving && !!res && (res.needsAddress || editAddress);

  const pickMonth = (id: string) => { setMonthId(id); setSessionPick(null); setEditAddress(false); setDay(null); setSlot(null); setCreative(null); setMoving(null); setDone(null); setErr(null); };
  const pickSlot = (s: string) => { setSlot(s); setCreative(null); };

  const send = () =>
    start(async () => {
      if (!month) return;
      setErr(null);
      const auth = portalAuthFromLocation();
      // §6.6 W02: the WHERE is the session's plan, at the version these times came from.
      const plan = { planId: res?.planId ?? null, addressVersion: res?.addressVersion ?? null };
      const r = moving && slot
        // A move keeps the booked session's own address (its times were measured from it).
        ? await portalRescheduleSession(auth, moving, { slotISO: slot, creativeTeamMemberId: chosenCreative, location: null }).catch(() => ({ ok: false, message: "That didn't send. Try again." }))
        : await portalRequestSession(
            auth,
            // A24: the session this picker books (its gate is the one shown).
            slot ? { monthId: month.monthId, slotISO: slot, creativeTeamMemberId: chosenCreative, sessionIndex: pickIdx, ...plan } : { monthId: month.monthId, when, sessionIndex: pickIdx, ...plan },
          ).catch(() => ({ ok: false, message: "That didn't send. Try again." }));
      if (r.ok) {
        setDone(r.message);
        setSlot(null);
        setMoving(null);
        // The request is a row now: re-render from the server so the list
        // below carries it (and keeps carrying it after any reload).
        router.refresh();
      } else {
        setErr(r.message);
        router.refresh();
      }
    });

  const openRequests = month ? month.requests.filter((r) => OPEN.has(r.status)) : [];
  const selfBooking = month?.bookingMode === "SELF";
  const sessions = month?.sessions ?? [];
  const required = month?.sessionsRequired ?? 1;
  const writtenPath = !!month && month.planningMode === "WRITTEN";
  const monthFull = !!month && month.capacity.remaining <= 0;
  const showPicker = !!month && !readOnly && !month.locked && (!monthFull || !!moving) && !done;

  // §6.6 W02: the session's times, read from its address whenever the picker
  // opens on a session (or the address changes). A move reads the times from
  // the booked session's own address.
  useEffect(() => {
    if (!showPicker || !month) return;
    let live = true;
    const key = slotsKey;
    portalSessionSlots(portalAuthFromLocation(), month.monthId, pickIdx, { moveRequestId: moving })
      .catch((): SessionSlotsResult => ({ ok: false, message: "We could not load the times. Try again.", days: [] }))
      .then((r) => { if (live) setSlotsRes({ key, res: r }); });
    return () => { live = false; };
  }, [showPicker, slotsKey, month, pickIdx, moving]);
  const needsCreativePick = !!slot && slotCreatives.length > 1 && !creative;
  const requestRows = month ? month.requests.filter((r) => r.status !== "CONFIRMED" || (r.canChange && !readOnly)) : [];

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
        <p className="mt-3 text-sm text-muted">Your next program month isn&rsquo;t open yet. We&rsquo;ll set it up and it will show here.</p>
      ) : (
        <>
          {months.length === 1 && <div className="mt-1 text-sm font-semibold">{monthLabel(month.monthKey)}</div>}

          {/* Strategy call / planning — a slim row when handled, a clear CTA when not. */}
          {!embedded && <div className="mt-3">
            {writtenPath ? (
              <StatusRow icon={month.locked ? Clock : CheckCircle2} tone={month.locked ? "muted" : "ok"}>
                {month.locked ? "Planning in writing: send us your answers and session booking opens" : "Planning in writing: answers received"}
              </StatusRow>
            ) : month.callStatus === "COMPLETED" ? (
              <StatusRow icon={CheckCircle2} tone="ok">Strategy call held{month.callAtISO ? ` ${new Date(month.callAtISO).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })}` : ""}</StatusRow>
            ) : month.callStatus === "SCHEDULED" ? (
              <StatusRow icon={CheckCircle2} tone="ok">Strategy call booked{month.callAtISO ? ` for ${whenLabel(month.callAtISO, tz)} ${tzName(tz)}` : " for this month"}</StatusRow>
            ) : month.callStatus === "NOT_REQUIRED" ? (
              // NOT_REQUIRED means the program has no strategy call at all —
              // say that, never a tick implying one is booked.
              <StatusRow icon={Info} tone="muted">Your program doesn&rsquo;t include a strategy call. We plan the month from your topics and answers.</StatusRow>
            ) : month.callStatus === "SKIPPED" ? (
              // SKIPPED means no call exists for this month. The client still
              // needs a way to get one, so the booking link stays reachable.
              <div className="flex flex-wrap items-center justify-between gap-3">
                <StatusRow icon={Info} tone="muted">No strategy call this month.</StatusRow>
                {!readOnly && (
                  <a href={bookingUrl} target={/^https?:/.test(bookingUrl) ? "_blank" : undefined} rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                    Book one anyway <ChevronRight className="size-3.5" />
                  </a>
                )}
              </div>
            ) : readOnly ? (
              <StatusRow icon={Lock} tone="muted">Strategy calls resume when your program does</StatusRow>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/25 bg-brand-soft/30 p-3.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CalendarClock className="size-4 shrink-0 text-brand" /> We plan your month on a strategy call. Book it first.
                </div>
                <a href={bookingUrl} target={/^https?:/.test(bookingUrl) ? "_blank" : undefined} rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                  Book the call <ChevronRight className="size-4" />
                </a>
              </div>
            )}
          </div>}

          {/* Filming sessions — one row per DISTINCT session on the calendar. */}
          <div className={cn("mt-3", !embedded && "border-t border-border pt-3")}>
            {sessions.length > 0 && (
              <ul className="space-y-2">
                {sessions.map((s, i) => (
                  <li key={s.key}>
                    <StatusRow icon={CheckCircle2} tone={s.state === "CONFIRMING" ? "pending" : "ok"}>
                      <span className="font-semibold">{required > 1 ? `Session ${s.sessionIndex ?? i + 1} of ${required}: ` : "Filming session: "}{s.label}</span>
                      <span className="block text-xs text-muted">
                        {s.startISO ? `${whenLabel(s.startISO, tz)} ${tzName(tz)}` : "Date being confirmed"}
                        {s.area ? ` · ${s.area}` : ""}
                        {s.addressNote ? ` · ${s.addressNote}` : ""}
                      </span>
                      {/* A25: the office is reassessing it. Nothing has moved. */}
                      {s.kyleConfirming && <span className="block text-xs font-medium text-foreground">Kyle will confirm your filming time with you.</span>}
                    </StatusRow>
                    {s.addressNeeded && !readOnly && (
                      addressFor === s.key
                        ? <AddressForm sessionKey={s.key} onDone={() => setAddressFor(null)} />
                        : (
                          <button type="button" onClick={() => setAddressFor(s.key)} className="ml-6 mt-1 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
                            <MapPin className="size-3.5" /> Add the exact address
                          </button>
                        )
                    )}
                  </li>
                ))}
              </ul>
            )}
            {sessions.length > 0 && month.sessionsMissing > 0 && (
              <p className="mt-2 text-xs text-muted">{month.sessionsMissing} of {required} session{required === 1 ? "" : "s"} still to book this month.</p>
            )}
            {sessions.length === 0 && month.locked && <StatusRow icon={Lock} tone="muted">{month.reason}</StatusRow>}

            {/* The asks: everything not yet a booked session, plus a booked one
                the client may still move or cancel (a confirmed row is otherwise
                already on the list above as its session). */}
            {requestRows.length > 0 && (
              <ul className="mt-2 space-y-2">
                {requestRows.map((r) => (
                  <RequestRow key={r.id} r={r} readOnly={readOnly} tz={tz} selfBooking={selfBooking} moving={moving === r.id}
                    onMove={(id) => { setMoving(moving === id ? null : id); setSlot(null); setDone(null); }} />
                ))}
              </ul>
            )}
            {done && <div className="mt-2"><StatusRow icon={CheckCircle2} tone="ok">{done}</StatusRow></div>}

            {showPicker && (
              <div className="mt-2">
                <div className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> {moving ? "Pick the new time" : openRequests.length || sessions.length ? "Book another session" : "Book your filming session"}</div>

                {/* Pro: which session (each has its own address, times and state). */}
                {!moving && required > 1 && (
                  <div className="mt-2 flex flex-wrap gap-1.5" role="tablist" aria-label="Which session">
                    {Array.from({ length: required }, (_, i) => i + 1).filter((i) => !bookedIndexes.has(i)).map((i) => (
                      <button key={i} type="button" role="tab" aria-selected={pickIdx === i}
                        onClick={() => { setSessionPick(i); setEditAddress(false); setDay(null); setSlot(null); setCreative(null); setErr(null); }}
                        className={cn("rounded-lg border px-2.5 py-1 text-xs font-semibold", pickIdx === i ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground")}>
                        Session {i} of {required}
                      </button>
                    ))}
                  </div>
                )}

                {!res ? (
                  <p className="mt-3 flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Checking the times{moving ? "" : " from your filming address"}…</p>
                ) : !res.ok && !res.needsAddress ? (
                  <p className="mt-3 text-sm text-muted">{res.message}</p>
                ) : (
                  <>
                    {/* Step 1: where. An exact address, before any time is offered. */}
                    {!moving && (
                      needsAddress ? (
                        <PlanAddressStep monthId={month.monthId} sessionIndex={pickIdx} lead={res.needsAddress ? res.message : null}
                          onSaved={() => { setEditAddress(false); setSlot(null); setDay(null); setReload((n) => n + 1); }}
                          onCancel={res.needsAddress ? null : () => setEditAddress(false)} />
                      ) : (
                        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <MapPin className="size-4 shrink-0 text-muted-2" />
                          <span className="font-medium">{res.addressLine}</span>
                          <button type="button" onClick={() => setEditAddress(true)} className="text-xs font-semibold text-brand hover:underline">Change</button>
                        </div>
                      )
                    )}

                    {/* Step 2: when, from that address. */}
                    {!needsAddress && (monthDays.length > 0 ? (
                      <>
                        <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-2">Pick a day</div>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {monthDays.map((d) => (
                            <button key={d.date} type="button" onClick={() => { setDay(d.date); setSlot(null); setCreative(null); }}
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
                                <button key={s} type="button" onClick={() => pickSlot(s)}
                                  className={cn(
                                    "rounded-xl border px-2 py-2 text-sm font-medium tabular-nums transition-colors",
                                    slot === s ? "border-brand bg-brand-soft font-semibold text-brand" : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground",
                                  )}>
                                  {timeLabel(s, tz)}
                                  {activeDay.slotCreatives?.[s]?.length === 1 && <span className="block text-[10px] font-normal text-muted-2">{activeDay.slotCreatives[s][0].name.split(" ")[0]}</span>}
                                  {activeDay.slotTravel[s] === "UNCHECKED" && <span className="block text-[10px] font-normal text-muted-2">Kyle confirms</span>}
                                </button>
                              ))}
                            </div>
                            {slot && slotCreatives.length > 1 && (
                              <div className="mt-3">
                                <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Who would you like?</div>
                                <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label="Videographer">
                                  {slotCreatives.map((c) => (
                                    <button key={c.teamMemberId} type="button" role="radio" aria-checked={creative === c.teamMemberId} onClick={() => setCreative(c.teamMemberId)}
                                      className={cn("rounded-xl border px-3 py-1.5 text-sm", creative === c.teamMemberId ? "border-brand bg-brand-soft font-semibold text-brand" : "border-border bg-surface text-muted hover:text-foreground")}>
                                      {c.name}
                                      {activeDay.slotCreativeTravel[slot]?.[c.teamMemberId] === "UNCHECKED" && <span className="ml-1 text-[10px] font-normal text-muted-2">(Kyle confirms)</span>}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                            {Object.values(activeDay.slotTravel).includes("UNCHECKED") && (
                              <p className="mt-2 text-xs text-muted">&ldquo;Kyle confirms&rdquo;: we could not check the drive from your videographer&rsquo;s other shoot that day, so Kyle confirms that time by hand.</p>
                            )}
                          </>
                        )}
                      </>
                    ) : moving ? (
                      <p className="mt-3 text-xs text-muted">No open times to move to right now. Call or text Kyle and he will find one.</p>
                    ) : (
                      <label className="mt-3 block">
                        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">When works?</span>
                        {res.message && <span className="mt-1 block text-xs text-muted">{res.message}</span>}
                        <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. Tuesday or Thursday afternoon"
                          className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-brand" />
                        {(res.earliestISO ?? month.earliestISO) && (
                          <span className="mt-1 block text-xs text-muted">Sessions start on or after {new Date((res.earliestISO ?? month.earliestISO)!).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" })}.</span>
                        )}
                      </label>
                    ))}

                    {/* Step 3: book (or request). */}
                    {!needsAddress && (
                      <>
                        <button
                          type="button"
                          disabled={busy || (monthDays.length > 0 ? !slot || needsCreativePick : !when.trim() || !!moving)}
                          onClick={send}
                          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90 disabled:opacity-40"
                        >
                          {busy && <Loader2 className="size-4 animate-spin" />}
                          {slot && activeDay ? `${moving ? "Move to" : selfBooking && chosenTravel !== "UNCHECKED" ? "Book" : "Request"} ${dayLabel(activeDay.date)} at ${timeLabel(slot, tz)}` : "Send my request"}
                        </button>
                        <p className="mt-1.5 text-xs text-muted">
                          {chosenTravel === "UNCHECKED"
                            ? "Kyle confirms this time by hand, so it shows as requested until he does."
                            : selfBooking
                            ? "This books straight into our calendar. It shows as booked once the calendar confirms it."
                            : "Desk-assisted booking: Kyle books your pick in our calendar by hand, so it shows as requested until he confirms it."}
                        </p>
                      </>
                    )}
                  </>
                )}
                <KyleLine />
                {err && <p className="mt-2 text-xs text-danger">{err}</p>}
              </div>
            )}
            {!showPicker && !readOnly && month && !month.locked && <KyleLine />}
          </div>
        </>
      )}
    </div>
  );
}
