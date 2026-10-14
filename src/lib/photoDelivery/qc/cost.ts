// ---------------------------------------------------------------------------
// WHAT A CLAUDE CALL COST (prompt pack 0.10, plan §13 spend guardrails).
//
// List prices per million tokens by model family. Defaults are the pack's
// (Haiku 0.10/0.50, Sonnet 2/10, Opus 4/20) plus the two fallback models the
// caller may drop to (Haiku 4.5 1/5, Sonnet 4.6 3/15). Cache reads bill at
// 0.1x base input and 5-minute cache writes at 1.25x (the pack's assumption;
// Opus 5.5 actually bills reads at 0.05x, so its figure is a slight
// overestimate, which is the safe direction for a budget guardrail).
//
// Every number is env-overridable without a deploy of new code:
//   QC_PRICE_HAIKU5="0.10,0.50"   QC_PRICE_SONNET5="2,10"   QC_PRICE_OPUS5="4,20"
//   QC_PRICE_HAIKU45="1,5"        QC_PRICE_SONNET46="3,15"  QC_PRICE_FABLE="10,50"
//   QC_PRICE_CACHE_READ_X="0.1"   QC_PRICE_CACHE_WRITE_X="1.25"
// Pure: no I/O.
// ---------------------------------------------------------------------------

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type Price = { inPerM: number; outPerM: number; cacheReadX: number; cacheWriteX: number };

export type PriceFamily = "haiku5" | "sonnet5" | "opus5" | "haiku45" | "sonnet46" | "fable";

const DEFAULT_PRICES: Record<PriceFamily, [number, number]> = {
  haiku5: [0.1, 0.5],
  sonnet5: [2, 10],
  opus5: [4, 20],
  haiku45: [1, 5],
  sonnet46: [3, 15],
  fable: [10, 50],
};

export function priceFamily(model: string): PriceFamily {
  const m = model.toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (/haiku-4/.test(m)) return "haiku45";
  if (/sonnet-4/.test(m)) return "sonnet46";
  if (m.includes("haiku")) return "haiku5";
  if (m.includes("sonnet")) return "sonnet5";
  // Opus, and anything unrecognised: price it as Opus so an unknown model can
  // only make the guardrail trip early, never late.
  return "opus5";
}

function envPair(name: string): [number, number] | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const [a, b] = raw.split(",").map((s) => Number(s.trim()));
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 ? [a, b] : null;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]?.trim());
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function priceFor(model: string): Price {
  const fam = priceFamily(model);
  const [inPerM, outPerM] = envPair(`QC_PRICE_${fam.toUpperCase()}`) ?? DEFAULT_PRICES[fam];
  return {
    inPerM,
    outPerM,
    cacheReadX: envNum("QC_PRICE_CACHE_READ_X", 0.1),
    cacheWriteX: envNum("QC_PRICE_CACHE_WRITE_X", 1.25),
  };
}

/** USD for one call. `inputTokens` is the UNCACHED input, as the API reports it. */
export function costOf(model: string, u: Usage): number {
  const p = priceFor(model);
  const usd =
    (u.inputTokens * p.inPerM +
      u.cacheReadTokens * p.inPerM * p.cacheReadX +
      u.cacheWriteTokens * p.inPerM * p.cacheWriteX +
      u.outputTokens * p.outPerM) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
