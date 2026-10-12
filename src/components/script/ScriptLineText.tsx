import { cn } from "@/lib/utils";
import { lineShape } from "@/lib/scriptLayout";

// ---------------------------------------------------------------------------
// ONE LINE OF A SCRIPT, as it reads (Oct 12 2026). Skits are kept as written:
// "JOE: “…”" speaker lines, [stage directions], [SCENE HEADINGS] and [EDIT
// CUES]. Here the speaker is set in bold, a direction in muted italics and a
// heading as a small capitalised sub-heading, so the client's portal and the
// editor's brief read like a scene. Words are the line's own; nothing is
// dropped (a heading only loses its brackets on screen — Copy hands over the
// stored text).
// ---------------------------------------------------------------------------
export function ScriptLineText({ text, className }: { text: string; className?: string }) {
  const s = lineShape(text);
  if (s.kind === "heading") {
    return <p className={cn("mt-1.5 break-words font-semibold uppercase tracking-wide text-muted", className, "text-[0.8em]")}>{s.text.replace(/^\[|\]$/g, "")}</p>;
  }
  return (
    <p className={cn("break-words leading-relaxed", s.kind === "direction" ? "italic text-muted" : "text-foreground/90", className)}>
      {s.speaker && <span className="font-semibold not-italic text-foreground">{s.speaker}: </span>}
      {s.text}
    </p>
  );
}
