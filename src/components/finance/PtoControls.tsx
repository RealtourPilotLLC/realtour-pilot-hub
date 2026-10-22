"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { removePto, savePto } from "@/app/sales/ptoActions";

// The owner's paid-time-off forms (Oct 22 2026, lib/pto). The server action
// decides everything (service days, holidays, the bank); this only draws.

type Res = { ok: boolean; message: string };
const BTN = "inline-flex min-h-9 items-center justify-center gap-1 rounded-lg px-3 text-xs font-semibold disabled:opacity-50 sm:min-h-8";
const PRIMARY = `${BTN} bg-brand-action text-white`;
const QUIET = `${BTN} border border-border text-muted hover:bg-surface-2`;
const INPUT = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-base sm:text-sm";
const LABEL = "text-[11px] font-medium text-muted";

export type PtoInitial = { id: string; yearKey: string; startKey: string; endKey: string; type: string; fraction: number; note: string };

function useAction() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<Res | null>(null);
  const run = (fn: () => Promise<Res>, after?: (ok: boolean) => void) =>
    start(async () => {
      const r = await fn().catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." }));
      setMsg(r);
      if (r.ok) router.refresh();
      after?.(r.ok);
    });
  return { busy, msg, run };
}

/** Add time off (or, with `initial`, change it): a day or a range of days, its type, full or part of a day. */
export function PtoForm({ memberId, types, defaultDay, initial, onDone }: {
  memberId: string;
  types: { key: string; label: string }[];
  defaultDay: string;
  initial?: PtoInitial | null;
  onDone?: () => void;
}) {
  const [startKey, setStart] = useState(initial?.startKey ?? defaultDay);
  const [endKey, setEnd] = useState(initial?.endKey ?? defaultDay);
  const [type, setType] = useState(initial?.type ?? types[0]?.key ?? "vacation");
  const [fraction, setFraction] = useState(String(initial?.fraction ?? 1));
  const [note, setNote] = useState(initial?.note ?? "");
  const { busy, msg, run } = useAction();
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="space-y-0.5">
          <span className={LABEL}>First day</span>
          <input type="date" value={startKey} onChange={(e) => { setStart(e.target.value); if (e.target.value > endKey) setEnd(e.target.value); }} className={INPUT} />
        </label>
        <label className="space-y-0.5">
          <span className={LABEL}>Last day</span>
          <input type="date" value={endKey} min={startKey} onChange={(e) => setEnd(e.target.value)} className={INPUT} />
        </label>
        <label className="space-y-0.5">
          <span className={LABEL}>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label className="space-y-0.5">
          <span className={LABEL}>How much of the day</span>
          <select value={fraction} onChange={(e) => setFraction(e.target.value)} className={INPUT} disabled={startKey !== endKey}>
            <option value="1">Full day</option>
            <option value="0.75">Three quarters</option>
            <option value="0.5">Half day</option>
            <option value="0.25">A quarter</option>
          </select>
        </label>
      </div>
      <label className="block space-y-0.5">
        <span className={LABEL}>Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={INPUT} placeholder="e.g. Family wedding" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !startKey}
          onClick={() =>
            run(
              () => savePto(memberId, { id: initial?.id ?? null, yearKey: initial?.yearKey ?? null, startKey, endKey, type, fraction: startKey === endKey ? Number(fraction) : 1, note }),
              (ok) => { if (ok) { if (!initial) setNote(""); onDone?.(); } },
            )
          }
          className={PRIMARY}
        >
          {busy && <Loader2 className="size-3 animate-spin" />} {initial ? "Save" : "Add the time off"}
        </button>
        {initial && onDone && <button type="button" onClick={onDone} className={QUIET}>Cancel</button>}
      </div>
      {msg && <p className={`text-[11px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}

/** One stretch of time off in the owner's list, with Edit and Remove. */
export function PtoRow({ memberId, types, initial, children }: { memberId: string; types: { key: string; label: string }[]; initial: PtoInitial; children: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  const { busy, msg, run } = useAction();
  if (editing) return <PtoForm memberId={memberId} types={types} defaultDay={initial.startKey} initial={initial} onDone={() => setEditing(false)} />;
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button type="button" onClick={() => setEditing(true)} className={QUIET}>Edit</button>
        <button type="button" disabled={busy} onClick={() => run(() => removePto(memberId, initial.yearKey, initial.id))} className={QUIET}>
          {busy && <Loader2 className="size-3 animate-spin" />} Remove
        </button>
      </div>
      {msg && !msg.ok && <p className="w-full text-[11px] text-danger">{msg.message}</p>}
    </div>
  );
}
