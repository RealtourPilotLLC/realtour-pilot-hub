import Link from "next/link";
import { DollarSign, TrendingUp, Receipt, Wallet } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { stageMeta } from "@/lib/pipeline";
import { formatMoney } from "@/lib/utils";
import { format, startOfMonth, subMonths, isSameMonth } from "date-fns";

export const dynamic = "force-dynamic";

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
  sub,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
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

export default async function SalesPage() {
  const projects = await prisma.project.findMany({ include: { client: true } });
  const now = new Date();

  const active = projects.filter((p) => p.status !== "DELIVERED" && p.status !== "CANCELLED");
  const delivered = projects.filter((p) => p.deliveredAt);

  const pipelineValue = active.reduce((s, p) => s + (p.price ?? 0), 0);
  const revenueThisMonth = delivered
    .filter((p) => isSameMonth(p.deliveredAt!, now))
    .reduce((s, p) => s + (p.price ?? 0), 0);
  const allTime = delivered.reduce((s, p) => s + (p.price ?? 0), 0);
  const avgOrder =
    projects.length > 0
      ? projects.reduce((s, p) => s + (p.price ?? 0), 0) / projects.length
      : 0;

  // Revenue by month (last 6 months), booked by createdAt.
  const months = Array.from({ length: 6 }, (_, i) => startOfMonth(subMonths(now, 5 - i)));
  const byMonth = months.map((m) => ({
    label: format(m, "MMM"),
    value: projects
      .filter((p) => isSameMonth(p.createdAt, m))
      .reduce((s, p) => s + (p.price ?? 0), 0),
  }));
  const maxMonth = Math.max(1, ...byMonth.map((m) => m.value));

  // Revenue by client.
  const byClient = Object.values(
    projects.reduce<Record<string, { name: string; total: number; count: number }>>((acc, p) => {
      const k = p.client.id;
      acc[k] ??= { name: p.client.name, total: 0, count: 0 };
      acc[k].total += p.price ?? 0;
      acc[k].count += 1;
      return acc;
    }, {}),
  ).sort((a, b) => b.total - a.total);

  const recent = [...projects].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <div>
      <PageHeader
        title="Sales & Finance"
        subtitle="Revenue, orders, and pipeline value"
        actions={
          <Badge soft="var(--surface-2)">QuickBooks &amp; Stripe sync — coming with integrations</Badge>
        }
      />
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={DollarSign} label="Revenue this month" value={formatMoney(revenueThisMonth)} accent="#16a34a" />
          <StatCard icon={Wallet} label="Pipeline value" value={formatMoney(pipelineValue)} accent="#0ea5e9" sub={`${active.length} active orders`} />
          <StatCard icon={Receipt} label="Avg order value" value={formatMoney(avgOrder)} accent="#4f46e5" />
          <StatCard icon={TrendingUp} label="Delivered (all-time)" value={formatMoney(allTime)} accent="#d97706" sub={`${delivered.length} orders`} />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Bookings by month */}
          <div className="rounded-2xl border bg-surface lg:col-span-2">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Bookings by month</h2>
            </div>
            <div className="flex items-end gap-4 px-6 py-6" style={{ height: 220 }}>
              {byMonth.map((m) => (
                <div key={m.label} className="flex flex-1 flex-col items-center justify-end gap-2">
                  <span className="text-xs font-medium text-muted">{formatMoney(m.value)}</span>
                  <div
                    className="w-full rounded-t-lg bg-brand"
                    style={{ height: `${(m.value / maxMonth) * 140 + 4}px`, opacity: 0.85 }}
                  />
                  <span className="text-xs text-muted">{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* By client */}
          <div className="rounded-2xl border bg-surface">
            <div className="border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Revenue by client</h2>
            </div>
            <div className="divide-y">
              {byClient.map((c) => (
                <div key={c.name} className="flex items-center justify-between px-5 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted">{c.count} orders</div>
                  </div>
                  <span className="text-sm font-semibold">{formatMoney(c.total)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Orders table */}
        <div className="rounded-2xl border bg-surface">
          <div className="border-b px-5 py-3.5">
            <h2 className="text-sm font-semibold">Orders</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-2">
                <th className="px-5 py-2 font-medium">Property</th>
                <th className="px-5 py-2 font-medium">Client</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Booked</th>
                <th className="px-5 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((p) => {
                const stage = stageMeta(p.status);
                return (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-surface-2">
                    <td className="px-5 py-2.5">
                      <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                        {p.title}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5 text-muted">{p.client.name}</td>
                    <td className="px-5 py-2.5">
                      <Badge color={stage.color} soft={stage.soft}>
                        {stage.short}
                      </Badge>
                    </td>
                    <td className="px-5 py-2.5 text-muted">{format(p.createdAt, "MMM d, yyyy")}</td>
                    <td className="px-5 py-2.5 text-right font-semibold">{formatMoney(p.price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
