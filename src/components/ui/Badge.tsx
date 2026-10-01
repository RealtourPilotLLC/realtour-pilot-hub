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

/** Theme-aware ink and tint for status controls that cannot wrap a Badge. */
export function badgeColors(color?: string, soft?: string) {
  const isHex = !!color && /^#?[0-9a-f]{6}$/i.test(color);
  return {
    backgroundColor: isHex ? tint(color!, 0.15) : soft ?? "var(--surface-2)",
    color: isHex
      ? `color-mix(in srgb, ${color!.startsWith("#") ? color : `#${color}`}, var(--chip-ink, #fff) var(--chip-ink-mix, 18%))`
      : color ?? "var(--muted)",
  };
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
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-ui-status font-medium leading-snug whitespace-normal break-words ring-1 ring-inset",
        className,
      )}
      style={{
        ...badgeColors(color, soft),
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
