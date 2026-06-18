import { cn } from "@/lib/utils";

// Translucent tint of a hex color, so chips glow against the dark canvas
// instead of using the old light pastel backgrounds.
function tint(color: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "var(--surface-2)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
  const bg = color ? tint(color, 0.16) : soft ?? "var(--surface-2)";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        className,
      )}
      style={{
        color: color ?? "var(--muted)",
        backgroundColor: bg,
        // @ts-expect-error CSS custom prop for the inset ring
        "--tw-ring-color": color ? tint(color, 0.22) : "var(--border)",
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
