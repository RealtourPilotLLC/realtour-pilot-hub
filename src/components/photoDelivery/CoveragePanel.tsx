"use client";

import { CheckCircle2, ChevronDown, CircleHelp, Undo2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { decideFindingsAction } from "@/app/ops/photo-delivery/actions";
import { useJob } from "./JobContext";
import { FINDING_STATUS_LABEL, RESPONSIBILITY_LABEL, SEVERITY_CLASS, SEVERITY_LABEL, UNDOABLE } from "./format";
import type { FindingView } from "./types";

// ---------------------------------------------------------------------------
// THE COVERAGE TAB (plan 9.4): what was ordered (PhotoJob.expectedJson, from
// the live order lines and the photographer's notes) against what the gallery
// holds, then the order-coverage findings (QC pass P4): MET, NOT_MET or
// UNKNOWN items. "Accept with reason" marks a NOT_MET item OVERRIDDEN with the
// reason, which is what the delivery gate's coverage check asks for (9.6).
// ---------------------------------------------------------------------------

const COV_LABEL: Record<string, string> = { MET: "Met", NOT_MET: "Not met", UNKNOWN: "Unknown" };

const btn = "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50";

function Row({ f }: { f: FindingView }) {
  const { decide, pending, ask, run, jobId } = useJob();
  const open = f.status === "OPEN";
  const accept = async () => {
    const reason = await ask({
      title: "Accept this coverage gap?",
      description: "Say why the gallery is fine without it (for example: the client cancelled the drone add-on). It is kept in the activity log.",
      required: true,
      confirmLabel: "Accept",
    });
    if (reason === null) return;
    await run(() => decideFindingsAction({ jobId, findingIds: [f.id], status: "OVERRIDDEN", reason }));
  };
  const cov = f.coverageStatus;
  return (
    <li className={cn("rounded-xl border p-3", open && f.severity !== "MINOR" ? "border-warning/40 bg-warning-soft/20" : "border-border bg-surface")}>
      <div className="flex flex-wrap items-center gap-1.5">
        {cov === "UNKNOWN" ? <CircleHelp aria-hidden className="size-4 text-muted" /> : <XCircle aria-hidden className={cn("size-4", open ? "text-danger" : "text-muted")} />}
        <h3 className="min-w-0 break-words text-sm font-semibold">{f.specificIssue}</h3>
        <span className="text-[12px] font-medium text-muted">{cov ? COV_LABEL[cov] : "Not met or unknown"}</span>
        <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", SEVERITY_CLASS[f.severity])}>{SEVERITY_LABEL[f.severity]}</span>
        <span className="text-[12px] text-muted">{RESPONSIBILITY_LABEL[f.responsibility] ?? f.responsibility}</span>
      </div>
      {f.explanation && <p className="mt-1 break-words text-[13px] text-muted">{f.explanation}</p>}
      {f.recommendedAction && <p className="mt-0.5 text-[13px] text-muted">Suggested: {f.recommendedAction}</p>}
      {!open && (
        <p className="mt-1 text-[13px]">
          <span className="font-medium">{f.status === "OVERRIDDEN" ? "Accepted" : FINDING_STATUS_LABEL[f.status] ?? f.status}</span>
          {f.decidedBy ? ` by ${f.decidedBy}` : ""}
          {f.decidedAt ? `, ${etMonthDayTime(f.decidedAt)}` : ""}
          {f.statusReason ? `: ${f.statusReason}` : ""}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {open && (
          <>
            <button type="button" disabled={pending} onClick={() => void accept()} className={btn}>
              Accept with reason
            </button>
            <button type="button" disabled={pending} onClick={() => void decide([f], "FALSE_POSITIVE")} className={btn}>
              It is in the gallery
            </button>
            <button type="button" disabled={pending} onClick={() => void decide([f], "RESHOOT_REQUESTED")} className={btn}>
              Recommend a reshoot
            </button>
          </>
        )}
        {UNDOABLE.has(f.status) && (
          <button type="button" disabled={pending} onClick={() => void decide([f], "OPEN")} className={btn}>
            <Undo2 aria-hidden className="size-3.5" /> Undo
          </button>
        )}
      </div>
    </li>
  );
}

export function CoveragePanel() {
  const { data } = useJob();
  const p4 = data.findings.filter((f) => f.pass === "P4_ORDER");
  const open = p4.filter((f) => f.status === "OPEN");
  const decided = p4.filter((f) => f.status !== "OPEN");
  const c = data.coverageCounts;
  const want = new Map(data.expected.map((e) => [e.label, e.value]));
  const ran = data.runs.some((r) => r.passes.includes("P4") || r.passes.includes("P4_ORDER"));
  const counts: { label: string; have: number; ordered: string | null }[] = [
    { label: "Photos in the delivery", have: c.photos, ordered: want.get("Photos ordered (at least)") ?? null },
    { label: "Aerial photos", have: c.aerial, ordered: want.get("Drone photos") ?? null },
    { label: "Twilight photos", have: c.twilight, ordered: want.get("Twilight photos") ?? want.get("Virtual twilight photos") ?? null },
    { label: "Virtually staged", have: c.staged, ordered: want.get("Virtually staged photos") ?? null },
  ];
  return (
    <div className="space-y-4">
      <section aria-labelledby="pd-ordered-h">
        <h3 id="pd-ordered-h" className="text-sm font-semibold">What was ordered</h3>
        {data.expected.length === 0 && !data.requestedFeatures.length && !data.specialInstructions ? (
          <p className="mt-1 text-[13px] text-muted">The order carried no counts or requests the hub could read.</p>
        ) : (
          <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            {data.expected.map((e) => (
              <div key={e.label} className="flex justify-between gap-2 border-b border-border py-1" title={e.source ? `From ${e.source}` : undefined}>
                <dt className="text-muted">{e.label}</dt>
                <dd className="text-right font-medium">{e.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {data.requestedFeatures.length > 0 && <p className="mt-2 text-[13px]"><span className="font-medium">Requested:</span> {data.requestedFeatures.join(", ")}</p>}
        {data.specialInstructions && <p className="mt-1 break-words text-[13px] text-muted"><span className="font-medium text-foreground">Notes:</span> {data.specialInstructions}</p>}
      </section>

      <section aria-labelledby="pd-counts-h">
        <h3 id="pd-counts-h" className="text-sm font-semibold">In the gallery</h3>
        <ul className="mt-1.5 grid grid-cols-2 gap-2 text-sm">
          {counts.map((x) => (
            <li key={x.label} className="rounded-lg border border-border bg-surface-2/40 p-2">
              <span className="block text-[12px] text-muted">{x.label}</span>
              <span className="text-base font-semibold tabular-nums">{x.have}</span>
              {x.ordered && <span className="text-[12px] text-muted"> of {x.ordered} ordered</span>}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[12px] text-muted">Aerial, twilight and staged counts come from QC&rsquo;s photo labels, so they read zero until QC has run.</p>
      </section>

      <section aria-labelledby="pd-p4-h" className="space-y-2">
        <h3 id="pd-p4-h" className="text-sm font-semibold">Coverage check</h3>
        {!ran && p4.length === 0 ? (
          <p className="text-[13px] text-muted">The order coverage check has not run on this gallery yet.</p>
        ) : open.length === 0 ? (
          <p className="flex items-center gap-2 text-sm"><CheckCircle2 aria-hidden className="size-4 text-success" /> Nothing ordered is missing{decided.length ? " (or every gap was accepted with a reason)" : ""}.</p>
        ) : (
          <ul className="space-y-2">{open.map((f) => <Row key={f.id} f={f} />)}</ul>
        )}
        {decided.length > 0 && (
          <details className="rounded-xl border border-border">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown aria-hidden className="size-4" /> Accepted or decided ({decided.length})
            </summary>
            <ul className="space-y-2 border-t border-border p-2">{decided.map((f) => <Row key={f.id} f={f} />)}</ul>
          </details>
        )}
        {data.coverageMet.length > 0 && (
          <details className="rounded-xl border border-border">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown aria-hidden className="size-4" /> Met ({data.coverageMet.length})
            </summary>
            <ul className="space-y-1 border-t border-border p-3 text-[13px]">
              {data.coverageMet.map((m, i) => (
                <li key={`${m.label}-${i}`}>
                  <CheckCircle2 aria-hidden className="mr-1 inline size-3.5 text-success" />
                  <span className="font-medium">{m.label}</span>
                  {m.evidence && <span className="text-muted">: {m.evidence}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
