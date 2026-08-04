import Link from "next/link";
import { Repeat, AlertTriangle } from "lucide-react";
import { Section } from "@/components/ui/Section";
import type { RecurringRevenue as Recurring } from "@/lib/recurring";

// The second revenue rail. Everything else on /trends counts Aryeo money — what
// clients pay per listing. This counts what they pay every month whether or not
// they list anything, which is the steadiest revenue in the business and appears
// in no Aryeo figure anywhere.

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function RecurringRevenueCard({ data }: { data: Recurring }) {
  const { retainers, lapsed, passes } = data;
  if (retainers.length === 0 && lapsed.length === 0 && passes.length === 0) return null;
  const lapsedMonthly = lapsed.reduce((s, r) => s + r.monthlyAmount, 0);

  return (
    <Section
      icon={Repeat}
      title="Recurring revenue"
      action={<span className="text-[11px] text-muted-2">billed in QuickBooks · not in any figure above</span>}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-2">Every month</div>
          <div className="text-2xl font-bold tabular-nums text-brand">{usd0(data.monthlyRunRate)}</div>
          <div className="text-[11px] text-muted-2">{retainers.length} live retainer{retainers.length === 1 ? "" : "s"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-2">Annualised</div>
          <div className="text-2xl font-bold tabular-nums">{usd0(data.annualRunRate)}</div>
          <div className="text-[11px] text-muted-2">if nobody churns</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-2">Collected this year</div>
          <div className="text-2xl font-bold tabular-nums">{usd0(data.ytdTotal)}</div>
          <div className="text-[11px] text-muted-2">{usd0(data.ytdRetainer)} monthly + {usd0(data.ytdPasses)} passes</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-2">Sessions delivered</div>
          <div className="text-2xl font-bold tabular-nums">{data.sessionShoots}</div>
          <div className="text-[11px] text-muted-2">$0 in Aryeo by design</div>
        </div>
      </div>

      {/* A lapsed retainer is worth more attention than anything else here: it is
          revenue that used to arrive every month and simply stopped. */}
      {lapsed.length > 0 && (
        <div className="mt-4 rounded-xl border border-danger/40 bg-danger/5 p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-danger">
            <AlertTriangle className="size-4" /> {usd0(lapsedMonthly)}/month of retainers has stopped
          </h3>
          <div className="mt-2 space-y-1">
            {lapsed.map((r) => (
              <div key={r.customer + r.monthlyAmount} className="flex flex-wrap items-center gap-x-3 text-sm">
                {r.clientId ? (
                  <Link href={`/clients/${r.clientId}`} className="font-medium hover:underline">{r.clientName ?? r.customer}</Link>
                ) : (
                  <span className="font-medium">{r.customer}</span>
                )}
                <span className="text-muted-2">
                  was {usd0(r.monthlyAmount)}/mo{r.tier ? ` · ${r.tier}` : ""} · last billed {r.lastBilledISO}
                </span>
                {r.passSince && (
                  <span
                    className="text-[11px] text-muted-2"
                    title="A separate purchase, not a replacement — clients hold passes and monthly retainers at the same time"
                  >
                    (separately bought a {usd0(r.passSince.amount)} pass on {r.passSince.dateISO})
                  </span>
                )}
                <span className="ml-auto tabular-nums text-muted">{usd0(r.ytdRevenue)} this year</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-2">
            Together these were worth {usd0(lapsedMonthly * 12)} a year. A content pass bought afterwards is noted where it happened, but
            it is a separate purchase rather than a replacement — clients hold both at once — so every row here is a real stop.
          </p>
        </div>
      )}

      {retainers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Live retainers</h3>
          <div className="mt-2 space-y-1.5">
            {retainers.map((r) => (
              <div key={r.customer + r.monthlyAmount} className="flex flex-wrap items-center gap-x-3 text-sm">
                {r.clientId ? (
                  <Link href={`/clients/${r.clientId}`} className="font-medium hover:underline">{r.clientName ?? r.customer}</Link>
                ) : (
                  <span className="font-medium">{r.customer}</span>
                )}
                <span className="text-[11px] text-muted-2">
                  {r.tier ?? "monthly content"} · {r.monthsBilled} month{r.monthsBilled === 1 ? "" : "s"} billed
                </span>
                <span className="ml-auto font-semibold tabular-nums">{usd0(r.monthlyAmount)}/mo</span>
                <span className="w-24 shrink-0 text-right tabular-nums text-muted-2">{usd0(r.ytdRevenue)} YTD</span>
              </div>
            ))}
          </div>
        </div>
      )}


      {passes.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Content passes bought this year</h3>
          <div className="mt-2 space-y-1">
            {passes.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-3 text-sm">
                <span className="font-medium">{p.customer}</span>
                <span className="text-[11px] text-muted-2">{p.dateISO}</span>
                <span className="ml-auto font-semibold tabular-nums">{usd0(p.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-muted-2">
        Monthly social clients (Video Starter, Accelerator, Pro) pay a recurring QuickBooks invoice, and their Aryeo booking is priced at
        $0 on purpose so they can schedule the session they have already paid for without paying twice. That means none of this money
        appears in the booking, revenue or average-ticket figures above — those count per-listing work only. Retainers are detected from
        the ledger (same customer, same amount, three or more months), so a new one shows up here on its own.
        {data.unmatched.length > 0 && ` Not matched to a client record: ${data.unmatched.join(", ")}.`}
      </p>
    </Section>
  );
}
