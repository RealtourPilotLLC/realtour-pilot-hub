import Link from "next/link";
import { DollarSign, Camera, Car, Upload, ChevronRight, Clock, HelpCircle } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { shootEarnings } from "@/lib/shoot";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Async server component: computes the assigned photographer's pay for this one
// shoot (base pay + that day's mileage share) and renders it. Rendered inside a
// <Suspense> so the guided screen paints immediately and the pay streams in —
// the mileage step can hit the OSRM router on a cold day.
//
// A DOLLAR FIGURE IS ONLY EVER PRINTED FOR A REAL PAY LINE. Anything else — pay
// held behind the upload page, a shoot the office took off payroll, a payroll
// pass that wouldn't run — is a sentence saying which, because "$0.00" under
// "Your pay for this shoot" reads to the person who did the work as "that was
// worth nothing" (readiness audit, Sep 2).
export async function ShootPayCard({ projectId, memberId }: { projectId: string; memberId: string }) {
  const earnings = await shootEarnings(projectId, memberId);
  if (!earnings) return null;

  // Held by the debrief pay gate. The one state with something to DO about it,
  // so it gets the amber treatment and the same button the shoot screen uses.
  if (earnings.state === "pending") {
    return (
      <Section icon={DollarSign} title="Your pay for this shoot" tone="warning">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Clock className="size-4 shrink-0 text-warning" /> Not worked out yet
        </div>
        <p className="mt-1.5 text-sm text-muted">
          Nothing is missing and nothing is lost — this shoot goes on your payroll the moment you submit its upload
          page. Files into Dropbox, tick everything off, add your notes for the editor, then hit{" "}
          <span className="font-medium text-foreground">Everything&rsquo;s uploaded — submit</span>. Your shoot pay and
          mileage show up right here.
        </p>
        <Link
          href={`/upload/${projectId}`}
          className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90"
        >
          <Upload className="size-4" /> Finish the upload page <ChevronRight className="size-4" />
        </Link>
        <p className="mt-3 text-[11px] text-muted-2">
          Shoots from Sep 2 2026 on. Anything you shot before that is already on your pay page.
        </p>
      </Section>
    );
  }

  // The owner took this job off this person's payroll. They can't see /payouts,
  // so the only way they'd ever learn it is here.
  if (earnings.state === "removed") {
    return (
      <Section icon={DollarSign} title="Your pay for this shoot">
        <p className="text-sm font-semibold">Not on your payroll</p>
        <p className="mt-1 text-sm text-muted">
          This shoot was taken off your pay in the office, so it isn&rsquo;t in your period total. If that doesn&rsquo;t
          look right, text Jordan — it can be put straight back.
        </p>
      </Section>
    );
  }

  // We couldn't work out a figure. Say it plainly instead of vanishing (the old
  // behaviour) or printing a zero — both leave the person guessing.
  if (earnings.state === "unavailable") {
    return (
      <Section icon={DollarSign} title="Your pay for this shoot">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <HelpCircle className="size-4 shrink-0 text-muted" /> We couldn&rsquo;t work this one out
        </div>
        <p className="mt-1 text-sm text-muted">
          Your pay for this shoot didn&rsquo;t come through — that&rsquo;s on us, not on you, and nothing you&rsquo;ve
          earned is gone. Reload the page, and if it still won&rsquo;t show, text Jordan so he can check it against
          payroll.
        </p>
      </Section>
    );
  }

  if (!earnings.configured) {
    return (
      <Section icon={DollarSign} title="Your pay">
        <p className="text-sm text-muted">
          Your pay rates aren’t set up yet — text Jordan and he’ll add them. Then your earnings for each shoot show here.
        </p>
      </Section>
    );
  }

  const hasTravel = earnings.mileageShare > 0;
  return (
    <Section icon={DollarSign} title="Your pay for this shoot">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-3xl font-semibold tracking-tight">{usd(earnings.total)}</div>
          <div className="mt-1 space-y-0.5 text-sm text-muted">
            <div className="flex items-center gap-2">
              <Camera className="size-3.5" /> Shoot pay {usd(earnings.shootPay)}
              {/* Which visit this figure is for — a return trip pays the flat
                  rate, so the number is deliberately not a % of the invoice. */}
              {earnings.returnTrip && <span className="text-muted-2">· second visit, flat rate</span>}
            </div>
            {hasTravel ? (
              <div className="flex items-center gap-2">
                <Car className="size-3.5" /> Travel {usd(earnings.mileageShare)}
                {earnings.payableMiles ? <span className="text-muted-2">· {Math.round(earnings.payableMiles)} paid mi{earnings.sharedJobs > 1 ? ` ÷ ${earnings.sharedJobs}` : ""}</span> : null}
              </div>
            ) : earnings.hasHome ? (
              <div className="flex items-center gap-2 text-muted-2"><Car className="size-3.5" /> Within your free travel radius</div>
            ) : (
              <div className="flex items-center gap-2 text-muted-2"><Car className="size-3.5" /> Text Jordan your home address to turn on mileage pay</div>
            )}
          </div>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-muted-2">Estimate — final pay is confirmed on payout day and may combine with other shoots that day for travel.</p>
    </Section>
  );
}

export function ShootPayCardSkeleton() {
  return (
    <Section icon={DollarSign} title="Your pay for this shoot">
      <div className="h-9 w-32 animate-pulse rounded-lg bg-surface-2" />
      <div className="mt-2 h-4 w-48 animate-pulse rounded bg-surface-2" />
    </Section>
  );
}
