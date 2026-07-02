import React from "react";

// Tiny, dependency-free markdown renderer for our own controlled content
// (training summaries + SOPs): #/## headings, -/*/• bullets, 1. numbered lists,
// **bold**, and paragraphs. Not a general-purpose parser — just what we author.
function inline(text: string): React.ReactNode {
  // **bold** (matched first) and *italic*.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const lines = content.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const cls = h[1].length <= 2
        ? "mt-4 mb-1 text-sm font-semibold text-foreground first:mt-0"
        : "mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2";
      blocks.push(<p key={k++} className={cls}>{inline(h[2])}</p>);
      i++; continue;
    }

    if (/^[-*•]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*•]\s+/, "")); i++; }
      blocks.push(
        <ul key={k++} className="my-1.5 space-y-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-2" />
              <span>{inline(it)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+\.\s+/, "")); i++; }
      blocks.push(
        <ol key={k++} className="my-1.5 ml-4 list-decimal space-y-1 marker:text-muted-2">
          {items.map((it, j) => <li key={j} className="pl-1 text-sm leading-relaxed text-foreground/85">{inline(it)}</li>)}
        </ol>,
      );
      continue;
    }

    blocks.push(<p key={k++} className="my-1.5 text-sm leading-relaxed text-foreground/85">{inline(t)}</p>);
    i++;
  }
  return <div className={className}>{blocks}</div>;
}
