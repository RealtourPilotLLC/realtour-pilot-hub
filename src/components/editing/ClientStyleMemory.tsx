import { Ban, Film, Star } from "lucide-react";
import type { StyleMemory } from "@/lib/creativeGuard";

// ---------------------------------------------------------------------------
// THE CLIENT'S STYLE, ON ONE CARD (Oct 15 2026). Shown on the editor brief
// and in the Review Room: what works for this client (their proven format),
// what they stopped (never make one of these), their own example videos, and
// the last videos we made them that were approved. Read-only; the office
// edits the first two on the client file (CreativeGuardEditor).
// ---------------------------------------------------------------------------

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;

export function ClientStyleMemory({ memory, title = "Their style" }: { memory: StyleMemory | null | undefined; title?: string }) {
  if (!memory) return null;
  const g = memory.guard;
  const has = (g && (g.provenFormats.length > 0 || g.discontinued.length > 0 || g.experimentCap != null)) || memory.examples.length > 0 || memory.recentVideos.length > 0;
  if (!has) return null;
  return (
    <div className="rounded-2xl border border-border bg-surface p-4" data-style-memory>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2 space-y-2 text-sm">
        {g && g.provenFormats.length > 0 && (
          <p className="flex items-start gap-1.5"><Star className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden /><span><span className="text-muted">What works for them:</span> {g.provenFormats.join("; ")}</span></p>
        )}
        {g && g.discontinued.length > 0 && (
          <ul className="space-y-1" data-discontinued>
            {g.discontinued.map((d) => (
              <li key={d.name} className="flex items-start gap-1.5">
                <Ban className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
                <span><span className="font-medium">Don&rsquo;t make &ldquo;{d.name}&rdquo;</span>{d.reason ? <span className="text-muted"> · {d.reason}</span> : null}<span className="text-xs text-muted-2"> · stopped{day(d.at) ? ` ${day(d.at)}` : ""}{d.by ? ` by ${d.by.split(/\s+/)[0]}` : ""}</span></span>
              </li>
            ))}
          </ul>
        )}
        {g && g.experimentCap != null && (
          <p className="text-xs text-muted">{g.experimentCap === 0 ? "No experimental concepts: stay in the proven format." : `At most ${g.experimentCap} experimental concept${g.experimentCap === 1 ? "" : "s"} a month.`}</p>
        )}
        {memory.examples.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted">Their example videos</p>
            <ul className="mt-0.5 flex flex-wrap gap-2">
              {memory.examples.map((x, i) => (
                <li key={i} className="inline-flex min-w-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs">
                  <Film className="size-3 text-muted" aria-hidden />
                  {x.url ? <a href={x.url} target="_blank" rel="noopener noreferrer" className="truncate text-brand hover:underline">{x.name}</a> : <span className="truncate">{x.name}{x.text ? `: ${x.text}` : ""}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {memory.recentVideos.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted">Their last approved videos</p>
            <ul className="mt-0.5 space-y-0.5">
              {memory.recentVideos.map((v) => (
                <li key={v.url} className="text-xs">
                  <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{v.title}</a>
                  {day(v.approvedAtISO) && <span className="text-muted-2"> · approved {day(v.approvedAtISO)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
