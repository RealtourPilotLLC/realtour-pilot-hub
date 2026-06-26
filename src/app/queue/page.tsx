import Link from "next/link";
import { CheckCircle2, Inbox, ChevronDown, Camera, AlertTriangle, Sun, CalendarClock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { TaskCard, type QueueTask } from "@/components/queue/TaskCard";
import { taskToView } from "@/lib/taskView";
import { prisma } from "@/lib/prisma";
import { recentProjectWhere } from "@/lib/recency";
import { etDayStartUtc, etAddDays, etMonthDay } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];
const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const rank = (t: QueueTask) => PRIORITY_RANK[t.priority] ?? 9;
const dueMs = (t: QueueTask) => (t.dueAt ? new Date(t.dueAt).getTime() : Infinity);

type Group = {
  projectId: string; label: string; client: string | null; tasks: QueueTask[];
  minRank: number; minDue: number; overdue: number; types: string[];
};

function buildGroups(tasks: QueueTask[], startToday: number): { groups: Group[]; general: QueueTask[] } {
  const byProject = new Map<string, QueueTask[]>();
  const general: QueueTask[] = [];
  for (const v of tasks) {
    if (v.projectId) { if (!byProject.has(v.projectId)) byProject.set(v.projectId, []); byProject.get(v.projectId)!.push(v); }
    else general.push(v);
  }
  const groups: Group[] = [...byProject.entries()].map(([projectId, ts]) => {
    ts.sort((a, b) => rank(a) - rank(b) || dueMs(a) - dueMs(b));
    return {
      projectId,
      label: (ts[0].propertyAddress || ts[0].clientName || "Project").split(",")[0],
      client: ts[0].clientName,
      tasks: ts,
      minRank: Math.min(...ts.map(rank)),
      minDue: Math.min(...ts.map(dueMs)),
      overdue: ts.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < startToday).length,
      types: [...new Set(ts.map((t) => t.taskType))],
    };
  });
  groups.sort((a, b) => a.minRank - b.minRank || a.minDue - b.minDue || b.tasks.length - a.tasks.length);
  general.sort((a, b) => rank(a) - rank(b) || dueMs(a) - dueMs(b));
  return { groups, general };
}

function JobGroup({ g, open }: { g: Group; open: boolean }) {
  const dueChip =
    g.overdue > 0 ? <span className="rounded-full bg-danger-soft px-1.5 text-[11px] font-semibold text-danger">{g.overdue} overdue</span>
    : isFinite(g.minDue) ? <span className="text-[11px] text-muted-2">due {etMonthDay(new Date(g.minDue))}</span>
    : null;
  return (
    <details open={open} className="group rounded-2xl border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-surface-2">
        <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><Camera className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{g.label}</span>{dueChip}</div>
          <div className="truncate text-xs text-muted">{g.client ? `${g.client} · ` : ""}{g.tasks.length} task{g.tasks.length === 1 ? "" : "s"} · {g.types.map((t) => t.replace(/_/g, " ")).join(", ")}</div>
        </div>
        <Link href={`/projects/${g.projectId}`} className="hidden shrink-0 text-xs text-muted hover:text-foreground sm:inline">Open →</Link>
      </summary>
      <div className="grid gap-3 border-t border-border p-3 sm:p-4 lg:grid-cols-2">
        {g.tasks.map((t) => <TaskCard key={t.id} task={t} />)}
      </div>
    </details>
  );
}

export default async function DailyTasksPage() {
  const tasks = await prisma.smartTask.findMany({
    where: { status: { in: ACTIVE }, OR: [{ projectId: null }, { project: recentProjectWhere() }] },
    include: { client: { select: { name: true } } },
  });
  const completedCount = await prisma.smartTask.count({ where: { status: "COMPLETED" } });

  // ET day boundaries (the business runs on Eastern).
  const now = new Date();
  const startToday = etDayStartUtc(now).getTime();
  const startTomorrow = etDayStartUtc(etAddDays(now, 1)).getTime();

  const views = tasks.map(taskToView);
  const overdue = views.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < startToday);
  const today = views.filter((t) => { const d = dueMs(t); return d === Infinity || (d >= startToday && d < startTomorrow); });
  const upcoming = views.filter((t) => { const d = dueMs(t); return d !== Infinity && d >= startTomorrow; });

  const od = buildGroups(overdue, startToday);
  const td = buildGroups(today, startToday);
  const up = buildGroups(upcoming, startToday);

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="Daily Tasks"
        subtitle={`${today.length} for today · ${overdue.length} overdue · ${upcoming.length} upcoming`}
        actions={
          <div className="flex items-center gap-2">
            {overdue.length > 0 && <Badge color="#dc2626" soft="#fee2e2">{overdue.length} overdue</Badge>}
            <Badge soft="var(--surface-2)"><CheckCircle2 className="mr-1 inline size-3 text-success" />{completedCount} done</Badge>
          </div>
        }
      />
      <div className="space-y-6 p-4 sm:p-6">
        {views.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <CheckCircle2 className="mx-auto mb-2 size-6 text-success" />
            <p className="text-sm text-muted">All caught up — nothing due. 🎉</p>
          </div>
        ) : (
          <>
            {/* OVERDUE — front and center */}
            {overdue.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <AlertTriangle className="size-4 text-danger" />
                  <h2 className="text-sm font-semibold text-danger">Overdue</h2>
                  <span className="rounded-full bg-danger-soft px-1.5 text-xs font-medium text-danger">{overdue.length}</span>
                </div>
                <div className="space-y-3">
                  {od.general.length > 0 && <GeneralBlock items={od.general} />}
                  {od.groups.map((g) => <JobGroup key={g.projectId} g={g} open />)}
                </div>
              </section>
            )}

            {/* TODAY — the daily focus */}
            <section>
              <div className="mb-3 flex items-center gap-2">
                <Sun className="size-4 text-warning" />
                <h2 className="text-sm font-semibold">Today</h2>
                <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{today.length}</span>
              </div>
              {today.length === 0 ? (
                <p className="rounded-2xl border border-dashed bg-surface px-4 py-6 text-center text-sm text-muted">Nothing due today.</p>
              ) : (
                <div className="space-y-3">
                  {td.general.length > 0 && <GeneralBlock items={td.general} />}
                  {td.groups.map((g) => <JobGroup key={g.projectId} g={g} open />)}
                </div>
              )}
            </section>

            {/* UPCOMING — collapsed by default */}
            {upcoming.length > 0 && (
              <details className="group rounded-2xl border bg-surface">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 hover:bg-surface-2">
                  <ChevronDown className="size-4 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
                  <CalendarClock className="size-4 text-brand" />
                  <h2 className="text-sm font-semibold">Upcoming</h2>
                  <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{upcoming.length}</span>
                </summary>
                <div className="space-y-3 border-t border-border p-3 sm:p-4">
                  {up.general.length > 0 && <GeneralBlock items={up.general} />}
                  {up.groups.map((g) => <JobGroup key={g.projectId} g={g} open={false} />)}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GeneralBlock({ items }: { items: QueueTask[] }) {
  return (
    <div className="rounded-2xl border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Inbox className="size-4 text-brand" />
        <h3 className="text-sm font-semibold">General</h3>
        <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{items.length}</span>
      </div>
      <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-2">
        {items.map((t) => <TaskCard key={t.id} task={t} />)}
      </div>
    </div>
  );
}
