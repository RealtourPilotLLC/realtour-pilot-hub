import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { stripeSnapshot, type StripeSnapshot } from "@/lib/integrations/stripe";

// ---------------------------------------------------------------------------
// STRIPE AT A GLANCE (Oct 24 2026, Jordan: "I want to see Stripe balances too.
// The stripe balances should show incoming, balance, MTD Gross and Net Rev.")
// Live from Stripe (lib/integrations/stripe.stripeSnapshot); on Finance →
// Overview and Finance → Audit, and inset in the dashboard's Financial
// Position card. Owner only, like every Finance tab but Unpaid.
// ---------------------------------------------------------------------------

const money = (n: number | null | undefined, cents = false) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;

function Shell({ right, inset, children }: { right?: React.ReactNode; inset?: boolean; children: React.ReactNode }) {
  const Title = inset ? "h4" : "h2";
  return (
    <section id="stripe" aria-labelledby="stripe-title" className={cn("min-w-0 scroll-mt-20 border border-border", inset ? "rounded-xl p-4" : "panel-shadow rounded-2xl bg-surface p-4 sm:p-5")} data-stripe-card>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Title id="stripe-title" className={cn("mr-auto font-semibold tracking-tight", inset ? "text-base" : "text-lg")}>Stripe</Title>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Reads Stripe itself: for a page that doesn't already hold a snapshot. */
export async function StripeBalances() {
  return <StripeCard s={await stripeSnapshot().catch(() => null)} />;
}

/** `inset`: a panel inside another card (the dashboard), two tiles a row. */
export function StripeCard({ s, inset = false }: { s: StripeSnapshot | null; inset?: boolean }) {
  if (!s) return <Shell inset={inset}><p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Couldn&rsquo;t read Stripe. Check the key on Connections → Stripe. This is not a $0 balance.</p></Shell>;
  const tiles: { label: string; value: number | null; sub: string }[] = [
    { label: "Incoming", value: s.incoming, sub: "Paid by clients, not available yet" },
    { label: "Balance", value: s.balance, sub: s.inTransit ? `${money(s.inTransit, true)} on its way to the bank` : "Available to pay out" },
    { label: `${s.monthLabel} gross`, value: s.mtd.gross, sub: `${s.mtd.charges} payment${s.mtd.charges === 1 ? "" : "s"}` },
    { label: `${s.monthLabel} net revenue`, value: s.mtd.net, sub: `After ${money(s.mtd.fees, true)} of fees${s.mtd.refunds ? ` and ${money(s.mtd.refunds, true)} refunded` : ""}` },
  ];
  return (
    <Shell inset={inset} right={<span className="text-[12px] text-muted">{s.source === "live" ? `Live from Stripe · ${etDateTime(s.asOf)}` : `From the last sync · ${etDateTime(s.asOf)} (Stripe didn't answer just now)`}</span>}>
      <div className={cn("grid grid-cols-2 gap-3", !inset && "lg:grid-cols-4")}>
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl bg-surface-2/60 p-3" data-stripe={t.label}>
            <p className="text-[13px] text-muted">{t.label}</p>
            <p className={cn("text-xl font-bold tabular-nums sm:text-2xl", t.value == null && "text-base font-semibold text-muted")}>{t.value == null ? "Not read" : money(t.value, true)}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">{t.sub}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-muted">
        {`This month Stripe also paid out ${money(s.mtd.paidOut, true)} to you, held back ${money(s.mtd.capitalWithheld, true)} for the Stripe Capital loan, and billed ${money(s.mtd.billingFees, true)} of its own fees. Loan repayments aren’t counted against revenue.`}
      </p>
    </Shell>
  );
}
