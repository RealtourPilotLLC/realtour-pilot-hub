import { Map as MapIcon } from "lucide-react";
import { getShootMapData } from "@/lib/shoot";
import { ShootRouteMap } from "./ShootRouteMap";

// Async server component: loads the day's shoots + driving route (one OSRM call)
// and renders the embedded map. Streamed via <Suspense> on the shoot page so the
// screen paints before the routing resolves.
export async function ShootMapCard({ projectId, memberId }: { projectId: string; memberId: string | null }) {
  const data = await getShootMapData(projectId, memberId);
  if (!data || data.pins.length === 0) return null;
  const stops = data.pins.length;

  return (
    <div className="overflow-hidden rounded-2xl border bg-surface panel-shadow">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <MapIcon className="size-4 text-brand" />
        <span className="text-sm font-semibold">{stops > 1 ? "Your route today" : "Location"}</span>
        {stops > 1 && <span className="text-xs text-muted">· {stops} stops</span>}
      </div>
      <ShootRouteMap pins={data.pins} home={data.home} route={data.route} />
    </div>
  );
}

export function ShootMapCardSkeleton() {
  return <div className="h-[15.5rem] w-full animate-pulse rounded-2xl border border-border bg-surface-2" />;
}
