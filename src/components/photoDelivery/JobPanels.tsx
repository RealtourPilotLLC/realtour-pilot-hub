import { ChevronDown } from "lucide-react";
import { etDateTime, etMonthDayTime } from "@/lib/datetime";
import { STRATEGY_LABEL, VERDICT_LABEL, prettyEnum, usd } from "./format";
import type { EventView, FixBatchView, JobHeaderView, PhotoView, RunView } from "./types";

// ---------------------------------------------------------------------------
// The job page's read-only HISTORY tab, rendered on the server (Oct 15 2026:
// Activity and Files became one tab):
//   · the files (plan 9.4), behind one closed line: where the photos are read
//     from (Aryeo listing or Dropbox), the AutoHDR shoot when linked, every
//     version per photo, the QC runs (status, cost for the owner) and the fix
//     batches;
//   · the PhotoJobEvent timeline, newest first (plan 0.3: every automated
//     decision and every human action is logged).
// ---------------------------------------------------------------------------

export function HistoryPanel({ events, ...files }: { events: EventView[] } & FilesProps) {
  return (
    <div className="space-y-4">
      <details className="group rounded-xl border border-border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
          Photos, versions, QC runs and fixes
          <ChevronDown aria-hidden className="size-4 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-border p-3">
          <FilesPanel {...files} />
        </div>
      </details>
      <ActivityPanel events={events} />
    </div>
  );
}

export function ActivityPanel({ events }: { events: EventView[] }) {
  if (!events.length) return <p className="text-sm text-muted">Nothing logged yet.</p>;
  return (
    <ol className="space-y-2" aria-label="Activity, newest first">
      {events.map((e) => (
        <li key={e.id} className="border-l-2 border-border pl-3">
          <p className="text-[12px] text-muted">
            {etDateTime(e.at)} · <span className="font-medium text-foreground">{e.actor}</span>
          </p>
          <p className="break-words text-sm">{e.action}</p>
          {e.detail && (
            <details className="mt-0.5">
              <summary className="inline-flex min-h-8 cursor-pointer items-center text-[12px] text-muted hover:text-foreground">Details</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-snug">{e.detail}</pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

const SOURCE_LABEL: Record<string, string> = { ARYEO: "Aryeo listing", DROPBOX: "Dropbox", AUTOHDR: "AutoHDR" };

/** `showCredits`: false for a view-only viewer (Oct 22 2026): the fix batches say what ran, never how many credits. */
type FilesProps = { header: JobHeaderView; photos: PhotoView[]; runs: RunView[]; batches: FixBatchView[]; canSeeMoney: boolean; showCredits?: boolean };

export function FilesPanel({ header, photos, runs, batches, canSeeMoney, showCredits = true }: FilesProps) {
  const nameOf = new Map(photos.map((p) => [p.id, p.name]));
  const sources = [...new Set(photos.map((p) => p.sourceKind))];
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="font-semibold">Where the photos come from</h3>
        <p className="mt-1 text-muted">
          {photos.length === 0 ? "No photos yet." : sources.map((s) => SOURCE_LABEL[s] ?? s).join(" and ")}
          {photos.length > 0 && ` · ${photos.length} photo${photos.length === 1 ? "" : "s"} seen`}
        </p>
        <p className="mt-1">
          <span className="text-muted">AutoHDR shoot: </span>
          {header.autohdrPhotoshootId ? (
            <>
              #{header.autohdrPhotoshootId}
              {header.autohdrShootName ? ` (${header.autohdrShootName})` : ""}
              {header.autohdrExpiresAt ? `, expires ${etMonthDayTime(header.autohdrExpiresAt)}` : ""}
            </>
          ) : (
            <span className="text-muted">not linked yet (fixes need it)</span>
          )}
        </p>
      </section>

      <section>
        <h3 className="font-semibold">Photos and versions</h3>
        <ul className="mt-1.5 divide-y divide-border rounded-xl border border-border">
          {photos.map((p) => (
            <li key={p.id} className="p-2.5">
              <p className="flex flex-wrap items-center gap-x-2">
                <span className="break-all font-medium">{p.name}</span>
                <span className="text-[12px] text-muted">{SOURCE_LABEL[p.sourceKind] ?? p.sourceKind}</span>
                {p.status !== "ACTIVE" && <span className="text-[12px] text-warning">{p.status === "EXCLUDED" ? "left out" : "no longer in the gallery"}</span>}
              </p>
              {p.versions.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
                  {p.versions.map((v) => (
                    <li key={v.id}>
                      {v.label} · {prettyEnum(v.source)} · {etMonthDayTime(v.createdAt)}
                      {v.createdBy ? ` · ${v.createdBy}` : ""}
                      {v.current ? " · current" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="font-semibold">QC runs</h3>
        {runs.length === 0 ? (
          <p className="mt-1 text-muted">QC has not run on this job.</p>
        ) : (
          <div className="mt-1.5 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[26rem] text-[13px]">
              <thead className="text-left text-[12px] text-muted">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">Started</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Why</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Status</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Verdict</th>
                  {canSeeMoney && <th scope="col" className="px-2 py-1.5 font-medium">Cost</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-2 py-1.5">{etMonthDayTime(r.startedAt)}</td>
                    <td className="px-2 py-1.5">{prettyEnum(r.trigger)}{r.shadow ? " (shadow)" : ""}</td>
                    <td className="px-2 py-1.5">
                      {prettyEnum(r.status)}
                      {r.error && <span className="block max-w-[14rem] break-words text-[12px] text-warning">{r.error}</span>}
                    </td>
                    <td className="px-2 py-1.5">{r.verdict ? VERDICT_LABEL[r.verdict] ?? r.verdict : "None yet"}</td>
                    {canSeeMoney && <td className="px-2 py-1.5 tabular-nums">{r.costUsd != null ? usd(r.costUsd) : ""}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="font-semibold">Fix batches</h3>
        {batches.length === 0 ? (
          <p className="mt-1 text-muted">No fixes approved on this job.</p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {batches.map((b) => (
              <li key={b.id} className="rounded-xl border border-border p-2.5">
                <p>
                  <span className="font-medium">{prettyEnum(b.status)}</span> · {prettyEnum(b.mode)}
                  {showCredits ? ` · est. ${b.estimatedCredits} credit${b.estimatedCredits === 1 ? "" : "s"}` : ""}
                  {canSeeMoney && b.estimatedUsd != null ? ` (${usd(b.estimatedUsd)})` : ""}
                </p>
                <p className="text-[12px] text-muted">Approved by {b.approvedBy}, {etDateTime(b.approvedAt)}</p>
                {b.operations.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[12px]">
                    {b.operations.map((o) => (
                      <li key={o.id}>
                        {nameOf.get(o.photoId) ?? "Photo"}: {STRATEGY_LABEL[o.strategy] ?? o.strategy} · {prettyEnum(o.status)}
                        {!showCredits ? "" : o.chargedCredits != null ? ` · charged ${o.chargedCredits}` : ` · est. ${o.estimatedCredits}`}
                        {o.error && <span className="text-warning"> · {o.error}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
