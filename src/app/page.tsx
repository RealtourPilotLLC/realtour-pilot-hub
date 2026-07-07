import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, AlertTriangle, Camera, CheckCircle2, MessageSquare, PackageCheck, Sun, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ProactiveFlags } from "@/components/dashboard/ProactiveFlags";
import {
  getMorningBrief, getOverdueTasks, getShootWindow, getProactiveFlags,
  getHandledToday, getOwnerStats, DELIVER_TASK_TYPES,
} from "@/lib/queries";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier, homeFor } from "@/lib/auth/access";
import { isNeedsAssigning } from "@/lib/triage";
import { formatMoney } from "@/lib/utils";
import { etFullDate, etTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// The dashboard's ONE job: a 10-second, role-aware glance — is anything on
// fire, and one button into where the work happens (/today). It shows COUNTS;
// /today shows rows. It never renders a task list. Keep it to ~one phone
// screen with exactly one primary CTA. (The old page was ~5,000px tall with
// 154 links and no primary action — don't let it grow back.)

function CountChip({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <Link
      href="/today"
      className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm hover:bg-surface-2"
    >
      <span className="text-lg font-semibold tabular-nums" style={{ color: tone }}>{count}</span>
      <span className="text-muted">{label}</span>
    </Link>
  );
}

export default async function DashboardPage() {
  const me = await getCurrentUser().catch(() => null);
  // Creatives never see the ops overview (middleware already bounces the roles;
  // this covers per-user "dashboard" permission overrides). Sessionless local
  // dev renders the full owner view.
  if (me && contentTier(me.role) === "CREATIVE") redirect(homeFor(me.role));
  const isOwner = !me || me.role === "OWNER";

  const [brief, overdue, shoots, radar, handledToday, ownerStats] = await Promise.all([
    getMorningBrief(),
    getOverdueTasks(),
    getShootWindow(),
    getProactiveFlags(),
    getHandledToday(),
    isOwner ? getOwnerStats() : Promise.resolve(null),
  ]);

  const replies = brief.filter((t) => ["client_reply", "lead"].includes(t.taskType)).length;
  const toAssign = brief.filter(isNeedsAssigning).length;
  const toQc = brief.filter((t) => DELIVER_TASK_TYPES.includes(t.taskType)).length;
  const total = brief.length;
  const blockers = overdue.slice(0, 3);
  const firstName = me?.name?.split(" ")[0] ?? (isOwner ? "Jordan" : "there");
  const allClear = total === 0 && overdue.length === 0 && shoots.today.length === 0;
  const nextTomorrow = shoots.tomorrow[0] ?? null;

  return (
    <div>
      <PageHeader eyebrow="Eastern time" title="Dashboard" subtitle={etFullDate(new Date())} />
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {/* 1 · Orientation */}
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand/15 text-brand"><Sun className="size-5" /></span>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Good morning, {firstName}</h2>
            <p className="text-xs text-muted">{handledToday} thing{handledToday === 1 ? "" : "s"} handled today</p>
          </div>
        </div>

        {allClear ? (
          /* All clear — one calm card instead of five empty sections. */
          <div className="panel-shadow rounded-2xl border border-border bg-surface p-6 text-center">
            <CheckCircle2 className="mx-auto size-8 text-success" />
            <p className="mt-2 text-sm font-semibold">You&apos;re clear — {handledToday} handled today.</p>
            <p className="mt-1 text-xs text-muted">
              Next shoot: {nextTomorrow ? `tomorrow ${etTime(nextTomorrow.shootDate!)} — ${nextTomorrow.title.split(",")[0]} · ${nextTomorrow.photographer?.name ?? "unassigned"}` : "none scheduled"}
            </p>
          </div>
        ) : (
          <>
            {/* 2 · THE button — the page's single primary action */}
            <Link
              href="/today"
              className="flex w-full items-center justify-between rounded-2xl bg-brand px-5 py-4 text-white shadow-lg transition-opacity hover:opacity-90"
            >
              <span className="text-base font-semibold">Start your day</span>
              <span className="flex items-center gap-2 text-sm font-medium opacity-90">
                {total} thing{total === 1 ? "" : "s"} need you <ArrowRight className="size-4" />
              </span>
            </Link>

            {/* 3 · The numbers without the walls */}
            <div className="flex gap-2">
              <CountChip label="replies" count={replies} tone="#38bdf8" />
              <CountChip label="to QC" count={toQc} tone="#a78bfa" />
              <CountChip label="to assign" count={toAssign} tone="#d97706" />
            </div>

            {/* 4 · Blockers — overdue carry-over, capped at 3 */}
            {blockers.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-danger/30 bg-surface">
                <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-danger">
                  <AlertTriangle className="size-3.5" /> Blockers
                </div>
                <div className="divide-y divide-border/60">
                  {blockers.map((t) => (
                    <Link key={t.id} href="/today" className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-surface-2">
                      <span className="min-w-0 truncate">{t.title}</span>
                      <span className="shrink-0 text-[11px] font-medium text-danger">overdue</span>
                    </Link>
                  ))}
                </div>
                {overdue.length > 3 && (
                  <Link href="/today" className="block border-t border-border px-4 py-2 text-xs font-medium text-brand hover:underline">
                    +{overdue.length - 3} more → Today
                  </Link>
                )}
              </div>
            )}

            {/* 5 · Today's schedule (rendered once — the only shoots list here) */}
            <div className="panel-shadow rounded-2xl border border-border bg-surface">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
                <Camera className="size-3.5" /> Today&apos;s shoots
                <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{shoots.today.length}</span>
              </div>
              {shoots.today.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-2">No shoots today.</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {shoots.today.slice(0, 4).map((s) => (
                    <Link key={s.apptId} href={`/shoot/${s.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-surface-2">
                      <span className="min-w-0 truncate">{s.title.split(",")[0]}</span>
                      <span className="shrink-0 text-xs text-muted">{etTime(s.shootDate!)} · {s.photographer?.name ?? "Unassigned"}</span>
                    </Link>
                  ))}
                </div>
              )}
              <Link href="/schedule" className="block border-t border-border px-4 py-2 text-xs text-muted hover:text-foreground">
                Tomorrow: {shoots.tomorrow.length} shoot{shoots.tomorrow.length === 1 ? "" : "s"} → Schedule
              </Link>
            </div>
          </>
        )}

        {/* 6 · Radar — fresh risk only (≤3; creatives never reach this page) */}
        {radar.flags.length > 0 && <ProactiveFlags flags={radar.flags} />}

        {/* 7 · Money strip — owner only */}
        {isOwner && ownerStats && (
          <Link href="/sales" className="panel-shadow flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl border border-border bg-surface px-5 py-3.5 text-sm hover:bg-surface-2">
            <span><span className="text-muted">Delivered this month</span> <b>{formatMoney(ownerStats.revenueThisMonth)}</b> <span className="text-muted-2">({ownerStats.deliveredThisMonth})</span></span>
            <span><span className="text-muted">Pipeline</span> <b>{formatMoney(ownerStats.pipelineRevenue)}</b> <span className="text-muted-2">({ownerStats.activeCount} active)</span></span>
            {radar.topAr && <span><span className="text-muted">Top AR</span> <b>{radar.topAr.name} {formatMoney(radar.topAr.total)}</b></span>}
            <ArrowRight className="ml-auto size-4 text-muted-2" />
          </Link>
        )}

        {/* Quiet secondary links — everything else lives in the sidebar */}
        <div className="flex flex-wrap items-center gap-4 px-1 text-xs text-muted-2">
          <Link href="/queue" className="hover:text-foreground">Full task board</Link>
          <Link href="/pipeline" className="hover:text-foreground">Project tracker</Link>
          <span className="ml-auto inline-flex items-center gap-3">
            {toAssign > 0 && <span><UserPlus className="mr-1 inline size-3" />{toAssign} unassigned</span>}
            <span><PackageCheck className="mr-1 inline size-3" />{toQc} in QC</span>
            <span><MessageSquare className="mr-1 inline size-3" />{replies} waiting</span>
          </span>
        </div>
      </div>
    </div>
  );
}
