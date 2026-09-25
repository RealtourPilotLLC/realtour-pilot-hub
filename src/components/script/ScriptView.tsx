"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { realCategory, scriptBlocksFromParts, scriptBlocksFromText, type ScriptLine, type ScriptParts } from "@/lib/scriptLayout";

// ---------------------------------------------------------------------------
// THE ONE SCRIPT RENDERER (U01). Every script surface — the client's topic
// card and Scripts view, the posting kit under a video, the staff review
// queue, the import preview — draws a script through this, so a Hook, three
// Talking Points and the Close look the same everywhere: bold headings, the
// same spacing, real lists, and a category chip only when a real pillar exists.
//
// Pure presentation. The layout comes from src/lib/scriptLayout.ts, which
// never rewrites or drops a word; Copy and Download hand over the EXACT stored
// text the caller passed in `body`, not a re-rendering of it.
//
// `parts` (the version's own columns) is preferred when the caller has them;
// otherwise the stored body is read with the label-tolerant text parser.
// ---------------------------------------------------------------------------

export type ScriptViewProps = {
  /** The exact stored text — rendered when no parts are given, and what Copy / Download hand over. */
  body: string;
  parts?: ScriptParts | null;
  /** The pillar's CURRENT name (resolved by id); falls back to the category in the text. */
  pillarName?: string | null;
  size?: "sm" | "xs";
  /** "staff" also marks a script that has no pillar; the client never sees that note. */
  audience?: "client" | "staff";
  /** Copy + Download (default on). */
  actions?: boolean;
  /** The script's title is usually the card's heading already. */
  showTitle?: boolean;
  /** For the downloaded file's name. */
  fileTitle?: string | null;
};

function Lines({ lines, textCls }: { lines: ScriptLine[]; textCls: string }) {
  return (
    <>
      {lines.map((l, i) =>
        l.kind === "space" ? (
          <div key={i} className="h-1.5" aria-hidden />
        ) : l.kind === "list" ? (
          <ul key={i} className={cn("my-0.5 list-disc space-y-0.5 pl-5 leading-relaxed text-foreground/90 marker:text-muted-2", textCls)}>
            {l.items.map((it, j) => <li key={j} className="break-words">{it.text}</li>)}
          </ul>
        ) : (
          <p key={i} className={cn("break-words leading-relaxed text-foreground/90", textCls)}>{l.text}</p>
        ),
      )}
    </>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "script";

export function ScriptView({ body, parts, pillarName, size = "sm", audience = "client", actions = true, showTitle = false, fileTitle }: ScriptViewProps) {
  const layout = useMemo(
    () => {
      if (!parts) return scriptBlocksFromText(body);
      // The chip names the CURRENT pillar when the caller resolved one, else
      // whatever category the stored text carries (never a no-pillar placeholder).
      const fromText = scriptBlocksFromText(body);
      return scriptBlocksFromParts(parts, { pillarName, categoryLabel: fromText.category });
    },
    [body, parts, pillarName],
  );
  const category = parts ? layout.category : (realCategory(pillarName) ?? layout.category);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const textCls = size === "xs" ? "text-xs" : "text-sm";
  const headCls = size === "xs" ? "text-[11px]" : "text-xs";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied(null), 2000);
  };
  const download = () => {
    const blob = new Blob([body.endsWith("\n") ? body : `${body}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(fileTitle ?? layout.title ?? "script")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="mt-2">
      {(category || audience === "staff" || actions) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {category ? (
            <span className="inline-block max-w-full truncate rounded-md bg-brand-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">{category}</span>
          ) : audience === "staff" ? (
            <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-2">No pillar linked</span>
          ) : null}
          {actions && (
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={copy}
                className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                aria-label="Copy the script"
              >
                {copied === "ok" ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                {copied === "ok" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
              </button>
              <button
                type="button"
                onClick={download}
                className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                aria-label="Download the script as a text file"
              >
                <Download className="size-3" /> Download
              </button>
            </span>
          )}
        </div>
      )}
      <span role="status" className="sr-only">{copied === "ok" ? "Script copied" : copied === "failed" ? "The script could not be copied" : ""}</span>
      {showTitle && layout.title && <div className={cn("mb-1 font-semibold", textCls)}>{layout.title}</div>}
      {layout.lead.length > 0 && <Lines lines={layout.lead} textCls={textCls} />}
      {layout.sections.map((s, i) => (
        <section key={i} className={cn(i > 0 || layout.lead.length ? "mt-3" : "")} aria-label={s.label}>
          <h4 className={cn("mb-1 font-bold uppercase tracking-wider text-brand", headCls)}>{s.label}</h4>
          {s.lines.length ? <Lines lines={s.lines} textCls={textCls} /> : <p className={cn("italic text-muted-2", textCls)}>(empty)</p>}
        </section>
      ))}
    </div>
  );
}
