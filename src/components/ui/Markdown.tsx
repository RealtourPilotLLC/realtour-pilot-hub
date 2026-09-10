import React from "react";

// Tiny, dependency-free markdown renderer for our own controlled content
// (training summaries + SOPs): #/## headings, -/*/• bullets, 1. numbered lists,
// **bold**, and paragraphs. Not a general-purpose parser — just what we author.
// A bare URL becomes a link (the editor brief carries an example reel:
// "Example: https://media.realtourpilot.com/videos/…" — Jordan, Sep 10). A
// trailing period/comma stays outside the link.
function linkify(text: string): React.ReactNode {
  const bits = text.split(/(https?:\/\/[^\s<>()]+)/g);
  if (bits.length === 1) return text;
  return bits.map((b, i) => {
    if (!/^https?:\/\/[^\s<>()]+$/.test(b)) return <React.Fragment key={i}>{b}</React.Fragment>;
    const m = b.match(/^(.*?)([.,;:!?]*)$/) as RegExpMatchArray;
    return (
      <React.Fragment key={i}>
        <a href={m[1]} target="_blank" rel="noreferrer" className="break-all text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand">{m[1]}</a>
        {m[2]}
      </React.Fragment>
    );
  });
}

function inline(text: string): React.ReactNode {
  // **bold** (matched first) and *italic*.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i} className="font-semibold text-foreground">{linkify(p.slice(2, -2))}</strong>;
    if (/^\*[^*]+\*$/.test(p)) return <em key={i}>{linkify(p.slice(1, -1))}</em>;
    return <React.Fragment key={i}>{linkify(p)}</React.Fragment>;
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

    // Horizontal rule.
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) {
      blocks.push(<hr key={k++} className="my-3 border-border" />);
      i++; continue;
    }

    // Blockquote (e.g. an executive summary callout).
    if (/^>\s?/.test(t)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { quote.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
      blocks.push(
        <blockquote key={k++} className="my-2 border-l-2 border-brand/50 bg-surface-2/50 px-3 py-2 text-sm leading-relaxed text-foreground/85">
          {inline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // Pipe table: header row, |---| separator, data rows.
    if (t.startsWith("|") && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes("-")) {
      const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = cells(t);
      i += 2; // skip separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(cells(lines[i].trim())); i++; }
      blocks.push(
        <div key={k++} className="my-2 overflow-x-auto scroll-thin">
          <table className="w-full min-w-[20rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-2">
                {header.map((c, j) => <th key={j} className={`px-2 py-1.5 font-medium ${j > 0 ? "text-right" : ""}`}>{inline(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border/50 last:border-0">
                  {r.map((c, j) => <td key={j} className={`px-2 py-1.5 tabular-nums ${j > 0 ? "text-right" : ""} text-foreground/85`}>{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // A line that is nothing but **bold** is how people write a section
    // heading in a note ("**STORY / EDIT FLOW**", "**AI CLIPS NEEDED**") —
    // render it as one instead of a bold paragraph (Jordan, Sep 10).
    const boldLine = t.match(/^\*\*([^*]+)\*\*:?$/);
    if (boldLine) {
      blocks.push(<p key={k++} className="mt-4 mb-1 text-sm font-semibold text-foreground first:mt-0">{inline(boldLine[1])}</p>);
      i++; continue;
    }

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
