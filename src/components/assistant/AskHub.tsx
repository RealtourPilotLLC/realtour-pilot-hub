"use client";

import Link from "next/link";
import { useState, useRef, useEffect, useTransition } from "react";
import { Send, Sparkles, BookOpen, Database, User, ShieldCheck, Phone, Copy, Check, Mail, ListChecks, ArrowUpRight, Brain, Lock, Paperclip, X, FileText } from "lucide-react";
import { askHub, type HubAnswer, type HubTurn, type HubRole, type HubDraft, type HubTaskCard, type HubMemoryCard } from "@/app/assistant/actions";
import { sendClientText } from "@/app/clients/actions";
import { ink } from "@/components/ui/Badge";

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
      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${PRIORITY_COLOR[task.priority] ?? "#94a3b8"}22`, color: ink(PRIORITY_COLOR[task.priority] ?? "#94a3b8") }}>
        {task.priority}
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-2" />
    </Link>
  );
}

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner only", ADMIN: "Team", CREATIVE: "Everyone" };

// Confirmation that the hub learned a new fact and will use it going forward.
function MemoryCard({ memory }: { memory: HubMemoryCard }) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand">
        <Brain className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-brand">
          <Check className="size-3.5" /> Saved to memory{memory.superseded > 0 ? ` · replaced ${memory.superseded} older note${memory.superseded > 1 ? "s" : ""}` : ""}
        </div>
        <div className="truncate text-sm font-medium text-foreground">{memory.title}</div>
        <div className="truncate text-xs text-muted capitalize">{memory.category.replace(/_/g, " ")}</div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">
        <Lock className="size-2.5" /> {ROLE_LABEL[memory.minRole] ?? memory.minRole}
      </span>
    </div>
  );
}

const ROLES: { value: HubRole; label: string; hint: string }[] = [
  { value: "OWNER", label: "Owner (you)", hint: "sees everything" },
  { value: "ADMIN", label: "Admin (Kyle)", hint: "no owner finances/strategy" },
  { value: "CREATIVE", label: "Creative", hint: "craft & shoot info only" },
];

type Msg =
  | { role: "user"; text: string; attachments?: string[] }
  | { role: "hub"; text: string; sources: HubAnswer["sources"]; drafts?: HubDraft[]; tasks?: HubTaskCard[]; memories?: HubMemoryCard[] };

// A file staged for the next question. Images are downscaled client-side so a
// phone photo doesn't blow the server-action payload limit.
type StagedFile = {
  name: string;
  kind: "image" | "pdf" | "text";
  mediaType?: string;
  dataBase64?: string;
  text?: string;
  preview?: string; // object URL for image thumbnails
};

const MAX_FILES = 4;

async function stageFile(f: File): Promise<StagedFile | { error: string }> {
  if (f.type.startsWith("image/")) {
    // Downscale to ≤1568px JPEG — plenty for the model, tiny on the wire.
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("bad image"));
        i.src = url;
      });
      const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      return { name: f.name, kind: "image", mediaType: "image/jpeg", dataBase64: dataUrl.split(",")[1], preview: dataUrl };
    } catch {
      return { error: `Couldn't read ${f.name}` };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
    if (f.size > 4 * 1024 * 1024) return { error: `${f.name} is over 4MB — export a smaller PDF and try again.` };
    const buf = await f.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: f.name, kind: "pdf", dataBase64: btoa(bin) };
  }
  if (f.type.startsWith("text/") || /\.(txt|csv|md|json|log)$/i.test(f.name)) {
    if (f.size > 512 * 1024) return { error: `${f.name} is too big for a text file — trim it under 500KB.` };
    return { name: f.name, kind: "text", text: await f.text() };
  }
  return { error: `${f.name}: photos, PDFs, and text/CSV files are supported.` };
}

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

export function AskHub({ initial, tier }: { initial?: string; tier: HubRole }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);
  const chatId = useRef<string | undefined>(undefined);

  async function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    setFileErr(null);
    const room = MAX_FILES - files.length;
    if (room <= 0) { setFileErr(`Up to ${MAX_FILES} files per question.`); return; }
    const staged: StagedFile[] = [];
    for (const f of Array.from(list).slice(0, room)) {
      const r = await stageFile(f);
      if ("error" in r) setFileErr(r.error);
      else staged.push(r);
    }
    if (staged.length) setFiles((cur) => [...cur, ...staged].slice(0, MAX_FILES));
  }

  // Drag & drop anywhere on the chat. Depth counter stops child dragleave flicker.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const dragHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      dragDepth.current++;
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      addFiles(e.dataTransfer.files);
    },
  };

  // Paste a screenshot/photo (or a copied file) straight into the chat.
  function onPaste(e: React.ClipboardEvent) {
    const pasted = Array.from(e.clipboardData?.files ?? []);
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
    }
  }

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
    if ((!q && files.length === 0) || isPending) return;
    // Build history from the conversation so far (before this question).
    const history: HubTurn[] = messages.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));
    const outgoing = files.map((f) =>
      f.kind === "image"
        ? { kind: "image" as const, mediaType: f.mediaType!, dataBase64: f.dataBase64!, name: f.name }
        : f.kind === "pdf"
          ? { kind: "pdf" as const, dataBase64: f.dataBase64!, name: f.name }
          : { kind: "text" as const, text: f.text!, name: f.name },
    );
    setMessages((m) => [...m, { role: "user", text: q || "(attached files)", attachments: files.map((f) => f.name) }]);
    setValue("");
    setFiles([]);
    setFileErr(null);
    startTransition(async () => {
      const res = await askHub(q, history, chatId.current, outgoing.length ? outgoing : undefined);
      if (res.chatId) chatId.current = res.chatId;
      setMessages((m) => [...m, { role: "hub", text: res.answer, sources: res.sources, drafts: res.drafts, tasks: res.tasks, memories: res.memories }]);
      requestAnimationFrame(() =>
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }),
      );
    });
  }

  return (
    <div className="relative mx-auto flex h-[calc(100vh-8.5rem)] max-w-3xl flex-col p-6" {...dragHandlers}>
      {dragOver && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-brand bg-brand/10">
          <div className="flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5 text-sm font-medium text-brand shadow-lg">
            <Paperclip className="size-4" /> Drop photos or files to attach
          </div>
        </div>
      )}
      <div className="mb-3 flex items-center justify-end gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium text-muted"
          title="What you're allowed to see. Private owner/admin knowledge and comms are filtered out automatically for your role."
        >
          <ShieldCheck className="size-3.5 text-brand" />
          {ROLES.find((r) => r.value === tier)?.label ?? tier} view
        </span>
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
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {m.attachments.map((n, j) => (
                        <span key={j} className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px]">
                          <Paperclip className="size-3" /> {n}
                        </span>
                      ))}
                    </div>
                  )}
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
                  {m.memories?.map((mem, j) => <MemoryCard key={`m${j}`} memory={mem} />)}
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

      <div className="mt-3 rounded-2xl border bg-surface p-2">
        {(files.length > 0 || fileErr) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface-2 py-1 pl-1.5 pr-1 text-xs">
                {f.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.preview} alt={f.name} className="size-6 rounded object-cover" />
                ) : (
                  <FileText className="size-3.5 text-muted" />
                )}
                <span className="max-w-36 truncate">{f.name}</span>
                <button
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="rounded p-0.5 text-muted-2 hover:text-danger"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {fileErr && <span className="text-[11px] text-danger">{fileErr}</span>}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.csv,.md,.json,.log"
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isPending}
            aria-label="Attach photos or files"
            title="Attach photos or files (images, PDFs, CSV/text)"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-surface-2 text-muted hover:text-foreground disabled:opacity-50"
          >
            <Paperclip className="size-4" />
          </button>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(value);
              }
            }}
            rows={1}
            placeholder={files.length ? "Ask about the attached file(s)…" : "Ask about shoots, clients, schedule, to-dos, billing… (paste or drop images)"}
            className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm focus:outline-none"
          />
          <button
            onClick={() => send(value)}
            disabled={isPending || (!value.trim() && files.length === 0)}
            aria-label="Send"
            className="flex size-9 items-center justify-center rounded-xl bg-brand text-brand-fg disabled:opacity-50"
          >
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
