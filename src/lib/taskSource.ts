// Where a task came from — a clean, normalized presentation for the source chip
// shown on every task card. The `source` column is a free string with historical
// drift (openphone-call, slack-channel, "Luma Visuals", revision, comms, …), so
// we fold all the variants into one of a few friendly origins.
//
// Dependency-free on purpose: the client-side TaskCard imports this, so nothing
// here may reach prisma, settings or Node built-ins (the Turbopack build fails
// silently on that while tsc and the dev server stay green).

export type SourceKey =
  | "slack"
  | "aryeo"
  | "gmail"
  | "openphone"
  | "feedback"
  | "luma"
  | "team"
  | "assistant"
  | "manual"
  | "system";

export type SourceMeta = { key: SourceKey; label: string };

// Fold any raw source string into a friendly origin.
//
// `ctx` (Sep 8 audit): a photographer's field flag is minted with source
// "manual" (fieldIssues.ts) and rendered as "Shoot issue — 1946 Rowan St ·
// Added by hand", which reads as if Kyle typed it himself. When the row says
// WHO flagged it (flaggedBy, stamped by fileFieldIssue and the lightbox photo
// flags) the chip says so; a flag filed from the field before that column
// existed (sourceDetail is the /upload or /shoot page it came from) still says
// it came from the field rather than from a keyboard in the office.
export function sourceMeta(
  raw: string | null | undefined,
  ctx?: { flaggedBy?: string | null; sourceDetail?: string | null },
): SourceMeta {
  const s = (raw || "").toLowerCase();
  if (s.includes("slack")) return { key: "slack", label: "Slack" };
  if (s.includes("gmail") || s.includes("email")) return { key: "gmail", label: "Gmail" };
  if (s.includes("openphone") || s.includes("phone") || s.includes("text") || s.includes("call") || s.includes("sms"))
    return { key: "openphone", label: "OpenPhone" };
  if (s.includes("luma")) return { key: "luma", label: "Luma" };
  if (s.includes("feedback")) return { key: "feedback", label: "Feedback" };
  if (s.includes("aryeo")) return { key: "aryeo", label: "Aryeo" };
  // A teammate @-mention task (source "team").
  if (s.includes("team")) return { key: "team", label: "Team" };
  // Ask-the-Hub created task (source "assistant").
  if (s.includes("assistant") || s.includes("hub")) return { key: "assistant", label: "Assistant" };
  // "revision" / "comms" tasks came in over a conversation we couldn't pin to one
  // channel — present them as a generic message origin rather than a raw word.
  if (s.includes("revision") || s.includes("comms")) return { key: "openphone", label: "Message" };
  if (s.includes("manual")) {
    const by = ctx?.flaggedBy?.trim();
    if (by) return { key: "manual", label: `Flagged by ${by.split(/\s+/)[0]}` };
    if (/^\/(upload|shoot)\//.test(ctx?.sourceDetail ?? "")) return { key: "manual", label: "Flagged in the field" };
    return { key: "manual", label: "Added by hand" };
  }
  return { key: "system", label: "System" };
}

// WHO received the original message — the inbox/line/channel it landed on
// (Jordan Aug 25: every task should say when the message came in and who got
// it). Derived from the same sourceDetail the task creators already store:
//   gmail  → "gmail-thread:<mailbox>:<threadId>"  → the mailbox
//   slack  → "channel <name> · <ts>"              → the channel
//   openphone → all texts/calls land on the one company Quo line
export function receivedByLabel(source: string | null | undefined, sourceDetail: string | null | undefined): string | null {
  const key = sourceMeta(source).key;
  if (key === "gmail") {
    const m = sourceDetail?.match(/^gmail-thread:([^:]+@[^:]+):/);
    return m ? `${m[1]} inbox` : "email inbox";
  }
  if (key === "openphone") return "the company line";
  if (key === "slack") {
    const m = sourceDetail?.match(/^channel ([^\s·]+)/);
    return m ? `#${m[1].replace(/^#/, "")}` : "Slack";
  }
  return null;
}

// Tailwind classes per origin for the small source chip (soft bg + readable text,
// dark-theme friendly — uses the app's semantic surface/brand tokens).
export const SOURCE_CHIP: Record<SourceKey, string> = {
  slack: "bg-[#4a154b]/15 text-[#c191c4]",
  aryeo: "bg-brand/15 text-brand",
  gmail: "bg-danger/10 text-danger",
  openphone: "bg-success/10 text-success",
  feedback: "bg-warning/10 text-warning",
  luma: "bg-[#6366f1]/15 text-[#a5b4fc]",
  team: "bg-brand/10 text-brand",
  assistant: "bg-brand/10 text-brand",
  manual: "bg-surface-2 text-muted",
  system: "bg-surface-2 text-muted-2",
};

// ---------------------------------------------------------------------------
// WHAT KIND of task it is — the one label map.
//
// Sep 8 audit: three hand-kept maps (TaskCard, DoneView, the dead TodayView)
// had already drifted — "delivery" read "delivery" on the board and "Delivery
// prep" on the Done ledger. This is the single copy both surfaces read. It is
// parked here, not in a taskTypes.ts registry, because this is the one
// dependency-free task-presentation module the client TaskCard and the server
// DoneView already share; the planned TASK_TYPES registry (label, bucket, lane,
// board visibility, loop membership) should absorb it when it lands.
//
// Labels are lowercase — every surface that shows them renders uppercase via
// CSS, so one casing serves the board chip and the Done ledger alike. `bucket`
// is the Done ledger's grouping for the day recap ("3 replies · 2 QC & delivery").
// Retired types (callback, vendor_update, delivery, finish_delivery,
// appointment_prep) keep an entry: nothing mints them any more, but their rows
// are still in the 45-day Done ledger and must read as what they were.
// ---------------------------------------------------------------------------
export type TaskTypeMeta = { label: string; bucket: string };

export const TASK_TYPE_META: Record<string, TaskTypeMeta> = {
  client_reply: { label: "reply", bucket: "Replies" },
  comms_followup: { label: "job instruction", bucket: "Replies" },
  lead: { label: "new lead", bucket: "Replies" },
  confirmation_text: { label: "confirmation text", bucket: "Confirmations" },
  appointment_prep: { label: "shoot prep", bucket: "Confirmations" },
  media_qa: { label: "QC", bucket: "QC & delivery" },
  delivery: { label: "delivery", bucket: "QC & delivery" },
  finish_delivery: { label: "finish delivery", bucket: "QC & delivery" },
  delivery_text: { label: "delivery text", bucket: "QC & delivery" },
  image_fixes: { label: "photo fixes", bucket: "QC & delivery" },
  feedback_review: { label: "feedback", bucket: "QC & delivery" },
  revision: { label: "revision", bucket: "Revisions" },
  edit_video: { label: "video edit", bucket: "Revisions" },
  vendor_update: { label: "vendor update", bucket: "Vendor" },
  internal_instruction: { label: "team task", bucket: "Team" },
  todo: { label: "to-do", bucket: "Team" },
  connection_fix: { label: "connection fix", bucket: "Team" },
};

export function taskTypeMeta(taskType: string): TaskTypeMeta {
  return TASK_TYPE_META[taskType] ?? { label: taskType.replace(/_/g, " "), bucket: "Other" };
}

export function taskTypeLabel(taskType: string): string {
  return taskTypeMeta(taskType).label;
}
