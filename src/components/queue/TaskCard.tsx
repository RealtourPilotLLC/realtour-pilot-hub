"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  CheckCircle2, Clock, MapPin, Loader2, Sparkles, Copy, Send, ExternalLink,
  MessageSquarePlus, ChevronDown, Hash, Mail, Phone, Camera, Star, Clapperboard,
  PencilLine, Cpu, CircleDot, User, Users,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { setSmartTaskStatus, setTaskAssignee, draftTaskReply, sendDeliveryText, sendConfirmationText } from "@/app/actions";
import { addTaskNote } from "@/app/projects/messageActions";
import { etDateTime, etMonthDay, etDaysAgo } from "@/lib/datetime";
import { sourceMeta, SOURCE_CHIP, type SourceKey } from "@/lib/taskSource";
import { editorMeta, isDelegated, DELEGATE_KEYS, EDITORS } from "@/lib/editors";

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
  lead: "new lead",
  feedback_review: "feedback",
  appointment_prep: "shoot prep",
  todo: "to-do",
};
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, " ");

const DRAFTABLE = ["client_reply", "revision", "feedback_review", "delivery_text"];
const LUMA_TRACKER_URL = "https://portal.lumavisuals.co/";
// Task types that carry a pre-written message (in `description`) ready to send.
const PREDRAFTED = ["confirmation_text", "delivery_text"];

// One read-only deliverable status row for a QC task (parsed server-side from the
// task's checklist JSON — the checklist is no longer an interactive UI, it just
// feeds this at-a-glance "what's live / what's pending" line and the auto-close).
export type DeliverableStatus = { label: string; done: boolean };

export type QueueTask = {
  id: string;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  dueAt: string | null;
  createdAt: string | null;
  reasonCreated: string | null;
  summary: string | null;
  description: string | null;
  deliverables: DeliverableStatus[];
  source: string;
  sourceDetail: string | null;
  assignedKey: string | null;
  projectId: string | null;
  clientId: string | null;
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

const SOURCE_ICON: Record<SourceKey, typeof Hash> = {
  slack: Hash,
  aryeo: Camera,
  gmail: Mail,
  openphone: Phone,
  feedback: Star,
  luma: Clapperboard,
  team: Users,
  assistant: Sparkles,
  manual: PencilLine,
  system: Cpu,
};

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

// "Came in" label: relative for the last couple days, else the month/day.
function cameInLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const ago = etDaysAgo(d);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  return etMonthDay(d);
}

// The card's expandable "what happened" body. Prefers the AI summary; falls back
// to the why + the raw message so older tasks (no summary yet) still read well.
function summaryText(task: QueueTask): string | null {
  if (task.summary?.trim()) return task.summary.trim();
  if (task.reasonCreated?.trim()) return task.reasonCreated.trim();
  return null;
}

// Fallback roster when the page didn't pass the live team (keeps older callers
// working). The Daily Tasks queue + project page pass the full team via props.
const FALLBACK_ASSIGNEES = [
  { key: "kyle", name: "Kyle" },
  { key: "jordan", name: "Jordan" },
  ...DELEGATE_KEYS.map((k) => ({ key: k, name: EDITORS[k].name })),
];

export function TaskCard({ task, assignees }: { task: QueueTask; assignees?: { key: string; name: string }[] }) {
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
  const [assigning, startAssign] = useTransition();

  const assignee = editorMeta(task.assignedKey);
  const delegated = isDelegated(task.assignedKey);
  const roster = assignees ?? FALLBACK_ASSIGNEES;
  const assigneeName = roster.find((a) => a.key === task.assignedKey)?.name ?? assignee?.name ?? null;
  const p = PRIORITY[task.priority] ?? PRIORITY.MEDIUM;
  const due = dueLabel(task.dueAt);
  const cameIn = cameInLabel(task.createdAt);
  const done = task.status === "COMPLETED";
  const canDraft = DRAFTABLE.includes(task.taskType);
  const predrafted = PREDRAFTED.includes(task.taskType) && !!task.description;
  const canSend = task.taskType === "delivery_text" || task.taskType === "confirmation_text";
  const isLuma = task.taskType === "vendor_update" && /luma/i.test(task.title);
  const src = sourceMeta(task.source);
  const SrcIcon = SOURCE_ICON[src.key];
  const summary = summaryText(task);
  // Project chip label: the street, when we have an address.
  const projectLabel = task.propertyAddress ? task.propertyAddress.split(",")[0].trim() : null;
  // The title often already contains the street — don't repeat it in the chip.
  const titleHasAddress = !!projectLabel && task.title.toLowerCase().includes(projectLabel.toLowerCase());
  // What's worth expanding: a summary, the live/pending deliverable status, the
  // raw message, or a drafted message to review.
  const hasBody = !!summary || task.deliverables.length > 0 || (!!task.description && !predrafted);
  // Drafted-message tasks open expanded so the message is visible to review/send.
  const [open, setOpen] = useState(predrafted);

  const run = (status: string) => start(async () => setSmartTaskStatus(task.id, status));
  const assign = (key: string) => startAssign(async () => setTaskAssignee(task.id, key));
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
      if (!open) setOpen(true);
      setDraft(await draftTaskReply(task.id));
    });
  const saveNote = () =>
    startNote(async () => {
      const r = await addTaskNote(task.id, noteText);
      setNoteMsg(r.message);
      if (r.ok) { setNoteText(""); setNoteOpen(false); }
    });

  return (
    <div id={`task-${task.id}`} className={`panel-shadow scroll-mt-24 rounded-2xl border bg-surface p-3 sm:p-4 transition-shadow ${done ? "opacity-60" : ""}`}>
      {/* Meta row: priority + type on the left, due on the right. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge color={p.color} soft={p.soft}>{task.priority.toLowerCase()}</Badge>
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

      {/* Title — clickable to expand when there's a body to reveal. */}
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`mt-1.5 flex w-full items-start gap-1.5 text-left ${hasBody ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className="break-words text-sm font-semibold leading-snug">{task.title}</span>
        {hasBody && (
          <ChevronDown className={`mt-0.5 size-4 shrink-0 text-muted-2 transition-transform ${open ? "rotate-180" : ""}`} />
        )}
      </button>

      {/* Identity row: client · project · source · came-in date. The five things
          that make a task trackable at a glance. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        {task.clientName && (
          task.clientId ? (
            <Link href={`/clients/${task.clientId}`} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 font-medium text-foreground/90 hover:text-foreground">
              <User className="size-3 text-muted-2" /> {task.clientName}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 font-medium text-foreground/80">
              <User className="size-3 text-muted-2" /> {task.clientName}
            </span>
          )
        )}
        {projectLabel && !titleHasAddress && (
          task.projectId ? (
            <Link href={`/projects/${task.projectId}`} className="inline-flex min-w-0 items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-muted hover:text-foreground">
              <MapPin className="size-3 shrink-0" /> <span className="max-w-[12rem] truncate">{projectLabel}</span>
            </Link>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-muted">
              <MapPin className="size-3 shrink-0" /> <span className="max-w-[12rem] truncate">{projectLabel}</span>
            </span>
          )
        )}
        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium ${SOURCE_CHIP[src.key]}`}>
          <SrcIcon className="size-3" /> {src.label}
        </span>
        {assigneeName && task.assignedKey && task.assignedKey !== "kyle" && (
          <span className="inline-flex items-center gap-1 rounded-md bg-brand/10 px-1.5 py-0.5 font-medium text-brand" title={delegated ? `Delegated to ${assigneeName}${assignee?.does ? ` — ${assignee.does}` : ""}` : `For ${assigneeName}`}>
            <Users className="size-3" /> {assigneeName}
          </span>
        )}
        {cameIn && <span className="text-muted-2">· {cameIn}</span>}
      </div>

      {/* Expandable body — the "what happened" summary + details. */}
      {open && hasBody && (
        <div className="mt-2.5 space-y-2.5 rounded-xl border border-border bg-surface-2/40 p-3">
          {summary && <p className="whitespace-pre-line break-words text-sm text-foreground/90">{summary}</p>}

          {/* QC: read-only live/pending status per deliverable. */}
          {task.deliverables.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {task.deliverables.map((d, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${d.done ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}
                >
                  {d.done ? <CheckCircle2 className="size-3" /> : <CircleDot className="size-3" />}
                  {d.label.replace(/^QC\s+/i, "")}
                  <span className="opacity-70">{d.done ? "live" : "pending"}</span>
                </span>
              ))}
            </div>
          )}

          {/* The actual inbound message (not for predrafted-send tasks — those show
              their drafted text below instead). */}
          {task.description && !predrafted && !summary?.includes(task.description.slice(0, 40)) && (
            <p className="whitespace-pre-line break-words border-t border-border pt-2 text-xs text-muted">{task.description}</p>
          )}

          {task.reasonCreated && summary !== task.reasonCreated && (
            <p className="text-[11px] text-muted-2">Why: {task.reasonCreated}</p>
          )}
        </div>
      )}

      {/* Drafted text ready to review + send (confirmation / delivery texts). */}
      {predrafted && open && (
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

      {/* Action footer. */}
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
            className="w-[6.5rem] min-w-0 rounded-lg border bg-surface px-2 py-1.5 text-xs focus:outline-none"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>
            ))}
          </select>
        )}
        {!done && (
          <select
            value={task.assignedKey || "kyle"}
            disabled={assigning}
            onChange={(e) => assign(e.target.value)}
            title="Assign this task"
            className={`w-[7.5rem] min-w-0 rounded-lg border px-2 py-1.5 text-xs focus:outline-none ${task.assignedKey && task.assignedKey !== "kyle" ? "bg-brand/10 text-brand" : "bg-surface text-muted"}`}
          >
            {roster.map((a) => (
              <option key={a.key} value={a.key}>{a.name}</option>
            ))}
          </select>
        )}

        {/* Primary actions: own full-width row on mobile, right-aligned on sm+. */}
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:ml-auto sm:w-auto">
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
