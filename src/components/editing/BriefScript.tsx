"use client";

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { scriptBlocksFromText, type ScriptLine } from "@/lib/scriptLayout";

// ---------------------------------------------------------------------------
// THE SCRIPT, AS THE EDITOR NEEDS IT (Oct 5 2026) — section 3 of the video's
// brief. The approved words exactly as stored (never money-scrubbed: a
// real-estate script talks about prices), laid out by the one script layout
// (lib/scriptLayout), with ONE copy button that hands over the exact text for
// the captions. A section the writer left blank is simply not drawn — the old
// card printed "(empty)" under a Hook heading, which read as "the hook is
// missing" rather than "there is no separate hook".
// ---------------------------------------------------------------------------

function Lines({ lines }: { lines: ScriptLine[] }) {
  return (
    <>
      {lines.map((l, i) =>
        l.kind === "space" ? null : l.kind === "list" ? (
          <ul key={i} className="my-0.5 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-foreground/90">
            {l.items.map((it, j) => <li key={j} className="break-words">{it.text}</li>)}
          </ul>
        ) : (
          <p key={i} className="break-words text-sm leading-relaxed text-foreground/90">{l.text}</p>
        ),
      )}
    </>
  );
}

const hasWords = (lines: ScriptLine[]) => lines.some((l) => (l.kind === "para" && l.text.trim()) || (l.kind === "list" && l.items.some((it) => it.text.trim())));

export function BriefScript({ body, parts }: {
  /** The exact stored words — what Copy hands over. */
  body: string;
  /** Already-named parts (the Studio reel script's Hook / Script), drawn as
   *  they are instead of re-reading `body`. Empty parts are left out. */
  parts?: { label: string; text: string }[] | null;
}) {
  const layout = useMemo(() => {
    if (!parts) return scriptBlocksFromText(body);
    return {
      title: null, category: null, categoryRaw: null, lead: [] as ScriptLine[],
      sections: parts.filter((p) => p.text.trim()).map((p) => ({ role: "other" as const, label: p.label, index: null, pointRole: null, sourceLabel: null, lines: p.text.split("\n").map((t): ScriptLine => (t.trim() ? { kind: "para", text: t.trim() } : { kind: "space" })) })),
    };
  }, [body, parts]);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const sections = layout.sections.filter((s) => hasWords(s.lines));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied(null), 2000);
  };
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {layout.category && <span className="max-w-full truncate rounded-md bg-brand-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">{layout.category}</span>}
        <button
          type="button"
          onClick={copy}
          className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
          aria-label="Copy the script"
        >
          {copied === "ok" ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          {copied === "ok" ? "Copied" : copied === "failed" ? "Couldn't copy — select the text" : "Copy script"}
        </button>
      </div>
      <span role="status" className="sr-only">{copied === "ok" ? "Script copied" : copied === "failed" ? "The script could not be copied" : ""}</span>
      {hasWords(layout.lead) && <Lines lines={layout.lead} />}
      {sections.map((s, i) => (
        <section key={i} className={i > 0 || hasWords(layout.lead) ? "mt-3" : ""} aria-label={s.label}>
          <h4 className="mb-1 text-xs font-bold uppercase tracking-wider text-brand">{s.label}</h4>
          <Lines lines={s.lines} />
        </section>
      ))}
    </div>
  );
}
