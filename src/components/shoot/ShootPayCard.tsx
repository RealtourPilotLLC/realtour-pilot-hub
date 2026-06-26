import { DollarSign, Camera, Car } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { shootEarnings } from "@/lib/shoot";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Async server component: computes the assigned photographer's pay for this one
// shoot (base pay + that day's mileage share) and renders it. Rendered inside a
// <Suspense> so the guided screen paints immediately and the pay streams in —
// the mileage step can hit the OSRM router on a cold day.
export async function ShootPayCard({ projectId, memberId }: { projectId: string; memberId: string }) {
  const earnings = await shootEarnings(projectId, memberId);
  if (!earnings) return null;

  if (!earnings.configured) {
    return (
      <Section icon={DollarSign} title="Your pay">
        <p className="text-sm text-muted">
          Your pay rates aren’t set up yet. Once they’re added on the team page, your earnings for each shoot show here.
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
            <div className="flex items-center gap-2"><Camera className="size-3.5" /> Shoot pay {usd(earnings.shootPay)}</div>
            {hasTravel ? (
              <div className="flex items-center gap-2">
                <Car className="size-3.5" /> Travel {usd(earnings.mileageShare)}
                {earnings.payableMiles ? <span className="text-muted-2">· {Math.round(earnings.payableMiles)} paid mi{earnings.sharedJobs > 1 ? ` ÷ ${earnings.sharedJobs}` : ""}</span> : null}
              </div>
            ) : earnings.hasHome ? (
              <div className="flex items-center gap-2 text-muted-2"><Car className="size-3.5" /> Within your free travel radius</div>
            ) : (
              <div className="flex items-center gap-2 text-muted-2"><Car className="size-3.5" /> Add your home address for mileage</div>
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
