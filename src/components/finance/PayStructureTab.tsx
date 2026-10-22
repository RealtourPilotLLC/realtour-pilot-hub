import { ArrowLeftRight, CalendarRange, ChevronDown, Info, PiggyBank, TrendingDown, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { ownerPaySavings, TIER_LIST_PRICE, WEEKEND_HOLIDAY_PREMIUM, type MonthRow, type PersonMonth, type PaySavings } from "@/lib/paySavings";
import { FIXED_PAY } from "@/lib/payStructure";
import { usd, usd0 } from "@/lib/money";

// Finance → Pay structure (Jordan, Oct 21 2026): what James and Harrison
// would have cost on the old per-shoot pay against what the new yearly pay
// costs, month by month since the Sep 20 2026 pay period (paid Oct 9; Jordan,
// Oct 22: "Oct 9 pay was the new pay structure"), with every part shown.
// OWNER ONLY: the Finance page already sends every non-owner to Unpaid, and
// ownerPaySavings() refuses anyone else on its own (lib/paySavings.ts).

const dayLabel = (key: string, year = false) =>
  new Date(key + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
/** Savings read as money kept: positive in green, a month that cost more in red. */
const savedTone = (n: number) => (n > 0.005 ? "text-success" : n < -0.005 ? "text-danger" : "text-muted");
const signed = (n: number) => (n < -0.005 ? `-${usd0(Math.abs(n))}` : usd0(n));
const signedCents = (n: number) => (n < -0.005 ? `-${usd(Math.abs(n))}` : usd(n));

export async function PayStructureTab({ show }: { show: FinanceTab[] }) {
  const data = await ownerPaySavings();
  const mtd = data.currentMonth;
  return (
    <div>
      <PageHeader
        eyebrow="Finance"
        title="Pay structure"
        subtitle="Old per-shoot pay against the new yearly pay for James and Harrison, since the Sep 20 pay period, paid Oct 9"
        actions={<Badge soft="var(--surface-2)">Through {dayLabel(data.asOfKey, true)}</Badge>}
      />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="paystructure" show={show} />

        {data.missing.length > 0 && (
          <p className="rounded-2xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning">
            No one on the team roster is named {data.missing.join(" or ")}, so they are left out below.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={<PiggyBank className="size-4 text-success" />} label="Saved since Sep 20" value={signed(data.totals.savings)} tone={savedTone(data.totals.savings)} />
          <Stat icon={<CalendarRange className="size-4 text-brand" />} label={mtd ? `${mtd.label.split(" ")[0]} so far` : "This month so far"} value={mtd ? signed(mtd.savings) : "$0"} tone={mtd ? savedTone(mtd.savings) : "text-muted"} />
          <Stat icon={<TrendingUp className="size-4 text-muted" />} label="Old pay would have been" value={usd0(data.totals.old)} />
          <Stat icon={<TrendingDown className="size-4 text-muted" />} label="New pay, bonus at most" value={usd0(data.totals.new)} />
        </div>

        <Section icon={ArrowLeftRight} title="Month by month" count={data.months.length || null} flush>
          {data.months.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">The new pay structure starts with the Sep 20 2026 pay period, paid Oct 9. Nothing to compare yet.</p>
          ) : (
            <div>
              <div className="grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] gap-2 border-b border-border px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                <span>Month</span><span className="text-right">Old</span><span className="text-right">New</span><span className="text-right">Saved</span>
              </div>
              <div className="divide-y divide-border/60">
                {data.months.map((m) => <MonthDetails key={m.monthKey} m={m} />)}
              </div>
              <div className="grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] gap-2 border-t border-border bg-surface-2/50 px-5 py-3 text-sm font-semibold tabular-nums">
                <span>Total since Sep 20</span>
                <span className="text-right">{usd0(data.totals.old)}</span>
                <span className="text-right">{usd0(data.totals.new)}</span>
                <span className={`text-right ${savedTone(data.totals.savings)}`}>{signed(data.totals.savings)}</span>
              </div>
              {data.people.length > 1 && (
                <div className="space-y-1 border-t border-border/60 px-5 py-2.5 text-xs text-muted">
                  {data.people.map((p) => (
                    <div key={p.key} className="grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] gap-2 tabular-nums">
                      <span className="truncate">{p.name}</span>
                      <span className="text-right">{usd0(p.old)}</span>
                      <span className="text-right">{usd0(p.new)}</span>
                      <span className={`text-right font-medium ${savedTone(p.savings)}`}>{signed(p.savings)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Section>

        <Assumptions data={data} />
      </div>
    </div>
  );
}

function MonthDetails({ m }: { m: MonthRow }) {
  const partial = m.isCurrent || m.fromKey.slice(8) !== "01";
  return (
    <details className="group">
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] items-center gap-2 px-5 py-3 text-sm tabular-nums hover:bg-surface-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{m.label}</span>
            {partial && (
              <span className="block truncate text-[11px] text-muted-2">
                {dayLabel(m.fromKey)} to {dayLabel(m.toKey)}{m.isCurrent ? ", so far" : ""}
              </span>
            )}
          </span>
        </span>
        <span className="text-right">{usd0(m.old)}</span>
        <span className="text-right">{usd0(m.new)}</span>
        <span className="text-right">
          <span className={`block font-semibold ${savedTone(m.savings)}`}>{signed(m.savings)}</span>
          <span className="block text-[10px] font-normal text-muted-2">{signed(m.runningSavings)} to date</span>
        </span>
      </summary>
      <div className="grid gap-3 border-t border-border/60 bg-surface-2/30 px-3 py-3 sm:px-5 lg:grid-cols-2">
        {m.people.map((p) => <PersonCard key={p.key} p={p} />)}
      </div>
    </details>
  );
}

function PersonCard({ p }: { p: PersonMonth }) {
  const o = p.old, n = p.new;
  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="text-sm font-semibold">{p.name}</span>
        <span className={`ml-auto text-sm font-bold tabular-nums ${savedTone(p.savings)}`}>{signedCents(p.savings)} saved</span>
      </div>

      <div className="px-4 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Old per-shoot pay</div>
        <Line label={`Shoot pay, ${o.shoots} shoot${o.shoots === 1 ? "" : "s"}`} value={o.shootPay} />
        <Line
          label={`Mileage, ${Math.round(o.miles)} mi driven`}
          value={o.mileage}
          note={[
            o.notComputedDays > 0 ? `mileage not computed for ${o.notComputedDays} day${o.notComputedDays === 1 ? "" : "s"}, counted as 0` : null,
            o.noLocation > 0 ? `${o.noLocation} shoot${o.noLocation === 1 ? "" : "s"} without a map location, not in any route` : null,
          ].filter(Boolean).join("; ") || undefined}
        />
        <Line label={`Content sessions at tier price, ${o.sessions.length}`} value={o.branding} />
        {o.sessions.length > 0 && (
          <ul className="mb-1 mt-0.5 space-y-1 border-l-2 border-border pl-3">
            {o.sessions.map((s) => (
              <li key={`${s.projectId}-${s.dayKey}`} className="text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 font-medium">{s.clientName ?? s.title.split(",")[0]}</span>
                  <span className="text-muted-2">{s.tier} · {dayLabel(s.dayKey)}</span>
                  <span className="ml-auto font-semibold tabular-nums">{usd(s.oldPay)}</span>
                </div>
                <div className="text-muted">
                  {usd(s.priceUsed)} used ({s.source === "their rate" ? "their rate" : s.source === "list price" ? "list price" : s.source})
                  {s.source === "their rate" || s.source === "list price" ? `: ${s.terms}${s.sessionsPerMonth > 1 ? `, ${s.sessionsPerMonth} sessions a month` : ""}` : ""}.
                  {" "}Aryeo showed {usd(s.aryeoInvoice)}, which would have paid {usd(s.atAryeoPrice)}.
                  {s.notes.length > 0 && <span className="text-muted-2"> {s.notes.join("; ")}.</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Line label="Old total" value={o.total} strong />
      </div>

      <div className="border-t border-border/60 px-4 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">New yearly pay</div>
        <Line
          label={`Regular pay, ${n.days} day${n.days === 1 ? "" : "s"}`}
          value={n.regular.total}
          note={`service fee ${usd(n.regular.serviceFee)} + vehicle ${usd(n.regular.vehicle)}, ${n.regular.periodsLabel}`}
        />
        <Line
          label={`Weekend/holiday appointments, assumed approved, ${n.premiums.count} × ${usd0(n.premiums.each)}`}
          value={n.premiums.total}
          note={n.premiums.appointments.length > 0
            ? n.premiums.appointments.map((a) => `${a.title.split(",")[0]} (${a.why}, ${dayLabel(a.dayKey)})`).join("; ")
            : undefined}
        />
        <Line label="Commissions" value={n.commissions.total} note={n.commissions.tracked ? undefined : "commissions not tracked yet"} />
        <Line
          label="Bonus at most"
          value={n.bonusAtMost.total}
          note={`${usd0(n.bonusAtMost.max)} for ${n.bonusAtMost.periodLabel} spread over its ${n.bonusAtMost.periodDays} days, ${n.bonusAtMost.days} of them this month`}
        />
        <Line label="New total" value={n.total} strong />
      </div>

      {Math.abs(p.adjustments) > 0.005 && (
        <p className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-2">
          Payout adjustments entered on Payroll this month: {signedCents(p.adjustments)}. Counted on neither side.
        </p>
      )}
    </div>
  );
}

function Line({ label, value, note, strong }: { label: string; value: number; note?: string; strong?: boolean }) {
  return (
    <div className={`py-1 ${strong ? "mt-1 border-t border-border/60 pt-1.5" : ""}`}>
      <div className="flex items-baseline gap-2 text-sm">
        <span className={`min-w-0 flex-1 ${strong ? "font-semibold" : ""}`}>{label}</span>
        <span className={`shrink-0 tabular-nums ${strong ? "font-bold" : "font-medium"}`}>{usd(value)}</span>
      </div>
      {note && <div className="text-[11px] leading-snug text-muted-2">{note}</div>}
    </div>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl border bg-surface p-4">
      <div className="flex items-center gap-2 text-sm text-muted">{icon} {label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function Assumptions({ data }: { data: PaySavings }) {
  const rateLines = data.people.map((p) => {
    const r = p.rates;
    const figures = `${pct(r.payPercent)} of the invoice or a ${usd0(r.payFloor)} floor, ${usd(r.mileageRate)} a mile past ${r.homeRadiusMi} miles each way`;
    return r.fromProfile
      ? `${p.name}: ${figures}, from their team profile.`
      : `${p.name}: ${figures}. Their team profile no longer has a ${r.fellBack.join(", ")}, so the rates they had before fixed pay are used.`;
  });
  const items = [
    "Both sides start with the first fixed-pay period, Sep 20 2026 (paid Oct 9).",
    "Old pay is the per-shoot pay Payroll used before the Sep 20 pay period: the higher of the percent of the eligible invoice or the floor, plus mileage past the free radius, with the same return-trip, reshoot and per-job override rules. Shoots count in the month they happened.",
    ...rateLines,
    `Content program sessions show $0 in Aryeo. On the old side each one is priced at what that client pays for their tier (their monthly rate divided by their sessions a month; paid in full is spread over its months; a trial is its one month), or the tier's month-to-month list price when no billing terms are on file (Starter ${usd0(TIER_LIST_PRICE.Starter)}, Accelerator ${usd0(TIER_LIST_PRICE.Accelerator)}, Pro ${usd0(TIER_LIST_PRICE.Pro)}). The old percent and floor then run on that price. ${data.sessionsAtTheirRate} session${data.sessionsAtTheirRate === 1 ? "" : "s"} used their rate and ${data.sessionsAtListPrice} the list price.`,
    `Mileage comes from the miles Payroll already worked out for each day; this page never looks a route up. ${data.notComputedDays > 0 ? `Mileage not computed for ${data.notComputedDays} day${data.notComputedDays === 1 ? "" : "s"}: those count as 0, so the old side is if anything low.` : "Every shoot day has its miles worked out."}`,
    "New regular pay (service fee plus vehicle) is what Payroll pays: one twenty-sixth of the yearly amount for each pay period, from the Sep 20 period. A pay period split by the month's edge counts its days out of 14 in each month. The vehicle amount replaces mileage, so the new side has no mileage.",
    `Weekend and company-holiday appointments are assumed approved at ${usd0(WEEKEND_HOLIDAY_PREMIUM)} each, one per appointment even when a holiday falls on a weekend (there is no approval record yet). Holidays: New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving and Christmas, on the day itself.`,
    "Commissions are not tracked in the hub yet, so they count $0.",
    `The bonus formula is not set yet, so the new side carries the most each bonus period could pay (James ${usd0(FIXED_PAY.james.bonusMax)}, Harrison ${usd0(FIXED_PAY.harrison.bonusMax)}; Sep 25 to Dec 31 2026, then calendar quarters), spread evenly over the period's days. Sep 20 to 24 are before the first bonus period and carry none. Savings are never overstated by the bonus.`,
    "This month counts through today on both sides. Payout adjustments entered on Payroll count on neither side.",
  ];
  return (
    <Section icon={Info} title="How the numbers are made">
      <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted">
        {items.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </Section>
  );
}
