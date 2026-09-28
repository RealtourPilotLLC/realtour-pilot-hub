"use client";

import { useState, useTransition } from "react";
import { CalendarOff, Loader2, X } from "lucide-react";
import { etAt } from "@/lib/datetime";
import { cancelCapacityExceptionAction, recordCapacityExceptionAction } from "./actions";

// ---------------------------------------------------------------------------
// §10 capacity (Sep 26 2026): the form that writes one CapacityException, and
// the Cancel on a register row. Mirrors lib/capacity's CAPACITY_KINDS the way
// the Settings cards mirror their server lists — that module is server-only.
// Times are Eastern (the business runs on ET); an empty end means "until
// someone says otherwise".
// ---------------------------------------------------------------------------

const KINDS: { key: string; label: string; hint: string }[] = [
  { key: "TIME_OFF", label: "Time off", hint: "a day off, a holiday, leave" },
  { key: "TRAINING", label: "Training", hint: "protected learning time" },
  { key: "BLOCKED", label: "Blocked", hint: "can't work on the queue — waiting on something" },
  { key: "CONNECTIVITY", label: "Offline", hint: "internet or power is down" },
  { key: "OTHER", label: "Other", hint: "a staffing decision, e.g. a backup editor this week" },
];
const SELF_KINDS = new Set(["CONNECTIVITY", "BLOCKED"]);

const TZ = "America/New_York";
function etLocalNow(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
function fromEtLocal(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = etAt(m[1], Number(m[2]), Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const INPUT = "rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand";

export function CapacityForm({
  people, selfOnly,
}: {
  /** who the viewer may record for; one entry for an editor (themselves) */
  people: { id: string; name: string }[];
  /** an editor: only "offline" and "blocked", only for themselves */
  selfOnly: boolean;
}) {
  const kinds = selfOnly ? KINDS.filter((k) => SELF_KINDS.has(k.key)) : KINDS;
  const [who, setWho] = useState(people[0]?.id ?? "");
  const [kind, setKind] = useState(kinds[0]?.key ?? "OTHER");
  const [from, setFrom] = useState(etLocalNow);
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const submit = () =>
    start(async () => {
      const startsAt = fromEtLocal(from);
      if (!startsAt) return setMsg("Pick when it starts.");
      const endsAt = until ? fromEtLocal(until) : null;
      if (until && !endsAt) return setMsg("That end isn't a real date.");
      const r = await recordCapacityExceptionAction({ teamMemberId: who, kind, startsAt, endsAt, note }).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      setMsg(r.message);
      if (r.ok) { setNote(""); setUntil(""); }
    });
  return (
    <div className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-end gap-3">
        {!selfOnly && (
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
            Who
            <select value={who} onChange={(e) => setWho(e.target.value)} className={`${INPUT} normal-case tracking-normal`}>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
          What
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${INPUT} normal-case tracking-normal`}>
            {kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
          From (ET)
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
          Until (ET, optional)
          <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className={INPUT} />
        </label>
      </div>
      <p className="text-[11px] text-muted-2">{kinds.find((k) => k.key === kind)?.hint}</p>
      <input
        aria-label="Note"
        value={note}
        maxLength={300}
        placeholder="Note — what the office should know (optional)"
        onChange={(e) => setNote(e.target.value)}
        className={`${INPUT} w-full`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !who}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarOff className="size-4" />} Record it
        </button>
        {msg && <span className="text-[12px] text-muted">{msg}</span>}
      </div>
      <p className="text-[11px] text-muted-2">
        It shows beside the person on the Editing Room&rsquo;s workload panel. Nothing is reassigned, no date moves and pay is not touched — the hub records the decision; people make it.
      </p>
    </div>
  );
}

export function CancelCapacityButton({ id }: { id: string }) {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => start(async () => {
          const r = await cancelCapacityExceptionAction(id).catch(() => ({ ok: false, message: "That didn't cancel — try again." }));
          setMsg(r.ok ? null : r.message);
        })}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />} Cancel
      </button>
      {msg && <span className="text-[11px] text-warning">{msg}</span>}
    </span>
  );
}
