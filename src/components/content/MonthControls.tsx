"use client";

import { useState, useTransition } from "react";
import { CalendarX2, Loader2, Undo2 } from "lucide-react";
import { moveSessionToMonth, setMonthSkipped } from "@/app/content/actions";

// Month-slippage controls (Jordan, Aug 28: "we did her July content in August
// — sometimes clients get a month behind or miss a month"). The content month
// is a PACKAGE: a session filmed in August can BELONG to July.

/** Re-label a session onto the month it belongs to. The portal follows. */
export function SessionMonthMover({ projectId, currentKey, monthKeys }: { projectId: string; currentKey: string; monthKeys: string[] }) {
  const [key, setKey] = useState(currentKey);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // Adjacent months are always offered even when no workspace exists yet —
  // moving there creates it.
  const [y, m] = currentKey.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const options = [...new Set([...monthKeys, prev, next])].sort().reverse();
  const label = (k: string) =>
    new Date(`${k}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

  return (
    // Lives inside the session row's <Link> — swallow BOTH the bubble and the
    // anchor default, or picking a month would also navigate.
    <span className="inline-flex items-center gap-1" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {busy && <Loader2 className="size-3 animate-spin text-muted" />}
      <select
        aria-label="Content month this session belongs to"
        title="Which month's PACKAGE this session belongs to — filmed-late sessions can be re-labeled"
        value={key}
        disabled={busy}
        onChange={(e) => {
          const nextKey = e.target.value;
          const prevKey = key;
          setKey(nextKey);
          start(async () => {
            const r = await moveSessionToMonth(projectId, nextKey).catch(() => ({ ok: false, message: "That didn't stick." }));
            if (!r.ok) { setKey(prevKey); setErr(r.message); } else setErr(null);
          });
        }}
        className="cursor-pointer rounded-md border border-transparent bg-transparent py-0.5 pl-1 pr-5 text-[11px] font-medium text-muted hover:border-border hover:bg-surface-2 disabled:opacity-60"
      >
        {options.map((k) => (
          <option key={k} value={k}>{label(k)}</option>
        ))}
      </select>
      {err && <span className="text-[10px] text-danger">{err}</span>}
    </span>
  );
}

/** Mark a month the client missed — the dashboard stops nagging about it. */
export function SkipMonthButton({ monthId, skipped }: { monthId: string; skipped: boolean }) {
  const [isSkipped, setIsSkipped] = useState(skipped);
  const [busy, start] = useTransition();
  return (
    <button
      disabled={busy}
      onClick={() =>
        start(async () => {
          const r = await setMonthSkipped(monthId, !isSkipped).catch(() => ({ ok: false, message: "" }));
          if (r.ok) setIsSkipped(!isSkipped);
        })
      }
      title={isSkipped ? "Reopen this month" : "The client missed this month — mark it skipped so nothing nags about it"}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : isSkipped ? <Undo2 className="size-3" /> : <CalendarX2 className="size-3" />}
      {isSkipped ? "Skipped — reopen" : "Mark skipped"}
    </button>
  );
}
