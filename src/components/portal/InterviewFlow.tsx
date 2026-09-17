"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Loader2, Pencil, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalAnswerInterview, portalSubmitInterview } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { ScriptBody } from "@/components/portal/ScriptBody";
import type { PortalInterviewView } from "@/lib/portal";

// ---------------------------------------------------------------------------
// THE GUIDED INTERVIEW (spec §6): one question at a time from the policy's
// plan, skip and "I don't know" always available, save-and-resume by
// construction (every answer is a row; the server picks the next question
// from the rows), direct edit of any earlier answer (a new version — the old
// one stays), and a preview of the draft script when one exists. No AI is
// ever called from here: the draft is made by the team from these answers.
// ---------------------------------------------------------------------------

const monthLabel = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return monthKey ? new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long" }) : ""; };

export function InterviewFlow({ iv, backHref, canAct }: { iv: PortalInterviewView; backHref: string; canAct: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const activeKey = editKey ?? iv.nextKey;
  const activePrompt = editKey ? iv.answers.find((a) => a.questionKey === editKey)?.questionText ?? "" : iv.next.prompt ?? "";
  const answeredKeys = iv.answers.length;
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    const r = await fn().catch(() => ({ ok: false, message: "That didn't save — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setText(""); setEditKey(null); router.refresh(); }
  });
  const answer = (kind: "TYPED" | "SKIPPED" | "DONT_KNOW") => activeKey && run(() => portalAnswerInterview(portalAuthFromLocation(), iv.interviewId, activeKey, text, kind, activePrompt));
  const submit = () => run(() => portalSubmitInterview(portalAuthFromLocation(), iv.interviewId));
  const submitted = iv.status === "SUBMITTED";

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
          <div className="text-[11px] font-semibold uppercase tracking-widest text-brand">{editKey ? "Change your answer" : iv.next.isFollowUp ? "One follow-up" : `Question ${Math.min(answeredKeys + 1, iv.progress.substantiveTotal + 1)}`}</div>
          <p className="mt-1 text-base font-medium">{activePrompt}</p>
          {iv.next.isFollowUp && !editKey && <p className="mt-0.5 text-[11px] text-muted-2">Asked once, only because something important was missing.</p>}
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Say it the way you'd say it to a client…" aria-label="Your answer" className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
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
          <p className={cn("text-sm font-medium", iv.ready ? "text-success" : "text-warning")}>{iv.ready ? "That's everything we need to draft this script." : "We can draft from this, but a few things are missing:"}</p>
          {iv.gaps.length > 0 && <ul className="mt-1 list-inside list-disc text-xs text-muted">{iv.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>}
          {canAct && !submitted && (
            <button type="button" onClick={submit} disabled={busy} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Send className="size-3.5" /> Send my answers</button>
          )}
          {submitted && <p className="mt-2 text-xs text-muted">Sent. We draft the script from these answers; changing an answer now makes a new draft (the earlier one is kept).</p>}
        </div>
      )}

      {/* Draft preview */}
      {iv.draft && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> Draft script from your answers <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">{iv.draft.versionLabel}{iv.draft.strategyLabel ? ` · strategy ${iv.draft.strategyLabel}` : ""}</span></div>
          <p className="mt-0.5 text-[11px] text-muted-2">A draft for our creative review before it&rsquo;s final — the finished script will appear under this topic.{iv.draft.changedSince ? " You changed answers since this draft; the next draft will use them." : ""}</p>
          <ScriptBody body={iv.draft.body} />
          {iv.draft.gaps.length > 0 && (
            <div className="mt-2 rounded-lg border border-warning/30 bg-warning-soft/30 p-2.5 text-xs">
              <div className="font-semibold text-warning">Left open on purpose — we won&rsquo;t invent these:</div>
              <ul className="mt-1 list-inside list-disc text-muted">{iv.draft.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}
