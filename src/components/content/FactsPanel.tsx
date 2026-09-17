"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Lock, NotebookPen, Undo2, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { addFact, factDecision, setFactScopeAction } from "@/app/content/actions";
import type { FactCategory, FactScope } from "@/lib/clientFacts";

// ---------------------------------------------------------------------------
// Client facts (spec §23): "Updated from your latest call" — accept / reject
// / undo each, set its scope (permanent · this month · this project), see
// conflicts as exceptions. Confidential facts are locked out of AI context
// for good. Only ACCEPTED facts reach a prompt or the editor's brief.
// ---------------------------------------------------------------------------

export type FactUi = { id: string; category: string; body: string; source: string; sourceRef: string | null; speaker: string | null; factDate: string | null; scope: string; monthKey: string | null; projectId: string | null; status: string; aiContext: string; confidential: boolean; conflictsWithBody: string | null; autoAccepted: boolean; reviewedBy: string | null; undoneBy: string | null; excerpt: string | null };
const CATEGORIES: FactCategory[] = ["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE", "DECISION", "COMMITMENT", "PERFORMANCE_REPORTED", "FEEDBACK", "PROPOSED_CHANGE", "INTERNAL"];
const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");
const catWords = (c: string) => c === "PERFORMANCE_REPORTED" ? "reported result (not verified)" : c.toLowerCase().replace("_", " ");

export function FactsPanel({ clientId, facts, counts, months, projects }: { clientId: string; facts: FactUi[]; counts: { proposed: number; accepted: number; rejected: number; conflicts: number; confidential: number }; months: { id: string; key: string }[]; projects: { id: string; title: string }[] }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fail(fn); setNote(r.message); });
  const proposed = facts.filter((f) => f.status === "PROPOSED");
  const accepted = facts.filter((f) => f.status === "ACCEPTED");
  const rejected = facts.filter((f) => f.status === "REJECTED");
  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
      <Section icon={NotebookPen} title="Updated from their latest calls — needs your review" count={counts.proposed} tone={counts.proposed ? "warning" : "default"} flush
        action={<span className="text-[11px] text-muted-2">{counts.conflicts ? `${counts.conflicts} conflict${counts.conflicts === 1 ? "" : "s"} · ` : ""}{counts.confidential} confidential (locked) · nothing reaches AI until accepted</span>}>
        <div className="divide-y divide-border">
          {proposed.length === 0 && <p className="px-5 py-3 text-sm text-muted">Nothing waiting.</p>}
          {proposed.map((f) => <FactRow key={f.id} f={f} busy={busy} run={run} months={months} projects={projects} />)}
        </div>
      </Section>
      <AddFact clientId={clientId} busy={busy} run={run} />
      <Section icon={Check} title="Accepted — in use by generation and the editor brief" count={accepted.length} flush>
        <div className="divide-y divide-border">{accepted.map((f) => <FactRow key={f.id} f={f} busy={busy} run={run} months={months} projects={projects} />)}{accepted.length === 0 && <p className="px-5 py-3 text-sm text-muted">None accepted yet — until you accept facts, prompts run on the approved strategy alone (the honest state).</p>}</div>
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

function FactRow({ f, busy, run, months, projects }: { f: FactUi; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void; months: { id: string; key: string }[]; projects: { id: string; title: string }[] }) {
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
            <button disabled={busy} onClick={() => run(() => factDecision(f.id, "ACCEPT", { scope, monthId: scope === "MONTH" ? ref || null : null, projectId: scope === "PROJECT" ? ref || null : null, category: cat }))} className={`${btn} bg-success/15 text-success`}><Check className="mr-1 inline size-3" />Accept</button>
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
