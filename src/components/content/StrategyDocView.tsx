import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// ONE STRATEGY RENDERER for the staff Strategy tab and the client's My
// Strategy page (U01, Sep 25 2026). Both used to print each section as raw
// pre-wrapped text (staff) or a generic paragraph formatter (client), so the
// brand overview's labels, the goals, the pillars with their purpose and focus
// areas, and the video framework's parts all read as one block of words.
//
// It renders the STORED SECTIONS — the document's own headings, order and
// words, which are what a person edits and what the client was released —
// and gives each line the role it already has: "Core Values: …" becomes a
// labelled row, "Pillar 2: …" opens a card, bullets and numbered lines become
// real lists, "Hook" / "Talking Point 1 - Rehook" / "Strategic Direction"
// become sub-headings. Nothing is dropped or reworded: every word of the
// section is somewhere in the blocks (the drill proves the word sequence). The
// typed StrategyDocument is not used for the body on purpose — it is a parse
// that can trail a hand edit, and the verbatim section is the truth.
//
// Hook-free and icon-free, so a server page and a client panel can both use
// it, and a drill can call strategyBlocks() without a renderer.
// ---------------------------------------------------------------------------

export type StrategyBlock =
  | { kind: "fields"; rows: { label: string; value: string }[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "subheading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "card"; title: string; blocks: StrategyBlock[] };

export type StrategyDocSection = { id: string; heading: string; text: string };

const BULLET_RE = /^\s*(?:[-•*·▪◦●]|(\d{1,2})[.)])\s+/;
const PILLAR_RE = /^pillar\s*\d+\b/i;
/** Sub-headings the house template uses inside a section (framework parts, the audience block, the section-4 tail). */
const KNOWN_SUBHEAD_RE = /^(?:target audience|hook|talking point\s*\d+\b.*|close(?:\s*\/\s*call to action)?|call to action|caption cta examples|strategic direction|context|payoff|style)(?:\s*\([^)]*\))?:?$/i;
/** "Label: value" — a short label that starts with a capital, then a value. */
const FIELD_RE = /^([A-Z][A-Za-z0-9&/'’ -]{1,38}):\s+(\S.*)$/;
/** A label alone on its line ("Brand Voice:"), its value on the lines below (PDF wraps). */
const LABEL_ONLY_RE = /^([A-Z][A-Za-z0-9&/'’ -]{1,38}):$/;

function isSubheading(line: string): boolean {
  return KNOWN_SUBHEAD_RE.test(line.trim());
}

/** The blocks of ONE section's text. Pure; no word is dropped or changed. */
export function strategyBlocks(text: string): StrategyBlock[] {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const top: StrategyBlock[] = [];
  let target = top; // where blocks go: the section, or the open pillar card
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fields: { label: string; value: string }[] | null = null;
  let open: "field" | "list" | "para" | null = null;

  const flush = () => {
    if (para.length) target.push({ kind: "paragraph", text: para.join(" ") });
    if (list?.items.length) target.push({ kind: "list", ordered: list.ordered, items: list.items });
    if (fields?.length) target.push({ kind: "fields", rows: fields });
    para = []; list = null; fields = null; open = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (open !== "field") flush(); else open = null; continue; }
    if (PILLAR_RE.test(line)) {
      flush();
      const card: StrategyBlock = { kind: "card", title: line, blocks: [] };
      top.push(card);
      target = card.blocks;
      continue;
    }
    if (isSubheading(line)) {
      flush();
      // A framework part or the section-4 tail ends a pillar card.
      target = top;
      top.push({ kind: "subheading", text: line.replace(/:$/, "") });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const ordered = !!bullet[1];
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push(line.replace(BULLET_RE, ""));
      open = "list";
      continue;
    }
    const field = FIELD_RE.exec(line) ?? (LABEL_ONLY_RE.test(line) ? [line, line.slice(0, -1), ""] as const : null);
    if (field) {
      if (list || para.length) flush();
      fields = fields ?? [];
      fields.push({ label: field[1].trim(), value: (field[2] ?? "").trim() });
      open = "field";
      continue;
    }
    // A plain line: it continues whatever is open (a wrapped value, list item
    // or paragraph); otherwise it starts a paragraph.
    if (open === "field" && fields?.length) { const last = fields[fields.length - 1]; last.value = [last.value, line].filter(Boolean).join(" "); continue; }
    if (open === "list" && list?.items.length) { list.items[list.items.length - 1] += ` ${line}`; continue; }
    if (fields || list) flush();
    para.push(line);
    open = "para";
  }
  flush();
  return top;
}

/**
 * The blocks of one SECTION. Content Goals are a list whatever the source
 * did with them: a Word export gives each goal its own paragraph with no
 * bullet, and five one-line paragraphs read as prose, not goals.
 */
export function sectionBlocks(section: StrategyDocSection): StrategyBlock[] {
  const blocks = strategyBlocks(section.text);
  const goals = section.id === "content-goals" || /content goals?$/i.test(section.heading.trim());
  if (goals && blocks.length > 1 && blocks.every((b) => b.kind === "paragraph" && b.text.length <= 240)) {
    return [{ kind: "list", ordered: false, items: blocks.map((b) => (b.kind === "paragraph" ? b.text : "")) }];
  }
  return blocks;
}

/** Every word the blocks carry, in order — for the drill's no-word-lost check. */
export function blockWords(blocks: StrategyBlock[]): string[] {
  const out: string[] = [];
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  for (const b of blocks) {
    if (b.kind === "fields") for (const r of b.rows) out.push(...words(r.label), ...words(r.value));
    else if (b.kind === "list") for (const i of b.items) out.push(...words(i));
    else if (b.kind === "subheading" || b.kind === "paragraph") out.push(...words(b.text));
    else { out.push(...words(b.title)); out.push(...blockWords(b.blocks)); }
  }
  return out;
}

function Blocks({ blocks, size }: { blocks: StrategyBlock[]; size: "sm" | "xs" }) {
  const text = size === "xs" ? "text-xs" : "text-sm";
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        if (b.kind === "fields") {
          return (
            <dl key={i} className="space-y-1.5">
              {b.rows.map((r, j) => (
                <div key={j} className="sm:grid sm:grid-cols-[11rem_1fr] sm:gap-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-2 sm:pt-0.5">{r.label}</dt>
                  <dd className={`${text} leading-relaxed text-foreground/90`}>{r.value || <span className="text-muted-2">—</span>}</dd>
                </div>
              ))}
            </dl>
          );
        }
        if (b.kind === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return (
            <Tag key={i} className={`${b.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5 marker:text-brand`}>
              {b.items.map((it, j) => <li key={j} className={`${text} leading-relaxed text-foreground/90`}>{it}</li>)}
            </Tag>
          );
        }
        if (b.kind === "subheading") return <h4 key={i} className="pt-1 text-[13px] font-semibold text-foreground">{b.text}</h4>;
        if (b.kind === "paragraph") return <p key={i} className={`${text} leading-relaxed text-foreground/85`}>{b.text}</p>;
        return (
          <div key={i} className="rounded-xl border border-border bg-surface-2/40 px-3.5 py-3">
            <h4 className="text-[14px] font-semibold text-foreground">{b.title}</h4>
            <div className="mt-2"><Blocks blocks={b.blocks} size={size} /></div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The sections of one strategy version. `collapsible` puts each in a
 * <details> (the client page and long staff versions); `openFirst` opens the
 * first one. `actions(section)` renders a row under a section — the staff
 * panel's Edit / Remove; the client page passes nothing.
 */
export function StrategyDocView({ sections, collapsible = false, openFirst = false, size = "sm", actions, empty }: {
  sections: StrategyDocSection[];
  collapsible?: boolean;
  openFirst?: boolean;
  size?: "sm" | "xs";
  actions?: (section: StrategyDocSection) => ReactNode;
  empty?: ReactNode;
}) {
  if (!sections.length) return <>{empty ?? null}</>;
  return (
    <div className="space-y-2">
      {sections.map((sec, i) => {
        const body = sec.text.trim()
          ? <Blocks blocks={sectionBlocks(sec)} size={size} />
          : <p className="text-xs text-muted-2">(empty)</p>;
        const foot = actions ? actions(sec) : null;
        if (collapsible) {
          return (
            <details key={sec.id} open={openFirst && i === 0} className="group rounded-xl border border-border bg-surface-2/30 px-4 py-3">
              <summary className="cursor-pointer text-sm font-bold text-foreground">{sec.heading}</summary>
              <div className="mt-3">{body}</div>
              {foot && <div className="mt-3 border-t border-border pt-2">{foot}</div>}
            </details>
          );
        }
        return (
          <section key={sec.id} className="rounded-xl border border-border px-4 py-3">
            <h3 className="text-[15px] font-bold text-foreground">{sec.heading}</h3>
            <div className="mt-2.5">{body}</div>
            {foot && <div className="mt-3 border-t border-border pt-2">{foot}</div>}
          </section>
        );
      })}
    </div>
  );
}
