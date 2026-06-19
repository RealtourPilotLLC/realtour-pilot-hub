import Link from "next/link";
import { CalendarDays, MapPin, Camera } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { stageMeta } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

function dayKey(d: Date) {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export default async function SchedulePage() {
  const startToday = new Date(new Date().toDateString());

  // Driven off APPOINTMENTS so an order with multiple visits shows each shoot on
  // its own day, with the photographer assigned to that specific appointment.
  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: startToday },
      status: { not: "CANCELED" },
      project: { status: { notIn: ["CANCELLED", "DELIVERED"] } },
    },
    orderBy: { startAt: "asc" },
    include: {
      project: { select: { id: true, title: true, status: true, client: { select: { name: true } } } },
      assignedTo: true,
    },
  });

  const groups = new Map<string, typeof appts>();
  for (const a of appts) {
    const k = dayKey(a.startAt!);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }

  return (
    <div>
      <PageHeader
        title="Schedule"
        subtitle={`${appts.length} upcoming shoot${appts.length === 1 ? "" : "s"}`}
        actions={<Badge soft="var(--surface-2)">From Aryeo appointments</Badge>}
      />
      <div className="space-y-6 p-6">
        {appts.length === 0 && <p className="text-sm text-muted">No upcoming shoots scheduled.</p>}
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
                const time = a.startAt!.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
                return (
                  <Link
                    key={a.id}
                    href={`/projects/${p.id}`}
                    className="flex items-center gap-4 border-b px-5 py-3 last:border-0 hover:bg-surface-2"
                  >
                    <div className="w-16 shrink-0 text-sm font-semibold text-foreground/80">{time}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                        <MapPin className="size-3.5 shrink-0 text-muted-2" />
                        {p.title}
                      </div>
                      <div className="truncate text-xs text-muted">{p.client.name}</div>
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
