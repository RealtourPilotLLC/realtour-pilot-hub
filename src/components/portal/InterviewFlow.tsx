"use client";

import { useEffect, useState, useTransition } from "react";
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
//
// 6.5 (Sep 25 2026): a topic they already talked through on a call asks only
// what is still missing (mode GAPS_ONLY), and says so. A note from their own
// profile can be a suggestion too, labelled as such — never presented as
// something they said in this questionnaire. And the "sent" line no longer
// promises that changing an answer makes a new draft: nothing redrafts on its
// own; the team sees the change and updates the script before it reaches them.
// ---------------------------------------------------------------------------

const monthLabel = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return monthKey ? new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long" }) : ""; };

export function InterviewFlow({ iv, backHref, canAct }: { iv: PortalInterviewView; backHref: string; canAct: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** The call line they started from, if any. Only a pointer — the server re-reads the line itself. */
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [suggestionChoice, setSuggestionChoice] = useState<string | null>(null);
  const [replacedText, setReplacedText] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<"empty" | "saved" | "failed">("empty");
  const [textKey, setTextKey] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const activeKey = editKey ?? iv.nextKey;
  // A local draft belongs to the exact account, enrollment, month, interview
  // and question. It is never submitted or sent to script generation here.
  const keyFor = (questionKey: string) => `rtp-answer-draft:v2:${iv.clientId}:${iv.enrollmentId}:${iv.monthId}:${iv.interviewId}:${questionKey}`;
  const draftKey = activeKey ? keyFor(activeKey) : null;
  const legacyKey = activeKey ? `rtp-answer-draft:${iv.interviewId}:${iv.monthKey}:${iv.topicId}:${activeKey}` : null;
  // On a question switch, do not show the previous question's unsent words
  // during the render before sessionStorage restores this question's draft.
  const visibleText = draftKey === textKey ? text : "";
  const activePrompt = editKey ? iv.answers.find((a) => a.questionKey === editKey)?.questionText ?? "" : iv.next.prompt ?? "";
  const answeredKeys = iv.answers.length;
  useEffect(() => {
    if (!draftKey || !canAct) return;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      try {
        const stored = window.sessionStorage.getItem(draftKey);
        const older = stored === null && legacyKey ? window.sessionStorage.getItem(legacyKey) : null;
        const saved = stored ?? older;
        if (older !== null && legacyKey) {
          window.sessionStorage.setItem(draftKey, older);
          window.sessionStorage.removeItem(legacyKey);
        }
        setText(saved ?? (editKey ? iv.answers.find((a) => a.questionKey === editKey)?.answerText ?? "" : ""));
        setTextKey(draftKey);
        setDraftState(saved !== null ? "saved" : "empty");
      } catch { setDraftState("failed"); }
    });
    return () => { current = false; };
  }, [draftKey, legacyKey, canAct, editKey, iv.answers]);
  const updateText = (next: string) => {
    setText(next);
    setTextKey(draftKey);
    if (!draftKey) return;
    try {
      window.sessionStorage.setItem(draftKey, next);
      setDraftState(next ? "saved" : "empty");
    } catch { setDraftState("failed"); }
  };
  const retryDraft = () => {
    if (!draftKey) return;
    try {
      const restored = visibleText ? null : window.sessionStorage.getItem(draftKey) ?? (legacyKey ? window.sessionStorage.getItem(legacyKey) : null);
      if (restored !== null) { setText(restored); setTextKey(draftKey); }
      const next = restored ?? visibleText;
      window.sessionStorage.setItem(draftKey, next);
      if (legacyKey && restored !== null) window.sessionStorage.removeItem(legacyKey);
      setDraftState(next ? "saved" : "empty");
    }
    catch { setDraftState("failed"); }
  };
  const run = (fn: () => Promise<{ ok: boolean; message: string }>, onSaved?: () => void) => start(async () => {
    const r = await fn().catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { onSaved?.(); setText(""); setTextKey(null); setEditKey(null); setSuggestionId(null); setSuggestionChoice(null); setReplacedText(null); setDraftState("empty"); router.refresh(); }
  });
  const answer = (kind: "TYPED" | "SKIPPED" | "DONT_KNOW") => activeKey && run(
    () => portalAnswerInterview(portalAuthFromLocation(), iv.interviewId, activeKey, visibleText, kind, activePrompt, kind === "TYPED" ? suggestionId : null),
    () => { if (draftKey) { try { window.sessionStorage.removeItem(draftKey); } catch { /* local storage may be unavailable */ } } },
  );
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
        <p className="mt-1 text-xs text-muted">
          {iv.mode === "GAPS_ONLY"
            ? "We covered most of this on your call. These are only the pieces we still need, in your own words. Skip anything; you can come back and change any answer."
            : "A few quick questions in your own words. We turn them into a filmable script. Skip anything; you can come back and change any answer."}
        </p>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-2">
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-semibold">{iv.mode === "GAPS_ONLY" ? `${iv.progress.substantiveAnswered} answered` : `${iv.progress.substantiveAnswered}/${iv.progress.substantiveTotal} answered`}</span>
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
                {canAct && <button type="button" onClick={() => { setEditKey(a.questionKey); setText(a.answerText ?? ""); setTextKey(keyFor(a.questionKey)); setSuggestionChoice(null); setReplacedText(null); }} aria-label="Edit this answer" className="shrink-0 rounded-md p-1 text-muted-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Pencil className="size-3.5" /></button>}
              </div>
              {a.version > 1 && <div className="text-[10px] text-muted-2">edited · v{a.version} (earlier answers are kept)</div>}
            </div>
          ))}
        </div>
      )}

      {/* The one question */}
      {canAct && activeKey && (
        <div className="panel-shadow rounded-2xl border border-brand/30 bg-surface/80 p-4 backdrop-blur">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-brand">{editKey ? "Change your answer" : iv.nextIsGap || iv.mode === "GAPS_ONLY" ? "One more, so we can write it" : iv.next.isFollowUp ? "One follow-up" : `Question ${Math.min(answeredKeys + 1, iv.progress.substantiveTotal + 1)}`}</div>
          <p className="mt-1 text-base font-medium">{activePrompt}</p>
          {iv.next.isFollowUp && !editKey && <p className="mt-0.5 text-[11px] text-muted-2">{iv.nextIsGap ? "We ask only because nothing we have covers this yet — two at most." : "Asked once, only because something important was missing."}</p>}
          <textarea autoFocus value={visibleText} onChange={(e) => { updateText(e.target.value); setSuggestionId(null); setReplacedText(null); }} rows={4} placeholder="Say it the way you'd say it to a client…" aria-label="Your answer" className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand" />
          <p role="status" className={cn("mt-1 text-xs", draftState === "failed" ? "text-danger" : "text-muted")}>
            {draftState === "saved" ? `Draft kept in this tab through a refresh. Use ${editKey ? "Save new answer" : "Save & next"} to send it to the team.` : draftState === "failed" ? `This tab couldn't access your draft. Try again; ${editKey ? "Save new answer" : "Save & next"} sends the words currently shown to the team.` : editKey ? "These are your saved words. Use Save new answer to send a change." : "This answer has not been sent yet."}
          </p>
          {draftState === "failed" && <button type="button" onClick={retryDraft} className="min-h-11 text-sm font-semibold text-brand underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Try draft storage again</button>}
          {/* WHAT THEY ALREADY SAID ON A CALL — optional and editable, with its
              source. Never pre-filled: they choose to start from it. */}
          {iv.suggestions.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-1 text-[11px] font-semibold text-muted-2"><MessageSquareQuote className="size-3" /> {iv.suggestions.every((sg) => sg.from === "profile") ? "From your profile notes" : iv.suggestions.some((sg) => sg.from === "profile") ? "From your call and your profile notes" : "From your planning call"}: use one as a start if it fits (optional)</div>
              <ul className="mt-1 space-y-1">
                {iv.suggestions.map((sg) => (
                  <li key={sg.id}>
                    <button type="button" onClick={() => {
                      if (visibleText.trim()) setSuggestionChoice(sg.id);
                      else { updateText(sg.text); setSuggestionId(sg.id); setSuggestionChoice(null); }
                    }} className={cn("w-full rounded-lg border px-2.5 py-1.5 text-left text-xs hover:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", suggestionId === sg.id ? "border-brand bg-brand-soft" : "border-border bg-surface")}>
                      <span className="text-foreground">&ldquo;{sg.text}&rdquo;</span>
                      <span className="mt-0.5 block text-[10px] text-muted-2">
                        {sg.from === "profile"
                          ? `a suggestion from your profile notes${callDay(sg.callDateISO) ? `, ${callDay(sg.callDateISO)}` : ""}`
                          : `you said this on your call${callDay(sg.callDateISO) ? ` of ${callDay(sg.callDateISO)}` : ""}`}
                      </span>
                    </button>
                    {suggestionChoice === sg.id && <div className="mt-1 flex flex-wrap gap-2 rounded-lg border border-border bg-surface-2 p-2 text-xs">
                      <span className="w-full">Keep your draft and add this suggestion, or replace it. You can undo a replacement.</span>
                      <button type="button" className="min-h-11 rounded-lg border border-border bg-surface px-3 font-semibold" onClick={() => { updateText(`${visibleText.trimEnd()}\n\n${sg.text}`); setSuggestionId(null); setSuggestionChoice(null); }}>Add to answer</button>
                      <button type="button" className="min-h-11 rounded-lg border border-border bg-surface px-3 font-semibold" onClick={() => { setReplacedText(visibleText); updateText(sg.text); setSuggestionId(sg.id); setSuggestionChoice(null); }}>Replace draft</button>
                      <button type="button" className="min-h-11 px-3 text-muted" onClick={() => setSuggestionChoice(null)}>Cancel</button>
                    </div>}
                  </li>
                ))}
              </ul>
              {replacedText !== null && <button type="button" onClick={() => { updateText(replacedText); setReplacedText(null); setSuggestionId(null); }} className="mt-2 text-xs font-semibold text-brand underline">Undo replacement</button>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy || !visibleText.trim()} onClick={() => answer("TYPED")} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {editKey ? "Save new answer" : "Save & next"}</button>
            {!editKey && <button type="button" disabled={busy} onClick={() => answer("SKIPPED")} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Skip</button>}
            {!editKey && <button type="button" disabled={busy} onClick={() => answer("DONT_KNOW")} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">I don&rsquo;t know</button>}
            {editKey && <button type="button" onClick={() => { setEditKey(null); setText(""); setTextKey(null); }} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>}
          </div>
          <p className="mt-2 text-xs text-muted">Only {editKey ? "Save new answer" : "Save & next"} records your answer for the team. The draft survives a refresh in this tab, but may be lost when the tab closes. It does not start script writing or the filming preparation clock.</p>
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
          {/* 6.5: nothing redrafts on its own after a script exists, so the old
              "changing an answer now makes a new draft" was a promise nothing
              kept. The team sees the change (a staff badge) and updates it. */}
          {/* …and once the script is RELEASED "before it reaches you" is false:
              it has. The client's way to change it is on the script itself
              (6.5: decisions attach to the exact released version). */}
          {submitted && iv.ready && iv.script.stage !== "released" && <p className="mt-2 text-xs text-muted">Sent. We write the script from these answers. If you change an answer, we&rsquo;ll see it and update the script before it reaches you.</p>}
          {submitted && iv.ready && iv.script.stage === "released" && <p className="mt-2 text-xs text-muted">Sent. Your script is written from these answers. Changing an answer here won&rsquo;t change it: to change the script, choose Request changes on it.</p>}
          {submitted && !iv.ready && <p className="mt-2 text-xs text-muted">Sent. We&rsquo;ll be in touch with a question or two before we write it. Add to any answer here and it counts right away.</p>}
          {sentWithGaps && <p className="mt-2 text-xs text-muted">Sent with gaps — we&rsquo;ll be in touch with a question or two. Add to any answer here and it counts right away.</p>}
          {/* A18: sending the answers is what opens filming on this route, so
              the next step is right here — the month's "Book filming" step
              (it opens once every topic in the session has its answers in). */}
          {submitted && iv.ready && canAct && (
            <Link href={`${backHref}#step-filming`} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
              Next: book your filming <ArrowRight className="size-3" />
            </Link>
          )}
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
            topic once it&rsquo;s ready.{iv.script.changedSince ? " You’ve changed an answer since we started. We’ll see the change before your script reaches you." : ""}
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
