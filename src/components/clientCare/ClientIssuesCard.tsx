"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, MessageSquareWarning } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { createClientIssueAction, dismissClientIssueAction, moveClientIssueAction, updateClientIssueAction } from "@/app/clients/clientCareActions";
import { COMPLAINT_CAUSES, STATE_WORDS } from "@/lib/clientIssuesCore";
import type { ClientIssueView } from "@/lib/clientIssues";
import { etDayKey } from "@/lib/datetime";
import { ComplaintPlan } from "@/components/clientCare/ComplaintPlan";

// ---------------------------------------------------------------------------
// COMPLAINTS on the client file (Oct 15 2026): what happened, the impact, the
// cause, what we did, what we changed so it doesn't happen again, who owns it
// and by when, and whether the client said they are satisfied. Marking it
// corrected gives Kyle a task to check in with the client two business days
// later; nothing is ever sent to the client from here.
// ---------------------------------------------------------------------------

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");
const TONE: Record<string, string> = {
  OPEN: "bg-danger/10 text-danger",
  CORRECTED: "bg-warning/10 text-warning",
  CONFIRMED_SATISFIED: "bg-success/10 text-success",
  UNRESOLVED: "bg-danger/10 text-danger",
};

function OneIssue({ issue, canEdit, projects, sendUp = false }: { issue: ClientIssueView; canEdit: boolean; projects: { id: string; title: string }[]; sendUp?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [impact, setImpact] = useState(issue.impact ?? "");
  const [cause, setCause] = useState(issue.cause ?? "");
  const [correction, setCorrection] = useState(issue.correction ?? "");
  const [processChange, setProcessChange] = useState(issue.processChange ?? "");
  const [ownerName, setOwnerName] = useState(issue.ownerName ?? "");
  // The ET day of the due (Oct 28 2026), not the first ten characters of a UTC stamp.
  const [due, setDue] = useState(issue.dueAtISO ? etDayKey(new Date(issue.dueAtISO)) : "");
  const [note, setNote] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      setMsg(null);
      const r = await fn().catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  const jobTitles = issue.projectIds.map((id) => projects.find((p) => p.id === id)).filter(Boolean) as { id: string; title: string }[];
  const field = "mt-0.5 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm";
  return (
    <li id={`issue-${issue.id}`} className="scroll-mt-24 rounded-xl border border-border px-3 py-2.5" data-client-issue={issue.state}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{issue.title}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", TONE[issue.state])}>{STATE_WORDS[issue.state]}</span>
        <span className="text-[11px] text-muted-2">opened {day(issue.createdAtISO)} · {issue.source}</span>
      </div>
      {/* Oct 29 2026: the plan (summary, steps, preferences, KPI) for the people who work complaints; everyone else reads the words. */}
      {canEdit ? (
        <div className="mt-1.5"><ComplaintPlan issueId={issue.id} compact fallbackWords={issue.summary ?? issue.whatHappened} sendUp={sendUp} /></div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">{issue.summary ?? issue.whatHappened}</p>
      )}
      {jobTitles.length > 0 && <p className="mt-0.5 text-xs text-muted">Jobs: {jobTitles.map((p, i) => <span key={p.id}>{i ? ", " : ""}<Link href={`/projects/${p.id}`} className="text-brand hover:underline">{p.title.split(",")[0]}</Link></span>)}</p>}
      <details className="mt-1.5" open={issue.state === "OPEN" && !issue.summary}>
        <summary className="cursor-pointer text-xs font-medium text-brand">Cause, correction and owner</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted">Impact on the client<textarea value={impact} onChange={(e) => setImpact(e.target.value)} rows={2} disabled={!canEdit || pending} className={field} /></label>
          <label className="text-xs text-muted">Cause
            <select value={cause} onChange={(e) => setCause(e.target.value)} disabled={!canEdit || pending} className={field}>
              <option value="">Not decided yet</option>
              {COMPLAINT_CAUSES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">What we did to correct it<textarea value={correction} onChange={(e) => setCorrection(e.target.value)} rows={2} disabled={!canEdit || pending} className={field} /></label>
          <label className="text-xs text-muted">What we changed so it doesn&rsquo;t happen again<textarea value={processChange} onChange={(e) => setProcessChange(e.target.value)} rows={2} disabled={!canEdit || pending} className={field} /></label>
          <label className="text-xs text-muted">Owner<input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} disabled={!canEdit || pending} placeholder="Jordan" className={field} /></label>
          <label className="text-xs text-muted">Due<input type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={!canEdit || pending} className={field} /></label>
        </div>
        {canEdit && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => updateClientIssueAction({ id: issue.id, impact, cause: cause || null, correction, processChange, ownerName: ownerName || null, ownerKey: ownerName ? ownerName.trim().split(/\s+/)[0].toLowerCase() : null, dueISO: due || null }))}
            className="mt-2 min-h-11 rounded-lg border border-border px-3 text-sm font-medium"
          >
            Save
          </button>
        )}
      </details>
      {issue.correctedAtISO && <p className="mt-1 text-xs text-muted">Corrected {day(issue.correctedAtISO)}{issue.state === "CORRECTED" ? ". Kyle checks in with the client two business days after." : "."}</p>}
      {issue.confirmedAtISO && <p className="text-xs text-muted">{issue.state === "CONFIRMED_SATISFIED" ? "Client satisfied" : "Not resolved"} {day(issue.confirmedAtISO)}{issue.confirmationNote ? `: ${issue.confirmationNote}` : ""}</p>}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {issue.state === "OPEN" && <button type="button" disabled={pending || correction.trim().length < 3} title={correction.trim().length < 3 ? "Write what was done to correct it first" : undefined} onClick={() => run(() => moveClientIssueAction({ id: issue.id, to: "CORRECTED", correction, processChange }))} className="min-h-11 rounded-lg bg-brand-action px-3 text-sm font-medium text-white disabled:opacity-50">{pending && <Loader2 className="mr-1 inline size-4 animate-spin" />}Mark corrected</button>}
          {(issue.state === "CORRECTED" || issue.state === "OPEN") && (
            <>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What the client said" className="min-h-11 min-w-0 flex-1 basis-48 rounded-md border border-border bg-surface px-2 text-sm" />
              {issue.state === "CORRECTED" && <button type="button" disabled={pending} onClick={() => run(() => moveClientIssueAction({ id: issue.id, to: "CONFIRMED_SATISFIED", note }))} className="min-h-11 rounded-lg border border-success/40 px-3 text-sm font-medium text-success">Client satisfied</button>}
              <button type="button" disabled={pending || note.trim().length < 3} onClick={() => run(() => moveClientIssueAction({ id: issue.id, to: "UNRESOLVED", note }))} className="min-h-11 rounded-lg border border-danger/40 px-3 text-sm font-medium text-danger disabled:opacity-50">Not resolved</button>
            </>
          )}
          {(issue.state === "UNRESOLVED" || issue.state === "CONFIRMED_SATISFIED") && <button type="button" disabled={pending} onClick={() => run(() => moveClientIssueAction({ id: issue.id, to: "OPEN", note }))} className="min-h-11 rounded-lg border border-border px-3 text-sm">Reopen</button>}
          {issue.state === "OPEN" && <button type="button" disabled={pending || note.trim().length < 3} title="Not a complaint after all: say why in the box" onClick={() => run(() => dismissClientIssueAction({ id: issue.id, reason: note }))} className="min-h-11 rounded-lg px-2 text-xs text-muted disabled:opacity-50">Not a complaint</button>}
        </div>
      )}
      {issue.history.length > 1 && (
        <details className="mt-1"><summary className="cursor-pointer text-[11px] text-muted">History</summary>
          <ul className="mt-0.5 space-y-0.5 text-[11px] text-muted">{issue.history.map((h, i) => <li key={i}>{day(h.at)}{h.by ? ` · ${h.by}` : ""}: {h.what}</li>)}</ul>
        </details>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </li>
  );
}

// Oct 27 2026 (Jordan on a client's Settings tab: "record a complaint, I think
// they should automatically be recorded"): `addManually` turns the form into
// a quiet secondary "Add one manually" link under the list, for the rare one
// that came some other way. Without it (the client file) nothing changes.
export function ClientIssuesCard({ clientId, issues, canEdit, projects, addManually = false, sendUp = false }: { clientId: string; issues: ClientIssueView[]; canEdit: boolean; projects: { id: string; title: string }[]; addManually?: boolean; sendUp?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [title, setTitle] = useState("");
  const [what, setWhat] = useState("");
  const [source, setSource] = useState("call");
  const [picked, setPicked] = useState<string[]>([]);
  const open = issues.filter((i) => i.state === "OPEN" || i.state === "CORRECTED" || i.state === "UNRESOLVED").length;
  if (!canEdit && issues.length === 0) return null;
  return (
    <Section icon={MessageSquareWarning} title="Complaints" count={open ? `${open} open` : null} tone={open ? "warning" : "default"}>
      {issues.length === 0 ? <p className="text-sm text-muted">None on record.</p> : (
        <ul className="space-y-2 text-sm">{issues.map((i) => <OneIssue key={i.id} issue={i} canEdit={canEdit} projects={projects} sendUp={sendUp} />)}</ul>
      )}
      {canEdit && (
        <details className={cn("mt-3 text-sm", !addManually && "rounded-lg border border-border px-3 py-2")}>
          <summary className={cn("cursor-pointer", addManually ? "text-xs text-muted hover:text-foreground" : "font-medium")}>{addManually ? "Add one manually" : "Record a complaint"}</summary>
          <div className="mt-2 space-y-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={pending} placeholder="Short title" className="block w-full rounded-md border border-border bg-surface px-2 py-1.5" />
            <textarea value={what} onChange={(e) => setWhat(e.target.value)} rows={3} disabled={pending} placeholder="What happened, in the client's words where you have them" className="block w-full rounded-md border border-border bg-surface px-2 py-1.5" />
            <div className="flex flex-wrap items-center gap-2">
              <select value={source} onChange={(e) => setSource(e.target.value)} disabled={pending} className="rounded-md border border-border bg-surface px-2 py-1.5">
                {[["call", "On a call"], ["text", "By text"], ["email", "By email"], ["portal", "In the portal"], ["staff", "Noticed by us"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {projects.length > 0 && (
                <select multiple value={picked} onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))} disabled={pending} className="min-h-11 max-w-xs rounded-md border border-border bg-surface px-2 py-1 text-xs" aria-label="Jobs it is about">
                  {projects.slice(0, 40).map((p) => <option key={p.id} value={p.id}>{p.title.split(",")[0]}</option>)}
                </select>
              )}
            </div>
            <button
              type="button"
              disabled={pending || title.trim().length < 3 || what.trim().length < 3}
              onClick={() => start(async () => {
                setMsg(null);
                const r = await createClientIssueAction({ clientId, title, whatHappened: what, source, projectIds: picked }).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
                setMsg({ ok: r.ok, text: r.message });
                if (r.ok) { setTitle(""); setWhat(""); setPicked([]); router.refresh(); }
              })}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 font-medium text-white disabled:opacity-50"
            >
              {pending && <Loader2 className="size-4 animate-spin" />} Record it
            </button>
          </div>
        </details>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </Section>
  );
}
