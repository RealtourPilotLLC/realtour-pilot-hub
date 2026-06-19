import Link from "next/link";
import {
  Sun,
  MessageSquare,
  CalendarDays,
  PackageCheck,
  PhoneCall,
  KanbanSquare,
  CheckCircle2,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import type { BriefTask } from "@/lib/queries";

export type BriefShoot = {
  key: string;
  id: string;
  title: string;
  time: string;
  clientName: string;
  photographer: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  openphone: "OpenPhone",
  slack: "Slack",
  gmail: "Gmail",
  feedback: "Feedback",
};

function dueTime(iso: string | null): string {
  if (!iso) return "";
  return "by " + new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function TaskRow({ t }: { t: BriefTask }) {
  return (
    <Link
      href={t.projectId ? `/projects/${t.projectId}` : "/queue"}
      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
    >
      <span className="truncate text-sm">{t.title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
        {SOURCE_LABEL[t.source] && (
          <span className="rounded bg-surface-2 px-1 font-medium text-muted-2">{SOURCE_LABEL[t.source]}</span>
        )}
        {dueTime(t.dueAt)}
      </span>
    </Link>
  );
}

function Step({
  n,
  icon: Icon,
  title,
  count,
  accent,
  children,
  empty,
}: {
  n: number;
  icon: LucideIcon;
  title: string;
  count: number;
  accent: string;
  children: React.ReactNode;
  empty: string;
}) {
  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="flex size-6 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted-2">
          {n}
        </span>
        <Icon className="size-4" style={{ color: accent }} />
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{count}</span>
      </div>
      <div className="mt-1.5 pl-[34px]">
        {count === 0 ? <p className="py-1 text-xs text-muted-2">{empty}</p> : children}
      </div>
    </div>
  );
}

export function MorningBrief({
  tasks,
  todayShoots,
  tomorrowShoots,
  firstName = "Kyle",
}: {
  tasks: BriefTask[];
  todayShoots: BriefShoot[];
  tomorrowShoots: BriefShoot[];
  firstName?: string;
}) {
  const is = (...types: string[]) => tasks.filter((t) => types.includes(t.taskType));
  const messages = is("client_reply", "internal_instruction", "revision", "lead");
  const deliver = is("delivery", "media_qa", "finish_delivery", "delivery_text", "feedback_review");
  const confirm = is("appointment_prep");
  const total = tasks.length + todayShoots.length;

  return (
    <section className="overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/[0.08] via-surface to-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand/15 text-brand">
            <Sun className="size-5" />
          </span>
          <div>
            <div className="eyebrow">Your day</div>
            <h2 className="text-lg font-semibold tracking-tight">Good morning, {firstName}</h2>
          </div>
        </div>
        <Link href="/queue" className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2">
          Full task list
        </Link>
      </div>

      {total === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-muted">
          Nothing on the schedule today and no to-dos. New texts, calls, and Slack messages will show up here.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {/* 1. Comms */}
          <Step n={1} icon={MessageSquare} title="Check your messages" count={messages.length} accent="#38bdf8" empty="No messages to handle.">
            <div className="space-y-0.5">{messages.map((t) => <TaskRow key={t.id} t={t} />)}</div>
          </Step>

          {/* 2. Today's schedule debrief */}
          <Step n={2} icon={CalendarDays} title="Today's shoots" count={todayShoots.length} accent="#a78bfa" empty="No shoots today.">
            <div className="space-y-0.5">
              {todayShoots.map((s) => (
                <Link key={s.key} href={`/projects/${s.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                  <span className="truncate text-sm">{s.title}</span>
                  <span className="shrink-0 text-[11px] text-muted">{s.time} · {s.photographer ?? "Unassigned"}</span>
                </Link>
              ))}
            </div>
          </Step>

          {/* 3. QC + deliver yesterday's content */}
          <Step n={3} icon={PackageCheck} title="QC & deliver content" count={deliver.length} accent="#34d399" empty="Nothing to deliver today.">
            <p className="mb-1 text-[11px] text-muted-2">
              Check verticals + horizontals, no odd AI edits / reflections / blemishes, item removal + virtual staging done, and every ordered deliverable is on Aryeo.
            </p>
            <div className="space-y-0.5">{deliver.map((t) => <TaskRow key={t.id} t={t} />)}</div>
          </Step>

          {/* 4. Confirm tomorrow */}
          <Step n={4} icon={PhoneCall} title="Confirm tomorrow's shoots" count={confirm.length + tomorrowShoots.length} accent="#fbbf24" empty="Nothing to confirm.">
            <div className="space-y-0.5">
              {confirm.map((t) => <TaskRow key={t.id} t={t} />)}
              {tomorrowShoots.map((s) => (
                <Link key={s.key} href={`/projects/${s.id}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                  <span className="truncate text-sm text-muted">{s.title}</span>
                  <span className="shrink-0 text-[11px] text-muted-2">tomorrow {s.time} · {s.photographer ?? "Unassigned"}</span>
                </Link>
              ))}
            </div>
          </Step>

          {/* 5. Tracker check */}
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex size-6 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted-2">5</span>
              <KanbanSquare className="size-4 text-muted" />
              <h3 className="text-sm font-semibold">Update the project tracker</h3>
            </div>
            <Link href="/pipeline" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
              Open pipeline <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

// Small caught-up banner reused on the dashboard.
export function AllCaught() {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
      <CheckCircle2 className="size-4" /> All caught up
    </span>
  );
}
