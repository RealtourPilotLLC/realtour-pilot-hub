import { AlertTriangle, Sun, Sunrise, CalendarRange, Inbox, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { TaskCard, type QueueTask } from "@/components/queue/TaskCard";
import { prisma } from "@/lib/prisma";
import { recentProjectWhere } from "@/lib/recency";

export const dynamic = "force-dynamic";

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];
const DAY = 86400000;
const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function toView(t: {
  id: string; title: string; taskType: string; status: string; priority: string;
  dueAt: Date | null; reasonCreated: string | null; checklist: string | null; source: string;
  projectId: string | null; propertyAddress: string | null; client: { name: string } | null;
}): QueueTask {
  return {
    id: t.id, title: t.title, taskType: t.taskType, status: t.status, priority: t.priority,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null, reasonCreated: t.reasonCreated,
    checklist: t.checklist ? (JSON.parse(t.checklist) as string[]) : [],
    source: t.source, projectId: t.projectId, clientName: t.client?.name ?? null, propertyAddress: t.propertyAddress,
  };
}

export default async function DailyTasksPage() {
  const tasks = await prisma.smartTask.findMany({
    // Current work only: open tasks that are unlinked or tied to a project
    // still inside the last-30-day window (finished old jobs drop off).
    where: {
      status: { in: ACTIVE },
      OR: [{ projectId: null }, { project: recentProjectWhere() }],
    },
    include: { client: { select: { name: true } } },
  });
  const completedCount = await prisma.smartTask.count({ where: { status: "COMPLETED" } });

  const now = new Date();
  const startToday = new Date(now.toDateString()).getTime();
  const startTomorrow = startToday + DAY;
  const startDayAfter = startToday + 2 * DAY;
  const endWeek = startToday + 7 * DAY;

  const views = tasks
    .map(toView)
    .sort((a, b) => {
      const pr = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      if (pr !== 0) return pr;
      return (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity);
    });

  const bucket = (t: QueueTask): string => {
    if (!t.dueAt) return "nodate";
    const d = new Date(t.dueAt).getTime();
    if (d < startToday) return "overdue";
    if (d < startTomorrow) return "today";
    if (d < startDayAfter) return "tomorrow";
    if (d < endWeek) return "week";
    return "later";
  };

  const groups: Record<string, QueueTask[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], nodate: [] };
  for (const v of views) groups[bucket(v)].push(v);

  const SECTIONS: { key: string; title: string; icon: typeof Sun; accent: string }[] = [
    { key: "overdue", title: "Overdue", icon: AlertTriangle, accent: "#dc2626" },
    { key: "today", title: "Today", icon: Sun, accent: "#d97706" },
    { key: "tomorrow", title: "Tomorrow", icon: Sunrise, accent: "#0ea5e9" },
    { key: "week", title: "This week", icon: CalendarRange, accent: "#4f46e5" },
    { key: "later", title: "Later", icon: CalendarRange, accent: "#64748b" },
    { key: "nodate", title: "No due date", icon: Inbox, accent: "#64748b" },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Last 2 weeks"
        title="Daily Tasks"
        subtitle={`${views.length} open task${views.length === 1 ? "" : "s"}`}
        actions={
          <Badge soft="var(--surface-2)">
            <CheckCircle2 className="mr-1 inline size-3 text-success" />
            {completedCount} done
          </Badge>
        }
      />
      <div className="space-y-8 p-6">
        {views.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <CheckCircle2 className="mx-auto mb-2 size-6 text-success" />
            <p className="text-sm text-muted">All caught up — nothing due. 🎉</p>
          </div>
        ) : (
          SECTIONS.map(({ key, title, icon: Icon, accent }) => {
            const items = groups[key];
            if (items.length === 0) return null;
            return (
              <section key={key}>
                <div className="mb-3 flex items-center gap-2">
                  <Icon className="size-4" style={{ color: accent }} />
                  <h2 className="text-sm font-semibold">{title}</h2>
                  <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{items.length}</span>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {items.map((t) => (
                    <TaskCard key={t.id} task={t} />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
