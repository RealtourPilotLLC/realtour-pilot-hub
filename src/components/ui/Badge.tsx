import { cn } from "@/lib/utils";

// Translucent tint of a hex color, so chips glow against the dark canvas.
function tint(color: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "var(--surface-2)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Theme-aware chip ink: mixes a hue toward the canvas-appropriate ink (white
// on dark, near-black on light — the --chip-ink / --hue-ink-mix tokens in
// globals.css) so the ~65%-lightness pastel palette stays legible on BOTH
// canvases. Dark mode mixes 0% — pixel-identical to the raw hue. Use this for
// any inline `style={{ color: someHue }}` chip/icon text on page surfaces.
export function ink(color: string): string {
  const c = /^[0-9a-f]{6}$/i.test(color.trim()) ? `#${color.trim()}` : color;
  return `color-mix(in srgb, ${c}, var(--chip-ink, #fff) var(--hue-ink-mix, 0%))`;
}

export function Badge({
  children,
  color,
  soft,
  className,
}: {
  children: React.ReactNode;
  /** text/border color */
  color?: string;
  /** background color (ignored when `color` is a hex — we derive a tint) */
  soft?: string;
  className?: string;
}) {
  const isHex = !!color && /^#?[0-9a-f]{6}$/i.test(color);
  const bg = isHex ? tint(color!, 0.15) : soft ?? "var(--surface-2)";
  // Mix the text toward the theme ink (white lift on dark — same 18% as the
  // old `lighten` — a stronger sink toward black on light) so it stays
  // readable on the tint in both themes.
  const fg = isHex
    ? `color-mix(in srgb, ${color!.startsWith("#") ? color : `#${color}`}, var(--chip-ink, #fff) var(--chip-ink-mix, 18%))`
    : color ?? "var(--muted)";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        className,
      )}
      style={{
        color: fg,
        backgroundColor: bg,
        // @ts-expect-error CSS custom prop for the inset ring
        "--tw-ring-color": isHex ? tint(color!, 0.24) : "var(--border)",
      }}
    >
      {children}
    </span>
  );
}

/** A small colored dot, for status legends. */
export function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
