import { CheckCircle2, MessageSquare, PencilLine, PackageCheck, Users, ChevronDown, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { TaskCard, type QueueTask } from "@/components/queue/TaskCard";
import { TaskFocus } from "@/components/queue/TaskFocus";
import { taskToView } from "@/lib/taskView";
import { prisma } from "@/lib/prisma";
import { recentProjectWhere } from "@/lib/recency";
import { etDayStartUtc } from "@/lib/datetime";
import { isDelegated, EDITORS, DELEGATE_KEYS, type EditorKey } from "@/lib/editors";

export const dynamic = "force-dynamic";

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];
const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const rank = (t: QueueTask) => PRIORITY_RANK[t.priority] ?? 9;
const dueMs = (t: QueueTask) => (t.dueAt ? new Date(t.dueAt).getTime() : Infinity);

// Which "Needs you" group a non-delegated task belongs to.
function category(taskType: string): "comms" | "revisions" | "qc" {
  if (taskType === "revision") return "revisions";
  if (["media_qa", "image_fixes", "delivery", "feedback_review"].includes(taskType)) return "qc";
  return "comms"; // replies, instructions, leads, confirmations, delivery texts, decisions
}

// In-progress statuses that read as "being worked" for the delegated summary.
const WORKING = new Set(["IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN"]);

// Collapsible group panel — collapsed by default (native <details>, so no client
// JS needed). The header (counts + overdue) stays visible; click to expand.
function GroupCard({ icon: Icon, title, accent, items, overdue, blurb }: {
  icon: LucideIcon; title: string; accent: string; items: QueueTask[]; overdue: number; blurb?: string;
}) {
  return (
    <details className="group panel-shadow overflow-hidden rounded-2xl border bg-surface">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 hover:bg-surface-2">
        <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
        <span className="flex size-7 items-center justify-center rounded-lg" style={{ background: `${accent}22`, color: accent }}>
          <Icon className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{items.length}</span>
        {overdue > 0 && <span className="rounded-full bg-danger-soft px-1.5 text-[11px] font-semibold text-danger">{overdue} overdue</span>}
      </summary>
      <div className="border-t border-border">
        {blurb && <p className="px-4 pt-2.5 text-[11px] text-muted-2">{blurb}</p>}
        <div className="grid grid-cols-1 gap-3 p-3 sm:p-4 lg:grid-cols-2">
          {items.map((t) => <TaskCard key={t.id} task={t} />)}
        </div>
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

  const startToday = etDayStartUtc(new Date()).getTime();
  const isOverdue = (t: QueueTask) => !!t.dueAt && new Date(t.dueAt).getTime() < startToday;
  // Urgency sort: overdue first, then priority, then soonest due.
  const cmp = (a: QueueTask, b: QueueTask) =>
    (isOverdue(a) ? 0 : 1) - (isOverdue(b) ? 0 : 1) || rank(a) - rank(b) || dueMs(a) - dueMs(b);

  const views = tasks.map(taskToView);
  const delegated = views.filter((v) => isDelegated(v.assignedKey));
  const needsYou = views.filter((v) => !isDelegated(v.assignedKey));

  const comms = needsYou.filter((v) => category(v.taskType) === "comms").sort(cmp);
  const revisions = needsYou.filter((v) => category(v.taskType) === "revisions").sort(cmp);
  const qc = needsYou.filter((v) => category(v.taskType) === "qc").sort(cmp);

  const byEditor = DELEGATE_KEYS
    .map((k: EditorKey) => ({ key: k, meta: EDITORS[k], items: delegated.filter((v) => v.assignedKey === k).sort(cmp) }))
    .filter((g) => g.items.length > 0);

  const overdueCount = views.filter(isOverdue).length;
  const oc = (items: QueueTask[]) => items.filter(isOverdue).length;
  const nothing = views.length === 0;

  return (
    <div>
      <TaskFocus />
      <PageHeader
        eyebrow="Eastern time"
        title="Daily Tasks"
        subtitle={`${needsYou.length} need you · ${delegated.length} delegated${overdueCount ? ` · ${overdueCount} overdue` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            {overdueCount > 0 && <Badge color="#dc2626" soft="#fee2e2">{overdueCount} overdue</Badge>}
            <Badge soft="var(--surface-2)"><CheckCircle2 className="mr-1 inline size-3 text-success" />{completedCount} done</Badge>
          </div>
        }
      />
      <div className="space-y-5 p-4 sm:p-6">
        {nothing ? (
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <CheckCircle2 className="mx-auto mb-2 size-6 text-success" />
            <p className="text-sm text-muted">All caught up — nothing open. 🎉</p>
          </div>
        ) : (
          <>
            {/* NEEDS YOU */}
            <div className="flex items-center gap-2 px-1 pt-1">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-2">Needs you</h2>
              <span className="text-xs text-muted-2">· {needsYou.length}</span>
            </div>
            {comms.length > 0 && (
              <GroupCard icon={MessageSquare} title="Replies & admin" accent="#38bdf8" items={comms} overdue={oc(comms)}
                blurb="Messages to reply to, new leads, confirmations, delivery texts, and decisions." />
            )}
            {revisions.length > 0 && (
              <GroupCard icon={PencilLine} title="Revisions" accent="#fb7185" items={revisions} overdue={oc(revisions)}
                blurb="Client change requests after delivery — assign each to the right editor when you action it." />
            )}
            {qc.length > 0 && (
              <GroupCard icon={PackageCheck} title="QC & deliver" accent="#34d399" items={qc} overdue={oc(qc)}
                blurb="Quality-check content as it lands, then deliver." />
            )}
            {comms.length + revisions.length + qc.length === 0 && (
              <p className="rounded-2xl border border-dashed bg-surface px-4 py-6 text-center text-sm text-muted">Nothing needs you right now.</p>
            )}

            {/* DELEGATED */}
            {byEditor.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-1 pt-2">
                  <Users className="size-3.5 text-muted-2" />
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-2">Delegated — in progress</h2>
                  <span className="text-xs text-muted-2">· {delegated.length}</span>
                </div>
                {byEditor.map((g) => {
                  const working = g.items.filter((t) => WORKING.has(t.status)).length;
                  const overdue = oc(g.items);
                  return (
                    <details key={g.key} suppressHydrationWarning className="group panel-shadow overflow-hidden rounded-2xl border bg-surface">
                      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 hover:bg-surface-2">
                        <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
                        <span className="flex size-7 items-center justify-center rounded-lg bg-brand/15 text-brand"><Users className="size-4" /></span>
                        <h3 className="text-sm font-semibold">{g.meta.name}</h3>
                        <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-muted-2">{g.meta.kind === "external" ? "external" : "in-house"}</span>
                        <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{g.items.length}</span>
                        {working > 0 && <span className="text-[11px] text-muted-2">{working} in progress</span>}
                        {overdue > 0 && <span className="rounded-full bg-danger-soft px-1.5 text-[11px] font-semibold text-danger">{overdue} overdue</span>}
                      </summary>
                      <div className="grid grid-cols-1 gap-3 border-t border-border p-3 sm:p-4 lg:grid-cols-2">
                        {g.items.map((t) => <TaskCard key={t.id} task={t} />)}
                      </div>
                    </details>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
