import { PageHeader } from "@/components/PageHeader";
import { ProjectMap, type MapPin, type MapDay } from "@/components/map/ProjectMap";
import { prisma } from "@/lib/prisma";
import { stageMeta } from "@/lib/pipeline";
import { hasDroneOps } from "@/components/project/DroneBadge";
import { etDayKey, isTodayET } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function MapPage() {
  // Shoots (appointments) with coordinates, from a week ago through the next
  // ~60 days — so the day overview covers what's coming up.
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

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
          deliverables: { select: { type: true } },
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
      <PageHeader title="Map" subtitle={`${days.length} shoot days · pick a day to see the route, weather & drive times`} />
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
