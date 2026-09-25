"use client";

import { useState, useTransition } from "react";
import { Check, CircleDashed, FileText, History, Loader2, PenLine, Scissors, Send, Sparkles, Undo2 } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { ScriptBody } from "@/components/portal/ScriptBody";
// policy.ts is pure data with no imports of its own ("no node:crypto so this
// file can be imported from client components") — the 20–30 s target is read
// from it rather than copied, so the chip, the findings row and the validator
// can never drift from each other.
//
// NOT "every reader of the target" (review, Sep 18 2026 — the claim was made
// and it is false): contentPolicy/prompts.ts:108 still writes "exactly three
// points, 20–30 s" into the script prompt's prose as a literal. Changing
// GENERATION_POLICY.timing.targetSec today would move this chip, the row below,
// validateNewScript, tightenInstruction and policyRulesText, and leave that one
// sentence behind. It is named here rather than claimed away; prompts.ts was
// outside this change's files.
import { GENERATION_POLICY } from "@/lib/contentPolicy/policy";
import { approveScriptVersionAction, draftOwedScriptsAction, releaseScriptAction, returnScriptAction, reviseScriptAI, saveScriptText, tightenScriptAI } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Scripts tab (spec §22/§27): ONE review queue for both planning paths, the
// version trail per script (regenerate/revise/edit never erase — they add a
// version), explicit attributable approve, release as a separate act, and
// the validator's findings + the generator's gaps shown, never filled.
// ---------------------------------------------------------------------------

export type VersionUi = { id: string; versionNo: number; status: string; source: string; body: string; createdBy: string | null; createdAt: string; changeSummary: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; estimatedSeconds: number | null; spokenWordCount: number | null; pointCount: number; findings: { severity: string; message: string; code?: string }[]; gaps: { kind: string; text: string; question: string | null }[]; strategyVersionNo: number | null; policyVersionNo: number | null; answerCount: number; path: string; basedOnVersionNo: number | null; regeneratedSections: string[] };
/** One topic the month owes a script, with the reason it is or is not ready. Mirrors ScriptWorkItem in src/lib/contentDrafting.ts. */
export type OwedUi = { topicId: string; title: string; monthId: string; readiness: string; why: string; interviewId: string | null; excerpts: number };

export type ScriptUi = { id: string; title: string; status: string; historical: boolean; releaseState: string | null; monthKey: string | null; pillarName: string | null; currentVersionId: string | null; approvedVersionId: string | null; sharedVersionId: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; versions: VersionUi[]; sourceFile: string | null; clientVerdict: "APPROVED" | "CHANGES_REQUESTED" | "STALE" | null; clientVerdictAt: string | null };

const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "");

const [TARGET_LO, TARGET_HI] = GENERATION_POLICY.timing.targetSec;

/**
 * Where a version's spoken estimate sits against the target.
 *
 * WHY THIS IS NOT READ OFF THE FINDINGS. The findings box only renders when the
 * version has a stored validationJson, and on Sep 17 2026 that was true of 9 of
 * 174 versions — while the estimate chip was on all 174 and untinted, so a 47 s
 * script and a 24 s one looked identical in the queue. The seconds are on every
 * row; the band is computed from them.
 */
function band(seconds: number | null): "under" | "on" | "over" | null {
  if (seconds == null) return null;
  return seconds > TARGET_HI ? "over" : seconds < TARGET_LO ? "under" : "on";
}

export function ScriptsPanel({ scripts, queueCount, scriptOwner, owed = [] }: { scripts: ScriptUi[]; queueCount: number; scriptOwner: string; owed?: OwedUi[] }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setNote(r.message); });
  const queue = scripts.filter((s) => !s.historical && s.versions[0] && (s.versions[0].status === "DRAFT" || s.versions[0].status === "INTERNAL_REVIEW"));
  const rest = scripts.filter((s) => !queue.includes(s) && !s.historical);
  const historical = scripts.filter((s) => s.historical);
  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
      <OwedScripts owed={owed} busy={busy} run={run} />
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
  // A HISTORICAL import is never paced against the policy. 129 of the 174
  // versions in production estimate over 30 s and almost all of them are
  // archive scripts with four talking points — what was filmed, not an overrun
  // to fix. The validator makes the same distinction ("It never 'fixes' an old
  // script"); tinting their chips amber would be the same mistake in colour.
  const pace = s.historical ? null : band(cur?.estimatedSeconds ?? null);
  // WHAT IS TRUE NOW, not what a pointer still remembers (audit, Sep 17). A
  // script pulled back to the queue keeps its ledger history, so the chip and
  // the buttons ask the approved VERSION whether it is still live. Reading
  // sharedVersionId first used to put "released to the portal" on withheld work
  // and left a returned-then-shared script with no button at all.
  const approvedLive = !!s.approvedVersionId && s.versions.some((v) => v.id === s.approvedVersionId && (v.status === "APPROVED" || v.status === "SHARED"));
  const releasedLive = approvedLive && !!s.sharedVersionId && s.releaseState !== "withheld";
  const state = s.historical ? "historical" : releasedLive ? "released to the portal" : approvedLive ? (cur && cur.id !== s.approvedVersionId ? "new draft since approval" : "approved · not released") : "needs your OK";
  const tone = s.historical ? "bg-surface-2 text-muted" : state.startsWith("needs") || state.startsWith("new draft") ? "bg-brand-soft text-brand" : "bg-success-soft text-success";
  // THE CLIENT'S OWN VERDICT (F09). Separate from every chip above, because our
  // approval and their willingness to say these words on camera are different
  // facts and the second one decides whether this belongs on a call sheet.
  const verdict =
    s.clientVerdict === "APPROVED" ? { label: "client signed off", cls: "bg-success-soft text-success" }
    : s.clientVerdict === "CHANGES_REQUESTED" ? { label: "client asked for changes", cls: "bg-warning-soft text-warning" }
    : s.clientVerdict === "STALE" ? { label: "rewritten since they approved", cls: "bg-warning-soft text-warning" }
    : releasedLive ? { label: "client hasn't answered yet", cls: "bg-surface-2 text-muted" }
    : null;
  return (
    <details className="group px-5 py-3" open={open}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 marker:content-none">
        <FileText className="size-3.5 shrink-0 text-muted-2" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{s.title}</span>
        {s.pillarName && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{s.pillarName}</span>}
        {cur && (
          <span className="text-[11px] text-muted-2">
            v{cur.versionNo} · {cur.path}
            {cur.estimatedSeconds != null && (
              // Never colour alone: the words "over"/"under" carry the same
              // information for anyone who cannot tell the tints apart.
              <span className={pace === "on" || pace === null ? "" : "font-medium text-warning"} title={`${TARGET_LO}–${TARGET_HI}s target · ${GENERATION_POLICY.timing.wordsPerSec} words per second`}>
                {" "}· ≈{cur.estimatedSeconds}s / {cur.spokenWordCount}w{pace === "over" ? ` · over ${TARGET_LO}–${TARGET_HI}s` : pace === "under" ? ` · under ${TARGET_LO}–${TARGET_HI}s` : ""}
              </span>
            )}
            {cur.pointCount !== 3 && !s.historical ? ` · ${cur.pointCount} points` : ""}
          </span>
        )}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{state}</span>
        {verdict && <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${verdict.cls}`} title={s.clientVerdictAt ? `on ${fmt(s.clientVerdictAt)}` : undefined}>{verdict.label}</span>}
      </summary>
      <div className="mt-2">
        {cur && (
          <p className="text-[11px] text-muted-2">
            {cur.changeSummary ?? cur.source.toLowerCase()} · {fmt(cur.createdAt)}{cur.createdBy ? ` by ${cur.createdBy}` : ""}
            {cur.strategyVersionNo != null ? ` · strategy v${cur.strategyVersionNo}` : " · no strategy version recorded"}{cur.policyVersionNo != null ? ` · policy v${cur.policyVersionNo}` : ""}{cur.answerCount ? ` · ${cur.answerCount} source answer${cur.answerCount === 1 ? "" : "s"}` : ""}
            {s.approvedAt ? ` · approved ${fmt(s.approvedAt)} by ${s.approvedBy}` : ""}{s.sharedAt ? ` · released ${fmt(s.sharedAt)}` : ""}{s.sourceFile ? ` · from ${s.sourceFile}` : ""}
          </p>
        )}
        {cur && !s.historical && (cur.findings.length > 0 || cur.gaps.length > 0 || pace === "over" || pace === "under") && (
          <div className="mt-1.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[11px]">
            {/* The stored timing finding, when there is one, says the same thing
                as the row below and with a possibly older estimate — the row is
                built from the version's current seconds, so the stored one goes.
                BOTH BANDS OR NEITHER (review, Sep 18 2026): this filter drops a
                timing finding by code AND by message prefix, so when the row
                below only rendered for "over", an under-target draft lost its
                finding and showed nothing at all. Measured on production the
                same day: 4 of the 20 live current versions estimate under 20 s,
                all four store no findings, and all four displayed nothing about
                their length. */}
            {cur.findings.filter((f) => f.severity !== "info" && f.code !== "timing.out-of-range" && !/^Spoken estimate /.test(f.message)).map((f, i) => <p key={`f${i}`} className={f.severity === "block" ? "text-danger" : "text-warning"}>{f.severity === "block" ? "Format: " : "Note: "}{f.message}</p>)}
            {pace === "over" && (
              <p className="flex flex-wrap items-center gap-1.5 text-warning">
                <span>Length: ≈{cur.estimatedSeconds}s ({cur.spokenWordCount} words) against the {TARGET_LO}–{TARGET_HI}s target. It can still be approved — this is an estimate from a word count, not a rejection.</span>
                <button disabled={busy} onClick={() => run(() => tightenScriptAI(s.id))} className="inline-flex items-center gap-1 rounded-md border border-warning/40 px-2 py-0.5 font-semibold text-warning hover:bg-warning/10 disabled:opacity-50">
                  <Scissors className="size-3" />Tighten to {TARGET_LO}–{TARGET_HI}s
                </button>
              </p>
            )}
            {/* No Tighten button on a short script: tightenScriptAI refuses a
                version that is already at or under the target, and offering a
                button the server declines is the trap the approve flow already
                learned to avoid. Shortening is the wrong verb anyway — the
                validator's own words for this case are "it may read as thin on
                camera; add substance rather than padding". */}
            {pace === "under" && (
              <p className="text-warning">
                Length: ≈{cur.estimatedSeconds}s ({cur.spokenWordCount} words) is under the {TARGET_LO}–{TARGET_HI}s target. It can still be approved — this is an estimate from a word count, not a rejection — but it may read as thin on camera. Add substance with &ldquo;Ask AI to revise&rdquo; or &ldquo;Edit myself&rdquo; rather than padding; both keep this version.
              </p>
            )}
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

// ---------------------------------------------------------------------------
// WHAT THIS MONTH STILL OWES (F07/F08, Sep 22 2026).
//
// The queue above shows scripts that EXIST. This shows the ones that do not,
// and the honest reason for each — because the two states that used to be
// invisible are the two that matter: a client whose written answers are sitting
// there undrafted (the portal told them we would draft it), and a topic the
// call only PROPOSED that nobody has reconciled.
//
// "Draft what's ready" never touches a THIN topic. Drafting one of those from
// the topic line and the strategy alone is a judgement call, so it is its own
// button with its own words on it.
// ---------------------------------------------------------------------------
const READY = new Set(["FROM_ANSWERS", "FROM_CALL"]);
const TONE: Record<string, string> = {
  FROM_ANSWERS: "border-emerald-500/30 bg-emerald-500/5",
  FROM_CALL: "border-emerald-500/30 bg-emerald-500/5",
  WAITING_ON_ANSWERS: "border-amber-500/30 bg-amber-500/5",
  WAITING_ON_PLANNING: "border-amber-500/30 bg-amber-500/5",
  THIN_ANSWERS: "border-amber-500/30 bg-amber-500/5",
  THIN: "border-border bg-surface-2",
};
const LABEL: Record<string, string> = {
  FROM_ANSWERS: "Ready — their answers",
  FROM_CALL: "Ready — call excerpts",
  WAITING_ON_ANSWERS: "Waiting on them",
  WAITING_ON_PLANNING: "Needs reconciling",
  // CP-08: answers were sent but stop short of a script — Kyle follows up first.
  THIN_ANSWERS: "Answers too thin",
  THIN: "No evidence yet",
};

function OwedScripts({ owed, busy, run }: { owed: OwedUi[]; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  if (!owed.length) return null;
  const monthId = owed[0].monthId;
  const ready = owed.filter((o) => READY.has(o.readiness));
  const thin = owed.filter((o) => o.readiness === "THIN");
  return (
    <Section
      icon={CircleDashed}
      title="Still owed this month"
      count={owed.length}
      flush
      action={
        <span className="flex flex-wrap items-center gap-2">
          {ready.length > 0 && (
            <button disabled={busy} onClick={() => run(() => draftOwedScriptsAction(monthId, false))} className={`${btn} bg-brand text-white`}>
              <Sparkles className="mr-1 inline size-3" />Draft what&rsquo;s ready ({ready.length})
            </button>
          )}
          {thin.length > 0 && ready.length === 0 && (
            <button disabled={busy} onClick={() => run(() => draftOwedScriptsAction(monthId, true))} className={quiet}>
              <PenLine className="mr-1 inline size-3" />Draft from the topic alone ({thin.length})
            </button>
          )}
        </span>
      }
    >
      <ul className="divide-y divide-border">
        {owed.map((o) => (
          <li key={o.topicId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-5 py-2.5">
            <span className="text-sm font-medium">{o.title}</span>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${TONE[o.readiness] ?? "border-border bg-surface-2"}`}>{LABEL[o.readiness] ?? o.readiness}</span>
            <span className="text-[12px] text-muted">{o.why}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
