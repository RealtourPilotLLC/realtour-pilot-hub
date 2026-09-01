"use client";

import { useRef, useState } from "react";
import { Bold, Italic, Heading2, List, ListOrdered } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { Markdown } from "@/components/ui/Markdown";
import { cn } from "@/lib/utils";

// A dependency-free Markdown editor: formatting toolbar (bold, italic,
// heading, bullet/numbered lists) over the shared AutoTextarea, with a live
// Preview tab rendered by the same <Markdown> the rest of the hub uses — so
// what the photographer formats here is exactly what the editor sees on
// /edit and the shoot screen (Jordan, Sep 1: Script Studio scripts are
// Markdown; "Changed on site" needs real editing with bold, bullets, etc.).
export function MarkdownEditor({
  value,
  onChange,
  minRows = 5,
  maxRows = 24,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  minRows?: number;
  maxRows?: number;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");

  function apply(
    fn: (selected: string, full: string, start: number, end: number) => { text: string; selStart: number; selEnd: number },
  ) {
    setTab("write");
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const r = fn(value.slice(start, end), value, start, end);
    onChange(r.text);
    // Re-focus and restore the selection after React applies the new value.
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(r.selStart, r.selEnd);
    });
  }

  // Wrap the selection (or a placeholder word) in an inline marker. Only ever
  // called from click handlers — never during render.
  function doWrap(marker: string, fallback: string) {
    apply((sel, full, start, end) => {
      const inner = sel || fallback;
      const text = full.slice(0, start) + marker + inner + marker + full.slice(end);
      return { text, selStart: start + marker.length, selEnd: start + marker.length + inner.length };
    });
  }

  // Prefix every selected line (replacing any existing list/heading marker).
  function doLines(prefix: (i: number) => string) {
    apply((sel, full, start, end) => {
      const ls = full.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const leRaw = full.indexOf("\n", end);
      const le = leRaw === -1 ? full.length : leRaw;
      const block = full.slice(ls, le);
      let n = 0;
      const out = block
        .split("\n")
        .map((l) => (l.trim() ? prefix(n++) + l.replace(/^\s*(?:[-*•]\s+|\d+\.\s+|#{1,6}\s+)?/, "") : l))
        .join("\n");
      const text = full.slice(0, ls) + out + full.slice(le);
      return { text, selStart: ls, selEnd: ls + out.length };
    });
  }

  const btn = "rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-foreground";
  const tabBtn = (active: boolean) =>
    cn("rounded-md px-2 py-1 text-[11px] font-semibold", active ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground");
  return (
    <div className={cn("rounded-lg border border-border bg-surface", className)}>
      <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
        <button type="button" title="Bold" onClick={() => doWrap("**", "bold text")} className={btn}><Bold className="size-3.5" /></button>
        <button type="button" title="Italic" onClick={() => doWrap("*", "italic text")} className={btn}><Italic className="size-3.5" /></button>
        <button type="button" title="Heading" onClick={() => doLines(() => "## ")} className={btn}><Heading2 className="size-3.5" /></button>
        <button type="button" title="Bullet list" onClick={() => doLines(() => "- ")} className={btn}><List className="size-3.5" /></button>
        <button type="button" title="Numbered list" onClick={() => doLines((i) => `${i + 1}. `)} className={btn}><ListOrdered className="size-3.5" /></button>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" onClick={() => setTab("write")} className={tabBtn(tab === "write")}>Write</button>
          <button type="button" onClick={() => setTab("preview")} className={tabBtn(tab === "preview")}>Preview</button>
        </div>
      </div>
      {tab === "write" ? (
        <AutoTextarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          minRows={minRows}
          maxRows={maxRows}
          placeholder={placeholder}
          className="w-full rounded-b-lg bg-surface-2/60 px-3 py-2 text-sm leading-relaxed outline-none focus:bg-surface-2"
        />
      ) : (
        <div className="min-h-24 px-3 py-2">
          {value.trim() ? <Markdown content={value} /> : <p className="text-sm text-muted-2">Nothing to preview yet.</p>}
        </div>
      )}
    </div>
  );
}
