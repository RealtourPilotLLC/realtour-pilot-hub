"use client";

import { useMemo } from "react";
import { CheckCircle2, ChevronDown, Lock, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { PhotoImg } from "./PhotoImg";
import { FindingActions } from "./FindingActions";
import { photoTitle, useJob } from "./JobContext";
import { FINDING_STATUS_LABEL, RESPONSIBILITY_LABEL, SEVERITY_CLASS, SEVERITY_LABEL, STRATEGY_LABEL, groupFindings, plural, type FindingGroup } from "./format";
import type { FindingView } from "./types";

// ---------------------------------------------------------------------------
// THE ISSUES TAB (plan 9.4, 7.5): finding GROUPS first ("Trash or recycling
// bin, 3 photos"), each with its photos, severity, confidence, who it belongs
// to (photographer, editor, office) and the decision buttons; a decision on a
// group applies to every open finding in it. Decided groups fold away, and
// everything under the confidence floor sits in a collapsed "Low confidence"
// drawer that never blocks delivery. Order coverage (P4) lives on its own tab.
// ---------------------------------------------------------------------------

const LIVE = new Set(["OPEN", "APPROVED_FIX", "FIXING"]);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function StatusChip({ status }: { status: string }) {
  if (status === "OPEN") return null;
  const tone = status === "FIXED" || status === "FALSE_POSITIVE" ? "text-success" : status === "APPROVED_FIX" || status === "FIXING" ? "text-brand" : "text-muted";
  return <span className={cn("text-[12px] font-medium", tone)}>{FINDING_STATUS_LABEL[status] ?? status}</span>;
}

function GroupCard({ g, low = false }: { g: FindingGroup; low?: boolean }) {
  const { photoById, openLightbox, selected } = useJob();
  const first = g.findings[0];
  const single = g.findings.length === 1;
  const inCart = g.findings.some((f) => selected.has(f.id) && f.status === "OPEN");
  return (
    <li className={cn("rounded-xl border bg-surface p-3", g.severity === "CRITICAL" && g.openIds.length ? "border-danger/40" : "border-border")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold ring-1 ring-inset", SEVERITY_CLASS[g.severity])}>{SEVERITY_LABEL[g.severity]}</span>
        <h3 className="min-w-0 break-words text-sm font-semibold">{g.title}</h3>
        {g.photoIds.length > 1 && <span className="text-[13px] text-muted">{plural(g.photoIds.length, "photo")}</span>}
        {g.privacy && (
          <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[12px] font-medium text-danger">
            <Lock aria-hidden className="size-3" /> Privacy
          </span>
        )}
        {g.findings.some((f) => f.isPermanentFeature) && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[12px] text-muted">Permanent feature</span>}
        {g.holds && <span className="rounded-full bg-danger-action px-2 py-0.5 text-[12px] font-semibold text-white">Holds delivery</span>}
        {inCart && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[12px] font-medium">In cart</span>}
        {g.sharedStatus && <StatusChip status={g.sharedStatus} />}
      </div>
      <p className="mt-1 text-[13px] text-muted">
        Confidence {pct(g.confidence)}
        {low && " (below the floor: advisory only)"} · {RESPONSIBILITY_LABEL[g.responsibility] ?? g.responsibility}
        {first.fixStrategy && ` · ${STRATEGY_LABEL[first.fixStrategy] ?? first.fixStrategy}`}
        {first.arbitration === "PENDING" && " · second check pending"}
        {first.arbitration === "OVERTURNED" && " · downgraded by the second check"}
      </p>
      {g.escalationReason && <p className="mt-0.5 text-[13px] text-warning">Raised to {SEVERITY_LABEL[g.severity].toLowerCase()}: {g.escalationReason}</p>}
      {single && (
        <div className="mt-1.5 space-y-1 text-sm">
          <p className="break-words">{first.specificIssue}</p>
          {first.explanation && first.explanation !== first.specificIssue && <p className="break-words text-[13px] text-muted">{first.explanation}</p>}
          {first.locationText && <p className="text-[13px] text-muted">Where: {first.locationText}</p>}
          {first.recommendedAction && <p className="text-[13px] text-muted">Suggested: {first.recommendedAction}</p>}
        </div>
      )}
      {g.photoIds.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Photos with this issue">
          {g.photoIds.slice(0, 12).map((id) => {
            const p = photoById.get(id);
            if (!p) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => openLightbox(id)}
                  className="relative block size-14 overflow-hidden rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-brand"
                  aria-label={`Open ${photoTitle(p)}: ${p.roomLabel}`}
                  title={`${photoTitle(p)}: ${p.roomLabel}`}
                >
                  <PhotoImg photoId={p.id} hash={p.contentHash} fallbackUrl={p.sourceUrl} size="thumb256" alt="" className={cn("size-full object-cover", p.status !== "ACTIVE" && "opacity-40")} />
                  {p.position && <span className="absolute bottom-0 left-0 rounded-tr bg-black/65 px-1 text-[11px] font-semibold text-white">{String(p.position).padStart(2, "0")}</span>}
                </button>
              </li>
            );
          })}
          {g.photoIds.length > 12 && <li className="self-center text-[13px] text-muted">+{g.photoIds.length - 12} more</li>}
        </ul>
      )}
      {!single && (
        <details className="mt-2">
          <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-4" /> Each finding ({g.findings.length})
          </summary>
          <ul className="mt-1 space-y-1.5">
            {g.findings.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </ul>
        </details>
      )}
      {single && first.status !== "OPEN" && (first.statusReason || first.decidedBy) && (
        <p className="mt-1.5 text-[13px] text-muted">
          {FINDING_STATUS_LABEL[first.status] ?? first.status}
          {first.decidedBy ? ` by ${first.decidedBy}` : ""}
          {first.decidedAt ? `, ${etMonthDayTime(first.decidedAt)}` : ""}
          {first.statusReason ? `: ${first.statusReason}` : ""}
        </p>
      )}
      <FindingActions findings={g.findings} className="mt-2.5" />
    </li>
  );
}

function FindingRow({ f }: { f: FindingView }) {
  const { photoById } = useJob();
  const p = f.photoId ? photoById.get(f.photoId) : null;
  return (
    <li className="rounded-lg border border-border bg-surface-2/40 p-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", SEVERITY_CLASS[f.severity])}>{SEVERITY_LABEL[f.severity]}</span>
        {p && <span className="font-medium">{photoTitle(p)} · {p.roomLabel}</span>}
        <span className="text-muted">{pct(f.confidence)}</span>
        <StatusChip status={f.status} />
      </div>
      <p className="mt-0.5 break-words">{f.specificIssue}</p>
      {f.statusReason && <p className="text-muted">{f.statusReason}</p>}
    </li>
  );
}

export function IssuesPanel() {
  const { data, shown } = useJob();
  const visible = useMemo(() => data.findings.filter((f) => f.pass !== "P4_ORDER"), [data.findings]);
  const main = useMemo(() => groupFindings(visible.filter((f) => shown(f)), data.groupMeta), [visible, shown, data.groupMeta]);
  const low = useMemo(() => groupFindings(visible.filter((f) => !shown(f)), data.groupMeta), [visible, shown, data.groupMeta]);
  const live = main.filter((g) => g.findings.some((f) => LIVE.has(f.status)));
  const decided = main.filter((g) => !g.findings.some((f) => LIVE.has(f.status)));
  const openCount = visible.filter((f) => f.status === "OPEN" && shown(f)).length;
  const ranQc = data.runs.length > 0;

  if (!ranQc && visible.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-surface-2/40 p-4 text-sm text-muted">
        QC has not run on this gallery yet.{data.freeCheck ? " The free photo check runs on its own once AutoHDR's edits are in." : data.qcEnabled && data.paidQcAuto ? " It starts on its own once the gallery has landed." : data.qcEnabled ? " Press Run QC once the photos are in." : " QC is switched off in Photo Delivery settings."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {live.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-success/30 bg-success-soft/40 p-3 text-sm">
          <CheckCircle2 aria-hidden className="size-4 text-success" /> No open issues above the confidence floor.
        </p>
      ) : (
        <>
          <p className="text-[13px] text-muted">
            {plural(openCount, "open issue")} in {plural(live.length, "group")}. A decision on a group applies to every photo in it.
          </p>
          <ul className="space-y-2">
            {live.map((g) => (
              <GroupCard key={g.key} g={g} />
            ))}
          </ul>
        </>
      )}
      {decided.length > 0 && (
        <details className="rounded-xl border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-4" /> Decided and fixed ({decided.length})
          </summary>
          <ul className="space-y-2 border-t border-border p-2">
            {decided.map((g) => (
              <GroupCard key={g.key} g={g} />
            ))}
          </ul>
        </details>
      )}
      {low.length > 0 && (
        <details className="rounded-xl border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ShieldAlert aria-hidden className="size-4" /> Low confidence ({low.reduce((n, g) => n + g.findings.length, 0)})
            <span className="text-[12px] font-normal text-muted-2">under {pct(data.displayFloor)}, never blocks delivery</span>
          </summary>
          <ul className="space-y-2 border-t border-border p-2">
            {low.map((g) => (
              <GroupCard key={g.key} g={g} low />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
