import { Home, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { routeDeliverable, type VendorMeta } from "@/lib/vendors";
import type { DeliverableType } from "@prisma/client";

// Where a deliverable is produced: in-house (our editors) or out at a vendor.
export function VendorBadge({
  type,
  label,
  vendor,
}: {
  type?: DeliverableType;
  label?: string | null;
  vendor?: VendorMeta;
}) {
  const v = vendor ?? (type ? routeDeliverable(type, label) : null);
  if (!v) return null;
  return (
    <Badge color={v.color} className="px-1.5 py-0 text-[10px]">
      {v.kind === "in_house" ? <Home className="size-2.5" /> : <ExternalLink className="size-2.5" />}
      {v.name}
    </Badge>
  );
}
