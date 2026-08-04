"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { Sparkles, Send, Loader2, Check, MessageSquare, ClipboardList, X } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { Markdown } from "@/components/ui/Markdown";
import { askMyDay, sendSlackToKyle, createTaskForKyle, type DayChatTurn } from "@/app/day/actions";
import type { DayProposal } from "@/lib/dayTools";

// Ask about the day. It reads the real schedule and the real list, edits Jordan's
// own to-dos directly, and can only ever PROPOSE anything aimed at Kyle — those
// come back as buttons here, because a message should leave on a human's click.

const STARTERS = [
  "What should I work on right now?",
  "Prioritise my list for today",
  "What's at risk this week?",
  "Draft Kyle a message about today's shoots",
];

type Msg = { role: "user" | "assistant"; content: string; proposals?: DayProposal[] };

function SlackProposal({ p }: { p: Extract<DayProposal, { kind: "slack" }> }) {
  const [text, setText] = useState(p.text);
  const [state, setState] = useState<"idle" | "sent" | "dropped">("idle");
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  if (state === "dropped") return null;
  if (state === "sent") {
    return (
      <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
        <Check className="size-4" /> Sent to Kyle on Slack.
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-brand/30 bg-brand/[0.04] p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-brand">
        <MessageSquare className="size-3.5" /> Message for Kyle — not sent yet
      </div>
      {p.why && <p className="mb-1.5 text-xs text-muted">{p.why}</p>}
      <AutoTextarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        minRows={2}
        maxRows={14}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() =>
            start(async () => {
              const r = await sendSlackToKyle(text);
              if (r.ok) setState("sent");
              else setErr(r.error ?? "Didn't send.");
            })
          }
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send to Kyle
        </button>
        <button onClick={() => setState("dropped")} className="text-sm text-muted-2 hover:text-foreground">
          Discard
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

function TaskProposal({ p }: { p: Extract<DayProposal, { kind: "task" }> }) {
  const [title, setTitle] = useState(p.title);
  const [state, setState] = useState<"idle" | "made" | "dropped">("idle");
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  if (state === "dropped") return null;
  if (state === "made") {
    return (
      <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
        <Check className="size-4" /> On Kyle&rsquo;s queue.
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-accent/30 bg-accent/[0.05] p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-accent">
        <ClipboardList className="size-3.5" /> Task for Kyle — not created yet
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
      />
      {p.detail && <p className="mt-1.5 text-xs text-muted">{p.detail}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() =>
            start(async () => {
              const r = await createTaskForKyle({ title, detail: p.detail, dueDate: p.dueDate });
              if (r.ok) setState("made");
              else setErr(r.error ?? "Didn't create.");
            })
          }
          disabled={busy || !title.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Add to Kyle&rsquo;s queue
        </button>
        <button onClick={() => setState("dropped")} className="text-sm text-muted-2 hover:text-foreground">
          Discard
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

export function DayAssistant() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (msgs.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs]);

  const ask = (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setErr(null);
    setQ("");
    const history: DayChatTurn[] = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: "user", content: question }]);
    start(async () => {
      const r = await askMyDay(question, history);
      if (r.error) {
        setErr(r.error);
        return;
      }
      setMsgs((m) => [...m, { role: "assistant", content: r.answer, proposals: r.proposals }]);
    });
  };

  return (
    <div className="rounded-2xl border border-brand/25 bg-brand/[0.03] p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-brand" />
        <h2 className="text-base font-semibold">Ask about your day</h2>
        {msgs.length > 0 && (
          <button onClick={() => { setMsgs([]); setErr(null); }} className="ml-auto text-xs text-muted-2 hover:text-foreground">
            Clear
          </button>
        )}
      </div>

      {msgs.length === 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {STARTERS.map((s) => (
            <button
              key={s}
              onClick={() => ask(s)}
              className="rounded-full border border-border bg-surface px-3 py-1.5 text-sm text-muted transition hover:border-brand hover:text-brand"
            >
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-3 max-h-[28rem] space-y-3 overflow-y-auto pr-1">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white">
                {m.content}
              </div>
            ) : (
              <div key={i} className="max-w-full">
                <div className="rounded-2xl rounded-bl-sm bg-surface px-3.5 py-2.5 text-sm leading-relaxed">
                  <Markdown content={m.content} />
                </div>
                {m.proposals?.map((p, j) =>
                  p.kind === "slack" ? <SlackProposal key={j} p={p} /> : <TaskProposal key={j} p={p} />,
                )}
              </div>
            ),
          )}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted-2">
              <Loader2 className="size-4 animate-spin" /> Reading your day…
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="flex items-end gap-2 rounded-xl border border-border bg-surface p-2">
        <AutoTextarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(q);
            }
          }}
          minRows={1}
          maxRows={8}
          placeholder="What should I do next? Reschedule my afternoon. Tell Kyle…"
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-2"
        />
        <button
          onClick={() => ask(q)}
          disabled={busy || !q.trim()}
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-white disabled:opacity-40"
          aria-label="Ask"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>

      {err && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-danger">
          <X className="size-4" /> {err}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-2">
        It can change your own to-dos directly. Anything aimed at Kyle comes back as a button — nothing leaves without you pressing it.
      </p>
    </div>
  );
}
