"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Clock, MapPin, Loader2, Sparkles, Copy, Send, ExternalLink, Square, CheckSquare, MessageSquarePlus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { setSmartTaskStatus, toggleTaskChecklistItem, draftTaskReply, sendDeliveryText, sendConfirmationText } from "@/app/actions";
import { addTaskNote } from "@/app/projects/messageActions";
import { etDaysAgo, etDateTime } from "@/lib/datetime";
import type { ChecklistItem } from "@/lib/checklist";

// Friendly display label per task type (QA → QC, etc.).
const TYPE_LABEL: Record<string, string> = {
  media_qa: "QC",
  client_reply: "reply",
  comms_followup: "job instruction",
  confirmation_text: "confirmation",
  delivery: "delivery",
  delivery_text: "delivery text",
  revision: "revision",
  vendor_update: "vendor update",
  image_fixes: "photo fixes",
  internal_instruction: "team task",
};
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, " ");

const DRAFTABLE = ["client_reply", "revision", "feedback_review", "delivery_text"];
const LUMA_TRACKER_URL = "https://portal.lumavisuals.co/";
// Task types that carry a pre-written message (in `description`) ready to send.
const PREDRAFTED = ["confirmation_text", "delivery_text"];

export type QueueTask = {
  id: string;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  dueAt: string | null;
  reasonCreated: string | null;
  description: string | null;
  checklist: ChecklistItem[];
  source: string;
  projectId: string | null;
  clientName: string | null;
  propertyAddress: string | null;
};

const PRIORITY: Record<string, { color: string; soft: string }> = {
  URGENT: { color: "#dc2626", soft: "#fee2e2" },
  HIGH: { color: "#d97706", soft: "#fef3c7" },
  MEDIUM: { color: "#0ea5e9", soft: "#e0f2fe" },
  LOW: { color: "#64748b", soft: "var(--surface-2)" },
};

const STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_CLIENT",
  "WAITING_PHOTOGRAPHER",
  "WAITING_EDITOR",
  "WAITING_VENDOR",
  "WAITING_JORDAN",
  "BLOCKED",
  "CANCELLED",
];

function dueLabel(due: string | null) {
  if (!due) return null;
  const d = new Date(due);
  // Bucket "due soon" by ET calendar day (the business runs on ET; the server is
  // UTC) so the amber color matches the ET-based Overdue/Today/Upcoming grouping.
  const daysUntil = -etDaysAgo(d);
  const text = etDateTime(d);
  const overdue = d.getTime() < Date.now();
  return { text, overdue, soon: daysUntil <= 1 };
}

export function TaskCard({ task }: { task: QueueTask }) {
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<{ text?: string; error?: string } | null>(null);
  const [drafting, startDraft] = useTransition();
  const [copied, setCopied] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);
  const [sending, startSend] = useTransition();
  const [predraftCopied, setPredraftCopied] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteMsg, setNoteMsg] = useState<string | null>(null);
  const [savingNote, startNote] = useTransition();
  const p = PRIORITY[task.priority] ?? PRIORITY.MEDIUM;
  const due = dueLabel(task.dueAt);
  const done = task.status === "COMPLETED";
  const canDraft = DRAFTABLE.includes(task.taskType);
  const predrafted = PREDRAFTED.includes(task.taskType) && !!task.description;
  const canSend = task.taskType === "delivery_text" || task.taskType === "confirmation_text";
  const isLuma = task.taskType === "vendor_update" && /luma/i.test(task.title);
  // The title often already contains the street, so drop the redundant address line.
  const titleHasAddress = !!task.propertyAddress &&
    task.title.toLowerCase().includes(task.propertyAddress.split(",")[0].trim().toLowerCase());

  const run = (status: string) => start(async () => setSmartTaskStatus(task.id, status));
  const sendText = () =>
    startSend(async () => {
      const r = task.taskType === "confirmation_text"
        ? await sendConfirmationText(task.id)
        : await sendDeliveryText(task.id);
      setSendMsg(r.message);
    });
  const makeDraft = () =>
    startDraft(async () => {
      setCopied(false);
      setDraft(await draftTaskReply(task.id));
    });
  const saveNote = () =>
    startNote(async () => {
      const r = await addTaskNote(task.id, noteText);
      setNoteMsg(r.message);
      if (r.ok) { setNoteText(""); setNoteOpen(false); }
    });

  return (
    <div className={`panel-shadow rounded-2xl border bg-surface p-3 sm:p-4 ${done ? "opacity-60" : ""}`}>
      {/* Meta row: priority + type on the left, due on the right. Wraps to its
          own line on narrow cards instead of overlapping. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge color={p.color} soft={p.soft}>
          {task.priority.toLowerCase()}
        </Badge>
        <span className="text-[11px] uppercase tracking-wide text-muted-2">{typeLabel(task.taskType)}</span>
        {due ? (
          <span className={`ml-auto inline-flex items-center gap-0.5 whitespace-nowrap text-xs ${due.overdue ? "font-semibold text-danger" : due.soon ? "font-medium text-warning" : "text-muted"}`}>
            <Clock className="size-3" />
            {due.overdue ? `Overdue · ${due.text}` : `Due ${due.text}`}
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-0.5 whitespace-nowrap text-xs text-muted-2"><Clock className="size-3" />No due date</span>
        )}
      </div>
      <div className="mt-1.5 break-words text-sm font-semibold leading-snug">{task.title}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
        {task.clientName && <span>{task.clientName}</span>}
        {task.propertyAddress && !titleHasAddress && (
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <MapPin className="size-3 shrink-0" /> <span className="truncate">{task.propertyAddress}</span>
          </span>
        )}
      </div>

      {task.checklist.length > 0 && <ChecklistBox taskId={task.id} initial={task.checklist} />}

      {predrafted && (
        <div className="mt-2 rounded-xl border bg-surface-2/60 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Drafted text</span>
            <button
              onClick={() => { navigator.clipboard?.writeText(task.description ?? "").catch(() => {}); setPredraftCopied(true); }}
              className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
            >
              <Copy className="size-3" /> {predraftCopied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="whitespace-pre-line break-words text-sm text-foreground/90">{task.description}</p>
          <p className="mt-2 text-[10px] text-muted-2">Review before sending. The hub never sends on its own.</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {!done ? (
          <button
            onClick={() => run("COMPLETED")}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 px-2.5 py-1.5 text-xs font-medium text-success hover:bg-success/20 disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
            Complete
          </button>
        ) : (
          <button onClick={() => run("OPEN")} disabled={pending} className="text-xs text-muted hover:underline">
            Reopen
          </button>
        )}
        {!done && (
          <select
            value={task.status}
            disabled={pending}
            onChange={(e) => run(e.target.value)}
            title="Set status"
            className="max-w-[8rem] rounded-lg border bg-surface px-2 py-1.5 text-xs focus:outline-none"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        )}

        {/* Primary actions pushed to the right; they wrap below on narrow cards. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!done && isLuma && (
            <a
              href={LUMA_TRACKER_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the Luma Visuals tracker"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              <ExternalLink className="size-3.5" /> Luma tracker
            </a>
          )}
          {!done && canSend && (
            <button
              onClick={sendText}
              disabled={sending}
              title="Send via OpenPhone"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              Send
            </button>
          )}
          {!done && canDraft && (
            <button
              onClick={makeDraft}
              disabled={drafting}
              title="AI draft a reply"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-60"
            >
              {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              Draft
            </button>
          )}
          {task.projectId && (
            <button
              onClick={() => setNoteOpen((v) => !v)}
              title="Leave a note on this job (posts to project messages)"
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
            >
              <MessageSquarePlus className="size-3.5" /> Note
            </button>
          )}
          {task.projectId && (
            <Link
              href={`/projects/${task.projectId}${task.taskType === "image_fixes" ? "#flags" : ""}`}
              className="text-xs text-muted hover:text-foreground"
            >
              Open →
            </Link>
          )}
        </div>
      </div>
      {sendMsg && <p className="mt-2 text-xs text-muted">{sendMsg}</p>}

      {noteOpen && (
        <div className="mt-3 rounded-xl border bg-surface-2/60 p-3">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={2}
            autoFocus
            placeholder="Leave a note for the crew on this job…"
            className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={saveNote}
              disabled={savingNote || !noteText.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {savingNote ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-3.5" />} Add to project messages
            </button>
            <button onClick={() => { setNoteOpen(false); setNoteText(""); }} className="text-xs text-muted hover:text-foreground">Cancel</button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-2">Posts to the job&rsquo;s team thread — not sent to the client.</p>
        </div>
      )}
      {noteMsg && !noteOpen && <p className="mt-2 text-xs text-success">{noteMsg}</p>}

      {draft && (
        <div className="mt-3 rounded-xl border bg-surface-2/60 p-3">
          {draft.error ? (
            <p className="text-xs text-danger">{draft.error}</p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Suggested reply</span>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(draft.text ?? "").catch(() => {});
                    setCopied(true);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
                >
                  <Copy className="size-3" /> {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="whitespace-pre-line break-words text-sm text-foreground/90">{draft.text}</p>
              <p className="mt-2 text-[10px] text-muted-2">Review before sending. The hub never sends on its own.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Interactive checklist: tick items in place; the server persists each toggle
// and auto-completes the task once every box is checked.
function ChecklistBox({ taskId, initial }: { taskId: string; initial: ChecklistItem[] }) {
  const [items, setItems] = useState<ChecklistItem[]>(initial);
  const [busy, setBusy] = useState<number | null>(null);
  const [, start] = useTransition();
  const doneCount = items.filter((i) => i.done).length;

  const toggle = (i: number) => {
    // Optimistic flip; the server is the source of truth on revalidate.
    setItems((cur) => cur.map((it, idx) => (idx === i ? { ...it, done: !it.done } : it)));
    setBusy(i);
    start(async () => {
      const r = await toggleTaskChecklistItem(taskId, i);
      if (r.ok) setItems(r.items);
      setBusy(null);
    });
  };

  return (
    <div className="mt-2 rounded-xl border border-border bg-surface-2/40 p-2.5">
      <div className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2">
        Checklist · {doneCount}/{items.length}
      </div>
      <ul className="space-y-0.5">
        {items.map((it, i) => (
          <li key={i}>
            <button
              onClick={() => toggle(i)}
              disabled={busy === i}
              className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface-2 disabled:opacity-60"
            >
              {busy === i ? (
                <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted" />
              ) : it.done ? (
                <CheckSquare className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : (
                <Square className="mt-0.5 size-3.5 shrink-0 text-muted-2" />
              )}
              <span className={it.done ? "text-muted-2 line-through" : "text-foreground/85"}>{it.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
