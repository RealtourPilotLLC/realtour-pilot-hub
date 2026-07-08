"use client";

import { useState, useTransition } from "react";
import { Sparkles, User, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { generateChatSummary, getChatTranscript } from "@/app/assistant/history/actions";
import { ink } from "@/components/ui/Badge";

export type ChatListItem = {
  id: string;
  title: string;
  summary: string | null;
  categoryLabel: string;
  categoryColor: string;
  role: string;
  questions: number;
  when: string;
};

const ROLE_CHIP: Record<string, { label: string; color: string }> = {
  OWNER: { label: "Owner", color: "#e96320" },
  ADMIN: { label: "Admin", color: "#6ba3d6" },
  CREATIVE: { label: "Creative", color: "#9aa4b2" },
};

type Line = { role: string; content: string; at: string };

function ChatRow({ chat }: { chat: ChatListItem }) {
  const [summary, setSummary] = useState<string | null>(chat.summary);
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [err, setErr] = useState("");
  const [pending, startTransition] = useTransition();
  const role = ROLE_CHIP[chat.role] ?? ROLE_CHIP.OWNER;

  function makeSummary() {
    startTransition(async () => {
      setErr("");
      const r = await generateChatSummary(chat.id);
      if (r.ok && r.summary) setSummary(r.summary);
      else setErr(r.error ?? "Could not summarize.");
    });
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && lines === null) {
      startTransition(async () => {
        const r = await getChatTranscript(chat.id);
        if (r.ok && r.messages) setLines(r.messages);
        else setErr(r.error ?? "Could not load transcript.");
      });
    }
  }

  return (
    <div className="rounded-xl border bg-surface p-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: ink(chat.categoryColor) }}>
          <span className="size-2 rounded-full" style={{ backgroundColor: chat.categoryColor }} />
          {chat.categoryLabel}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${role.color}22`, color: ink(role.color) }}>
          {role.label}
        </span>
        <span className="text-xs text-muted-2">{chat.when}</span>
      </div>

      <div className="text-sm font-medium text-foreground">{chat.title}</div>

      {summary ? (
        <p className="mt-1 text-sm leading-relaxed text-muted">{summary}</p>
      ) : (
        <div className="mt-1.5">
          <button
            onClick={makeSummary}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
          >
            <Sparkles className="size-3.5" /> {pending ? "Summarizing…" : "Generate summary"}
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 border-t pt-2 text-xs text-muted-2">
        <span>{chat.questions} question{chat.questions === 1 ? "" : "s"}</span>
        <button onClick={toggle} className="inline-flex items-center gap-1 hover:text-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {open ? "Hide transcript" : "View transcript"}
        </button>
        {summary && (
          <button onClick={makeSummary} disabled={pending} className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50" title="Regenerate summary">
            <RefreshCw className={`size-3 ${pending ? "animate-spin" : ""}`} /> Refresh
          </button>
        )}
      </div>

      {err && <div className="mt-2 text-xs text-danger">{err}</div>}

      {open && (
        <div className="mt-2 max-h-80 space-y-2 overflow-y-auto scroll-thin rounded-lg bg-background/40 p-3">
          {lines === null ? (
            <div className="text-xs text-muted">Loading…</div>
          ) : lines.length === 0 ? (
            <div className="text-xs text-muted">No messages.</div>
          ) : (
            lines.map((m, i) => (
              <div key={i} className={`flex gap-2 ${m.role === "user" ? "" : "opacity-90"}`}>
                <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${m.role === "user" ? "bg-surface-2 text-muted" : "bg-brand-soft text-brand"}`}>
                  {m.role === "user" ? <User className="size-3" /> : <Sparkles className="size-3" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wide text-muted-2">{m.role === "user" ? "Asked" : "Hub"} · {m.at}</div>
                  <div className="whitespace-pre-wrap text-sm text-foreground/85">{m.content}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ChatHistoryList({ chats }: { chats: ChatListItem[] }) {
  if (chats.length === 0) {
    return (
      <div className="rounded-xl border bg-surface p-8 text-center text-sm text-muted">
        No conversations yet. Questions asked in Ask the Hub will appear here.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {chats.map((c) => (
        <ChatRow key={c.id} chat={c} />
      ))}
    </div>
  );
}
