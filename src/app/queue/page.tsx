import { AlertTriangle, CalendarClock, ListTodo, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { TaskCard, type QueueTask } from "@/components/queue/TaskCard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];

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

export default async function QueuePage() {
  const tasks = await prisma.smartTask.findMany({
    where: { status: { in: ACTIVE } },
    orderBy: [{ dueAt: "asc" }],
    include: { client: { select: { name: true } } },
  });
  const completedCount = await prisma.smartTask.count({ where: { status: "COMPLETED" } });

  const now = new Date();
  const endToday = new Date(now.toDateString()).getTime() + 86400000;
  const views = tasks.map(toView);

  const urgent = views.filter((t) => t.priority === "URGENT");
  const rest = views.filter((t) => t.priority !== "URGENT");
  const dueToday = rest.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < endToday);
  const upcoming = rest.filter((t) => !dueToday.includes(t));

  const Section = ({ title, icon: Icon, items, accent }: { title: string; icon: typeof ListTodo; items: QueueTask[]; accent?: string }) =>
    items.length === 0 ? null : (
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Icon className="size-4" style={{ color: accent ?? "var(--brand)" }} />
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

  return (
    <div>
      <PageHeader
        title="Kyle's Queue"
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
            <p className="text-sm text-muted">Queue is clear — nothing needs attention right now. 🎉</p>
          </div>
        ) : (
          <>
            <Section title="Urgent now" icon={AlertTriangle} items={urgent} accent="#dc2626" />
            <Section title="Due today" icon={CalendarClock} items={dueToday} accent="#d97706" />
            <Section title="Upcoming" icon={ListTodo} items={upcoming} />
          </>
        )}
      </div>
    </div>
  );
}
