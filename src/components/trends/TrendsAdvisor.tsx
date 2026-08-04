"use client";

import { useRef, useState } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { askTrendsAdvisor, type AdvisorTurn } from "@/app/trends/advisorActions";

const SUGGESTIONS = [
  "How do I get my average order up next month?",
  "Which package should I push hardest, and to who?",
  "Who should I call this week?",
  "Why is my average ticket falling?",
  "What should I bundle with Bronze?",
];

export function TrendsAdvisor() {
  const [turns, setTurns] = useState<(AdvisorTurn & { tools?: string[] })[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: q }]);
    setTimeout(() => boxRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }), 50);
    try {
      const r = await askTrendsAdvisor(q, history);
      setTurns((t) => [...t, { role: "assistant", content: r.answer, tools: r.toolsUsed }]);
    } catch {
      setTurns((t) => [...t, { role: "assistant", content: "Something went wrong. Try again." }]);
    } finally {
      setBusy(false);
      setTimeout(() => boxRef.current?.scrollTo({ top: 1e9, behavior: "smooth" }), 80);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface panel-shadow">
      <div className="border-b border-border px-5 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-brand" /> Ask your growth advisor
        </span>
        <p className="mt-0.5 text-[11px] text-muted-2">
          Reads the same live numbers as this page — booking pace, package mix, real margins, who is drifting. Aimed at one thing: a bigger average order.
        </p>
      </div>

      <div ref={boxRef} className="max-h-[28rem] space-y-3 overflow-y-auto scroll-thin px-4 py-4">
        {turns.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-muted hover:bg-surface hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-brand/15 px-3.5 py-2 text-sm">{t.content}</div>
          ) : (
            <div key={i} className="max-w-[95%] rounded-2xl rounded-bl-sm border border-border/60 bg-surface-2/60 px-3.5 py-2.5">
              <Markdown content={t.content} className="text-sm" />
              {t.tools && t.tools.length > 0 && (
                <div className="mt-1.5 text-[10px] text-muted-2">
                  Checked: {t.tools.filter((x) => x !== "current_datetime").join(", ") || "context"}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> reading the numbers…
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Ask about growth, pricing, packages, clients…"
          className="max-h-32 min-h-[2.4rem] flex-1 resize-y rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button
          onClick={() => send()}
          disabled={busy || !input.trim()}
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand text-white disabled:opacity-40"
        >
          <Send className="size-4" />
        </button>
      </div>
    </section>
  );
}
