import Link from "next/link";
import { redirect } from "next/navigation";
import { Camera, Car, Wallet, ChevronRight, SlidersHorizontal, Receipt, History, TrendingUp, Upload } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PayFlag } from "@/components/mypay/PayFlag";
import { QuarterScoreCard } from "@/components/mypay/QuarterScoreCard";
import { prisma } from "@/lib/prisma";
import { quarterFor, scoreQuarter } from "@/lib/kpi";
import { usd } from "@/lib/money";
import { payPeriodFor, periodBounds, shiftPeriod } from "@/lib/payroll";
import { payHistoryFor } from "@/lib/payHistory";
import { pendingWrapUpShoots } from "@/lib/shoot";
import { etDayKey } from "@/lib/datetime";
import { getCurrentUser } from "@/lib/auth/user";
import { homeFor } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";
// Payroll resolves mileage through the public OSRM router, so a cold day costs a
// network round trip. Bounded generously — /trends learned the hard way what the
// platform default does to a page that touches this engine.
export const maxDuration = 60;

// A photographer's OWN pay — nothing else. Shoot pay + mileage per job with
// period totals; no other people, no client pricing. The invoice shown per job
// is the ELIGIBLE-services invoice their % is applied to (payableInvoice —
// virtual/AI add-ons like staging, twilight, declutter are already excluded),
// so pay × % visibly lines up. Periods offered: the CLOSED one still awaiting
// its payday ("Getting paid" — the default, because on/before payday the money
// landing in their account is the number they came to check), the CURRENT
// accruing one, and a peek at NEXT. Older history stays on Jordan's /payouts.
// Anything off gets flagged straight to Jordan. Every closed period back to the
// start of their work is browsable, and the year-to-date total sits on top.
//
// Shoots held by the debrief pay gate are dropped by the payroll engine before
// this page ever sees a line, so they are re-listed separately (pendingWrapUpShoots)
// under "waiting on your upload page". Without that a shoot silently VANISHES
// off the pay page the day it's shot — the photographer's own record of a job
// he did, gone, with nothing said (readiness audit, Sep 2). They carry no dollar
// figure: the gate withholds the money, this page only stops hiding the shoot.

const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : "—";
const fmtKey = (k: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  new Date(k + "T12:00:00Z").toLocaleDateString("en-US", opts);

function Chip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1 text-xs">
      <span className="text-muted-2">{icon}</span>
      <span className="text-muted">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

export default async function MyPayPage({ searchParams }: { searchParams: Promise<{ p?: string; as?: string }> }) {
  const sp = await searchParams;
  const me = await getCurrentUser().catch(() => null);

  // Photographers see THEIR pay. Owner/admin who ALSO shoot (a linked
  // TeamMember with a pay rate — Jordan shoots at his own 40%) see THEIR OWN
  // pay here too; the whole-team payroll stays on Finance → Payroll. Owner/
  // admin without a shoot rate belong on /payouts. ?as=<memberId> is an
  // EXPLICIT owner/admin preview (read-only, the flag action refuses for
  // unlinked callers). Editors have no payroll here.
  //
  // NOBODY's pay ever renders as a guess: the old "first photographer"
  // local-dev fallback put James's page in front of the owner twice and is
  // gone for good. No session → login (prod) or the empty state (open dev).
  let memberId: string | null = null;
  let showTeamLink = false;
  if (me?.role === "PHOTOGRAPHER") {
    memberId = me.teamMemberId;
  } else if (me?.role === "EDITOR") {
    redirect(homeFor(me.role));
  } else if (sp.as && (me ? me.role === "OWNER" || me.role === "ADMIN" : !authEnforced())) {
    memberId = sp.as; // explicit preview — owner/admin (or open local dev)
  } else if (me) {
    const tm = me.teamMemberId
      ? await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { payPercent: true } })
      : null;
    if (tm?.payPercent == null) redirect("/payouts");
    memberId = me.teamMemberId;
    // The whole-team payroll link only helps people allowed on Finance —
    // James (admin, sales:false) sees HIS pay with no dead door beside it.
    const { canAccess } = await import("@/lib/auth/access");
    showTeamLink = canAccess(me, "sales");
  } else if (authEnforced()) {
    // Unauthenticated or a transient session/DB failure — bounce to login; a
    // healthy session lands right back here on the next request.
    redirect("/login?next=/my-pay");
  }

  if (!memberId) {
    return (
      <div>
        <PageHeader title="My Pay" subtitle="Your shoot pay and mileage per pay period" />
        <div className="p-6">
          <p className="rounded-2xl border border-dashed border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            Your login isn&apos;t linked to a team member yet — ask Jordan to connect it and your pay will show up here.
          </p>
        </div>
      </div>
    );
  }

  // ONE payroll pass covers the whole year: the selected period's detail, every
  // past period they can look back at, and the year-to-date total all come out
  // of it. Running the engine per period would multiply a network-bound job.
  const current = payPeriodFor();
  const prev = shiftPeriod(current.startKey, -1);
  const next = shiftPeriod(current.startKey, 1);
  const todayKey = etDayKey(new Date());
  const prevAwaitingPayout = prev.payoutKey >= todayKey;

  // The quarterly bonus scorecard rides along with the payroll pass rather than
  // after it — payroll is network-bound (OSRM), so a serial second wait would
  // show up as a slower page for nothing. Prior quarter too: "track their
  // progress" needs something to have progressed FROM. A failure in either
  // scoring pass must never take the pay page down — pay is what they came for.
  const thisQuarter = quarterFor();
  const lastQuarter = quarterFor(undefined, 1);
  const [history, member, flags, kpi, kpiPrev] = await Promise.all([
    payHistoryFor(memberId),
    prisma.teamMember.findUnique({ where: { id: memberId }, select: { name: true } }),
    prisma.smartTask.findMany({
      where: { dedupeKey: { startsWith: `payflag-${memberId}-` }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { dedupeKey: true },
    }),
    scoreQuarter({ memberId, quarter: thisQuarter }).catch(() => null),
    scoreQuarter({ memberId, quarter: lastQuarter }).catch(() => null),
  ]);
  const person = history.person;

  // `p` is a period start key. The old -1 / 0 / 1 links still resolve so a
  // bookmarked or texted link never lands on the wrong period.
  const legacy: Record<string, string> = { "-1": prev.startKey, "0": current.startKey, "1": next.startKey };
  const wanted = sp.p ? (legacy[sp.p] ?? sp.p) : prevAwaitingPayout ? prev.startKey : current.startKey;
  const selected = history.periods.find((x) => x.startKey === wanted) ?? history.periods.find((x) => x.startKey === current.startKey) ?? history.periods[0];
  const period = { startKey: selected.startKey, endKey: selected.endKey, payoutKey: selected.payoutKey };
  const paysToday = period.payoutKey === todayKey;

  const inPeriod = (k: string) => k >= period.startKey && k <= period.endKey;
  const flagged = new Set(flags.map((f) => f.dedupeKey));
  const jobs = (person?.jobs ?? []).filter((j) => inPeriod(j.dayKey));
  // The shoots the gate is holding back in THIS period. Cheap (one indexed
  // project query) and it runs after payroll rather than beside it — payroll is
  // the network-bound half, and this must never be the reason the pay page is
  // slow. A failure here must not take the page down: the pay is what they came
  // for, so we lose the waiting list, not the money.
  const { start: periodStart, end: periodEnd } = periodBounds(period);
  const pending = await pendingWrapUpShoots(memberId, periodStart, periodEnd).catch(() => []);
  const days = (person?.days ?? []).filter((d) => inPeriod(d.dayKey));
  const adjustments = (person?.adjustments ?? []).filter((a) => inPeriod(etDayKey(new Date(a.dateISO))));
  const asSuffix = sp.as ? `&as=${sp.as}` : "";
  // Everything already closed and browsable, newest first.
  const pastPeriods = history.periods.filter((x) => !x.isFuture);

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="My Pay"
        subtitle={`${member?.name ? member.name.split(" ")[0] + "'s" : "Your"} shoot pay + mileage — flag anything that looks off`}
        actions={showTeamLink ? (
          <Link href="/sales?tab=payroll" className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2">
            Team payroll <ChevronRight className="size-3.5" />
          </Link>
        ) : undefined}
      />
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {/* TOTAL PAY THIS YEAR — the number they came to check when they are not
            checking a single period. Counts work through today, so a shoot
            already on the calendar for next week is not in it yet. */}
        <div className="panel-shadow rounded-2xl border border-brand/30 bg-brand/[0.04] p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <TrendingUp className="size-3.5 text-brand" /> Total pay {history.year}
              </div>
              <div className="mt-0.5 text-3xl font-bold tabular-nums text-brand">{usd(history.ytd.total)}</div>
              <div className="mt-0.5 text-[11px] text-muted-2">
                {history.ytd.jobs} shoot{history.ytd.jobs === 1 ? "" : "s"} across {history.ytd.periodsWorked} pay period
                {history.ytd.periodsWorked === 1 ? "" : "s"} · through today
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip icon={<Camera className="size-3.5" />} label="Shoot pay" value={usd(history.ytd.shootPay)} />
              <Chip icon={<Car className="size-3.5" />} label="Mileage" value={usd(history.ytd.mileage)} />
              {history.ytd.adjustments !== 0 && (
                <Chip icon={<SlidersHorizontal className="size-3.5" />} label="Adjustments" value={usd(history.ytd.adjustments)} />
              )}
            </div>
          </div>
        </div>

        {/* QUARTERLY BONUS SCORECARD — their KPI tracker, live through the
            quarter (Jordan, Sep 2026: up to $1,000 a quarter, $4k a year).
            Sits under the year total because it is the OTHER money question a
            photographer has, and above the period detail because it is about
            the quarter, not this fortnight. */}
        {kpi && <QuarterScoreCard card={kpi} previous={kpiPrev} />}

        {/* Period switch: the payout awaiting its payday (when there is one),
            the accruing period, and a peek at next. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm">
            {[
              ...(prevAwaitingPayout ? [{ key: prev.startKey, label: "Getting paid" }] : []),
              { key: current.startKey, label: prevAwaitingPayout ? "Current period" : "Current" },
              { key: next.startKey, label: "Next" },
            ].map((t) => (
              <Link
                key={t.key}
                href={`/my-pay?p=${t.key}${asSuffix}`}
                className={`rounded-lg px-3 py-1.5 font-medium ${period.startKey === t.key ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2"}`}
              >
                {t.label}
              </Link>
            ))}
            <span className="ml-2 text-muted">{fmtKey(period.startKey)} – {fmtKey(period.endKey)}</span>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${paysToday ? "bg-success text-white" : "bg-success/10 font-medium text-success"}`}>
            {paysToday ? "Pays TODAY" : `Pays ${fmtKey(period.payoutKey, { weekday: "short", month: "short", day: "numeric" })}`}
          </span>
        </div>

        {/* Totals — the photographer's own numbers only */}
        <div className="panel-shadow rounded-2xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <Chip icon={<Receipt className="size-3.5" />} label="Invoices" value={usd(jobs.reduce((s, j) => s + j.invoice, 0))} />
              <Chip icon={<Camera className="size-3.5" />} label="Shoot pay" value={usd(selected.shootPay)} />
              <Chip icon={<Car className="size-3.5" />} label="Mileage" value={usd(selected.mileage)} />
              {selected.adjustments !== 0 && (
                <Chip icon={<SlidersHorizontal className="size-3.5" />} label="Adjustments" value={usd(selected.adjustments)} />
              )}
            </div>
            <div className="text-right">
              <div className="text-[11px] text-muted">Period total</div>
              <div className="text-xl font-semibold text-success">{usd(selected.total)}</div>
            </div>
          </div>
          {/* The total is honest about what it LEAVES OUT. Held shoots aren't in
              it, and a photographer counting his own jobs would otherwise find
              the number short with no explanation anywhere on the page. */}
          {pending.length > 0 && (
            <p className="mt-3 border-t border-border/60 pt-2.5 text-xs text-muted">
              {pending.length} more shoot{pending.length === 1 ? "" : "s"} from this period {pending.length === 1 ? "isn't" : "aren't"} counted
              here yet — {pending.length === 1 ? "its" : "their"} upload page {pending.length === 1 ? "hasn't" : "haven't"} been submitted. Listed below.
            </p>
          )}
        </div>

        {/* Shoots — each row shows the eligible-services invoice the pay % is
            applied to (virtual add-ons already excluded) next to the pay. */}
        <div className="panel-shadow rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <Camera className="size-3.5" /> Shoots
            {/* Counts the held shoots too — they happened, they're in this
                period, and leaving them out of the count is how one goes
                missing without anybody noticing. */}
            <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{jobs.length + pending.length}</span>
          </div>
          {jobs.length === 0 && pending.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-2">
              No shoots in this period yet — they appear here as they&apos;re scheduled and shot.
            </p>
          ) : jobs.length > 0 ? (
            <div className="divide-y divide-border/60">
              {jobs.map((j) => {
                const key = `payflag-${memberId}-${j.projectId}-${period.startKey}`;
                return (
                  <div key={`${j.projectId}-${j.shootISO}`} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate">
                        {j.title.split(",")[0]}
                        {j.returnTrip && <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] text-muted">second visit · flat rate</span>}
                      </span>
                      <span className="shrink-0 font-semibold">{usd(j.jobTotal)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-3 text-[11px] text-muted-2">
                      {/* The agent beside the invoice — a row is reviewable without
                          opening the job (Jordan, Aug 25). */}
                      <span className="min-w-0 truncate">
                        {fmtDay(j.shootISO)}
                        {j.clientName ? <> · <span className="font-medium text-muted">{j.clientName}</span></> : ""}
                        {j.invoice > 0 ? ` · invoice ${usd(j.invoice)}` : ""} · shoot {usd(j.shootPay)}{j.mileageShare > 0 ? ` · mileage ${usd(j.mileageShare)}` : ""}
                      </span>
                      <PayFlag projectId={j.projectId} street={j.title.split(",")[0]} periodStartKey={period.startKey} already={flagged.has(key)} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* WAITING ON YOUR UPLOAD PAGE — shoots the pay gate is holding. No
              dollar figure: the gate withholds the amount by design (Jordan,
              Sep 1: "once submitted, this shoot will be added to your payroll").
              What this block owes them is the shoot, the reason, and the door. */}
          {pending.length > 0 && (
            <div className="border-t border-border/60 bg-warning-soft/30">
              <div className="flex items-center gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-warning">
                <Upload className="size-3.5" /> Waiting on your upload page
                <span className="ml-auto rounded-full bg-warning/15 px-1.5 text-[10px] font-medium">{pending.length}</span>
              </div>
              <div className="divide-y divide-border/60">
                {pending.map((w) => (
                  <Link key={w.projectId} href={`/upload/${w.projectId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{w.title.split(",")[0]}</span>
                      <span className="block truncate text-[11px] text-muted-2">{fmtDay(w.shootISO)} · submit the upload page and this shoot joins your pay</span>
                    </span>
                    <span className="shrink-0 text-[11px] font-semibold text-warning">Not counted yet</span>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-2" />
                  </Link>
                ))}
              </div>
              <p className="px-4 pb-2.5 text-[11px] leading-relaxed text-muted">
                Nothing here is lost. Files into Dropbox, tick everything off, then hit{" "}
                <span className="font-medium text-foreground">Everything&rsquo;s uploaded — submit</span> — the shoot lands on your
                payroll and the money shows above. Applies to shoots from Sep 2 2026 on.
              </p>
            </div>
          )}
          <p className="border-t border-border/60 px-4 py-2 text-[11px] leading-relaxed text-muted-2">
            Invoice totals only count the services you shoot — virtual add-ons (staging, twilights, declutter, AI edits)
            aren&apos;t included — and are subject to change with change orders, refunds, credits, and discounts.
          </p>
        </div>

        {/* Mileage days */}
        {days.length > 0 && (
          <div className="panel-shadow rounded-2xl border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Car className="size-3.5" /> Mileage
              <span className="ml-auto text-[11px] font-normal normal-case text-muted-2">first {person?.homeRadiusMi ?? 35} mi each way is on us</span>
            </div>
            <div className="divide-y divide-border/60">
              {days.map((d) => (
                <div key={d.dayKey} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="text-muted">{fmtKey(d.dayKey, { weekday: "short", month: "short", day: "numeric" })}</span>
                  <span className="text-xs text-muted-2">{Math.round(d.miles)} mi driven · {Math.round(d.payableMiles)} paid</span>
                  <span className="font-medium">{usd(d.mileagePay)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Adjustments (bonuses / paybacks on this period) */}
        {adjustments.length > 0 && (
          <div className="panel-shadow rounded-2xl border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">Adjustments</div>
            <div className="divide-y divide-border/60">
              {adjustments.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 truncate text-muted">{a.label}</span>
                  <span className={`font-medium ${a.amount < 0 ? "text-danger" : ""}`}>{usd(a.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* EVERY past period, newest first. Tapping one loads it above. */}
        {pastPeriods.length > 1 && (
          <div className="panel-shadow rounded-2xl border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <History className="size-3.5" /> Pay history
              <span className="ml-auto text-[11px] font-normal normal-case text-muted-2">
                {pastPeriods.length} periods · tap one to open it
              </span>
            </div>
            <div className="divide-y divide-border/60">
              {pastPeriods.map((x) => {
                const isOpen = x.startKey === period.startKey;
                return (
                  <Link
                    key={x.startKey}
                    href={`/my-pay?p=${x.startKey}${asSuffix}`}
                    className={`flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-surface-2 ${isOpen ? "bg-brand/[0.06]" : ""}`}
                  >
                    <span className={`min-w-0 truncate ${isOpen ? "font-semibold" : ""}`}>
                      {fmtKey(x.startKey)} – {fmtKey(x.endKey)}
                    </span>
                    {x.isCurrent ? (
                      <span className="shrink-0 rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand">accruing</span>
                    ) : x.isPaid ? (
                      <span className="shrink-0 text-[10px] text-muted-2">paid {fmtKey(x.payoutKey)}</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                        pays {fmtKey(x.payoutKey)}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-muted-2">
                      {x.jobs} shoot{x.jobs === 1 ? "" : "s"}
                    </span>
                    <span className="w-20 shrink-0 text-right font-semibold tabular-nums">{usd(x.total)}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* General question */}
        <div className="panel-shadow rounded-2xl border border-border bg-surface p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wallet className="size-4 text-brand" /> Something not adding up?</p>
          <p className="mb-3 text-xs text-muted">Flag a shoot above, or ask about the period here — it goes straight to Jordan.</p>
          <PayFlag periodStartKey={period.startKey} general already={flagged.has(`payflag-${memberId}-period-${period.startKey}`)} />
        </div>

        <p className="px-1 text-[11px] text-muted-2">
          Pay periods run two weeks and pay out the Friday after they close. Every past period is listed above — open any one to see the
          shoots behind it. <ChevronRight className="inline size-3" /> Something still not right? Flag it and Jordan gets it.
        </p>
      </div>
    </div>
  );
}
