"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, MessageSquareWarning } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDate } from "@/lib/datetime";
import type { OpenComplaint } from "@/lib/clientIssuePlan";
import { listOpenComplaintsAction } from "@/app/clients/complaintPlanActions";
import { STATE_WORDS } from "@/lib/clientIssuesCore";
import { ComplaintPlan } from "@/components/clientCare/ComplaintPlan";

// ---------------------------------------------------------------------------
// OPEN CLIENT COMPLAINTS on Kyle's desk and James's (Oct 29 2026): "I'd want
// Kyle to have these options too. James also needs to be able to see this as
// well since he is the creative manager." Every open complaint, its plan's
// progress, and how many of its steps are on this person's list; a row opens
// the same plan panel Jordan's dashboard shows. It reads the records itself
// and again every 45 seconds while in view. Nothing open: no card.
// ---------------------------------------------------------------------------

const POLL_MS = 45_000;

export function ComplaintsCard({ readOnly = false, className }: { readOnly?: boolean; className?: string }) {
  const [rows, setRows] = useState<OpenComplaint[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await listOpenComplaintsAction().catch(() => null);
    if (r?.ok) setRows(r.rows);
  }, []);
  useEffect(() => {
    void reload();
    const id = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  if (!rows || rows.length === 0) return null;
  const mine = rows.reduce((n, r) => n + r.mine, 0);
  return (
    <section aria-labelledby="complaints-title" data-desk-card="complaints" data-count={rows.length} className={cn("panel-shadow flex min-w-0 flex-col rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5", className)}>
      <h2 id="complaints-title" className="flex items-center gap-2 text-xl font-semibold leading-tight"><MessageSquareWarning aria-hidden className="size-5 text-danger" />Client complaints</h2>
      <p className="mt-0.5 text-sm text-muted">{rows.length} open{mine ? ` · ${mine} step${mine === 1 ? "" : "s"} on your list` : ""}. Jordan, Kyle and James work the same plan.</p>
      <ul className="mt-3 divide-y divide-border">
        {rows.map((r) => {
          const isOpen = open === r.issueId;
          return (
            <li key={r.issueId} className="py-2" data-complaint-row={r.issueId}>
              <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                <button type="button" onClick={() => setOpen(isOpen ? null : r.issueId)} aria-expanded={isOpen} className="flex min-h-11 min-w-0 flex-1 basis-56 items-start gap-1.5 text-left">
                  {isOpen ? <ChevronDown aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" /> : <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />}
                  <span className="min-w-0">
                    <span className="block font-medium [overflow-wrap:anywhere]">{r.clientName ?? "A client"}: {r.title}</span>
                    <span className={cn("block text-[12px] [overflow-wrap:anywhere]", r.progress.late ? "text-danger" : "text-muted")}>
                      {r.needsPlan ? "No plan yet" : r.progress.words}
                    </span>
                  </span>
                </button>
                <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  {r.mine > 0 && <span className="rounded bg-brand/10 px-1.5 py-0.5 font-medium text-brand">{r.mine} yours</span>}
                  {r.state !== "OPEN" && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-muted">{STATE_WORDS[r.state]}</span>}
                  <span className="text-muted-2">{etDate(r.createdAtISO)}</span>
                </span>
              </div>
              {isOpen && (
                <div className="mt-2 space-y-2">
                  <ComplaintPlan issueId={r.issueId} readOnly={readOnly} fallbackWords={r.summary} sendUp={!readOnly} />
                  <Link href={`/clients/${r.clientId}#issue-${r.issueId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand">Open on {r.clientName?.split(" ")[0] ?? "the client"}&rsquo;s page</Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
