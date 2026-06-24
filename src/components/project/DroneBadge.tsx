import { Plane } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { PALETTE } from "@/lib/palette";
import { DeliverableType } from "@prisma/client";

// True when a project includes any drone/aerial deliverable.
export function hasDroneOps(deliverables: { type: DeliverableType }[]): boolean {
  return deliverables.some((d) => d.type === DeliverableType.DRONE);
}

// "Drone" flag shown on any project with aerial work, so airspace gets checked.
export function DroneBadge({ size = "sm" }: { size?: "sm" | "xs" }) {
  return (
    <Badge color={PALETTE.blue} className={size === "xs" ? "px-1.5 py-0 text-[10px]" : undefined}>
      <Plane className="size-3" /> Drone
    </Badge>
  );
}
