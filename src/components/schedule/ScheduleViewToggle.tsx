import Link from "next/link";
import { CalendarDays, MapPinned } from "lucide-react";

// List | Map toggle for the Schedule page — the two views share ONE appointment
// window now (Map used to be its own /map route with a slightly different query,
// so the two drifted). Same visual language as CommsTabs: brand pill = active,
// bordered pill = idle. Lives in the PageHeader `actions` slot.
export type ScheduleView = "list" | "map";

export function ScheduleViewToggle({ view, includeTest = false }: { view: ScheduleView; includeTest?: boolean }) {
  const active = "inline-flex min-h-11 items-center rounded-lg bg-brand-action px-3 py-1.5 text-sm font-medium text-white";
  const idle = "inline-flex min-h-11 items-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link href={includeTest ? "/schedule?test=1" : "/schedule"} className={view === "list" ? active : idle}>
        <CalendarDays className="mr-1.5 inline size-3.5" />
        List
      </Link>
      <Link href={includeTest ? "/schedule?view=map&test=1" : "/schedule?view=map"} className={view === "map" ? active : idle}>
        <MapPinned className="mr-1.5 inline size-3.5" />
        Map
      </Link>
      <Link href={`/schedule${view === "map" ? `?view=map${includeTest ? "" : "&test=1"}` : includeTest ? "" : "?test=1"}`} className={idle}>{includeTest ? "Hide test records" : "Show test records"}</Link>
    </div>
  );
}
