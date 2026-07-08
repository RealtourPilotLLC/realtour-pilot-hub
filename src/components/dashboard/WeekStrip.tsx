import Link from "next/link";
import { etDate, etDayKey, etTime } from "@/lib/datetime";
import type { ShootWindow } from "@/lib/queries";

type WeekShoot = ShootWindow["week"][number];

// "This week" — the next 7 days of shoots as a compact per-day strip under the
// today list ("Wed 2 · Thu 3 · …"). It replaced the old "Tomorrow: N shoots"
// one-liner, which hid a 9-shoot week behind a single number. Native
// <details>/<summary> keeps it JS-free (server component): tap a day chip to
// expand time · street · photographer rows; the amber badge means nobody is
// assigned to that visit yet. Day headers link into /schedule for the full view.
export function WeekStrip({ week }: { week: WeekShoot[] }) {
  if (week.length === 0) {
    return (
      <Link href="/schedule" className="block border-t border-border px-4 py-2 text-xs text-muted hover:text-foreground">
        No shoots in the next 7 days → Schedule
      </Link>
    );
  }

  // Group by ET calendar day. The query is startAt-asc, so insertion order is
  // already chronological — Map preserves it.
  const byDay = new Map<string, WeekShoot[]>();
  for (const s of week) {
    const key = etDayKey(s.shootDate);
    const arr = byDay.get(key);
    if (arr) arr.push(s);
    else byDay.set(key, [s]);
  }

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">This week</span>
        {[...byDay.values()].map((shoots) => (
          // `open:basis-full` drops an expanded day onto its own full-width row
          // so the detail rows don't wedge between the sibling chips.
          <details key={etDayKey(shoots[0].shootDate)} className="open:basis-full">
            <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              {/* "Wed 2" — weekday + shoot count, per the strip design */}
              <span className="text-muted">{etDate(shoots[0].shootDate).split(",")[0]}</span>
              <span className="font-semibold tabular-nums">{shoots.length}</span>
              {/* amber dot = at least one visit that day still has no photographer */}
              {shoots.some((s) => !s.photographer) && <span className="size-1.5 rounded-full bg-warning" />}
            </summary>
            <Link href="/schedule" className="mt-1 block px-1 text-[10px] font-semibold uppercase tracking-wide text-muted hover:text-foreground">
              {etDate(shoots[0].shootDate)} → Schedule
            </Link>
            <div className="mb-1 mt-1 divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {shoots.map((s) => (
                <Link key={s.apptId} href={`/shoot/${s.id}`} className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-surface-2">
                  <span className="shrink-0 tabular-nums text-muted">{etTime(s.shootDate)}</span>
                  <span className="min-w-0 flex-1 truncate">{s.title.split(",")[0]}</span>
                  {s.photographer ? (
                    <span className="shrink-0 text-muted">{s.photographer.name}</span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">unassigned</span>
                  )}
                </Link>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
