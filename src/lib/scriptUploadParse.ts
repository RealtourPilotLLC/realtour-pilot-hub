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
//
// SKITS (Jordan, Oct 12 2026, Joe Sutow's October PDF: "his are written in a
// different way … upload it as written"). A script written as a scene —
// speaker labels on their own line (JOE, "JAMES — INTERVIEWER"), [stage
// directions], edit cues (CUT TO SHARK REACTION), several BUILD UP scenes and
// a SECOND REHOOK — is read by readSkitScript, which keeps EVERY line where
// the document put it: Hook = HOOK, Talking point 1 = REHOOK, Talking point 2
// = every BUILD UP scene and any second re-hook in order, Talking point 3 =
// PAYOFF, Close = CLOSE. A speaker label goes in front of the line it
// introduces ("JOE: “…”"); directions and cues stay in [brackets]; scene
// headings stay as [BUILD UP, SCENE 1: LENDER]. Labels and headings lose their
// dashes ("JAMES (INTERVIEWER)"); spoken words are never touched here.
// checkAsWritten then compares, word for word, what the document says with
// what the script holds, so a dropped or added word is shown to a person.
// ---------------------------------------------------------------------------

import { parseDeliveredScript, splitDeliveredScripts, estimateSpokenSeconds, isStageDirectionLine, type CanonicalScript } from "@/lib/contentPolicy/scriptFormat";
import { countSpokenWords, GENERATION_POLICY, type TalkingPointRole } from "@/lib/contentPolicy/policy";

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
  /** "skit": read line by line as written (speakers, directions, scenes); "house": the archive reader. */
  format: ScriptFormat;
  /** The document's "Purpose:" / "Goal:" line. */
  goal: string | null;
  /** The document's "Topic:" line (a skit's title is its name, the topic is what it teaches). */
  topic: string | null;
  /** The quality-dimension line ("Pillars: Credibility + Entertainment | Trust + Value") — never the content pillar. */
  dimensions: string | null;
  /** Speaker labels as the script now writes them ("JOE", "JAMES (INTERVIEWER)"). */
  speakers: string[];
  /** Stage directions and edit cues kept in the script (never spoken, never timed). */
  directions: number;
  /** The document's own lines for this script — what checkAsWritten compares against. Null when read from a list the staff shaped. */
  sourceBlock: string | null;
};

export type ScriptFormat = "house" | "skit";

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
export function readUploadedScript(text: string, opts: { title?: string | null; sourceName?: string; asWritten?: boolean } = {}): ParsedUploadScript {
  const cleaned = cleanUploadText(text);
  if (opts.asWritten || looksLikeSkit(cleaned)) {
    const r = readSkitScript(cleaned, { sourceName: opts.sourceName });
    const title = (opts.title ?? "").trim();
    return { ...r, title: title || r.title, titleFound: !!(title || r.title), sourceBlock: null };
  }
  // Normalizing is idempotent: a block that already went through the splitter passes unchanged.
  const body = numberRoleLabels(normalizeUploadText(cleaned)).trim();
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
    format: "house", goal: c.internal.goal, topic: null, dimensions: null,
    speakers: c.internal.speakerLabels, directions: 0, sourceBlock: null,
  };
}

/**
 * One document → its scripts. `name` is the file name (a single-script file
 * with no title line takes its name as the title).
 */
export function splitUploadedScripts(source: UploadSource): UploadSplit {
  const cleaned = cleanUploadText(source.text);
  if (looksLikeSkit(cleaned)) {
    // Skits: split and read the document's own lines (labels are not rewritten first).
    const lines = unwrapLines(cleaned.split("\n"));
    const sk = splitSkitDocument(lines) ?? { blocks: [lines.join("\n")], preamble: "" };
    const blocks = sk.blocks.filter((b) => b.trim());
    const scripts = blocks.map((b) => {
      const r = readSkitScript(b, { sourceName: source.name, source: true });
      if (!r.title && blocks.length === 1 && !/^pasted/i.test(source.name)) r.title = fileTitle(source.name);
      r.titleFound = !!r.title;
      return r;
    });
    return { scripts, preamble: sk.preamble.trim() || null };
  }
  const norm = normalizeUploadText(cleaned);
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

// ---------------------------------------------------------------------------
// SKITS, read as written (Oct 12 2026 — see the note at the top).
// ---------------------------------------------------------------------------

/** pdf-parse's page separators ("-- 1 of 6 --"), form feeds and non-breaking spaces out; nothing else changes. */
const PAGE_MARK = /^\s*-{1,3}\s*(?:page\s*)?\d{1,3}\s*(?:of|\/)\s*\d{1,3}\s*-{1,3}\s*$/i;
export function cleanUploadText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n").replace(/ /g, " ").split("\n").filter((l) => !PAGE_MARK.test(l)).join("\n");
}

const DASH_CLASS = "\\u2012-\\u2015";
const SPACED_DASH = new RegExp(`\\s*[${DASH_CLASS}]\\s*|\\s+-{1,2}\\s+`, "g");

/** A scene or beat heading, dashes out: "BUILD UP — SCENE 1: LENDER" → "BUILD UP, SCENE 1: LENDER". */
export function cleanHeading(raw: string): string {
  return stripDecor(raw).replace(/^\[|\]$/g, "").replace(/\s*:\s*$/, "").replace(SPACED_DASH, ", ").replace(/,\s*,/g, ",").replace(/\s+/g, " ").trim();
}

/** A speaker label, dashes out: "JAMES — INTERVIEWER" → "JAMES (INTERVIEWER)"; "JOE" stays "JOE". */
export function cleanSpeakerLabel(raw: string): string {
  const s = stripDecor(raw).replace(/\s*:\s*$/, "").replace(/\s+/g, " ").trim();
  if (!/[()]/.test(s)) {
    const m = new RegExp(`^(.+?)\\s*(?:[${DASH_CLASS}]|\\s-{1,2}\\s|,)\\s*(.+)$`).exec(s);
    if (m) return `${m[1].trim()} (${m[2].replace(SPACED_DASH, ", ").trim()})`;
  }
  return s.replace(SPACED_DASH, ", ");
}

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor", "of", "on", "or", "over", "the", "to", "vs", "with"]);
const ACRONYMS = new Set(["FHA", "VA", "HOA", "MLS", "ADU", "FAQ", "CTA", "USA", "DIY", "ROI", "LLC", "HVAC", "FSBO", "ARM", "USDA", "PMI", "DOM", "ARV", "TV", "AI"]);
/** A title written in capitals reads as a name: "THE POSTGAME INTERVIEW" → "The Postgame Interview". Anything with a lower-case letter is left exactly as written. */
export function titleCaseIfShouting(t: string): string {
  if (/[a-z]/.test(t) || !/[A-Z]/.test(t)) return t;
  let first = true;
  let afterColon = false;
  return t.split(/(\s+)/).map((w) => {
    if (!w || /^\s+$/.test(w)) return w;
    const bare = w.replace(/[^A-Za-z']/g, "");
    let out: string;
    if (ACRONYMS.has(bare)) out = w;
    else if (!first && !afterColon && SMALL_WORDS.has(bare.toLowerCase())) out = w.toLowerCase();
    else out = w.toLowerCase().replace(/^([^a-z]*)([a-z])/, (_m, p: string, c: string) => p + c.toUpperCase());
    first = false;
    afterColon = /[:!?]$/.test(w);
    return out;
  }).join("");
}

type SkitPart = "hook" | "rehook" | "build" | "payoff" | "close" | "caption";
type SectionHit = { part: SkitPart | "same"; sub: string | null; inline: string | null; tp: number | null };

const ROLE_PART: Record<string, SkitPart> = { "RE-HOOK": "rehook", "BUILD UP": "build", "SET UP": "build", CONTEXT: "build", PAYOFF: "payoff" };
const TP_PART: SkitPart[] = ["rehook", "build", "payoff"];

/** "SECOND REHOOK: And here's…" → the heading and the spoken words after it (only when they read as words, not more heading). */
function headWithInline(s: string, tail: string): { head: string; inline: string | null } {
  const t = tail.trim();
  const m = new RegExp(`^[:|${DASH_CLASS}-]+\\s*(.+)$`).exec(t);
  if (m && /[a-z]/.test(m[1])) return { head: s.slice(0, s.length - tail.length).trim(), inline: m[1].trim() };
  return { head: s, inline: null };
}

/**
 * Is this line one of the five parts' labels (or a scene heading inside one)?
 * A bracketed line is a heading only when it names a scene, a build-up beat or
 * a second re-hook ("[BUILD UP, SCENE 1: LENDER]") — any other bracket is a
 * direction. A spoken sentence that starts like a label ("Build up your
 * savings first.") is not one.
 */
export function sectionOf(raw: string): SectionHit | null {
  const bracketed = /^\s*\[(.*)\]\s*$/.exec(raw);
  const s = stripDecor(bracketed ? bracketed[1] : raw);
  if (!s || s.length > 90) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(?:second|2nd|another|mid|middle|extra)[\s-]+re[-\s]?hook\b(.*)$/i.exec(s)) || (m = /^re[-\s]?hook\s*#?\s*(?:2|two)\b(.*)$/i.exec(s))) {
    const { head, inline } = headWithInline(s, m[1]);
    return { part: "build", sub: cleanHeading(head), inline: bracketed ? null : inline, tp: null };
  }
  if ((m = /^build[-\s]?up\b\s*(.*)$/i.exec(s))) {
    const rest = m[1].trim();
    if (!rest) return { part: "build", sub: bracketed ? cleanHeading(s) : null, inline: null, tp: null };
    const after = new RegExp(`^(?:[,:|${DASH_CLASS}-]+|(?=\\())\\s*(.*)$`).exec(rest);
    if (!after) return null; // "Build up your savings first." — spoken
    if (bracketed || rest.startsWith("(") || /^(?:scene|part|beat|act|#?\d|one|two|three)\b/i.test(after[1])) return { part: "build", sub: cleanHeading(s), inline: null, tp: null };
    return { part: "build", sub: null, inline: after[1].trim() || null, tp: null };
  }
  if ((m = /^(?:scene|beat|act)\s*#?\s*(\d{1,2}|one|two|three|four|five|six)\b(.*)$/i.exec(s))) {
    const tail = m[2].trim();
    if (tail && !new RegExp(`^[:,.(${DASH_CLASS}-]`).test(tail)) return null;
    return { part: "same", sub: cleanHeading(s), inline: null, tp: null };
  }
  if (bracketed) return null;
  const l = labelLine(s);
  if (!l || l.startsWith("@HEAD") || /^(Category|Title): /.test(l)) return null;
  const im = /^([\s\S]*?)(?::\s([\s\S]*))?$/.exec(l);
  const label = (im?.[1] ?? l).trim();
  const inline = im?.[2]?.trim() || null;
  if (label === "HOOK") return { part: "hook", sub: null, inline, tp: null };
  if (label.startsWith("CLOSE")) return { part: "close", sub: null, inline, tp: null };
  if (label === "CAPTION") return { part: "caption", sub: null, inline, tp: null };
  let r: RegExpExecArray | null;
  if ((r = /^@ROLE (.+)$/.exec(label))) return ROLE_PART[r[1]] ? { part: ROLE_PART[r[1]], sub: null, inline, tp: null } : null;
  if ((r = /^TALKING POINT (\d+)(?: - (.+))?$/.exec(label))) {
    const n = Number(r[1]);
    const part = r[2] ? ROLE_PART[r[2]] : TP_PART[n - 1];
    return { part: part ?? "payoff", sub: null, inline, tp: part ? null : n };
  }
  return null;
}

const startsPart = (line: string): boolean => {
  const h = sectionOf(line);
  return !!h && h.part !== "same" && !/^\s*\[/.test(line);
};

const CUE_RE = /^(?:SMASH\s+CUT|JUMP\s+CUT|MATCH\s+CUT|HARD\s+CUT|QUICK\s+CUT|CUT(?:\s+(?:TO|BACK|AWAY|IN))?|FADE(?:\s+(?:IN|OUT|TO))?|DISSOLVE|WIPE|B[-\s]?ROLL|INSERT|SFX|MUSIC|TITLE\s+CARD|END\s+CARD|TEXT\s+ON\s+SCREEN|ON[-\s]SCREEN(?:\s+TEXT)?|SUPER|FREEZE(?:\s+FRAME)?|SLOW[-\s]?MO(?:TION)?|ZOOM|TRANSITION|MONTAGE|FLASHBACK|INTERCUT|SPLIT\s+SCREEN|GRAPHIC|LOWER\s+THIRD)\b/;
/** An edit or camera cue written as its own capitalised line ("CUT TO SHARK REACTION"). */
export function isCue(line: string): boolean {
  const s = stripDecor(line);
  return !!s && s.length <= 90 && !/[a-z]/.test(s.replace(/\([^)]*\)/g, "")) && CUE_RE.test(s);
}

const META_RE = new RegExp(`^(purpose|goal|objective|topic|video\\s+topic|angle|concept|pillars?|content\\s+pillars?|category|dimensions?|quality\\s+dimensions?|title)\\s*[:|${DASH_CLASS}-]\\s*(.*)$`, "i");
const NAME_TOKEN = "[A-Z][A-Z0-9.'’&]*";
const NAME = `${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){0,3}`;
const SPEAKER_CORE = `${NAME}(?:\\s*(?:[${DASH_CLASS}]|\\s-{1,2}\\s|,)\\s*${NAME})?(?:\\s*\\([^()]{1,30}\\))?`;
const SPEAKER_ALONE_RE = new RegExp(`^(${SPEAKER_CORE})\\s*:?$`);
const INLINE_SPEAKER_RE = new RegExp(`^(${SPEAKER_CORE})\\s*:\\s+(\\S.*)$`);
const NOT_SPEAKERS = /^(?:TP\s*\d|CTA|HOOK|CLOSE|PAYOFF|RE-?HOOK|CAPTION|NOTE|NOTES|TIP|PS|PSA|FYI|NB|OK|Q|A)$/;

/** A speaker label on its own line ("JOE", "JAMES — INTERVIEWER", "SHARK CLIP"), cleaned — or null. */
export function speakerAlone(line: string): string | null {
  const s = stripDecor(line);
  if (!s || s.length > 48) return null;
  if (/[.!?…"“”]$/.test(s.replace(/:$/, "")) || /[a-z]/.test(s.replace(/\([^)]*\)/g, ""))) return null;
  if (NOT_SPEAKERS.test(s.replace(/:$/, "").trim()) || sectionOf(s) || isCue(s) || META_RE.test(s)) return null;
  return SPEAKER_ALONE_RE.test(s) ? cleanSpeakerLabel(s) : null;
}

/** "JOE: “Yeah…”" → the cleaned label and the words after it — or null. */
export function inlineSpeaker(line: string): { label: string; rest: string } | null {
  const s = line.trim();
  const m = INLINE_SPEAKER_RE.exec(s);
  if (!m) return null;
  const label = m[1].trim();
  if (/[a-z]/.test(label.replace(/\([^)]*\)/g, "")) || NOT_SPEAKERS.test(label) || sectionOf(label) || isCue(label)) return null;
  return { label: cleanSpeakerLabel(label), rest: m[2].trim() };
}

const isBracketLine = (l: string) => /^\s*\[[^\]]*\]\s*$/.test(l);
const opensQuote = (l: string) => /^[“"‘«]/.test(l.trim()) || /^…?[“"]/.test(l.trim());
const NUM_HEAD = new RegExp(`^\\s*(?:(?:script|video|reel|skit)\\s*#?\\s*)?(\\d{1,2})\\s*[.):|${DASH_CLASS}-]\\s*\\S|^\\s*(?:script|video|reel|skit)\\s*#?\\s*\\d{1,2}\\s*$`, "i");

/** Does this text read as a skit: speakers, directions, cues or scene headings after its first part label? */
export function looksLikeSkit(text: string): boolean {
  const lines = text.split("\n");
  const first = lines.findIndex(startsPart);
  if (first < 0) return false;
  for (const raw of lines.slice(first + 1)) {
    const t = raw.trim();
    if (!t) continue;
    if (isBracketLine(t) || isCue(t) || speakerAlone(t) || inlineSpeaker(t)) return true;
    const h = sectionOf(t);
    if (h?.sub) return true;
  }
  return false;
}

/**
 * Lines a PDF broke mid-sentence put back together: an open quote or bracket
 * runs on to the line that closes it, and a line ending mid-phrase runs on to
 * one that starts in lower case. Labels, speakers, cues, headings and a new
 * quoted line always start their own line. Words are only ever joined.
 */
export function unwrapLines(lines: string[]): string[] {
  const out: string[] = [];
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
  const stops = (nx: string) => !nx || !!sectionOf(nx) || !!speakerAlone(nx) || isCue(nx) || !!inlineSpeaker(nx) || META_RE.test(nx) || NUM_HEAD.test(nx);
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i].replace(/\s+$/, "");
    if (!text.trim() || sectionOf(text) || speakerAlone(text) || isCue(text)) { out.push(text); continue; }
    let j = i;
    while (j + 1 < lines.length && j - i < 8) {
      const nx = lines[j + 1].trim();
      if (stops(nx)) break;
      const openBracket = count(text, /\[/g) > count(text, /\]/g);
      const openQuote = count(text, /“/g) > count(text, /”/g) || count(text, /"/g) % 2 === 1;
      if (!openBracket && opensQuote(nx)) break;
      if (!openBracket && nx.startsWith("[")) break;
      const midPhrase = /[a-z,;]$/.test(text.trim()) && /^[a-z]/.test(nx);
      if (!(openBracket || openQuote || midPhrase)) break;
      text = `${text.trimEnd()} ${nx}`;
      j++;
    }
    out.push(text);
    i = j;
  }
  return out;
}

const countHookLines = (block: string) => block.split("\n").filter((l) => sectionOf(l)?.part === "hook" && !/^\s*\[/.test(l)).length;

/** A skit document → one block per script: numbered heads ("1. THE ROBBER" + Purpose/Topic or HOOK below), else one per HOOK. */
export function splitSkitDocument(lines: string[]): { blocks: string[]; preamble: string } | null {
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = stripDecor(lines[i]);
    if (!t || !NUM_HEAD.test(t) || sectionOf(t)) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
      const u = lines[j].trim();
      if (!u) continue;
      if (META_RE.test(u) || startsPart(u)) { heads.push(i); break; }
      if (NUM_HEAD.test(stripDecor(u))) break;
    }
  }
  if (heads.length) {
    const blocks = heads.map((h, k) => lines.slice(h, heads[k + 1] ?? lines.length).join("\n"));
    if (blocks.every((b) => countHookLines(b) <= 1)) return { blocks, preamble: lines.slice(0, heads[0]).join("\n") };
  }
  const hooks = lines.map((l, i) => (sectionOf(l)?.part === "hook" && !/^\s*\[/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!hooks.length) return null;
  // One script per HOOK: its meta lines and title sit directly above it.
  const starts = hooks.map((h, k) => {
    const floor = k ? hooks[k - 1] + 1 : 0;
    let start = h;
    let j = h - 1;
    while (j >= floor && (!lines[j].trim() || META_RE.test(lines[j].trim()))) { if (lines[j].trim()) start = j; j--; }
    if (j >= floor) {
      const t = lines[j].trim();
      if (t && !isBracketLine(t) && !opensQuote(t) && !sectionOf(t) && !isCue(t) && t.split(/\s+/).length <= 14 && !/[.!?…,;]["”’)]?$/.test(t)) start = j;
    }
    return start;
  });
  return { blocks: starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length).join("\n")), preamble: lines.slice(0, starts[0]).join("\n") };
}

const DIMENSION_WORDS = new Set(["trust", "value", "credibility", "entertainment"]);
/** "Credibility + Entertainment | Trust + Value" names the quality dimensions, not a content pillar. */
export function isDimensionLine(v: string): boolean {
  const terms = v.split(/[+|,&/]|\band\b/i).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const dims = terms.filter((t) => DIMENSION_WORDS.has(t)).length;
  return dims >= 2 && dims * 2 >= terms.length;
}

const stripTitleNumber = (t: string) => t.replace(new RegExp(`^(?:(?:script|video|reel|skit)\\s*#?\\s*)?\\d{1,2}\\s*[.):|${DASH_CLASS}-]\\s*`, "i"), "").replace(/^(?:script|video|reel|skit)\s*#?\s*\d{1,2}\s*$/i, "").trim();

/** The words a person says in a line of a skit: the speaker label and any whole-line [direction] are not spoken. */
export function spokenWordsOfLine(line: string): number {
  let l = line.trim();
  if (!l || isStageDirectionLine(l)) return 0;
  const sp = inlineSpeaker(l);
  if (sp) l = sp.rest;
  if (isStageDirectionLine(l)) return 0;
  return countSpokenWords(l);
}

/**
 * Read ONE skit as written. `source` = these are the document's own lines
 * (kept as sourceBlock for the word check); otherwise the text is a script
 * this module already wrote (canonicalUploadText) being read back.
 */
export function readSkitScript(text: string, opts: { sourceName?: string; source?: boolean } = {}): ParsedUploadScript {
  const lines = cleanUploadText(text).split("\n").map((l) => l.replace(/\s+$/, ""));
  const first = lines.findIndex(startsPart);
  const headEnd = first < 0 ? lines.length : first;
  const notes: string[] = [];
  let title = "";
  let goal: string | null = null, topic: string | null = null, dimensions: string | null = null, category: string | null = null;

  // 1 · the head: the title (a capitalised title may wrap), its meta lines, anything else (reported).
  let h = 0;
  while (h < headEnd && !lines[h].trim()) h++;
  if (h < headEnd) {
    const firstLine = stripDecor(lines[h]);
    if (/^VIDEO\s*\d{1,2}\s*\|/i.test(firstLine)) {
      h++;
      while (h < headEnd && !lines[h].trim()) h++;
      if (h < headEnd) { title = stripDecor(lines[h]); h++; }
    } else if (!META_RE.test(firstLine)) {
      title = stripTitleNumber(firstLine) || firstLine;
      h++;
      while (h < headEnd && title && !/[a-z]/.test(title) && lines[h].trim() && !/[a-z]/.test(lines[h]) && lines[h].trim().split(/\s+/).length <= 4 && !META_RE.test(lines[h].trim())) {
        title = `${title} ${stripDecor(lines[h])}`;
        h++;
      }
    }
  }
  for (; h < headEnd; h++) {
    const t = stripDecor(lines[h]);
    if (!t) continue;
    const m = META_RE.exec(t);
    if (!m) { notes.push(`“${t.slice(0, 60)}${t.length > 60 ? "…" : ""}” sits before the Hook, so it isn't in the script.`); continue; }
    let value = m[2].trim();
    // A meta line a document wrapped (not yet joined): it runs on to lower-case lines.
    while (h + 1 < headEnd && /^[a-z]/.test(lines[h + 1].trim()) && !/[.!?]["”’)]?$/.test(value)) { value = `${value} ${lines[h + 1].trim()}`; h++; }
    const key = m[1].toLowerCase();
    if (/^(purpose|goal|objective)$/.test(key)) goal ??= value;
    else if (/topic|angle|concept/.test(key)) topic ??= value;
    else if (key === "title") { if (!title) title = value; else topic ??= value; }
    else if (/dimension/.test(key)) dimensions ??= value;
    else if (isDimensionLine(value)) dimensions ??= value;
    else category ??= value;
  }

  // 2 · the body: every line kept where the document put it.
  const parts: Record<SkitPart, string[]> = { hook: [], rehook: [], build: [], payoff: [], close: [], caption: [] };
  const extra: { label: string; lines: string[] }[] = [];
  const speakers: string[] = [];
  let directions = 0;
  const body = first < 0 ? [] : lines.slice(first);
  // Dialogue written in quotation marks: an unquoted line that no speaker
  // introduces is a description of action ("Skeptical/confused reaction."), so
  // it is marked as a direction — its words unchanged.
  let introduced = 0, quoted = 0;
  for (let k = 0; k < body.length; k++) {
    if (!speakerAlone(body[k].trim())) continue;
    const nx = body.slice(k + 1).find((l) => l.trim() && !isBracketLine(l));
    if (nx) { introduced++; if (opensQuote(nx)) quoted++; }
  }
  const quotedDialogue = introduced >= 2 && quoted / introduced >= 0.7;
  let cur: SkitPart | null = null;
  let tpExtra: { label: string; lines: string[] } | null = null;
  let pending: string | null = null;
  const push = (line: string) => {
    if (tpExtra) tpExtra.lines.push(line);
    else if (cur) parts[cur].push(line);
  };
  const addSpeaker = (label: string) => { if (!speakers.includes(label)) speakers.push(label); };
  for (const raw of body) {
    const t = raw.trim();
    if (!t) continue;
    const sec = sectionOf(t);
    if (sec && !(sec.part === "same" && !cur)) {
      if (sec.part !== "same") {
        if (sec.tp) { tpExtra = { label: `Talking point ${sec.tp}`, lines: [] }; extra.push(tpExtra); cur = "payoff"; }
        else { tpExtra = null; cur = sec.part; }
      }
      if (sec.sub) push(`[${sec.sub}]`);
      pending = null;
      if (sec.inline) push(sec.inline);
      continue;
    }
    if (!cur) continue;
    if (t.startsWith("[")) {
      if (pending) { push(`${pending}: ${t}`); pending = null; } else push(t);
      directions++;
      continue;
    }
    if (isCue(t)) { push(`[${cleanHeading(t)}]`); directions++; pending = null; continue; }
    const alone = speakerAlone(t);
    if (alone) { pending = alone; addSpeaker(alone); continue; }
    const inl = inlineSpeaker(t);
    if (inl) { addSpeaker(inl.label); push(`${inl.label}: ${inl.rest}`); pending = null; continue; }
    if (pending) { push(`${pending}: ${t}`); pending = null; continue; }
    if (quotedDialogue && !opensQuote(t)) { push(`[${t}]`); directions++; continue; }
    push(t);
  }

  const join = (a: string[]) => a.join("\n").trim();
  const points: UploadPoint[] = [
    { role: "re-hook", text: join(parts.rehook) },
    { role: "build-up", text: join(parts.build) },
    { role: "payoff", text: join(parts.payoff) },
    ...extra.map((x) => ({ role: null, text: join(x.lines) })),
  ];
  // When a doc only had TALKING POINT 4+ the payoff lines above already hold
  // nothing of theirs; an empty extra stays visible as the shape problem it is.
  const hook = join(parts.hook);
  const close = join(parts.close);
  const caption = join(parts.caption) || null;
  const spoken = [hook, ...points.map((p) => p.text), close].flatMap((x) => x.split("\n"));
  const words = spoken.reduce((n, l) => n + spokenWordsOfLine(l), 0);
  const cleanTitle = titleCaseIfShouting(title.replace(/^["“'‘]+|["”'’]+$/g, "").replace(/\s+/g, " ").trim()).slice(0, 200);
  const r: ParsedUploadScript = {
    sourceName: opts.sourceName ?? "Pasted text",
    title: cleanTitle, titleFound: !!cleanTitle,
    text: "",
    categoryLabel: category,
    hook, points, close, caption,
    words, seconds: Math.round(words / GENERATION_POLICY.timing.wordsPerSec),
    notes,
    format: speakers.length || directions || [hook, ...points.map((p) => p.text), close].some((x) => /^\[/m.test(x)) ? "skit" : "house", goal, topic, dimensions, speakers, directions,
    sourceBlock: opts.source ? lines.join("\n") : null,
  };
  r.text = canonicalUploadText(r);
  return r;
}

const ROLE_WORDS: Record<TalkingPointRole, string> = { "re-hook": "RE-HOOK", "build-up": "BUILD UP", payoff: "PAYOFF" };

/** A script in house labels, its lines exactly as kept — what the preview hands back and apply reads again. */
export function canonicalUploadText(s: Pick<ParsedUploadScript, "title" | "goal" | "topic" | "dimensions" | "categoryLabel" | "hook" | "points" | "close" | "caption">): string {
  const out: string[] = [];
  if (s.title.trim()) out.push(s.title.trim());
  if (s.goal) out.push(`Goal: ${s.goal}`);
  if (s.topic) out.push(`Topic: ${s.topic}`);
  if (s.dimensions) out.push(`Dimensions: ${s.dimensions}`);
  if (s.categoryLabel) out.push(`Category: ${s.categoryLabel}`);
  const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
  out.push("HOOK", ...lines(s.hook));
  s.points.forEach((p, i) => out.push(`TALKING POINT ${i + 1}${p.role ? ` - ${ROLE_WORDS[p.role]}` : ""}`, ...lines(p.text)));
  out.push("CLOSE / CTA", ...lines(s.close));
  if (s.caption?.trim()) out.push("CAPTION", ...lines(s.caption));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// THE AS-WRITTEN CHECK. Every word under the document's parts, in order,
// against every word the script holds — quotes, case and spacing normalised,
// nothing else. Labels, the title, the Purpose/Topic/Pillars lines and speaker
// labels are not compared (they are not spoken and are re-written as labels);
// directions and cues are (they are kept as written).
// ---------------------------------------------------------------------------
type Tok = { k: string; w: string };
function tokensOf(s: string): Tok[] {
  return (s.normalize("NFKC").replace(/[‘’‚‛ʼ`]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []).map((w) => ({ w, k: w.toLowerCase() }));
}
/** A line's words as one key — the same normalisation the check uses (quotes, case, spacing). */
export const wordKey = (s: string): string => tokensOf(s).map((t) => t.k).join(" ");

/** "Purpose: …" / "Topic: …" / "Pillars: …" → its value (null for any other line). */
export function metaValue(line: string): string | null {
  const m = META_RE.exec(stripDecor(line));
  return m ? m[2].trim() || null : null;
}

function lineWords(t: string): Tok[] {
  const sec = sectionOf(t);
  if (sec) return sec.inline ? tokensOf(sec.inline) : [];
  if (speakerAlone(t)) return [];
  const inl = inlineSpeaker(t);
  return tokensOf(inl ? inl.rest : t);
}

/**
 * The words under a script's parts in the document: from its first part label
 * on. A script written with no labels at all (plain paragraphs) is everything
 * after its title line and its Purpose / Topic lines.
 */
export function documentWords(block: string): Tok[] {
  const lines = cleanUploadText(block).split("\n");
  const first = lines.findIndex(startsPart);
  if (first >= 0) return lines.slice(first).flatMap((l) => (l.trim() ? lineWords(l.trim()) : []));
  const body = lines.map((l) => l.trim()).filter(Boolean);
  if (body.length && body[0].split(/\s+/).length <= 14 && !/[.!?…]["”’)]?$/.test(body[0])) body.shift();
  return body.filter((l) => !META_RE.test(l)).flatMap((l) => lineWords(l));
}

/** The words a script holds, part by part. */
export function partWords(p: { hook: string; points: { text: string }[]; close: string; caption?: string | null }): Tok[] {
  return [p.hook, ...p.points.map((x) => x.text), p.close, p.caption ?? ""].flatMap((t) => t.split("\n")).flatMap((l) => (l.trim() ? lineWords(l.trim()) : []));
}

/** Longest-common-subsequence diff on word keys; null when too large to compare. */
function diffTokens(a: Tok[], b: Tok[]): { missing: number[]; added: number[] } | null {
  let s = 0;
  while (s < a.length && s < b.length && a[s].k === b[s].k) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e].k === b[b.length - 1 - e].k) e++;
  const A = a.slice(s, a.length - e), B = b.slice(s, b.length - e);
  const n = A.length, m = B.length;
  if (!n || !m) return { missing: A.map((_, i) => s + i), added: B.map((_, i) => s + i) };
  if (n * m > 6_000_000) return null;
  const w = m + 1;
  const L = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i].k === B[j].k ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const missing: number[] = [], added: number[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].k === B[j].k) { i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) missing.push(s + i++);
    else added.push(s + j++);
  }
  while (i < n) missing.push(s + i++);
  while (j < m) added.push(s + j++);
  return { missing, added };
}

function runs(toks: Tok[], idx: number[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let last = -2;
  for (const i of idx) {
    if (i !== last + 1 && cur.length) { out.push(cur.join(" ")); cur = []; }
    cur.push(toks[i].w);
    last = i;
  }
  if (cur.length) out.push(cur.join(" "));
  return out.map((r) => (r.split(" ").length > 14 ? `${r.split(" ").slice(0, 14).join(" ")}…` : r));
}

export type AsWrittenCheck = {
  /** False when there was nothing to compare against (no part labels in the document, or too long to compare). */
  checked: boolean;
  ok: boolean;
  /** Runs of the document's words the script does not have ("title stayed out of the penalty box"). */
  missing: string[];
  /** Runs of words in the script the document does not have. */
  added: string[];
  missingCount: number;
  addedCount: number;
};

export function checkAsWritten(sourceBlock: string, parts: { hook: string; points: { text: string }[]; close: string; caption?: string | null }): AsWrittenCheck {
  const src = documentWords(sourceBlock);
  const got = partWords(parts);
  if (!src.length) return { checked: false, ok: false, missing: [], added: [], missingCount: 0, addedCount: 0 };
  const d = diffTokens(src, got);
  if (!d) return { checked: false, ok: false, missing: [], added: [], missingCount: 0, addedCount: 0 };
  return { checked: true, ok: !d.missing.length && !d.added.length, missing: runs(src, d.missing).slice(0, 6), added: runs(got, d.added).slice(0, 6), missingCount: d.missing.length, addedCount: d.added.length };
}

/**
 * Where each script sits in the documents, for a list read by the AI (or
 * re-shaped by the staff): its title's words, searched in order, else the
 * first words of its hook (backed up to that hook's label). Each block runs
 * to the next script's start. Null when a script can't be found.
 */
export function locateScriptBlocks(docText: string, anchors: { title: string; hook: string }[]): (string | null)[] {
  const lines = cleanUploadText(docText).split("\n");
  const toks: { k: string; line: number }[] = [];
  lines.forEach((l, i) => { for (const t of tokensOf(l)) toks.push({ k: t.k, line: i }); });
  const find = (keys: string[], from: number): number => {
    if (!keys.length) return -1;
    outer: for (let i = from; i + keys.length <= toks.length; i++) {
      for (let j = 0; j < keys.length; j++) if (toks[i + j].k !== keys[j]) continue outer;
      return i;
    }
    return -1;
  };
  const startLines: (number | null)[] = [];
  let fromTok = 0;
  for (const a of anchors) {
    const titleKeys = tokensOf(stripTitleNumber(a.title) || a.title).map((t) => t.k);
    let at = titleKeys.length >= 1 ? find(titleKeys, fromTok) : -1;
    let line: number | null = null;
    if (at >= 0) line = toks[at].line;
    else {
      const hookKeys = a.hook.split("\n").flatMap((l) => (l.trim() ? lineWords(l.trim()) : [])).slice(0, 8).map((t) => t.k);
      at = hookKeys.length >= 3 ? find(hookKeys, fromTok) : -1;
      if (at >= 0) {
        line = toks[at].line;
        for (let b = line; b >= Math.max(0, line - 6); b--) if (sectionOf(lines[b])?.part === "hook") { line = b; break; }
      }
    }
    startLines.push(line);
    if (at >= 0) fromTok = at + 1;
  }
  return startLines.map((s, k) => {
    if (s == null) return null;
    const next = startLines.slice(k + 1).find((x): x is number => x != null) ?? lines.length;
    return lines.slice(s, next).join("\n");
  });
}

// ---------------------------------------------------------------------------
// PILLAR, by the words — the cheap match when no AI pass ran (or it named no
// pillar). Content words the script shares with a pillar's name, purpose and
// focus areas; the reason says which.
// ---------------------------------------------------------------------------
const STOP = new Set("a about after again all also an and any are as at be because been before being but by can could did do does doing don't down each even every few for from get gets getting go going got had has have he her here his how i i'd i'll i'm if in into is it it's its just know let like make many me more most much my no not now of off on once one only or other our out over own really right same say see she should so some still such than that that's the their them then there these they this those through to too under until up us very want was we we're well were what when where which while who why will with won't would you you're your yours".split(" "));
const stem = (w: string) => w.replace(/'s$/, "").replace(/(ies)$/, "y").replace(/(ing|ers|er|ed|es|s)$/, "");
function contentWords(s: string, shown?: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokensOf(s)) {
    const k = t.k;
    if (k.length <= 2 || STOP.has(k) || /^\d+$/.test(k)) continue;
    const st = stem(k);
    out.add(st);
    if (shown && !shown.has(st)) shown.set(st, k);
  }
  return out;
}
export function pickPillarByWords(scriptText: string, pillars: { id: string; name: string; purpose?: string | null; focusAreas?: string | null }[]): { id: string; why: string } | null {
  if (!pillars.length) return null;
  const shown = new Map<string, string>();
  // Speaker labels and capitalised headings / cues say nothing about the subject.
  const subject = scriptText.split("\n").map((l) => {
    const t = l.trim();
    if (/^\[[^\]a-z]*\]$/.test(t)) return "";
    const sp = inlineSpeaker(t);
    return sp ? sp.rest : t;
  }).join("\n");
  const words = contentWords(subject, shown);
  const pillarWords = pillars.map((p) => contentWords(`${p.name} ${p.purpose ?? ""} ${p.focusAreas ?? ""}`));
  // A word every other pillar uses too (the agent's own name, "buyers") picks nothing out.
  const common = new Set([...new Set(pillarWords.flatMap((w) => [...w]))].filter((w) => pillars.length > 2 && pillarWords.filter((pw) => pw.has(w)).length * 2 > pillars.length));
  let best: { id: string; name: string; score: number; shared: string[] } | null = null;
  let second = 0;
  for (const [i, p] of pillars.entries()) {
    const nameWords = contentWords(p.name);
    const all = pillarWords[i];
    const shared = [...all].filter((w) => words.has(w) && !common.has(w));
    const score = shared.length + [...nameWords].filter((w) => words.has(w) && !common.has(w)).length;
    if (!best || score > best.score) { second = best?.score ?? 0; best = { id: p.id, name: p.name, score, shared }; }
    else if (score > second) second = score;
  }
  if (!best || best.score < 2 || best.score === second) return null;
  return { id: best.id, why: `Closest match by its words (${best.shared.slice(0, 4).map((w) => shown.get(w) ?? w).join(", ")}).` };
}
