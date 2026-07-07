import { CheckCircle2, MessageSquare, MessageSquareText, Send, PencilLine, PackageCheck, UserPlus, ChevronDown, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { TaskCard, type QueueTask } from "@/components/queue/TaskCard";
import { TaskFocus } from "@/components/queue/TaskFocus";
import { AddTask } from "@/components/queue/AddTask";
import { taskToView } from "@/lib/taskView";
import { MESSAGE_TASK_TYPES } from "@/lib/queries";
import { prisma } from "@/lib/prisma";
import { recentProjectWhere } from "@/lib/recency";
import { etDayStartUtc } from "@/lib/datetime";
import { listAssignees, slugForName, firstName } from "@/lib/assignees";
import { isNeedsAssigning } from "@/lib/triage";
import { getCurrentUser } from "@/lib/auth/user";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];
const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const rank = (t: QueueTask) => PRIORITY_RANK[t.priority] ?? 9;
const dueMs = (t: QueueTask) => (t.dueAt ? new Date(t.dueAt).getTime() : Infinity);

// Which category a task belongs to within a person's list.
function category(taskType: string): "confirmations" | "deliveries" | "comms" | "revisions" | "qc" {
  if (["confirmation_text", "appointment_prep"].includes(taskType)) return "confirmations";
  if (taskType === "delivery_text") return "deliveries";
  if (taskType === "revision") return "revisions";
  if (["media_qa", "image_fixes", "delivery", "feedback_review", "finish_delivery"].includes(taskType)) return "qc";
  return "comms"; // replies, instructions, leads, decisions
}

// Triage ("needs assigning") is shared with the morning brief via src/lib/triage.
const TRIAGE = "needs-assigning";

// Collapsible group panel — collapsed by default (native <details>, so no client
// JS needed). The header (counts + overdue) stays visible; click to expand.
function GroupCard({ icon: Icon, title, accent, items, overdue, blurb, assignees, defaultOpen, assignPrompt, editorView }: {
  icon: LucideIcon; title: string; accent: string; items: QueueTask[]; overdue: number; blurb?: string;
  assignees: { key: string; name: string }[]; defaultOpen?: boolean; assignPrompt?: boolean; editorView?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group panel-shadow overflow-hidden rounded-2xl border bg-surface">
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
          {items.map((t) => <TaskCard key={t.id} task={t} assignees={assignees} assignPrompt={assignPrompt} editorView={editorView} />)}
        </div>
      </div>
    </details>
  );
}

function FilterChip({ href, label, count, active }: { href: string; label: string; count: number; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
        active ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("rounded-full px-1.5 text-[10px]", active ? "bg-white/20" : "bg-surface-2")}>{count}</span>
    </Link>
  );
}

export default async function DailyTasksPage({ searchParams }: { searchParams: Promise<{ who?: string }> }) {
  const sp = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  // Editors are scoped to their OWN delegated work — never the whole team's
  // queue. editorKey = kim/remar/…; fall back to their first-name slug.
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;
  const [tasks, assignees] = await Promise.all([
    prisma.smartTask.findMany({
      where: {
        status: { in: ACTIVE },
        // DB-level scope for editors, so their view can't even load others' work.
        ...(editorScope ? { assignedKey: editorScope } : {}),
        OR: [
          { projectId: null },
          { project: recentProjectWhere() },
          // Messages/replies surface regardless of project age — same as the
          // morning brief — so clicking one in the brief always finds it here.
          { taskType: { in: MESSAGE_TASK_TYPES } },
        ],
      },
      include: { client: { select: { name: true } } },
    }),
    listAssignees(),
  ]);
  const completedCount = await prisma.smartTask.count({ where: { status: "COMPLETED" } });
  const assigneeChips = assignees.map((a) => ({ key: a.key, name: a.name }));

  const startToday = etDayStartUtc(new Date()).getTime();
  const isOverdue = (t: QueueTask) => !!t.dueAt && new Date(t.dueAt).getTime() < startToday;
  const cmp = (a: QueueTask, b: QueueTask) =>
    (isOverdue(a) ? 0 : 1) - (isOverdue(b) ? 0 : 1) || rank(a) - rank(b) || dueMs(a) - dueMs(b);

  const views = tasks.map(taskToView);
  // Pull the "needs assigning" pile out first — delegatable work with no owner
  // yet — so it surfaces in its own pinned section instead of hiding in Kyle's
  // pile. Everything else has a home (an editor, or Kyle's default routine).
  const triage = views.filter(isNeedsAssigning);
  const assigned = views.filter((v) => !isNeedsAssigning(v));
  // Unassigned routine work still defaults to Kyle (he runs the daily queue).
  const ownerKey = (v: QueueTask) => v.assignedKey || "kyle";
  const countOf = (key: string) => assigned.filter((v) => ownerKey(v) === key).length;

  // "My tasks" = the signed-in person, matched to their assignee slug.
  const meKey = me?.name ? slugForName(me.name) : null;
  const meHasChip = !!meKey && assignees.some((a) => a.key === meKey);

  // Selected filter. ?who=all | me | needs-assigning | <slug>. An editor is
  // locked to their own key (the ?who= param can't broaden their view).
  const whoRaw = (editorScope ?? sp.who ?? "all").toLowerCase();
  const who = whoRaw === "me" && meKey ? meKey : whoRaw;
  const activeKey = whoRaw === "all" ? "all" : whoRaw === "me" && meKey ? "me" : who;
  // Person buckets are built from assigned work only (triage renders on its own).
  const forGrouping = who === "all" ? assigned : who === TRIAGE ? [] : assigned.filter((v) => ownerKey(v) === who);

  const byKey = new Map<string, QueueTask[]>();
  for (const v of forGrouping) {
    const k = ownerKey(v);
    const arr = byKey.get(k);
    if (arr) arr.push(v);
    else byKey.set(k, [v]);
  }

  const overdueCount = views.filter(isOverdue).length;
  const oc = (items: QueueTask[]) => items.filter(isOverdue).length;
  const nothing = views.length === 0;
  const showTriage = !editorScope && (who === "all" || who === TRIAGE) && triage.length > 0;
  // Nothing to render for the current filter (but there ARE tasks elsewhere).
  const empty = !showTriage && forGrouping.length === 0;

  // The category-grouped cards for one person.
  const personSection = (name: string, set: QueueTask[]) => {
    if (set.length === 0) return null;
    const confirmations = set.filter((v) => category(v.taskType) === "confirmations").sort(cmp);
    const deliveries = set.filter((v) => category(v.taskType) === "deliveries").sort(cmp);
    const comms = set.filter((v) => category(v.taskType) === "comms").sort(cmp);
    const revisions = set.filter((v) => category(v.taskType) === "revisions").sort(cmp);
    const qc = set.filter((v) => category(v.taskType) === "qc").sort(cmp);
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-2 px-1 pt-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-2">Needs {name}</h2>
          <span className="text-xs text-muted-2">· {set.length}</span>
        </div>
        {comms.length > 0 && (
          <GroupCard icon={MessageSquare} title="Replies & admin" accent="#38bdf8" items={comms} overdue={oc(comms)} assignees={assigneeChips} editorView={!!editorScope}
            blurb="Messages to reply to, new leads, and decisions." />
        )}
        {confirmations.length > 0 && (
          <GroupCard icon={MessageSquareText} title="Confirmation texts" accent="#fbbf24" items={confirmations} overdue={oc(confirmations)} assignees={assigneeChips} editorView={!!editorScope}
            blurb="Confirm upcoming shoots with the client — the text is pre-drafted, just review and send." />
        )}
        {deliveries.length > 0 && (
          <GroupCard icon={Send} title="Delivery texts" accent="#22c55e" items={deliveries} overdue={oc(deliveries)} assignees={assigneeChips} editorView={!!editorScope}
            blurb="The “your gallery is ready” text to the client after delivery — pre-drafted, just review and send." />
        )}
        {revisions.length > 0 && (
          <GroupCard icon={PencilLine} title="Revisions" accent="#fb7185" items={revisions} overdue={oc(revisions)} assignees={assigneeChips} editorView={!!editorScope}
            blurb="Client change requests after delivery — auto-routed to the deliverable's editor; reassign if it should go to someone else." />
        )}
        {qc.length > 0 && (
          <GroupCard icon={PackageCheck} title="QC & deliver" accent="#34d399" items={qc} overdue={oc(qc)} assignees={assigneeChips} editorView={!!editorScope}
            blurb="Quality-check content as it lands, then deliver." />
        )}
      </div>
    );
  };

  // Sections in roster order; any assignedKey not in the roster falls through last.
  const sections = assignees.filter((a) => (byKey.get(a.key)?.length ?? 0) > 0);
  const known = new Set(assignees.map((a) => a.key));
  const orphans = [...byKey.keys()].filter((k) => !known.has(k));
  const selectedName = assignees.find((a) => a.key === who)?.name ?? firstName(who);

  // The "needs assigning" pile — pinned above the person sections, open by
  // default, so unowned work is a visible number, not something to hunt for.
  const triageSection = (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1 pt-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#d97706" }}>Needs assigning</h2>
        <span className="text-xs text-muted-2">· {triage.length}</span>
      </div>
      <GroupCard icon={UserPlus} title="Pick who owns each" accent="#f59e0b" items={triage.slice().sort(cmp)} overdue={oc(triage)} assignees={assigneeChips} defaultOpen assignPrompt
        blurb="Work that came in without an owner — mostly Slack to-dos. Assign each to the right person and it moves to their list." />
    </div>
  );

  return (
    <div>
      <TaskFocus />
      <PageHeader
        eyebrow="Eastern time"
        title="Daily Tasks"
        subtitle={`${views.length} open${triage.length ? ` · ${triage.length} to assign` : ""}${overdueCount ? ` · ${overdueCount} overdue` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            {triage.length > 0 && <Badge color="#b45309" soft="#fef3c7">{triage.length} to assign</Badge>}
            {overdueCount > 0 && <Badge color="#dc2626" soft="#fee2e2">{overdueCount} overdue</Badge>}
            <Badge soft="var(--surface-2)"><CheckCircle2 className="mr-1 inline size-3 text-success" />{completedCount} done</Badge>
          </div>
        }
      />
      <div className="space-y-5 p-4 sm:p-6">
        <AddTask assignees={assigneeChips} />

        {/* Person filter — see everyone, just you, or one teammate's tasks.
            Hidden for editors, who are locked to their own work. */}
        {!nothing && !editorScope && (
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip href="/queue" label="Everyone" count={views.length} active={activeKey === "all"} />
            {meHasChip && <FilterChip href="/queue?who=me" label="My tasks" count={countOf(meKey!)} active={activeKey === "me"} />}
            {triage.length > 0 && <FilterChip href={`/queue?who=${TRIAGE}`} label="Needs assigning" count={triage.length} active={activeKey === TRIAGE} />}
            {assignees
              .filter((a) => countOf(a.key) > 0 || a.key === who)
              .map((a) => (
                <FilterChip key={a.key} href={`/queue?who=${a.key}`} label={a.name} count={countOf(a.key)} active={activeKey === a.key} />
              ))}
          </div>
        )}

        {nothing ? (
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <CheckCircle2 className="mx-auto mb-2 size-6 text-success" />
            <p className="text-sm text-muted">All caught up — nothing open. 🎉</p>
          </div>
        ) : empty ? (
          <p className="rounded-2xl border border-dashed bg-surface px-4 py-6 text-center text-sm text-muted">
            {who === TRIAGE
              ? "Nothing needs assigning right now."
              : `Nothing assigned to ${activeKey === "me" ? "you" : selectedName} right now.`}
          </p>
        ) : (
          <>
            {showTriage && triageSection}
            {who === "all" ? (
              <>
                {sections.map((a) => <Fragment key={a.key}>{personSection(a.name, byKey.get(a.key)!.slice().sort(cmp))}</Fragment>)}
                {orphans.map((k) => <Fragment key={k}>{personSection(firstName(k), byKey.get(k)!.slice().sort(cmp))}</Fragment>)}
              </>
            ) : who === TRIAGE ? null : (
              personSection(selectedName, forGrouping.slice().sort(cmp))
            )}
          </>
        )}
      </div>
    </div>
  );
}
