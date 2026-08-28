// The brand lockup — the A-mark + wordmark, ONE component for every header
// (Jordan, Aug 28: "where it says RealTour Pilot it should have our logo, not
// the text — across the entire dashboard"). The wordmark is set in the
// logo's own style: uppercase, black weight, tight; REAL + PILOT take the
// surface's ink, TOUR is always brand orange. When the real wordmark FILE
// lands in public/brand/wordmark.svg, swap the span block for an <img> here
// and every header updates at once.
import { cn } from "@/lib/utils";

export function BrandMark({ className = "size-9" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/mark.svg" alt="RealTour Pilot" className={cn("shrink-0 rounded-xl bg-white p-1", className)} />;
}

export function BrandWordmark({ className = "text-sm" }: { className?: string }) {
  return (
    <span className={cn("select-none font-black uppercase leading-none tracking-tight", className)} style={{ fontFamily: "var(--font-sora), Inter, sans-serif" }}>
      REAL<span className="text-brand">TOUR</span>&nbsp;PILOT
    </span>
  );
}

export function BrandLockup({ markClass = "size-9", wordClass = "text-sm", sub }: { markClass?: string; wordClass?: string; sub?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <BrandMark className={markClass} />
      <span className="min-w-0">
        <BrandWordmark className={wordClass} />
        {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
      </span>
    </span>
  );
}
