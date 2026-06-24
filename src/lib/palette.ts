// ---------------------------------------------------------------------------
// One harmonized chip palette for the whole hub. Every status / segment /
// vendor / role chip draws from THIS set, so colors feel like one family:
// calm, lower-saturation, consistent lightness (~64–70% L) for legible text
// on the dark surfaces. Brand orange is reserved for brand/accent moments and
// red strictly for alerts — they are intentionally not in the rotation.
// ---------------------------------------------------------------------------
export const PALETTE = {
  gray: "#9aa4b2",
  blue: "#6ba3d6",
  teal: "#4fb3a6",
  green: "#5cb98a",
  indigo: "#8b93e6",
  violet: "#b389d6",
  gold: "#d4a95f",
  rose: "#d782ac",
  red: "#ec6a6a", // alerts only
  brand: "#e96320", // brand/accent only
} as const;

export type PaletteColor = keyof typeof PALETTE;

// Translucent tint of a palette hue for chip/inset backgrounds.
export function soft(hex: string, alpha = 0.16): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "var(--surface-2)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
