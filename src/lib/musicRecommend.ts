import "server-only";
import { createHash } from "crypto";
import { DeliverableType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { aiJson } from "@/lib/integrations/ai";
import { getSecret } from "@/lib/integrations/connections";
import { getSetting, putSetting } from "@/lib/settings";
import { editorView, parseClientProfile } from "@/lib/clientProfile";
import { refinedDeliverableLabel } from "@/lib/pipeline";
import { videoStyleByKey } from "@/lib/videoStyles";
import { videoTier } from "@/lib/projectStatus";
import { clip, stripMoneySentences } from "@/lib/text";
import { bpmRangeLabel, clampBpmRange, parseEditSpec } from "@/lib/musicPick";

// ---------------------------------------------------------------------------
// "Recommended for this edit" — music suggestions read off the job's editing
// instructions (Jordan, Sep 15: "recommended songs based on the editing
// instructions"). Three steps, each on its own so they can be tested apart:
//
//   buildMusicBriefContext(projectId) — gathers what the editor is cutting:
//     the office's spec (music type, colour profile, length, instructions),
//     the photographer's VISION FOR THE EDIT + SUMMARY, the video type and
//     tier, the property in tone words (size band, aerials — never the street
//     or the client's name) and the client's brand read as the editor sees it
//     (editorView, the creative-safe cut). Money sentences are scrubbed,
//     and so are the job's title, its address and the client's name wherever
//     a person typed them into the free text (nameRedactor, below).
//   recommendQueries(context) — asks the hub's AI (the same aiJson tool-call
//     pattern the revision briefs use, on the fast model) for 2–3 semantic
//     search phrases, a BPM range, instrumental-or-any, up to three moods and
//     one plain sentence of why. Anything unusable (no key, a timeout, junk)
//     falls back to a DETERMINISTIC keyword read, so the card always has a
//     recommendation and never a spinner that ends in nothing. No key means
//     no wait at all, and a failed ask is remembered ten minutes per context
//     so an outage costs one wait, not one per open.
//   cachedRecommendation(projectId, context) — the AI's answer is kept per
//     job in AppSetting `music-reco:<projectId>` under a hash of the context,
//     so re-opening the brief does not re-ask unless the instructions changed
//     (Refresh asks on purpose). Only AI answers are cached: the fallback is
//     free to recompute, and caching it would stop the AI being tried again.
//
// The Epidemic Sound results themselves are fetched fresh on every open by
// the server action (music.actions.ts) — the preview URLs are signed and
// expire. Nothing here touches Epidemic Sound.
// ---------------------------------------------------------------------------

export type MusicBriefContext = {
  /** "Premium Cinematic Video" — the Style Guide name per owed video, deduped */
  deliverables: string[];
  tier: "standard" | "premium" | "branding" | null;
  /** the brief's "STYLE: …" line (Timeless & Elegant (Cinematic), Fast-Paced) */
  style: string | null;
  musicType: string | null;
  colorProfile: string | null;
  desiredLength: string | null;
  /** the office's instructions on the spec */
  instructions: string | null;
  vision: string | null;
  summary: string | null;
  /** the photographer's free-text "anything else for the editor" */
  notes: string | null;
  /** "2,000-2,999 sq ft home, aerials included" */
  property: string | null;
  /** the client's brand / aesthetic read, editor-safe */
  brand: string | null;
};

export type MusicRecommendation = {
  /** 2–3 semantic search phrases an editor would type */
  queries: string[];
  bpmMin: number | null;
  bpmMax: number | null;
  vocals: "instrumental" | "any";
  /** Epidemic Sound mood NAMES (the action resolves them to ids against the live list) */
  moods: string[];
  /** one plain sentence for the card */
  why: string;
  source: "ai" | "fallback";
};

// ---- The context ----------------------------------------------------------
// The photographer's brief is one column composed of labelled sections
// ("VISION FOR THE EDIT\n…\n\nSUMMARY\n…", plus STYLE: / COLOR PROFILE: lines
// up top). Read here with the same rule the upload portal's parser applies —
// a label only counts as an ENTIRE line — kept local so this module doesn't
// ride on the upload lane's file while it is being reworked (Sep 15).
const SECTION_LABELS = new Set([
  "VISION FOR THE EDIT", "SUMMARY", "SHOTS THAT MUST BE SHOWN", "THINGS TO AVOID", "AREAS TO AVOID",
  "REALTOR REQUESTS", "ADDITIONAL NOTES", "INTRO SCRIPT", "EDITING NOTES",
]);
type BriefParts = { style: string | null; colorProfile: string | null; sections: Map<string, string>; preface: string };

function briefParts(text: string | null | undefined): BriefParts {
  const out: BriefParts = { style: null, colorProfile: null, sections: new Map(), preface: "" };
  if (!text?.trim()) return out;
  const buckets = new Map<string, string[]>();
  const preface: string[] = [];
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const style = current === null ? line.match(/^STYLE:\s*(.+)$/) : null;
    if (style) { out.style = style[1].trim(); continue; }
    const color = line.match(/^COLOR PROFILE:\s*(.+)$/);
    if (color) { out.colorProfile = color[1].trim(); continue; }
    if (SECTION_LABELS.has(line)) {
      current = line;
      if (!buckets.has(line)) buckets.set(line, []);
      continue;
    }
    if (current) buckets.get(current)!.push(raw);
    else preface.push(raw);
  }
  for (const [label, lines] of buckets) {
    const body = lines.join("\n").trim();
    if (body) out.sections.set(label, body);
  }
  out.preface = preface.join("\n").trim();
  return out;
}

// "None", "n/a", "-" — a filled-in box that says nothing.
const NOTHING_RE = /^(none|n\/?a|no|nothing|nil|-+|\.+)$/i;
// A brand paragraph that only says there is nothing on file.
const NO_BRAND_RE = /^no (explicit |specific |particular )?(aesthetic|brand|style)[^.]*\b(on record|on file|noted|yet)\b[^.]*\.?$/i;
// "Up to the editor" / "editor's choice" — a music type that is no steer.
const NO_STEER_RE = /^(up to (the )?editor|editor'?s? (choice|call|pick)|any|anything|whatever|n\/?a|none|tbd)\b/i;

function words(v: unknown, max: number, scrub: (t: string) => string = (t) => t): string | null {
  if (typeof v !== "string") return null;
  const t = scrub(stripMoneySentences(v)).replace(/\s+/g, " ").trim();
  if (!t || NOTHING_RE.test(t)) return null;
  return clip(t, max);
}

// ---- Names and the address stay out of the prompt --------------------------
// The free text (the office's instructions, the photographer's vision) is
// written by people who name things: "show Sarah's pool at 632 Greenridge".
// The system prompt tells the AI not to repeat a name or an address, but that
// governs the answer, not the input — so the input is scrubbed here (review,
// Sep 15): the job title and the address line as whole phrases, the house
// number with its street, each street word, and the client's name (whole and
// each part) become "the home" / "the client". The city, state and zip ride
// only inside the whole-phrase rule (a town called Media must not eat "social
// media"); a street called Spring still costs a "spring morning" its word,
// and that trade is on purpose.
const STREET_WORDS = new Set([
  "rd", "road", "st", "street", "ln", "lane", "dr", "drive", "ave", "avenue", "ct", "court", "cir", "circle", "blvd", "boulevard",
  "way", "pl", "place", "ter", "terrace", "trl", "trail", "hwy", "highway", "pkwy", "parkway", "loop", "run", "pike", "path",
  "unit", "apt", "suite", "ste", "n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west",
]);
const NAME_WORDS = new Set([
  "the", "and", "of", "at", "for", "with", "realty", "realtor", "realtors", "real", "estate", "group", "team", "homes", "home",
  "properties", "property", "llc", "inc", "co", "company", "associates", "partners", "brokerage", "agency", "agent", "sales",
]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole words only; \b would miss a name ending in a non-word character.
const wordRe = (source: string) => new RegExp(`(?<![\\w])(?:${source})(?![\\w])`, "gi");
const STREET_TAIL = `(?:\\s+(?:${[...STREET_WORDS].map(escapeRe).join("|")}))?`;

export function nameRedactor(ids: { title?: string | null; addressLine?: string | null; clientName?: string | null }): (text: string) => string {
  const rules: [RegExp, string][] = [];
  const seen = new Set<string>();
  const add = (source: string, sub: string) => {
    if (seen.has(source)) return;
    seen.add(source);
    rules.push([wordRe(source), sub]);
  };
  const phrase = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
  // Whole phrases first, the longest of them first (the title "632 Greenridge
  // Rd" must not eat the front of "632 Greenridge Rd, Media, PA 19063" and
  // leave the town behind), then the parts.
  const wholes = [ids.title, ids.addressLine].map(phrase).filter((v) => v.length >= 3).sort((a, b) => b.length - a.length);
  for (const v of wholes) add(escapeRe(v).replace(/ /g, "\\s+"), "the home");
  const client = phrase(ids.clientName);
  if (client.length >= 3) add(escapeRe(client).replace(/ /g, "\\s+"), "the client");
  for (const v of [ids.title, ids.addressLine]) {
    // The street portion: everything before the first comma.
    const street = phrase(v).split(",")[0].trim();
    const m = street.match(/^(\d+[A-Za-z]?)\s+(.+)$/);
    const number = m?.[1] ?? null;
    const rest = (m?.[2] ?? street).split(/\s+/).filter(Boolean);
    if (number && rest.length) {
      // "632 Greenridge" · "632 Greenridge Rd" — the number with the street, any length of it.
      add(`${escapeRe(number)}\\s+${escapeRe(rest[0])}${rest.slice(1, 5).map((t) => `(?:\\s+${escapeRe(t)})?`).join("")}`, "the home");
    }
    for (const t of rest) {
      if (STREET_WORDS.has(t.toLowerCase()) || !/^[A-Za-z][A-Za-z'-]{3,}$/.test(t)) continue;
      add(`${escapeRe(t)}${STREET_TAIL}`, "the home");
    }
    // A bare house number of three digits or more ("at 632"); "3 car garage" stays.
    if (number && /^\d{3,}/.test(number)) add(escapeRe(number), "the home");
  }
  for (const t of client.split(/\s+/)) {
    if (NAME_WORDS.has(t.toLowerCase()) || !/^[A-Za-z][A-Za-z'-]{2,}$/.test(t)) continue;
    add(escapeRe(t), "the client");
  }
  if (rules.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [re, sub] of rules) out = out.replace(re, sub);
    // "the Smith listing" → "the the client listing" → "the client listing"
    return out.replace(/\b(the)\s+the (home|client)\b/gi, "$1 $2");
  };
}

export async function buildMusicBriefContext(projectId: string): Promise<MusicBriefContext | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      addressLine: true,
      editSpec: true,
      videoInstructions: true,
      editorBrief: true,
      squareFeetBand: true,
      client: { select: { name: true, profileJson: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, videoStyle: true } },
    },
  });
  if (!p) return null;
  // Every free-text field goes through the redactor: the title, address and
  // client name are selected only to be taken back out of the words.
  const redact = nameRedactor({ title: p.title, addressLine: p.addressLine, clientName: p.client.name });
  const free = (v: unknown, max: number) => words(v, max, redact);
  const spec = parseEditSpec(p.editSpec);
  const videos = p.deliverables.filter((d) => d.type === DeliverableType.VIDEO || d.type === DeliverableType.SOCIAL_REEL);
  const deliverables: string[] = [];
  for (const d of videos) {
    const name = videoStyleByKey(d.videoStyle)?.name ?? refinedDeliverableLabel(d.type, d.label);
    if (!deliverables.includes(name)) deliverables.push(name);
  }
  // The Style Guide tier when the row carries a style key; else the page's
  // own label read (videoTier) — the same order /edit resolves it in.
  const styleTier = videos.map((d) => videoStyleByKey(d.videoStyle)?.tier ?? null).find(Boolean) ?? null;
  const tier: MusicBriefContext["tier"] = styleTier ?? videoTier(p.deliverables) ?? null;

  const brief = briefParts(p.videoInstructions);
  const extra = briefParts(p.editorBrief); // a legacy brief may carry the sections in the free-text box
  const section = (label: string) => brief.sections.get(label) ?? extra.sections.get(label) ?? null;
  const editingNotes = section("EDITING NOTES");

  const band = (p.squareFeetBand ?? "").replace(/sq\.?\s*ft\.?/i, "").replace(/\s+/g, " ").trim();
  const aerials = p.deliverables.some((d) => d.type === DeliverableType.DRONE || /\b(drone|aerial)/i.test(d.label ?? ""));
  const property = [band ? `${band} sq ft home` : null, aerials ? "aerials included" : null].filter(Boolean).join(", ") || null;

  // The brand read the editor already sees on this page — the creative-safe
  // cut (editorView), never the relationship notes; nothing for a brand-new
  // client whose brief is the provisional one (inventing a brand for someone
  // we have never worked with is the one thing that brief must not do).
  const profile = parseClientProfile(p.client.profileJson);
  const brandRead = profile && !profile.newClient ? free(editorView(profile)?.brandStyle, 400) : null;
  // "No aesthetic preferences on record yet" is the profile saying nothing —
  // not a steer to hand the AI (seen on 632 Greenridge, Sep 15 probe).
  const brand = brandRead && NO_BRAND_RE.test(brandRead) ? null : brandRead;

  return {
    deliverables,
    tier,
    style: free(brief.style ?? extra.style, 80),
    musicType: free(spec.musicType, 120),
    colorProfile: free(spec.colorProfile ?? brief.colorProfile, 60),
    desiredLength: free(spec.desiredLength, 40),
    instructions: free(spec.instructions, 700),
    vision: free(section("VISION FOR THE EDIT") ?? brief.preface, 700),
    summary: free(section("SUMMARY"), 400),
    notes: free([extra.preface, editingNotes].filter((x) => x && !NOTHING_RE.test(x.trim())).join(" "), 300),
    property,
    brand,
  };
}

/** Sixteen hex chars of the context — the cache key's "did the instructions change". */
export function contextHash(ctx: MusicBriefContext): string {
  return createHash("sha256").update(JSON.stringify(ctx)).digest("hex").slice(0, 16);
}

// Is there anything written to reason about? Labels and a size band alone are
// the keyword read's job, not a question for the AI.
const hasWords = (ctx: MusicBriefContext): boolean =>
  Boolean(ctx.style || ctx.instructions || ctx.vision || ctx.summary || ctx.notes || ctx.brand || (ctx.musicType && !NO_STEER_RE.test(ctx.musicType)));

// ---- The AI ask -------------------------------------------------------------
// ai.ts's FAST model — its constant isn't exported, and this is a
// classification-sized ask (a few hundred tokens), the same size as
// messageToTodo's.
const MODEL_FAST = "claude-haiku-4-5-20251001";
const AI_TIMEOUT_MS = 12_000;

// Epidemic Sound's mood names, as the catalogue spells them. The AI picks
// from these; the action then resolves each against the LIVE list and drops
// any the agreement doesn't carry, so a misspelling costs a chip, never a
// bad filter.
const ES_MOODS =
  "Angry, Busy & Frantic, Changing Tempo, Chasing, Dark, Dreamy, Eccentric, Elegant, Epic, Euphoric, Fear, Floating, Funny, Glamorous, Happy, Heavy & Ponderous, Hopeful, Laid Back, Marching, Mysterious, Peaceful, Playful, Quirky, Relaxing, Restless, Romantic, Running, Sad, Scary, Sentimental, Sexy, Smooth, Sneaking, Suspense, Weird";

const SYSTEM = `You choose background music for a real estate media agency's video editors. You read the editing instructions for ONE job and return search settings for the Epidemic Sound catalogue.
Rules:
- queries: 2 or 3 short semantic search phrases an editor would type, each a sound plus a scene (for example "warm cinematic piano and strings, hilltop home at dusk"). Never a song title, an artist or a genre on its own.
- bpmMin and bpmMax: whole numbers between 40 and 200 that fit the pacing the instructions ask for (slow and cinematic sits around 70 to 110, a fast social reel around 100 to 130), or null for both when nothing steers the pace.
- vocals: "instrumental" unless the instructions ask for vocals or a sing-along. A spoken script, an agent intro or a voiceover means "instrumental".
- moods: up to 3, spelled exactly as in this list: ${ES_MOODS}.
- why: one plain sentence under 25 words that an editor can read on the card, saying what steered you (the pacing, the feel, the video type). No em dashes. Never mention money, the client's name or the property's address.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries", "bpmMin", "bpmMax", "vocals", "moods", "why"],
  properties: {
    queries: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } },
    bpmMin: { type: ["integer", "null"] },
    bpmMax: { type: ["integer", "null"] },
    vocals: { type: "string", enum: ["instrumental", "any"] },
    moods: { type: "array", maxItems: 3, items: { type: "string" } },
    why: { type: "string" },
  },
};

export function promptFor(ctx: MusicBriefContext): string {
  const lines: [string, string | null][] = [
    ["Video type", ctx.deliverables.length ? `${ctx.deliverables.join(" + ")}${ctx.tier ? ` (${ctx.tier} tier)` : ""}` : null],
    ["Style (photographer)", ctx.style],
    ["Music type (spec)", ctx.musicType],
    ["Colour profile", ctx.colorProfile],
    ["Desired length", ctx.desiredLength],
    ["Instructions (office)", ctx.instructions],
    ["Vision for the edit (photographer)", ctx.vision],
    ["Summary (photographer)", ctx.summary],
    ["Notes for the editor", ctx.notes],
    ["Property", ctx.property],
    ["Client brand and aesthetic", ctx.brand],
  ];
  return lines.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
}

type RawReco = { queries?: unknown; bpmMin?: unknown; bpmMax?: unknown; vocals?: unknown; moods?: unknown; why?: unknown };

/** Strict shape check on whatever came back — the AI's tool call or a stored
 *  row. Null when there isn't a usable query in it. */
export function normaliseRecommendation(raw: unknown, source: "ai" | "fallback"): MusicRecommendation | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawReco;
  const queries: string[] = [];
  for (const q of Array.isArray(r.queries) ? r.queries : []) {
    const t = typeof q === "string" ? q.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (t.length >= 3 && !queries.some((x) => x.toLowerCase() === t.toLowerCase())) queries.push(t);
    if (queries.length === 3) break;
  }
  if (queries.length === 0) return null;
  const bpm = clampBpmRange(typeof r.bpmMin === "number" ? r.bpmMin : null, typeof r.bpmMax === "number" ? r.bpmMax : null);
  const moods: string[] = [];
  for (const m of Array.isArray(r.moods) ? r.moods : []) {
    const t = typeof m === "string" ? m.trim().slice(0, 40) : "";
    if (t && !moods.some((x) => x.toLowerCase() === t.toLowerCase())) moods.push(t);
    if (moods.length === 3) break;
  }
  const why = typeof r.why === "string" ? clip(r.why.replace(/\s+/g, " ").trim(), 220) : "";
  return {
    queries,
    bpmMin: bpm?.min ?? null,
    bpmMax: bpm?.max ?? null,
    vocals: r.vocals === "instrumental" ? "instrumental" : "any",
    moods,
    why: why || "Read from the edit instructions.",
    source,
  };
}

// ---- The deterministic read ---------------------------------------------------
// Jordan's three feels, as words that turn up in briefs. Hits are counted per
// bucket over everything written; the most-hit bucket wins, a tie goes to the
// order below. No hits: the spec's music type leads, else the house default
// for a listing video.
type Bucket = {
  feel: string;
  re: RegExp;
  queries: string[];
  vocals: "instrumental" | "any";
  bpm: [number, number];
  moods: string[];
};
const BUCKETS: Bucket[] = [
  {
    feel: "elegant cinematic",
    re: /\b(cinematic|elegant|elegance|luxur\w*|timeless|premium|grand|sophisticated|classy|refined|polished|upscale)\b/gi,
    queries: ["elegant cinematic piano strings", "warm cinematic piano and strings, luxury home at golden hour"],
    vocals: "instrumental",
    bpm: [70, 110],
    moods: ["Elegant", "Hopeful", "Dreamy"],
  },
  {
    feel: "upbeat and social",
    re: /\b(upbeat|social|reels?|fun|fast|energetic|energy|pop|trendy|punchy|hype|influencer|dynamic|lively|bright|feel[- ]good)\b/gi,
    queries: ["upbeat modern pop beat", "bright feel-good pop for a fast social reel"],
    vocals: "any",
    bpm: [100, 130],
    moods: ["Happy", "Euphoric", "Playful"],
  },
  {
    feel: "calm and secluded",
    re: /\b(calm|nature|secluded|peaceful|quiet|serene|tranquil|private|privacy|relax\w*|soft|gentle|slow|ambient|breathe|retreat)\b/gi,
    queries: ["calm acoustic ambient", "gentle acoustic guitar and soft pads, a quiet home in nature"],
    vocals: "instrumental",
    bpm: [60, 95],
    moods: ["Peaceful", "Relaxing", "Dreamy"],
  },
];

export function fallbackRecommendation(ctx: MusicBriefContext): MusicRecommendation {
  const text = [ctx.deliverables.join(" "), ctx.style, ctx.musicType, ctx.vision, ctx.summary, ctx.instructions, ctx.notes, ctx.brand]
    .filter(Boolean)
    .join(" ");
  let best: { b: Bucket; hits: string[] } | null = null;
  for (const b of BUCKETS) {
    const hits: string[] = [];
    for (const m of text.matchAll(b.re)) {
      const w = m[0].toLowerCase();
      if (!hits.includes(w)) hits.push(w);
    }
    if (hits.length && (!best || hits.length > best.hits.length)) best = { b, hits };
  }
  if (best) {
    const { b, hits } = best;
    const range = clampBpmRange(b.bpm[0], b.bpm[1]);
    const said = hits.slice(0, 3).join(", ");
    return {
      queries: b.queries,
      bpmMin: range?.min ?? null,
      bpmMax: range?.max ?? null,
      vocals: b.vocals,
      moods: b.moods,
      why: `The brief says ${said}, so ${b.feel} music, ${b.vocals === "instrumental" ? "instrumental" : "vocals welcome"}, ${bpmRangeLabel(range)} (the hub's own read of the words).`,
      source: "fallback",
    };
  }
  const type = ctx.musicType && !NO_STEER_RE.test(ctx.musicType) ? ctx.musicType.trim() : null;
  if (type) {
    return {
      queries: [type.toLowerCase(), `${type.toLowerCase()} music for a real estate listing video`],
      bpmMin: null,
      bpmMax: null,
      vocals: "any",
      moods: [],
      why: `Nothing in the brief steers the feel, so the spec's music type (${type}) leads (the hub's own read).`,
      source: "fallback",
    };
  }
  return {
    queries: ["warm modern background music for a home tour", "bright acoustic pop for a listing video"],
    bpmMin: null,
    bpmMax: null,
    vocals: "any",
    moods: [],
    why: "Nothing in the brief steers the music yet, so this is the house default for a listing video (the hub's own read).",
    source: "fallback",
  };
}

// ---- Ask, with the fallback -----------------------------------------------------
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The AI didn't answer within ${Math.round(ms / 1000)}s.`)), ms);
  });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}

// A failed ask (down, slow, junk) is remembered per context for ten minutes,
// in memory: the wait is the timeout plus the client's own retry backoff, and
// without this every open of the brief paid it again during an outage
// (review, Sep 15). The keyword read is what's remembered; Refresh (`fresh`)
// asks again on purpose. Never on disk — a good answer is what the
// AppSetting cache is for.
const OUTAGE_TTL_MS = 10 * 60_000;
const OUTAGE_MEMO_CAP = 200;
const outageMemo = new Map<string, { at: number; reco: MusicRecommendation }>();
function rememberOutage(hash: string, reco: MusicRecommendation) {
  const now = Date.now();
  for (const [k, v] of outageMemo) if (now - v.at >= OUTAGE_TTL_MS) outageMemo.delete(k);
  while (outageMemo.size >= OUTAGE_MEMO_CAP) outageMemo.delete(outageMemo.keys().next().value as string);
  outageMemo.set(hash, { at: now, reco });
}

export type RecommendOpts = {
  timeoutMs?: number;
  /** ask again even if this context failed a moment ago (the card's Refresh) */
  fresh?: boolean;
  /** the AI key: undefined = look it up, null = known to be absent (tests) */
  key?: string | null;
};

/** The AI's read of the context, or the keyword read when the AI is not
 *  connected, times out, or answers with junk. Never throws. */
export async function recommendQueries(ctx: MusicBriefContext, opts: RecommendOpts = {}): Promise<MusicRecommendation> {
  if (!hasWords(ctx)) return fallbackRecommendation(ctx);
  // No key: nothing to wait for, straight to the keyword read. Looked up
  // once here and handed to aiJson, which would otherwise fetch it again.
  const key = opts.key === undefined ? await getSecret("ai") : opts.key;
  if (!key) return fallbackRecommendation(ctx);
  const hash = contextHash(ctx);
  if (!opts.fresh) {
    const failed = outageMemo.get(hash);
    if (failed && Date.now() - failed.at < OUTAGE_TTL_MS) return failed.reco;
  }
  try {
    const raw = await withTimeout(
      aiJson<RawReco>({ system: SYSTEM, prompt: promptFor(ctx), schema: SCHEMA, maxTokens: 400, model: MODEL_FAST, key }),
      opts.timeoutMs ?? AI_TIMEOUT_MS,
    );
    const reco = normaliseRecommendation(raw, "ai");
    if (reco) {
      outageMemo.delete(hash);
      return reco;
    }
    console.warn("[music-reco] AI answer unusable, using the keyword read", JSON.stringify(raw).slice(0, 300));
  } catch (e) {
    console.warn("[music-reco] AI unavailable, using the keyword read:", e instanceof Error ? e.message : e);
  }
  const reco = fallbackRecommendation(ctx);
  rememberOutage(hash, reco);
  return reco;
}

// ---- The per-job cache ------------------------------------------------------------
type Stored = { hash: string; reco: MusicRecommendation | null; at: string };
const cacheKey = (projectId: string) => `music-reco:${projectId}`;

/** The recommendation for this job: the cached AI answer when the
 *  instructions haven't changed, else a fresh ask (cached when the AI
 *  answered). `fresh` skips the cache — the card's Refresh. */
export async function cachedRecommendation(
  projectId: string,
  ctx: MusicBriefContext,
  opts: { fresh?: boolean } = {},
): Promise<MusicRecommendation> {
  const key = cacheKey(projectId);
  const hash = contextHash(ctx);
  if (!opts.fresh) {
    const stored = await getSetting<Stored>(key, { hash: "", reco: null, at: "" });
    if (stored.hash === hash && stored.reco?.source === "ai") {
      const reco = normaliseRecommendation(stored.reco, "ai");
      if (reco) return reco;
    }
  }
  const reco = await recommendQueries(ctx, { fresh: opts.fresh });
  if (reco.source === "ai") {
    await putSetting<Stored>(key, { hash, reco, at: new Date().toISOString() }).catch((e) => {
      console.warn("[music-reco] couldn't cache the answer", projectId, e instanceof Error ? e.message : e);
    });
  }
  return reco;
}
