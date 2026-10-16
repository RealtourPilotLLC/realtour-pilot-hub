// ---------------------------------------------------------------------------
// SCRIPT BANK READER (Oct 15 2026) — a document of many already-written
// scripts, in order, turned into the bulk plan's import list. No AI: the
// words are kept exactly as written.
//
// The shape it reads is the one Rick Schultz's "Video Script Bank" uses and
// any labelled script document shares:
//
//   DELIVERY NOTE: Talk fast. Cut every 1-2 seconds. …      (optional, once)
//   VIDEO 1: Call Me First                                 (VIDEO|SCRIPT|REEL n)
//   Rick Schultz | Personal Brand                          (optional category)
//   HOOK "Stop. Don't call a realtor yet. Call me first."
//   BEAT "Once you commit to someone, …"                   (RE-HOOK, BUILD UP, TALKING POINT n…)
//   PAYOFF "Quick call. My process. Then you decide."
//   ON-SCREEN / CTA Call before you commit. Link in bio.    (CTA, CLOSE, CALLBACK)
//   CAPTION Haven't picked an agent yet? …
//
// Page furniture (the document's title repeated on every page, "Page 3 of
// 15", "-- 3 of 15 --") and section headings between scripts ("RELOCATION
// SUPPORT") are dropped. Pure: the drill runs it on Rick's real text.
// ---------------------------------------------------------------------------

import type { BulkScriptInput } from "@/lib/bulkPlan";

export type ScriptBankParse = {
  scripts: (BulkScriptInput & { n: number; section: string | null })[];
  /** The document's standing delivery/editing note, when it has one. */
  note: string | null;
  problems: string[];
};

const HEADER = /^(?:VIDEO|SCRIPT|REEL|CLIP)\s*#?\s*(\d{1,3})\s*[:.\-–—]\s*(.+)$/i;
const NOTE = /^(?:DELIVERY|EDITING|EDIT|PRODUCTION)\s+NOTES?\s*:\s*(.*)$/i;
type Field = "hook" | "line" | "close" | "caption";
const LABELS: [RegExp, Field, BulkScriptInput["lines"][number]["role"]][] = [
  [/^HOOK\b[\s:.\-–—]*/i, "hook", null],
  [/^(?:RE[\s-]?HOOK)\b[\s:.\-–—]*/i, "line", "re-hook"],
  [/^(?:BEAT|BUILD[\s-]?UP|SET[\s-]?UP|TALKING POINT\s*\d*(?:\s*[-–—:]\s*(?:RE[\s-]?HOOK|BUILD[\s-]?UP|SETUP|PAYOFF))?)\b[\s:.\-–—]*/i, "line", null],
  [/^PAYOFF\b[\s:.\-–—]*/i, "line", "payoff"],
  [/^(?:ON[\s-]?SCREEN\s*\/\s*CTA|ON[\s-]?SCREEN(?:\s+TEXT)?|CALLBACK\s*\/\s*CTA|CALLBACK|CTA|CLOSE)\b[\s:.\-–—]*/i, "close", null],
  [/^CAPTION\b[\s:.\-–—]*/i, "caption", null],
];
const FURNITURE = [/^Page \d+ of \d+$/i, /^--\s*\d+ of \d+\s*--$/, /^\d+\s*\/\s*\d+$/];

const unquote = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^["“”']+|["“”']+$/g, "").trim();
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseScriptBank(text: string): ScriptBankParse {
  const raw = (text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  // A line printed beside the page number on several pages (the document's
  // title) is furniture. Only lines that touch a page marker count: a CTA the
  // scripts repeat ("Call first. Link in bio.") is content, however often.
  const isMarker = (l: string) => FURNITURE.some((re) => re.test(l));
  const nearMarker = new Map<string, number>();
  raw.forEach((l, i) => {
    if (isMarker(l) || HEADER.test(l)) return;
    if ((i > 0 && isMarker(raw[i - 1])) || (i + 1 < raw.length && isMarker(raw[i + 1]))) nearMarker.set(l, (nearMarker.get(l) ?? 0) + 1);
  });
  const repeated = new Set([...nearMarker.entries()].filter(([l, n]) => n >= 3 && l.length <= 90).map(([l]) => l));
  const lines = raw.filter((l) => !repeated.has(l) && !FURNITURE.some((re) => re.test(l)));

  const problems: string[] = [];
  const scripts: ScriptBankParse["scripts"] = [];
  let note: string[] | null = null;
  let section: string | null = null;
  type Cur = { n: number; title: string; section: string | null; category: string | null; hook: string[]; lines: { role: BulkScriptInput["lines"][number]["role"]; text: string[] }[]; close: string[]; caption: string[]; field: Field | "category" | null };
  let cur: Cur | null = null;
  const finish = () => {
    if (!cur) return;
    const s = cur;
    scripts.push({
      n: s.n, title: clean(s.title), section: s.section, category: s.category,
      hook: unquote(s.hook.join(" ")),
      lines: s.lines.map((l) => ({ role: l.role, text: unquote(l.text.join(" ")) })).filter((l) => l.text),
      close: clean(s.close.join(" ")),
      caption: clean(s.caption.join(" ")) || null,
    });
    cur = null;
  };
  for (const l of lines) {
    const h = HEADER.exec(l);
    if (h) {
      finish();
      cur = { n: Number(h[1]), title: h[2], section, category: null, hook: [], lines: [], close: [], caption: [], field: "category" };
      continue;
    }
    const nm = NOTE.exec(l);
    if (nm && !cur) { note = [nm[1]]; continue; }
    if (!cur) {
      if (note) note.push(l);
      continue;
    }
    // A section heading between scripts: short, all capitals, no label.
    if (l.length <= 40 && /^[A-Z0-9 &/'’,-]+$/.test(l) && /[A-Z]{3}/.test(l) && !LABELS.some(([re]) => re.test(l))) {
      finish();
      section = l;
      continue;
    }
    if (cur.field === "category") {
      const c = /^[^|]{1,60}\|\s*(.+)$/.exec(l) ?? /^(?:Category|Pillar)\s*:\s*(.+)$/i.exec(l);
      cur.field = null;
      if (c) { cur.category = clean(c[1]); continue; }
    }
    const lab = LABELS.find(([re]) => re.test(l));
    if (lab) {
      const [re, field, role] = lab;
      const rest = l.replace(re, "");
      cur.field = field;
      if (field === "hook") cur.hook.push(rest);
      else if (field === "line") cur.lines.push({ role: role ?? (/PAYOFF/i.test(l) ? "payoff" : /RE[\s-]?HOOK/i.test(l) ? "re-hook" : null), text: [rest] });
      else if (field === "close") cur.close.push(rest);
      else cur.caption.push(rest);
      continue;
    }
    // A continuation of the field being read.
    if (cur.field === "hook") cur.hook.push(l);
    else if (cur.field === "line") cur.lines[cur.lines.length - 1]?.text.push(l);
    else if (cur.field === "close") cur.close.push(l);
    else if (cur.field === "caption") cur.caption.push(l);
  }
  finish();

  for (const [i, s] of scripts.entries()) {
    if (!s.hook) problems.push(`Script ${s.n} (“${s.title}”) has no hook.`);
    if (!s.lines.length) problems.push(`Script ${s.n} (“${s.title}”) has no lines after the hook.`);
    if (i > 0 && s.n !== scripts[i - 1].n + 1) problems.push(`The numbering jumps from ${scripts[i - 1].n} to ${s.n}.`);
  }
  if (!scripts.length) problems.push("No scripts found. Each script should start with a line like “VIDEO 1: Title”.");
  return { scripts, note: note ? clean(note.join(" ")) || null : null, problems };
}
