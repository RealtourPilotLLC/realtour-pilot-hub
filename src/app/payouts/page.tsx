import Link from "next/link";
import { Banknote, Car, SlidersHorizontal, ChevronLeft, ChevronRight, CalendarCheck, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { computePayroll, payPeriodFor, shiftPeriod, unassignedShootsInRange } from "@/lib/payroll";
import { PayoutCard } from "@/components/payouts/PayoutCard";
import { usd } from "@/lib/money";

export const dynamic = "force-dynamic";

const fmtKey = (k: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(k + "T12:00:00Z").toLocaleDateString("en-US", opts);

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string }>;
}) {
  const sp = await searchParams;
  // Bi-weekly pay periods (anchored May 31, 2026). Default = the period
  // containing today; ?start= picks a specific period.
  const period = payPeriodFor(sp.start);
  const { startKey, endKey, payoutKey } = period;

  const start = new Date(startKey + "T00:00:00.000Z");
  const end = new Date(endKey + "T23:59:59.999Z");

  const [people, unassigned] = await Promise.all([
    computePayroll(start, end),
    unassignedShootsInRange(start, end),
  ]);
  const grandTotal = people.reduce((s, p) => s + p.total, 0);
  const mileageTotal = people.reduce((s, p) => s + p.mileageTotal, 0);
  const flagCount = people.reduce((s, p) => s + p.issues.filter((i) => i.level === "warn").length, 0) + (unassigned.length > 0 ? 1 : 0);

  const prev = shiftPeriod(startKey, -1);
  const next = shiftPeriod(startKey, 1);
  const current = payPeriodFor();
  const isCurrent = startKey === current.startKey;
  const fmtRange = (a: string, b: string) =>
    `${fmtKey(a, { month: "short", day: "numeric" })} – ${fmtKey(b, { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <div>
      <PageHeader
        title="Payouts"
        subtitle="Photographer shoot pay + mileage, calculated from your rates"
        actions={
          flagCount > 0
            ? <Badge color="#d97706" soft="#fef3c7">{flagCount} to review</Badge>
            : <Badge soft="var(--surface-2)">{isCurrent ? "Current period" : "Past period"}</Badge>
        }
      />
      <div className="space-y-6 p-4 sm:p-6">
        {/* Period nav */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <Link href={`/payouts?start=${prev.startKey}`} className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2">
              <ChevronLeft className="size-3.5" /> Prev
            </Link>
            <span className="px-2 text-sm font-medium">{fmtRange(startKey, endKey)}</span>
            <Link href={`/payouts?start=${next.startKey}`} className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2">
              Next <ChevronRight className="size-3.5" />
            </Link>
            {!isCurrent && (
              <Link href="/payouts" className="ml-1 text-xs text-muted hover:text-foreground">Current</Link>
            )}
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 px-2.5 py-1.5 text-xs font-medium text-success">
            <CalendarCheck className="size-3.5" /> Pays {fmtKey(payoutKey, { weekday: "short", month: "short", day: "numeric" })}
          </span>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <Stat icon={<Banknote className="size-4 text-success" />} label="Period total" value={usd(grandTotal)} />
          <Stat icon={<Car className="size-4 text-accent" />} label="Mileage in total" value={usd(mileageTotal)} />
          <Stat icon={<SlidersHorizontal className="size-4 text-brand" />} label="Photographers" value={String(people.length)} />
        </div>

        {/* Unassigned shoots — nobody is being paid for these */}
        {unassigned.length > 0 && (
          <div className="rounded-2xl border border-warning/40 bg-warning/5 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-warning">
              <AlertTriangle className="size-4" /> {unassigned.length} shoot{unassigned.length === 1 ? "" : "s"} this period have no photographer assigned
            </div>
            <p className="mt-0.5 text-xs text-muted">Nobody is being paid for these — assign a photographer on the project so they're counted.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {unassigned.slice(0, 12).map((u) => (
                <Link key={u.id} href={`/projects/${u.id}`} className="rounded-lg border bg-surface px-2 py-1 text-xs hover:bg-surface-2">
                  {u.title.split(",")[0]}{u.shootISO ? ` · ${new Date(u.shootISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}
                </Link>
              ))}
              {unassigned.length > 12 && <span className="px-1 py-1 text-xs text-muted">+{unassigned.length - 12} more</span>}
            </div>
          </div>
        )}

        {people.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-surface p-10 text-center text-sm text-muted">
            No shoots in this period. Use the date range above to pick a pay period.
          </div>
        ) : (
          <div className="space-y-4">
            {people.map((p) => (
              <PayoutCard key={p.member.id} person={p} periodStartISO={start.toISOString()} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border bg-surface p-4">
      <div className="flex items-center gap-2 text-sm text-muted">{icon} {label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}
