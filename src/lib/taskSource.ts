// Where a task came from — a clean, normalized presentation for the source chip
// shown on every task card. The `source` column is a free string with historical
// drift (openphone-call, slack-channel, "Luma Visuals", revision, comms, …), so
// we fold all the variants into one of a few friendly origins.

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
export function sourceMeta(raw: string | null | undefined): SourceMeta {
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
  if (s.includes("manual")) return { key: "manual", label: "Added by hand" };
  return { key: "system", label: "System" };
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
