import { FileText } from "lucide-react";
import { fmtBriefSize, type MonthBriefView } from "@/lib/monthBriefCore";

// ---------------------------------------------------------------------------
// The client's creative brief, read-only (Oct 8 2026) — on the photographer's
// shoot screen and in the editor's brief. Links go through the brief's own
// door, which admits only the people on one of THIS month's jobs. The notes
// are the client's own words for the shoot: shown as written.
// ---------------------------------------------------------------------------

export function BriefReadOnly({ brief, clientPlanned, monthName, className = "" }: { brief: MonthBriefView | null; clientPlanned: boolean; monthName: string; className?: string }) {
  const files = brief?.files ?? [];
  const notes = brief?.notes?.text?.trim() ?? "";
  if (!clientPlanned && files.length === 0 && !notes) return null;
  return (
    <div data-client-brief className={`rounded-xl border border-brand/25 bg-brand-soft/30 p-3 text-sm ${className}`}>
      <p className="font-semibold text-brand">The client&rsquo;s brief for {monthName}</p>
      {clientPlanned && <p className="mt-0.5 text-xs text-muted">Client-planned: they bring their own topics and scripts.</p>}
      {files.length === 0 && !notes && <p className="mt-1 text-xs text-muted">No brief added for this month — go by what they bring on the day.</p>}
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-1.5">
              <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
              <a href={f.href} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand">{f.name}</a>
              <span className="text-[11px] text-muted-2">{fmtBriefSize(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {notes && <p className="mt-2 whitespace-pre-wrap leading-relaxed text-foreground/90">{notes}</p>}
    </div>
  );
}
