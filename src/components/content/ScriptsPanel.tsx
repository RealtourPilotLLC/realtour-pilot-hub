"use client";

import { useState, useTransition } from "react";
import { Check, ChevronDown, CircleDashed, Eye, FileText, History, Loader2, MessageSquareText, PenLine, RefreshCw, RotateCcw, Send, Sparkles } from "lucide-react";
import type { QueueItemUi } from "@/lib/aiQueue";
import type { QuestionRequestUi } from "@/lib/questionRequests";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { useToast } from "@/components/ui/Toast";
import { useDetailsMenu } from "@/components/ui/useDetailsMenu";
import { useAiQueueWatch } from "@/components/content/useAiQueueWatch";
import { ScriptView } from "@/components/script/ScriptView";
import { WriterNotes, versionHow } from "@/components/content/WriterNotes";
import { TopicBriefFold, type TopicBriefUi } from "@/components/content/TopicBriefFold";
import type { WriterCardUi } from "@/lib/scriptWriter/record";
import { lengthBand, trimInstruction } from "@/lib/scriptWriter/rules";
// policy.ts is pure data with no imports of its own ("no node:crypto so this
// file can be imported from client components"): the 30–50 s target and the
// 65 s "well over a minute" threshold are read from it rather than copied, so
// the Shorten offer and the validator can never drift from each other.
import { GENERATION_POLICY } from "@/lib/contentPolicy/policy";
import { VIDEO_FORMAT_LABEL, type VideoFormat } from "@/lib/contentPolicy/videoFormat";
import { approveAndSendScriptAction, approveAndSendScriptsAction, approveScriptVersionAction, queueOwedScriptsAction, queueScriptRevisionAction, queueScriptRewriteAction, releaseScriptAction, resendQuestionRequestAction, restoreScriptVersionAction, retryAiJobAction, returnScriptAction, saveScriptText, sendQuestionRequestAction, undoQuestionRequestAction } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Scripts tab (spec §22/§27): ONE review queue for both planning paths, the
// version trail per script (regenerate/revise/edit never erase — they add a
// version), explicit attributable approve, release as its own act or in the
// same press ("Approve and send", Oct 20 2026; never on its own).
//
// THE CARD SHOWS THE SCRIPT, NOT THE MACHINERY (Oct 23 2026). Jordan, with a
// screenshot of Bernadette's Saturday script (v12, a creative review line,
// two gap boxes, a word count, a red "still failing" line, 13 checks and the
// craft scores above the script): "I don't need to see that it needs fixes; I
// just need it to be fixed. This is way too much. I just want to come in and
// either make a quick edit or just approve and send."
//
//   the card    the title, the format chip and the state ("needs your OK");
//               the script (pillar chip, Copy, Download, the parts and the
//               caption CTA); the filming notes in small type
//   two actions Edit (inline, saved as a new version through saveScriptText)
//               and Approve and send (approveAndSendScriptAction: the same
//               approve, release ledger and checks as before; a refusal is
//               said in words on the card)
//   More        everything else that was on the card: Approve only, send the
//               approved version, Ask AI to revise (with Keep exactly),
//               Write it again (Oct 23 2026: a fresh draft of the topic by
//               the writer, as the next version; refused in words for a
//               script that has gone to the client, lib/scriptRewriteRule),
//               Shorten with AI, Version history (View, Restore), Back to the
//               queue / Pull back from the client's portal. The list is
//               placed against the screen when it opens (useDetailsMenu), so
//               the card's rounded, clipped edge never cuts it off.
//   notes       one fold at the very bottom, "Writer's notes", closed, grey
//
// SEND QUESTION REQUEST (Oct 23 2026, Jordan). A visible button beside Edit on
// a draft the client has not seen (never shared, never approved by them, not
// filmed). One short confirm, then lib/questionRequests: the draft comes off
// the month (kept in its history), the topic is asked in writing with three
// to five AI questions, and the client gets one email with a link. The card's
// place is taken by "Questions sent <date> · waiting on <client>", with Undo
// (the draft back, no more emails) and Resend (a new link).
//
// No review result, gap, craft score, fix round, word count or red warning
// is on the card, and nothing on it says a script needs fixes: the automatic
// check keeps the best version current on its own (scriptJudge.ts). The
// portal is unchanged. Client change requests keep their own panel
// (ScriptRequestsPanel), exactly as before.
//
// Oct 12 2026: the AI buttons answer at once and work in the background
// (aiQueue.ts). The script being revised says so ("revising…") across
// refreshes while every other script stays usable, and the page polls until
// the new version lands (or the failure, with its reason and Try again).
// ---------------------------------------------------------------------------

export type VersionUi = { id: string; versionNo: number; status: string; source: string; body: string; createdBy: string | null; createdAt: string; changeSummary: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; estimatedSeconds: number | null; spokenWordCount: number | null; pointCount: number; findings: { severity: string; message: string; code?: string }[]; gaps: { kind: string; text: string; question: string | null }[]; strategyVersionNo: number | null; policyVersionNo: number | null; answerCount: number; path: string; basedOnVersionNo: number | null; regeneratedSections: string[];
  /** A skit kept as written (speaker lines, directions): its length is a note, and Shorten would rewrite it, so it isn't offered. */
  skit?: boolean;
  /** Oct 22 2026: the format this version was written in: Skit or Talking to camera. */
  format?: VideoFormat;
  /** Oct 14 2026: the writer's angle (viewer, belief, stake, angle, clientTake, payoff). Staff only, never the portal. */
  angle?: Record<string, string> | null;
  /** Oct 14 2026: the automatic check's line. Oct 23 2026: no longer drawn on the card (Writer's notes keep neutral facts only). */
  check?: { tone: "ok" | "warn" | "muted"; text: string } | null;
  /** Still flagged by the automatic check: sorts first in the review queue (never said on the card). */
  flagged?: boolean;
  /** Oct 14 2026: the shoot plan (staff only). Not part of `body`, so the editor carries it in its own box. */
  filmingNotes?: string | null;
  /** Oct 22 2026: the new writer's brief and rationale (staff only; null for a version it did not make). */
  writer?: WriterCardUi | null };
/** One topic the month owes a script, with the reason it is or is not ready. Mirrors ScriptWorkItem in src/lib/contentDrafting.ts. */
export type OwedUi = { topicId: string; title: string; monthId: string; readiness: string; why: string; interviewId: string | null; excerpts: number };

export type ScriptUi = { id: string; title: string; status: string; historical: boolean; releaseState: string | null; monthKey: string | null; pillarName: string | null; currentVersionId: string | null; approvedVersionId: string | null; sharedVersionId: string | null; approvedBy: string | null; approvedAt: string | null; sharedAt: string | null; versions: VersionUi[]; sourceFile: string | null; clientVerdict: "APPROVED" | "CHANGES_REQUESTED" | "STALE" | null; clientVerdictAt: string | null;
  /** 6.5: the client changed an answer after this script was drafted — nothing redrafts on its own. */
  answersChanged?: boolean;
  /** Oct 22 2026: its video is filmed (lib/scriptFilmed) — not the client's verdict, and the client is no longer asked. */
  filmed?: { atISO: string | null; signal: string } | null;
  /** Oct 22 2026: the topic's format (its own, else the account's default); null for a script with no topic. */
  topicFormat?: VideoFormat | null;
  /** Oct 22 2026 (audit M5): a bulk plan's script, the client's own bank: the client is never asked to approve it. */
  bulkBank?: boolean;
  /** Oct 23 2026: why "Write it again" is refused for this script (lib/scriptRewriteRule), or null when it may run. */
  rewrite?: string | null;
  /** Oct 26 2026: what the agent said about this script's topic (lib/scriptWriter/topicBrief), on a monthly topic's script. */
  brief?: TopicBriefUi | null };

/**
 * The script's CURRENT version (Oct 23 2026). An automatic fix round that was
 * not better is kept in the history and can be newer than the current one, so
 * the card reads currentVersionId, never "the newest".
 */
export function currentOf(s: Pick<ScriptUi, "versions" | "currentVersionId">): VersionUi | null {
  return s.versions.find((v) => v.id === s.currentVersionId) ?? s.versions[0] ?? null;
}

/** A version's status in words (audit D22: staff saw "internal_review"). */
const VERSION_WORD: Record<string, string> = { DRAFT: "waiting for an OK", INTERNAL_REVIEW: "waiting for an OK", APPROVED: "approved", SHARED: "sent to the client", SUPERSEDED: "replaced", REJECTED: "rejected", WITHDRAWN: "withdrawn for questions" };

const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const menuItem = "flex w-full min-h-9 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-2 disabled:opacity-50";
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "");

/** The old writer's "well over a minute" line (policy), where Tighten applies. */
const { warnAboveSec: WARN_HI } = GENERATION_POLICY.timing;

type QueueResult = { ok: boolean; message: string; runId?: string };
type Run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: (r: { ok: boolean; message: string }) => void) => void;

/** Filming notes as staff read them: a pasted link opens. */
function NotesText({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/\S+)/g).map((part, i) => (i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer" className="text-brand underline break-all">{part}</a> : part))}</>;
}
/** A script's revision as the row shows it: the queued run, or a click whose answer has not been rendered yet. */
type RevCtl = { server: QueueItemUi | null; sending: boolean; sendingLabel?: string | null; onRevise: (mode: "revise" | "tighten", instructions?: string, lockSections?: string[]) => void; onRewrite: () => void; onRetry: () => void };

/** Oct 14 2026: "Keep exactly" on a revision: these sections are copied back word for word by code. */
const LOCKS: [string, string][] = [["hook", "Hook"], ["rehook", "Re-hook"], ["buildup", "Build up"], ["payoff", "Payoff"], ["close", "Close"], ["captionCta", "Caption CTA"]];

export function ScriptsPanel({ enrollmentId = "", scripts, queueCount, scriptOwner, owed = [], revising = {}, drafting = {}, queueActive = [], questionRequests = [], clientFirst = "" }: {
  enrollmentId?: string; scripts: ScriptUi[]; queueCount: number; scriptOwner: string; owed?: OwedUi[];
  /** Oct 26 2026: the client's first name, for "What <first> said" on the card. */
  clientFirst?: string;
  /** Oct 23 2026: the month's open question requests (Send Question Request). */
  questionRequests?: QuestionRequestUi[];
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
  // Oct 23 2026: a card's own presses answer on the card (a refusal is said in words next to the button).
  const runCard: Run = (fn, after) => start(async () => { const r = await fn(); after?.(r); });
  const { toast, show } = useToast();
  useAiQueueWatch(enrollmentId, queueActive);
  // Per-script "sending": a revision click never takes the panel's shared busy.
  // The value is what was pressed ("rewrite" for Write it again), for the chip before the server's answer is drawn.
  const [sending, setSending] = useState<Map<string, string | null>>(new Map());
  // Oct 20 2026 (audit D5): the queue's ticked versions, for "Approve & send N".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const mark = (id: string, on: boolean, label: string | null = null) => setSending((cur) => { const next = new Map(cur); if (on) next.set(id, label); else next.delete(id); return next; });
  const send = async (id: string, fn: () => Promise<QueueResult>, label: string | null = null) => {
    mark(id, true, label);
    let r: QueueResult;
    try { r = await fn(); } catch { r = { ok: false, message: "Couldn't reach the server. Try again." }; }
    show(r.ok || r.runId ? "ok" : "err", r.message);
    // Once the server's answer is rendered, the queued run speaks for the row.
    setTimeout(() => mark(id, false), r.ok || r.runId ? 15_000 : 0);
  };
  const revCtl = (s: ScriptUi): RevCtl => {
    const server = revising[s.id] ?? null;
    return {
      server, sending: sending.has(s.id), sendingLabel: sending.get(s.id) ?? null,
      onRevise: (mode, instructions = "", lockSections = []) => void send(s.id, () => queueScriptRevisionAction(s.id, mode, instructions, lockSections), mode),
      // Oct 23 2026: "Write it again", queued and shown exactly like a revision.
      onRewrite: () => void send(s.id, () => queueScriptRewriteAction(s.id), "rewrite"),
      onRetry: () => { if (server) void send(s.id, () => retryAiJobAction(server.runId), server.label ?? null); },
    };
  };
  // Oct 14 2026: a draft the automatic check still flags comes first (the order only; the card never says why).
  const waiting = (s: ScriptUi) => { const c = currentOf(s); return !!c && (c.status === "DRAFT" || c.status === "INTERNAL_REVIEW"); };
  const queue = scripts.filter((s) => !s.historical && waiting(s)).sort((a, b) => Number(!!currentOf(b)?.flagged) - Number(!!currentOf(a)?.flagged));
  const rest = scripts.filter((s) => !queue.includes(s) && !s.historical);
  const historical = scripts.filter((s) => s.historical);
  // Oct 23 2026: Send Question Request. A success is said in the toast (the
  // card leaves the queue for the request's card); a refusal stays on the card.
  const askQuestions = async (scriptId: string): Promise<{ ok: boolean; message: string }> => {
    let r: { ok: boolean; message: string };
    try { r = await sendQuestionRequestAction(scriptId); } catch { r = { ok: false, message: "Couldn't reach the server. Try again." }; }
    if (r.ok) show("ok", r.message);
    return r;
  };
  return (
    <div className="space-y-5">
      {toast}
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" />}{note}</p>}
      <OwedScripts owed={owed} drafting={drafting} sending={sending.has("owed")} onDraft={(includeThin) => void send("owed", () => queueOwedScriptsAction(owed[0]?.monthId ?? "", includeThin))} />
      {questionRequests.length > 0 && (
        <Section icon={MessageSquareText} title="Questions sent" count={questionRequests.length} flush action={<span className="text-[11px] text-muted-2">the client answers, then the script is drafted from their answers</span>}>
          <div className="divide-y divide-border">{questionRequests.map((q) => <QuestionRequestCard key={q.id} q={q} show={show} />)}</div>
        </Section>
      )}
      <Section icon={FileText} title="Review queue" count={queueCount} flush action={<span className="text-[11px] text-muted-2">approval owner: {scriptOwner}</span>}>
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
            const vid = currentOf(s)?.id ?? null;
            const pickable = queue.length > 1 && !!vid && !vid.startsWith("legacy:");
            return (
              <div key={s.id} className="flex items-start">
                {pickable && (
                  <label className="flex min-h-11 shrink-0 items-start pl-4 pt-3.5" title="Tick to approve and send with the others">
                    <span className="sr-only">Tick {s.title}</span>
                    <input type="checkbox" className="size-4" checked={picked.has(vid!)} onChange={(e) => setPicked((cur) => { const next = new Set(cur); if (e.target.checked) next.add(vid!); else next.delete(vid!); return next; })} />
                  </label>
                )}
                <div className="min-w-0 flex-1"><ScriptItem s={s} busy={busy} run={runCard} rev={revCtl(s)} open onAsk={askQuestions} clientFirst={clientFirst} /></div>
              </div>
            );
          })}
          {queue.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nothing waiting on you.</p>}
        </div>
      </Section>
      <Section icon={Check} title="Approved and released" count={rest.length} flush>
        <div className="divide-y divide-border">
          {rest.map((s) => <ScriptItem key={s.id} s={s} busy={busy} run={runCard} rev={revCtl(s)} onAsk={askQuestions} clientFirst={clientFirst} />)}
          {rest.length === 0 && <p className="px-5 py-3 text-sm text-muted">No approved scripts on this month yet.</p>}
        </div>
      </Section>
      {historical.length > 0 && (
        <Section icon={History} title="Historical (imported)" count={historical.length} flush action={<span className="text-[11px] text-muted-2">history — never approved, filmed or released by an import</span>}>
          <div className="divide-y divide-border">{historical.map((s) => <ScriptItem key={s.id} s={s} busy={busy} run={runCard} />)}</div>
        </Section>
      )}
    </div>
  );
}

function ScriptItem({ s, busy, run, open, rev, onAsk, clientFirst = "" }: { s: ScriptUi; busy: boolean; run: Run; open?: boolean; rev?: RevCtl; onAsk?: (scriptId: string) => Promise<{ ok: boolean; message: string }>; clientFirst?: string }) {
  const [showVersions, setShowVersions] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [mode, setMode] = useState<"read" | "revise" | "edit">("read");
  // Oct 23 2026: what the last press on this card said (a refusal in words, or what was done).
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);
  // Oct 23 2026: More is placed against the screen when it opens (the card clipped it).
  const menu = useDetailsMenu();
  const closeMenu = () => menu.close(true);
  const cur = currentOf(s);
  // THE EDIT BOX LOADS ON CLICK (Oct 14 2026). It used to be seeded once, when
  // the page first drew: an AI revision that landed afterwards (Janice's v4)
  // was on screen, but Edit opened the version before it and saved that back
  // on top. The box now takes the current version when Edit is pressed, and
  // remembers which one, so the server can refuse a save that started from a
  // version that is no longer current.
  const [body, setBody] = useState("");
  const [notes, setNotes] = useState("");
  const [baseId, setBaseId] = useState<string | null>(null);
  const startEdit = () => { setBody(cur?.body ?? ""); setNotes(cur?.filmingNotes ?? ""); setBaseId(cur?.id ?? null); setMode("edit"); setSaid(null); };
  const base = baseId ? s.versions.find((v) => v.id === baseId) ?? null : null;
  const moved = mode === "edit" && !!cur && !!baseId && cur.id !== baseId;
  const [instr, setInstr] = useState("");
  const [locks, setLocks] = useState<string[]>([]);
  // WHAT IS TRUE NOW, not what a pointer still remembers (audit, Sep 17). A
  // script pulled back to the queue keeps its ledger history, so the chip and
  // the buttons ask the approved VERSION whether it is still live.
  const approvedLive = !!s.approvedVersionId && s.versions.some((v) => v.id === s.approvedVersionId && (v.status === "APPROVED" || v.status === "SHARED"));
  const releasedLive = approvedLive && !!s.sharedVersionId && s.releaseState !== "withheld";
  // Oct 20 2026 (audit D5): approving a new version of a released script keeps
  // the client's shared version on their portal, so "released" alone no longer
  // means the approved version is the one they see.
  const sharedNo = s.sharedVersionId ? s.versions.find((v) => v.id === s.sharedVersionId)?.versionNo ?? null : null;
  const approvedNo = s.approvedVersionId ? s.versions.find((v) => v.id === s.approvedVersionId)?.versionNo ?? null : null;
  const state = s.historical ? "historical"
    : releasedLive ? (s.sharedVersionId === s.approvedVersionId ? (cur && cur.id !== s.approvedVersionId ? "new draft since it was sent" : "released to the portal") : `approved · client still sees${sharedNo ? ` v${sharedNo}` : " the earlier version"}`)
    : approvedLive ? (cur && cur.id !== s.approvedVersionId ? "new draft since approval" : "approved · not released") : "needs your OK";
  // What the client has on their portal right now (audit D6: taking it off says so and takes a reason).
  const onPortal = !!s.sharedVersionId && s.releaseState === "released";
  const canApprove = !!cur && !cur.id.startsWith("legacy:") && (!approvedLive || cur.id !== s.approvedVersionId);
  const canSendApproved = approvedLive && s.sharedVersionId !== s.approvedVersionId;
  const [override, setOverride] = useState<{ message: string; send: boolean } | null>(null);
  const [overrideWhy, setOverrideWhy] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullWhy, setPullWhy] = useState("");
  // Oct 23 2026: Send Question Request, for a draft the client has never seen
  // (never shared or released, no verdict of theirs, not filmed). The server
  // asks the same questions again and refuses in words (questionRequestRefusal).
  const [asking, setAsking] = useState<"idle" | "confirm" | "sending">("idle");
  const approve = (send: boolean) => {
    if (!cur) return;
    setOverride(null);
    setSaid(null);
    run(() => (send ? approveAndSendScriptAction(cur.id) : approveScriptVersionAction(cur.id)), (r) => {
      // An overridable format finding asks for a written reason; every other refusal is said as it is.
      if (!r.ok && /^Format check:/.test(r.message)) setOverride({ message: r.message, send });
      else setSaid(r);
    });
  };
  // Audit, Oct 23 2026: every share stamp the server reads, so a script once on the portal never offers it.
  const canAsk = !!onAsk && !s.historical && !s.bulkBank && !!s.monthKey && !!cur && !cur.id.startsWith("legacy:") && !s.sharedVersionId && !s.sharedAt && !s.versions.some((v) => !!v.sharedAt || v.status === "SHARED") && s.releaseState !== "released" && !s.clientVerdict && !s.filmed;
  const ask = () => {
    if (!onAsk) return;
    setAsking("sending");
    setSaid(null);
    void onAsk(s.id).then((r) => { setAsking("idle"); if (!r.ok) setSaid(r); });
  };
  const tone = s.historical ? "bg-surface-2 text-muted" : state.startsWith("needs") || state.startsWith("new draft") || state.startsWith("approved · client") ? "bg-brand-soft text-brand" : "bg-success-soft text-success";
  // Oct 12: an AI revision of THIS script in the queue (the rest stay usable).
  const revBusy = !!rev && (rev.server?.state === "queued" || rev.server?.state === "running" || (rev.sending && rev.server?.state !== "failed"));
  const revFailed = !!rev && !revBusy && rev.server?.state === "failed" ? rev.server : null;
  // What the busy chip says: the queued job's own label, else the press just made (before the server's answer is drawn).
  const busyLabel = rev?.server && (rev.server.state === "queued" || rev.server.state === "running") ? rev.server.label ?? null : rev?.sendingLabel ?? null;
  // THE CLIENT'S OWN VERDICT (F09): our approval and their willingness to say
  // these words on camera are different facts. Neutral tones (Oct 23 2026).
  const verdict =
    s.clientVerdict === "APPROVED" ? { label: "client signed off", cls: "bg-success-soft text-success" }
    : s.clientVerdict === "CHANGES_REQUESTED" ? { label: "client asked for changes", cls: "bg-brand-soft text-brand" }
    : s.clientVerdict === "STALE" && !s.filmed ? { label: "rewritten since they approved", cls: "bg-surface-2 text-muted" }
    // Oct 22 2026: filmed before they answered. The client is not asked any more.
    // Oct 22 2026 (audit M5): never on a bulk plan's bank, which the client is not asked to approve.
    : releasedLive && !s.filmed && !s.bulkBank ? { label: "client hasn't answered yet", cls: "bg-surface-2 text-muted" }
    : null;
  // Filmed and never signed off by the client: its own chip, so nobody chases it.
  const filmedChip = s.filmed && s.clientVerdict !== "APPROVED" && !s.historical
    ? { label: `filmed${s.filmed.atISO ? ` ${new Date(s.filmed.atISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}`, title: "Filmed. The client never approved it in the portal, and nothing asks them to now." }
    : null;
  // "Shorten with AI" (in More): the one-press length trim the card used to
  // show as "A bit long: needs a fix" / "Tighten". Never on a skit or history.
  const words = cur?.spokenWordCount ?? null;
  const band = words != null ? lengthBand(words) : null;
  const shorten = !s.historical && !!rev && !!cur && !cur.skit
    ? band === "over" || (band === "long" && !!cur.writer) ? { kind: "trim" as const }
    : (cur.estimatedSeconds ?? 0) > WARN_HI ? { kind: "tighten" as const } : null
    : null;
  const onShorten = () => {
    if (!shorten || !rev || !cur) return;
    if (shorten.kind === "trim") rev.onRevise("revise", trimInstruction(words ?? 0, (cur.writer?.brief.mustKeep ?? []).map((m) => m.text)));
    else rev.onRevise("tighten");
  };
  const formatNote = cur?.format && s.topicFormat && s.topicFormat !== cur.format && !s.historical
    ? `The topic is now ${VIDEO_FORMAT_LABEL[s.topicFormat]}; this version was written as ${VIDEO_FORMAT_LABEL[cur.format]}. "Ask AI to revise" rewrites it; nothing changes on its own.`
    : null;
  return (
    <details className="group px-5 py-3" open={open} data-script-card={s.id}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 marker:content-none">
        <FileText className="size-3.5 shrink-0 text-muted-2" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{s.title}</span>
        {cur?.format && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cur.format === "SKIT" ? "bg-brand-soft text-brand" : "bg-surface-2 text-muted"}`}>{VIDEO_FORMAT_LABEL[cur.format]}</span>}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{state}</span>
        {verdict && <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${verdict.cls}`} title={s.clientVerdictAt ? `on ${fmt(s.clientVerdictAt)}` : undefined}>{verdict.label}</span>}
        {filmedChip && <span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success" title={filmedChip.title}>{filmedChip.label}</span>}
        {revBusy && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand"><Loader2 className="size-3 animate-spin" />{busyLabel === "tighten" ? "shortening…" : busyLabel === "redraft" ? "redrafting…" : busyLabel === "rewrite" ? "writing again…" : "revising…"}</span>}
      </summary>
      <div className="mt-2">
        {revBusy && <p className="mb-1.5 text-[12px] text-muted"><Loader2 className="mr-1 inline size-3 animate-spin" />{busyLabel === "tighten" ? "Shortening" : busyLabel === "redraft" ? "Drafting again from the answers" : busyLabel === "rewrite" ? "Writing it again from the topic" : "Revising"} in the background. The new version appears here when it&rsquo;s ready; this one is kept.</p>}
        {revFailed && (
          <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            {revFailed.label === "rewrite" ? "The fresh draft" : "The AI revision"} didn&rsquo;t finish ({revFailed.error}).
            <button onClick={rev?.onRetry} className={quiet}>Try again</button>
          </p>
        )}
        {mode === "edit" ? (
          <div className="mt-2">
            <p className="mb-1 text-[11px] text-muted">Saving keeps v{base?.versionNo ?? cur?.versionNo} and adds your edit as a new version.</p>
            {moved && (
              <p className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[12px] text-muted">
                A newer version (v{cur?.versionNo}) arrived while you were editing v{base?.versionNo}, so saving this one is refused. Copy what you changed, then:
                <button onClick={startEdit} className={quiet}>Start over from v{cur?.versionNo}</button>
              </p>
            )}
            <AutoTextarea aria-label="The script" value={body} onChange={(e) => setBody(e.target.value)} minRows={8} className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-base leading-relaxed sm:text-xs" />
            <label className="mt-1.5 block text-[11px] font-medium text-muted">Filming notes <span className="font-normal text-muted-2">(staff and the shoot only, never the client)</span></label>
            <AutoTextarea value={notes} onChange={(e) => setNotes(e.target.value)} minRows={2} className="mt-0.5 w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-base leading-relaxed sm:text-xs" />
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={busy} onClick={() => run(() => saveScriptText(s.id, body, { baseVersionId: baseId, filmingNotes: notes }), (r) => { setSaid(r); if (r.ok) setMode("read"); })} className={`${btn} min-h-9 bg-brand-action text-white`}>Save</button>
              <button onClick={() => setMode("read")} className={`${quiet} min-h-9`}>Cancel</button>
            </div>
          </div>
        ) : cur ? (
          <>
            <ScriptView body={cur.body} size="sm" audience="staff" pillarName={s.pillarName} fileTitle={s.title} />
            {cur.filmingNotes && <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-muted"><span className="font-semibold">Filming notes:</span> <NotesText text={cur.filmingNotes} /></p>}
          </>
        ) : null}
        {mode === "revise" && (
          <div className="mt-2">
            <AutoTextarea value={instr} onChange={(e) => setInstr(e.target.value)} minRows={2} placeholder="Tell the AI what to change. The current version is kept as is." className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-base sm:text-xs" />
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
              <button disabled={revBusy || !instr.trim()} onClick={() => { rev?.onRevise("revise", instr, locks); setInstr(""); setLocks([]); setMode("read"); }} className={`${btn} inline-flex min-h-9 items-center gap-1 bg-brand-action text-white`}><Sparkles className="size-3" /> Write a new version</button>
              <button onClick={() => setMode("read")} className={`${quiet} min-h-9`}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "read" && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5" data-card-actions>
            {/* Oct 23 2026: TWO ACTIONS UP FRONT. Approve and send = one press:
                approve this exact version and share it to the client's portal
                (scriptShare.shareApprovedScript, the same release ledger and
                checks). Nothing sends a script on its own (script_auto_share
                stays locked). */}
            {!s.historical && canApprove && cur && <button disabled={busy} onClick={() => approve(true)} className={`${btn} min-h-9 bg-brand-action text-white`}><Send className="mr-1 inline size-3" />Approve and send</button>}
            {!s.historical && !canApprove && canSendApproved && <button disabled={busy} onClick={() => { setSaid(null); run(() => releaseScriptAction(s.id), setSaid); }} className={`${btn} min-h-9 bg-brand-action text-white`}><Send className="mr-1 inline size-3" />Send v{approvedNo ?? ""} to the client</button>}
            {!s.historical && cur && <button onClick={startEdit} className={`${quiet} min-h-9`}><PenLine className="mr-1 inline size-3" />Edit</button>}
            {canAsk && <button disabled={busy || revBusy || asking !== "idle"} onClick={() => { setSaid(null); setAsking("confirm"); }} className={`${quiet} min-h-9`} data-question-request><MessageSquareText className="mr-1 inline size-3" />Send Question Request</button>}
            {/* Oct 23 2026: placed against the screen when it opens (useDetailsMenu), so the card's clipped edge never cuts it off. */}
            <details {...menu.detailsProps} className="relative" data-more-menu>
              <summary {...menu.summaryProps} className={`${quiet} inline-flex min-h-9 cursor-pointer list-none items-center gap-1 marker:content-none [&::-webkit-details-marker]:hidden`}>More <ChevronDown className="size-3" /></summary>
              <div {...menu.panelProps} className="absolute left-0 z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-1 shadow-lg">
                {!s.historical && canApprove && cur && <button disabled={busy} onClick={() => { closeMenu(); approve(false); }} className={menuItem}><Check className="size-3" />Approve only (send later)</button>}
                {!s.historical && canApprove && canSendApproved && <button disabled={busy} onClick={() => { closeMenu(); setSaid(null); run(() => releaseScriptAction(s.id), setSaid); }} className={menuItem}><Send className="size-3" />Send the approved v{approvedNo ?? ""} to the client</button>}
                {!s.historical && <button disabled={revBusy} onClick={() => { closeMenu(); setMode("revise"); }} className={menuItem}><Sparkles className="size-3" />Ask AI to revise</button>}
                {/* Oct 23 2026: a fresh draft of the topic by the writer, as the next version. Greyed, with the reason, where it is refused. */}
                {!s.historical && rev && <button disabled={revBusy || !!s.rewrite} onClick={() => { closeMenu(); setSaid(null); rev.onRewrite(); }} aria-describedby={s.rewrite ? `rewrite-why-${s.id}` : undefined} className={menuItem} data-rewrite><RefreshCw className="size-3" />Write it again</button>}
                {!s.historical && rev && s.rewrite && <p id={`rewrite-why-${s.id}`} className="px-2.5 pb-1.5 text-[11px] leading-snug text-muted" data-rewrite-why>{s.rewrite}</p>}
                {shorten && <button disabled={revBusy} onClick={() => { closeMenu(); onShorten(); }} className={menuItem}><Sparkles className="size-3" />Shorten with AI</button>}
                {s.versions.length > 1 && <button onClick={() => { closeMenu(); setShowVersions(!showVersions); }} className={menuItem}><History className="size-3" />{showVersions ? "Hide" : "Show"} version history ({s.versions.length})</button>}
                {/* Oct 20 2026 (audit D6): taking a script off the client's portal says so and takes a reason. */}
                {!s.historical && (onPortal
                  ? <button disabled={busy} onClick={() => { closeMenu(); setPullWhy(""); setPulling(true); }} className={menuItem}><RotateCcw className="size-3" />Pull back from the client&rsquo;s portal</button>
                  : (s.approvedVersionId || s.sharedVersionId) && <button disabled={busy} onClick={() => { closeMenu(); setSaid(null); run(() => returnScriptAction(s.id, ""), setSaid); }} className={menuItem}><RotateCcw className="size-3" />Back to the queue</button>)}
                {s.historical && s.versions.length <= 1 && <p className="px-2.5 py-1.5 text-xs text-muted">Imported history: nothing to change.</p>}
              </div>
            </details>
          </div>
        )}
        {mode === "read" && asking !== "idle" && (
          <div className="mt-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-2 text-[12px]" data-question-confirm>
            <p className="text-muted">Withdraw this draft and email the client a few questions about this topic? The draft stays in its history, and Undo puts it back.</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button disabled={asking === "sending"} onClick={ask} className={`${btn} min-h-9 bg-brand-action text-white`}>
                {asking === "sending" ? <><Loader2 className="mr-1 inline size-3 animate-spin" />Writing the questions…</> : <><Send className="mr-1 inline size-3" />Send the questions</>}
              </button>
              <button disabled={asking === "sending"} onClick={() => setAsking("idle")} className={`${quiet} min-h-9`}>Keep the draft</button>
            </div>
          </div>
        )}
        {said && mode === "read" && <p role="status" className="mt-1.5 text-[12px] text-muted">{said.message}</p>}
        {mode === "read" && override && cur && (
          // An overridable format finding (a missing pillar link and the like):
          // the approver may pass it with a written reason, recorded on the
          // ledger. A "House script format:" failure never reaches here (audit
          // finding 6, Sep 17): it is said as a plain refusal instead.
          <div className="mt-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-2 text-[12px]">
            <p className="text-muted">{override.message}</p>
            <label className="mt-1.5 block font-medium text-muted" htmlFor={`why-${s.id}`}>Approve anyway? Say why (this is recorded)</label>
            <AutoTextarea id={`why-${s.id}`} value={overrideWhy} onChange={(e) => setOverrideWhy(e.target.value)} minRows={2} className="mt-0.5 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base sm:text-xs" />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button disabled={busy || !overrideWhy.trim()} onClick={() => { const send = override.send, why = overrideWhy.trim(); run(() => (send ? approveAndSendScriptAction(cur.id, why) : approveScriptVersionAction(cur.id, why)), (r) => { setSaid(r); if (r.ok) { setOverride(null); setOverrideWhy(""); } }); }} className={`${btn} min-h-9 bg-brand-action text-white`}>{override.send ? "Approve and send anyway" : "Approve anyway"}</button>
              <button onClick={() => { setOverride(null); setOverrideWhy(""); }} className={`${quiet} min-h-9`}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "read" && pulling && onPortal && (
          <div className="mt-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-2 text-[12px]">
            <label className="block font-medium text-muted" htmlFor={`pull-${s.id}`}>Pull &ldquo;{s.title}&rdquo; off the client&rsquo;s portal? It goes back to the review queue. Say why (kept with its history)</label>
            <AutoTextarea id={`pull-${s.id}`} value={pullWhy} onChange={(e) => setPullWhy(e.target.value)} minRows={2} className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base sm:text-xs" />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button disabled={busy || !pullWhy.trim()} onClick={() => run(() => returnScriptAction(s.id, pullWhy.trim()), (r) => { setSaid(r); if (r.ok) setPulling(false); })} className={`${btn} min-h-9 border border-border text-foreground hover:bg-surface-2`}>Pull it back</button>
              <button onClick={() => setPulling(false)} className={`${quiet} min-h-9`}>Keep it on their portal</button>
            </div>
          </div>
        )}
        {showVersions && s.versions.length > 1 && (
          <ul className="mt-2 space-y-0.5 text-[11px] text-muted" data-version-history>
            {s.versions.map((v) => (
              <li key={v.id}>
                v{v.versionNo} · {VERSION_WORD[v.status] ?? v.status.toLowerCase().replace(/_/g, " ")} · {versionHow(v.changeSummary, v.source)}{v.basedOnVersionNo ? ` (from v${v.basedOnVersionNo})` : ""} · {fmt(v.createdAt)}{v.createdBy ? ` by ${v.createdBy}` : ""}{v.approvedAt ? ` · approved by ${v.approvedBy}` : ""}{v.sharedAt ? " · shared" : ""}{v.id === s.sharedVersionId ? " ← what the client sees" : ""}{v.id === cur?.id ? " · current" : ""}
                {v.id !== cur?.id && (
                  <span className="ml-1.5 inline-flex gap-1 align-middle">
                    <button onClick={() => setViewing(viewing === v.id ? null : v.id)} className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-px text-[10px] font-medium hover:bg-surface-2"><Eye className="size-2.5" />{viewing === v.id ? "Hide" : "View"}</button>
                    {/* Oct 14 2026: restore = a copy on top, never a rewind. */}
                    {!s.historical && !v.id.startsWith("legacy:") && (
                      <button disabled={busy || revBusy || mode === "edit"} title={revBusy ? "Wait for the AI revision to finish" : mode === "edit" ? "Finish or cancel the edit first" : undefined}
                        onClick={() => { if (window.confirm(`Restore v${v.versionNo}? Its script and filming notes are copied into a new version on top. Nothing is deleted: you can restore any other version the same way.`)) run(() => restoreScriptVersionAction(s.id, v.id, cur?.id ?? null), (r) => { setSaid(r); if (r.ok) setViewing(null); }); }}
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
        {/* Oct 26 2026: what the agent said about this topic (TopicBriefFold), read and Edit, above the writer's notes. Staff only. */}
        {s.brief && !s.historical && <TopicBriefFold monthId={null} brief={s.brief} clientFirst={clientFirst} variant="card" />}
        {/* Oct 23 2026: the one fold at the very bottom, closed, grey. Staff only: never sent to the portal. */}
        {cur && !s.historical && (
          <WriterNotes
            versionNo={cur.versionNo} how={versionHow(cur.changeSummary, cur.path)} madeAt={fmt(cur.createdAt)} madeBy={cur.createdBy}
            words={cur.spokenWordCount} seconds={cur.estimatedSeconds} skit={!!cur.skit}
            approved={s.approvedAt ? `${fmt(s.approvedAt)}${s.approvedBy ? ` by ${s.approvedBy}` : ""}` : null} released={s.sharedAt ? fmt(s.sharedAt) : null} sourceFile={s.sourceFile}
            answersChanged={!!s.answersChanged} formatNote={formatNote} angle={cur.angle ?? null} writer={cur.writer ?? null} gaps={cur.gaps}
          />
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// A QUESTION REQUEST'S CARD (Oct 23 2026): "Questions sent <date> · waiting on
// <client>", the questions, the email's state, the withdrawn draft one press
// away, Undo (the draft back, no further email) and Resend (a new link).
// ---------------------------------------------------------------------------
const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
function QuestionRequestCard({ q, show }: { q: QuestionRequestUi; show: (kind: "ok" | "err", text: string) => void }) {
  const [busy, start] = useTransition();
  const [said, setSaid] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const act = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    setSaid(null);
    let r: { ok: boolean; message: string };
    try { r = await fn(); } catch { r = { ok: false, message: "Couldn't reach the server. Try again." }; }
    if (r.ok) show("ok", r.message); else setSaid(r.message);
    setConfirmUndo(false);
  });
  const sentOn = fmt(q.email.state === "sent" ? q.email.at : q.createdAt);
  const chip = q.stage === "ANSWERED" ? "Answers in · the new draft is on its way" : `Questions sent ${sentOn} · waiting on ${q.clientFirstName}`;
  const emailLine = q.email.state === "sent" ? `Emailed ${fmt(q.email.at)}${q.email.count > 1 ? ` (${q.email.count} emails so far)` : ""}. Follow-ups go on the usual reminder cadence until they answer.`
    : q.email.state === "queued" ? `The email goes out ${q.email.at ? `${fmtWhen(q.email.at)} ET` : "in office hours"}.`
    : q.email.state === "failed" ? `The email failed (${q.email.note ?? "unknown"}); it retries on its own, or press Resend.`
    : q.email.state === "not_sent" ? `No email went out (${(q.email.note ?? "not sent").replace(/_/g, " ")}). Press Resend once that's sorted.`
    : "No email yet.";
  return (
    <div className="px-5 py-3" data-question-request-card={q.id}>
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquareText className="size-3.5 shrink-0 text-muted-2" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{q.topicTitle}</span>
        <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">{chip}</span>
      </div>
      <p className="mt-1.5 text-[12px] text-muted">{emailLine}{q.answered > 0 && q.stage === "WAITING" ? ` ${q.answered} of ${q.questions.length} answered so far.` : ""}</p>
      <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[12px]">{q.questions.map((t, i) => <li key={i}>{t}</li>)}</ol>
      {viewing && q.withdrawn.body && (
        <div className="mt-2 rounded-lg border border-border bg-surface px-2.5 py-2"><ScriptView body={q.withdrawn.body} size="sm" audience="staff" fileTitle={q.topicTitle} /></div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {q.stage === "WAITING" && <button disabled={busy} onClick={() => act(() => resendQuestionRequestAction(q.id))} className={`${quiet} min-h-9`}><Send className="mr-1 inline size-3" />Resend</button>}
        {!confirmUndo
          ? <button disabled={busy} onClick={() => setConfirmUndo(true)} className={`${quiet} min-h-9`}><RotateCcw className="mr-1 inline size-3" />Undo</button>
          : <>
              <span className="text-[12px] text-muted">Put the draft back and stop the emails?</span>
              <button disabled={busy} onClick={() => act(() => undoQuestionRequestAction(q.id))} className={`${btn} min-h-9 border border-border text-foreground hover:bg-surface-2`}>Undo the request</button>
              <button disabled={busy} onClick={() => setConfirmUndo(false)} className={`${quiet} min-h-9`}>Cancel</button>
            </>}
        {q.withdrawn.body && <button onClick={() => setViewing(!viewing)} className={`${quiet} min-h-9`}><Eye className="mr-1 inline size-3" />{viewing ? "Hide" : "View"} the withdrawn draft{q.withdrawn.versionNo ? ` (v${q.withdrawn.versionNo})` : ""}</button>}
        {busy && <Loader2 className="size-3 animate-spin text-muted" />}
      </div>
      {said && <p role="status" className="mt-1.5 text-[12px] text-muted">{said}</p>}
    </div>
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
