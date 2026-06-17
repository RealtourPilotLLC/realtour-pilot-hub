"use client";

import { useState, useRef, useTransition } from "react";
import { Send, Sparkles, BookOpen, ExternalLink, User } from "lucide-react";
import { askHub, type HubAnswer } from "@/app/assistant/actions";

type Msg =
  | { role: "user"; text: string }
  | { role: "hub"; text: string; sources: HubAnswer["sources"] };

const SUGGESTIONS = [
  "What's the standard photo shoot checklist?",
  "How do we handle twilight shoots?",
  "What's our editing standard?",
  "How do we deliver galleries?",
];

function renderText(text: string) {
  // very small **bold** + newline renderer
  return text.split("\n").map((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={i} className={line.trim() === "" ? "h-2" : "leading-relaxed"}>
        {parts.map((p, j) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={j}>{p.slice(2, -2)}</strong>
          ) : (
            <span key={j}>{p}</span>
          ),
        )}
      </p>
    );
  });
}

export function AskHub() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [value, setValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  function send(text: string) {
    const q = text.trim();
    if (!q) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setValue("");
    startTransition(async () => {
      const res = await askHub(q);
      setMessages((m) => [...m, { role: "hub", text: res.answer, sources: res.sources }]);
      requestAnimationFrame(() =>
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }),
      );
    });
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-8.5rem)] max-w-3xl flex-col p-6">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto scroll-thin pr-1">
        {messages.length === 0 && (
          <div className="rounded-2xl border bg-surface p-6 text-center">
            <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
              <Sparkles className="size-6" />
            </span>
            <h2 className="font-semibold">Ask the Hub</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Ask about how we work — shooting, editing, delivery, sales. Today I answer
              from your SOPs &amp; resources. Soon I&apos;ll learn from your real
              conversations to match how you actually handle things.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border bg-surface px-3 py-1.5 text-xs font-medium text-foreground/80 hover:bg-surface-2"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="flex max-w-[80%] items-start gap-2">
                <div className="rounded-2xl rounded-tr-sm bg-brand px-4 py-2.5 text-sm text-brand-fg">
                  {m.text}
                </div>
                <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                  <User className="size-4" />
                </span>
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="flex max-w-[85%] items-start gap-2">
                <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                  <Sparkles className="size-4" />
                </span>
                <div className="rounded-2xl rounded-tl-sm border bg-surface px-4 py-3 text-sm text-foreground/90">
                  <div className="space-y-0.5">{renderText(m.text)}</div>
                  {m.sources.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-2">
                      {m.sources.map((s, j) =>
                        s.href ? (
                          <a
                            key={j}
                            href={s.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted hover:text-foreground"
                          >
                            <ExternalLink className="size-3" /> {s.title}
                          </a>
                        ) : (
                          <span
                            key={j}
                            className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted"
                          >
                            <BookOpen className="size-3" /> {s.title}
                          </span>
                        ),
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ),
        )}

        {isPending && (
          <div className="flex items-center gap-2 pl-9 text-sm text-muted">
            <span className="size-1.5 animate-bounce rounded-full bg-muted-2 [animation-delay:-0.2s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-2 [animation-delay:-0.1s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-2" />
          </div>
        )}
      </div>

      <div className="mt-3 flex items-end gap-2 rounded-2xl border bg-surface p-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(value);
            }
          }}
          rows={1}
          placeholder="Ask about shooting, editing, delivery, sales…"
          className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm focus:outline-none"
        />
        <button
          onClick={() => send(value)}
          disabled={isPending || !value.trim()}
          className="flex size-9 items-center justify-center rounded-xl bg-brand text-brand-fg disabled:opacity-50"
        >
          <Send className="size-4" />
        </button>
      </div>
    </div>
  );
}
