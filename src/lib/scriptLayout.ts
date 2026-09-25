// ---------------------------------------------------------------------------
// ONE SCRIPT LAYOUT (U01, unified handoff Sep 25 2026).
//
// Every surface that shows a script — the client's topic card, their Scripts
// view, the posting kit under a video, the staff review queue and the import
// preview — used to hand the stored text to ScriptBody, whose one regular
// expression knew "HOOK", "TALKING POINT 1 - RE-HOOK" and "CTA" and nothing
// else. The house renderer (contentPolicy/scriptFormat.renderScript) writes
// "Talking Point 1: Re-hook" and "Close / Call to action", so on every
// versioned script the three talking points and the close rendered as plain
// paragraphs, and a script with no pillar showed the chip "(NO PILLAR LINKED)".
//
// This module turns a script into sections, two ways:
//   · scriptBlocksFromParts — the structured path, from the version's own
//     columns (hook, points with their roles, close, caption CTA). What the
//     portal uses for every versioned script.
//   · scriptBlocksFromText — the text path, for imports and any stored body.
//     It recognises every label variant the house renderer, the archive and
//     the importer produce ("Talking Point 1 (Re-hook): …", "Close/CTA:",
//     "Hook: <inline text>", "Re-hook (as delivered)", "Optional Caption
//     CTA"…) and turns bullet lines into real lists.
//
// THE INVARIANT: presentation only. Nothing is rewritten and no word is
// dropped — only a label line changes role (it becomes a heading). Every block
// keeps the source text it came from, so layoutWords(scriptBlocksFromText(b))
// equals scriptWords(b) for any body; the drill checks it over the archive
// fixtures. "Do not fix formatting by changing the script" (handoff §5 U01).
//
// Pure: no imports beyond the pure policy module, so client components use it.
// ---------------------------------------------------------------------------

import type { TalkingPointRole } from "@/lib/contentPolicy/policy";

export type ScriptLine =
  | { kind: "para"; text: string }
  | { kind: "list"; items: { marker: string; text: string }[] }
  | { kind: "space" };

export type SectionRole = "hook" | "point" | "rehook-extra" | "payoff-extra" | "close" | "caption" | "other";

export type ScriptSection = {
  role: SectionRole;
  /** The canonical, client-facing heading ("Talking Point 1 — Re-hook"). */
  label: string;
  /** 1-based for talking points. */
  index: number | null;
  pointRole: TalkingPointRole | null;
  /** The label line exactly as the source wrote it, minus any inline text. null on the parts path. */
  sourceLabel: string | null;
  lines: ScriptLine[];
};

export type ScriptLayout = {
  title: string | null;
  /** The pillar to show as a chip — null when the script has no real pillar. */
  category: string | null;
  /** The "Category: …" line as written (kept for the word invariant; never rendered when it is a no-pillar placeholder). */
  categoryRaw: string | null;
  /** Lines before the first recognised section (imports without labels live here). */
  lead: ScriptLine[];
  sections: ScriptSection[];
};

/** The parts of a versioned script — ContentScriptVersion's columns, already client-safe. */
export type ScriptParts = {
  title?: string | null;
  hook: string;
  points: { role: TalkingPointRole | null; text: string }[];
  close: string;
  captionCta?: string | null;
};

const ROLE_LABEL: Record<TalkingPointRole, string> = { "re-hook": "Re-hook", "build-up": "Build-up", payoff: "Payoff" };

/** Loose role reading for a label fragment: "Re-hook", "REHOOK", "Build up", "Build-up", "Payoff", "Pay off". */
export function roleOf(fragment: string | null | undefined): TalkingPointRole | null {
  const k = (fragment ?? "").toLowerCase().replace(/[^a-z]+/g, "");
  if (k === "rehook") return "re-hook";
  if (k === "buildup") return "build-up";
  if (k === "payoff") return "payoff";
  return null;
}

export function pointLabel(index: number, role: TalkingPointRole | null): string {
  return role ? `Talking Point ${index} — ${ROLE_LABEL[role]}` : `Talking Point ${index}`;
}

/**
 * A category that names a real pillar, or null. "(no pillar linked)" and
 * "(no pillar)" are what the renderer and three generator fallbacks wrote
 * when nothing was linked — a placeholder, never a pillar a client should see.
 */
export function realCategory(label: string | null | undefined): string | null {
  const t = (label ?? "").trim();
  if (!t) return null;
  if (/^\(?\s*no\s+pillar/i.test(t)) return null;
  return t;
}

// ---- words, for the invariant ------------------------------------------------

/** The words of a text, lowercased, punctuation dropped. What "no word lost" is measured in. */
export function scriptWords(text: string | null | undefined): string[] {
  return ((text ?? "").toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []);
}

function lineWords(lines: ScriptLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.kind === "para") out.push(...scriptWords(l.text));
    else if (l.kind === "list") for (const it of l.items) out.push(...scriptWords(`${it.marker} ${it.text}`));
  }
  return out;
}

/** Every word the layout holds, in source order — titles, labels as written, and text. */
export function layoutWords(layout: ScriptLayout): string[] {
  return [
    ...scriptWords(layout.title),
    ...scriptWords(layout.categoryRaw),
    ...lineWords(layout.lead),
    ...layout.sections.flatMap((s) => [...scriptWords(s.sourceLabel), ...lineWords(s.lines)]),
  ];
}

/** Only the words a person SAYS: the sections' text, not titles, categories or labels. */
export function spokenLayoutWords(layout: ScriptLayout): string[] {
  return layout.sections.filter((s) => s.role !== "caption").flatMap((s) => lineWords(s.lines));
}

// ---- lines → paragraphs and lists ---------------------------------------------

const BULLET_RE = /^\s*([•●▪◦*]|[-–—]|\d{1,2}[.)])\s+(.+)$/;

function toLines(raw: string[]): ScriptLine[] {
  const out: ScriptLine[] = [];
  for (const r of raw) {
    const line = r.trimEnd();
    if (!line.trim()) {
      if (out.length && out[out.length - 1].kind !== "space") out.push({ kind: "space" });
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b) {
      const prev = out[out.length - 1];
      if (prev && prev.kind === "list") prev.items.push({ marker: b[1], text: b[2].trim() });
      else out.push({ kind: "list", items: [{ marker: b[1], text: b[2].trim() }] });
      continue;
    }
    out.push({ kind: "para", text: line.trim() });
  }
  while (out.length && out[out.length - 1].kind === "space") out.pop();
  while (out.length && out[0].kind === "space") out.shift();
  return out;
}

// ---- the structured path ------------------------------------------------------

/**
 * A versioned script's own columns → sections. The category is the CURRENT
 * pillar name the caller resolved (by pillarId), else the frozen label — and
 * never a no-pillar placeholder.
 */
export function scriptBlocksFromParts(parts: ScriptParts, opts: { pillarName?: string | null; categoryLabel?: string | null } = {}): ScriptLayout {
  const split = (t: string | null | undefined) => toLines((t ?? "").replace(/\r\n?/g, "\n").split("\n"));
  const sections: ScriptSection[] = [];
  sections.push({ role: "hook", label: "Hook", index: null, pointRole: null, sourceLabel: null, lines: split(parts.hook) });
  parts.points.forEach((p, i) => {
    sections.push({ role: "point", label: pointLabel(i + 1, p.role), index: i + 1, pointRole: p.role, sourceLabel: null, lines: split(p.text) });
  });
  sections.push({ role: "close", label: "Close / CTA", index: null, pointRole: null, sourceLabel: null, lines: split(parts.close) });
  if (parts.captionCta && parts.captionCta.trim()) sections.push({ role: "caption", label: "Caption CTA (optional)", index: null, pointRole: null, sourceLabel: null, lines: split(parts.captionCta) });
  const category = realCategory(opts.pillarName) ?? realCategory(opts.categoryLabel);
  return { title: parts.title?.trim() || null, category, categoryRaw: category, lead: [], sections };
}

// ---- the text path ------------------------------------------------------------

type LabelHit = { role: SectionRole; index: number | null; pointRole: TalkingPointRole | null; sourceLabel: string; inline: string | null };

/** Markdown emphasis and heading marks around a label ("**Hook:**", "## CLOSE"). */
const unwrap = (s: string) => s.replace(/^#{1,4}\s+/, "").replace(/^\*\*(.+?)\*\*\s*/, "$1 ").replace(/^__(.+?)__\s*/, "$1 ").trim();

/**
 * Is this line a section label? A label is the WHOLE line ("HOOK", "Close /
 * Call to action") or a label followed by a colon and inline text ("Hook: The
 * first weekend…"). A spoken sentence that merely starts with the word
 * ("Close the deal before…", "Hook them early") is never a label: without a
 * colon, anything after the label word refuses the match.
 */
export function readLabel(line: string): LabelHit | null {
  const t = unwrap(line);
  if (!t || t.length > 160) return null;
  let m: RegExpExecArray | null;

  // Hook
  if ((m = /^hook\s*(?:[:：]\s*(.*))?$/i.exec(t))) {
    const inline = m[1]?.trim() || null;
    return { role: "hook", index: null, pointRole: null, sourceLabel: inline ? t.slice(0, t.length - inline.length).trim() : t, inline };
  }

  // Talking Point n — with ":", "-", "–", "—" or "(role)", optional inline text.
  if ((m = /^talking\s*point\s*(\d{1,2})\b\s*(.*)$/i.exec(t))) {
    const index = Number(m[1]);
    let rest = m[2].trim();
    let role: TalkingPointRole | null = null;
    let inline: string | null = null;
    if (!rest) {
      // bare "Talking Point 2"
    } else if (rest.startsWith("(")) {
      const close = rest.indexOf(")");
      if (close < 0) return null;
      role = roleOf(rest.slice(1, close));
      if (!role) return null;
      rest = rest.slice(close + 1).trim();
      if (rest) {
        if (!/^[:：\-–—]/.test(rest)) return null;
        inline = rest.replace(/^[:：\-–—]\s*/, "").trim() || null;
      }
    } else if (/^[:：\-–—]/.test(rest)) {
      const after = rest.replace(/^[:：\-–—]\s*/, "");
      const colon = after.search(/[:：]/);
      const head = colon >= 0 ? after.slice(0, colon) : after;
      const headRole = roleOf(head);
      if (headRole && head.trim().split(/\s+/).length <= 2) {
        role = headRole;
        inline = colon >= 0 ? after.slice(colon + 1).trim() || null : null;
      } else {
        inline = after.trim() || null;
      }
    } else {
      return null;
    }
    const sourceLabel = inline ? t.slice(0, t.length - inline.length).replace(/\s+$/, "") : t;
    return { role: "point", index, pointRole: role, sourceLabel, inline };
  }

  // Archive-only spoken RE-HOOK / PAYOFF blocks ("Re-hook (as delivered)", "PAYOFF:")
  if ((m = /^(re-?\s?hook|pay-?\s?off)\s*(\(as delivered\))?\s*(?:[:：]\s*(.*))?$/i.exec(t))) {
    const inline = m[3]?.trim() || null;
    const r = roleOf(m[1]);
    return { role: r === "re-hook" ? "rehook-extra" : "payoff-extra", index: null, pointRole: r, sourceLabel: inline ? t.slice(0, t.length - inline.length).trim() : t, inline };
  }

  // Close / CTA and its variants
  if ((m = /^(close(?:\s*\/\s*(?:call\s+to\s+action|cta))?|callback(?:\s*\/\s*cta)?|call\s+to\s+action|cta|outro)\s*(?:[:：]\s*(.*))?$/i.exec(t))) {
    const inline = m[2]?.trim() || null;
    return { role: "close", index: null, pointRole: null, sourceLabel: inline ? t.slice(0, t.length - inline.length).trim() : t, inline };
  }

  // Caption CTA (optional)
  if ((m = /^((?:optional\s+)?caption(?:\s+cta)?(?:\s*\(optional\))?)\s*(?:[:：]\s*(.*))?$/i.exec(t))) {
    const inline = m[2]?.trim() || null;
    return { role: "caption", index: null, pointRole: null, sourceLabel: inline ? t.slice(0, t.length - inline.length).trim() : t, inline };
  }

  // INTRO — a section with no canonical role
  if ((m = /^(intro)\s*(?:[:：]\s*(.*))?$/i.exec(t))) {
    const inline = m[2]?.trim() || null;
    return { role: "other", index: null, pointRole: null, sourceLabel: inline ? t.slice(0, t.length - inline.length).trim() : t, inline };
  }
  return null;
}

const CATEGORY_RE = /^(?:video\s+)?category\s*[:：]\s*(.*)$/i;

function labelFor(hit: LabelHit): string {
  switch (hit.role) {
    case "hook": return "Hook";
    case "point": return pointLabel(hit.index ?? 1, hit.pointRole);
    case "rehook-extra": return "Re-hook (as delivered)";
    case "payoff-extra": return "Payoff (as delivered)";
    case "close": return "Close / CTA";
    case "caption": return "Caption CTA (optional)";
    default: return hit.sourceLabel.replace(/[:：]\s*$/, "");
  }
}

/**
 * Any stored script body → sections. A first line followed by a category or
 * a section label is the title; every recognised label line becomes a
 * heading; everything else stays exactly where it was.
 */
export function scriptBlocksFromText(body: string): ScriptLayout {
  const lines = (body ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  let title: string | null = null;
  let categoryRaw: string | null = null;
  let category: string | null = null;

  // Title: the first non-empty line, when the NEXT non-empty line is a
  // category or a label — i.e. the body is a structured script. An unlabelled
  // import's first spoken line is never promoted to a title.
  if (i < lines.length && !CATEGORY_RE.test(lines[i].trim()) && !readLabel(lines[i])) {
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && lines[i].trim().length <= 160 && (CATEGORY_RE.test(lines[j].trim()) || readLabel(lines[j]))) {
      title = lines[i].trim();
      i++;
    }
  }

  const lead: string[] = [];
  const sections: { hit: LabelHit; raw: string[] }[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const cat = CATEGORY_RE.exec(trimmed);
    if (cat && categoryRaw === null && sections.length === 0) {
      categoryRaw = trimmed;
      category = realCategory(cat[1]);
      continue;
    }
    const hit = readLabel(line);
    if (hit) {
      sections.push({ hit, raw: hit.inline ? [hit.inline] : [] });
      continue;
    }
    if (sections.length) sections[sections.length - 1].raw.push(line);
    else lead.push(line);
  }
  return {
    title,
    category,
    categoryRaw,
    lead: toLines(lead),
    sections: sections.map(({ hit, raw }) => ({ role: hit.role, label: labelFor(hit), index: hit.index, pointRole: hit.pointRole, sourceLabel: hit.sourceLabel, lines: toLines(raw) })),
  };
}

/** A plain-text rendering of a layout — what "Download" writes when no exact stored text is handed over. */
export function layoutToText(layout: ScriptLayout): string {
  const out: string[] = [];
  if (layout.title) out.push(layout.title);
  if (layout.category) out.push(`Category: ${layout.category}`);
  const put = (lines: ScriptLine[]) => {
    for (const l of lines) {
      if (l.kind === "para") out.push(l.text);
      else if (l.kind === "list") for (const it of l.items) out.push(`${it.marker} ${it.text}`);
      else out.push("");
    }
  };
  put(layout.lead);
  for (const s of layout.sections) {
    out.push("", s.label);
    put(s.lines);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
