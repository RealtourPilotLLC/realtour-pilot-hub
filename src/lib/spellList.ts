// ---------------------------------------------------------------------------
// SPELL THESE EXACTLY (Oct 16 2026).
//
// Caption and name spelling is the number one repeat in #video-editing: 37
// days flagged since June, and about 35 of the 94 review notes in the hub are
// one-word caption fixes. The captions come from auto-transcription (Descript),
// and the script was sometimes not in the folder, so the same names came back
// wrong again and again: "Westchester" for West Chester (four times),
// Okehocking, Ridley, Leola, Chesterbrook ("chest to broke"), Manheim
// Township, Erica for Erika.
//
// Fixed at the source: the editor's brief carries ONE short list of the names
// in THIS video, built on its own from what the hub already knows:
//   · the client's name, brokerage and team;
//   · the job's street and town (a listing video);
//   · the proper nouns in the approved script (capitalised words and phrases,
//     never a word only because it starts a sentence or a title);
//   · corrections from this client's past review notes and revision items
//     ("X → Y", "X should be Y", "spelled wrong", "two words");
//   · the house list below: local names transcription keeps mangling, promoted
//     to the main list when this job mentions them, and named once in a
//     compact line otherwise.
// The editor's final check names the same list on its captions line
// (selfCheck.withVideoFacts), so the reviewer's step stays simple.
//
// buildSpellList is PURE (the brief and the drill call the same function);
// spellCorrectionTextsFor is the one read of past notes.
// ---------------------------------------------------------------------------

export type SpellSource = "client" | "address" | "past" | "script" | "house";
export type SpellEntry = { text: string; note: string | null; from: SpellSource };
export type HouseSpelling = { name: string; note?: string; wrong: string[] };

/** Local names that auto-transcription keeps getting wrong. Add a line here
 *  when a new one comes back from review more than once. `wrong` is what the
 *  captions (or a note) have said instead; a match on either promotes it. */
export const HOUSE_SPELLINGS: readonly HouseSpelling[] = [
  { name: "West Chester", note: "two words", wrong: ["Westchester", "West-Chester"] },
  { name: "Chesterbrook", note: "one word", wrong: ["Chester Brook", "Chesterbrooke", "chest to broke"] },
  { name: "Okehocking", wrong: ["Oak Hocking", "Oakhocking", "Okehockin"] },
  { name: "Manheim Township", wrong: ["Mannheim Township", "Manheim Twp"] },
  { name: "Ridley", wrong: ["Ridly", "Riddley"] },
  { name: "Leola", wrong: ["Liola", "Leeola"] },
];

export type SpellListInput = {
  clientName?: string | null;
  brokerage?: string | null;
  team?: string | null;
  /** "412 Okehocking Ln" (a listing video's street; never a session title) */
  street?: string | null;
  town?: string | null;
  /** the words for THIS video (approved script, else the Studio's hook and script) */
  script?: string | null;
  /** this client's past review notes and revision items, raw */
  corrections?: readonly string[] | null;
  /** other words on the job the house list is matched against (order note, office notes) */
  context?: readonly (string | null | undefined)[] | null;
};

export type SpellList = {
  /** what to spell exactly, most certain first */
  entries: SpellEntry[];
  /** the house names this job did not mention, for one compact line */
  house: HouseSpelling[];
};

const MAX_ENTRIES = 16;
const MAX_SCRIPT = 10;

// Function words, pronouns, auxiliaries and the commonest verbs and
// interjections. A capitalised one is a sentence start or title case, never a
// name; two or more in one sentence mark it as title case.
const COMMON = new Set(
  (
    "a an the and or but nor so if then than when where why how what who whom whose which while because as at by for from in into of off on onto out over to up with without about after before between during under until upon via vs " +
    "is are was were be been being am do does did done doing have has had having can could will would shall should may might must not no yes " +
    "now here there this that these those it its i me my mine we us our ours you your yours he him his she her hers they them their theirs " +
    "let let's lets don't doesn't didn't won't can't isn't aren't wasn't weren't i'm i've i'll i'd you're you've you'll you'd we're we've we'll they're they've that's there's here's what's it's it'll " +
    "all any each every some most many much more less few one two three four five six seven eight nine ten first second third last next new old " +
    "just only also even very really still again never always ever too today tonight tomorrow yesterday hey hi hello welcome thanks thank okay ok oh well like " +
    "get got go going know need want think see look make take call text come check ready buy sell move live find give keep say tell ask work help start stop try use pay save win lose love"
  ).split(/\s+/),
);
// Never a name to spell: days, months, the first person.
const SKIP = new Set(
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december i i'm i've i'll i'd".split(" "),
);
// Allowed inside a name, between two capitalised words ("Bank of America", "Fox & Roach").
const JOINERS = new Set(["of", "de", "la", "le", "du", "del", "der", "van", "von", "&"]);
// A dot after these does not end the sentence ("St. Davids").
const ABBREV = new Set(["st", "mt", "ft", "dr", "mr", "mrs", "ms", "jr", "sr", "ave", "rd", "ln", "blvd"]);

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9&' ]+/g, " ").replace(/\s+/g, " ").trim();
const squash = (s: string) => norm(s).replace(/[\s'-]+/g, "");
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const isAllCaps = (w: string) => w.length >= 2 && w === w.toUpperCase() && /[A-Z]/.test(w);
const capitalised = (w: string) => /^[A-Z]/.test(w) && !isAllCaps(w.replace(/\.$/, ""));
const dropPossessive = (s: string) => s.replace(/['’]s$/i, "");

// ---- the script's proper nouns ----------------------------------------------

// A section label at the start of a script line ("Talking Point 1 (Re-hook):").
const LABEL = /^\s*(?:[-•*]\s*)?[A-Z][A-Za-z0-9 /&()+'’-]{0,40}?:\s*/;
// Lines that are never spoken: the category, the caption copy, hashtags.
const UNSPOKEN = /^\s*(?:[-•*]\s*)?(?:category|caption(?:\s*cta)?|hashtags?|music|song|length|shot list|b-?roll|notes?)\s*:/i;

type Tok = { w: string; start: boolean; brk: boolean };

function tokenise(line: string): Tok[] {
  const out: Tok[] = [];
  let start = true;
  let brk = false;
  const re = /([A-Za-z][A-Za-z'’-]*)(\.?)|(\d[\w'’,-]*)|([.!?…]+)|([:;,()"“”[\]{}/|]+)|(&)/g;
  for (const m of line.matchAll(re)) {
    if (m[1]) {
      const word = m[1].replace(/[-'’]+$/, "");
      const abbrev = !!m[2] && ABBREV.has(word.toLowerCase());
      out.push({ w: abbrev ? `${word}.` : word, start, brk });
      start = false;
      brk = false;
      if (m[2] && !abbrev) { start = true; brk = true; }
    } else if (m[3]) {
      // A number breaks a run ("415 Oak Street": the street is the address's).
      start = false;
      brk = true;
    } else if (m[4]) {
      start = true;
      brk = true;
    } else if (m[5]) {
      brk = true;
      if (/[:;]/.test(m[5])) start = true;
    } else if (m[6]) {
      out.push({ w: "&", start: false, brk });
      brk = false;
    }
  }
  return out;
}

/** The proper nouns a script names, in order, each once: capitalised words
 *  and phrases mid-sentence, a multi-word name even at a sentence start, and
 *  nothing from a title-case line (a hook in Title Case names every word). */
export function properNounsIn(script: string | null | undefined): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of (script ?? "").split(/\r?\n/)) {
    if (!raw.trim() || UNSPOKEN.test(raw)) continue;
    const line = raw.replace(LABEL, "");
    const toks = tokenise(line);
    // Sentences: a token that starts one begins a new group.
    const sentences: Tok[][] = [];
    for (const t of toks) {
      if (t.start || sentences.length === 0) sentences.push([]);
      sentences[sentences.length - 1].push(t);
    }
    for (const s of sentences) {
      const capCommon = s.slice(1).filter((t) => capitalised(t.w) && COMMON.has(t.w.toLowerCase())).length;
      if (capCommon >= 2) continue; // title case
      let run: string[] = [];
      let runStart = false;
      const flush = () => {
        while (run.length && JOINERS.has(run[run.length - 1].toLowerCase())) run.pop();
        if (run.length && !(runStart && run.length === 1)) {
          const words = [...run];
          words[words.length - 1] = dropPossessive(words[words.length - 1]);
          const phrase = words.join(" ");
          const k = norm(phrase);
          if (k && !seen.has(k)) { seen.add(k); found.push(phrase); }
        }
        run = [];
        runStart = false;
      };
      s.forEach((t, i) => {
        const lower = t.w.toLowerCase();
        const name = capitalised(t.w) && !COMMON.has(lower) && !SKIP.has(lower.replace(/['’]s$/, ""));
        if (t.brk && run.length) flush();
        if (name) {
          if (!run.length) runStart = i === 0;
          run.push(t.w);
          if (/['’]s$/i.test(t.w)) flush(); // a possessive ends the name
        } else if (run.length && JOINERS.has(lower) && !t.brk) {
          run.push(t.w);
        } else if (run.length) {
          flush();
        }
      });
      flush();
    }
  }
  return found;
}

// ---- past corrections -----------------------------------------------------------

export type SpellCorrection = { right: string; wrong: string | null; kind: "swap" | "spelled" | "spacing" };

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const INFLECTION = /^(?:s|es|ed|d|ing|'s|er|ers|ly|n't)$/;
function isInflection(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/’/g, "'");
  const y = b.toLowerCase().replace(/’/g, "'");
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.startsWith(short) && INFLECTION.test(long.slice(short.length))) return true;
  // "happen" / "happened", "stress" / "stressed", "city" / "cities"
  const stem = (s: string) => s.replace(/(?:ies|es|s|ed|d|ing)$/, "");
  return stem(x) === stem(y) && stem(x).length >= 3;
}

/** Is this correction about how a NAME is spelled (and not a caption's grammar,
 *  "Baths → Bath", or a word swap, "Easier → Know")? */
export function isNameCorrection(c: SpellCorrection, known: (s: string) => boolean = () => false): boolean {
  const right = c.right.trim();
  if (right.length < 3 || /\d/.test(right)) return false;
  if (known(right)) return true;
  if (!/^[A-Z]/.test(right) || COMMON.has(right.toLowerCase()) || /['’]/.test(right)) return false;
  if (c.kind === "spacing" || c.kind === "spelled") return true;
  const wrong = (c.wrong ?? "").trim();
  if (!wrong) return false;
  if (squash(wrong) === squash(right)) return true; // "Westchester" / "West Chester"
  if (right.length < 4 || /['’]/.test(wrong) || COMMON.has(wrong.toLowerCase())) return false;
  if (right.charAt(0).toLowerCase() !== wrong.charAt(0).toLowerCase()) return false;
  if (isInflection(right, wrong)) return false;
  const d = editDistance(right.toLowerCase(), wrong.toLowerCase());
  return d <= Math.max(1, Math.floor(0.25 * Math.max(right.length, wrong.length)));
}

const Q = `"([^"\\n]{1,40})"`;
const LEFT = `((?:[A-Z][\\w.'-]*\\s+){0,2}[A-Za-z][\\w.'-]*)`; // one word, or a capitalised name of up to three
const RIGHT = `([A-Za-z][\\w.'-]*(?:\\s+[A-Z][\\w.'-]*){0,2})`;
const CAP = `((?:[A-Z][\\w.'-]*\\s+){0,2}[A-Z][\\w.'-]*)`;
const PATTERNS: { re: RegExp; pick: (m: RegExpMatchArray) => SpellCorrection | null }[] = [
  // X → Y, X -> Y, X —> Y, X => Y
  { re: new RegExp(`(?:${Q}|${LEFT})\\s*(?:→|-+>|—+>|–+>|=>)\\s*(?:${Q}|${RIGHT})`, "g"), pick: (m) => ({ wrong: m[1] ?? m[2], right: m[3] ?? m[4], kind: "swap" }) },
  // X should be Y / X needs to be Y / X should read Y
  { re: new RegExp(`(?:${Q}|${LEFT})\\s+(?:should|needs? to)\\s+(?:be|read|say)\\s+(?:spelled\\s+)?(?:${Q}|${RIGHT})`, "g"), pick: (m) => ({ wrong: m[1] ?? m[2], right: m[3] ?? m[4], kind: "swap" }) },
  // "Y" not "X"
  { re: new RegExp(`${Q}\\s*,?\\s*not\\s+${Q}`, "g"), pick: (m) => ({ right: m[1], wrong: m[2], kind: "swap" }) },
  // Erika not Erica (bare capitalised words)
  { re: /\b([A-Z][a-z]{2,})\s*,?\s+not\s+([A-Z][a-z]{2,})\b/g, pick: (m) => ({ right: m[1], wrong: m[2], kind: "swap" }) },
  // "Y" instead of "X"
  { re: new RegExp(`${Q}\\s+instead of\\s+${Q}`, "g"), pick: (m) => ({ right: m[1], wrong: m[2], kind: "swap" }) },
  // change "X" to "Y"
  { re: new RegExp(`[Cc]hange\\s+${Q}\\s+to\\s+${Q}`, "g"), pick: (m) => ({ wrong: m[1], right: m[2], kind: "swap" }) },
  // Okehocking is spelled wrong / was misspelled
  { re: new RegExp(`(?:${Q}|${CAP})\\s+(?:is|was|are|were)\\s+(?:spelled|spelt|misspelled)(?:\\s+(?:wrong|incorrectly))?`, "g"), pick: (m) => ({ right: m[1] ?? m[2], wrong: null, kind: "spelled" }) },
  // it's spelled "Erika" / spelling: "Erika"
  { re: new RegExp(`[Ss]pell(?:ed|ing)?\\s*(?:it\\s+)?(?:as\\s+|:\\s*)?${Q}`, "g"), pick: (m) => ({ right: m[1], wrong: null, kind: "spelled" }) },
  // it's spelled Erika (bare)
  { re: /[Ss]pelled\s+(?!wrong|incorrectly)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g, pick: (m) => ({ right: m[1], wrong: null, kind: "spelled" }) },
  // typo: Okehocking
  { re: /[Tt]ypo\s*(?:here)?\s*[:-]?\s*"?([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2})"?/g, pick: (m) => ({ right: m[1], wrong: null, kind: "spelled" }) },
  // West Chester is two words / "West Chester" (two words)
  { re: /"?([A-Z][a-z]+)\s+([A-Z][a-z]+)"?\s*[(,:-]?\s*(?:is|are|should be|needs to be)?\s*two words/g, pick: (m) => ({ right: `${m[1]} ${m[2]}`, wrong: `${m[1]}${m[2].toLowerCase()}`, kind: "spacing" }) },
  // Chester Brook should be one word
  { re: /"?([A-Z][a-z]+)\s+([A-Za-z][a-z]+)"?\s*[(,:-]?\s*(?:is|should be|needs to be)?\s*one word/g, pick: (m) => ({ right: `${m[1]}${m[2].toLowerCase()}`, wrong: `${m[1]} ${m[2]}`, kind: "spacing" }) },
];
// "Westchester should be two words": only the wrong form is known.
const SPLIT_ONLY = /"?([A-Z][a-z]{4,})"?\s+(?:is|should be|needs to be)\s+two words/g;

/** Every correction a note asks for, name-like or not (isNameCorrection decides). */
export function correctionsIn(text: string | null | undefined): SpellCorrection[] {
  const t = (text ?? "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  if (!t.trim()) return [];
  const out: SpellCorrection[] = [];
  for (const p of PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      const c = p.pick(m);
      if (!c?.right) continue;
      const right = c.right.trim().replace(/[.,;:!?]+$/, "");
      if (/^(?:one|two)(?: words?)?$/i.test(right)) continue; // "X should be two words": SPLIT_ONLY reads it
      // "Hey Erica → Erika": the wrong side is as many words as the right one.
      let wrong = c.wrong ? c.wrong.trim().replace(/[.,;:!?]+$/, "") : null;
      const n = right.split(/\s+/).length;
      if (wrong && c.kind === "swap" && wrong.split(/\s+/).length > n) wrong = wrong.split(/\s+/).slice(-n).join(" ");
      out.push({ right, wrong, kind: c.kind });
    }
  }
  for (const m of t.matchAll(SPLIT_ONLY)) {
    const house = HOUSE_SPELLINGS.find((h) => h.wrong.some((w) => squash(w) === squash(m[1])) || squash(h.name) === squash(m[1]));
    if (house) out.push({ right: house.name, wrong: m[1], kind: "spacing" });
  }
  return out;
}

// ---- the list -----------------------------------------------------------------

/** The street of a listing title ("415 Oak Street, Wayne, PA" → "415 Oak Street"); null for anything that is not an address. */
export function streetOf(title: string | null | undefined): string | null {
  const first = clean((title ?? "").split(",")[0]);
  return /^\d+[A-Za-z]?\s+\S/.test(first) ? first : null;
}

/** The town of a listing title when the job has no city field ("415 Oak Street, Wayne, PA 19087" → "Wayne"). */
export function townOf(title: string | null | undefined): string | null {
  const parts = (title ?? "").split(",").map(clean);
  return parts.length >= 3 && streetOf(title) && /^[A-Za-z][A-Za-z .'-]+$/.test(parts[1]) ? parts[1] : null;
}

/** Build the list. Pure: the brief, the final check and the drill all call it. */
export function buildSpellList(input: SpellListInput): SpellList {
  const entries: SpellEntry[] = [];
  const keys = new Set<string>();
  const indexOf = (text: string) => entries.findIndex((e) => norm(e.text) === norm(text));
  /** Is `text` already said, as an entry or as a whole word inside one ("Rob" in "Rob Listing")? */
  const covered = (text: string) => {
    const k = norm(text);
    if (keys.has(k)) return true;
    return entries.some((e) => ` ${norm(e.text)} `.includes(` ${k} `));
  };
  const add = (text: string | null | undefined, from: SpellSource, note: string | null = null) => {
    const t = clean(text);
    if (!t || t.length < 2 || entries.length >= MAX_ENTRIES || covered(t)) return;
    // The hub's own placeholders are not names (audit, Oct 19: "Unknown
    // customer (no customer on the Aryeo order)" was listed to spell exactly).
    if (/^(unknown customer|\[?no address provided\]?|untitled job|tbd)\b/i.test(t)) return;
    keys.add(norm(t));
    entries.push({ text: t, note, from });
  };
  /** Add what the note says that the entry does not say yet ("never Liola" beside "not Liola" adds nothing). */
  const addNote = (i: number, note: string) => {
    const e = entries[i];
    for (const part of note.split(/,\s*/)) {
      const word = part.replace(/^(?:never|not)\s+/i, "").toLowerCase();
      if (!part.trim() || (e.note ?? "").toLowerCase().includes(word)) continue;
      e.note = e.note ? `${e.note}, ${part}` : part;
    }
  };

  // 1 · who: the client, the brokerage, the team.
  add(input.clientName, "client");
  add(input.brokerage, "client");
  add(input.team, "client");
  // 2 · where: a listing's street and town.
  add(input.street, "address");
  add(input.town, "address");

  // 3 · what came back before: name-like corrections from their own notes.
  const knownWords = new Set(
    [input.clientName, input.brokerage, input.team, input.street, input.town, ...HOUSE_SPELLINGS.map((h) => h.name)]
      .flatMap((s) => norm(s ?? "").split(" "))
      .filter((w) => w.length >= 3),
  );
  const known = (s: string) => norm(s).split(" ").every((w) => knownWords.has(w));
  const corrections = (input.corrections ?? []).flatMap((t) => correctionsIn(t)).filter((c) => isNameCorrection(c, known));
  for (const c of corrections) {
    const house = HOUSE_SPELLINGS.find((h) => squash(h.name) === squash(c.right));
    const right = house?.name ?? c.right;
    const spacing = !!c.wrong && squash(c.wrong) === squash(right) && norm(c.wrong) !== norm(right);
    const note = spacing
      ? `${house?.note ?? (right.includes(" ") ? "two words" : "one word")}, never ${c.wrong}`
      : c.wrong && norm(c.wrong) !== norm(right) ? `not ${c.wrong}` : "spelled wrong before";
    // Said already (their own name, the town): the note goes on that entry.
    const at = indexOf(right);
    const inside = at === -1 && !right.includes(" ") ? entries.findIndex((e) => norm(e.text).split(" ").includes(norm(right))) : -1;
    if (at !== -1 || inside !== -1) addNote(at !== -1 ? at : inside, note);
    else add(right, "past", note);
  }

  // 4 · the script's own names.
  let fromScript = 0;
  // A house name's wrong form in the script ("Westchester") is said on the house entry, never listed as a name.
  const houseWrong = new Set(HOUSE_SPELLINGS.flatMap((h) => h.wrong.map(squash)));
  for (const n of properNounsIn(input.script)) {
    if (fromScript >= MAX_SCRIPT) break;
    if (houseWrong.has(squash(n))) continue;
    const before = entries.length;
    add(n, "script");
    if (entries.length > before) fromScript++;
  }

  // 5 · the house list: promoted when anything on this job names it (or a wrong form of it).
  const hay = norm([input.script, input.street, input.town, input.clientName, input.brokerage, input.team, ...(input.context ?? []), ...(input.corrections ?? [])].filter(Boolean).join(" \n "));
  const hayWords = ` ${hay} `;
  const mentions = (s: string) => hayWords.includes(` ${norm(s)} `);
  const unmatched: HouseSpelling[] = [];
  for (const h of HOUSE_SPELLINGS) {
    const wrongSeen = h.wrong.filter((w) => norm(w) !== norm(h.name) && mentions(w));
    if (!mentions(h.name) && !wrongSeen.length) {
      unmatched.push(h);
      continue;
    }
    const note = [h.note, wrongSeen[0] ? `never ${wrongSeen[0]}` : null].filter(Boolean).join(", ") || null;
    const at = indexOf(h.name);
    const inside = at === -1 ? entries.findIndex((e) => norm(e.text).includes(norm(h.name))) : -1;
    if (at !== -1 || inside !== -1) {
      if (note) addNote(at !== -1 ? at : inside, note);
    } else {
      add(h.name, "house", note);
    }
  }
  return { entries, house: unmatched };
}

/** One entry as it reads on the brief and the final check: "West Chester (two words)". */
export const spellWords = (e: SpellEntry) => (e.note ? `${e.text} (${e.note})` : e.text);

/** The final check's words: the first few names, and how many more the brief has. */
export function spellLine(list: SpellList, max = 8): string | null {
  if (!list.entries.length) return null;
  const shown = list.entries.slice(0, max).map(spellWords).join(", ");
  const more = list.entries.length - max;
  return more > 0 ? `${shown}, and ${more} more on the brief` : shown;
}

// ---- the one read -------------------------------------------------------------

/** This client's past review notes and revision items (newest first), raw.
 *  The client's team counts as theirs: an assistant's job and the agent's
 *  share a name. Server-only; a failed read is an empty list. */
export async function spellCorrectionTextsFor(clientId: string): Promise<string[]> {
  const { prisma } = await import("@/lib/prisma");
  const client = await prisma.client
    .findUnique({ where: { id: clientId }, select: { parentClientId: true, teamMembers: { select: { id: true } } } })
    .catch(() => null);
  const clientIds = [clientId, client?.parentClientId, ...(client?.teamMembers.map((t) => t.id) ?? [])].filter((x): x is string => !!x);
  const projectIds = (
    await prisma.project.findMany({ where: { clientId: { in: clientIds } }, orderBy: { createdAt: "desc" }, take: 200, select: { id: true } }).catch(() => [])
  ).map((p) => p.id);
  if (!projectIds.length) return [];
  const [notes, issues] = await Promise.all([
    prisma.mediaNote
      .findMany({ where: { projectId: { in: projectIds }, lane: "EDITOR", parentId: null }, orderBy: { createdAt: "desc" }, take: 300, select: { body: true } })
      .catch(() => []),
    prisma.revisionIssue
      .findMany({ where: { projectId: { in: projectIds } }, orderBy: { createdAt: "desc" }, take: 300, select: { originalText: true, summary: true } })
      .catch(() => []),
  ]);
  return [...notes.map((n) => n.body), ...issues.flatMap((i) => [i.originalText, i.summary ?? ""])].filter((s) => s.trim());
}
