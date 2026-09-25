"use client";

import { useState, useTransition } from "react";
import { ArrowRight, Check, Loader2, Lock, NotebookPen, Undo2, Wand2, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { addFact, applyFieldProposalAction, factConfidential, factDecision, ignoreFieldProposalAction, setFactScopeAction } from "@/app/content/actions";
import type { FactCategory, FactScope } from "@/lib/clientFacts";

// ---------------------------------------------------------------------------
// Client facts (spec §23): "Updated from your latest call" — accept / reject
// / undo each, set its scope (permanent · this month · this project), see
// conflicts as exceptions. Confidential facts are locked out of AI context
// for good. Only ACCEPTED facts reach a prompt or the editor's brief.
//
// CP-11 (Sep 24 2026): TWO ACTS, side by side and never merged.
//   · Remember — accept the fact. Prompts read it; a production preference is
//     on the editor's brief. The client's profile is NOT changed.
//   · Apply change — when the call changed a standing preference, the proposal
//     under the fact names the field, what it says now, what it would become,
//     and the call it came from. Applying writes a new version (history kept)
//     and tells the editor; Ignore leaves the profile exactly as it is.
//
// A09 (Sep 25 2026): "Said in confidence" on any fact the extractor did not
// mark. It becomes confidential for good: out of every prompt, and the call
// line it came from stops reaching scripts and the client's suggested answers.
// ---------------------------------------------------------------------------

/** A proposed profile change from a call (ContentStrategyProposal kind PROFILE). */
export type FieldProposalUi = {
  id: string; factId: string | null; target: string; label: string;
  /** The value it was proposed against, what it would become, and what the profile says NOW. */
  from: string | null; to: string; current: string | null; drifted: boolean;
  callDateISO: string | null; excerpt: string | null;
};
export type FactUi = { id: string; category: string; body: string; source: string; sourceRef: string | null; speaker: string | null; factDate: string | null; scope: string; monthKey: string | null; projectId: string | null; status: string; aiContext: string; confidential: boolean; conflictsWithBody: string | null; autoAccepted: boolean; reviewedBy: string | null; undoneBy: string | null; excerpt: string | null };
const CATEGORIES: FactCategory[] = ["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE", "DECISION", "COMMITMENT", "PERFORMANCE_REPORTED", "FEEDBACK", "PROPOSED_CHANGE", "INTERNAL"];
const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");
const catWords = (c: string) => c === "PERFORMANCE_REPORTED" ? "reported result (not verified)" : c.toLowerCase().replace("_", " ");

export function FactsPanel({ clientId, facts, counts, months, projects, fieldProposals = [] }: { clientId: string; facts: FactUi[]; counts: { proposed: number; accepted: number; rejected: number; conflicts: number; confidential: number }; months: { id: string; key: string }[]; projects: { id: string; title: string }[]; fieldProposals?: FieldProposalUi[] }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fail(fn); setNote(r.message); });
  const proposed = facts.filter((f) => f.status === "PROPOSED");
  const accepted = facts.filter((f) => f.status === "ACCEPTED");
  const rejected = facts.filter((f) => f.status === "REJECTED");
  const shown = new Set(facts.map((f) => f.id));
  const orphans = fieldProposals.filter((p) => !p.factId || !shown.has(p.factId));
  const proposalsFor = (factId: string) => fieldProposals.filter((p) => p.factId === factId);
  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
      <Section icon={NotebookPen} title="Updated from their latest calls — needs your review" count={counts.proposed} tone={counts.proposed ? "warning" : "default"} flush
        action={<span className="text-[11px] text-muted-2">{counts.conflicts ? `${counts.conflicts} conflict${counts.conflicts === 1 ? "" : "s"} · ` : ""}{counts.confidential} confidential (locked) · nothing reaches AI until accepted</span>}>
        <div className="divide-y divide-border">
          {proposed.length === 0 && <p className="px-5 py-3 text-sm text-muted">Nothing waiting.</p>}
          {proposed.map((f) => <FactRow key={f.id} f={f} busy={busy} run={run} months={months} projects={projects} proposals={proposalsFor(f.id)} />)}
        </div>
      </Section>
      {orphans.length > 0 && (
        <Section icon={Wand2} title="Proposed profile changes" count={orphans.length} tone="warning" flush action={<span className="text-[11px] text-muted-2">applying is a separate act from remembering</span>}>
          <div className="divide-y divide-border">{orphans.map((p) => <div key={p.id} className="px-5 py-2.5"><ProposalBox p={p} busy={busy} run={run} /></div>)}</div>
        </Section>
      )}
      <AddFact clientId={clientId} busy={busy} run={run} />
      <Section icon={Check} title="Remembered — generation reads these; production preferences also reach the editor brief" count={accepted.length} flush>
        <div className="divide-y divide-border">{accepted.map((f) => <FactRow key={f.id} f={f} busy={busy} run={run} months={months} projects={projects} proposals={proposalsFor(f.id)} />)}{accepted.length === 0 && <p className="px-5 py-3 text-sm text-muted">None accepted yet — until you accept facts, prompts run on the approved strategy alone (the honest state).</p>}</div>
      </Section>
      {rejected.length > 0 && (
        <Section icon={X} title="Rejected" count={rejected.length} flush>
          <div className="divide-y divide-border">{rejected.map((f) => <FactRow key={f.id} f={f} busy={busy} run={run} months={months} projects={projects} />)}</div>
        </Section>
      )}
    </div>
  );
}

async function fail(fn: () => Promise<{ ok: boolean; message: string }>) { try { return await fn(); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Something went wrong." }; } }

function FactRow({ f, busy, run, months, projects, proposals = [] }: { f: FactUi; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void; months: { id: string; key: string }[]; projects: { id: string; title: string }[]; proposals?: FieldProposalUi[] }) {
  const [scope, setScope] = useState<FactScope>(f.scope as FactScope);
  const [ref, setRef] = useState<string>(f.scope === "MONTH" ? (months.find((m) => m.key === f.monthKey)?.id ?? "") : f.scope === "PROJECT" ? (f.projectId ?? "") : "");
  const [cat, setCat] = useState<FactCategory>(f.category as FactCategory);
  return (
    <div className="px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-2">
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{catWords(f.category)}</span>
        <span>{f.source.replace("_", " ")}{f.speaker ? ` · said by ${f.speaker}` : ""}{f.factDate ? ` · ${fmt(f.factDate)}` : ""}</span>
        <span>{f.scope === "MONTH" ? `this month (${f.monthKey ?? "?"})` : f.scope === "PROJECT" ? "this project" : "permanent"}</span>
        {f.confidential && <span className="inline-flex items-center gap-0.5 text-warning"><Lock className="size-3" />confidential — never AI context</span>}
        {f.status === "ACCEPTED" && f.aiContext === "ALLOWED" && <span className="text-success">AI context on</span>}
        {f.autoAccepted && <span>auto-accepted (undoable)</span>}
        {f.reviewedBy && <span>reviewed by {f.reviewedBy}</span>}
        {f.undoneBy && <span>undone by {f.undoneBy}</span>}
      </div>
      <p className="mt-0.5 text-sm">{f.body}</p>
      {f.excerpt && <p className="text-[11px] text-muted-2">“{f.excerpt.slice(0, 220)}{f.excerpt.length > 220 ? "…" : ""}”</p>}
      {f.conflictsWithBody && <p className="mt-0.5 rounded bg-warning-soft/60 px-2 py-1 text-[11px] text-warning">Conflicts with an accepted fact: “{f.conflictsWithBody}”. Accepting this one supersedes it — your call.</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {f.status === "PROPOSED" && (
          <>
            <select value={cat} onChange={(e) => setCat(e.target.value as FactCategory)} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]">{CATEGORIES.map((c) => <option key={c} value={c}>{catWords(c)}</option>)}</select>
            <select value={scope} onChange={(e) => setScope(e.target.value as FactScope)} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]"><option value="PERMANENT">permanent</option><option value="MONTH">this month</option><option value="PROJECT">this project</option></select>
            {scope === "MONTH" && <select value={ref} onChange={(e) => setRef(e.target.value)} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]"><option value="">— month —</option>{months.map((m) => <option key={m.id} value={m.id}>{m.key}</option>)}</select>}
            {scope === "PROJECT" && <select value={ref} onChange={(e) => setRef(e.target.value)} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]"><option value="">— session —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>}
            <button disabled={busy} title="Accept the fact: prompts use it. It does not change their profile." onClick={() => run(() => factDecision(f.id, "ACCEPT", { scope, monthId: scope === "MONTH" ? ref || null : null, projectId: scope === "PROJECT" ? ref || null : null, category: cat }))} className={`${btn} bg-success/15 text-success`}><Check className="mr-1 inline size-3" />Remember</button>
            <button disabled={busy} onClick={() => run(() => factDecision(f.id, "REJECT"))} className={quiet}>Reject</button>
          </>
        )}
        {f.status === "ACCEPTED" && (
          <>
            <select value={scope} onChange={(e) => { const s = e.target.value as FactScope; setScope(s); if (s === "PERMANENT") run(() => setFactScopeAction(f.id, s)); }} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]"><option value="PERMANENT">permanent</option><option value="MONTH">this month</option><option value="PROJECT">this project</option></select>
            {scope === "MONTH" && <select value={ref} onChange={(e) => { setRef(e.target.value); if (e.target.value) run(() => setFactScopeAction(f.id, "MONTH", e.target.value, null)); }} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]"><option value="">— month —</option>{months.map((m) => <option key={m.id} value={m.id}>{m.key}</option>)}</select>}
            {scope === "PROJECT" && <select value={ref} onChange={(e) => { setRef(e.target.value); if (e.target.value) run(() => setFactScopeAction(f.id, "PROJECT", null, e.target.value)); }} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]"><option value="">— session —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>}
          </>
        )}
        {(f.status === "ACCEPTED" || f.status === "REJECTED") && <button disabled={busy} onClick={() => run(() => factDecision(f.id, "UNDO"))} className={quiet}><Undo2 className="mr-1 inline size-3" />Undo</button>}
        {!f.confidential && (
          <button disabled={busy} title="They said this in confidence: keep it out of every prompt, script and suggested answer from now on. It can't be undone from here." onClick={() => { if (window.confirm("Mark this as said in confidence? It leaves every prompt and the client's suggested answers for good.")) run(() => factConfidential(f.id)); }} className={quiet}>
            <Lock className="mr-1 inline size-3" />Said in confidence
          </button>
        )}
      </div>
      {proposals.map((p) => <div key={p.id} className="mt-2"><ProposalBox p={p} busy={busy} run={run} /></div>)}
    </div>
  );
}

/** "Proposed change · Music: “Upbeat pop” → “Calm acoustic” · from the Sep 24 call" — Apply or Ignore, with notes. */
function ProposalBox({ p, busy, run }: { p: FieldProposalUi; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [value, setValue] = useState(p.to);
  const [note, setNote] = useState("");
  return (
    <div className="rounded-lg border border-brand/30 bg-brand-soft/30 px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <Wand2 className="size-3.5 text-brand" />
        <span className="font-semibold">Proposed change · {p.label}:</span>
        <span className="text-muted">{p.from ? `“${p.from}”` : "not set"}</span>
        <ArrowRight className="size-3 text-muted-2" />
        <span className="font-medium">“{p.to}”</span>
        {p.callDateISO && <span className="text-muted-2">· from the {fmt(p.callDateISO)} call</span>}
      </div>
      {p.excerpt && <p className="mt-0.5 text-[11px] text-muted-2">“{p.excerpt.slice(0, 200)}{p.excerpt.length > 200 ? "…" : ""}”</p>}
      {p.drifted && <p className="mt-1 rounded bg-warning-soft/60 px-2 py-1 text-[11px] text-warning">Changed since this was proposed — it now says {p.current ? `“${p.current}”` : "nothing"}. Applying will be refused; ignore this one or set it by hand on the Brand tab.</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input value={value} onChange={(e) => setValue(e.target.value)} aria-label={`New ${p.label}`} className="w-48 rounded border border-border bg-surface px-2 py-1 text-[12px]" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your notes (optional)" className="w-56 rounded border border-border bg-surface px-2 py-1 text-[12px]" />
        <button disabled={busy || !value.trim()} onClick={() => run(() => applyFieldProposalAction(p.id, value, note || null))} className={`${btn} bg-brand text-white`}>Apply change</button>
        <button disabled={busy} onClick={() => run(() => ignoreFieldProposalAction(p.id, note || null))} className={quiet}>Ignore</button>
      </div>
    </div>
  );
}

function AddFact({ clientId, busy, run }: { clientId: string; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [body, setBody] = useState(""); const [cat, setCat] = useState<FactCategory>("PRODUCTION_PREFERENCE"); const [conf, setConf] = useState(false);
  return (
    <div className="rounded-2xl border border-border bg-surface px-5 py-3">
      <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} minRows={1} placeholder="Add a fact you know (accepted under your name; still undoable)" className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs" />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <select value={cat} onChange={(e) => setCat(e.target.value as FactCategory)} className="rounded border border-border bg-surface-2 px-1.5 py-1 text-[11px]">{CATEGORIES.map((c) => <option key={c} value={c}>{catWords(c)}</option>)}</select>
        <label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={conf} onChange={(e) => setConf(e.target.checked)} className="accent-[var(--brand)]" />confidential (never AI context)</label>
        <button disabled={busy || !body.trim()} onClick={() => { run(() => addFact(clientId, body, cat, conf)); setBody(""); }} className={`${btn} bg-brand text-white`}>Add</button>
      </div>
    </div>
  );
}
