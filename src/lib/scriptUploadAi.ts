// ---------------------------------------------------------------------------
// "UPLOAD THIS MONTH'S SCRIPTS" — the AI reading, AS WRITTEN (Jordan, Oct 12
// 2026: "Some scripts are scripted differently, so AI should analyze the
// upload and upload it as written. Also, a Pillar should automatically be
// assigned based on the context of the script. I should be able to change it,
// though, if need be.")
//
// Pure: the prompt, the schema and what the answer becomes. No database, no
// network — scriptUpload.aiSplitUpload runs it (attended, logged as a
// ProgramAiRun), and a local check can run the same prompt on a real file.
//
// The model files each script's EXISTING lines into the house parts and picks
// the content pillar; it writes no words. What it hands back is then:
//   · tidied here, deterministically — speaker labels and scene headings lose
//     their dashes, a part label it left inside a part is taken out (it would
//     move the lines after it on re-reading);
//   · written as the house-labelled text the preview shows and apply reads
//     again (scriptUploadParse.canonicalUploadText);
//   · compared word for word with the document (scriptUploadParse.
//     checkAsWritten, run by the preview) — a missing or added word is shown
//     on that script's card and has to be looked at before it can be added.
// ---------------------------------------------------------------------------

import { normalizeTitle, titleSimilarity } from "@/lib/contentPolicy/topicBank";
import {
  canonicalUploadText, cleanHeading, cleanSpeakerLabel, cleanUploadText, inlineSpeaker, isCue, metaValue, readUploadedScript, sectionOf, speakerAlone, titleCaseIfShouting, unwrapLines, wordKey,
  type UploadSource,
} from "@/lib/scriptUploadParse";

export const AS_WRITTEN_PROMPT_KEY = "script-upload-as-written";

export type PillarChoice = { id: string; name: string; purpose?: string | null; focusAreas?: string | null };
/** Where the pillar list came from — said to the model and to the staff. */
export type PillarSource = "pillars" | "approved" | "draft" | "none";

export type AsWrittenScript = {
  title: string;
  purpose: string | null;
  topic: string | null;
  dimensions: string | null;
  category: string | null;
  speakers: string[];
  hook: string;
  rehook: string;
  buildUp: string;
  payoff: string;
  close: string;
  caption: string | null;
  leftOut: string | null;
  pillar: string | null;
  pillarWhy: string | null;
};
export type AsWrittenOut = { scripts: AsWrittenScript[] };

export const AS_WRITTEN_SYSTEM = `You file a real estate agent's short-form video scripts, exactly as written, into the House Video Structure Framework. You never write, rewrite, shorten, correct, reorder or improve a single word. Scripts come in many styles: talking-head scripts, skits with several speakers, stage directions and scenes, or plain paragraphs.

THE FIVE PARTS. Every script gets all five, in this order:
- hook: the HOOK section (the opening).
- rehook: the RE-HOOK / REHOOK section (Talking Point 1).
- buildUp: EVERY build-up section and scene, in order (Talking Point 2). A "SECOND REHOOK", "REHOOK 2" or any other extra beat between the build up and the payoff also goes here, in order.
- payoff: the PAYOFF section (Talking Point 3).
- close: the CLOSE / CTA section.
When a script labels its sections, follow its labels exactly. When it has no labels, place its lines where they belong by meaning (the opening line is the hook, the final ask is the close), still without changing a word.

HOW TO COPY. Each part is plain text, one line per line of the script:
1. Copy every word exactly as written, with its quotation marks and punctuation. Do not fix typos or grammar.
2. A sentence the document breaks across two lines (PDF line wrapping) is joined back into one line.
3. A speaker label goes in front of the line it introduces, followed by a colon: JOE: “Yeah, you know, really proud of the group.” Write the label as the document writes it. The next lines in the same speaker's turn get no label. If a direction comes between the label and the words, the label goes on the direction line.
4. Stage directions stay in [square brackets] exactly as written. An edit or camera cue on its own line ("CUT TO SHARK REACTION", "SMASH CUT") is written in brackets: [CUT TO SHARK REACTION]. A line that describes action or a reaction and is not spoken ("Skeptical/confused reaction.") also goes in brackets: [Skeptical/confused reaction.]
5. A scene or beat heading inside a part ("BUILD UP — SCENE 1: LENDER", "SECOND REHOOK") stays as its own line, in brackets: [BUILD UP — SCENE 1: LENDER].
6. Never drop a line and never repeat one. Leave out only the section labels themselves (HOOK, REHOOK, BUILD UP, PAYOFF, CLOSE) and the script's heading lines (its number and title, and its Purpose / Topic / Pillars lines), which have their own fields below.

THE OTHER FIELDS:
- title: the script's name exactly as the document writes it, without its number ("THE POSTGAME INTERVIEW"). If it has no name, its first few spoken words.
- purpose: the text of its "Purpose:" or "Goal:" line as written, else null.
- topic: the text of its "Topic:" line as written, else null.
- dimensions: a line naming the quality dimensions Trust, Value, Credibility and Entertainment (documents often label it "Pillars:"), as written, else null. These are NOT the client's content pillars.
- category: a line that names one of the client's content pillars (e.g. "Category: Seller Education"), as written, else null.
- speakers: every speaker label the script uses, as written.
- caption: a caption line if the script has one, as written, else null.
- leftOut: any line of the script you could not place (a note to the team), as written, else null.
- pillar: the ONE content pillar from the client's list that this script best serves, judged by its subject and purpose (what it teaches or shows), not its tone or format. Write the name exactly as listed. null only when the list is empty.
- pillarWhy: one short plain sentence saying why that pillar fits (no dashes).

One entry per script, in document order. Skip cover pages and anything that is not a script.`;

const LINES = "Plain text, one line per line of the script. Words copied exactly.";
export const AS_WRITTEN_SCHEMA = {
  type: "object",
  properties: {
    scripts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          purpose: { type: ["string", "null"] },
          topic: { type: ["string", "null"] },
          dimensions: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          speakers: { type: "array", items: { type: "string" } },
          hook: { type: "string", description: LINES },
          rehook: { type: "string", description: LINES },
          buildUp: { type: "string", description: `${LINES} Every build-up scene and any second re-hook, in order.` },
          payoff: { type: "string", description: LINES },
          close: { type: "string", description: LINES },
          caption: { type: ["string", "null"] },
          leftOut: { type: ["string", "null"] },
          pillar: { type: ["string", "null"] },
          pillarWhy: { type: ["string", "null"] },
        },
        required: ["title", "purpose", "topic", "dimensions", "category", "speakers", "hook", "rehook", "buildUp", "payoff", "close", "caption", "leftOut", "pillar", "pillarWhy"],
      },
    },
  },
  required: ["scripts"],
} as const;

const PILLAR_HEAD: Record<PillarSource, string> = {
  pillars: "THE CLIENT'S CONTENT PILLARS",
  approved: "THE CLIENT'S CONTENT PILLARS (from their approved strategy)",
  draft: "THE CLIENT'S CONTENT PILLARS (from their draft strategy, not approved yet)",
  none: "THE CLIENT'S CONTENT PILLARS",
};

/** The documents (page markers out) and the pillar list, as the model reads them. */
export function asWrittenPrompt(sources: UploadSource[], pillars: PillarChoice[], from: PillarSource): string {
  const list = pillars.length
    ? pillars.map((p, i) => `${i + 1}. ${p.name}${p.purpose ? ` | Purpose: ${p.purpose.replace(/\s+/g, " ").slice(0, 300)}` : ""}${p.focusAreas ? ` | Focus: ${p.focusAreas.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n")
    : "(none on file: set pillar and pillarWhy to null)";
  const docs = sources.map((s) => `=== FILE: ${s.name} ===\n${cleanUploadText(s.text).trim()}`).join("\n\n").slice(0, 60_000);
  return `${PILLAR_HEAD[from]}:\n${list}\n\nTHE DOCUMENT:\n${docs}`;
}

const normLabel = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * One part as the model wrote it → the part's lines, tidied: a speaker label
 * cleaned ("JAMES — INTERVIEWER:" → "JAMES (INTERVIEWER):"), a scene heading
 * bracketed and cleaned, an edit cue bracketed, a part label taken out (its
 * own words, if it carried any, kept). Spoken words are never changed.
 */
export function tidyPart(text: string | null | undefined, speakers: string[]): string {
  const declared = new Set(speakers.map(normLabel).filter(Boolean));
  const out: string[] = [];
  for (const raw of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sec = sectionOf(line);
    if (sec) {
      if (sec.sub) out.push(`[${sec.sub}]`);
      if (sec.inline) out.push(sec.inline);
      continue;
    }
    const alone = speakerAlone(line);
    if (alone) { out.push(`${alone}:`); continue; }
    const sp = /^([^:“”"[\]]{1,60}?):\s+(\S.*)$/.exec(line);
    if (sp && (declared.has(normLabel(sp[1])) || inlineSpeaker(line))) { out.push(`${cleanSpeakerLabel(sp[1])}: ${sp[2].trim()}`); continue; }
    if (isCue(line)) { out.push(`[${cleanHeading(line)}]`); continue; }
    out.push(line);
  }
  // A label the model left on its own line ("JOE:") goes in front of the next line.
  const merged: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (/^[^:]{1,60}:$/.test(out[i]) && i + 1 < out.length) { merged.push(`${out[i]} ${out[i + 1]}`); i++; }
    else merged.push(out[i]);
  }
  return merged.join("\n");
}

/**
 * THE DOCUMENT'S OWN CHARACTERS. A model answering in JSON straightens
 * “curly quotes” and can respace a line; the words are the same, the line is
 * not quite as written. So each line the model filed is looked up, by its
 * words, among the document's own lines (wrapped lines joined), and the
 * document's line is used — the model decides only where a line goes and
 * whether it is a direction. A line it can't find there stays as the model
 * wrote it, and the word check still reads it against the document.
 */
export function documentLineIndex(docText: string): Map<string, string> {
  const idx = new Map<string, string>();
  const put = (t: string | null | undefined) => {
    const v = t?.trim();
    if (!v) return;
    const k = wordKey(v);
    if (k && !idx.has(k)) idx.set(k, v);
  };
  for (const raw of unwrapLines(cleanUploadText(docText).split("\n"))) {
    const t = raw.trim();
    if (!t) continue;
    put(t);
    put(metaValue(t));
    put(inlineSpeaker(t)?.rest);
    put(sectionOf(t)?.inline);
  }
  return idx;
}

function asTheDocumentWroteIt(body: string, idx: Map<string, string> | null): string {
  if (!idx) return body;
  const inner = /^\[([\s\S]*)\]$/.exec(body.trim());
  const src = idx.get(wordKey(inner ? inner[1] : body));
  if (!src) return body;
  return inner && !/^\[[\s\S]*\]$/.test(src) ? `[${src}]` : src;
}

function restoreLines(part: string, idx: Map<string, string> | null): string {
  if (!idx) return part;
  return part.split("\n").map((line) => {
    if (sectionOf(line)?.sub) return line; // a scene heading keeps its cleaned form
    const sp = inlineSpeaker(line);
    return sp ? `${sp.label}: ${asTheDocumentWroteIt(sp.rest, idx)}` : asTheDocumentWroteIt(line, idx);
  }).join("\n");
}

const stripNumber = (t: string) => t.replace(/^\s*(?:(?:script|video|reel|skit)\s*#?\s*)?\d{1,2}\s*[.):|‒-―-]\s*/i, "").trim();

export type AsWrittenItem = {
  /** The house-labelled text apply reads again. */
  text: string;
  title: string;
  /** The title as the document wrote it — where the word check finds the script. */
  titleAsWritten: string;
  pillarId: string | null;
  pillarWhy: string | null;
  leftOut: string | null;
  dimensions: string | null;
};

/** The model's answer → one item per script, each read back by the same reader every upload uses. `docText` = the documents, for their own characters. */
export function itemsFromAsWritten(out: AsWrittenOut, pillars: PillarChoice[], docText?: string): AsWrittenItem[] {
  const idx = docText?.trim() ? documentLineIndex(docText) : null;
  const part = (t: string | null | undefined, speakers: string[]) => restoreLines(tidyPart(t, speakers), idx);
  const meta = (t: string | null | undefined) => (t?.trim() ? asTheDocumentWroteIt(t.trim(), idx) : null);
  const items: AsWrittenItem[] = [];
  for (const [i, s] of (out?.scripts ?? []).entries()) {
    if (!s) continue;
    const speakers = Array.isArray(s.speakers) ? s.speakers.filter((x) => typeof x === "string") : [];
    const titleAsWritten = stripNumber(String(s.title ?? "")).replace(/\s+/g, " ").trim();
    const title = titleCaseIfShouting(titleAsWritten).slice(0, 200) || `Script ${i + 1}`;
    const text = canonicalUploadText({
      title,
      goal: meta(s.purpose),
      topic: meta(s.topic),
      dimensions: meta(s.dimensions),
      categoryLabel: meta(s.category),
      hook: part(s.hook, speakers),
      points: [
        { role: "re-hook", text: part(s.rehook, speakers) },
        { role: "build-up", text: part(s.buildUp, speakers) },
        { role: "payoff", text: part(s.payoff, speakers) },
      ],
      close: part(s.close, speakers),
      caption: meta(s.caption),
    });
    items.push({ text, title, titleAsWritten, pillarId: pillarIdFor(s.pillar, pillars), pillarWhy: s.pillar && s.pillarWhy ? s.pillarWhy.trim().slice(0, 240) : null, leftOut: s.leftOut?.trim() || null, dimensions: meta(s.dimensions) });
  }
  return items;
}

/** The model's pillar name → the choice it names (exact, then a close spelling). */
export function pillarIdFor(name: string | null | undefined, pillars: PillarChoice[]): string | null {
  if (!name?.trim() || !pillars.length) return null;
  const key = normalizeTitle(name);
  const exact = pillars.find((p) => normalizeTitle(p.name) === key);
  if (exact) return exact.id;
  let best: { id: string; sim: number } | null = null;
  for (const p of pillars) {
    const sim = titleSimilarity(name, p.name);
    if (sim >= 0.6 && (!best || sim > best.sim)) best = { id: p.id, sim };
  }
  return best?.id ?? null;
}

/** For a check: what the reader makes of an item (the same call the preview and apply make). */
export const readItem = (it: AsWrittenItem) => readUploadedScript(it.text, { title: it.title, asWritten: true });

/** The dimension line as a per-dimension record for the version (internal; never client-facing). */
export function dimensionsRecord(line: string | null | undefined): Record<string, string> | null {
  const v = line?.trim();
  if (!v) return null;
  const groups = v.split("|").map((g) => g.trim()).filter(Boolean);
  const out: Record<string, string> = {};
  groups.forEach((g, gi) => {
    for (const term of g.split(/[+,&/]|\band\b/i).map((t) => t.trim()).filter(Boolean)) {
      const dim = ["Trust", "Value", "Credibility", "Entertainment"].find((d) => d.toLowerCase() === term.toLowerCase());
      if (dim) out[dim] = `${groups.length > 1 ? (gi === 0 ? "Lead" : "Supporting") : "Named"} (from the script document: ${v})`;
      else out.Also = out.Also ? `${out.Also}; ${term}` : term;
    }
  });
  return Object.keys(out).length ? out : { Document: v };
}
