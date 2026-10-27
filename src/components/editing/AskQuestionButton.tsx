"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HelpCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { askEditQuestionAction } from "@/app/edit/[id]/brief.actions";
import type { QuestionTarget } from "@/lib/editorQuestionsCore";

// ---------------------------------------------------------------------------
// A SMALL "ASK A QUESTION" ON THE BRIEF (Jordan, Oct 27 2026: "a little, like
// button here ... ask a question button, like small here"). One per revision
// note, one per client request, one beside What to make. A press opens a box
// for the question; Send texts the creative manager and whoever left the note
// when they are on our team (never a client), and posts it in the team
// messages. Shaped like the shoot screen's AskOnJob, whose recipients are
// fixed to Kyle or Jordan and whose action editors cannot use.
// ---------------------------------------------------------------------------

const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-60";

export function AskQuestionButton({ projectId, target, who, readOnly = false, className }: {
  projectId: string;
  target: QuestionTarget;
  /** who will be texted, in words ("James and the reviewer who left it") */
  who: string;
  readOnly?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  if (readOnly) return null;
  const tag = target.kind === "make" ? "make" : `${target.kind}:${target.id}`;
  if (!open) {
    return (
      <span className={cn("inline-flex flex-col", className)}>
        <button
          type="button"
          data-ask-question={tag}
          onClick={() => { setOpen(true); setMsg(null); }}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-brand hover:bg-brand-soft/40 hover:underline focus-visible:outline-2 focus-visible:outline-brand"
        >
          <HelpCircle aria-hidden className="size-3.5" /> Ask a question
        </button>
        {msg?.ok && <span role="status" className="px-2 text-[12px] font-medium text-success">{msg.message}</span>}
      </span>
    );
  }
  return (
    <form
      data-ask-question-form={tag}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await askEditQuestionAction(projectId, target, words).catch(() => ({ ok: false, message: "That didn't send. Try again." }));
          setMsg(r);
          if (r.ok) { setWords(""); setOpen(false); router.refresh(); }
        });
      }}
      className={cn("mt-1 w-full basis-full space-y-2 rounded-xl border border-border bg-surface p-3", className)}
    >
      <textarea
        value={words}
        onChange={(e) => setWords(e.target.value)}
        rows={2}
        maxLength={1000}
        aria-label="Your question"
        placeholder="What do you need to know?"
        className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm"
      />
      <p className="text-[12px] text-muted">Texted to {who}, and posted in the team messages.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || words.trim().length < 3} className={`${BTN} bg-brand-action text-brand-fg hover:brightness-95`}>
          {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}Send
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} className={`${BTN} border border-border-strong font-medium hover:bg-surface-2`}>Cancel</button>
      </div>
      {msg && !msg.ok && <p role="alert" className="text-sm text-danger">{msg.message}</p>}
    </form>
  );
}
