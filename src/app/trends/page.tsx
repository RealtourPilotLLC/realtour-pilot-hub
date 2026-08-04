import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TrendingUp, TrendingDown, Minus, CalendarClock, Package, Users, AlertTriangle, Clock, DollarSign } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { KpiCards, type KpiItem } from "@/components/finance/KpiCards";
import { TrendChart } from "@/components/trends/TrendChart";
import { TrendsAdvisor } from "@/components/trends/TrendsAdvisor";
import { GrowthPlanCard } from "@/components/trends/GrowthPlanCard";
import { MarginByPackage, MarginByPackageSkeleton } from "@/components/trends/MarginByPackage";
import { RecurringRevenueCard } from "@/components/trends/RecurringRevenue";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { bookingTrends, serviceTrends, topSpenders } from "@/lib/trends";
import { getGrowthPlan } from "@/lib/growthPlan";
import { recurringRevenue } from "@/lib/recurring";

export const dynamic = "force-dynamic";
// The margin section runs the full payroll engine (~15s on a cold cache) and it
// streams, so the request stays open until that finishes. Without this the
// function hits the platform default, gets killed mid-stream, and the browser is
// left holding a half-sent page that never finishes loading — the whole page
// looks broken, not just the one card. /sales sets the same limit for the same
// engines.
export const maxDuration = 60;

// Trends — the leading indicators. Everything here counts orders by the date
// they were PLACED (Aryeo orderedAt), never by shoot date, because that is what
// moves first when things slow down.

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function Delta({ pct, invert }: { pct: number | null; invert?: boolean }) {
  if (pct === null || !Number.isFinite(pct)) return <span className="text-muted-2">—</span>;
  const flat = Math.abs(pct) < 1;
  const good = invert ? pct < 0 : pct > 0;
  const Icon = flat ? Minus : pct > 0 ? TrendingUp : TrendingDown;
  const color = flat ? "text-muted-2" : good ? "text-success" : "text-danger";
  return (
    <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${color}`}>
      <Icon className="size-3.5" />
      {pct > 0 ? "+" : ""}{Math.round(pct)}%
    </span>
  );
}

export default async function TrendsPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/trends");
  if (me && !canAccess(me, "trends")) redirect("/");

  // The growth plan and the advisor are owner-only: they quote margins, which
  // means real payroll and editor costs.
  const isOwner = !me || me.role === "OWNER";
  const [bookings, services, spenders, growth, recurring] = await Promise.all([
    bookingTrends(),
    serviceTrends(),
    topSpenders(20),
    isOwner ? getGrowthPlan() : Promise.resolve(null),
    isOwner ? recurringRevenue().catch(() => null) : Promise.resolve(null),
  ]);

  const win = (k: string) => bookings.windows.find((w) => w.key === k)!;
  const today = win("today"), w7 = win("7d"), w30 = win("30d"), w365 = win("365d");

  const kpis: KpiItem[] = [
    {
      key: "today", icon: <CalendarClock className="size-4" />, accent: "#6366f1",
      label: "Booked today", value: String(today.count),
      sub: today.revenue > 0 ? usd0(today.revenue) : "no orders yet",
    },
    {
      key: "w7", icon: <CalendarClock className="size-4" />, accent: "#0ea5e9",
      label: "Past 7 days", value: String(w7.count),
      sub: `${usd0(w7.revenue)} · prior 7d: ${w7.prevCount}`,
      tone: (w7.countChangePct ?? 0) < -15 ? "danger" : undefined,
      detailTitle: "Past 7 days vs before",
      details: [
        { label: "Orders", value: String(w7.count), sub: `prior week ${w7.prevCount}` },
        { label: "Booked value", value: usd0(w7.revenue), sub: `prior week ${usd0(w7.prevRevenue)}` },
        { label: "Average ticket", value: usd0(w7.avgTicket) },
        { label: "Same week last year", value: w7.yoyCount === null ? "—" : String(w7.yoyCount) },
      ],
    },
    {
      key: "w30", icon: <TrendingUp className="size-4" />, accent: "#34d399",
      label: "Past 30 days", value: String(w30.count),
      sub: `${usd0(w30.revenue)} · avg ${usd0(w30.avgTicket)}`,
      tone: (w30.countChangePct ?? 0) < -15 ? "danger" : undefined,
      detailTitle: "Past 30 days vs before",
      details: [
        { label: "Orders", value: String(w30.count), sub: `prior 30d ${w30.prevCount}` },
        { label: "Booked value", value: usd0(w30.revenue), sub: `prior 30d ${usd0(w30.prevRevenue)}` },
        { label: "Average ticket", value: usd0(w30.avgTicket) },
        { label: "Same 30d last year", value: w30.yoyCount === null ? "—" : String(w30.yoyCount) },
        { label: "Cancelled", value: String(w30.cancelled), sub: "counted as booked above" },
      ],
    },
    {
      key: "w365", icon: <TrendingUp className="size-4" />, accent: "#f59e0b",
      label: "Past year", value: String(w365.count),
      sub: `${usd0(w365.revenue)} booked`,
      detailTitle: "Past 12 months",
      details: [
        { label: "Orders", value: String(w365.count), sub: `prior year ${w365.prevCount}` },
        { label: "Booked value", value: usd0(w365.revenue), sub: `prior year ${usd0(w365.prevRevenue)}` },
        { label: "Average ticket", value: usd0(w365.avgTicket) },
        { label: "Booking lead time", value: bookings.leadTimeDays.median === null ? "—" : `${bookings.leadTimeDays.median} days`, sub: "median order → shoot" },
      ],
    },
  ];

  // Computed across EVERY client, not the top-20 table — otherwise the money
  // attached to it silently misses every mid-size regular.
  // Clients on a monthly retainer are worth more than their Aryeo total shows —
  // flag them so the table is not read as their whole value.
  const onRetainer = new Set(recurring?.clientIds ?? []);
  const quiet = spenders.quiet;
  const quietShown = quiet.rows.slice(0, 12);
  const maxPackage = Math.max(1, ...services.packages.map((s) => s.orders));
  const packagesByRevenue = [...services.packages].sort((a, b) => b.revenue - a.revenue).slice(0, 12);
  const pkgRevTotal = services.packages.reduce((s, p) => s + p.revenue, 0);
  const maxPkgRev = Math.max(1, ...packagesByRevenue.map((s) => s.revenue));
  const proj = bookings.projection;
  const pctOfMonth = Math.round((proj.daysElapsed / proj.daysInMonth) * 100);

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="Trends"
        subtitle="Bookings, services and clients — counted when the order came in, not when it shoots"
      />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <KpiCards items={kpis} />

        {/* The answer, before the evidence: what to actually change. */}
        {growth && <GrowthPlanCard plan={growth.plan} builtAt={growth.builtAt ? growth.builtAt.toISOString() : null} stale={growth.stale} />}

        {/* The "is it actually slow?" answer, said plainly. */}
        <div className="rounded-2xl border border-border bg-surface p-4 text-sm panel-shadow">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="flex items-center gap-1.5">
              <span className="text-muted">Last 7 days vs the week before</span> <Delta pct={w7.countChangePct} />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted">Last 30 days vs the 30 before</span> <Delta pct={w30.countChangePct} />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted">vs the same 30 days last year</span> <Delta pct={w30.yoyChangePct} />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted">Average ticket, 30d vs prior</span> <Delta pct={w30.prevCount ? ((w30.avgTicket - (w30.prevRevenue / Math.max(1, w30.prevCount))) / (w30.prevRevenue / Math.max(1, w30.prevCount))) * 100 : null} />
            </span>
          </div>
          <p className="mt-2 text-[11px] text-muted-2">
            Orders are counted on the day the client placed them. Cancelled orders stay counted — hiding them would flatter a bad month.
            Typical order books {bookings.leadTimeDays.median ?? "—"} days before the shoot, so today&rsquo;s bookings are roughly next week&rsquo;s work.
          </p>
        </div>

        {/* THIS MONTH — where it lands if the current pace holds */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow sm:col-span-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">{proj.monthLabel} projection</h2>
              <span className="text-[11px] text-muted-2">day {proj.daysElapsed} of {proj.daysInMonth} · {pctOfMonth}% through</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-2">So far</div>
                <div className="text-2xl font-bold tabular-nums">{proj.mtdCount}</div>
                <div className="text-[11px] text-muted-2">{usd0(proj.mtdRevenue)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-2">On pace for</div>
                <div className="text-2xl font-bold tabular-nums text-brand">{proj.projectedCount}</div>
                <div className="text-[11px] text-muted-2">{usd0(proj.projectedRevenue)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-2">Last month</div>
                <div className="text-2xl font-bold tabular-nums text-muted">{proj.lastMonthCount}</div>
                <div className="text-[11px] text-muted-2">{usd0(proj.lastMonthRevenue)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-2">A year ago</div>
                <div className="text-2xl font-bold tabular-nums text-muted">{proj.yoyMonthCount ?? "—"}</div>
                <div className="text-[11px] text-muted-2">same month</div>
              </div>
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              Against the same day last month ({proj.lastMonthSamePoint} by day {proj.daysElapsed}) you are
              <Delta pct={proj.paceVsLastMonthPct} />
              <span className="text-muted-2">— that comparison is fairer than the run rate, which swings early in a month.</span>
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
            <h2 className="text-sm font-semibold">Bookings per week</h2>
            <div className="mt-3 space-y-2.5">
              {[
                { label: "Last 4 weeks", v: bookings.avgPerWeek.last4 },
                { label: "Last 12 weeks", v: bookings.avgPerWeek.last12 },
                { label: "Last 52 weeks", v: bookings.avgPerWeek.last52 },
              ].map((r) => (
                <div key={r.label} className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted">{r.label}</span>
                  <span className="text-lg font-bold tabular-nums">{r.v}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-2">
              Average orders placed per week. The 4-week number against the 52-week number is your real direction.
            </p>
          </div>
        </div>

        <TrendChart daily={bookings.daily} monthly={bookings.monthly} />

        {/* Clients going quiet — the most actionable thing on the page */}
        {quiet.count > 0 && (
          <div className="rounded-2xl border border-warning/40 bg-warning/5 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-warning">
              <AlertTriangle className="size-4" /> {quiet.count} regular{quiet.count === 1 ? "" : "s"} have gone quiet
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Past double their own normal booking gap, with at least three orders behind them. These are the accounts worth a call before
              they become last year&rsquo;s clients.
            </p>

            {/* What that silence is actually worth. */}
            <div className="mt-3 grid grid-cols-3 gap-3 rounded-xl border border-warning/25 bg-warning/[0.06] p-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-2">Spent this year</div>
                <div className="text-xl font-bold tabular-nums text-warning">{usd0(quiet.ytdRevenue)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-2">Spent with us ever</div>
                <div className="text-xl font-bold tabular-nums">{usd0(quiet.lifetimeRevenue)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-2">Worth per year</div>
                <div className="text-xl font-bold tabular-nums">{usd0(quiet.annualValue)}</div>
              </div>
            </div>

            <div className="mt-3 space-y-1.5">
              {quietShown.map((c) => (
                <div key={c.clientId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                  <Link href={`/clients/${c.clientId}`} className="font-medium hover:underline">{c.name}</Link>
                  <span className="text-muted-2">
                    normally every {c.medianGapDays}d · last ordered <span className="font-medium text-warning">{c.daysSinceLastOrder}d ago</span>
                  </span>
                  <span className="ml-auto tabular-nums text-muted">{usd0(c.ytdRevenue)} YTD</span>
                </div>
              ))}
              {quiet.count > quietShown.length && (
                <p className="pt-1 text-[11px] text-muted-2">
                  + {quiet.count - quietShown.length} more, {usd0(quiet.rows.slice(quietShown.length).reduce((s, r) => s + r.ytdRevenue, 0))} YTD between them.
                </p>
              )}
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted-2">
              &ldquo;Worth per year&rdquo; is what these clients actually paid over the last twelve months (anyone newer than a year is
              annualised over their own tenure). It is measured money, not a projection from how often they book — an earlier version
              modelled it from booking rhythm and came out more than double what they had really spent.
            </p>
          </div>
        )}

        {/* Packages, most ordered to least — the names clients actually buy.
            The DeliverableType enum is deliberately NOT used here: it collapses
            "Premium Social Reel" and "Social Reel" into one line, hiding that
            they are different products at different prices. */}
        <Section icon={Package} title="Most-ordered packages" action={<span className="text-[11px] text-muted-2">{services.totalOrders} orders this year</span>}>
          <div className="space-y-2">
            {services.packages.map((s) => (
              <div key={s.label} className="flex items-center gap-3">
                <span className="w-48 shrink-0 truncate text-sm" title={s.label}>{s.label}</span>
                <div className="h-5 min-w-0 flex-1 overflow-hidden rounded bg-surface-2">
                  <div className="h-full rounded bg-brand/70" style={{ width: `${(s.orders / maxPackage) * 100}%` }} />
                </div>
                <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums">{s.orders}</span>
                <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-muted-2">{Math.round(s.attachPct)}%</span>
                <span className="w-16 shrink-0 text-right text-xs"><Delta pct={s.changePct} /></span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted-2">
            Bar = orders containing that package this year · next column = share of all orders · last = last 90 days vs the 90 before.
            {services.packageTail.count > 0 && ` Plus ${services.packageTail.count} one-off line items ordered once each.`}
          </p>
        </Section>

        {/* Which packages actually carry the revenue — often NOT the ones with
            the most orders. Estimated attribution; see the note. */}
        <Section
          icon={DollarSign}
          title="Revenue by package"
          action={
            <span className="text-[11px] text-muted-2">
              {services.exactRevenue ? "from Aryeo line items" : "estimated"} · {usd0(pkgRevTotal)}
            </span>
          }
        >
          <div className="space-y-2">
            {packagesByRevenue.map((s) => (
              <div key={s.label} className="flex items-center gap-3">
                <span className="w-48 shrink-0 truncate text-sm" title={s.label}>
                  {s.label}
                  {!s.exact && !s.estPrice && (
                    <span className="ml-1 text-[10px] text-muted-2" title="No standalone sales to learn a price from — this share is a generic estimate">~</span>
                  )}
                </span>
                <div className="h-5 min-w-0 flex-1 overflow-hidden rounded bg-surface-2">
                  <div className="h-full rounded bg-success/70" style={{ width: `${(s.revenue / maxPkgRev) * 100}%` }} />
                </div>
                <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">{usd0(s.revenue)}</span>
                <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-muted-2">
                  {pkgRevTotal ? Math.round((s.revenue / pkgRevTotal) * 100) : 0}%
                </span>
                <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-muted-2">
                  {usd0(s.orders ? s.revenue / s.orders : 0)}/order
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-2">
            {services.exactRevenue ? (
              <>Straight from the Aryeo order line items — the real product sold and the real dollars on the invoice, no estimation.</>
            ) : (
              <>
                Estimated: each order&rsquo;s value is shared across its packages, weighted by what each sells for on its own.
                Rows marked <span className="font-medium">~</span> were never sold standalone. Good for ranking; not accounting.
              </>
            )}
          </p>
        </Section>

        {/* What each package actually EARNS. Revenue is only half the story —
            a $1,300 product that needs a $299 premium edit and a full shoot day
            can be worth less than a $400 add-on that needs neither. Streamed,
            because costing it runs the whole payroll engine. */}
        {isOwner && (
          <Suspense fallback={<MarginByPackageSkeleton />}>
            <MarginByPackage />
          </Suspense>
        )}

        {/* The other revenue rail — monthly retainers, invisible in every Aryeo figure. */}
        {recurring && <RecurringRevenueCard data={recurring} />}

        {/* Top spenders */}
        <Section icon={Users} title="Top spenders" action={<span className="text-[11px] text-muted-2">per-listing revenue · Top 5 = {Math.round(spenders.concentrationTop5)}% · top 10 = {Math.round(spenders.concentrationTop10)}%</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-2">
                  <th className="pb-2 font-medium">Client</th>
                  <th className="pb-2 text-right font-medium">This year</th>
                  <th className="pb-2 text-right font-medium">Jobs</th>
                  <th className="pb-2 text-right font-medium">Avg</th>
                  <th className="pb-2 text-right font-medium">90d trend</th>
                  <th className="pb-2 text-right font-medium">Last order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {spenders.rows.map((c) => (
                  <tr key={c.clientId} className={c.overdue ? "bg-warning/5" : undefined}>
                    <td className="py-2 pr-2">
                      <Link href={`/clients/${c.clientId}`} className="font-medium hover:underline">{c.name}</Link>
                      {onRetainer.has(c.clientId) && (
                        <span
                          className="ml-1.5 rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand"
                          title="Also pays a monthly retainer in QuickBooks — not counted in this table"
                        >
                          + retainer
                        </span>
                      )}
                      {c.company && <span className="ml-1.5 text-[11px] text-muted-2">{c.company}</span>}
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums">{usd0(c.ytdRevenue)}</td>
                    <td className="py-2 text-right tabular-nums text-muted">{c.ytdJobs}</td>
                    <td className="py-2 text-right tabular-nums text-muted">{usd0(c.avgTicket)}</td>
                    <td className="py-2 text-right"><Delta pct={c.changePct} /></td>
                    <td className="py-2 text-right tabular-nums text-muted-2">
                      {c.daysSinceLastOrder === null ? "—" : `${c.daysSinceLastOrder}d`}
                      {c.overdue && <AlertTriangle className="ml-1 inline size-3 text-warning" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* When orders actually arrive */}
        <Section icon={Clock} title="When orders come in" action={<span className="text-[11px] text-muted-2">last 12 months</span>}>
          <div className="flex items-end gap-2">
            {bookings.busiestDow.map((d) => {
              const max = Math.max(1, ...bookings.busiestDow.map((x) => x.count));
              return (
                <div key={d.dow} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-[11px] font-semibold tabular-nums">{d.count}</span>
                  <div className="flex h-20 w-full items-end">
                    <div className="w-full rounded-t bg-accent/60" style={{ height: `${(d.count / max) * 100}%` }} />
                  </div>
                  <span className="text-[10px] text-muted-2">{d.dow}</span>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Ask anything about the numbers above. */}
        {isOwner && <TrendsAdvisor />}
      </div>
    </div>
  );
}
