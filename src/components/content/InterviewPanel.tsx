"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageSquare, Sparkles } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { answerInterview, draftScriptFromInterview } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// The guided topic interview (spec §6): one concise question at a time, skip
// and "I don't know" always available, every answer a new version (the
// earlier one stays), and a draft that carries the gaps instead of filling
// them. The state comes from the server (contentInterview.interviewState) —
// this panel only asks and records.
// ---------------------------------------------------------------------------

export type InterviewUi = {
  interviewId: string; topicId: string; topicTitle: string; status: string; answeredCount: number; nextKey: string | null;
  next: { kind: "question" | "follow-up" | "done"; prompt?: string; label?: string; condition?: string; substantive?: boolean };
  sufficiency: { ready: boolean; substantiveAnswered: number; substantiveTotal: number; gaps: { kind: string; field: string | null; text: string; question: string | null }[] };
  answers: { questionKey: string; questionText: string; answerText: string | null; answerKind: string; version: number }[];
  answersChangedSinceDraft: boolean; hasDraft: boolean;
};

const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";

export function InterviewPanel({ iv }: { iv: InterviewUi }) {
  const [text, setText] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setNote(r.message); if (r.ok) { setText(""); setEditKey(null); } });
  const activeKey = editKey ?? iv.nextKey;
  const activePrompt = editKey ? iv.answers.find((a) => a.questionKey === editKey)?.questionText ?? "" : iv.next.prompt ?? "";

  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <MessageSquare className="size-3.5" />
        <span className="font-medium text-foreground">Written answers · {iv.topicTitle}</span>
        <span>{iv.sufficiency.substantiveAnswered}/{iv.sufficiency.substantiveTotal} substantive answers · {iv.status.toLowerCase().replace("_", " ")}</span>
      </div>
      {iv.answers.length > 0 && (
        <div className="mt-2 space-y-1">
          {iv.answers.filter((a) => !a.questionKey.includes(":fu:") || a.answerText).map((a) => (
            <div key={a.questionKey} className="rounded-lg bg-surface px-2.5 py-1.5 text-[12px]">
              <div className="text-muted-2">{a.questionText}</div>
              <div className="flex items-start gap-2">
                <div className="flex-1 whitespace-pre-wrap">{a.answerKind === "SKIPPED" ? <em className="text-muted">skipped</em> : a.answerKind === "DONT_KNOW" ? <em className="text-muted">don&rsquo;t know</em> : a.answerText}</div>
                <span className="text-[10px] text-muted-2">v{a.version}</span>
                <button onClick={() => { setEditKey(a.questionKey); setText(a.answerText ?? ""); }} className="text-[11px] text-muted hover:underline">edit</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {activeKey && (
        <div className="mt-2">
          <p className="text-sm font-medium">{activePrompt}</p>
          {iv.next.kind === "follow-up" && !editKey && <p className="text-[11px] text-muted-2">a follow-up — asked once, only because something important is missing</p>}
          <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} placeholder="In the client's own words…" className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-xs" />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button disabled={busy || !text.trim()} onClick={() => run(() => answerInterview(iv.interviewId, activeKey, text, "TYPED", activePrompt))} className={`${btn} bg-brand text-white`}>{busy ? <Loader2 className="inline size-3 animate-spin" /> : editKey ? "Save new answer" : "Save answer"}</button>
            {!editKey && <button disabled={busy} onClick={() => run(() => answerInterview(iv.interviewId, activeKey, "", "SKIPPED", activePrompt))} className={quiet}>Skip</button>}
            {!editKey && <button disabled={busy} onClick={() => run(() => answerInterview(iv.interviewId, activeKey, "", "DONT_KNOW", activePrompt))} className={quiet}>Don&rsquo;t know</button>}
            {editKey && <button onClick={() => { setEditKey(null); setText(""); }} className={quiet}>Cancel</button>}
          </div>
        </div>
      )}
      {iv.next.kind === "done" && !editKey && (
        <div className="mt-2 text-[12px]">
          <p className={iv.sufficiency.ready ? "text-success" : "text-warning"}>{iv.sufficiency.ready ? "Enough to draft a script." : "A draft can be made, but it will carry gaps:"}</p>
          {iv.sufficiency.gaps.length > 0 && <ul className="mt-1 list-inside list-disc text-muted">{iv.sufficiency.gaps.map((g, i) => <li key={i}>{g.text}{g.question ? ` — ${g.question}` : ""}</li>)}</ul>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(iv.next.kind === "done" || iv.answers.length >= 3) && (
          <button disabled={busy} onClick={() => run(() => draftScriptFromInterview(iv.interviewId))} className={`${btn} inline-flex items-center gap-1 bg-brand text-white`}>
            <Sparkles className="size-3" /> {iv.hasDraft ? (iv.answersChangedSinceDraft ? "New draft from the changed answers" : "Draft again (new version)") : "Draft the script from these answers"}
          </button>
        )}
        {iv.hasDraft && !iv.answersChangedSinceDraft && <span className="text-[11px] text-muted-2">a draft exists for these answers — see Scripts</span>}
      </div>
      {note && <p className="mt-1.5 text-[11px] text-muted">{note}</p>}
    </div>
  );
}
