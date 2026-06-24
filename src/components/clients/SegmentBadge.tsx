import { Badge } from "@/components/ui/Badge";
import { segmentMeta } from "@/lib/segments";

// The customer-segment chip shown next to a client name everywhere. Pass the
// stored `client.segment`; falls back to nothing if a client hasn't been
// scored yet (e.g. brand-new, before the next segment sync).
export function SegmentBadge({
  segment,
  size = "sm",
  title,
}: {
  segment?: string | null;
  size?: "sm" | "xs";
  title?: boolean;
}) {
  const m = segmentMeta(segment);
  if (!m) return null;
  return (
    <Badge
      color={m.color}
      className={size === "xs" ? "px-1.5 py-0 text-[10px]" : undefined}
    >
      {title ? m.label : m.short}
    </Badge>
  );
}
