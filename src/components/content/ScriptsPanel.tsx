"use client";

import { useState, useTransition } from "react";
import { Check, FileText, History, Loader2, Send, Sparkles, Undo2 } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { approveScriptVersionAction, releaseScriptAction, returnScriptAction, reviseScriptAI, saveScriptText } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Scripts tab (spec §22/§27): ONE review queue for both planning paths, the
// version trail per script (regenerate/revise/edit never erase — they add a
// version), explicit attributable approve, release as a separate act, and
// the validator's findings + the generator's gaps shown, never filled.
// ---------------------------------------------------------------------------

export type VersionUi = { id: string; versionNo: number; status: string; source: string; body: string; createdBy: string | null; createdAt: string; changeSummary: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; estimatedSeconds: number | null; spokenWordCount: number | null; pointCount: number; findings: { severity: string; message: string }[]; gaps: { kind: string; text: string; question: string | null }[]; strategyVersionNo: number | null; policyVersionNo: number | null; answerCount: number; path: string; basedOnVersionNo: number | null; regeneratedSections: string[] };
export type ScriptUi = { id: string; title: string; status: string; historical: boolean; releaseState: string | null; monthKey: string | null; pillarName: string | null; currentVersionId: string | null; approvedVersionId: string | null; sharedVersionId: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; versions: VersionUi[]; sourceFile: string | null };

const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "");

export function ScriptsPanel({ scripts, queueCount, scriptOwner }: { scripts: ScriptUi[]; queueCount: number; scriptOwner: string }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setNote(r.message); });
  const queue = scripts.filter((s) => !s.historical && s.versions[0] && (s.versions[0].status === "DRAFT" || s.versions[0].status === "INTERNAL_REVIEW"));
  const rest = scripts.filter((s) => !queue.includes(s) && !s.historical);
  const historical = scripts.filter((s) => s.historical);
  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
      <Section icon={FileText} title="Review queue" count={queueCount} flush action={<span className="text-[11px] text-muted-2">approval owner: {scriptOwner} · call-derived and written-answer drafts land here alike</span>}>
        <div className="divide-y divide-border">
          {queue.map((s) => <ScriptItem key={s.id} s={s} busy={busy} run={run} open />)}
          {queue.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nothing waiting on you.</p>}
        </div>
      </Section>
      <Section icon={Check} title="Approved and released" count={rest.length} flush>
        <div className="divide-y divide-border">
          {rest.map((s) => <ScriptItem key={s.id} s={s} busy={busy} run={run} />)}
          {rest.length === 0 && <p className="px-5 py-3 text-sm text-muted">No approved scripts on this month yet.</p>}
        </div>
      </Section>
      {historical.length > 0 && (
        <Section icon={History} title="Historical (imported)" count={historical.length} flush action={<span className="text-[11px] text-muted-2">history — never approved, filmed or released by an import</span>}>
          <div className="divide-y divide-border">{historical.map((s) => <ScriptItem key={s.id} s={s} busy={busy} run={run} />)}</div>
        </Section>
      )}
    </div>
  );
}

function ScriptItem({ s, busy, run, open }: { s: ScriptUi; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void; open?: boolean }) {
  const [showVersions, setShowVersions] = useState(false);
  const [mode, setMode] = useState<"read" | "revise" | "edit">("read");
  const cur = s.versions[0] ?? null;
  const [body, setBody] = useState(cur?.body ?? "");
  const [instr, setInstr] = useState("");
  // WHAT IS TRUE NOW, not what a pointer still remembers (audit, Sep 17). A
  // script pulled back to the queue keeps its ledger history, so the chip and
  // the buttons ask the approved VERSION whether it is still live. Reading
  // sharedVersionId first used to put "released to the portal" on withheld work
  // and left a returned-then-shared script with no button at all.
  const approvedLive = !!s.approvedVersionId && s.versions.some((v) => v.id === s.approvedVersionId && (v.status === "APPROVED" || v.status === "SHARED"));
  const releasedLive = approvedLive && !!s.sharedVersionId && s.releaseState !== "withheld";
  const state = s.historical ? "historical" : releasedLive ? "released to the portal" : approvedLive ? (cur && cur.id !== s.approvedVersionId ? "new draft since approval" : "approved · not released") : "needs your OK";
  const tone = s.historical ? "bg-surface-2 text-muted" : state.startsWith("needs") || state.startsWith("new draft") ? "bg-brand-soft text-brand" : "bg-success-soft text-success";
  return (
    <details className="group px-5 py-3" open={open}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 marker:content-none">
        <FileText className="size-3.5 shrink-0 text-muted-2" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{s.title}</span>
        {s.pillarName && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{s.pillarName}</span>}
        {cur && <span className="text-[11px] text-muted-2">v{cur.versionNo} · {cur.path}{cur.estimatedSeconds != null ? ` · ≈${cur.estimatedSeconds}s / ${cur.spokenWordCount}w` : ""}{cur.pointCount !== 3 && !s.historical ? ` · ${cur.pointCount} points` : ""}</span>}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{state}</span>
      </summary>
      <div className="mt-2">
        {cur && (
          <p className="text-[11px] text-muted-2">
            {cur.changeSummary ?? cur.source.toLowerCase()} · {fmt(cur.createdAt)}{cur.createdBy ? ` by ${cur.createdBy}` : ""}
            {cur.strategyVersionNo != null ? ` · strategy v${cur.strategyVersionNo}` : " · no strategy version recorded"}{cur.policyVersionNo != null ? ` · policy v${cur.policyVersionNo}` : ""}{cur.answerCount ? ` · ${cur.answerCount} source answer${cur.answerCount === 1 ? "" : "s"}` : ""}
            {s.approvedAt ? ` · approved ${fmt(s.approvedAt)} by ${s.approvedBy}` : ""}{s.sharedAt ? ` · released ${fmt(s.sharedAt)}` : ""}{s.sourceFile ? ` · from ${s.sourceFile}` : ""}
          </p>
        )}
        {cur && !s.historical && (cur.findings.length > 0 || cur.gaps.length > 0) && (
          <div className="mt-1.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[11px]">
            {cur.findings.filter((f) => f.severity !== "info").map((f, i) => <p key={`f${i}`} className={f.severity === "block" ? "text-danger" : "text-warning"}>{f.severity === "block" ? "Format: " : "Note: "}{f.message}</p>)}
            {cur.gaps.map((g, i) => <p key={`g${i}`} className="text-muted">Gap ({g.kind}): {g.text}{g.question ? ` → ${g.question}` : ""}</p>)}
          </div>
        )}
        {mode === "edit" ? (
          <div className="mt-2">
            <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} minRows={8} className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs leading-relaxed" />
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={busy} onClick={() => { run(() => saveScriptText(s.id, body)); setMode("read"); }} className={`${btn} bg-brand text-white`}>Save as a new version</button>
              <button onClick={() => { setBody(cur?.body ?? ""); setMode("read"); }} className={quiet}>Cancel</button>
            </div>
          </div>
        ) : cur ? <ScriptBody body={cur.body} size="sm" /> : null}
        {mode === "revise" && (
          <div className="mt-2">
            <AutoTextarea value={instr} onChange={(e) => setInstr(e.target.value)} minRows={2} placeholder="Tell the AI what to change — the current version is kept as is" className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs" />
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={busy || !instr.trim()} onClick={() => { run(() => reviseScriptAI(s.id, instr)); setInstr(""); setMode("read"); }} className={`${btn} inline-flex items-center gap-1 bg-brand text-white`}><Sparkles className="size-3" /> Regenerate as new version</button>
              <button onClick={() => setMode("read")} className={quiet}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "read" && !s.historical && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {cur && (!approvedLive || cur.id !== s.approvedVersionId) && <button disabled={busy} onClick={() => run(async () => {
              const r = await approveScriptVersionAction(cur.id);
              if (!r.ok && /^Format check:/.test(r.message)) {
                // An overridable finding — a missing pillar link and the like:
                // the approver may pass it with a written reason, recorded on
                // the ledger. A "House script format:" failure never reaches
                // here (audit finding 6, Sep 17): the shape of a script is not
                // something a reason can argue with, so it is shown as a plain
                // error rather than an offer the server would refuse.
                const why = window.prompt(`${r.message}\n\nApprove anyway? Say why (this is recorded):`) ?? "";
                if (why.trim()) return approveScriptVersionAction(cur.id, why.trim());
              }
              return r;
            })} className={`${btn} bg-success/15 text-success hover:bg-success/25`}><Check className="mr-1 inline size-3" />Approve v{cur.versionNo}</button>}
            {approvedLive && s.sharedVersionId !== s.approvedVersionId && <button disabled={busy} onClick={() => run(() => releaseScriptAction(s.id))} className={`${btn} bg-brand text-white`}><Send className="mr-1 inline size-3" />Release to the portal</button>}
            <button onClick={() => setMode("revise")} className={quiet}><Sparkles className="mr-1 inline size-3" />Ask AI to revise</button>
            <button onClick={() => setMode("edit")} className={quiet}>Edit myself</button>
            {(s.approvedVersionId || s.sharedVersionId) && <button disabled={busy} onClick={() => run(() => returnScriptAction(s.id, ""))} className={quiet}><Undo2 className="mr-1 inline size-3" />Back to the queue</button>}
          </div>
        )}
        {s.versions.length > 1 && (
          <div className="mt-2">
            <button onClick={() => setShowVersions(!showVersions)} className="text-[11px] text-muted hover:underline"><History className="mr-0.5 inline size-3" />{s.versions.length} versions</button>
            {showVersions && (
              <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
                {s.versions.map((v) => (
                  <li key={v.id}>
                    v{v.versionNo} · {v.status.toLowerCase()} · {v.source.toLowerCase()}{v.basedOnVersionNo ? ` (from v${v.basedOnVersionNo}${v.regeneratedSections.length ? `; changed ${v.regeneratedSections.join(", ")}` : ""})` : ""} · {fmt(v.createdAt)}{v.createdBy ? ` by ${v.createdBy}` : ""}{v.approvedAt ? ` · approved by ${v.approvedBy}` : ""}{v.sharedAt ? " · shared" : ""}{v.id === s.sharedVersionId ? " ← what the client sees" : ""}
                    {v.changeSummary ? ` — ${v.changeSummary}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
