import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { CalendarDays, MapPin as MapPinIcon, Camera } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { stageMeta } from "@/lib/pipeline";
import { etDayStartUtc, etAddDays, etFullDate, etTime, etDayKey, isTodayET } from "@/lib/datetime";
import { ProjectMap, type MapPin, type MapDay } from "@/components/map/ProjectMap";
import { hasDroneOps } from "@/components/project/DroneBadge";
import { ScheduleViewToggle, type ScheduleView } from "@/components/schedule/ScheduleViewToggle";

export const dynamic = "force-dynamic";

// One shared forward horizon for BOTH views (List and Map). Before the merge the
// List ran today..+60 and the Map ran -7..+60 as two separate routes/queries, so
// the horizon could silently drift apart. Now both end at the same +WINDOW_DAYS.
// The Map additionally looks back MAP_LOOKBACK days (it's a route-planning view —
// you want to see this-week's completed stops), while the List stays purely
// forward-looking (a schedule of what's coming up).
const WINDOW_DAYS = 60;
const MAP_LOOKBACK_DAYS = 7;

// ---- List view: appointments grouped by ET day, today onward -----------------
async function ListView() {
  const startToday = etDayStartUtc(new Date());
  const windowEnd = etDayStartUtc(etAddDays(new Date(), WINDOW_DAYS));

  // Driven off APPOINTMENTS so an order with multiple visits shows each shoot on
  // its own day, with the photographer assigned to that specific appointment.
  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: startToday, lt: windowEnd },
      status: { not: "CANCELED" },
      project: { status: { notIn: ["CANCELLED", "DELIVERED"] } },
    },
    orderBy: { startAt: "asc" },
    include: {
      project: { select: { id: true, title: true, status: true, client: { select: { name: true, avatarUrl: true } } } },
      assignedTo: true,
    },
  });

  const groups = new Map<string, typeof appts>();
  for (const a of appts) {
    const k = etFullDate(a.startAt!);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }

  return (
    <div>
      <PageHeader
        title="Schedule"
        subtitle={`${appts.length} upcoming shoot${appts.length === 1 ? "" : "s"} · next ${WINDOW_DAYS} days`}
        actions={<ScheduleViewToggle view="list" />}
      />
      <div className="space-y-6 p-6">
        {appts.length === 0 && <p className="text-sm text-muted">No shoots scheduled in the next {WINDOW_DAYS} days.</p>}
        {[...groups.entries()].map(([day, items]) => (
          <div key={day}>
            <div className="mb-2 flex items-center gap-2">
              <CalendarDays className="size-4 text-brand" />
              <h2 className="text-sm font-semibold">{day}</h2>
              <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{items.length}</span>
            </div>
            <div className="overflow-hidden rounded-2xl border bg-surface">
              {items.map((a) => {
                const p = a.project;
                const stage = stageMeta(p.status);
                const time = etTime(a.startAt!);
                return (
                  <Link
                    key={a.id}
                    href={`/shoot/${p.id}`}
                    className="flex items-center gap-4 border-b px-5 py-3 last:border-0 hover:bg-surface-2"
                  >
                    <div className="w-16 shrink-0 text-sm font-semibold text-foreground/80">{time}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                        <MapPinIcon className="size-3.5 shrink-0 text-muted-2" />
                        {p.title}
                      </div>
                      {/* The agent's headshot beside their name (Jordan: show the
                          Aryeo profile photo "in other places the clients are
                          mentioned"); initials when Aryeo has no photo. */}
                      <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                        <Avatar name={p.client.name} src={p.client.avatarUrl} size={18} color="#4f46e5" />
                        <span className="truncate">{p.client.name}</span>
                      </div>
                    </div>
                    <Badge color={stage.color} soft={stage.soft}>
                      {stage.short}
                    </Badge>
                    {a.assignedTo ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <Avatar name={a.assignedTo.name} color={a.assignedTo.avatarColor} size={22} />
                        <span className="hidden sm:inline">{a.assignedTo.name.split(" ")[0]}</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-muted-2">
                        <Camera className="size-3.5" /> Unassigned
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Map view: geocoded appointments on the interactive route map -------------
// (Moved verbatim from the old /map route so the pins/day-picker/route logic is
// unchanged — only the data window's forward end is now the shared WINDOW_DAYS.)
async function MapView() {
  const now = new Date();
  const from = new Date(now.getTime() - MAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: from, lte: to },
      status: { not: "CANCELED" },
      project: { status: { notIn: ["CANCELLED"] }, lat: { not: null }, lng: { not: null } },
    },
    orderBy: { startAt: "asc" },
    include: {
      project: {
        select: {
          id: true, title: true, lat: true, lng: true, status: true,
          client: { select: { name: true } },
          deliverables: { where: { removedFromOrderAt: null }, select: { type: true } },
        },
      },
      assignedTo: { select: { name: true, homeLat: true, homeLng: true, homeRadiusMi: true } },
    },
  });

  const pins: MapPin[] = appts.map((a) => {
    const p = a.project;
    const stage = stageMeta(p.status);
    return {
      id: a.id,
      projectId: p.id,
      title: p.title,
      lat: p.lat!,
      lng: p.lng!,
      color: stage.color,
      stage: stage.short,
      client: p.client.name,
      shootISO: a.startAt?.toISOString() ?? null,
      endISO: a.endAt?.toISOString() ?? null,
      photographer: a.assignedTo?.name ?? null,
      homeLat: a.assignedTo?.homeLat ?? null,
      homeLng: a.assignedTo?.homeLng ?? null,
      radiusMi: a.assignedTo?.homeRadiusMi ?? null,
      dayKey: a.startAt ? etDayKey(a.startAt) : "",
      hasDrone: hasDroneOps(p.deliverables),
    };
  });

  // Build the day selector (ordered, with counts + friendly labels).
  const byDay = new Map<string, number>();
  const labelByDay = new Map<string, string>();
  for (const a of appts) {
    if (!a.startAt) continue;
    const k = etDayKey(a.startAt);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
    if (!labelByDay.has(k)) {
      const today = isTodayET(a.startAt);
      labelByDay.set(
        k,
        today
          ? "Today"
          : a.startAt.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }),
      );
    }
  }
  const days: MapDay[] = [...byDay.keys()].sort().map((k) => ({ key: k, label: labelByDay.get(k)!, count: byDay.get(k)! }));

  // Default to today if it has shoots, else the next upcoming day with shoots.
  const todayKey = etDayKey(now);
  const upcoming = days.find((d) => d.key >= todayKey);
  const defaultDay = days.find((d) => d.key === todayKey)?.key ?? upcoming?.key ?? days[days.length - 1]?.key ?? "";

  return (
    <div>
      <PageHeader
        title="Schedule"
        subtitle={`${days.length} shoot days · pick a day to see the route, weather & drive times`}
        actions={<ScheduleViewToggle view="map" />}
      />
      <div className="p-4 sm:p-6">
        {pins.length === 0 ? (
          <p className="text-sm text-muted">No upcoming shoots with locations yet.</p>
        ) : (
          <ProjectMap pins={pins} days={days} defaultDay={defaultDay} />
        )}
      </div>
    </div>
  );
}

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requirePageAccess("schedule");
  const sp = await searchParams;
  const view: ScheduleView = sp.view === "map" ? "map" : "list";
  // Each view early-returns its own query (communications pattern): the List
  // never runs the geocoded/map pull, the Map never runs the grouped-day pull.
  return view === "map" ? <MapView /> : <ListView />;
}
