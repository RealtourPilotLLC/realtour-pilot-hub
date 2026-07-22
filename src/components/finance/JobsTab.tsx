import Link from "next/link";
import { Briefcase, DollarSign, Camera, Percent, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { jobProfitability } from "@/lib/jobProfit";
import { etDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 60;
const m0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const m2 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctOf = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

// Per-job P&L: each shoot's revenue minus the EXACT pay of the photographer who
// shot it (base + mileage). "What each job really costs me, down to the penny."
export async function JobsTab({ show }: { show: FinanceTab[] }) {
  const now = new Date();
  const start = new Date(now.getTime() - WINDOW_DAYS * 864e5);
  const data = await jobProfitability(start, now);

  // Best/worst only over jobs with a cost actually booked — a $0-cost job (owner
  // shot it, payout excluded, or rates unconfigured) shows a fake 100% margin and
  // would falsely crown "most profitable."
  const rated = data.jobs.filter((j) => j.revenue > 0 && (j.photographerCost > 0 || j.editingCost > 0));
  const best = [...rated].sort((a, b) => (b.marginPct ?? -9) - (a.marginPct ?? -9))[0];
  const worst = [...rated].sort((a, b) => (a.marginPct ?? 9) - (b.marginPct ?? 9))[0];

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Jobs" subtitle={`Every shoot's true margin — last ${WINDOW_DAYS} days`} />
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="jobs" show={show} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={Briefcase} accent="#6ba3d6" label="Jobs shot" value={String(data.count)} sub={`last ${WINDOW_DAYS} days`} />
          <Kpi icon={DollarSign} accent="#5cb98a" label="Revenue" value={m0(data.revenue)} sub="eligible invoice" />
          <Kpi icon={Camera} accent="#d4a95f" label="Shooter + editing" value={m0(data.photographerCost + data.editingCost)} sub={`${m0(data.photographerCost)} shoot · ${m0(data.editingCost)} Luma`} />
          <Kpi icon={Percent} accent={data.avgMarginPct != null && data.avgMarginPct < 0.3 ? "#ec6a6a" : "#5cb98a"} label="Avg margin" value={pctOf(data.avgMarginPct)} sub={`${m0(data.margin)} after shooter + Luma`} />
        </div>

        {/* best / worst */}
        {best && worst && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-border bg-surface p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-success">Most profitable</div>
              <div className="mt-0.5 truncate text-sm font-semibold">{best.title}</div>
              <div className="mt-1 text-xs text-muted">{m0(best.revenue)} in · {m0(best.photographerCost)} to {best.photographer} · <span className="font-semibold text-success">{pctOf(best.marginPct)} margin</span></div>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-warning">Thinnest margin</div>
              <div className="mt-0.5 truncate text-sm font-semibold">{worst.title}</div>
              <div className="mt-1 text-xs text-muted">{m0(worst.revenue)} in · {m0(worst.photographerCost)} to {worst.photographer} · <span className={`font-semibold ${(worst.marginPct ?? 0) < 0.3 ? "text-danger" : "text-foreground"}`}>{pctOf(worst.marginPct)} margin</span></div>
            </div>
          </div>
        )}

        {/* PER-JOB TABLE */}
        <section className="rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-sm font-semibold">
            <Briefcase className="size-4 text-brand" /> Job-by-job
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-2">
                  <th className="px-5 py-2 font-medium">Property</th>
                  <th className="px-3 py-2 font-medium">Shooter</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Revenue</th>
                  <th className="px-3 py-2 text-right font-medium">Photog</th>
                  <th className="px-3 py-2 text-right font-medium">Editing</th>
                  <th className="px-3 py-2 text-right font-medium">Margin</th>
                  <th className="px-5 py-2 text-right font-medium">%</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.id} className="border-b border-border/60 last:border-0 hover:bg-surface-2">
                    <td className="px-5 py-2.5">
                      <Link href={`/projects/${j.id}`} className="font-medium text-foreground/90 hover:text-brand hover:underline">{j.title}</Link>
                      <div className="truncate text-[11px] text-muted-2">{j.client}</div>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{j.photographer}</td>
                    <td className="px-3 py-2.5 text-muted-2">{j.shootDate ? etDate(j.shootDate) : "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{m2(j.revenue)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{m2(j.photographerCost)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted" title={j.lumaVideos ? `${j.lumaVideos} premium video/reel × $299 (Luma)` : "no Luma editing"}>{j.editingCost ? m2(j.editingCost) : "—"}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${j.margin < 0 ? "text-danger" : "text-foreground"}`}>{m2(j.margin)}</td>
                    <td className={`px-5 py-2.5 text-right tabular-nums ${j.marginPct != null && j.marginPct < 0.3 ? "text-warning" : "text-muted"}`}>{pctOf(j.marginPct)}</td>
                  </tr>
                ))}
                {data.jobs.length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-muted">No shoots in the last {WINDOW_DAYS} days.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <p className="flex items-start gap-1.5 px-1 text-[11px] text-muted-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          Margin = revenue − the <span className="font-medium text-muted">photographer</span> (exact base + mileage) − <span className="font-medium text-muted">Luma editing</span> ($299 per premium video/reel, exact). Still to fold in per-job: AutoHDR ($0.50 × raw-photo count, pulling from Dropbox) and the in-house editors (Remar/Kim/Kyle — a monthly pool allocated across jobs). Card fees live on the Overview.
        </p>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, accent, label, value, sub }: { icon: LucideIcon; accent: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${accent}1a`, color: accent }}>
          <Icon className="size-4" />
        </span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}
