"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { EditorsTodayView } from "@/lib/editorActivity";
import { readFreshness } from "@/components/editing/WorkingNowPanel";

/** The existing Start/Pause and activity evidence, kept short above the queue. */
export function EditingWorkSummary({ view }: { view: EditorsTodayView }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const freshness = readFreshness(view, now);
  return (
    <section aria-label="Editors today" className="rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <h2 className="font-semibold">Editors today</h2>
        <span className={cn("text-muted", freshness.state !== "fresh" && "text-warning")} role={freshness.state !== "fresh" ? "status" : undefined}>{freshness.words}</span>
      </div>
      {view.ok ? (
        <ul className="mt-1.5 grid gap-x-5 gap-y-2 text-sm lg:grid-cols-2">
          {view.lines.map((line) => (
            <li key={line.key} className="min-w-0 leading-relaxed">
              <span className="font-semibold">{line.name}</span>{" · "}
              <span className={cn(line.tone === "on" ? "text-success" : line.tone === "unknown" ? "text-warning" : "text-muted")}>
                {line.tone === "on" ? "Pressed Start · " : ""}{line.lead}{" "}
              </span>
              {line.job && <Link href={line.job.href} className="font-medium underline decoration-border underline-offset-2 hover:decoration-brand focus-visible:outline-2 focus-visible:outline-brand">{line.job.street}</Link>}
              {line.tail && <span className="text-muted"> {line.tail}</span>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 text-sm text-muted">Refresh to try again. The work state is unknown.</p>}
    </section>
  );
}
