// ---------------------------------------------------------------------------
// THE COLORS WRITTEN IN A BRAND NOTE, AS SWATCHES (Oct 27 2026). Pure.
//
// Jordan on a client's Brand tab: "Brand Colors, this should be Colors ... No
// hue." A client's colors are stored as free text ("#1B2A4A and #D4AF37",
// "Navy and gold"), and the tab printed that text with nothing to look at.
// This pulls out what a browser can actually paint: hex codes, rgb()/hsl()
// values and plain CSS color names, in the order written, without repeats.
// Text with no paintable color gets no swatch at all (never an empty grey box).
// ---------------------------------------------------------------------------

// Plain color names people write in a brand note that CSS also knows. Names
// CSS does not know ("charcoal", "cream") are left as words, never guessed.
const NAMED = [
  "black", "white", "navy", "gold", "silver", "gray", "grey", "red", "blue", "green", "teal", "orange",
  "purple", "pink", "maroon", "beige", "ivory", "tan", "brown", "yellow", "olive", "coral", "turquoise",
  "burgundy", "crimson", "salmon", "khaki", "lavender", "indigo", "aqua", "lime", "plum", "slategray", "slategrey",
];
// "burgundy" is not a CSS name; it paints as its usual hex.
const ALIAS: Record<string, string> = { burgundy: "#800020" };

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
const FUNC = /\b(?:rgb|rgba|hsl|hsla)\(\s*[\d.]+%?\s*,?\s*[\d.]+%?\s*,?\s*[\d.]+%?(?:\s*[,/]\s*[\d.]+%?)?\s*\)/gi;
const NAME = new RegExp(`\\b(?:${NAMED.join("|")})\\b`, "gi");

export type Swatch = { css: string; label: string };

export function colorSwatches(text: string | null | undefined): Swatch[] {
  if (!text) return [];
  const found: { at: number; css: string; label: string }[] = [];
  for (const m of text.matchAll(HEX)) found.push({ at: m.index ?? 0, css: m[0].toLowerCase(), label: m[0].toUpperCase() });
  for (const m of text.matchAll(FUNC)) found.push({ at: m.index ?? 0, css: m[0].replace(/\s+/g, ""), label: m[0] });
  for (const m of text.matchAll(NAME)) {
    const word = m[0].toLowerCase();
    found.push({ at: m.index ?? 0, css: ALIAS[word] ?? word, label: word });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: Swatch[] = [];
  for (const f of found) {
    if (seen.has(f.css)) continue;
    seen.add(f.css);
    out.push({ css: f.css, label: f.label });
  }
  return out.slice(0, 12);
}
