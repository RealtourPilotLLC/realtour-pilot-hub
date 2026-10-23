"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { JobProvider, useJob, type TabKey } from "./JobContext";
import { Gallery } from "./Gallery";
import { IssuesPanel } from "./IssuesPanel";
import { FixCartPanel } from "./FixCartPanel";
import { CoveragePanel } from "./CoveragePanel";
import { Lightbox } from "./Lightbox";
import { DeliverPanel } from "./DeliverPanel";
import { HoldingPanel } from "./HoldingPanel";
import { SpecialRequests } from "./SpecialRequests";
import type { JobDetail, Viewer } from "./types";

// ---------------------------------------------------------------------------
// The job page body (plan 9.4): the gallery on the left (about 60%), the
// tabs on the right (Issues, Fix Cart, Coverage, History), the lightbox over
// both, and the Deliver panel stuck to the bottom. On a phone the tabs follow
// the gallery. History (Oct 15 2026: Activity and Files in one tab, under the
// "activity" key) arrives already rendered on the server; it needs no
// interaction.
// ---------------------------------------------------------------------------

export function JobWorkspace({ data, viewer, initialTab, initialPhoto, history, lead }: {
  data: JobDetail;
  viewer: Viewer;
  initialTab?: TabKey;
  initialPhoto?: string | null;
  history: ReactNode;
  /** Oct 22 2026: what the page shows between "What's holding this" and the gallery (the job summary, Before you send). */
  lead?: ReactNode;
}) {
  // A view-only viewer has no Fix Cart tab (Oct 22 2026): an old ?tab=cart link opens Issues.
  const tab = initialTab === "files" ? "activity" : initialTab === "cart" && viewer.readOnly ? "issues" : initialTab;
  return (
    <JobProvider data={data} viewer={viewer} mode="workspace" initialTab={tab} initialPhoto={initialPhoto}>
      {/* Oct 22 2026: what holds this job, first (HoldingPanel). */}
      <div className="mb-4 space-y-4">
        {/* Oct 23 2026 (huddle item 7): the special requests first: lot lines, staging, what the client asked. */}
        <SpecialRequests />
        <HoldingPanel />
        {lead}
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Gallery />
        <RightPanel history={history} />
      </div>
      <DeliverPanel />
      <Lightbox />
    </JobProvider>
  );
}

function RightPanel({ history }: { history: ReactNode }) {
  const { tab, setTab, data, selected, readOnly } = useJob();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const openIssues = data.findings.filter((f) => f.pass !== "P4_ORDER" && f.status === "OPEN" && f.confidence >= data.displayFloor).length;
  const openCoverage = data.findings.filter((f) => f.pass === "P4_ORDER" && f.status === "OPEN").length;
  const inCart = (data.cart?.lines ?? []).filter((l) => !l.humanCall && l.findingIds.some((id) => selected.has(id))).length;
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "issues", label: "Issues", count: openIssues },
    // The Fix Cart spends AutoHDR credits: the office's tab only (Oct 22 2026).
    ...(readOnly ? [] : [{ key: "cart" as const, label: "Fix Cart", count: inCart }]),
    { key: "coverage", label: "Coverage", count: openCoverage },
    { key: "activity", label: "History" },
  ];
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[n].key);
    refs.current[tabs[n].key]?.focus();
  };
  return (
    <section aria-label="Job details" className="panel-shadow min-w-0 rounded-2xl border border-border bg-surface lg:sticky lg:top-20">
      <div role="tablist" aria-label="Job details" className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2">
        {tabs.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[t.key] = el;
            }}
            role="tab"
            id={`pd-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`pd-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => setTab(t.key)}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-3 text-sm font-medium",
              tab === t.key ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {t.label}
            {t.count ? <span className="rounded-full bg-surface-2 px-1.5 text-[12px] tabular-nums">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`pd-panel-${t.key}`}
          aria-labelledby={`pd-tab-${t.key}`}
          hidden={tab !== t.key}
          tabIndex={0}
          className="p-3 sm:p-4 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto"
        >
          {tab === t.key &&
            (t.key === "issues" ? <IssuesPanel /> : t.key === "cart" ? <FixCartPanel /> : t.key === "coverage" ? <CoveragePanel /> : history)}
        </div>
      ))}
    </section>
  );
}
