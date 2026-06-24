import Link from "next/link";
import {
  Camera,
  Palette,
  CheckCircle2,
  DollarSign,
  AlertTriangle,
  CalendarDays,
  ArrowRight,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { getDashboardData, getMorningBrief, getOverdueTasks, getShootWindow } from "@/lib/queries";
import { MorningBrief, type BriefShoot } from "@/components/dashboard/MorningBrief";
import { formatMoney } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { etTime, etFullDate, etMonth, etDayNum, etDaysAgo } from "@/lib/datetime";

export const dynamic = "force-dynamic";

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
  sub,
}: {
  icon: typeof Camera;
  label: string;
  value: string | number;
  accent: string;
  sub?: string;
}) {
  return (
    <div className="panel-shadow rounded-2xl border bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{label}</span>
        <span
          className="flex size-8 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accent}1a`, color: accent }}
        >
          <Icon className="size-4" />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function toBriefShoot(s: {
  apptId: string; id: string; title: string; shootDate: Date | null;
  client: { name: string }; photographer: { name: string } | null;
}): BriefShoot {
  return {
    key: s.apptId,
    id: s.id,
    title: s.title,
    time: s.shootDate ? etTime(s.shootDate) : "",
    clientName: s.client.name,
    photographer: s.photographer?.name ?? null,
  };
}

export default async function DashboardPage() {
  const [data, brief, overdue, shoots] = await Promise.all([
    getDashboardData(),
    getMorningBrief(),
    getOverdueTasks(),
    getShootWindow(),
  ]);
  const today = etFullDate(new Date());

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={today} />

      <div className="space-y-6 p-6">
        {/* Kyle's morning brief — the first thing he sees each day */}
        <MorningBrief
          tasks={brief}
          todayShoots={shoots.today.map(toBriefShoot)}
          tomorrowShoots={shoots.tomorrow.map(toBriefShoot)}
        />

        {/* Stat row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatCard
            icon={Camera}
            label="Today's shoots"
            value={shoots.today.length}
            accent="#4f46e5"
            sub={shoots.tomorrow.length ? `${shoots.tomorrow.length} tomorrow` : `${data.counts.active} active projects`}
          />
          <StatCard
            icon={Palette}
            label="In editing"
            value={data.counts.editing}
            accent="#d97706"
          />
          <StatCard
            icon={CheckCircle2}
            label="In review / QC"
            value={data.counts.review}
            accent="#db2777"
          />
          <StatCard
            icon={CheckCircle2}
            label="Delivered (mo.)"
            value={data.counts.deliveredThisMonth}
            accent="#16a34a"
            sub={formatMoney(data.revenueThisMonth)}
          />
          <StatCard
            icon={DollarSign}
            label="Revenue in pipeline"
            value={formatMoney(data.pipelineRevenue)}
            accent="#0ea5e9"
            sub="active orders"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Needs attention — overdue / not finished on prior days */}
          <div className="panel-shadow lg:col-span-2 rounded-2xl border bg-surface">
            <div className="flex items-center justify-between border-b px-5 py-3.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-danger" />
                <h2 className="text-sm font-semibold">Needs attention</h2>
                {overdue.length > 0 && (
                  <span className="rounded-full bg-danger/10 px-1.5 text-xs font-medium text-danger">
                    {overdue.length} overdue
                  </span>
                )}
              </div>
              <Link
                href="/queue"
                className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                Daily tasks <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="max-h-[420px] divide-y overflow-y-auto scroll-thin">
              {overdue.length === 0 && (
                <div className="px-5 py-8 text-center text-sm text-muted">
                  All clear — nothing carried over. 🎉
                </div>
              )}
              {overdue.map((t) => (
                <Link
                  key={t.id}
                  href={t.projectId ? `/projects/${t.projectId}` : "/queue"}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{t.title}</div>
                    <div className="truncate text-xs text-muted">{t.clientName ?? t.propertyAddress ?? ""}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {t.priority === "URGENT" && <Badge color="#f87171">Urgent</Badge>}
                    <Badge color="#f87171">
                      {(() => {
                        if (!t.dueAt) return "overdue";
                        const od = etDaysAgo(new Date(t.dueAt)); // ET calendar-day delta
                        return od >= 1 ? `${od}d overdue` : "overdue";
                      })()}
                    </Badge>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Upcoming shoots */}
          <div className="panel-shadow rounded-2xl border bg-surface">
            <div className="flex items-center gap-2 border-b px-5 py-3.5">
              <CalendarDays className="size-4 text-accent" />
              <h2 className="text-sm font-semibold">Upcoming shoots</h2>
            </div>
            <div className="divide-y">
              {data.upcomingShoots.length === 0 && (
                <div className="px-5 py-8 text-center text-sm text-muted">
                  No shoots in the next 7 days.
                </div>
              )}
              {data.upcomingShoots.map((p) => (
                <Link
                  key={p.apptId}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2"
                >
                  <div className="flex flex-col items-center rounded-lg bg-surface-2 px-2 py-1 text-center">
                    <span className="text-[10px] font-medium uppercase text-muted">
                      {etMonth(p.shootDate!)}
                    </span>
                    <span className="text-base font-semibold leading-none">
                      {etDayNum(p.shootDate!)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.title}</div>
                    <div className="truncate text-xs text-muted">
                      {etTime(p.shootDate!)} ·{" "}
                      {p.photographer?.name ?? "Unassigned"}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Recent activity */}
        <div className="panel-shadow rounded-2xl border bg-surface">
          <div className="border-b px-5 py-3.5">
            <h2 className="text-sm font-semibold">Recent activity</h2>
          </div>
          <div className="divide-y">
            {data.recentActivity.length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-muted">No recent activity.</div>
            )}
            {data.recentActivity.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-5 py-3">
                {a.author ? (
                  <Avatar name={a.author.name} color={a.author.avatarColor} size={26} />
                ) : (
                  <span className="flex size-[26px] items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-muted">
                    SYS
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    {a.author && <span className="font-medium">{a.author.name} </span>}
                    <span className="text-foreground/80">{a.body}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    <Link href={`/projects/${a.projectId}`} className="hover:underline">
                      {a.project.title}
                    </Link>{" "}
                    · {formatDistanceToNow(a.createdAt, { addSuffix: true })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
