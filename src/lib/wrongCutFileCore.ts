// ---------------------------------------------------------------------------
// THE WRONG-FILE CHECK (Jordan, Oct 23 2026). Pure: no database, no clock, safe
// in a client bundle and in a drill.
//
// What happened: at 10:06 PM ET on Oct 23 an editor uploaded his old export
// "Done_859 N Lawrence St (Joseph Sutow).mov" as version 1 of the Premium reel
// on 538 Onward Ave. The same client's 859 N Lawrence St job had that exact
// file (same name, same size to the byte) as its round 1 from Oct 22. It was
// user error, and the hub said nothing at all. Jordan: yes to a warning at
// upload ("This looks like the file you uploaded for 859 N Lawrence St on Oct
// 22. Upload anyway?") and yes to a flag for the reviewer.
//
// A file looks wrong for a job when:
//   (a) its NAME names another property's street: a number-plus-street of a
//       recent job ("859 N Lawrence"), or, for the SAME client's other jobs,
//       the street name alone ("Lawrence"). Never the job's own street, its
//       unit, its town or its client's name, never a generic word ("Main",
//       "Final", "Reel") and never a short token;
//   (b) a cut on ANOTHER job has the same file name and the same size (or the
//       same content hash, where both rows have a real one);
//   (c, softer) an earlier round on THIS job has the same name and size: "the
//       same file as version 1".
//
// The words name the street and the ET date, never an id. No em dashes.
// lib/wrongCutFile.ts is the reader that feeds this; the upload panel, the
// upload action, the Review Room and the Ready to send card all read the
// answer from here, so they say one thing.
// ---------------------------------------------------------------------------

import { etMonthDay } from "@/lib/datetime";

export type WrongFileJob = {
  projectId: string;
  title: string | null;
  addressLine: string | null;
  city: string | null;
  state?: string | null;
  zip?: string | null;
  clientId: string | null;
  clientName?: string | null;
};

/** Another job whose street the file's name might be naming. */
export type WrongFileCandidate = WrongFileJob & {
  /** when it was booked or shot, for "the most recent wins" */
  at: Date | null;
};

/** A cut that shares the file's name and size (or its content hash). */
export type WrongFileTwin = {
  submissionId: string;
  projectId: string;
  /** its job, for the words (street, or title when the job has no street) */
  job: Pick<WrongFileJob, "title" | "addressLine">;
  deliverableId: string | null;
  slot: number | null;
  round: number;
  createdAt: Date;
  byKey: string | null;
  byName: string | null;
  /** how it matched: same name and size, or the same content hash */
  how: "name-size" | "hash";
};

export type WrongFileInput = {
  job: WrongFileJob;
  file: { name: string; size: number | null };
  /** the slot this file is for (or is on), for "version 1" vs "another video" */
  slot?: { deliverableId: string | null; slot: number | null } | null;
  /** other jobs: the same client's, then recent ones (the reader picks them) */
  candidates: WrongFileCandidate[];
  /** cuts with the same name+size or hash, the file's own row already left out */
  twins: WrongFileTwin[];
  /** who is uploading (or uploaded this version), for "you uploaded" */
  uploader?: { key: string | null; name: string | null } | null;
};

export type WrongFileHit =
  | { kind: "names-street"; projectId: string; street: string; sameClient: boolean; by: "number" | "name" }
  | { kind: "same-file-elsewhere"; projectId: string; place: string; sameStreet: boolean; at: Date; how: "name-size" | "hash"; byYou: boolean; byName: string | null }
  | { kind: "same-file-here"; round: number; at: Date; sameSlot: boolean; how: "name-size" | "hash" };

export type WrongFileVerdict = {
  hits: WrongFileHit[];
  /** (a) or (b): the file very likely belongs to another job */
  strong: boolean;
  /** the editor's words at upload, one sentence each */
  lines: string[];
  /** the same words for the job's timeline ("John uploaded", never "you") */
  record: string[];
  /** the reviewer's one line ("Wrong file? ...") */
  reviewerLine: string;
};

// ---- words and tokens ------------------------------------------------------

// Built from char codes so the source stays plain ASCII.
const ch = (n: number) => String.fromCharCode(n);
const ACCENTS = new RegExp(`[${ch(0x300)}-${ch(0x36f)}]`, "g");
const APOSTROPHES = new RegExp(`['${ch(0x2018)}${ch(0x2019)}]`, "g");
/** An en or em dash with its spaces, said as a comma in our words. */
const DASH = new RegExp(`[ ]*[${ch(0x2013)}${ch(0x2014)}][ ]*`, "g");

/** Lower-case words of a name, accents and apostrophes folded away. Splits on
 *  everything that is not a letter or a digit, so "Done_859" is two words. */
export function wordsOf(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFKD")
    .replace(ACCENTS, "")
    .replace(APOSTROPHES, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A file name's words without its extension. */
export function fileWords(name: string): string[] {
  return wordsOf(name.replace(/\.[a-z0-9]{2,5}$/i, ""));
}

const DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);

const SUFFIXES = new Set([
  "st", "street", "ave", "av", "avenue", "rd", "road", "ln", "lane", "dr", "drive", "ct", "court", "blvd", "boulevard",
  "way", "pl", "place", "cir", "circle", "ter", "terr", "terrace", "pkwy", "parkway", "hwy", "highway", "sq", "square",
  "run", "trl", "trail", "loop", "pike", "row", "aly", "alley", "xing", "crossing", "cv", "cove", "pt", "point", "path",
  "walk", "pass", "bnd", "bend", "hl", "holw", "mnr", "manor", "grn", "crk", "tpke", "turnpike", "rte", "route",
]);

// Words that are street names AND ordinary words (a topic title, a cut label,
// a person's habit of naming files). A street whose name is only one of these
// is never matched on its name alone: "The main reason buyers..." is not a
// file for 415 Main St. With its house number ("415 Main") it still is.
const COMMON = new Set([
  // the cut and the export
  "final", "finals", "finish", "finished", "done", "rev", "revised", "revision", "revisions", "edit", "edited", "edits",
  "export", "exported", "reel", "reels", "video", "videos", "vid", "clip", "clips", "cut", "cuts", "draft", "copy", "new",
  "old", "premium", "social", "media", "standard", "cinematic", "listing", "listings", "tour", "tours", "horizontal",
  "vertical", "label", "labels", "with", "without", "staging", "staged", "music", "border", "version", "take", "part",
  "mls", "branded", "unbranded", "agent", "realtor", "home", "homes", "house", "houses", "property", "real", "estate",
  "for", "the", "and", "your", "you", "this", "that", "what", "when", "why", "how", "not", "from", "into", "over",
  // street names that are ordinary words
  "main", "park", "bridge", "valley", "spring", "springs", "church", "hill", "hills", "lake", "lakes", "river", "ridge",
  "mill", "mills", "market", "high", "school", "station", "center", "centre", "college", "union", "water", "forest",
  "garden", "gardens", "grove", "meadow", "meadows", "view", "green", "oak", "oaks", "pine", "pines", "maple", "cedar",
  "elm", "walnut", "chestnut", "cherry", "willow", "birch", "spruce", "laurel", "holly", "rose", "sunset", "sunrise",
  "highland", "highlands", "line", "village", "front", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "state", "county", "country", "club", "farm", "farms", "creek", "brook", "woods", "wood",
  "orchard", "summit", "heights", "estates", "commons", "lane", "court", "place", "square", "plaza", "dock", "harbor",
  "bay", "beach", "shore", "field", "fields", "glen", "dale", "rock", "stone", "king", "queen", "prince", "liberty",
  "freedom", "hope", "pleasant", "fair", "grand", "little", "big", "long", "short", "upper", "lower", "middle",
  "north", "south", "east", "west", "city", "town", "cottage", "mansion", "manor", "barn", "lot", "lots", "plan", "floor",
  "custom", "build", "builder", "construction", "date", "night", "day", "week", "month", "year", "event", "invitational",
]);

const ORDINAL = /^\d+(st|nd|rd|th)$/;

/** A street off a job: its house number, the words of its name (the "core",
 *  without the directional or the suffix) and how it reads ("859 N Lawrence
 *  St"). Null for anything that is not an address ("August 2026 Social
 *  Content", "[No address provided]"). */
export type Street = { number: string | null; core: string[]; display: string };

export function streetOfJob(job: Pick<WrongFileJob, "title" | "addressLine">): Street | null {
  const fromLine = parseStreet(job.addressLine);
  if (fromLine) return fromLine;
  return parseStreet((job.title ?? "").split(",")[0]);
}

export function parseStreet(line: string | null | undefined): Street | null {
  const display = (line ?? "").split(",")[0].replace(/\s+/g, " ").trim();
  if (!display || /^\[?\s*no address/i.test(display)) return null;
  const words = wordsOf(display);
  if (!words.length) return null;
  let i = 0;
  let number: string | null = null;
  if (/^\d+[a-z]?$/.test(words[0]) && words.length > 1) {
    number = words[0].replace(/[a-z]$/, "");
    i = 1;
  }
  // A leading directional ("N" in "859 N Lawrence St"), unless it IS the name ("100 E St").
  const lead = i;
  while (i < words.length - 1 && DIRECTIONS.has(words[i]) && !SUFFIXES.has(words[i + 1]) && i - lead < 2) i++;
  const core: string[] = [];
  let sawSuffix = false;
  for (; i < words.length; i++) {
    const w = words[i];
    if (core.length > 0 && SUFFIXES.has(w)) { sawSuffix = true; break; }
    if (w === "unit" || w === "apt" || w === "suite" || w === "ste") break;
    core.push(w);
  }
  if (!core.length) return null;
  // No house number and no street word: a title, not an address.
  if (!number && !sawSuffix) return null;
  // A long run of words with no street word after them is a sentence.
  if (core.length > 4) return null;
  return { number, core, display };
}

/** Words that may stand for a street on their own: long enough, not a number,
 *  not an ordinary word. */
function distinctive(w: string): boolean {
  return w.length >= 4 && !/^\d/.test(w) && !ORDINAL.test(w) && !COMMON.has(w) && !SUFFIXES.has(w) && !DIRECTIONS.has(w);
}

/** Words before a number that make it not a house number ("Video 2", "unit 110", "v 3"). */
const NOT_A_HOUSE_NUMBER_BEFORE = new Set(["video", "vid", "v", "version", "part", "take", "reel", "clip", "unit", "apt", "suite", "ste", "no", "number", "episode", "ep", "day", "week", "round", "rev", "of"]);

const sameStreet = (a: Street | null, b: Street | null): boolean =>
  !!a && !!b && a.core.join(" ") === b.core.join(" ") && (a.number === b.number || !a.number || !b.number);

/** Does the file's name say this street by its number and name ("859 N Lawrence")? */
function namesByNumber(words: string[], s: Street): boolean {
  if (!s.number) return false;
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== s.number) continue;
    if (i > 0 && NOT_A_HOUSE_NUMBER_BEFORE.has(words[i - 1])) continue;
    let j = i + 1;
    while (j < words.length && DIRECTIONS.has(words[j]) && j - i <= 2 && words[j] !== s.core[0]) j++;
    if (words[j] === s.core[0]) return true;
  }
  return false;
}

/** Does the file's name say this street by its name alone ("Lawrence", "Ridley Creek")? */
function namesByName(words: string[], s: Street, exclude: Set<string>): boolean {
  const key = s.core.filter(distinctive);
  if (!key.length) return false;
  // Any of the street's own words that is also this job's (its street, town,
  // unit, client) proves nothing about another job.
  if (key.some((w) => exclude.has(w))) return false;
  const n = s.core.length;
  for (let i = 0; i + n <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) if (words[i + k] !== s.core[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** What a twin's job is called on screen: its street, else its title. */
function placeOf(job: Pick<WrongFileJob, "title" | "addressLine">): string {
  const s = streetOfJob(job);
  if (s) return s.display;
  const t = (job.title ?? "").split(",")[0].replace(DASH, ", ").replace(/\s+/g, " ").trim();
  return t ? (t.length > 60 ? `${t.slice(0, 57).trimEnd()}...` : t) : "another job";
}

/** "Oct 22", in ET. */
export const etDay = (d: Date): string => etMonthDay(d);

// ---- the check -------------------------------------------------------------

export function checkCutFile(input: WrongFileInput): WrongFileVerdict | null {
  const name = (input.file.name ?? "").trim();
  if (!name) return null;
  const words = fileWords(name);
  const job = input.job;
  const own = streetOfJob(job);

  // This job's own words: its street, unit, town, state, zip and client. None
  // of them may stand for ANOTHER job's street.
  const exclude = new Set<string>([
    ...wordsOf(job.addressLine),
    ...wordsOf(job.title),
    ...wordsOf(job.city),
    ...wordsOf(job.state),
    ...wordsOf(job.zip),
    ...wordsOf(job.clientName),
  ]);

  const hits: WrongFileHit[] = [];
  // Does the name say THIS job's street? Then a twin elsewhere is the other
  // job's mistake, not this one's (Sep 16: "Revised_308 W Upsal" went to 328
  // Columbia Ave first and was taken back; its later 308 W Upsal St version is
  // the right file), and the street name alone proves nothing either.
  const namesOwn = !!own && (namesByNumber(words, own) || namesByName(words, own, new Set()));

  // (a) the name names another job's street.
  const named: { c: WrongFileCandidate; s: Street; by: "number" | "name"; sameClient: boolean }[] = [];
  for (const c of input.candidates) {
    if (c.projectId === job.projectId) continue;
    const s = streetOfJob(c);
    if (!s || sameStreet(s, own)) continue;
    const sameClient = !!job.clientId && c.clientId === job.clientId;
    if (namesByNumber(words, s)) named.push({ c, s, by: "number", sameClient });
    // The street name alone only for the same client's own jobs: across every
    // client a street name is far too often a surname or a word.
    else if (sameClient && !namesOwn && namesByName(words, s, exclude)) named.push({ c, s, by: "name", sameClient });
  }
  named.sort((x, y) =>
    Number(y.sameClient) - Number(x.sameClient) ||
    Number(y.by === "number") - Number(x.by === "number") ||
    (y.c.at?.getTime() ?? 0) - (x.c.at?.getTime() ?? 0));
  const best = named[0];
  if (best) hits.push({ kind: "names-street", projectId: best.c.projectId, street: best.s.display, sameClient: best.sameClient, by: best.by });

  // (b) and (c): the same file on another job, or on an earlier round here.
  const uploader = input.uploader ?? null;
  const byYou = (t: WrongFileTwin) =>
    !!uploader && ((!!t.byKey && !!uploader.key && t.byKey === uploader.key) || (!t.byKey && !uploader.key && !!t.byName && !!uploader.name && t.byName === uploader.name));
  const newest = [...input.twins].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const elsewhere = namesOwn ? [] : newest.filter((t) => t.projectId !== job.projectId);
  // The twin on the job the name points at says the most; otherwise the newest.
  const other = (best ? elsewhere.find((t) => t.projectId === best.c.projectId) : undefined) ?? elsewhere[0];
  if (other) {
    const s = streetOfJob(other.job);
    hits.push({
      kind: "same-file-elsewhere",
      projectId: other.projectId,
      place: placeOf(other.job),
      sameStreet: sameStreet(s, own),
      at: other.createdAt,
      how: other.how,
      byYou: byYou(other),
      byName: other.byName,
    });
  }
  const here = newest.filter((t) => t.projectId === job.projectId);
  const slot = input.slot ?? null;
  const onSlot = (t: WrongFileTwin) => !!slot && t.deliverableId === slot.deliverableId && (t.slot ?? 1) === (slot.slot ?? 1);
  const mine = here.find(onSlot) ?? here[0];
  if (mine) hits.push({ kind: "same-file-here", round: mine.round, at: mine.createdAt, sameSlot: onSlot(mine), how: mine.how });

  if (!hits.length) return null;
  const strong = hits.some((h) => h.kind !== "same-file-here");
  return { hits, strong, lines: editorLines(hits, own, "you"), record: editorLines(hits, own, "record"), reviewerLine: reviewerLine(hits, own) };
}

// ---- the words -------------------------------------------------------------

const howWords = (how: "name-size" | "hash") => (how === "hash" ? "the identical file" : "same name and size");
const firstOf = (name: string | null | undefined) => (name ?? "").trim().split(/[\s(]+/)[0] || null;
const pick = <K extends WrongFileHit["kind"]>(hits: WrongFileHit[], kind: K) => hits.find((h) => h.kind === kind) as Extract<WrongFileHit, { kind: K }> | undefined;

/** The upload's words, to the person uploading ("you uploaded"), or for the
 *  job's timeline ("John uploaded"). */
function editorLines(hits: WrongFileHit[], own: Street | null, voice: "you" | "record"): string[] {
  const lines: string[] = [];
  const name = pick(hits, "names-street");
  const other = pick(hits, "same-file-elsewhere");
  const here = pick(hits, "same-file-here");
  if (other) {
    const who = other.byYou && voice === "you" ? "you" : firstOf(other.byName);
    const where = other.sameStreet ? `another job at ${other.place}` : other.place;
    lines.push(`This looks like the file ${who ? `${who} uploaded` : "uploaded"} for ${where} on ${etDay(other.at)} (${howWords(other.how)}).`);
  }
  if (name && (!other || (other.projectId !== name.projectId && other.place !== name.street))) {
    lines.push(`The file name says ${name.street}, ${own ? `but this job is ${own.display}` : "which is a different job"}.`);
  }
  if (here && !lines.length) {
    lines.push(
      here.sameSlot
        ? `This looks like the same file as version ${here.round} (${howWords(here.how)}).`
        : `This looks like the same file as version ${here.round} of another video on this job (${howWords(here.how)}).`,
    );
  }
  return lines;
}

function reviewerLine(hits: WrongFileHit[], own: Street | null): string {
  const name = pick(hits, "names-street");
  const other = pick(hits, "same-file-elsewhere");
  const here = pick(hits, "same-file-here");
  const otherPlace = other ? (other.sameStreet ? `another job at ${other.place}` : other.place) : "";
  if (name && other) return `Wrong file? The name says ${name.street}, and ${other.how === "hash" ? "the identical file" : "the same file"} was uploaded to ${otherPlace} on ${etDay(other.at)}.`;
  if (other) {
    return other.how === "hash"
      ? `Wrong file? The identical file was uploaded to ${otherPlace} on ${etDay(other.at)}.`
      : `Wrong file? The same file was uploaded to ${otherPlace} on ${etDay(other.at)} (same name and size).`;
  }
  if (name) return `Wrong file? The name says ${name.street}, ${own ? `not ${own.display}` : "which is a different job"}.`;
  if (here) {
    const which = `version ${here.round}${here.sameSlot ? "" : " of another video on this job"}`;
    return here.how === "hash"
      ? `Same file again? This version is the identical file to ${which} (${etDay(here.at)}).`
      : `Same file again? This version has the same name and size as ${which} (${etDay(here.at)}).`;
  }
  return "Wrong file?";
}

/** The line the job's timeline keeps when somebody presses "Upload anyway":
 *  who, the file, and the warning they were shown. */
export function overrideTimelineLine(input: { who: string | null; fileName: string; what: string; round: number; verdict: WrongFileVerdict }): string {
  const what = input.what.replace(DASH, ", ");
  return `${input.who?.trim() || "Somebody"} pressed Upload anyway for ${input.fileName} (${what}, version ${input.round}). The hub had warned: ${input.verdict.record.join(" ")}`.slice(0, 1000);
}
