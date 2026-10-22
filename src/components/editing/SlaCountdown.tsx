"use client";

import { useEffect, useState } from "react";
import { etMonthDayTime } from "@/lib/datetime";

// A live SLA countdown chip. Takes an ISO due date and ticks every minute so a
// VA glancing at the page always sees the real "due in 14h" / "OVERDUE 2d",
// never a stale server-rendered value. Red past due. Deliberately tiny — used
// both in the editor's Do-Now cards and the owner tracker's countdown column.
export function SlaCountdown({ dueISO, className = "" }: { dueISO: string | null; className?: string }) {
  // The clock is read only once mounted (audit L4, Oct 22 2026): the server's
  // "now" and the browser's differ, so a countdown rendered on both printed
  // different words (React #418 on /edit). Until then it shows the due time.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!dueISO) return <span className={`text-xs text-muted-2 ${className}`}>no due date</span>;
  if (now === null) {
    return <span className={`inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-muted ${className}`}>due {etMonthDayTime(dueISO)}</span>;
  }
  const due = new Date(dueISO).getTime();
  const ms = due - now;
  const overdue = ms < 0;
  const label = overdue ? `OVERDUE ${humanize(-ms)}` : `due in ${humanize(ms)}`;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
        overdue
          ? "bg-danger/10 text-danger"
          : ms < 24 * 3600_000
            ? "bg-warning/15 text-warning"
            : "bg-surface-2 text-muted"
      } ${className}`}
    >
      {label}
    </span>
  );
}

// Coarse human duration: days when ≥1d, else hours, else minutes. One unit only
// — a countdown chip doesn't need "2d 3h 15m", just the magnitude at a glance.
function humanize(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
