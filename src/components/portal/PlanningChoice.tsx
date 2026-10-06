"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, PenLine, Phone, Undo2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalCancelSessionRequest, portalPlanUndecided, portalPlanWithCall, portalPlanWithoutCall, portalScheduleLater } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { CTA_WORDS } from "@/lib/portalWords";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";

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
        <Button variant="secondary" onClick={() => setConfirm(true)}><PenLine aria-hidden className="size-4" /> Choose my topics here instead</Button>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-3 text-sm">
          <p>Choose your topics here? You&rsquo;ll pick topics and answer a few short questions per topic. You can book filming as soon as your answers are in, for a time at least three weekdays (72 weekday hours) later.</p>
          {callBooked && <p className="mt-1 text-xs text-muted">Your booked call stays on the calendar — cancel it on Calendly separately if you no longer need it.</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={go} busy={busy} busyLabel="Saving choice…">Yes, choose them here</Button>
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>Keep the call</Button>
          </div>
        </div>
      )}
      {msg && <div className="mt-1.5"><SaveStatus state={msg.ok ? "info" : "error"} message={msg.text} /></div>}
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
      <Button variant="secondary" onClick={go} busy={busy} busyLabel="Saving choice…"><Phone aria-hidden className="size-4" /> Talk through topics on a call instead</Button>
      {msg && <div className="mt-1.5"><SaveStatus state={msg.ok ? "info" : "error"} message={msg.text} /></div>}
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
 *
 * UNDO (Oct 6 2026). Jordan: the client must be able to undo the choice.
 *   · Right after a tap, the confirmation carries an "Undo" that puts the
 *     month back exactly as it was (the sealed token the choice returned).
 *   · Later, under "Change how you plan this month", "Undo my choice" sends
 *     the month back to no choice — the two cards again — unless the server
 *     says it can't honestly be undone any more (`undoBlocked`, one rule in
 *     portal.planningUndoRefusal), in which case the reason shows instead.
 * Both are optimistic: the cards move on the tap, the server follows, and a
 * refusal puts the cards back with the reason. Calls run one after another,
 * so an Undo tapped before the choice has saved waits for it, then undoes it.
 * This ONE component renders both the open prompt and the folded one, so it
 * stays mounted across the refresh that follows a choice and the Undo does
 * not vanish with it.
 */
type Route = "CALL" | "WRITTEN" | "UNDECIDED";
type Msg = { ok: boolean; text: string };
type Saved = { ok: boolean; undo?: string };
const DIDNT_SAVE = "That didn't save. Try again.";

export function RouteChoice({ monthId, current, large = true, chosen = false, callBooked = false, undoBlocked = null, blocked = null }: {
  monthId: string;
  current: Route;
  large?: boolean;
  /** The month carries an explicit choice (planningChosenAt) — there is something to undo. */
  chosen?: boolean;
  /** A strategy call is booked: undoing never cancels it, and with no choice the month reads as planned on it. */
  callBooked?: boolean;
  /** Why "Undo my choice" can't be offered any more (portalPlanning.undoBlocked); null = it can. */
  undoBlocked?: string | null;
  /** Oct 6: why switching TO a route isn't possible (portalPlanning.switchBlocked) — that card is shown but can't be tapped, and the reason is said. */
  blocked?: { CALL: string | null; WRITTEN: string | null } | null;
}) {
  const router = useRouter();
  const [shown, setShown] = useState<Route | null>(null); // optimistic route, until the server's catches up
  const [pending, setPending] = useState(0);
  const [seen, setSeen] = useState<Route>(current);
  const [undo, setUndo] = useState<{ prev: Route; saved: Promise<Saved> } | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(0); // the last tap; an older call's answer never overwrites a newer tap's screen
  const [, startRefresh] = useTransition();
  // A new server reading replaces the optimistic one once nothing is in flight.
  if (seen !== current) {
    setSeen(current);
    if (pending === 0) setShown(null);
  }
  const display: Route = shown ?? current;
  const refresh = () => startRefresh(() => router.refresh());
  /** One server call at a time, in tap order. */
  const run = <T,>(fn: () => Promise<T>): Promise<T> => {
    setPending((n) => n + 1);
    const p = queue.current.then(fn).finally(() => setPending((n) => n - 1));
    queue.current = p.catch(() => undefined);
    return p;
  };
  const auth = () => portalAuthFromLocation();

  const choose = (route: "CALL" | "WRITTEN") => {
    const prev = display;
    const tap = ++latest.current;
    setShown(route);
    setMsg({ ok: true, text: route === "WRITTEN" ? "You're choosing your topics here." : "You're talking your topics through on a call." });
    const saved = run(async (): Promise<Saved> => {
      const fn = route === "WRITTEN" ? portalPlanWithoutCall : portalPlanWithCall;
      const r: { ok: boolean; message: string; undo?: string } = await fn(auth(), monthId).catch(() => ({ ok: false, message: DIDNT_SAVE }));
      if (tap === latest.current) {
        if (r.ok) setMsg({ ok: true, text: r.message });
        else { setShown(prev); setUndo(null); setMsg({ ok: false, text: r.message }); }
      }
      refresh();
      return { ok: r.ok, undo: r.undo };
    });
    setUndo({ prev, saved });
  };

  /** The Undo beside the confirmation: back exactly as it was before the tap. */
  const undoNow = () => {
    if (!undo) return;
    const { prev, saved } = undo;
    const was = display;
    const tap = ++latest.current;
    setUndo(null);
    setShown(prev);
    setMsg({ ok: true, text: "Undone." });
    void run(async () => {
      const s = await saved;
      if (!s.ok) return; // the choice never landed — there is nothing to put back
      const r = s.undo
        ? await portalPlanUndecided(auth(), monthId, s.undo).catch(() => ({ ok: false, message: DIDNT_SAVE }))
        // No seal came back: the plain way to the same place.
        : prev === "UNDECIDED" ? await portalPlanUndecided(auth(), monthId).catch(() => ({ ok: false, message: DIDNT_SAVE }))
        : await (prev === "WRITTEN" ? portalPlanWithoutCall : portalPlanWithCall)(auth(), monthId).catch(() => ({ ok: false, message: DIDNT_SAVE }));
      if (tap === latest.current) {
        if (!r.ok) setShown(was);
        setMsg({ ok: r.ok, text: r.ok && !s.undo ? "Undone." : r.message });
      }
      refresh();
    });
  };

  /** "Undo my choice": back to no choice at all. */
  const undoChoice = () => {
    const was = display;
    const tap = ++latest.current;
    setUndo(null);
    setShown(callBooked ? "CALL" : "UNDECIDED");
    setMsg({ ok: true, text: "Undone." });
    void run(async () => {
      const r = await portalPlanUndecided(auth(), monthId).catch(() => ({ ok: false, message: DIDNT_SAVE }));
      if (tap === latest.current) {
        if (!r.ok) setShown(was);
        setMsg({ ok: r.ok, text: r.message });
      }
      refresh();
    });
  };

  // A route the server says can't be switched to: shown, never tappable.
  const blockedWhy = (route: "CALL" | "WRITTEN") => (display !== route ? blocked?.[route] ?? null : null);
  const card = (route: "CALL" | "WRITTEN", Icon: typeof PenLine, title: string, body: string) => {
    const isChosen = display === route;
    const off = !!blockedWhy(route);
    return (
      <button type="button" onClick={() => choose(route)} disabled={isChosen || off} aria-pressed={isChosen} aria-describedby={off ? `route-blocked-${monthId}` : undefined}
        className={cn("flex w-full flex-col items-start gap-1 rounded-2xl border p-4 text-left transition-colors disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", large && "min-h-24", isChosen ? "border-brand bg-brand-soft/40" : off ? "border-border bg-surface opacity-60" : "border-border bg-surface hover:border-brand/50")}>
        <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-brand" aria-hidden /> {title}</span>
        <span className="text-sm leading-relaxed text-muted">{body}</span>
        {isChosen && <span className="text-sm font-semibold text-foreground">Your choice this month</span>}
      </button>
    );
  };
  const cards = (
    <div className="grid gap-2 sm:grid-cols-2">
      {card("WRITTEN", PenLine, "Choose my topics here", "Pick your topics and answer a few short questions for each. Your progress saves as you go. Filming can be booked once your answers are in.")}
      {card("CALL", Phone, "Talk through topics on a call", "Book a strategy call and we choose the topics together. Filming can be booked as soon as the call is. Browsing topics first is optional.")}
    </div>
  );
  const why = blockedWhy("WRITTEN") ?? blockedWhy("CALL");
  const blockedNote = why && <p id={`route-blocked-${monthId}`} className="mt-2 text-xs text-muted">{why}</p>;
  const status = msg && (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <SaveStatus state={msg.ok ? "info" : "error"} message={msg.text} />
      {undo && <Button variant="secondary" onClick={undoNow}><Undo2 aria-hidden className="size-4" /> Undo</Button>}
    </div>
  );

  // Open: the month has no route yet, or the client has just acted here (so
  // the confirmation and its Undo stay in view).
  if (display === "UNDECIDED" || msg) return <div>{cards}{blockedNote}{status}</div>;

  // Undo my choice: only where there is a choice, and only where it changes
  // something — with a call booked, "no choice" already reads as the call.
  const offerUndo = chosen && !(callBooked && display === "CALL");
  return (
    <details>
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Change how you plan this month</summary>
      <div className="mt-2">
        {cards}
        {blockedNote}
        {offerUndo && (undoBlocked ? (
          undoBlocked !== why && <p className="mt-2 text-xs text-muted">{undoBlocked}</p>
        ) : (
          <div className="mt-2">
            <Button variant="quiet" onClick={undoChoice}><Undo2 aria-hidden className="size-4" /> Undo my choice</Button>
            <p className="mt-0.5 text-xs text-muted">
              {callBooked ? "Your booked call stays booked, so this month goes back to planning on it." : "Go back to deciding later. Nothing you've done is lost."}
            </p>
          </div>
        ))}
      </div>
    </details>
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
      <Button variant="secondary" onClick={go} busy={busy} busyLabel="Saving choice…">
        <CalendarClock className="size-4" aria-hidden /> {CTA_WORDS.LATER}
      </Button>
      {msg && <div className="mt-1.5"><SaveStatus state={msg.ok ? "info" : "error"} message={msg.text} /></div>}
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
    <span className="ml-auto inline-flex flex-wrap items-center gap-2 text-sm">
      {!confirm ? (
        <Button variant="quiet" onClick={() => setConfirm(true)}><XCircle aria-hidden className="size-4" /> {selfBooked ? "Cancel session" : confirmed ? "Ask to cancel" : "Cancel"}</Button>
      ) : (
        <>
          <span className="text-muted">{selfBooked ? "Cancel this session?" : confirmed ? "Ask us to cancel this session?" : "Cancel this request?"}</span>
          <Button variant="danger" onClick={go} busy={busy} busyLabel="Saving…">Yes</Button>
          <Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>No</Button>
        </>
      )}
      {msg && <span role="status" className="text-muted">{msg}</span>}
    </span>
  );
}
