// ---------------------------------------------------------------------------
// CREATIVE IDENTITY, the pure half (Oct 14 2026).
//
// Jordan: "The personality profile should be automatically created and
// approved based on their content strategy, brand voice, and brand message."
//
// One short profile per account: how funny, how much acting, what energy,
// what they will and will not do on camera. src/lib/creativeIdentity.ts
// derives it with one model call from the APPROVED strategy, the account's
// video style and accepted non-confidential facts, and stores it on
// ContentEnrollment.overridesJson.creativeIdentity, approved by "auto". This
// file holds the shape, the clean-up of a model answer and the prompt block
// every monthly script, topic-bank and revise prompt carries. No I/O.
//
// Only for the monthly personal-brand program; listing reels never read it.
// ---------------------------------------------------------------------------

export const HUMOR_STYLES = ["none", "dry", "warm", "playful", "outrageous"] as const;
export type HumorStyle = (typeof HUMOR_STYLES)[number];
export const COMEDY_COMFORT = ["no_acting", "light_bits", "full_skits"] as const;
export type ComedyComfort = (typeof COMEDY_COMFORT)[number];

/** One list entry: "stated" = the client's own (strategy text or an accepted fact); "inferred" = a suggestion. */
export type IdentityItem = { text: string; basis: "stated" | "inferred"; source: string };

export type CreativeIdentity = {
  humorStyle: HumorStyle;
  comedyComfort: ComedyComfort;
  onCameraEnergy: string;
  toneWords: string[];
  boundaries: IdentityItem[];
  interests: IdentityItem[];
  formatsLiked: IdentityItem[];
  formatsAvoided: IdentityItem[];
  filmingConstraints: IdentityItem[];
};

/** What overridesJson.creativeIdentity holds. Auto-approved: there is no review step. */
export type StoredCreativeIdentity = CreativeIdentity & {
  strategyVersionId: string;
  derivedAt: string;
  approvedAt: string;
  approvedBy: "auto";
  runId: string | null;
};

export const CREATIVE_IDENTITY_KEY = "creativeIdentity";

const LIST_KEYS = ["boundaries", "interests", "formatsLiked", "formatsAvoided", "filmingConstraints"] as const;

const IDENTITY_ITEM_SCHEMA = {
  type: "object",
  required: ["text", "basis", "source"],
  additionalProperties: false,
  properties: {
    text: { type: "string", description: "One short line." },
    basis: { type: "string", enum: ["stated", "inferred"], description: "stated = said in the strategy or an accepted fact; inferred = your suggestion from them." },
    source: { type: "string", description: "Where it comes from: a strategy section name (Brand Voice, Core Values, ...) or \"fact\"." },
  },
};

export const CREATIVE_IDENTITY_SCHEMA = {
  type: "object",
  required: ["humorStyle", "comedyComfort", "onCameraEnergy", "toneWords", ...LIST_KEYS],
  additionalProperties: false,
  properties: {
    humorStyle: { type: "string", enum: [...HUMOR_STYLES] },
    comedyComfort: { type: "string", enum: [...COMEDY_COMFORT], description: "full_skits only when the account is set to Skits or a fact says the client wants acted skits." },
    onCameraEnergy: { type: "string", description: "One short phrase, for example \"calm and steady\" or \"quick and upbeat\"." },
    toneWords: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } },
    boundaries: { type: "array", items: IDENTITY_ITEM_SCHEMA, description: "Only from the strategy or facts. Never invented." },
    interests: { type: "array", items: IDENTITY_ITEM_SCHEMA, description: "Only real interests named in the strategy or facts." },
    formatsLiked: { type: "array", items: IDENTITY_ITEM_SCHEMA },
    formatsAvoided: { type: "array", items: IDENTITY_ITEM_SCHEMA },
    filmingConstraints: { type: "array", items: IDENTITY_ITEM_SCHEMA },
  },
};

const clean = (s: unknown, max = 160): string => (typeof s === "string" ? s.replace(/[‒-―]/g, ",").replace(/\s+/g, " ").trim().slice(0, max) : "");

function items(v: unknown): IdentityItem[] {
  if (!Array.isArray(v)) return [];
  const out: IdentityItem[] = [];
  for (const x of v) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const text = clean(typeof x === "string" ? x : o.text);
    if (!text) continue;
    out.push({ text, basis: o.basis === "stated" ? "stated" : "inferred", source: clean(o.source, 60) || "strategy" });
  }
  return out.slice(0, 8);
}

/**
 * A model answer made safe to store. Unknown enum values fall back to the
 * quiet choice; full_skits is held to light_bits unless the account is SKITS
 * or a fact says the client wants skits (the brief's rule, enforced in code).
 */
export function normalizeCreativeIdentity(raw: unknown, opts: { skitsAccount: boolean; factSaysSkits?: boolean }): CreativeIdentity {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const humorStyle = (HUMOR_STYLES as readonly string[]).includes(String(o.humorStyle)) ? (o.humorStyle as HumorStyle) : "none";
  let comedyComfort = (COMEDY_COMFORT as readonly string[]).includes(String(o.comedyComfort)) ? (o.comedyComfort as ComedyComfort) : "no_acting";
  if (comedyComfort === "full_skits" && !opts.skitsAccount && !opts.factSaysSkits) comedyComfort = "light_bits";
  if (opts.skitsAccount && comedyComfort !== "full_skits") comedyComfort = "full_skits";
  const toneWords = (Array.isArray(o.toneWords) ? o.toneWords : []).map((w) => clean(w, 30)).filter(Boolean).slice(0, 5);
  return {
    humorStyle, comedyComfort,
    onCameraEnergy: clean(o.onCameraEnergy, 80) || "natural",
    toneWords,
    boundaries: items(o.boundaries), interests: items(o.interests), formatsLiked: items(o.formatsLiked), formatsAvoided: items(o.formatsAvoided), filmingConstraints: items(o.filmingConstraints),
  };
}

/** The stored profile from an overrides bag (a JSON string or the parsed object), or null. */
export function creativeIdentityFromOverrides(overrides: string | Record<string, unknown> | null | undefined): StoredCreativeIdentity | null {
  if (!overrides) return null;
  let bag: unknown = overrides;
  if (typeof overrides === "string") {
    try { bag = JSON.parse(overrides); } catch { return null; }
  }
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const v = (bag as Record<string, unknown>)[CREATIVE_IDENTITY_KEY];
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.strategyVersionId !== "string") return null;
  return { ...normalizeCreativeIdentity(s, { skitsAccount: s.comedyComfort === "full_skits", factSaysSkits: s.comedyComfort === "full_skits" }), strategyVersionId: s.strategyVersionId, derivedAt: String(s.derivedAt ?? ""), approvedAt: String(s.approvedAt ?? ""), approvedBy: "auto", runId: typeof s.runId === "string" ? s.runId : null };
}

const HUMOR_LINE: Record<HumorStyle, string> = {
  none: "none; keep it straight and warm",
  dry: "dry, understated",
  warm: "warm, gentle, self-aware",
  playful: "playful, light",
  outrageous: "big and bold, happy to look silly",
};
const COMEDY_LINE: Record<ComedyComfort, string> = {
  no_acting: "no acting; talking to camera only",
  light_bits: "light bits only (a prop, a reaction, a quick aside), no acted scenes",
  full_skits: "full skits; acted scenes are welcome",
};

export const CREATIVE_IDENTITY_RULE =
  "Stated items are the client's own; inferred items are suggestions, never facts. Write inside these limits. A boundary always wins over a joke.";

/** The CREATIVE IDENTITY block for a prompt, or "" when there is none. No dash is used as punctuation: the model mirrors it. */
export function creativeIdentityBlock(ci: CreativeIdentity | null | undefined): string {
  if (!ci) return "";
  const list = (label: string, xs: IdentityItem[]) => (xs.length ? [`${label}:`, ...xs.map((x) => `- (${x.basis}) ${x.text}`)] : []);
  return [
    "CREATIVE IDENTITY (auto-built from the approved strategy and accepted facts):",
    CREATIVE_IDENTITY_RULE,
    `Humour: ${HUMOR_LINE[ci.humorStyle]}.`,
    `Comedy comfort: ${COMEDY_LINE[ci.comedyComfort]}.`,
    `On-camera energy: ${ci.onCameraEnergy}.`,
    ci.toneWords.length ? `Tone: ${ci.toneWords.join(", ")}.` : "",
    ...list("Boundaries (never cross these)", ci.boundaries),
    ...list("Real interests", ci.interests),
    ...list("Formats they like", ci.formatsLiked),
    ...list("Formats they avoid", ci.formatsAvoided),
    ...list("Filming constraints", ci.filmingConstraints),
  ].filter(Boolean).join("\n");
}
