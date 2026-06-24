"use client";

import Link from "next/link";
import { useState, useRef, useEffect, useTransition } from "react";
import { Send, Sparkles, BookOpen, Database, User, ShieldCheck, Phone, Copy, Check, Mail, ListChecks, ArrowUpRight } from "lucide-react";
import { askHub, type HubAnswer, type HubTurn, type HubRole, type HubDraft, type HubTaskCard } from "@/app/assistant/actions";
import { sendClientText } from "@/app/clients/actions";

const PRIORITY_COLOR: Record<string, string> = { URGENT: "#f87171", HIGH: "#fb923c", MEDIUM: "#fbbf24", LOW: "#94a3b8" };

// Confirmation that a to-do was created from the chat. Links to where it lives.
function TaskCard({ task }: { task: HubTaskCard }) {
  return (
    <Link
      href={task.href}
      className="mt-3 flex items-center gap-3 rounded-xl border border-success/30 bg-success/5 p-3 hover:bg-success/10"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/15 text-success">
        <ListChecks className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-success">
          <Check className="size-3.5" /> Task added to the queue
        </div>
        <div className="truncate text-sm font-medium text-foreground">{task.title}</div>
        <div className="truncate text-xs text-muted">
          {task.due ? `Due ${task.due}` : ""}{task.project ? ` · ${task.project}` : ""}
        </div>
      </div>
      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${PRIORITY_COLOR[task.priority] ?? "#94a3b8"}22`, color: PRIORITY_COLOR[task.priority] ?? "#94a3b8" }}>
        {task.priority}
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-2" />
    </Link>
  );
}

const ROLES: { value: HubRole; label: string; hint: string }[] = [
  { value: "OWNER", label: "Owner (you)", hint: "sees everything" },
  { value: "ADMIN", label: "Admin (Kyle)", hint: "no owner finances/strategy" },
  { value: "CREATIVE", label: "Creative", hint: "craft & shoot info only" },
];

type Msg =
  | { role: "user"; text: string }
  | { role: "hub"; text: string; sources: HubAnswer["sources"]; drafts?: HubDraft[]; tasks?: HubTaskCard[] };

const SUGGESTIONS = [
  "What's shooting today?",
  "What's overdue right now?",
  "Who owes us money?",
  "Draft a follow-up to Stephen Kennedy about his balance",
  "Anything in revision?",
];

// A Send-ready draft the assistant produced. Editable, then the human sends it
// (via OpenPhone) or copies it. The assistant never sends.
function DraftCard({ draft }: { draft: HubDraft }) {
  const [text, setText] = useState(draft.message);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  async function doSend() {
    setStatus("sending"); setErr("");
    try {
      const r = await sendClientText(draft.clientId, text);
      if (r.ok) setStatus("sent");
      else { setStatus("error"); setErr(r.message); }
    } catch (e) {
      setStatus("error"); setErr(e instanceof Error ? e.message : "Failed to send.");
    }
  }
  function doCopy() {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }

  return (
    <div className="mt-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-brand">
        {draft.channel === "email" ? <Mail className="size-3.5" /> : <Phone className="size-3.5" />}
        Draft {draft.channel} to {draft.clientName}
        <span className="ml-auto font-normal text-muted">review before sending</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
        disabled={status === "sent"}
        className="w-full resize-y rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-70"
      />
      <div className="mt-2 flex items-center gap-2">
        {draft.channel === "text" && draft.canText && status !== "sent" && (
          <button
            onClick={doSend}
            disabled={status === "sending" || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg disabled:opacity-50"
          >
            <Send className="size-3.5" /> {status === "sending" ? "Sending…" : "Send via OpenPhone"}
          </button>
        )}
        <button
          onClick={doCopy}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
        </button>
        {status === "sent" && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
            <Check className="size-3.5" /> Sent
          </span>
        )}
        {draft.channel === "text" && !draft.canText && (
          <span className="text-xs text-muted">No phone on file — copy and send manually.</span>
        )}
        {status === "error" && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

function renderText(text: string) {
  // Lightweight renderer: blank lines → spacing, "- "/"* " → bullets, **bold**.
  return text.split("\n").map((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") return <div key={i} className="h-2" />;
    const bullet = /^\s*[-*]\s+/.test(line);
    const content = bullet ? line.replace(/^\s*[-*]\s+/, "") : line;
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith("**") && p.endsWith("**") ? <strong key={j}>{p.slice(2, -2)}</strong> : <span key={j}>{p}</span>,
    );
    return bullet ? (
      <div key={i} className="flex gap-2 leading-relaxed">
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/60" />
        <span>{parts}</span>
      </div>
    ) : (
      <p key={i} className="leading-relaxed">{parts}</p>
    );
  });
}

export function AskHub({ initial }: { initial?: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [value, setValue] = useState("");
  const [role, setRole] = useState<HubRole>("OWNER");
  const [isPending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

  // Auto-ask a seeded question (e.g. from an "Ask the Hub" deep link on a client page).
  useEffect(() => {
    if (initial && initial.trim() && !seeded.current) {
      seeded.current = true;
      send(initial.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  function send(text: string) {
    const q = text.trim();
    if (!q || isPending) return;
    // Build history from the conversation so far (before this question).
    const history: HubTurn[] = messages.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setValue("");
    startTransition(async () => {
      const res = await askHub(q, history, role);
      setMessages((m) => [...m, { role: "hub", text: res.answer, sources: res.sources, drafts: res.drafts, tasks: res.tasks }]);
      requestAnimationFrame(() =>
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }),
      );
    });
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-8.5rem)] max-w-3xl flex-col p-6">
      <div className="mb-3 flex items-center justify-end gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <ShieldCheck className="size-3.5 text-brand" /> Viewing as
        </span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as HubRole)}
          className="rounded-lg border bg-surface px-2 py-1 text-xs font-medium focus:outline-none"
          title="What this role is allowed to see. Private knowledge is filtered out for lower roles. Real per-user enforcement arrives with user accounts."
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label} — {r.hint}
            </option>
          ))}
        </select>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto scroll-thin pr-1">
        {messages.length === 0 && (
          <div className="rounded-2xl border bg-surface p-6 text-center">
            <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
              <Sparkles className="size-6" />
            </span>
            <h2 className="font-semibold">Ask the Hub</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Ask anything about your live operation — shoots, clients, the schedule, to-dos,
              billing, or how the team handles something. I read straight from your hub data.
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
                  {m.tasks?.map((t, j) => <TaskCard key={`t${j}`} task={t} />)}
                  {m.drafts?.map((d, j) => <DraftCard key={j} draft={d} />)}
                  {m.sources.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-2">
                      <span className="text-[11px] uppercase tracking-wide text-muted-2">Looked at</span>
                      {m.sources.map((s, j) => (
                        <span
                          key={j}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted"
                        >
                          {s.kind === "knowledge" ? <BookOpen className="size-3" /> : <Database className="size-3" />}
                          {s.title}
                        </span>
                      ))}
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
            <span className="ml-1 text-xs text-muted-2">checking your data…</span>
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
          placeholder="Ask about shoots, clients, schedule, to-dos, billing…"
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
