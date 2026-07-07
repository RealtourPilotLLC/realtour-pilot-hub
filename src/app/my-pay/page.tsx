import Link from "next/link";
import { redirect } from "next/navigation";
import { Camera, Car, Wallet, ChevronRight, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PayFlag } from "@/components/mypay/PayFlag";
import { prisma } from "@/lib/prisma";
import { usd } from "@/lib/money";
import { computePayroll, payPeriodFor, shiftPeriod, periodBounds } from "@/lib/payroll";
import { getCurrentUser } from "@/lib/auth/user";
import { homeFor } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

// A photographer's OWN pay — nothing else. Shoot pay + mileage per job with
// period totals; NO invoice amounts, no other people, no client pricing. Only
// the CURRENT and NEXT pay periods (history stays on Jordan's /payouts).
// Anything that looks off gets flagged straight to Jordan from the row.

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

  // Photographers see THEIR pay; owner/admin belong on /payouts (but can
  // preview a specific member with ?as= — read-only, the flag action refuses
  // for unlinked callers). Editors have no payroll here.
  let memberId: string | null = null;
  if (me?.role === "PHOTOGRAPHER") {
    memberId = me.teamMemberId;
  } else if (me?.role === "EDITOR") {
    redirect(homeFor(me.role));
  } else if (sp.as) {
    memberId = sp.as; // owner/admin (or open local dev) preview
  } else if (me) {
    redirect("/payouts");
  } else {
    // Open local dev: first configured photographer so the page renders.
    const m = await prisma.teamMember.findFirst({ where: { payPercent: { not: null } }, select: { id: true } });
    memberId = m?.id ?? null;
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

  // Current or next period only — never past ones.
  const current = payPeriodFor();
  const next = shiftPeriod(current.startKey, 1);
  const showNext = sp.p === "1";
  const period = showNext ? next : current;
  const { start, end } = periodBounds(period);

  const [people, member, flags] = await Promise.all([
    computePayroll(start, end, { memberId }),
    prisma.teamMember.findUnique({ where: { id: memberId }, select: { name: true } }),
    prisma.smartTask.findMany({
      where: { dedupeKey: { startsWith: `payflag-${memberId}-` }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { dedupeKey: true },
    }),
  ]);
  const person = people.find((p) => p.member.id === memberId) ?? null;
  const flagged = new Set(flags.map((f) => f.dedupeKey));
  const jobs = person?.jobs ?? [];
  const days = person?.days ?? [];
  const adjustments = person?.adjustments ?? [];
  const asSuffix = sp.as ? `&as=${sp.as}` : "";

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="My Pay"
        subtitle={`${member?.name ? member.name.split(" ")[0] + "'s" : "Your"} shoot pay + mileage — flag anything that looks off`}
      />
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {/* Period switch: current + next only */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm">
            <Link
              href={`/my-pay?p=0${asSuffix}`}
              className={`rounded-lg px-3 py-1.5 font-medium ${!showNext ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2"}`}
            >
              Current
            </Link>
            <Link
              href={`/my-pay?p=1${asSuffix}`}
              className={`rounded-lg px-3 py-1.5 font-medium ${showNext ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2"}`}
            >
              Next
            </Link>
            <span className="ml-2 text-muted">{fmtKey(period.startKey)} – {fmtKey(period.endKey)}</span>
          </div>
          <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
            Pays {fmtKey(period.payoutKey, { weekday: "short", month: "short", day: "numeric" })}
          </span>
        </div>

        {/* Totals — the photographer's own numbers only */}
        <div className="panel-shadow rounded-2xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <Chip icon={<Camera className="size-3.5" />} label="Shoot pay" value={usd(person?.shootPayTotal ?? 0)} />
              <Chip icon={<Car className="size-3.5" />} label="Mileage" value={usd(person?.mileageTotal ?? 0)} />
              {(person?.adjustmentTotal ?? 0) !== 0 && (
                <Chip icon={<SlidersHorizontal className="size-3.5" />} label="Adjustments" value={usd(person?.adjustmentTotal ?? 0)} />
              )}
            </div>
            <div className="text-right">
              <div className="text-[11px] text-muted">Period total</div>
              <div className="text-xl font-semibold text-success">{usd(person?.total ?? 0)}</div>
            </div>
          </div>
        </div>

        {/* Shoots — no invoice column, ever */}
        <div className="panel-shadow rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <Camera className="size-3.5" /> Shoots
            <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{jobs.length}</span>
          </div>
          {jobs.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-2">
              No shoots in this period yet — they appear here as they&apos;re scheduled and shot.
            </p>
          ) : (
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
                      <span>{fmtDay(j.shootISO)} · shoot {usd(j.shootPay)}{j.mileageShare > 0 ? ` · mileage ${usd(j.mileageShare)}` : ""}</span>
                      <PayFlag projectId={j.projectId} street={j.title.split(",")[0]} periodStartKey={period.startKey} already={flagged.has(key)} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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

        {/* General question */}
        <div className="panel-shadow rounded-2xl border border-border bg-surface p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wallet className="size-4 text-brand" /> Something not adding up?</p>
          <p className="mb-3 text-xs text-muted">Flag a shoot above, or ask about the period here — it goes straight to Jordan.</p>
          <PayFlag periodStartKey={period.startKey} general already={flagged.has(`payflag-${memberId}-period-${period.startKey}`)} />
        </div>

        <p className="px-1 text-[11px] text-muted-2">
          Pay periods run two weeks and pay out the Friday after they close. <ChevronRight className="inline size-3" /> Questions about an older period? Ask Jordan directly.
        </p>
      </div>
    </div>
  );
}
