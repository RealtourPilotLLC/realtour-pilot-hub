"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, ListChecks, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CAUSE_LABEL, ISSUE_CATEGORIES, ISSUE_CAUSES, ISSUE_STATE_LABEL, isEditorCaused } from "@/lib/issueCauses";
import {
  classifyIssueAction,
  markIssueNotNeededAction,
  mergeIssueAction,
  reopenIssueAction,
  splitIssueAction,
  verifyIssueAction,
} from "@/app/review/issueActions";
import type { IssueView } from "@/lib/revisionIssues";

// ---------------------------------------------------------------------------
// THE JOB'S REVISION ISSUES (§8.3) — every actionable ask on this job's videos,
// by the video and version it is on, with where it came from and where it
// stands. Read by the job, never by editor key, so an editor who inherits a
// job sees what the last editor was asked (the reassignment gap getEditorFeedback
// had). Reviewers classify, verify, merge duplicates, split mixed asks and mark
// asks not needed here; the editor's "done" is their send-for-review check.
// A cause is never shown as a verdict on anybody until a reviewer confirms it.
// ---------------------------------------------------------------------------

export type AttestationView = {
  submissionId: string;
  round: number;
  label: string;
  actorName: string;
  onBehalfOf: string | null;
  atISO: string;
  checklistKey: string;
  notApplicable: { label: string; reason: string | null }[];
  notAddressed: { text: string; reason: string }[];
};

const fmtT = (t: number | null) => (t == null ? "" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")} `);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function stateTone(state: string): string {
  if (state === "VERIFIED") return "bg-success/10 text-success";
  if (state === "ADDRESSED") return "bg-brand-soft text-brand";
  if (state === "OPEN" || state === "REOPENED") return "bg-warning-soft text-warning";
  return "bg-surface-2 text-muted";
}

function IssueRow({ issue, all, canReview }: { issue: IssueView; all: IssueView[]; canReview: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "na" | "merge" | "split">(null);
  const [text, setText] = useState("");
  const [into, setInto] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn().catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "That didn't go through." }));
      setMsg(r.message);
      if (r.ok) { setMode(null); setText(""); router.refresh(); }
    });
  const live = issue.state === "OPEN" || issue.state === "REOPENED" || issue.state === "ADDRESSED";
  const others = all.filter((o) => o.id !== issue.id && !o.duplicateOfId);
  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-start gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", stateTone(issue.state))}>{ISSUE_STATE_LABEL[issue.state] ?? issue.state}</span>
        <p className="min-w-0 flex-1 text-sm leading-snug">
          <span className="font-mono text-[11px] text-muted-2">{fmtT(issue.timeSec)}</span>
          {issue.summary ?? issue.text}
        </p>
      </div>
      {issue.summary && issue.summary !== issue.text && <p className="mt-1 text-xs italic text-muted">&ldquo;{issue.text.slice(0, 400)}&rdquo;</p>}
      <p className="mt-1 text-[11px] text-muted-2">
        {issue.category} · {issue.severity.toLowerCase()} · {issue.sourceKind === "BRIEF_ITEM" ? `client ask${issue.sourceChannel ? ` (${issue.sourceChannel})` : ""}` : issue.sourceKind === "MANUAL" ? "split out" : issue.raisedByName ?? "review note"}
        {issue.raisedOnRound ? ` · on v${issue.raisedOnRound}` : ""}
        {issue.addressedInRound ? ` · editor says fixed in v${issue.addressedInRound}` : ""}
        {issue.verifiedInRound ? ` · verified on v${issue.verifiedInRound}` : ""}
        {issue.missedInRound ? ` · still open when v${issue.missedInRound} was sent back` : ""}
        {issue.foundAfterApproval ? " · found after approval" : ""}
        {issue.imported ? " · from before the ledger" : ""}
      </p>
      {/* The cause is a reviewer's verdict on a version: an editor sees it on
          their own versions only — the server leaves it out otherwise (§8.4,
          revisionIssues.issuesForProject `viewer`). */}
      {!issue.causeHidden && (
        <p className="mt-0.5 text-[11px]">
          <span className={cn("font-medium", issue.cause === "UNCLASSIFIED" ? "text-muted-2" : isEditorCaused(issue.cause) ? "text-danger" : "text-foreground/80")}>
            Cause: {issue.causeLabel}
          </span>
          {issue.causeConfirmedBy ? <span className="text-muted-2"> — confirmed by {issue.causeConfirmedBy}</span> : null}
          {issue.cause === "UNCLASSIFIED" && issue.causeSuggested ? <span className="text-muted-2"> — suggested: {CAUSE_LABEL[issue.causeSuggested as keyof typeof CAUSE_LABEL] ?? issue.causeSuggested}</span> : null}
        </p>
      )}
      {canReview && !issue.duplicateOfId && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Cause"
            disabled={pending}
            value={issue.cause}
            onChange={(e) => run(() => classifyIssueAction(issue.id, { cause: e.target.value }))}
            className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs"
          >
            {ISSUE_CAUSES.map((c) => <option key={c} value={c}>{CAUSE_LABEL[c]}</option>)}
          </select>
          <select
            aria-label="Category"
            disabled={pending}
            value={issue.category}
            onChange={(e) => run(() => classifyIssueAction(issue.id, { cause: issue.cause, category: e.target.value }))}
            className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs"
          >
            {ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {issue.foundAfterApproval && (
            <label className="inline-flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                disabled={pending}
                checked={issue.reviewMiss === true}
                onChange={(e) => run(() => classifyIssueAction(issue.id, { cause: issue.cause, reviewMiss: e.target.checked }))}
              />
              review should have caught it
            </label>
          )}
          {issue.state === "ADDRESSED" && (
            <button type="button" disabled={pending} onClick={() => run(() => verifyIssueAction(issue.id))} className="rounded-lg border border-success/50 px-2 py-1 text-xs font-semibold text-success hover:bg-success/10">
              Verify fix
            </button>
          )}
          {(issue.state === "ADDRESSED" || issue.state === "VERIFIED" || issue.state === "NOT_APPLICABLE") && (
            <button type="button" disabled={pending} onClick={() => run(() => reopenIssueAction(issue.id))} className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2">
              Reopen
            </button>
          )}
          {live && (
            <button type="button" disabled={pending} onClick={() => setMode(mode === "na" ? null : "na")} className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2">
              Not needed
            </button>
          )}
          {others.length > 0 && (
            <button type="button" disabled={pending} onClick={() => setMode(mode === "merge" ? null : "merge")} className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2">
              Duplicate of…
            </button>
          )}
          <button type="button" disabled={pending} onClick={() => setMode(mode === "split" ? null : "split")} className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-surface-2">
            Split
          </button>
          {pending && <Loader2 className="size-3.5 animate-spin text-muted" />}
        </div>
      )}
      {mode === "na" && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Why it isn't needed" className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs" />
          <button type="button" disabled={pending} onClick={() => run(() => markIssueNotNeededAction(issue.id, text))} className="rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white">Mark not needed</button>
        </div>
      )}
      {mode === "merge" && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <select value={into} onChange={(e) => setInto(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs">
            <option value="">The issue this repeats…</option>
            {others.map((o) => <option key={o.id} value={o.id}>{(o.summary ?? o.text).slice(0, 80)}</option>)}
          </select>
          <button type="button" disabled={pending || !into} onClick={() => run(() => mergeIssueAction(issue.id, into))} className="rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white">Merge</button>
        </div>
      )}
      {mode === "split" && (
        <div className="mt-2 space-y-1.5">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={"One part per line, e.g.\nFix the agent's name in the end card\nAdd the pool shot the client asked for"} className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs" />
          <button type="button" disabled={pending} onClick={() => run(() => splitIssueAction(issue.id, text.split("\n")))} className="rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white">Split into parts</button>
        </div>
      )}
      {msg && <p className="mt-1.5 text-[11px] text-muted">{msg}</p>}
      {canReview && issue.events.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-muted-2">History ({issue.events.length})</summary>
          <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
            {issue.events.map((e, n) => (
              <li key={n}>
                {when(e.atISO)} · {e.actorName} · {e.kind.toLowerCase().replace(/_/g, " ")}
                {e.from || e.to ? ` (${e.from ?? "—"} → ${e.to ?? "—"})` : ""}
                {e.note ? ` — ${e.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function RevisionIssuesPanel({ issues, canReview, attestations = [] }: { issues: IssueView[]; canReview: boolean; attestations?: AttestationView[] }) {
  if (issues.length === 0 && attestations.length === 0) return null;
  const groups = new Map<string, IssueView[]>();
  for (const i of issues.filter((x) => !x.duplicateOfId)) {
    const k = i.cutLabel ?? (i.cutKey ? "Video" : "The whole job");
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const open = issues.filter((i) => i.state === "OPEN" || i.state === "REOPENED").length;
  const toVerify = issues.filter((i) => i.state === "ADDRESSED").length;
  const unclassified = issues.filter((i) => i.cause === "UNCLASSIFIED" && !i.duplicateOfId && i.state !== "NOT_APPLICABLE").length;
  return (
    <section id="issues" className="panel-shadow scroll-mt-20 overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <ListChecks className="size-4 text-brand" />
        <h2 className="text-sm font-semibold">Revision issues</h2>
        <span className="text-xs text-muted">
          {open} open · {toVerify} waiting on a verify{canReview ? ` · ${unclassified} not classified` : ""}
        </span>
      </div>
      <div className="space-y-4 px-4 py-3 sm:px-5">
        {[...groups.entries()].map(([label, list]) => (
          <div key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-2">{label}</p>
            <ul className="mt-2 space-y-2">
              {list.map((i) => <IssueRow key={i.id} issue={i} all={issues} canReview={canReview} />)}
            </ul>
          </div>
        ))}
        {attestations.length > 0 && (
          <div>
            <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-2">
              <ClipboardCheck className="size-3.5" /> Send-for-review checks
            </p>
            <ul className="mt-2 space-y-1.5">
              {attestations.map((a) => (
                <li key={a.submissionId} className="rounded-lg border border-border px-3 py-2 text-xs">
                  <span className="font-medium">{a.label} v{a.round}</span> — checked by {a.actorName}
                  {a.onBehalfOf ? ` for ${a.onBehalfOf}` : ""} · {when(a.atISO)} · {a.checklistKey}
                  {a.notApplicable.map((n, k) => <p key={`na${k}`} className="mt-0.5 text-muted">Not for this video: {n.label} — {n.reason}</p>)}
                  {a.notAddressed.map((n, k) => <p key={`nd${k}`} className="mt-0.5 text-warning">Not done: {n.text} — {n.reason}</p>)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
