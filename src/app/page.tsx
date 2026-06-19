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
import { getDashboardData, getMorningBrief } from "@/lib/queries";
import { MorningBrief } from "@/components/dashboard/MorningBrief";
import { stageMeta } from "@/lib/pipeline";
import { formatMoney } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

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
    <div className="rounded-2xl border bg-surface p-4">
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

export default async function DashboardPage() {
  const [data, brief] = await Promise.all([getDashboardData(), getMorningBrief()]);
  const today = format(new Date(), "EEEE, MMMM d");

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={today} />

      <div className="space-y-6 p-6">
        {/* Kyle's morning brief — the first thing he sees each day */}
        <MorningBrief tasks={brief} />

        {/* Stat row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatCard
            icon={Camera}
            label="Active projects"
            value={data.counts.active}
            accent="#4f46e5"
            sub={`${data.counts.booked} awaiting scheduling`}
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
          {/* Needs attention */}
          <div className="lg:col-span-2 rounded-2xl border bg-surface">
            <div className="flex items-center justify-between border-b px-5 py-3.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-warning" />
                <h2 className="text-sm font-semibold">Needs attention</h2>
              </div>
              <Link
                href="/pipeline"
                className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                View pipeline <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="divide-y">
              {data.needsAttention.length === 0 && (
                <div className="px-5 py-8 text-center text-sm text-muted">
                  All clear — nothing overdue or urgent. 🎉
                </div>
              )}
              {data.needsAttention.map(({ project, reasons }) => {
                const stage = stageMeta(project.status);
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{project.title}</div>
                      <div className="truncate text-xs text-muted">
                        {project.client.name}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {reasons.map((r) => (
                        <Badge
                          key={r}
                          color={r.includes("overdue") || r === "Urgent" ? "#dc2626" : "#d97706"}
                          soft={r.includes("overdue") || r === "Urgent" ? "#fee2e2" : "#fef3c7"}
                        >
                          {r}
                        </Badge>
                      ))}
                      <Badge color={stage.color} soft={stage.soft}>
                        {stage.short}
                      </Badge>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Upcoming shoots */}
          <div className="rounded-2xl border bg-surface">
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
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2"
                >
                  <div className="flex flex-col items-center rounded-lg bg-surface-2 px-2 py-1 text-center">
                    <span className="text-[10px] font-medium uppercase text-muted">
                      {format(p.shootDate!, "MMM")}
                    </span>
                    <span className="text-base font-semibold leading-none">
                      {format(p.shootDate!, "d")}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.title}</div>
                    <div className="truncate text-xs text-muted">
                      {format(p.shootDate!, "h:mm a")} ·{" "}
                      {p.photographer?.name ?? "Unassigned"}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Recent activity */}
        <div className="rounded-2xl border bg-surface">
          <div className="border-b px-5 py-3.5">
            <h2 className="text-sm font-semibold">Recent activity</h2>
          </div>
          <div className="divide-y">
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
