import Link from "next/link";
import { Trophy, TrendingUp, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { prisma } from "@/lib/prisma";
import { quarterFor, scorecardFor, poolMath, splitPool, type Scorecard } from "@/lib/bonus";
import { revenueByProcessor } from "@/lib/bookkeeping";
import { categoryBreakdown } from "@/lib/financeCategories";
import { PayBonusButton } from "@/components/finance/PayBonusButton";

export const dynamic = "force-dynamic";
const m = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// The quarterly performance bonus — LAUNCHED Aug 25 (Jordan: "Do the bonus
// engine"). The engine (src/lib/bonus.ts) was fully built and calibrated to
// real Q2 numbers but wired to nothing. Self-funding: the pool is a share of
// profit ABOVE a threshold — a quarter that misses the bar pays $0 by
// construction. This page COMPUTES; the owner's Pay button is the only thing
// that moves money (a PayoutAdjustment per person, visible on Payroll).
const DEFAULTS = { threshold: 15000, percent: 0.15, cap: 5000 };

async function bonusSettings() {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: ["bonus-threshold", "bonus-percent", "bonus-cap"] } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    threshold: Number(get("bonus-threshold") ?? DEFAULTS.threshold),
    percent: Number(get("bonus-percent") ?? DEFAULTS.percent),
    cap: get("bonus-cap") === "none" ? null : Number(get("bonus-cap") ?? DEFAULTS.cap),
  };
}

export async function BonusTab({ show, back = 0 }: { show: FinanceTab[]; back?: number }) {
  const q = quarterFor(undefined, back);
  const settings = await bonusSettings();

  // The quarter's money — same engines as Overview (processor revenue,
  // categorized business cost).
  const [rev, cats] = await Promise.all([
    revenueByProcessor(q.startKey, q.endKey),
    categoryBreakdown(q.startKey, q.endKey),
  ]);
  const pool = poolMath({
    revenue: rev.total,
    cost: cats.businessTotal,
    threshold: settings.threshold,
    poolPercent: settings.percent,
    poolCap: settings.cap,
  });

  // Who's scored: active shooting creatives (OWN basis) + the creative manager
  // (TEAM basis — accountable for everyone's results).
  const members = await prisma.teamMember.findMany({
    where: { active: true, role: { in: ["PHOTOGRAPHER", "MANAGER"] } },
    select: { id: true, name: true, creativeManager: true, role: true },
  });
  const cards: Scorecard[] = [];
  for (const tm of members) {
    const basis = tm.creativeManager ? "TEAM" : "OWN";
    if (tm.role === "MANAGER" && !tm.creativeManager) continue; // ops managers aren't in the shoot bonus
    cards.push(await scorecardFor(q, { memberId: basis === "TEAM" ? null : tm.id, name: tm.name, basis }).then((c) => ({ ...c, memberId: tm.id })));
  }
  const split = splitPool(pool.pool, cards);

  const already = await prisma.payoutAdjustment.findMany({
    where: { label: { startsWith: `Quarterly bonus ${q.quarter}` } },
    select: { teamMemberId: true, amount: true },
  });
  const paidTo = new Map(already.map((a) => [a.teamMemberId, a.amount]));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Quarterly bonus" subtitle={`${q.label} — self-funding: a share of profit above the bar, $0 when the bar isn't cleared`} />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="bonus" show={show} />

        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          {[0, 1, 2].map((b) => {
            const qq = quarterFor(undefined, b);
            return (
              <Link key={b} href={`/sales?tab=bonus&back=${b}`}
                className={b === back ? "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white" : "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2"}>
                {qq.label}
              </Link>
            );
          })}
        </div>

        {/* THE POOL */}
        <section className="panel-shadow rounded-2xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <Trophy className="size-3.5 text-brand" /> Bonus pool — {q.label}
              </div>
              <div className={`mt-0.5 text-3xl font-bold tabular-nums ${pool.funded ? "text-success" : "text-muted"}`}>{m(pool.pool)}</div>
              <p className="mt-1 max-w-xl text-xs text-muted">{pool.why}</p>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-muted">
              <span>Revenue <b className="text-foreground">{m(pool.revenue)}</b></span>
              <span>Costs <b className="text-foreground">{m(pool.cost)}</b></span>
              <span>Profit <b className="text-foreground">{m(pool.surplus)}</b></span>
              <span>Bar <b className="text-foreground">{m(pool.threshold)}</b></span>
              <span>Share <b className="text-foreground">{Math.round(pool.poolPercent * 100)}%</b>{pool.poolCap != null && <> · cap <b className="text-foreground">{m(pool.poolCap)}</b></>}</span>
            </div>
          </div>
        </section>

        {/* SCORECARDS */}
        {cards.map((c) => (
          <section key={c.memberId} className="panel-shadow rounded-2xl border border-border bg-surface">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
              <span className="flex items-center gap-2 text-sm font-semibold">
                {c.basis === "TEAM" ? <Users className="size-4 text-brand" /> : <TrendingUp className="size-4 text-brand" />}
                {c.name}
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{c.basis === "TEAM" ? "team results" : "own shoots"}</span>
              </span>
              <span className="ml-auto flex items-center gap-3">
                <span className="text-xs text-muted">{c.shoots} shoots</span>
                <span className="text-sm font-bold tabular-nums">{c.score == null ? "not enough data" : `${Math.round(c.score)}/100`}</span>
                <span className={`text-sm font-bold tabular-nums ${split[c.memberId] > 0 ? "text-success" : "text-muted-2"}`}>{m(split[c.memberId] ?? 0)}</span>
                {paidTo.has(c.memberId) ? (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">paid {m(paidTo.get(c.memberId) ?? 0)}</span>
                ) : (
                  split[c.memberId] > 0 && <PayBonusButton memberId={c.memberId} name={c.name.split(" ")[0]} amount={split[c.memberId]} quarter={q.quarter} />
                )}
              </span>
            </div>
            <div className="divide-y divide-border/60">
              {c.metrics.map((mt) => (
                <div key={mt.key} className="flex flex-wrap items-center gap-3 px-5 py-2 text-sm">
                  <span className="w-40 shrink-0 font-medium">{mt.label}{mt.thin && <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] text-muted-2">dropped — thin data</span>}</span>
                  <span className="min-w-0 flex-1 text-xs text-muted">{mt.detail}</span>
                  <span className="shrink-0 text-xs text-muted">{mt.value}</span>
                  <span className="w-16 shrink-0 text-right text-xs font-semibold tabular-nums">{mt.thin ? "—" : `${Math.round(mt.points)}/${Math.round(mt.maxPoints)}`}</span>
                </div>
              ))}
            </div>
          </section>
        ))}

        <p className="px-1 text-[11px] text-muted-2">
          The pool is {Math.round(settings.percent * 100)}% of quarterly profit above {m(settings.threshold)}{settings.cap != null ? `, capped at ${m(settings.cap)}` : ""}, split by score.
          Nothing pays automatically — the Pay button writes the bonus onto that person&rsquo;s next payout (visible on Payroll), and that&rsquo;s the only money path.
          Improvement is scored against each person&rsquo;s own prior quarter, so getting better pays even from a low base.
        </p>
      </div>
    </div>
  );
}
