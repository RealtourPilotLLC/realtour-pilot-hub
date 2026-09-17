"use client";

import { useState, useTransition } from "react";
import { Check, History, Lightbulb, Loader2, MessageSquare, Plus, RefreshCw, Sparkles, Star, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { TOPIC_STATUS_WORDS } from "@/lib/contentStatus";
import {
  addTopic, discussTopicAction, editTopic, generateScriptForTopicAction, reconcileTopicSelection, runTopicRefresh, setTopicStatus, setTopicsPerPillarAction,
  startInterview, suggestionAction, topicDecision,
} from "@/app/content/actions";
import { InterviewPanel, type InterviewUi } from "./InterviewPanel";

// ---------------------------------------------------------------------------
// Video Topics (spec §5/§18/§27) — the bank by pillar (Arielle's
// presentation), the month's selections with capacity explained (overflow
// kept), call-proposed selections a person confirms, refresh suggestions
// with per-suggestion accept / edit / archive / regenerate, and the
// "Recommended for next session" shortlist with its reasons. Every change
// lands on the topic's history.
// ---------------------------------------------------------------------------

export type TopicUi = { id: string; title: string; concept: string | null; pillarId: string | null; pillarLabel: string | null; status: string; approvalState: string | null; source: string; audienceNeed: string | null; businessGoal: string | null; intendedMessage: string | null; monthId: string | null; importedMark: string | null; proposedState: string | null; lastEventAt: string | null; scriptId: string | null };
export type GroupUi = { pillarId: string | null; pillarName: string; topics: TopicUi[] };
export type ProposedUi = { topic: TopicUi; evidence: { speaker: string; text: string }[]; clientSpoken: boolean; overflow: boolean };
export type SuggestionUi = { id: string; kind: string; rank: number | null; title: string; description: string | null; pillarName: string | null; audienceNeed: string | null; businessGoal: string | null; intendedMessage: string | null; rationale: string | null; whyNow: string | null; linkedGoal: string | null; priorContentRelation: string | null; relatedTopicId: string | null; runSummary: string | null };
export type RunUi = { id: string; kind: string; status: string; createdAt: string; changeSummary: string | null; missing: string[]; requestedBy: string | null };
export type EventUi = { kind: string; actorKind: string; note: string | null; createdAt: string; monthKey: string | null };

const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export function TopicsPanel({ enrollmentId, month, capacity, groups, proposed, monthTopics, suggestions, recommended, runs, interviews, histories, pillars, topicsPerPillar, isOwner, archivedCount }: {
  enrollmentId: string; month: { id: string; label: string; short: string } | null; capacity: { owed: number; selected: number; overflow: number } | null;
  groups: GroupUi[]; proposed: ProposedUi[]; monthTopics: TopicUi[]; suggestions: SuggestionUi[]; recommended: SuggestionUi[]; runs: RunUi[];
  interviews: Record<string, InterviewUi>; histories: Record<string, EventUi[]>; pillars: { id: string; name: string }[]; topicsPerPillar: number; isOwner: boolean; archivedCount: number;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setNote(r.message); });
  const [n, setN] = useState(topicsPerPillar);

  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}

      {/* Call-proposed selections — a person confirms */}
      {month && proposed.length > 0 && (
        <Section icon={MessageSquare} title={`Proposed for ${month.short} from the call`} count={proposed.length} tone="warning" flush>
          <p className="border-b border-border px-5 py-2 text-[12px] text-muted">Discussed on a call is not selected. Confirm the ones the client really chose; the rest go back to the bank with the mention kept on their history.</p>
          <div className="divide-y divide-border">
            {proposed.map((p) => (
              <div key={p.topic.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2"><span className="text-[15px] font-medium">{p.topic.title}</span>{!p.clientSpoken && <span className="text-[11px] text-warning">no client-spoken excerpt</span>}{p.overflow && <span className="text-[11px] text-warning">beyond capacity</span>}</div>
                {p.topic.concept && <p className="text-[12px] text-muted">{p.topic.concept}</p>}
                {p.evidence.slice(0, 2).map((e, i) => <p key={i} className="mt-0.5 text-[11px] text-muted-2">[{e.speaker}] “{e.text.slice(0, 200)}{e.text.length > 200 ? "…" : ""}”</p>)}
                <div className="mt-1.5 flex gap-1.5">
                  <button disabled={busy} onClick={() => run(() => reconcileTopicSelection(p.topic.id, month.id, true))} className={`${btn} bg-success/15 text-success`}><Check className="mr-1 inline size-3" />Confirm for {month.short}</button>
                  <button disabled={busy} onClick={() => run(() => reconcileTopicSelection(p.topic.id, month.id, false))} className={quiet}>Not this month</button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* The month's plan with capacity */}
      {month && capacity && (
        <Section icon={Lightbulb} title={`${month.short}'s video plan`} count={`${capacity.selected + capacity.overflow}/${capacity.owed}`} flush
          action={capacity.overflow > 0 ? <span className="text-[12px] text-warning">{capacity.overflow} over capacity — kept, not deleted</span> : capacity.selected >= capacity.owed && capacity.owed > 0 ? <span className="text-[12px] text-success">at capacity</span> : undefined}>
          <div className="divide-y divide-border">
            {monthTopics.map((t) => (
              <TopicRow key={t.id} t={t} busy={busy} month={month} pillars={pillars} history={histories[t.id] ?? []} interview={interviews[t.id] ?? null} inMonth run={run} />
            ))}
            {monthTopics.length === 0 && <p className="px-5 py-3 text-sm text-muted">Nothing planned yet — pick from the bank below, or confirm the call&rsquo;s proposals.</p>}
          </div>
        </Section>
      )}

      {/* Recommended for next session */}
      <Section icon={Star} title="Recommended for the next session" count={recommended.length} flush
        action={<button disabled={busy || !month} onClick={() => run(() => runTopicRefresh(enrollmentId, "RECOMMENDATION", month?.id))} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"><Sparkles className="size-3.5" />Rank the bank</button>}>
        <div className="divide-y divide-border">
          {recommended.length === 0 && <p className="px-5 py-3 text-sm text-muted">No ranking yet. The shortlist reflects the approved strategy&rsquo;s goals, the brand message and VERIFIED filming history only.</p>}
          {recommended.map((s) => (
            <div key={s.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2"><span className="text-[13px] text-muted-2">#{s.rank}</span><span className="text-[15px] font-medium">{s.title}</span>{s.pillarName && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{s.pillarName}</span>}{s.kind === "ALTERNATIVE" && <span className="text-[11px] text-muted-2">alternative</span>}</div>
              <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
                <div><dt className="inline text-muted-2">Goal: </dt><dd className="inline">{s.linkedGoal ?? "no goal matched"}</dd></div>
                <div><dt className="inline text-muted-2">Prior content: </dt><dd className="inline">{s.priorContentRelation === "NO_VERIFIED_HISTORY" ? "No verified filming history" : (s.priorContentRelation ?? "—").toLowerCase().replace("_", " ")}</dd></div>
                <div className="sm:col-span-2"><dt className="inline text-muted-2">Why now: </dt><dd className="inline">{s.whyNow}</dd></div>
              </dl>
              <div className="mt-1.5 flex gap-1.5">
                <button disabled={busy || !month} onClick={() => run(() => suggestionAction(s.id, "ACCEPT", { monthId: month?.id }))} className={`${btn} bg-brand text-white`}>Select for {month?.short ?? "the month"}</button>
                <button disabled={busy} onClick={() => run(() => suggestionAction(s.id, "ARCHIVE"))} className={quiet}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Refresh suggestions */}
      <Section icon={RefreshCw} title="Topic refresh — suggestions to review" count={suggestions.length} flush
        action={
          <span className="flex items-center gap-2">
            {isOwner && <label className="text-[11px] text-muted-2">per pillar <input type="number" min={10} max={15} value={n} onChange={(e) => setN(Number(e.target.value))} onBlur={() => { if (n !== topicsPerPillar) run(() => setTopicsPerPillarAction(n)); }} className="w-12 rounded border border-border bg-surface-2 px-1 text-[11px]" /></label>}
            <button disabled={busy} onClick={() => run(() => runTopicRefresh(enrollmentId, "REFRESH"))} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"><Sparkles className="size-3.5" />Refresh topics</button>
          </span>
        }>
        {runs.length > 0 && (
          <div className="border-b border-border px-5 py-2 text-[11px] text-muted">
            Last run: {fmt(runs[0].createdAt)} · {runs[0].kind.toLowerCase()} · {runs[0].status.toLowerCase().replace("_", " ")}{runs[0].changeSummary ? ` · ${runs[0].changeSummary}` : ""}
            {runs[0].missing.length > 0 && <ul className="mt-1 list-inside list-disc text-warning">{runs[0].missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}
          </div>
        )}
        <div className="divide-y divide-border">
          {suggestions.length === 0 && <p className="px-5 py-3 text-sm text-muted">No suggestions waiting. A refresh adds candidates under the approved pillars — it never touches selected, approved or in-production topics, and archived ideas never come back.</p>}
          {suggestions.map((s) => <SuggestionRow key={s.id} s={s} busy={busy} monthId={month?.id ?? null} run={run} />)}
        </div>
      </Section>

      {/* The bank by pillar */}
      <Section icon={Lightbulb} title="Video Topics — the bank" count={groups.reduce((n2, g) => n2 + g.topics.length, 0)} flush
        action={<span className="text-[11px] text-muted-2">{archivedCount} rejected/archived (kept, never re-suggested)</span>}>
        <AddTopic enrollmentId={enrollmentId} pillars={pillars} busy={busy} run={run} />
        {groups.map((g) => (
          <div key={g.pillarId ?? "none"}>
            <div className="border-y border-border bg-surface-2/50 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.pillarName} · {g.topics.length}</div>
            {g.topics.map((t, i) => <TopicRow key={t.id} t={t} idx={i + 1} busy={busy} month={month} pillars={pillars} history={histories[t.id] ?? []} interview={interviews[t.id] ?? null} run={run} />)}
            {g.topics.length === 0 && <p className="px-5 py-2 text-[12px] text-muted-2">nothing under this pillar yet</p>}
          </div>
        ))}
        {groups.length === 0 && <p className="px-5 py-4 text-sm text-muted">The bank is empty — import a topic bank, refresh from the approved strategy, or add a topic.</p>}
      </Section>
    </div>
  );
}

function TopicRow({ t, idx, busy, month, pillars, history, interview, inMonth, run }: { t: TopicUi; idx?: number; busy: boolean; month: { id: string; short: string } | null; pillars: { id: string; name: string }[]; history: EventUi[]; interview: InterviewUi | null; inMonth?: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [open, setOpen] = useState<"none" | "edit" | "history" | "discuss" | "interview">(interview && inMonth ? "interview" : "none");
  const [form, setForm] = useState({ title: t.title, concept: t.concept ?? "", pillarId: t.pillarId ?? "", audienceNeed: t.audienceNeed ?? "", businessGoal: t.businessGoal ?? "", intendedMessage: t.intendedMessage ?? "" });
  const [disc, setDisc] = useState("");
  const inProduction = ["SCRIPTED", "FILMED", "EDITING", "DELIVERED"].includes(t.status);
  return (
    <div className="px-5 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {idx != null && <span className="text-[12px] text-muted-2">{idx}.</span>}
            <span className="text-[15px] font-medium">{t.title}</span>
            {!["SAVED", "RECOMMENDED", "IDEA"].includes(t.status) && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{TOPIC_STATUS_WORDS[t.status] ?? t.status.toLowerCase()}</span>}
            {t.approvalState === "APPROVED" && <span className="text-[11px] text-success">approved</span>}
            {t.proposedState && <span className="text-[11px] text-warning">{t.source === "strategy_call" ? `declined on the call — ${t.proposedState === "REJECTED" ? "reject it to confirm" : "unconfirmed"}` : `import mark says ${t.proposedState.toLowerCase()} — unconfirmed`}</span>}
            {!t.pillarId && t.pillarLabel && <span className="text-[11px] text-muted-2">label “{t.pillarLabel}” not mapped</span>}
          </div>
          {t.concept && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{t.concept}</p>}
          {(t.audienceNeed || t.businessGoal || t.intendedMessage) && (
            <p className="mt-0.5 text-[11px] text-muted-2">{[t.audienceNeed && `need: ${t.audienceNeed}`, t.businessGoal && `goal: ${t.businessGoal}`, t.intendedMessage && `message: ${t.intendedMessage}`].filter(Boolean).join(" · ")}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {!inMonth && month && !inProduction && t.monthId !== month.id && (
            <button disabled={busy} onClick={() => run(() => setTopicStatus(t.id, "SELECTED", month.id))} className="rounded-lg border border-brand/40 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand-soft disabled:opacity-50">Use for {month.short}</button>
          )}
          {inMonth && month && !inProduction && <button disabled={busy} title="Back to the bank" onClick={() => run(() => setTopicStatus(t.id, "SAVED", null))} className={quiet}><X className="size-3" /></button>}
          {inMonth && month && !t.scriptId && <button disabled={busy} onClick={() => run(() => generateScriptForTopicAction(t.id, month.id))} className={`${btn} bg-brand text-white`}><Sparkles className="mr-1 inline size-3" />Draft script</button>}
          {inMonth && month && !interview && <button disabled={busy} onClick={() => run(() => startInterview(t.id, month.id))} className={quiet}>Written answers</button>}
          {t.approvalState !== "APPROVED" && !inProduction && <button disabled={busy} title="Approve this topic" onClick={() => run(() => topicDecision(t.id, "APPROVE", ""))} className={quiet}><Check className="size-3" /></button>}
          {!inProduction && <button disabled={busy} title="Reject" onClick={() => { const r = window.prompt("Why? (kept internally so it is never re-suggested)") ?? ""; run(() => topicDecision(t.id, "REJECT", r)); }} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"><X className="size-3" /></button>}
        </div>
      </div>
      <div className="mt-1 flex gap-3 text-[11px] text-muted-2">
        <button onClick={() => setOpen(open === "edit" ? "none" : "edit")} className="hover:underline">edit</button>
        <button onClick={() => setOpen(open === "discuss" ? "none" : "discuss")} className="hover:underline">note a discussion</button>
        <button onClick={() => setOpen(open === "history" ? "none" : "history")} className="hover:underline"><History className="mr-0.5 inline size-3" />history ({history.length})</button>
        {interview && <button onClick={() => setOpen(open === "interview" ? "none" : "interview")} className="hover:underline">answers</button>}
      </div>
      {open === "edit" && (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="rounded border border-border bg-surface-2 px-2 py-1 text-sm sm:col-span-2" />
          <select value={form.pillarId} onChange={(e) => setForm({ ...form, pillarId: e.target.value })} className="rounded border border-border bg-surface-2 px-2 py-1 text-xs"><option value="">— pillar —</option>{pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input value={form.concept} onChange={(e) => setForm({ ...form, concept: e.target.value })} placeholder="one-sentence description" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
          <input value={form.audienceNeed} onChange={(e) => setForm({ ...form, audienceNeed: e.target.value })} placeholder="audience need" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
          <input value={form.businessGoal} onChange={(e) => setForm({ ...form, businessGoal: e.target.value })} placeholder="business goal" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
          <input value={form.intendedMessage} onChange={(e) => setForm({ ...form, intendedMessage: e.target.value })} placeholder="intended message" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs sm:col-span-2" />
          <div className="flex gap-1.5 sm:col-span-2"><button disabled={busy} onClick={() => { run(() => editTopic(t.id, { title: form.title, concept: form.concept || null, pillarId: form.pillarId || null, audienceNeed: form.audienceNeed || null, businessGoal: form.businessGoal || null, intendedMessage: form.intendedMessage || null })); setOpen("none"); }} className={`${btn} bg-brand text-white`}>Save</button><button onClick={() => setOpen("none")} className={quiet}>Cancel</button></div>
        </div>
      )}
      {open === "discuss" && (
        <div className="mt-2 flex gap-1.5">
          <input value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="What was said (goes on the history, changes no status)" className="flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
          <button disabled={busy || !disc.trim()} onClick={() => { run(() => discussTopicAction(t.id, disc)); setDisc(""); setOpen("none"); }} className={`${btn} bg-brand text-white`}>Note</button>
        </div>
      )}
      {open === "history" && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
          {history.length === 0 && <li>No history recorded before Sep 17 2026.</li>}
          {history.map((e, i) => <li key={i}>{fmt(e.createdAt)} · {e.kind.toLowerCase()} · {e.actorKind.toLowerCase()}{e.monthKey ? ` · ${e.monthKey}` : ""}{e.note ? ` — ${e.note}` : ""}</li>)}
        </ul>
      )}
      {open === "interview" && interview && <div className="mt-2"><InterviewPanel iv={interview} /></div>}
    </div>
  );
}

function SuggestionRow({ s, busy, monthId, run }: { s: SuggestionUi; busy: boolean; monthId: string | null; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ title: s.title, description: s.description ?? "", audienceNeed: s.audienceNeed ?? "", businessGoal: s.businessGoal ?? "", intendedMessage: s.intendedMessage ?? "" });
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">{s.pillarName && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{s.pillarName}</span>}<span className="text-[15px] font-medium">{s.title}</span></div>
      {s.description && <p className="text-[13px] text-muted">{s.description}</p>}
      <p className="text-[11px] text-muted-2">{[s.audienceNeed && `need: ${s.audienceNeed}`, s.businessGoal && `goal: ${s.businessGoal}`, s.intendedMessage && `message: ${s.intendedMessage}`, s.rationale].filter(Boolean).join(" · ")}</p>
      {edit && (
        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className="rounded border border-border bg-surface-2 px-2 py-1 text-sm sm:col-span-2" />
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="description" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs sm:col-span-2" />
          <input value={f.audienceNeed} onChange={(e) => setF({ ...f, audienceNeed: e.target.value })} placeholder="audience need" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
          <input value={f.businessGoal} onChange={(e) => setF({ ...f, businessGoal: e.target.value })} placeholder="business goal" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
          <input value={f.intendedMessage} onChange={(e) => setF({ ...f, intendedMessage: e.target.value })} placeholder="intended message" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs sm:col-span-2" />
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button disabled={busy} onClick={() => run(() => suggestionAction(s.id, "ACCEPT", { edits: edit ? { title: f.title, description: f.description || null, audienceNeed: f.audienceNeed || null, businessGoal: f.businessGoal || null, intendedMessage: f.intendedMessage || null } : undefined }))} className={`${btn} bg-success/15 text-success`}><Check className="mr-1 inline size-3" />{edit ? "Accept with edits" : "Accept"}</button>
        {monthId && !edit && <button disabled={busy} onClick={() => run(() => suggestionAction(s.id, "ACCEPT", { monthId }))} className={quiet}>Accept + use this month</button>}
        <button onClick={() => setEdit(!edit)} className={quiet}>{edit ? "Cancel edit" : "Edit"}</button>
        <button disabled={busy} onClick={() => run(() => suggestionAction(s.id, "REGENERATE"))} className={quiet}><RefreshCw className="mr-1 inline size-3" />Regenerate</button>
        <button disabled={busy} onClick={() => run(() => suggestionAction(s.id, "ARCHIVE"))} className={quiet}>Archive</button>
      </div>
    </div>
  );
}

function AddTopic({ enrollmentId, pillars, busy, run }: { enrollmentId: string; pillars: { id: string; name: string }[]; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", concept: "", pillarId: "", audienceNeed: "", businessGoal: "", intendedMessage: "" });
  if (!open) return <div className="px-5 py-2.5"><button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"><Plus className="size-3.5" /> Suggest a topic</button></div>;
  return (
    <div className="grid gap-1.5 px-5 py-3 sm:grid-cols-2">
      <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Topic title — specific enough that the hook is obvious" className="rounded border border-border bg-surface-2 px-2 py-1 text-sm sm:col-span-2" />
      <select value={f.pillarId} onChange={(e) => setF({ ...f, pillarId: e.target.value })} className="rounded border border-border bg-surface-2 px-2 py-1 text-xs"><option value="">— pillar —</option>{pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <AutoTextarea value={f.concept} onChange={(e) => setF({ ...f, concept: e.target.value })} minRows={1} placeholder="One sentence: what the video would show" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
      <input value={f.audienceNeed} onChange={(e) => setF({ ...f, audienceNeed: e.target.value })} placeholder="audience need" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
      <input value={f.businessGoal} onChange={(e) => setF({ ...f, businessGoal: e.target.value })} placeholder="business goal" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs" />
      <input value={f.intendedMessage} onChange={(e) => setF({ ...f, intendedMessage: e.target.value })} placeholder="intended message" className="rounded border border-border bg-surface-2 px-2 py-1 text-xs sm:col-span-2" />
      <div className="flex gap-1.5 sm:col-span-2">
        <button disabled={busy || !f.title.trim()} onClick={() => { run(() => addTopic(enrollmentId, { title: f.title, concept: f.concept, pillarId: f.pillarId || null, audienceNeed: f.audienceNeed || null, businessGoal: f.businessGoal || null, intendedMessage: f.intendedMessage || null })); setF({ title: "", concept: "", pillarId: "", audienceNeed: "", businessGoal: "", intendedMessage: "" }); setOpen(false); }} className={`${btn} bg-brand text-white`}>Add to the bank</button>
        <button onClick={() => setOpen(false)} className={quiet}>Cancel</button>
      </div>
    </div>
  );
}
