// ---------------------------------------------------------------------------
// "UPLOAD THIS MONTH'S SCRIPTS" — the reading half (Jordan, Oct 12 2026: "a
// spot where I can manually upload the scripts for the month in case I
// scripted them manually").
//
// Pure: no database, no model, no network. It turns the text of one or more
// documents (a .docx, a PDF, a text file, a paste) into one block per script,
// each read by the house archive reader (contentPolicy.parseDeliveredScript)
// into the House Video Structure Framework: Hook · Talking Point 1 Re-hook ·
// Talking Point 2 Build up · Talking Point 3 Payoff · Close / Call to action.
//
// Two jobs, kept apart:
//   normalizeUploadText  rewrites LABEL lines only — the shorthand people type
//                        ("TP1 Rehook", "Close-CTA", "**Hook:**", "Pillar: X",
//                        "Script 2: Title", bare "Build up") into the words the
//                        archive reader already knows. A spoken line is never
//                        touched: only a line that IS a label (alone, or followed
//                        by ":" / "-") changes, and only its label part.
//   splitUploadedScripts finds where each script starts. A document in the
//                        archive's own shape ("1. Title" + "Category:", "VIDEO
//                        n — …") splits exactly as the Import tab splits it;
//                        anything else splits on its HOOK labels, each script's
//                        head (title, category) read back from the line above.
//
// Nothing here guesses words. A label it cannot place is reported in plain
// words ("isn't in the script"), and the staff preview shows every script in
// the house layout before anything is written.
// ---------------------------------------------------------------------------

import { parseDeliveredScript, splitDeliveredScripts, estimateSpokenSeconds, type CanonicalScript } from "@/lib/contentPolicy/scriptFormat";
import type { TalkingPointRole } from "@/lib/contentPolicy/policy";

export type UploadSource = { name: string; text: string };

export type UploadPoint = { role: TalkingPointRole | null; text: string };

export type ParsedUploadScript = {
  /** The file (or "Pasted text") this script came from. */
  sourceName: string;
  /** "" when the document gave this script no title. */
  title: string;
  titleFound: boolean;
  /** The script's own text with its label lines in house words (spoken words untouched). */
  text: string;
  /** The "Category:" / "Pillar:" line as written, if any. */
  categoryLabel: string | null;
  hook: string;
  points: UploadPoint[];
  close: string;
  caption: string | null;
  words: number;
  seconds: number;
  /** Plain-words notes about lines that are NOT in the script (an unknown label, text outside every part). */
  notes: string[];
};

export type UploadSplit = { scripts: ParsedUploadScript[]; preamble: string | null };

// ---- label lines -------------------------------------------------------------

const ROLE_SRC = String.raw`re[-\s]?hook|build[-\s]?up|set[-\s]?up|pay[-\s]?off|context`;
const SEP_TAIL = String.raw`\s*(?:\([^)]{0,40}\))?\s*(?:[:\-–—|]\s*(.*))?$`;

function canonRole(w: string): "RE-HOOK" | "BUILD UP" | "SET UP" | "PAYOFF" | "CONTEXT" | null {
  const k = w.toLowerCase().replace(/[^a-z]/g, "");
  if (k === "rehook") return "RE-HOOK";
  if (k === "buildup") return "BUILD UP";
  if (k === "setup") return "SET UP";
  if (k === "payoff") return "PAYOFF";
  if (k === "context") return "CONTEXT";
  return null;
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const numOf = (s: string) => NUM_WORDS[s.toLowerCase()] ?? Number(s);

/** Markdown and Word leftovers that sit around a label: "## ", "**", "__", "> ", non-breaking spaces. */
function stripDecor(line: string): string {
  return line.replace(/ /g, " ").replace(/\*\*|__/g, "").replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>\s?/, "").trim();
}

const ARCHIVE_VIDEO_HEAD = /^VIDEO\s*\d{1,2}\s*\|\s*.+$/i;
const ARCHIVE_VIDEO_TITLE = /^VIDEO\s*\d{1,2}\s*[—–-]\s*.+$/i;

/**
 * One line → its house label, or null when the line is not a label (spoken
 * text, a title, anything else). Returns sentinels for the two cases that need
 * the lines around them: "@ROLE <role>[: inline]" (a bare "Build up" — numbered
 * per script below) and "@HEAD <n>[|title]" ("Script 2" — its title may be on
 * the next line).
 */
export function labelLine(raw: string): string | null {
  const s = stripDecor(raw);
  if (!s) return null;
  let m: RegExpExecArray | null;
  const withRest = (label: string, rest: string | undefined) => (rest && rest.trim() ? `${label}: ${rest.trim()}` : label);

  if ((m = new RegExp(`^(?:the\\s+)?hook\\b${SEP_TAIL}`, "i").exec(s))) return withRest("HOOK", m[1]);

  if ((m = /^(?:tp|talking\s*point|point)\s*#?\s*([1-9]|one|two|three|four|five)\b(.*)$/i.exec(s))) {
    const n = numOf(m[1]);
    const tail = m[2];
    let t = tail.trim();
    let role: string | null = null;
    const paren = /^\(\s*([^)]{0,30})\)\s*(.*)$/.exec(t);
    if (paren) {
      role = canonRole(paren[1]);
      t = paren[2].trim();
    } else {
      const r = new RegExp(`^(?:[:\\-–—|]\\s*)?(${ROLE_SRC})\\b\\s*(.*)$`, "i").exec(t);
      if (r) { role = canonRole(r[1]); t = r[2].trim(); }
    }
    t = t.replace(/^\([^)]{0,30}\)\s*/, "");
    let rest: string;
    if (!t) rest = "";
    else {
      const sep = /^[:\-–—|]\s*(.*)$/.exec(t);
      if (!sep) return null; // "Point 1 is that…" — spoken
      rest = sep[1].trim();
    }
    return withRest(`TALKING POINT ${n}${role ? ` - ${role}` : ""}`, rest);
  }

  if ((m = new RegExp(`^(${ROLE_SRC})\\b${SEP_TAIL}`, "i").exec(s))) {
    const role = canonRole(m[1]);
    return role ? withRest(`@ROLE ${role}`, m[2]) : null;
  }

  if ((m = new RegExp(`^(close\\s*(?:[-–—/&+|]|and)?\\s*(?:cta|call\\s*to\\s*action)|callback\\s*/\\s*cta|close|cta|call\\s*to\\s*action|outro)\\b${SEP_TAIL}`, "i").exec(s))) return withRest("CLOSE / CTA", m[2]);

  if ((m = new RegExp(`^(?:optional\\s+)?caption(?:\\s*cta)?\\b${SEP_TAIL}`, "i").exec(s))) return withRest("CAPTION", m[1]);

  if ((m = /^(?:video\s+)?(?:category|pillar|content\s*pillar)\s*[:\-–—|]\s*(.+)$/i.exec(s))) return `Category: ${m[1].trim()}`;
  if ((m = /^(?:video\s+)?(?:topic|title|video\s*topic\s*title)\s*[:\-–—|]\s*(.+)$/i.exec(s))) return `Title: ${m[1].trim()}`;

  if (ARCHIVE_VIDEO_HEAD.test(s) || ARCHIVE_VIDEO_TITLE.test(s)) return null; // the archive reader's own heads
  if ((m = /^(?:script|video|reel)\s*#?\s*(\d{1,2})\b\s*(?:[:.)]\s*(.*))?$/i.exec(s))) return `@HEAD ${m[1]}${m[2]?.trim() ? `|${m[2].trim()}` : ""}`;
  if ((m = /^#\s*(\d{1,2})\b\s*[:.)\-–—]?\s*(.+)$/.exec(s))) return `@HEAD ${m[1]}|${m[2].trim()}`;
  return null;
}

/** True when the line is (or normalizes to) any label — used to keep titles from being read off labels. */
function isLabel(line: string): boolean {
  const l = labelLine(line);
  return !!l && !l.startsWith("@HEAD") && !/^(Category|Title): /.test(l);
}

/**
 * Rewrite the label lines of a whole document. Spoken lines come back exactly
 * as they went in (decoration such as "**" removed only from label lines).
 */
export function normalizeUploadText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const label = labelLine(raw);
    // Not a label: the line is kept word for word — only Markdown/Word
    // decoration ("## " before a title, "**" around a word) comes off.
    if (label == null) { out.push(raw.replace(/\*\*|__/g, "").replace(/^\s*#{1,6}\s+/, "").replace(/\s+$/, "")); continue; }
    if (label.startsWith("@HEAD ")) {
      const [n, title] = label.slice(6).split("|");
      if (title) { out.push(`${n}. ${title}`); continue; }
      // "Script 2" alone: the title is the next non-empty line, when that line is not a label.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? stripDecor(lines[j]) : "";
      if (next && !labelLine(lines[j]) && next.split(/\s+/).length <= 16) {
        out.push(`${n}. ${next}`);
        i = j;
      } else out.push(`${n}. Script ${n}`);
      continue;
    }
    out.push(label);
  }
  return out.join("\n");
}

// ---- splitting ---------------------------------------------------------------

const HOOK_LINE = /^HOOK(?:\s*:.*)?$/;
const TITLE_NUMBER = /^(\d{1,2})[.)]\s+(.+)$/;
const TITLE_LABEL = /^Title:\s*\S/;
const META_LINE = /^(Category:|CATEGORY$|Goal\s*:|(?:Video\s+Topic\s+)?Title\s*:\s*$)/i;

function patternTitle(t: string): boolean {
  return TITLE_NUMBER.test(t) || TITLE_LABEL.test(t) || ARCHIVE_VIDEO_HEAD.test(t) || ARCHIVE_VIDEO_TITLE.test(t);
}
/** A plain line that reads like a title: short, not a sentence, not a label. */
function looseTitle(t: string): boolean {
  if (t.length > 120 || t.split(/\s+/).length > 14) return false;
  if (/[.!…,;:]["”’)]?$/.test(t)) return false;
  return !isLabel(t);
}

/** Where the script whose HOOK is at `hook` starts: its title and category lines above it. */
function headStart(lines: string[], hook: number, floor: number, strict: boolean): { start: number; titled: boolean } {
  let start = hook;
  let steps = 0;
  for (let j = hook - 1; j >= floor && steps < 6; j--) {
    const t = lines[j].trim();
    if (!t) continue;
    steps++;
    if (META_LINE.test(t) || t.includes(" • ")) { start = j; continue; }
    if (patternTitle(t) || (!strict && looseTitle(t))) return { start: j, titled: true };
    break;
  }
  return { start, titled: false };
}

const countHooks = (block: string) => block.split("\n").filter((l) => HOOK_LINE.test(l.trim())).length;

/** Number bare "Re-hook / Build up / Payoff" labels as Talking Points 1-2-3 when a script has no "Talking point" labels of its own. */
function numberRoleLabels(block: string): string {
  const lines = block.split("\n");
  const hasTp = lines.some((l) => /^TALKING POINT \d/.test(l.trim()));
  let n = 0;
  return lines
    .map((l) => {
      const m = /^@ROLE ([A-Z -]+?)(?::\s*(.*))?$/.exec(l.trim());
      if (!m) return l;
      if (hasTp) return m[2] ? `${m[1]}: ${m[2]}` : m[1]; // the archive's separate block, read as such
      n++;
      return `TALKING POINT ${n} - ${m[1]}${m[2] ? `: ${m[2]}` : ""}`;
    })
    .join("\n");
}

function cleanTitle(t: string): string {
  return t
    .replace(/^(?:script|video|reel)\s*#?\s*\d{1,2}\s*[:.)\-–—|]\s*/i, "")
    .replace(/^\d{1,2}[.)]\s+/, "")
    .replace(/^["“'‘]+|["”'’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const PLACEHOLDER_TITLE = /^Script \d{1,2}$/;

/** Plain words for the reader's notes that mean "these words are not in the script". */
function notesFrom(c: CanonicalScript): string[] {
  const out: string[] = [];
  for (const w of c.parseWarnings) {
    let m: RegExpExecArray | null;
    if ((m = /^unrecognised label “(.+)”/.exec(w))) out.push(`“${m[1]}” isn't a part we know, so the lines under it aren't in the script.`);
    else if ((m = /before any labelled block: “(.+)”$/.exec(w))) out.push(`“${m[1]}…” sits outside the Hook, Talking points and Close, so it isn't in the script.`);
  }
  return out;
}

const fileTitle = (name: string) => name.replace(/\.(docx|pdf|txt|md)$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();

/** Read ONE script's text (already split). `title` overrides what the text says. */
export function readUploadedScript(text: string, opts: { title?: string | null; sourceName?: string } = {}): ParsedUploadScript {
  // Normalizing is idempotent: a block that already went through the splitter passes unchanged.
  const body = numberRoleLabels(normalizeUploadText(text)).trim();
  const c = parseDeliveredScript(body);
  const parsedTitle = cleanTitle(c.title || "");
  const titleFound = !!parsedTitle && !PLACEHOLDER_TITLE.test(parsedTitle);
  const title = (opts.title ?? "").trim() || (titleFound ? parsedTitle : "");
  const est = estimateSpokenSeconds(c);
  return {
    sourceName: opts.sourceName ?? "Pasted text",
    title, titleFound: !!title,
    text: body,
    categoryLabel: c.pillarRef?.categoryAsDelivered ?? null,
    hook: c.hook?.text ?? "",
    // The archive reader keeps separate RE-HOOK / PAYOFF blocks apart; the
    // version stores them as points (contentScripts.partsFromBody does the
    // same), so the preview counts what will be saved.
    points: [...c.points.map((p) => ({ role: p.role, text: p.text })), ...c.extraSpokenBlocks.map((b) => ({ role: b.kind === "re-hook" ? ("re-hook" as const) : b.kind === "payoff" ? ("payoff" as const) : null, text: b.text }))],
    close: c.close?.text ?? "",
    caption: c.captionCta,
    words: est.words, seconds: est.seconds,
    notes: notesFrom(c),
  };
}

/**
 * One document → its scripts. `name` is the file name (a single-script file
 * with no title line takes its name as the title).
 */
export function splitUploadedScripts(source: UploadSource): UploadSplit {
  const norm = normalizeUploadText(source.text);
  const lines = norm.split("\n");
  const hooks = lines.map((l, i) => (HOOK_LINE.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const archive = splitDeliveredScripts(norm);
  let blocks: string[];
  let preamble: string | null = null;

  if (archive.scripts.length >= 2 && archive.scripts.every((b) => countHooks(b) <= 1)) {
    // The archive's own shape — the Import tab's split, exactly.
    blocks = archive.scripts;
    preamble = archive.preamble || null;
  } else if (hooks.length >= 2) {
    // House labels without numbered heads: one script per HOOK, its head read back from above it.
    const strictProbe = hooks.map((h, k) => {
      for (let j = h - 1; j >= (k ? hooks[k - 1] + 1 : 0); j--) {
        const t = lines[j].trim();
        if (!t || META_LINE.test(t) || t.includes(" • ")) continue;
        return patternTitle(t);
      }
      return false;
    });
    const strict = strictProbe.filter(Boolean).length * 2 >= hooks.length;
    const starts = hooks.map((h, k) => headStart(lines, h, k ? hooks[k - 1] + 1 : 0, strict).start);
    preamble = lines.slice(0, starts[0]).join("\n").trim() || null;
    blocks = starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length).join("\n").trim());
  } else if (hooks.length === 1) {
    const s = headStart(lines, hooks[0], 0, false).start;
    preamble = lines.slice(0, s).join("\n").trim() || null;
    blocks = [lines.slice(s).join("\n").trim()];
  } else {
    blocks = archive.scripts.map((b) => b.trim()).filter(Boolean);
    preamble = archive.preamble || null;
  }

  const single = blocks.length === 1;
  const scripts = blocks.filter((b) => b.trim()).map((b) => {
    const r = readUploadedScript(b, { sourceName: source.name });
    if (!r.title && single && !/^pasted/i.test(source.name)) r.title = fileTitle(source.name);
    r.titleFound = !!r.title;
    return r;
  });
  return { scripts, preamble };
}

/** Is this a script at all — does it carry any of the house parts? */
export function hasScriptParts(s: Pick<ParsedUploadScript, "hook" | "points" | "close">): boolean {
  return !!s.hook.trim() || s.points.some((p) => p.text.trim()) || !!s.close.trim();
}

/** The house shape, in plain words, for the preview: what will stop approval until it's fixed. */
export function shapeProblems(s: Pick<ParsedUploadScript, "hook" | "points" | "close" | "title">): string[] {
  const out: string[] = [];
  if (!s.title.trim()) out.push("No title — add one.");
  if (!s.hook.trim()) out.push("No hook.");
  if (s.points.length !== 3) out.push(`${s.points.length} talking point${s.points.length === 1 ? "" : "s"} — the house format is 3 (Re-hook, Build up, Payoff).`);
  else {
    const want: TalkingPointRole[] = ["re-hook", "build-up", "payoff"];
    if (!s.points.every((p, i) => p.role === null || p.role === want[i])) out.push("The talking points are out of order — Re-hook, Build up, Payoff.");
  }
  if (s.points.some((p) => !p.text.trim())) out.push("A talking point is empty.");
  if (!s.close.trim()) out.push("No close.");
  return out;
}
