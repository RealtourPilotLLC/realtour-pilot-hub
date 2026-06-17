import { cn } from "@/lib/utils";

export function Badge({
  children,
  color,
  soft,
  className,
}: {
  children: React.ReactNode;
  /** text/border color */
  color?: string;
  /** background color */
  soft?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        className,
      )}
      style={{
        color: color ?? "var(--muted)",
        backgroundColor: soft ?? "var(--surface-2)",
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
