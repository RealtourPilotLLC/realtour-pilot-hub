"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, MessageSquareQuote, Pencil, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalAnswerInterview, portalSubmitInterview } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { PortalInterviewView } from "@/lib/portal";

// ---------------------------------------------------------------------------
// THE GUIDED INTERVIEW (spec §6): one question at a time from the policy's
// plan, skip and "I don't know" always available, save-and-resume by
// construction (every answer is a row; the server picks the next question
// from the rows), direct edit of any earlier answer (a new version — the old
// one stays), and a preview of the draft script when one exists. No AI is
// ever called from here: the draft is made by the team from these answers.
//
// CP-08 (Sep 24 2026): finishing the questions is not the same as having
// enough. Up to two targeted follow-ups appear only for what nothing on file
// covers; answers that still cannot carry a script are sent only as "what I
// have" (nothing is drafted, we follow up) — never with "we'll draft it".
// What they already said on a call is offered beside the question as an
// optional, editable starting point, with where it came from.
// ---------------------------------------------------------------------------

const monthLabel = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return monthKey ? new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long" }) : ""; };

export function InterviewFlow({ iv, backHref, canAct }: { iv: PortalInterviewView; backHref: string; canAct: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** The call line they started from, if any. Only a pointer — the server re-reads the line itself. */
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const activeKey = editKey ?? iv.nextKey;
  const activePrompt = editKey ? iv.answers.find((a) => a.questionKey === editKey)?.questionText ?? "" : iv.next.prompt ?? "";
  const answeredKeys = iv.answers.length;
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    const r = await fn().catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setText(""); setEditKey(null); setSuggestionId(null); router.refresh(); }
  });
  const answer = (kind: "TYPED" | "SKIPPED" | "DONT_KNOW") => activeKey && run(() => portalAnswerInterview(portalAuthFromLocation(), iv.interviewId, activeKey, text, kind, activePrompt, kind === "TYPED" ? suggestionId : null));
  const submit = (acknowledgeGaps = false) => run(() => portalSubmitInterview(portalAuthFromLocation(), iv.interviewId, { acknowledgeGaps }));
  const submitted = iv.status === "SUBMITTED";
  const sentWithGaps = iv.status === "SUBMITTED_WITH_GAPS";
  const callDay = (isoDate: string | null) => (isoDate ? new Date(isoDate).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null);

  return (
    <div className="space-y-4">
      <Link href={backHref} className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><ArrowLeft className="size-3.5" /> All topics</Link>
      <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Preparing {iv.monthKey ? `for ${monthLabel(iv.monthKey)}` : ""}</div>
        <h1 className="mt-1 text-lg font-semibold">{iv.topicTitle}</h1>
        <p className="mt-1 text-xs text-muted">A few short questions in your own words — we turn them into a filmable script. Skip anything; you can come back and change any answer.</p>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-2">
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-semibold">{iv.progress.substantiveAnswered}/{iv.progress.substantiveTotal} answered</span>
          {submitted && <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="size-3" /> sent {iv.submittedAtISO ? new Date(iv.submittedAtISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : ""}</span>}
          {sentWithGaps && <span className="inline-flex items-center gap-1 text-warning"><CheckCircle2 className="size-3" /> sent with gaps {callDay(iv.sentWithGapsAtISO) ?? ""} — we&rsquo;ll follow up</span>}
          {iv.strategyLabel && <span>· strategy version {iv.strategyLabel}</span>}
        </div>
      </div>

      {/* Earlier answers — editable */}
      {iv.answers.length > 0 && (
        <div className="space-y-2">
          {iv.answers.map((a) => (
            <div key={a.questionKey} className={cn("rounded-xl border border-border bg-surface px-3 py-2.5", editKey === a.questionKey && "border-brand")}>
              <div className="text-xs text-muted-2">{a.questionText}</div>
              <div className="mt-0.5 flex items-start gap-2">
                <div className="min-w-0 flex-1 whitespace-pre-wrap text-sm">{a.answerKind === "SKIPPED" ? <em className="text-muted">skipped</em> : a.answerKind === "DONT_KNOW" ? <em className="text-muted">don&rsquo;t know</em> : a.answerText}</div>
                {canAct && <button type="button" onClick={() => { setEditKey(a.questionKey); setText(a.answerText ?? ""); }} aria-label="Edit this answer" className="shrink-0 rounded-md p-1 text-muted-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Pencil className="size-3.5" /></button>}
              </div>
              {a.version > 1 && <div className="text-[10px] text-muted-2">edited · v{a.version} (earlier answers are kept)</div>}
            </div>
          ))}
        </div>
      )}

      {/* The one question */}
      {canAct && activeKey && (
        <div className="panel-shadow rounded-2xl border border-brand/30 bg-surface/80 p-4 backdrop-blur">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-brand">{editKey ? "Change your answer" : iv.nextIsGap ? "One more, so we can write it" : iv.next.isFollowUp ? "One follow-up" : `Question ${Math.min(answeredKeys + 1, iv.progress.substantiveTotal + 1)}`}</div>
          <p className="mt-1 text-base font-medium">{activePrompt}</p>
          {iv.next.isFollowUp && !editKey && <p className="mt-0.5 text-[11px] text-muted-2">{iv.nextIsGap ? "We ask only because nothing we have covers this yet — two at most." : "Asked once, only because something important was missing."}</p>}
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Say it the way you'd say it to a client…" aria-label="Your answer" className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
          {/* WHAT THEY ALREADY SAID ON A CALL — optional and editable, with its
              source. Never pre-filled: they choose to start from it. */}
          {iv.suggestions.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-1 text-[11px] font-semibold text-muted-2"><MessageSquareQuote className="size-3" /> From your planning call — use one as a start if it fits (optional)</div>
              <ul className="mt-1 space-y-1">
                {iv.suggestions.map((sg) => (
                  <li key={sg.id}>
                    <button type="button" onClick={() => { setText(sg.text); setSuggestionId(sg.id); }} className={cn("w-full rounded-lg border px-2.5 py-1.5 text-left text-xs hover:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", suggestionId === sg.id ? "border-brand bg-brand-soft" : "border-border bg-surface")}>
                      <span className="text-foreground">&ldquo;{sg.text}&rdquo;</span>
                      <span className="mt-0.5 block text-[10px] text-muted-2">you said this on your call{callDay(sg.callDateISO) ? ` of ${callDay(sg.callDateISO)}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy || !text.trim()} onClick={() => answer("TYPED")} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {editKey ? "Save new answer" : "Save & next"}</button>
            {!editKey && <button type="button" disabled={busy} onClick={() => answer("SKIPPED")} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Skip</button>}
            {!editKey && <button type="button" disabled={busy} onClick={() => answer("DONT_KNOW")} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">I don&rsquo;t know</button>}
            {editKey && <button type="button" onClick={() => { setEditKey(null); setText(""); }} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>}
          </div>
          <p className="mt-2 text-[11px] text-muted-2">Everything saves as you go — close this and come back any time.</p>
        </div>
      )}

      {/* Done: what's still missing, and send */}
      {iv.next.kind === "done" && !editKey && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          {/* The old copy said "We can draft from this, but a few things are
              missing" over answers that could not carry a script, and sent
              them as if they could. The promise now matches the state. */}
          <p className={cn("text-sm font-medium", iv.ready ? "text-success" : "text-warning")}>{iv.ready ? "That's everything we need to draft this script." : "Not quite enough to write this one yet:"}</p>
          {!iv.ready && iv.gaps.length > 0 && <ul className="mt-1 list-inside list-disc text-xs text-muted">{iv.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>}
          {canAct && !submitted && iv.ready && (
            <button type="button" onClick={() => submit(false)} disabled={busy} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Send className="size-3.5" /> Send my answers</button>
          )}
          {canAct && !iv.ready && iv.canSendWithGaps && (
            <>
              <p className="mt-2 text-xs text-muted">Edit any answer above to fill a gap. Or send what you have: we&rsquo;ll follow up with a question or two, and nothing is drafted until then.</p>
              <button type="button" onClick={() => submit(true)} disabled={busy} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brand/40 px-3 py-2 text-sm font-semibold text-brand hover:bg-brand-soft disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Send className="size-3.5" /> Send what I have — we&rsquo;ll follow up</button>
            </>
          )}
          {/* "We draft from these" only when they CAN carry a script: a row
              sent before the sufficiency check existed may not (review, Sep 24). */}
          {submitted && iv.ready && <p className="mt-2 text-xs text-muted">Sent. We draft the script from these answers; changing an answer now makes a new draft (the earlier one is kept).</p>}
          {submitted && !iv.ready && <p className="mt-2 text-xs text-muted">Sent. We&rsquo;ll be in touch with a question or two before we write it. Add to any answer here and it counts right away.</p>}
          {sentWithGaps && <p className="mt-2 text-xs text-muted">Sent with gaps — we&rsquo;ll be in touch with a question or two. Add to any answer here and it counts right away.</p>}
        </div>
      )}

      {/* WHERE THE SCRIPT STANDS — never the script itself. This panel used to
          print the newest AI draft under the label "A draft for our creative
          review". Jordan, Sep 18: a draft label is not a substitute for
          approval. Nothing here quotes a script; the server no longer sends
          one. The finished script appears under the topic once it is approved
          and released. */}
      {iv.script.stage === "preparing" && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> Your script is being prepared</div>
          <p className="mt-0.5 text-[11px] text-muted-2">
            We&rsquo;re writing it from your answers and our team reviews it before you see it. It appears under this
            topic once it&rsquo;s ready.{iv.script.changedSince ? " You&rsquo;ve changed an answer since we started — we&rsquo;ll use the newest ones." : ""}
          </p>
        </div>
      )}
      {/* "It's under this topic" was a promise nothing kept: the topic row
          printed a version number and the only script renderer in the portal
          needed a ContentVideo, and ContentVideo.topicId was set on 0 of 167
          rows (Sep 18). The topic now renders the script, and this panel takes
          the client to it instead of describing where it is. */}
      {iv.script.stage === "released" && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> Your script is ready</div>
          <p className="mt-0.5 text-[11px] text-muted-2">It&rsquo;s under this topic, with everything you need to film it.</p>
          <Link href={`${backHref}#topic-${iv.topicId}`} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
            Read my script <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}
      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}
