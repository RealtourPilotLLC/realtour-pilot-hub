import { normalizeTitle, pillarKey, titleSimilarity, titleTokens } from "./topicBank";

// ---------------------------------------------------------------------------
// A CLIENT'S PILLARS ARE EXACTLY THE CONFIRMED ONES (Jordan, Oct 23 2026: "I'm
// not sure why we have Pillar labels to map. We should just stick to their
// confirmed pillars that are in their content strategy, unless we discuss
// adding a new one on a strategy call or I add a new one in the hub.")
//
// Every label that arrives from outside (a model's answer, an imported
// document's heading, a script's Category line, an old topic's free text) is
// matched to one of the client's confirmed pillars by this one rule, and
// nothing else ever creates a pillar or asks a person to map a label:
//
//   1. its NAME or an ALIAS (case and punctuation ignored);
//   2. the same name spelled differently: without a leading "Pillar 3:"
//      (pillarKey), "&" for "and" (pillarLooseKey);
//   3. the first part of a "Seller Education / Buyer Education" label that
//      matches by 1 or 2;
//   4. the CLOSEST confirmed pillar by words (closestPillar below), when it is
//      close (PILLAR_CLOSE_MIN), clearly closer than the next one
//      (PILLAR_CLOSE_MARGIN), shares a telling word with it (not just
//      "education" or "strategy"), and the label does not name the other side
//      of the deal (a seller label never lands on a buyer-only pillar).
//
// No match: a generated topic is dropped from its run; an imported or older
// topic keeps no pillar. Never a new pillar, never a mapping queue.
//
// Against stored pillars (a retired one followed to the pillar it was merged
// into) this is contentPillars.matchConfirmedPillar; this file is the pure
// part, shared with the script upload, the validator, the drills and the
// Oct 23 repair (scripts/_live/oct23-pillar-labels-auto-map.ts).
// ---------------------------------------------------------------------------

export type PillarCandidate = { id: string; name: string; aliases?: string[] };
export type PillarMatchHow = "name" | "alias" | "spelling" | "part" | "closest";
export type PillarLabelMatch = { pillarId: string; pillarName: string; how: PillarMatchHow; score: number; why: string };

/** The closest pillar's score must reach this (0..1)… */
export const PILLAR_CLOSE_MIN = 0.5;
/** …and beat the next-closest DIFFERENT pillar by this much, or the label is ambiguous. */
export const PILLAR_CLOSE_MARGIN = 0.1;

const DIMENSION_WORDS = "trust|value|credibility|entertainment|entertaining|informing|informative|authority|awareness|engagement|curiosity|social proof|nurture|transparency";
const DIMENSION_RE = new RegExp(`^(${DIMENSION_WORDS})(\\s*(?:[\\/&•·,+|]|and)\\s*(${DIMENSION_WORDS}))*$`, "i");

/** A label that is only the quality dimensions (Trust / Value / Credibility / Entertainment…) is never a pillar (spec §27). */
export function isQualityDimensionLabel(label: string | null | undefined): boolean {
  const bare = (label ?? "").replace(/^\s*pillar\s*\d+\s*[:.\-–—]\s*/i, "").trim();
  return !!bare && DIMENSION_RE.test(bare);
}

/** pillarKey with every "and" dropped: "Seller Strategy and Premium Marketing" is "Seller Strategy & Premium Marketing". */
export function pillarLooseKey(label: string): string {
  return pillarKey(label).split(" ").filter((w) => w && w !== "and").join(" ");
}

/** "Seller Education / Buyer Education" → its parts, in order (one part = the label itself). */
export function pillarLabelParts(label: string): string[] {
  return label.split(/\s*(?:\/|•|\||·)\s*/).map((s) => s.trim()).filter(Boolean);
}

// Words too general to tie a label to a pillar on their own: "Education / Both"
// is not "Buyer Education & Protection" because both say "education".
const GENERIC = titleTokens("education educational strategy strategies content guidance tips process general information info topics");

const SELL = new Set(["seller", "sell", "list", "listing", "pricing", "price", "prelist"]);
const BUY = new Set(["buyer", "buy", "purchase", "purchas", "homebuyer", "firsttime"]);
function sides(tokens: Set<string>): { sell: boolean; buy: boolean } {
  let sell = false, buy = false;
  for (const t of tokens) { if (SELL.has(t)) sell = true; if (BUY.has(t)) buy = true; }
  return { sell, buy };
}

/** 0..1: how close a label is to one pillar name (half the house title similarity, half how much of the label the name covers). */
export function pillarLabelScore(label: string, candidate: string): number {
  const a = pillarLooseKey(label), b = pillarLooseKey(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const la = titleTokens(a), lb = titleTokens(b);
  // The other side of the deal: a seller-only label is never a buyer-only pillar, and back.
  const sa = sides(la), sb = sides(lb);
  if ((sa.sell && !sa.buy && sb.buy && !sb.sell) || (sa.buy && !sa.sell && sb.sell && !sb.buy)) return 0;
  let inter = 0, telling = 0;
  for (const t of la) if (lb.has(t)) { inter++; if (!GENERIC.has(t)) telling++; }
  // At least one telling word in common, or the two only look alike.
  if (!telling) return 0;
  const cover = la.size ? inter / la.size : 0;
  return Math.round(((titleSimilarity(a, b) + cover) / 2) * 100) / 100;
}

export type ClosestResult = { match: PillarLabelMatch | null; best: { pillarId: string; pillarName: string; score: number } | null; reason: string };

/** Step 4: the closest confirmed pillar by words, or why there is none. */
export function closestPillar(label: string, pillars: PillarCandidate[]): ClosestResult {
  if (!label.trim() || !pillars.length) return { match: null, best: null, reason: pillars.length ? "empty label" : "the client has no confirmed pillars" };
  if (isQualityDimensionLabel(label)) return { match: null, best: null, reason: "a quality dimension (trust, value…), not a pillar" };
  const scored = pillars.map((p) => {
    let best = { score: 0, via: p.name };
    for (const cand of [p.name, ...(p.aliases ?? [])]) {
      const s = pillarLabelScore(label, cand);
      if (s > best.score) best = { score: s, via: cand };
    }
    return { p, ...best };
  }).sort((x, y) => y.score - x.score);
  const [top, next] = scored;
  const best = { pillarId: top.p.id, pillarName: top.p.name, score: top.score };
  if (top.score < PILLAR_CLOSE_MIN) return { match: null, best, reason: top.score > 0 ? `too far from every pillar (closest “${top.p.name}”, ${top.score.toFixed(2)})` : "no pillar shares a telling word with it" };
  if (next && top.score - next.score < PILLAR_CLOSE_MARGIN) return { match: null, best, reason: `ambiguous: “${top.p.name}” ${top.score.toFixed(2)} vs “${next.p.name}” ${next.score.toFixed(2)}` };
  return {
    match: { pillarId: top.p.id, pillarName: top.p.name, how: "closest", score: top.score, why: `closest by words (${top.score.toFixed(2)}${top.via !== top.p.name ? `, via its earlier name “${top.via}”` : ""}${next ? `; next “${next.p.name}” ${next.score.toFixed(2)}` : ""})` },
    best, reason: "closest",
  };
}

/** Steps 1–3 over a plain list. */
export function exactPillarMatch(label: string, pillars: PillarCandidate[]): PillarLabelMatch | null {
  const one = (l: string): PillarLabelMatch | null => {
    const key = normalizeTitle(l);
    if (!key) return null;
    const byName = pillars.find((p) => normalizeTitle(p.name) === key);
    if (byName) return { pillarId: byName.id, pillarName: byName.name, how: "name", score: 1, why: "same name" };
    const byAlias = pillars.find((p) => (p.aliases ?? []).some((a) => normalizeTitle(a) === key));
    if (byAlias) return { pillarId: byAlias.id, pillarName: byAlias.name, how: "alias", score: 1, why: `an earlier name of “${byAlias.name}”` };
    const lk = pillarLooseKey(l);
    const bySpelling = lk ? pillars.find((p) => pillarLooseKey(p.name) === lk || (p.aliases ?? []).some((a) => pillarLooseKey(a) === lk)) : null;
    if (bySpelling) return { pillarId: bySpelling.id, pillarName: bySpelling.name, how: "spelling", score: 1, why: "the same name (pillar number or “and” aside)" };
    return null;
  };
  const whole = one(label);
  if (whole) return whole;
  const parts = pillarLabelParts(label);
  if (parts.length > 1) {
    for (const part of parts) {
      const m = one(part);
      if (m) return { ...m, how: "part", why: `the label's part “${part}” is ${m.how === "name" ? "its name" : m.how === "alias" ? "an earlier name" : "its name, spelled differently"}` };
    }
  }
  return null;
}

/**
 * Steps 1–4 over a plain list (no retired pillars, no database): the script
 * upload's pillar choices, the validator, the drills. Null = no confirmed
 * pillar is close enough.
 */
export function matchPillarLabel(label: string | null | undefined, pillars: PillarCandidate[]): PillarLabelMatch | null {
  const l = label?.trim();
  if (!l || !pillars.length) return null;
  return exactPillarMatch(l, pillars) ?? closestPillar(l, pillars).match;
}
