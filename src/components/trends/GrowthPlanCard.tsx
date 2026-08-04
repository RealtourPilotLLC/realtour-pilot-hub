"use client";

import { useState } from "react";
import { Lightbulb, Loader2, RefreshCw, ArrowUpRight, PackagePlus, Megaphone, Target, Wrench } from "lucide-react";
import { refreshGrowthPlanAction } from "@/app/trends/advisorActions";
import type { GrowthPlanData } from "@/lib/growthPlan";

// The one card on /trends that says what to DO. Everything above it reports.

type Props = { plan: GrowthPlanData | null; builtAt: string | null; stale: boolean };

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "built today";
  if (days === 1) return "built yesterday";
  return `built ${days} days ago`;
};

function Group({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof Target;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          <Icon className="size-3.5" /> {title}
        </h3>
        <span className="text-[11px] text-muted-2">{hint}</span>
      </div>
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-border/70 bg-surface-2/50 p-3">{children}</div>
);

export function GrowthPlanCard({ plan: initial, builtAt: initialAt, stale }: Props) {
  const [plan, setPlan] = useState(initial);
  const [builtAt, setBuiltAt] = useState(initialAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await refreshGrowthPlanAction();
      if (r.plan) {
        setPlan(r.plan);
        setBuiltAt(r.builtAt);
      }
      if (r.error) setError(r.error);
    } catch {
      setError("Could not rebuild the plan. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-brand/30 bg-brand/[0.04] panel-shadow">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-brand/20 px-5 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Lightbulb className="size-4 text-brand" /> What to do about it
        </span>
        <span className="text-[11px] text-muted-2">
          {builtAt ? when(builtAt) : "not built yet"}
          {stale && builtAt ? " · the numbers have moved since" : ""}
        </span>
        <button
          onClick={refresh}
          disabled={busy}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {busy ? "Thinking…" : "Rebuild"}
        </button>
      </div>

      <div className="space-y-5 px-5 py-4">
        {error && <p className="text-xs text-danger">{error}</p>}

        {!plan ? (
          <p className="text-sm text-muted">
            No plan yet — hit <span className="font-medium">Rebuild</span> and it will read this year&rsquo;s bookings, package mix,
            margins and client rhythms, then tell you what to change.
          </p>
        ) : (
          <>
            <p className="text-sm font-medium leading-relaxed">{plan.headline}</p>

            {plan.aovMoves?.length > 0 && (
              <Group icon={ArrowUpRight} title="Raise the average order" hint="biggest first">
                {plan.aovMoves.map((m, i) => (
                  <Row key={i}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold">{m.title}</span>
                      <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">{m.impact}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">{m.why}</p>
                    <p className="mt-1 text-xs">{m.how}</p>
                  </Row>
                ))}
              </Group>
            )}

            {plan.newPackages?.length > 0 && (
              <Group icon={PackagePlus} title="Packages worth creating" hint="not in the catalog today">
                {plan.newPackages.map((p, i) => (
                  <Row key={i}>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold">{p.name}</span>
                      <span className="text-sm font-semibold tabular-nums text-brand">{p.price}</span>
                    </div>
                    <p className="mt-1 text-xs">{p.contents}</p>
                    <p className="mt-1 text-xs text-muted">{p.why}</p>
                    <p className="mt-1 text-[11px] text-muted-2">Offer it first to: {p.targetClients}</p>
                  </Row>
                ))}
              </Group>
            )}

            {plan.promotions?.length > 0 && (
              <Group icon={Megaphone} title="Promotions to run" hint="with the reason behind each">
                {plan.promotions.map((p, i) => (
                  <Row key={i}>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold">{p.name}</span>
                      <span className="text-[11px] text-muted-2">{p.timing}</span>
                    </div>
                    <p className="mt-1 text-xs">{p.offer}</p>
                    <p className="mt-1 text-[11px] text-muted-2">Who: {p.audience}</p>
                    <p className="mt-1 text-xs text-muted">{p.why}</p>
                  </Row>
                ))}
              </Group>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              {plan.focus?.length > 0 && (
                <Group icon={Target} title="Lean into" hint="already working">
                  {plan.focus.map((f, i) => (
                    <Row key={i}>
                      <div className="text-sm font-semibold">{f.title}</div>
                      <p className="mt-1 text-xs text-muted">{f.why}</p>
                    </Row>
                  ))}
                </Group>
              )}
              {plan.fix?.length > 0 && (
                <Group icon={Wrench} title="Fix" hint="going the wrong way">
                  {plan.fix.map((f, i) => (
                    <Row key={i}>
                      <div className="text-sm font-semibold">{f.title}</div>
                      <p className="mt-1 text-xs text-muted">{f.why}</p>
                    </Row>
                  ))}
                </Group>
              )}
            </div>

            <p className="text-[11px] leading-relaxed text-muted-2">
              Generated from this year&rsquo;s live booking, package, margin and client data. Recommendations, not instructions — nothing here
              is sent to anyone, and prices are proposals for you to sanity-check against what your market will actually pay.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
