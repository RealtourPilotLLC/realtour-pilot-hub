"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, CircleDashed, Eye, FileText, History, Loader2, PenLine, RotateCcw, Scissors, Send, Sparkles, Undo2 } from "lucide-react";
import type { QueueItemUi } from "@/lib/aiQueue";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { useToast } from "@/components/ui/Toast";
import { useAiQueueWatch } from "@/components/content/useAiQueueWatch";
import { ScriptView } from "@/components/script/ScriptView";
import { WriterNotes } from "@/components/content/WriterNotes";
import type { WriterCardUi } from "@/lib/scriptWriter/record";
import { WRITER_LENGTH } from "@/lib/scriptWriter/rules";
// policy.ts is pure data with no imports of its own ("no node:crypto so this
// file can be imported from client components") — the 30–50 s target and the
// 25 s / 65 s warning thresholds are read from it rather than copied, so the
// chip, the findings row and the validator can never drift from each other.
// (Oct 6 2026: prompts.ts's prior-scripts line, once a "20–30 s" literal, now
// reads the policy too.)
import { GENERATION_POLICY } from "@/lib/contentPolicy/policy";
import { approveAndSendScriptAction, approveAndSendScriptsAction, approveScriptVersionAction, queueOwedScriptsAction, queueScriptRevisionAction, releaseScriptAction, restoreScriptVersionAction, retryAiJobAction, returnScriptAction, saveScriptText } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Scripts tab (spec §22/§27): ONE review queue for both planning paths, the
// version trail per script (regenerate/revise/edit never erase — they add a
// version), explicit attributable approve, release as its own act or in the
// same press ("Approve & send", Oct 20 2026; never on its own), and
// the validator's findings + the generator's gaps shown, never filled.
//
// Oct 12 2026: the AI buttons here answer at once and work in the background
// (aiQueue.ts) — "Draft what's ready", "Ask AI to revise" and "Tighten". The
// script being revised says so ("Revising…") across refreshes while every
// other script stays usable, and the page polls until the new version lands
// (or the failure, with its reason and Try again).
// ---------------------------------------------------------------------------

export type VersionUi = { id: string; versionNo: number; status: string; source: string; body: string; createdBy: string | null; createdAt: string; changeSummary: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; estimatedSeconds: number | null; spokenWordCount: number | null; pointCount: number; findings: { severity: string; message: string; code?: string }[]; gaps: { kind: string; text: string; question: string | null }[]; strategyVersionNo: number | null; policyVersionNo: number | null; answerCount: number; path: string; basedOnVersionNo: number | null; regeneratedSections: string[];
  /** A skit kept as written (speaker lines, directions): its length is a note, and Tighten would rewrite it, so it isn't offered. */
  skit?: boolean;
  /** Oct 14 2026: the writer's angle (viewer, belief, stake, angle, clientTake, payoff). Staff only, never the portal. */
  angle?: Record<string, string> | null;
  /** Oct 14 2026: the automatic check's line ("Checked: passed", "Auto-fixed 1 time", "Still flagged: …", "Not checked"). */
  check?: { tone: "ok" | "warn" | "muted"; text: string } | null;
  /** Still flagged by the automatic check: sorts first in the review queue. */
  flagged?: boolean;
  /** Oct 14 2026: the shoot plan (staff only). Not part of `body`, so the editor carries it in its own box. */
  filmingNotes?: string | null;
  /** Oct 22 2026: the new writer's brief, review and rationale (staff only; null for a version it did not make). */
  writer?: WriterCardUi | null };
/** One topic the month owes a script, with the reason it is or is not ready. Mirrors ScriptWorkItem in src/lib/contentDrafting.ts. */
export type OwedUi = { topicId: string; title: string; monthId: string; readiness: string; why: string; interviewId: string | null; excerpts: number };

export type ScriptUi = { id: string; title: string; status: string; historical: boolean; releaseState: string | null; monthKey: string | null; pillarName: string | null; currentVersionId: string | null; approvedVersionId: string | null; sharedVersionId: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; versions: VersionUi[]; sourceFile: string | null; clientVerdict: "APPROVED" | "CHANGES_REQUESTED" | "STALE" | null; clientVerdictAt: string | null;
  /** 6.5: the client changed an answer after this script was drafted — nothing redrafts on its own. */
  answersChanged?: boolean };

/** A version's status in words (audit D22: staff saw "internal_review"). */
const VERSION_WORD: Record<string, string> = { DRAFT: "waiting for an OK", INTERNAL_REVIEW: "waiting for an OK", APPROVED: "approved", SHARED: "sent to the client", SUPERSEDED: "replaced", REJECTED: "rejected" };

const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "");

const [TARGET_LO, TARGET_HI] = GENERATION_POLICY.timing.targetSec;
const { warnBelowSec: WARN_LO, warnAboveSec: WARN_HI } = GENERATION_POLICY.timing;

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
  // Tinted only when CLEARLY out of range (Oct 6 2026: 30–50 s, "sometimes a
  // minute") — the same thresholds as the validator's soft warning.
  return seconds > WARN_HI ? "over" : seconds < WARN_LO ? "under" : "on";
}

type QueueResult = { ok: boolean; message: string; runId?: string };
type Run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: (r: { ok: boolean; message: string }) => void) => void;

/** Filming notes as staff read them: a pasted link opens. */
function NotesText({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/\S+)/g).map((part, i) => (i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer" className="text-brand underline break-all">{part}</a> : part))}</>;
}
/** A script's revision as the row shows it: the queued run, or a click whose answer has not been rendered yet. */
type RevCtl = { server: QueueItemUi | null; sending: boolean; onRevise: (mode: "revise" | "tighten", instructions?: string, lockSections?: string[]) => void; onRetry: () => void };

/** Oct 14 2026: "Keep exactly" on a revision: these sections are copied back word for word by code. */
const LOCKS: [string, string][] = [["hook", "Hook"], ["rehook", "Re-hook"], ["buildup", "Build up"], ["payoff", "Payoff"], ["close", "Close"], ["captionCta", "Caption CTA"]];
const ANGLE_LABELS: [string, string][] = [["viewer", "Viewer"], ["belief", "Belief"], ["stake", "Stake"], ["angle", "Angle"], ["clientTake", "Client's take"], ["payoff", "Payoff"]];

export function ScriptsPanel({ enrollmentId = "", scripts, queueCount, scriptOwner, owed = [], revising = {}, drafting = {}, queueActive = [] }: {
  enrollmentId?: string; scripts: ScriptUi[]; queueCount: number; scriptOwner: string; owed?: OwedUi[];
  /** Oct 12: queued / running / failed AI revisions, by script id (aiQueue.queueStateFor). */
  revising?: Record<string, QueueItemUi>;
  /** Oct 12: the month's queued / drafting / failed script drafts, by topic id. */
  drafting?: Record<string, QueueItemUi>;
  /** Everything in flight for the client — the poll watches it. */
  queueActive?: string[];
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run: Run = (fn, after) => start(async () => { const r = await fn(); setNote(r.message); after?.(r); });
  const { toast, show } = useToast();
  useAiQueueWatch(enrollmentId, queueActive);
  // Per-script "sending": a revision click never takes the panel's shared busy.
  const [sending, setSending] = useState<Set<string>>(new Set());
  // Oct 20 2026 (audit D5): the queue's ticked versions, for "Approve & send N".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const mark = (id: string, on: boolean) => setSending((cur) => { const next = new Set(cur); if (on) next.add(id); else next.delete(id); return next; });
  const send = async (id: string, fn: () => Promise<QueueResult>) => {
    mark(id, true);
    let r: QueueResult;
    try { r = await fn(); } catch { r = { ok: false, message: "Couldn't reach the server — try again." }; }
    show(r.ok || r.runId ? "ok" : "err", r.message);
    // Once the server's answer is rendered, the queued run speaks for the row.
    setTimeout(() => mark(id, false), r.ok || r.runId ? 15_000 : 0);
  };
  const revCtl = (s: ScriptUi): RevCtl => {
    const server = revising[s.id] ?? null;
    return {
      server, sending: sending.has(s.id),
      onRevise: (mode, instructions = "", lockSections = []) => void send(s.id, () => queueScriptRevisionAction(s.id, mode, instructions, lockSections)),
      onRetry: () => { if (server) void send(s.id, () => retryAiJobAction(server.runId)); },
    };
  };
  // Oct 14 2026: a draft the automatic check still flags comes first.
  const queue = scripts.filter((s) => !s.historical && s.versions[0] && (s.versions[0].status === "DRAFT" || s.versions[0].status === "INTERNAL_REVIEW")).sort((a, b) => Number(!!b.versions[0]?.flagged) - Number(!!a.versions[0]?.flagged));
  const rest = scripts.filter((s) => !queue.includes(s) && !s.historical);
  const historical = scripts.filter((s) => s.historical);
  return (
    <div className="space-y-5">
      {toast}
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
      <OwedScripts owed={owed} drafting={drafting} sending={sending.has("owed")} onDraft={(includeThin) => void send("owed", () => queueOwedScriptsAction(owed[0]?.monthId ?? "", includeThin))} />
      <Section icon={FileText} title="Review queue" count={queueCount} flush action={<span className="text-[11px] text-muted-2">approval owner: {scriptOwner} · call-derived and written-answer drafts land here alike</span>}>
        {/* Oct 20 2026 (audit D5): tick the scripts you have read, then one
            press approves and sends them (one email batch per client). */}
        {queue.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-[12px]">
            <span className="text-muted">{picked.size ? `${picked.size} ticked` : "Tick the scripts you've read to approve and send them together."}</span>
            {picked.size > 0 && (
              <button disabled={busy} onClick={() => run(() => approveAndSendScriptsAction([...picked]), (r) => { if (r.ok) setPicked(new Set()); })} className={`${btn} min-h-9 bg-brand-action text-white`}>
                <Send className="mr-1 inline size-3" />Approve &amp; send {picked.size} to the client
              </button>
            )}
            {picked.size > 0 && <button onClick={() => setPicked(new Set())} className={`${quiet} min-h-9`}>Clear</button>}
          </div>
        )}
        <div className="divide-y divide-border">
          {queue.map((s) => {
            const vid = s.versions[0]?.id ?? null;
            const pickable = queue.length > 1 && !!vid && !vid.startsWith("legacy:");
            return (
              <div key={s.id} className="flex items-start">
                {pickable && (
                  <label className="flex min-h-11 shrink-0 items-start pl-4 pt-3.5" title="Tick to approve and send with the others">
                    <span className="sr-only">Tick {s.title}</span>
                    <input type="checkbox" className="size-4" checked={picked.has(vid!)} onChange={(e) => setPicked((cur) => { const next = new Set(cur); if (e.target.checked) next.add(vid!); else next.delete(vid!); return next; })} />
                  </label>
                )}
                <div className="min-w-0 flex-1"><ScriptItem s={s} busy={busy} run={run} rev={revCtl(s)} open /></div>
              </div>
            );
          })}
          {queue.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nothing waiting on you.</p>}
        </div>
      </Section>
      <Section icon={Check} title="Approved and released" count={rest.length} flush>
        <div className="divide-y divide-border">
          {rest.map((s) => <ScriptItem key={s.id} s={s} busy={busy} run={run} rev={revCtl(s)} />)}
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

function ScriptItem({ s, busy, run, open, rev }: { s: ScriptUi; busy: boolean; run: Run; open?: boolean; rev?: RevCtl }) {
  const [showVersions, setShowVersions] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [mode, setMode] = useState<"read" | "revise" | "edit">("read");
  const cur = s.versions[0] ?? null;
  // THE EDIT BOX LOADS ON CLICK (Oct 14 2026). It used to be seeded once, when
  // the page first drew: an AI revision that landed afterwards (Janice's v4)
  // was on screen, but Edit opened the version before it and saved that back
  // on top. The box now takes the current version when Edit is pressed, and
  // remembers which one, so the server can refuse a save that started from a
  // version that is no longer the newest.
  const [body, setBody] = useState("");
  const [notes, setNotes] = useState("");
  const [baseId, setBaseId] = useState<string | null>(null);
  const startEdit = () => { setBody(cur?.body ?? ""); setNotes(cur?.filmingNotes ?? ""); setBaseId(cur?.id ?? null); setMode("edit"); };
  const base = baseId ? s.versions.find((v) => v.id === baseId) ?? null : null;
  const moved = mode === "edit" && !!cur && !!baseId && cur.id !== baseId;
  const [instr, setInstr] = useState("");
  const [locks, setLocks] = useState<string[]>([]);
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
  // Oct 20 2026 (audit D5): approving a new version of a released script keeps
  // the client's shared version on their portal, so "released" alone no longer
  // means the approved version is the one they see.
  const sharedNo = s.sharedVersionId ? s.versions.find((v) => v.id === s.sharedVersionId)?.versionNo ?? null : null;
  const state = s.historical ? "historical"
    : releasedLive ? (s.sharedVersionId === s.approvedVersionId ? (cur && cur.id !== s.approvedVersionId ? "new draft since it was sent" : "released to the portal") : `approved · client still sees${sharedNo ? ` v${sharedNo}` : " the earlier version"}`)
    : approvedLive ? (cur && cur.id !== s.approvedVersionId ? "new draft since approval" : "approved · not released") : "needs your OK";
  // What the client has on their portal right now (audit D6: taking it off says so and takes a reason).
  const onPortal = !!s.sharedVersionId && s.releaseState === "released";
  const canApprove = !!cur && (!approvedLive || cur.id !== s.approvedVersionId);
  const [override, setOverride] = useState<{ message: string; send: boolean } | null>(null);
  const [overrideWhy, setOverrideWhy] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullWhy, setPullWhy] = useState("");
  const approve = (send: boolean) => {
    if (!cur) return;
    setOverride(null);
    run(() => (send ? approveAndSendScriptAction(cur.id) : approveScriptVersionAction(cur.id)), (r) => {
      if (!r.ok && /^Format check:/.test(r.message)) setOverride({ message: r.message, send });
    });
  };
  const tone = s.historical ? "bg-surface-2 text-muted" : state.startsWith("needs") || state.startsWith("new draft") || state.startsWith("approved · client") ? "bg-brand-soft text-brand" : "bg-success-soft text-success";
  // THE CLIENT'S OWN VERDICT (F09). Separate from every chip above, because our
  // approval and their willingness to say these words on camera are different
  // facts and the second one decides whether this belongs on a call sheet.
  // Oct 12: an AI revision of THIS script in the queue (the rest stay usable).
  const revBusy = !!rev && (rev.server?.state === "queued" || rev.server?.state === "running" || (rev.sending && rev.server?.state !== "failed"));
  const revFailed = !!rev && !revBusy && rev.server?.state === "failed" ? rev.server : null;
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
              <span className={pace === "on" || pace === null || (cur.skit && pace === "over") ? "" : "font-medium text-warning"} title={`${TARGET_LO}–${TARGET_HI}s target (about a minute is fine) · ${GENERATION_POLICY.timing.wordsPerSec} words per second`}>
                {" "}· ≈{cur.estimatedSeconds}s / {cur.spokenWordCount}w{pace === "over" ? (cur.skit ? " · a skit, runs long" : " · well over a minute") : pace === "under" ? ` · under ${TARGET_LO}s` : ""}
              </span>
            )}
            {cur.pointCount !== 3 && !s.historical ? ` · ${cur.pointCount} points` : ""}
          </span>
        )}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{state}</span>
        {verdict && <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${verdict.cls}`} title={s.clientVerdictAt ? `on ${fmt(s.clientVerdictAt)}` : undefined}>{verdict.label}</span>}
        {s.answersChanged && <span className="shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning" title="The client edited an answer after this draft. Revise it, or draft again from the answers.">answers changed since this draft</span>}
        {revBusy && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand"><Loader2 className="size-3 animate-spin" />{rev?.server?.label === "tighten" ? "tightening…" : rev?.server?.label === "redraft" ? "redrafting…" : "revising…"}</span>}
      </summary>
      <div className="mt-2">
        {revBusy && <p className="mb-1.5 text-[12px] text-muted"><Loader2 className="mr-1 inline size-3 animate-spin" />{rev?.server?.label === "tighten" ? "Tightening" : rev?.server?.label === "redraft" ? "Drafting again from the answers" : "Revising"} in the background — the new version appears here when it&rsquo;s ready{cur ? `; v${cur.versionNo} is kept` : ""}.</p>}
        {revFailed && (
          <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-danger">
            <AlertTriangle className="size-3.5" />{revFailed.label === "tighten" ? "Tightening" : revFailed.label === "redraft" ? "The new draft" : "The revision"} failed: {revFailed.error}
            <button onClick={rev?.onRetry} className="rounded-md border border-danger/40 px-2 py-0.5 text-[11px] font-semibold hover:bg-danger-soft">Try again</button>
          </p>
        )}
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
            {pace === "over" && cur.skit && (
              <p className="text-muted">Length: ≈{cur.estimatedSeconds}s ({cur.spokenWordCount} spoken words; speakers and directions aren&rsquo;t counted). Skits run longer than a talking head, and that&rsquo;s fine.</p>
            )}
            {/* Oct 22 2026: over the 110-word cap, the "A bit long: needs a fix" line below says it (with its own fix). */}
            {pace === "over" && !cur.skit && !((cur.spokenWordCount ?? 0) > WRITER_LENGTH.cap) && (
              <p className="flex flex-wrap items-center gap-1.5 text-warning">
                <span>Length: ≈{cur.estimatedSeconds}s ({cur.spokenWordCount} words) — well over a minute; the target is {TARGET_LO}–{TARGET_HI}s. It can still be approved — this is an estimate from a word count, not a rejection.</span>
                <button disabled={revBusy} onClick={() => rev?.onRevise("tighten")} className="inline-flex items-center gap-1 rounded-md border border-warning/40 px-2 py-0.5 font-semibold text-warning hover:bg-warning/10 disabled:opacity-50">
                  <Scissors className="size-3" />Tighten to {TARGET_LO}–{TARGET_HI}s
                </button>
              </p>
            )}
            {/* No Tighten button on a short script: the tighten plan refuses a
                version that is already at or under the target, and offering a
                button the server declines is the trap the approve flow already
                learned to avoid. Shortening is the wrong verb anyway — the
                validator's own words for this case are "it may read as thin on
                camera; add substance rather than padding". */}
            {pace === "under" && (
              <p className="text-warning">
                Length: ≈{cur.estimatedSeconds}s ({cur.spokenWordCount} words) is clearly short of the {TARGET_LO}–{TARGET_HI}s target. It can still be approved — this is an estimate from a word count, not a rejection — but it may read as thin on camera. Add substance with &ldquo;Ask AI to revise&rdquo; or &ldquo;Edit myself&rdquo; rather than padding; both keep this version.
              </p>
            )}
            {cur.gaps.map((g, i) => <p key={`g${i}`} className="text-muted">Gap ({g.kind}): {g.text}{g.question ? ` → ${g.question}` : ""}</p>)}
          </div>
        )}
        {/* Oct 14 2026: the automatic check's line and the writer's angle. Staff only: neither is ever sent to the portal. */}
        {cur && !s.historical && (cur.check || cur.angle) && mode !== "edit" && (
          <div className="mt-1.5 space-y-0.5 rounded-lg border border-border bg-surface-2/40 px-2.5 py-1.5 text-[11px]">
            {cur.check && <p className={cur.check.tone === "ok" ? "text-success" : cur.check.tone === "warn" ? "font-medium text-warning" : "text-muted"}>{cur.check.text}</p>}
            {cur.angle && (
              <details>
                <summary className="cursor-pointer text-muted"><span className="font-semibold">Angle:</span> {cur.angle.angle ?? cur.angle.payoff ?? ""}{cur.angle.viewer ? ` · for ${cur.angle.viewer}` : ""}</summary>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted">
                  {ANGLE_LABELS.filter(([k]) => cur.angle?.[k]).map(([k, label]) => (
                    <div key={k} className="contents"><dt className="font-medium">{label}</dt><dd>{cur.angle?.[k]}</dd></div>
                  ))}
                </dl>
              </details>
            )}
          </div>
        )}
        {/* Oct 22 2026: the new writer's review, rationale and brief, and the length rule (over 110 words: "A bit long: needs a fix", one press). */}
        {cur && !s.historical && mode !== "edit" && (
          <WriterNotes writer={cur.writer} words={cur.spokenWordCount} skit={!!cur.skit} canFix={!!rev} busy={revBusy} onFix={(instruction) => rev?.onRevise("revise", instruction)} />
        )}
        {mode === "edit" ? (
          <div className="mt-2">
            <p className="mb-1 text-[11px] text-muted">Editing v{base?.versionNo ?? cur?.versionNo}. Saving adds a new version; v{base?.versionNo ?? cur?.versionNo} is kept.</p>
            {moved && (
              <p className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning">
                <AlertTriangle className="size-3.5" />v{cur?.versionNo} was added while you were editing v{base?.versionNo}. Saving now would put v{base?.versionNo}&rsquo;s words back on top, so it is refused. Copy what you changed, then:
                <button onClick={startEdit} className="rounded-md border border-warning/40 px-2 py-0.5 text-[11px] font-semibold hover:bg-warning/10">Start over from v{cur?.versionNo}</button>
              </p>
            )}
            <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} minRows={8} className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs leading-relaxed" />
            <label className="mt-1.5 block text-[11px] font-medium text-muted">Filming notes <span className="font-normal text-muted-2">(staff and the shoot only, never the client; reference links go here)</span></label>
            <AutoTextarea value={notes} onChange={(e) => setNotes(e.target.value)} minRows={2} className="mt-0.5 w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs leading-relaxed" />
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={busy} onClick={() => run(() => saveScriptText(s.id, body, { baseVersionId: baseId, filmingNotes: notes }), (r) => { if (r.ok) setMode("read"); })} className={`${btn} bg-brand-action text-white`}>Save as a new version</button>
              <button onClick={() => setMode("read")} className={quiet}>Cancel</button>
            </div>
          </div>
        ) : cur ? (
          <>
            <ScriptView body={cur.body} size="sm" audience="staff" pillarName={s.pillarName} fileTitle={s.title} />
            {cur.filmingNotes && <p className="mt-1.5 whitespace-pre-wrap rounded-lg border border-border bg-surface-2/40 px-2.5 py-1.5 text-[11px] text-muted"><span className="font-semibold">Filming notes:</span> <NotesText text={cur.filmingNotes} /></p>}
          </>
        ) : null}
        {mode === "revise" && (
          <div className="mt-2">
            <AutoTextarea value={instr} onChange={(e) => setInstr(e.target.value)} minRows={2} placeholder="Tell the AI what to change — the current version is kept as is" className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs" />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
              <span className="font-medium">Keep exactly:</span>
              {LOCKS.map(([k, label]) => (
                <label key={k} className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={locks.includes(k)} onChange={(e) => setLocks((prev) => (e.target.checked ? [...prev, k] : prev.filter((x) => x !== k)))} />
                  {label}
                </label>
              ))}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={revBusy || !instr.trim()} onClick={() => { rev?.onRevise("revise", instr, locks); setInstr(""); setLocks([]); setMode("read"); }} className={`${btn} inline-flex items-center gap-1 bg-brand-action text-white`}><Sparkles className="size-3" /> Regenerate as new version</button>
              <button onClick={() => setMode("read")} className={quiet}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "read" && !s.historical && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {/* Oct 20 2026 (audit D5): one press approves THIS version and sends
                it to the client's portal (the Release operation). "Approve only"
                keeps it in the office. Both are a person's press; nothing sends
                a script on its own. */}
            {canApprove && cur && <button disabled={busy} onClick={() => approve(true)} className={`${btn} bg-brand-action text-white`}><Send className="mr-1 inline size-3" />Approve &amp; send v{cur.versionNo} to the client</button>}
            {canApprove && cur && <button disabled={busy} onClick={() => approve(false)} className={`${btn} bg-success/15 text-success hover:bg-success/25`}><Check className="mr-1 inline size-3" />Approve only</button>}
            {approvedLive && s.sharedVersionId !== s.approvedVersionId && <button disabled={busy} onClick={() => run(() => releaseScriptAction(s.id))} className={`${btn} bg-brand-action text-white`}><Send className="mr-1 inline size-3" />Send v{s.versions.find((v) => v.id === s.approvedVersionId)?.versionNo ?? ""} to the client</button>}
            <button disabled={revBusy} onClick={() => setMode("revise")} className={quiet}><Sparkles className="mr-1 inline size-3" />Ask AI to revise</button>
            <button onClick={startEdit} className={quiet}>Edit myself</button>
            {/* Oct 20 2026 (audit D6): taking a script off the client's portal says so and takes a reason. */}
            {onPortal
              ? <button disabled={busy} onClick={() => { setPullWhy(""); setPulling(true); }} className={quiet}><Undo2 className="mr-1 inline size-3" />Pull back from the client&rsquo;s portal</button>
              : (s.approvedVersionId || s.sharedVersionId) && <button disabled={busy} onClick={() => run(() => returnScriptAction(s.id, ""))} className={quiet}><Undo2 className="mr-1 inline size-3" />Back to the queue</button>}
          </div>
        )}
        {mode === "read" && override && cur && (
          // An overridable format finding (a missing pillar link and the like):
          // the approver may pass it with a written reason, recorded on the
          // ledger. A "House script format:" failure never reaches here (audit
          // finding 6, Sep 17): the shape of a script is not something a reason
          // can argue with, so it shows as a plain error instead.
          <div className="mt-2 rounded-lg border border-warning/40 bg-warning-soft px-2.5 py-2 text-[12px]">
            <p className="text-warning">{override.message}</p>
            <label className="mt-1.5 block font-medium text-muted" htmlFor={`why-${s.id}`}>Approve anyway? Say why (this is recorded)</label>
            <AutoTextarea id={`why-${s.id}`} value={overrideWhy} onChange={(e) => setOverrideWhy(e.target.value)} minRows={2} className="mt-0.5 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base sm:text-xs" />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button disabled={busy || !overrideWhy.trim()} onClick={() => { const send = override.send, why = overrideWhy.trim(); run(() => (send ? approveAndSendScriptAction(cur.id, why) : approveScriptVersionAction(cur.id, why)), (r) => { if (r.ok) { setOverride(null); setOverrideWhy(""); } }); }} className={`${btn} min-h-9 bg-brand-action text-white`}>{override.send ? "Approve and send anyway" : "Approve anyway"}</button>
              <button onClick={() => { setOverride(null); setOverrideWhy(""); }} className={`${quiet} min-h-9`}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "read" && pulling && onPortal && (
          <div className="mt-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-2 text-[12px]">
            <label className="block font-medium text-muted" htmlFor={`pull-${s.id}`}>Pull &ldquo;{s.title}&rdquo; off the client&rsquo;s portal? It goes back to the review queue. Say why (kept with its history)</label>
            <AutoTextarea id={`pull-${s.id}`} value={pullWhy} onChange={(e) => setPullWhy(e.target.value)} minRows={2} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base sm:text-xs" />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button disabled={busy || !pullWhy.trim()} onClick={() => run(() => returnScriptAction(s.id, pullWhy.trim()), (r) => { if (r.ok) setPulling(false); })} className={`${btn} min-h-9 bg-danger/15 text-danger hover:bg-danger/25`}>Pull it back</button>
              <button onClick={() => setPulling(false)} className={`${quiet} min-h-9`}>Keep it on their portal</button>
            </div>
          </div>
        )}
        {s.versions.length > 1 && (
          <div className="mt-2">
            <button onClick={() => setShowVersions(!showVersions)} className="text-[11px] text-muted hover:underline"><History className="mr-0.5 inline size-3" />{s.versions.length} versions</button>
            {showVersions && (
              <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
                {s.versions.map((v) => (
                  <li key={v.id}>
                    v{v.versionNo} · {VERSION_WORD[v.status] ?? v.status.toLowerCase().replace(/_/g, " ")} · {v.source.toLowerCase()}{v.basedOnVersionNo ? ` (from v${v.basedOnVersionNo}${v.regeneratedSections.length ? `; changed ${v.regeneratedSections.join(", ")}` : ""})` : ""} · {fmt(v.createdAt)}{v.createdBy ? ` by ${v.createdBy}` : ""}{v.approvedAt ? ` · approved by ${v.approvedBy}` : ""}{v.sharedAt ? " · shared" : ""}{v.id === s.sharedVersionId ? " ← what the client sees" : ""}{v.id === cur?.id ? " · current" : ""}
                    {v.changeSummary ? ` — ${v.changeSummary}` : ""}
                    {v.id !== cur?.id && (
                      <span className="ml-1.5 inline-flex gap-1 align-middle">
                        <button onClick={() => setViewing(viewing === v.id ? null : v.id)} className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-px text-[10px] font-medium hover:bg-surface-2"><Eye className="size-2.5" />{viewing === v.id ? "Hide" : "View"}</button>
                        {/* Oct 14 2026: restore = a copy on top, never a rewind. */}
                        {!s.historical && !v.id.startsWith("legacy:") && (
                          <button disabled={busy || revBusy || mode === "edit"} title={revBusy ? "Wait for the AI revision to finish" : mode === "edit" ? "Finish or cancel the edit first" : undefined}
                            onClick={() => { if (window.confirm(`Restore v${v.versionNo}? Its script and filming notes are copied into a new version on top (v${(cur?.versionNo ?? 0) + 1}). Nothing is deleted: you can restore any other version the same way.`)) run(() => restoreScriptVersionAction(s.id, v.id, cur?.id ?? null), (r) => { if (r.ok) setViewing(null); }); }}
                            className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-px text-[10px] font-medium hover:bg-surface-2 disabled:opacity-50"><RotateCcw className="size-2.5" />Restore</button>
                        )}
                      </span>
                    )}
                    {viewing === v.id && (
                      <div className="mt-1 rounded-lg border border-border bg-surface px-2.5 py-2 text-foreground">
                        <ScriptView body={v.body} size="sm" audience="staff" pillarName={s.pillarName} fileTitle={s.title} />
                        {v.filmingNotes && <p className="mt-1.5 whitespace-pre-wrap text-[11px] text-muted"><span className="font-semibold">Filming notes:</span> <NotesText text={v.filmingNotes} /></p>}
                      </div>
                    )}
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

function OwedScripts({ owed, drafting = {}, sending = false, onDraft }: { owed: OwedUi[]; drafting?: Record<string, QueueItemUi>; sending?: boolean; onDraft: (includeThin: boolean) => void }) {
  if (!owed.length) return null;
  // Oct 12: a topic already queued or with the model is not offered again.
  const inFlight = (o: OwedUi) => drafting[o.topicId]?.state === "queued" || drafting[o.topicId]?.state === "running";
  const ready = owed.filter((o) => READY.has(o.readiness) && !inFlight(o));
  const thin = owed.filter((o) => o.readiness === "THIN" && !inFlight(o));
  const draftingNow = owed.filter(inFlight).length;
  return (
    <Section
      icon={CircleDashed}
      title="Still owed this month"
      count={owed.length}
      flush
      action={
        <span className="flex flex-wrap items-center gap-2">
          {(draftingNow > 0 || sending) && <span className="inline-flex items-center gap-1 text-[12px] text-muted"><Loader2 className="size-3 animate-spin" />Drafting{draftingNow ? ` ${draftingNow}` : ""}…</span>}
          {ready.length > 0 && (
            <button disabled={sending} onClick={() => onDraft(false)} className={`${btn} bg-brand-action text-white`}>
              <Sparkles className="mr-1 inline size-3" />Draft what&rsquo;s ready ({ready.length})
            </button>
          )}
          {thin.length > 0 && ready.length === 0 && (
            <button disabled={sending} onClick={() => onDraft(true)} className={quiet}>
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
            {inFlight(o) && <span className="inline-flex items-center gap-1 text-[12px] font-medium text-brand"><Loader2 className="size-3 animate-spin" />Drafting…</span>}
            {drafting[o.topicId]?.state === "failed" && <span className="text-[12px] text-danger">Drafting failed: {drafting[o.topicId]?.error}</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
