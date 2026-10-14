"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { SLA_CLASS, slaState } from "./format";

// ---------------------------------------------------------------------------
// The SLA countdown chip (plan 9.3): green, amber under 6 hours left, red
// under 2, "Late by ..." past due. The first render uses the server's clock
// (so the HTML the server sent and the first browser render agree), then it
// ticks once a minute on the viewer's clock.
// ---------------------------------------------------------------------------

export function SlaChip({ dueAt, serverNow, delivered = false, className }: { dueAt: string | null; serverNow: string; delivered?: boolean; className?: string }) {
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    if (delivered || !dueAt) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [dueAt, delivered]);
  const s = slaState(dueAt, now, delivered);
  return (
    <span
      title={dueAt ? `Due ${etDateTime(dueAt)} ET` : "No due time recorded for this job"}
      className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-ui-status font-medium leading-snug ring-1 ring-inset", SLA_CLASS[s.tone], className)}
    >
      <Clock aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">Due: </span>
      {s.label}
    </span>
  );
}
