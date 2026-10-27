import { PhoneCall } from "lucide-react";
import { Section } from "@/components/ui/Section";
import type { CallListRow } from "@/lib/callList";

// ---------------------------------------------------------------------------
// PLAN › CALLS, the call list (Oct 27 2026). Jordan: "it should be analyzed
// and assigned automatically." Calls are filed by the matcher
// (lib/callAutoMatch.ts), so this is a calm read: one plain line per call
// (lib/callList.ts) and, under Details, how it was matched. No buttons; the
// month's call card above it keeps its own.
// ---------------------------------------------------------------------------

export function CallsList({ rows }: { rows: CallListRow[] }) {
  return (
    <Section icon={PhoneCall} title="Their calls" count={rows.length || null} flush>
      {rows.length === 0 ? (
        <p className="px-5 py-3 text-[13px] text-muted-2">No calls yet.</p>
      ) : (
        <ul data-call-list className="divide-y divide-border">
          {rows.map((c) => (
            <li key={c.id} data-call-row={c.id} className="px-5 py-2.5 text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{c.title}</span>
                <span className="text-muted">{c.when}</span>
                {c.monthName && <span className="text-[11px] text-muted-2">for {c.monthName}</span>}
              </div>
              <p className={c.warn ? "text-[12px] text-warning" : "text-[12px] text-muted"}>{c.line}</p>
              {(c.matchNote || c.lastError) && (
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-[11px] text-muted-2">Details</summary>
                  {c.matchNote && <p className="mt-1 text-[11px] text-muted">How it was matched: {c.matchNote}</p>}
                  {c.lastError && <p className="mt-0.5 text-[11px] text-muted">Last problem: {c.lastError.slice(0, 200)}</p>}
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
