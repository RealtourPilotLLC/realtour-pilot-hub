"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, PenLine, Phone, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalCancelSessionRequest, portalPlanWithCall, portalPlanWithoutCall, portalScheduleLater } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { CTA_WORDS } from "@/lib/portalWords";

/** "Plan without a call" — rendered ONLY when the server says the enrollment is eligible. Sets the written path; never cancels a booked call. */
export function PlanWithoutCall({ monthId, callBooked }: { monthId: string; callBooked: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const go = () => start(async () => {
    const r = await portalPlanWithoutCall(portalAuthFromLocation(), monthId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setConfirm(false); router.refresh(); }
  });
  return (
    <div className="mt-2">
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><PenLine className="size-3.5" /> Choose my topics here instead</button>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-3 text-sm">
          <p>Choose your topics here? You&rsquo;ll pick topics and answer a few short questions per topic. You can book filming as soon as your answers are in, for a time at least three weekdays (72 weekday hours) later.</p>
          {callBooked && <p className="mt-1 text-xs text-muted">Your booked call stays on the calendar — cancel it on Calendly separately if you no longer need it.</p>}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={go} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3 animate-spin" />} Yes, choose them here</button>
            <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Keep the call</button>
          </div>
        </div>
      )}
      {msg && <p role="status" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

/** The way back: "actually, I'd rather have the call". Rendered only when the
 *  enrollment is eligible for either path, so it can never appear on a program
 *  whose months are always planned in writing. */
export function PlanWithCall({ monthId }: { monthId: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const go = () => start(async () => {
    const r = await portalPlanWithCall(portalAuthFromLocation(), monthId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) router.refresh();
  });
  return (
    <div className="mt-2">
      <button type="button" onClick={go} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy ? <Loader2 className="size-3 animate-spin" /> : <Phone className="size-3.5" />} Talk through topics on a call instead</button>
      {msg && <p role="status" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

/**
 * THE OPENING PROMPT OF YOUR MONTH (§6.4, Sep 25 2026): "How would you like to
 * plan this month's videos?" — two equal cards, the same two server actions
 * the Schedule page's buttons use. Rendered only when the server says the
 * month may go either way (portalPlanning.noCallEligible). Choosing stamps
 * the month (planningChosenAt); switching later keeps every piece of work.
 * `current`: which route is already chosen, so its card reads as selected.
 */
export function RouteChoice({ monthId, current, large = true }: { monthId: string; current: "CALL" | "WRITTEN" | "UNDECIDED"; large?: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<"CALL" | "WRITTEN" | null>(null);
  const [busy, start] = useTransition();
  const choose = (route: "CALL" | "WRITTEN") => {
    setPending(route);
    start(async () => {
      const fn = route === "WRITTEN" ? portalPlanWithoutCall : portalPlanWithCall;
      const r = await fn(portalAuthFromLocation(), monthId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };
  const card = (route: "CALL" | "WRITTEN", Icon: typeof PenLine, title: string, body: string) => {
    const chosen = current === route;
    return (
      <button type="button" onClick={() => choose(route)} disabled={busy || chosen} aria-pressed={chosen}
        className={cn("flex w-full flex-col items-start gap-1 rounded-2xl border p-4 text-left transition-colors disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", large && "min-h-24", chosen ? "border-brand bg-brand-soft/40" : "border-border bg-surface hover:border-brand/50")}>
        <span className="flex items-center gap-2 text-sm font-semibold">
          {busy && pending === route ? <Loader2 className="size-4 animate-spin text-brand" aria-hidden /> : <Icon className="size-4 text-brand" aria-hidden />} {title}
        </span>
        <span className="text-xs text-muted">{body}</span>
        {chosen && <span className="text-[11px] font-semibold text-brand">Your choice this month</span>}
      </button>
    );
  };
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {card("WRITTEN", PenLine, "Choose my topics here", "Pick your topics and answer a few short questions for each. Your progress saves as you go. Filming can be booked once your answers are in.")}
        {card("CALL", Phone, "Talk through topics on a call", "Book a strategy call and we choose the topics together. Filming can be booked as soon as the call is. Browsing topics first is optional.")}
      </div>
      {msg && <p role="status" className={cn("mt-2 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

/**
 * "Schedule later" beside the filming picker (§6.4). Saves the choice on the
 * server so it survives a refresh; the step stays outstanding and the booking
 * picker stays right there. Never starts a new reminder stream.
 */
export function ScheduleLaterButton({ monthId, deferred, sessionIndex = null }: { monthId: string; deferred: boolean; /** A21: the session being deferred (Pro: 1 or 2); omitted = the next one still to book, which is what the picker beside it books. */ sessionIndex?: number | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  if (deferred) {
    return <p className="mt-2 flex items-center gap-1.5 text-xs text-muted"><CalendarClock className="size-3.5" aria-hidden /> You chose to schedule later — book any time above.</p>;
  }
  const go = () => start(async () => {
    const r = await portalScheduleLater(portalAuthFromLocation(), monthId, sessionIndex).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) router.refresh();
  });
  return (
    <div className="mt-2">
      <button type="button" onClick={go} disabled={busy} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border px-4 text-sm font-medium text-muted hover:bg-surface hover:text-foreground disabled:opacity-50 sm:min-h-9 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CalendarClock className="size-4" aria-hidden />} {CTA_WORDS.LATER}
      </button>
      {msg && <p role="status" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

/** Cancel one of the client's own session requests — the real cancellation, offered separately from any planning choice.
 *  `selfBooked` (CP-04): the hub booked it itself, so it cancels it itself — "Cancel session", not "Ask to cancel".
 *  Inside 24 hours the server refuses with Kyle's number, and that message is what shows. */
export function CancelRequestButton({ requestId, confirmed, selfBooked = false }: { requestId: string; confirmed: boolean; selfBooked?: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const go = () => start(async () => {
    const r = await portalCancelSessionRequest(portalAuthFromLocation(), requestId).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    setMsg(r.message);
    setConfirm(false);
    if (r.ok) router.refresh();
  });
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 text-[11px]">
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-2 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><XCircle className="size-3" /> {selfBooked ? "Cancel session" : confirmed ? "Ask to cancel" : "Cancel"}</button>
      ) : (
        <>
          <span className="text-muted">{selfBooked ? "Cancel this session?" : confirmed ? "Ask us to cancel this session?" : "Cancel this request?"}</span>
          <button type="button" onClick={go} disabled={busy} className="rounded-md bg-danger px-2 py-0.5 font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Yes</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-md border border-border px-2 py-0.5 text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">No</button>
        </>
      )}
      {msg && <span role="status" className="text-muted">{msg}</span>}
    </span>
  );
}
