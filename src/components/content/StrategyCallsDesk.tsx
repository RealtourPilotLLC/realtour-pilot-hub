"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import type { DeskData, DeskRow } from "@/lib/strategyCallDesk";
import { assignStrategyCallAction, ignoreStrategyCallAction, refreshStrategyCallsAction, unassignStrategyCallAction } from "@/app/content/calls/actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// STRATEGY CALLS DESK (Oct 6 2026). One row per call; one tap files it on a
// client's month, sets it aside, or takes it back. "It should work instantly"
// (Jordan): every decision is drawn at once and the server confirms in the
// background — a refusal puts the row back and says why.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const quiet = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const field = "min-h-11 min-w-0 max-w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (key: string, withYear = true) => {
  const [y, m] = key.split("-").map(Number);
  return withYear ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1];
};
const whenET = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "No time on file";

const STATUS_TONE: Record<DeskRow["status"], string> = {
  scheduled: "bg-brand-soft text-brand", completed: "bg-success/15 text-success", cancelled: "bg-surface-2 text-muted",
  rescheduled: "bg-surface-2 text-muted", "no-show": "bg-warning/15 text-warning",
};
const STATUS_WORD: Record<DeskRow["status"], string> = { scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", rescheduled: "Rescheduled", "no-show": "No-show" };

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", className)}>{children}</span>;
}

export function StrategyCallsDesk({ data }: { data: DeskData }) {
  const [rows, setRows] = useState<DeskRow[]>(data.rows);
  const inflight = useRef(new Set<string>());
  // A fresh server read replaces the rows — except any still waiting on its own answer.
  useEffect(() => {
    setRows((cur) => data.rows.map((r) => (inflight.current.has(r.id) ? cur.find((c) => c.id === r.id) ?? r : r)));
  }, [data]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const clientName = useMemo(() => new Map(data.clients.map((c) => [c.id, c.name])), [data.clients]);

  /** Draw the change now; the server answers in the background; a refusal restores the row. */
  function act(id: string, next: (r: DeskRow) => DeskRow, call: () => Promise<{ ok: boolean; message: string }>) {
    const before = rows.find((r) => r.id === id);
    if (!before) return;
    inflight.current.add(id);
    setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
    setRows((cur) => cur.map((r) => (r.id === id ? next(r) : r)));
    call()
      .then((res) => {
        if (!res.ok) {
          setRows((cur) => cur.map((r) => (r.id === id ? before : r)));
          setErrors((e) => ({ ...e, [id]: res.message }));
        }
      })
      .catch(() => {
        setRows((cur) => cur.map((r) => (r.id === id ? before : r)));
        setErrors((e) => ({ ...e, [id]: "Could not reach the hub — nothing was changed." }));
      })
      .finally(() => inflight.current.delete(id));
  }

  const assign = (r: DeskRow, clientId: string, monthKey: string) =>
    act(r.id, (x) => ({ ...x, state: "ASSIGNED", assignedBy: "staff", client: { id: clientId, name: clientName.get(clientId) ?? "Client" }, month: { id: x.month?.id ?? "pending", key: monthKey }, defaultMonthKey: monthKey, suggestion: null }),
      () => assignStrategyCallAction(r.id, clientId, monthKey));
  const unassign = (r: DeskRow) =>
    act(r.id, (x) => ({ ...x, state: "OPEN", assignedBy: null, client: null, month: null }), () => unassignStrategyCallAction(r.id));
  const ignore = (r: DeskRow) =>
    act(r.id, (x) => ({ ...x, state: "IGNORED", assignedBy: null, client: null, month: null }), () => ignoreStrategyCallAction(r.id));

  const now = new Date(data.nowISO).getTime();
  const live = (r: DeskRow) => r.status !== "cancelled" && r.status !== "rescheduled";
  const visible = rows.filter((r) => showAll || (live(r) && r.state !== "IGNORED"));
  const upcoming = visible.filter((r) => r.startISO && new Date(r.startISO).getTime() > now).sort((a, b) => (a.startISO ?? "").localeCompare(b.startISO ?? ""));
  const past = visible.filter((r) => !(r.startISO && new Date(r.startISO).getTime() > now));
  const open = rows.filter((r) => live(r) && r.state === "OPEN").length;
  const hidden = rows.length - rows.filter((r) => live(r) && r.state !== "IGNORED").length;

  return (
    <div className="space-y-5">
      {!data.candidateMapped && (
        <div className="flex gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p>
            Calls booked on <b>30 Minute Strategy Call</b> are not being read yet. On{" "}
            <Link href="/settings" className="font-semibold text-brand hover:underline">Settings → Calendly &amp; calls</Link>, set that type to{" "}
            <b>Possible strategy call</b> and turn it on, then press <b>Re-read Calendly</b> here.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-muted">
          <b className="text-foreground">{open}</b> call{open === 1 ? "" : "s"} not filed on a month
          {data.lastSyncedISO && <> · Calendly last read {whenET(data.lastSyncedISO)}</>}
        </p>
        <label className="inline-flex min-h-11 items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-4" />
          Show cancelled &amp; set aside{hidden ? ` (${hidden})` : ""}
        </label>
        <button type="button" className={quiet} disabled={refreshing} onClick={() => startRefresh(async () => {
          const r = await refreshStrategyCallsAction().catch(() => ({ ok: false, message: "Could not reach the hub." }));
          setFlash({ ok: r.ok, text: r.message });
        })}>
          {refreshing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />} Re-read Calendly
        </button>
      </div>
      {flash && <p role="status" className={cn("text-sm", flash.ok ? "text-success" : "text-danger")}>{flash.text}</p>}

      <Group title="Coming up · next 14 days" rows={upcoming} empty="No strategy calls booked in the next two weeks." {...{ data, assign, unassign, ignore, errors }} />
      <Group title="Past 30 days" rows={past} empty="No strategy calls in the last 30 days." {...{ data, assign, unassign, ignore, errors }} />
    </div>
  );
}

type RowActions = {
  data: DeskData;
  assign: (r: DeskRow, clientId: string, monthKey: string) => void;
  unassign: (r: DeskRow) => void;
  ignore: (r: DeskRow) => void;
  errors: Record<string, string>;
};

function Group({ title, rows, empty, ...a }: { title: string; rows: DeskRow[]; empty: string } & RowActions) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">{title}</h2>
      {rows.length === 0 ? <p className="rounded-xl border border-border bg-surface/70 p-4 text-sm text-muted">{empty}</p> : (
        <ul className="space-y-2">{rows.map((r) => <CallRow key={r.id} r={r} {...a} />)}</ul>
      )}
    </section>
  );
}

function CallRow({ r, data, assign, unassign, ignore, errors }: { r: DeskRow } & RowActions) {
  const [clientId, setClientId] = useState(r.client?.id ?? r.suggestion?.clientId ?? "");
  const [monthKey, setMonthKey] = useState(r.defaultMonthKey ?? r.monthOptions[0] ?? "");
  const [editing, setEditing] = useState(false);
  const live = r.status !== "cancelled" && r.status !== "rescheduled";
  const showPicker = live && (r.state === "OPEN" || editing);
  const pickedName = data.clients.find((c) => c.id === clientId)?.name ?? null;
  const err = errors[r.id];
  return (
    <li className={cn("rounded-xl border bg-surface/70 p-3 sm:p-4", r.state === "OPEN" && live ? "border-brand/30" : "border-border", (!live || r.state === "IGNORED") && "opacity-70")}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{whenET(r.startISO)}</div>
          <div className="break-words text-sm">{r.inviteeName ?? "Unknown invitee"}{r.inviteeEmail && <span className="text-muted"> · {r.inviteeEmail}</span>}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip className="bg-surface-2 text-muted">{r.eventType}</Chip>
          <Chip className={STATUS_TONE[r.status]}>{STATUS_WORD[r.status]}</Chip>
        </div>
      </div>

      <div className="mt-2 text-sm">
        {r.state === "ASSIGNED" && r.client && r.month ? (
          <p className="flex flex-wrap items-center gap-1.5">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            <span><b>{r.client.name}</b> · {monthName(r.month.key)}</span>
            <span className="text-muted-2">({r.assignedBy === "staff" ? "assigned by staff" : "matched by email"})</span>
          </p>
        ) : r.state === "IGNORED" ? (
          <p className="text-muted">Not a program call</p>
        ) : (
          <p className="text-muted">Not assigned{r.client && <> · on file for <b className="text-foreground">{r.client.name}</b>, no month</>}</p>
        )}
        {showPicker && r.suggestion && r.state === "OPEN" && (
          <p className="mt-1 flex items-center gap-1.5 text-muted"><Sparkles className="size-3.5 text-brand" aria-hidden /> Suggested: <b className="text-foreground">{r.suggestion.name}</b> — {r.suggestion.reason}</p>
        )}
      </div>

      {showPicker && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`client-${r.id}`}>Client</label>
          <select id={`client-${r.id}`} value={clientId} onChange={(e) => setClientId(e.target.value)} className={cn(field, "flex-1 sm:flex-none")}>
            <option value="">Choose a client…</option>
            {data.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="sr-only" htmlFor={`month-${r.id}`}>Month this call plans</label>
          <select id={`month-${r.id}`} value={monthKey} onChange={(e) => setMonthKey(e.target.value)} className={field}>
            {r.monthOptions.map((k) => <option key={k} value={k}>{monthName(k)}{k === r.defaultMonthKey ? " (default)" : ""}</option>)}
          </select>
          <button type="button" disabled={!clientId || !monthKey} onClick={() => { assign(r, clientId, monthKey); setEditing(false); }} className={cn(btn, "bg-brand-action text-white")}>
            {pickedName ? `Assign to ${pickedName} · ${monthName(monthKey, false)}` : "Assign"}
          </button>
          {editing && <button type="button" className={quiet} onClick={() => setEditing(false)}>Cancel</button>}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {r.state === "ASSIGNED" && live && !editing && <button type="button" className={quiet} onClick={() => setEditing(true)}>Change</button>}
        {(r.state === "ASSIGNED" || r.state === "IGNORED") && (
          <button type="button" className={quiet} onClick={() => unassign(r)}><Undo2 className="size-4" aria-hidden /> {r.state === "IGNORED" ? "Restore" : "Unassign"}</button>
        )}
        {r.state !== "IGNORED" && <button type="button" className={quiet} onClick={() => ignore(r)}>Not a program call</button>}
      </div>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
    </li>
  );
}
