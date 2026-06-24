import { cn } from "@/lib/utils";

// Translucent tint of a hex color, so chips glow against the dark canvas.
function tint(color: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "var(--surface-2)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Lighten a hex toward white so chip TEXT always clears the dark tinted
// background, even when the source hue is on the darker side.
function lighten(color: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `rgb(${r}, ${g}, ${b})`;
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
  // Slightly lift the text so even mid-tone hues stay readable on the tint.
  const fg = isHex ? lighten(color!, 0.18) : color ?? "var(--muted)";
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
