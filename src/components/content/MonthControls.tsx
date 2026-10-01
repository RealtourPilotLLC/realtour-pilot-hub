"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarX2, ChevronLeft, ChevronRight, Loader2, Undo2 } from "lucide-react";
import { moveSessionToMonth, setMonthSkipped } from "@/app/content/actions";
import { contentControlOutcome, type ContentControlOutcome } from "@/lib/contentControlReceipt";

const control = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium text-muted whitespace-normal hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const select = "min-h-11 min-w-0 max-w-full cursor-pointer rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";
type ControlReceipt = { outcome: ContentControlOutcome; text: string };
type ControlSession<T> = { value: T; baseline: T; expected: T | null; receipt: ControlReceipt | null; held: boolean; changed: boolean };
const initialSession = <T,>(value: T): ControlSession<T> => ({ value, baseline: value, expected: null, receipt: null, held: false, changed: false });
function useControlSessions<T>(id: string, initial: T, busy: boolean) {
  const [sessions, setSessions] = useState(() => new Map([[id, initialSession(initial)]]));
  const live = useRef(sessions);
  const update = (targetId: string, original: T, change: (old: ControlSession<T>) => ControlSession<T>) => {
    const old = live.current.get(targetId) ?? initialSession(original), next = change(old);
    if (next === old && live.current.has(targetId)) return;
    const rows = new Map(live.current); rows.set(targetId, next); live.current = rows; setSessions(rows);
  };
  useEffect(() => {
    const old = live.current.get(id) ?? initialSession(initial);
    if (busy || old.held) return;
    if (old.expected !== null) {
      if (old.expected === initial) {
        const rows = new Map(live.current); rows.set(id, { ...old, baseline: initial, expected: null, changed: false }); live.current = rows; setSessions(rows);
      }
    } else if (old.baseline !== initial) {
      const rows = new Map(live.current); rows.set(id, { ...old, value: old.value === old.baseline ? initial : old.value, baseline: initial, changed: old.value !== old.baseline }); live.current = rows; setSessions(rows);
    }
  }, [id, initial, busy]);
  return { session: sessions.get(id) ?? initialSession(initial), read: (targetId: string) => live.current.get(targetId), update };
}

function MonthReceipt({ receipt }: { receipt: ControlReceipt | null }) {
  if (!receipt) return null;
  return <span role={receipt.outcome === "confirmed" ? "status" : "alert"} className="block max-w-full break-words text-ui-status leading-relaxed">
    {receipt.text}
    {receipt.outcome === "unknown" && " This outcome is unconfirmed. Further changes are held here. Inspect the exact session/month and its library records before another write; refreshing this view does not by itself prove completion."}
  </span>;
}

/** Month navigation for the workspace: ‹ › chevrons + a quiet "all months"
 *  select. Replaces the old every-month pill rail — one month is the subject,
 *  history is a dropdown, not fourteen equal pills. */
export function MonthPicker({
  months, currentKey, makeHref,
}: {
  months: { key: string; label: string; historical: boolean }[];
  currentKey: string;
  /** href pattern with MONTH placeholder, e.g. "/content/abc?month=MONTH" */
  makeHref: string;
}) {
  const router = useRouter();
  const go = (k: string) => router.push(makeHref.replace("MONTH", encodeURIComponent(k)));
  const idx = months.findIndex((m) => m.key === currentKey);
  const newer = idx > 0 ? months[idx - 1] : null; // months sorted newest-first
  const older = idx >= 0 && idx < months.length - 1 ? months[idx + 1] : null;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      <button
        disabled={!older}
        onClick={() => older && go(older.key)}
        title={older ? older.label : undefined}
        aria-label="Earlier month"
        className={control}
      >
        <ChevronLeft className="size-4" />
      </button>
      <select
        aria-label="Month"
        value={currentKey}
        onChange={(e) => go(e.target.value)}
        className={select}
      >
        {months.map((m) => (
          <option key={m.key} value={m.key}>{m.label}{m.historical ? " · imported" : ""}</option>
        ))}
      </select>
      <button
        disabled={!newer}
        onClick={() => newer && go(newer.key)}
        title={newer ? newer.label : undefined}
        aria-label="Later month"
        className={control}
      >
        <ChevronRight className="size-4" />
      </button>
    </span>
  );
}

// Month-slippage controls (Jordan, Aug 28: "we did her July content in August
// — sometimes clients get a month behind or miss a month"). The content month
// is a PACKAGE: a session filmed in August can BELONG to July.

/** Re-label a session onto the month it belongs to. The portal follows. */
export function SessionMonthMover({ projectId, currentKey, monthKeys }: { projectId: string; currentKey: string; monthKeys: string[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const pending = useRef(false);
  const { session, read, update } = useControlSessions(projectId, currentKey, busy);
  const move = (nextKey: string) => {
    if (pending.current || read(projectId)?.held) return;
    pending.current = true;
    update(projectId, currentKey, (old) => ({ ...old, value: nextKey, receipt: null }));
    start(async () => {
      let receipt: ControlReceipt;
      try {
        const r = await moveSessionToMonth(projectId, nextKey), outcome = contentControlOutcome(r);
        receipt = { outcome, text: r.message || `Move to ${nextKey} was not confirmed for session ${projectId}.` };
      } catch { receipt = { outcome: "unknown", text: `Move to ${nextKey} was not confirmed for session ${projectId}. Your chosen month is kept.` }; }
      update(projectId, currentKey, (old) => ({ ...old, receipt, held: receipt.outcome === "unknown", expected: receipt.outcome === "confirmed" ? nextKey : old.expected, baseline: receipt.outcome === "confirmed" ? nextKey : old.baseline, changed: receipt.outcome === "confirmed" ? false : old.changed }));
      pending.current = false;
      if (receipt.outcome === "confirmed") { try { router.refresh(); } catch { /* confirmed write; a failed view refresh does not undo it */ } }
    });
  };
  // Adjacent months are always offered even when no workspace exists yet —
  // moving there creates it.
  const [y, m] = currentKey.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const options = [...new Set([...monthKeys, currentKey, session.value, prev, next])].sort().reverse();
  const label = (k: string) =>
    new Date(`${k}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

  return (
    // Lives inside the session row's <Link> — swallow BOTH the bubble and the
    // anchor default, or picking a month would also navigate.
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {busy && <Loader2 className="size-3 animate-spin text-muted" />}
      <select
        aria-label="Content month this session belongs to"
        title="Which month's PACKAGE this session belongs to — filmed-late sessions can be re-labeled"
        value={session.value}
        disabled={busy}
        onChange={(e) => {
          if (pending.current) return;
          const nextKey = e.target.value;
          if (read(projectId)?.held) update(projectId, currentKey, (old) => ({ ...old, value: nextKey }));
          else move(nextKey);
        }}
        className={select}
      >
        {options.map((k) => (
          <option key={k} value={k}>{label(k)}</option>
        ))}
      </select>
      {session.receipt?.outcome === "refused" && <button type="button" className={control} disabled={busy} onClick={() => move(read(projectId)?.value ?? session.value)}>Retry selected month</button>}
      {session.changed && <span role="alert" className="text-ui-status text-warning">The stored session month changed. Your chosen month is kept; check its current package before another move.</span>}
      <MonthReceipt receipt={session.receipt} />
    </span>
  );
}

/** Mark a month the client missed — the dashboard stops nagging about it. */
export function SkipMonthButton({ monthId, skipped }: { monthId: string; skipped: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const pending = useRef(false);
  const { session, read, update } = useControlSessions(monthId, skipped, busy);
  const toggle = () => {
    const latest = read(monthId) ?? session;
    if (pending.current || latest.held) return;
    const requested = !latest.value;
    pending.current = true;
    start(async () => {
      let receipt: ControlReceipt;
      try {
        const r = await setMonthSkipped(monthId, requested), outcome = contentControlOutcome(r);
        receipt = { outcome, text: r.message || `The month change was not confirmed for ${monthId}.` };
      } catch { receipt = { outcome: "unknown", text: `The request to ${requested ? "skip" : "reopen"} month ${monthId} was not confirmed.` }; }
      update(monthId, skipped, (old) => ({ ...old, receipt, held: receipt.outcome === "unknown", ...(receipt.outcome === "confirmed" ? { value: requested, baseline: requested, expected: requested, changed: false } : {}) }));
      pending.current = false;
      if (receipt.outcome === "confirmed") { try { router.refresh(); } catch { /* retain confirmed write evidence */ } }
    });
  };
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
    <button
      disabled={busy || session.held}
      onClick={toggle}
      title={session.value ? "Reopen this month" : "The client missed this month — mark it skipped so nothing nags about it"}
      className={control}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : session.value ? <Undo2 className="size-3" /> : <CalendarX2 className="size-3" />}
      {session.held ? "Verify month state" : session.value ? "Skipped — reopen" : "Mark skipped"}
    </button>
    <MonthReceipt receipt={session.receipt} />
    </span>
  );
}
