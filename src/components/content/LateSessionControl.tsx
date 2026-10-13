"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, ClipboardCopy, Loader2, Undo2 } from "lucide-react";
import { lateSessionAction, lateSessionMessageAction, setLateCombineOfferAction, undoLateSessionAction } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// "Bring September's session into October" (Oct 12 2026) — on the client
// file's Overview. Jordan: "We have been waiting on Arielle to schedule her
// September content session. I already sent the scripts. We also need her to
// schedule her October session ... Can we make sure we have an option for
// that?" An EXCEPTION, like the catch-up: one quiet link, owner/admin only,
// never anything a client sees until it's applied. Unlike the catch-up,
// nothing moves: September keeps its topics, scripts and videos, and its one
// session is booked in October beside October's own. Undo while nothing is
// booked for it. "Copy a message" puts Jordan's text on the clipboard — it
// never sends.
// ---------------------------------------------------------------------------

type State = "TO_BOOK" | "REQUESTED" | "BOOKED";

/**
 * Oct 13 2026: one session or two for the late month and its host
 * (monthLateSession.CombineChoice). `offered` false = not a Starter program,
 * so there is nothing to choose; `refusal` = why it can't change right now.
 */
export type LateCombineProps = { combined: boolean; offered: boolean; canOffer: boolean; officeOffered: boolean; refusal: string | null; offerRefusal: string | null; videos: number; combinedHours: number; separateHours: number };

export type LateSessionControlProps = {
  monthId: string;
  monthName: string;
  /** This month books an earlier month's session (host side). */
  carrying: {
    lateMonthId: string; lateLabel: string; state: State; filmed: boolean; startsAtISO: string | null;
    scriptsReleased: number; scriptsReady: boolean; scriptsSentOutside: boolean; lateVideosOwed: number;
    by: string | null; at: string; undoRefusal: string | null; lateHref: string;
    combine?: LateCombineProps | null;
  } | null;
  /** Earlier months it could book (host side), each with its reason when it can't. */
  options: { monthId: string; label: string; refusal: string | null; scriptsReleased: number }[];
  /** This (over) month's session is booked late (late side). */
  filmingIn: { hostLabel: string; hostHref: string; state: State; startsAtISO: string | null; by: string | null; at: string; undoRefusal: string | null; combine?: LateCombineProps | null } | null;
  /** This (over) month could be booked late in `hostLabel` (late side). */
  offer: { hostMonthId: string; hostLabel: string; refusal: string | null; scriptsReleased: number } | null;
};

const control = "inline-flex min-h-11 max-w-full items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-muted whitespace-normal hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const primary = "inline-flex min-h-11 max-w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white whitespace-normal hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const quiet = "inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const fmt = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : ""; };
const stateWords = (s: State, at: string | null) => s === "BOOKED" ? `booked${at ? ` for ${fmt(at)}` : ""}` : s === "REQUESTED" ? "requested, waiting on Kyle to confirm" : "not booked yet";

export function LateSessionControl(p: LateSessionControlProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const usable = p.options.filter((o) => !o.refusal);
  const [pick, setPick] = useState<string | null>(usable.length === 1 ? usable[0].monthId : null);
  const [sentOutside, setSentOutside] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) { setOpen(false); router.refresh(); }
    } catch { setMsg({ ok: false, text: "That wasn't confirmed. Reload to see where the months stand." }); }
  });
  const copy = (lateMonthId: string) => start(async () => {
    try {
      const r = await lateSessionMessageAction(lateMonthId);
      if (!r.ok || !r.body) { setMsg({ ok: false, text: r.message }); return; }
      setCopied(r.body);
      const wrote = await navigator.clipboard?.writeText(r.body).then(() => true).catch(() => false);
      setMsg({ ok: true, text: wrote ? r.message : "Here's the message. Select it below and copy it." });
    } catch { setMsg({ ok: false, text: "Couldn't build the message. Reload and try again." }); }
  });
  const result = (
    <>
      {msg && <p role="status" className={`mt-2 text-[13px] ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
      {copied && <textarea readOnly aria-label="Message to the client" value={copied} rows={4} className="mt-2 w-full rounded-lg border border-border bg-surface p-2 text-[13px] leading-relaxed" onFocus={(e) => e.currentTarget.select()} />}
    </>
  );
  // Oct 13 2026: "Filming: one 4-hour session (all 4 videos)" or "two sessions", with the switch.
  const combineRow = (lateMonthId: string, c: LateCombineProps | null | undefined) => {
    if (!c || (!c.canOffer && !c.combined)) return null;
    // Oct 13 2026 (Jordan: "Let her choose"): the office offers it, the client picks in their portal.
    return (
      <div className="mt-2 text-[13px]">
        <p>
          {c.officeOffered
            ? <>{c.combinedHours}-hour catch-up session: <span className="font-medium">offered</span>. The client chose <span className="font-medium">{c.combined ? `one Video Accelerator ${c.combinedHours}-hour session (all ${c.videos} videos)` : `two Video Starter sessions, ${c.separateHours} hours each`}</span>{c.combined ? "" : " (until they pick otherwise)"}.</>
            : <>Session: <span className="font-medium">two Video Starter sessions, {c.separateHours} hours each</span>.</>}
        </p>
        <button type="button" className={`${control} mt-1`} disabled={busy || !!c.offerRefusal} onClick={() => run(() => setLateCombineOfferAction(lateMonthId, !c.officeOffered))}>
          {c.officeOffered ? `Stop offering the ${c.combinedHours}-hour session` : `Offer a ${c.combinedHours}-hour catch-up session (all ${c.videos} videos)`}
        </button>
        {c.offerRefusal && <p className="mt-1 text-muted">{c.offerRefusal}</p>}
      </div>
    );
  };
  const scriptsCheckbox = (label: string, released: number) => released > 0 ? (
    <p className="mt-2 text-[13px] text-muted">{released} {label} script{released === 1 ? " is" : "s are"} released in their portal, so the session opens right away.</p>
  ) : (
    <label className="mt-2 flex items-start gap-2 text-[13px]">
      <input type="checkbox" className="mt-0.5" checked={sentOutside} disabled={busy} onChange={(e) => setSentOutside(e.target.checked)} />
      <span>Their {label} scripts were already sent to them outside the hub. <span className="text-muted">Unticked, the session opens once you share {label}&rsquo;s scripts here (Plan › Scripts › Upload).</span></span>
    </label>
  );

  // ---- this month books an earlier month's session -----------------------------
  if (p.carrying) {
    const c = p.carrying;
    return (
      <div id="late-session" className="scroll-mt-24 rounded-xl border border-brand/30 bg-brand-soft/30 p-3 text-sm">
        <p className="font-medium">{p.monthName} also books {c.lateLabel}&rsquo;s session.</p>
        <p className="mt-0.5 text-[13px] text-muted">
          {c.lateLabel} keeps its own topics, scripts and {c.lateVideosOwed} video{c.lateVideosOwed === 1 ? "" : "s"}; the session booked for it is filed on {c.lateLabel}. The client books both in their portal.
          {c.by ? ` Approved by ${c.by}` : ""}{c.at ? ` on ${fmt(c.at)}` : ""}.
        </p>
        <ul className="mt-2 space-y-0.5 text-[13px]">
          <li>{c.lateLabel}&rsquo;s session: <span className="font-medium">{c.filmed ? "filmed" : stateWords(c.state, c.startsAtISO)}</span></li>
          <li>
            {c.scriptsReleased > 0 ? `${c.scriptsReleased} ${c.lateLabel} script${c.scriptsReleased === 1 ? "" : "s"} released in their portal`
              : c.scriptsSentOutside ? `${c.lateLabel}'s scripts were sent outside the hub (none released here)`
              : <span className="text-warning">No {c.lateLabel} scripts shared yet. Their {c.lateLabel} session opens once you share them (Plan › Scripts › Upload).</span>}
          </li>
        </ul>
        {combineRow(c.lateMonthId, c.combine)}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={control} disabled={busy} onClick={() => copy(c.lateMonthId)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ClipboardCopy className="size-3.5" aria-hidden />} Copy a message
          </button>
          <button type="button" className={control} disabled={busy || !!c.undoRefusal} onClick={() => run(() => undoLateSessionAction(c.lateMonthId))}>
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
          <Link href={c.lateHref} className="text-[13px] font-medium text-brand hover:underline">Open {c.lateLabel} →</Link>
        </div>
        {c.undoRefusal && <p className="mt-1 text-[13px] text-muted">{c.undoRefusal}</p>}
        {result}
      </div>
    );
  }

  // ---- this (over) month's session is booked late --------------------------------
  if (p.filmingIn) {
    const f = p.filmingIn;
    return (
      <div id="late-session" className="scroll-mt-24 rounded-xl border border-brand/30 bg-brand-soft/30 p-3 text-sm">
        <p className="font-medium">{p.monthName}&rsquo;s session is being booked in {f.hostLabel}: {stateWords(f.state, f.startsAtISO)}.</p>
        <p className="mt-0.5 text-[13px] text-muted">
          Its topics, scripts and videos stay on {p.monthName}, and nothing here is chased as overdue while {f.hostLabel} runs.
          {f.by ? ` Approved by ${f.by}` : ""}{f.at ? ` on ${fmt(f.at)}` : ""}.
        </p>
        {combineRow(p.monthId, f.combine)}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={control} disabled={busy} onClick={() => copy(p.monthId)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ClipboardCopy className="size-3.5" aria-hidden />} Copy a message
          </button>
          <button type="button" className={control} disabled={busy || !!f.undoRefusal} onClick={() => run(() => undoLateSessionAction(p.monthId))}>
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
          <Link href={f.hostHref} className="text-[13px] font-medium text-brand hover:underline">Open {f.hostLabel} →</Link>
        </div>
        {f.undoRefusal && <p className="mt-1 text-[13px] text-muted">{f.undoRefusal}</p>}
        {result}
      </div>
    );
  }

  // ---- an over, planned month that could be booked late ---------------------------
  if (p.offer) {
    const o = p.offer;
    if (o.refusal) return null;
    return (
      <div id="late-session" className="scroll-mt-24 text-sm">
        {!open ? (
          <button type="button" className={quiet} onClick={() => { setOpen(true); setMsg(null); }}>
            <CalendarClock className="size-3.5" aria-hidden /> Film {p.monthName}&rsquo;s session in {o.hostLabel}…
          </button>
        ) : (
          <div className="rounded-xl border border-border bg-surface-2/40 p-3">
            <p className="font-medium">Book {p.monthName}&rsquo;s session in {o.hostLabel}</p>
            <p className="mt-0.5 text-[13px] text-muted">
              An exception for a month that was planned but never filmed. {p.monthName} keeps its topics, scripts and videos. The client books its session in their portal next to {o.hostLabel}&rsquo;s, and it&rsquo;s filed on {p.monthName}. You can undo this until it&rsquo;s booked.
            </p>
            {scriptsCheckbox(p.monthName, o.scriptsReleased)}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={primary} disabled={busy} onClick={() => run(() => lateSessionAction(o.hostMonthId, p.monthId, sentOutside))}>
                {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Bring {p.monthName}&rsquo;s session into {o.hostLabel}
              </button>
              <button type="button" className={control} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        )}
        {result}
      </div>
    );
  }

  // ---- this month could book an earlier month's session ---------------------------
  if (usable.length === 0) return null;
  const chosen = p.options.find((o) => o.monthId === pick && !o.refusal) ?? null;
  return (
    <div id="late-session" className="scroll-mt-24 text-sm">
      {!open ? (
        <button type="button" className={quiet} onClick={() => { setOpen(true); setMsg(null); }}>
          <CalendarClock className="size-3.5" aria-hidden /> Bring {usable.length === 1 ? `${usable[0].label}'s` : "an earlier month's"} session into {p.monthName}…
        </button>
      ) : (
        <div className="rounded-xl border border-border bg-surface-2/40 p-3">
          <p className="font-medium">Book an earlier month&rsquo;s session in {p.monthName}</p>
          <p className="mt-0.5 text-[13px] text-muted">For a month that was planned (a call held, or scripts written) but never filmed. Nothing moves: it keeps its own topics, scripts and videos, and {p.monthName} keeps its own session. The client books both in their portal.</p>
          <ul className="mt-2 space-y-1.5">
            {p.options.map((o) => (
              <li key={o.monthId}>
                <label className={`flex items-start gap-2 ${o.refusal ? "text-muted" : "cursor-pointer"}`}>
                  <input type="radio" name={`late-${p.monthId}`} className="mt-1" disabled={!!o.refusal || busy} checked={pick === o.monthId} onChange={() => setPick(o.monthId)} />
                  <span><span className="font-medium">{o.label}</span>{o.refusal && <span className="block text-[13px]">{o.refusal}</span>}</span>
                </label>
              </li>
            ))}
          </ul>
          {chosen && scriptsCheckbox(chosen.label, chosen.scriptsReleased)}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={primary} disabled={busy || !chosen} onClick={() => chosen && run(() => lateSessionAction(p.monthId, chosen.monthId, sentOutside))}>
              {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} {chosen ? `Bring ${chosen.label}'s session into ${p.monthName}` : "Pick a month"}
            </button>
            <button type="button" className={control} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {result}
    </div>
  );
}
