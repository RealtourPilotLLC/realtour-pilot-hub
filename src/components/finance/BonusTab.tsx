import Link from "next/link";
import { Trophy, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { prisma } from "@/lib/prisma";
import { BONUS_BANDS, MAX_QUARTERLY_BONUS, quarterFor, scoreQuarterRoster } from "@/lib/kpi";
import { PayBonusButton } from "@/components/finance/PayBonusButton";
import { usd0 as m } from "@/lib/money";

export const dynamic = "force-dynamic";

// The quarterly performance bonus, one engine (Jordan, Oct 21 2026: "One bonus
// engine: the scorecard bands"). Every card here is kpi.ts scoreQuarter(), the
// same scorecard each person watches on My Performance, paid in its fixed
// bands: 90+ $1,000, 80-89 $600, 70-79 $250, below 70 nothing. Until Oct 21
// this tab ran the retired lib/bonus.ts instead (a share of quarterly profit
// above $15k, split by a different score), so the figure Jordan paid could
// differ from the figure the photographer had been shown.
//
// This page COMPUTES; the owner's Pay button is the only thing that moves
// money (a PayoutAdjustment per person, visible on Payroll), and the server
// recomputes the amount with the same scoreQuarter() before it pays.
export async function BonusTab({ show, back = 0 }: { show: FinanceTab[]; back?: number }) {
  const q = quarterFor(undefined, back);
  const [cards, already] = await Promise.all([
    scoreQuarterRoster(q),
    prisma.payoutAdjustment.findMany({
      where: { label: { startsWith: `Quarterly bonus ${q.key}` } },
      select: { teamMemberId: true, amount: true },
    }),
  ]);
  const paidTo = new Map(already.map((a) => [a.teamMemberId, a.amount]));
  // back=0 is the quarter we are in; a card says the same thing (provisional).
  const running = back === 0 || cards.some((c) => c.provisional);
  const total = cards.reduce((s, c) => s + c.bonus, 0);
  const earning = cards.filter((c) => c.bonus > 0).length;

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Quarterly bonus" subtitle={`${q.label}: each person's My Performance scorecard, paid in fixed bands`} />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="bonus" show={show} />

        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          {[0, 1, 2].map((b) => {
            const qq = quarterFor(undefined, b);
            return (
              <Link key={b} href={`/sales?tab=bonus&back=${b}`}
                className={b === back ? "inline-flex min-h-9 items-center rounded-lg bg-brand-action px-3 py-1.5 text-xs font-semibold text-white sm:min-h-0" : "inline-flex min-h-9 items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 sm:min-h-0"}>
                {qq.label}
              </Link>
            );
          })}
        </div>

        {/* THE QUARTER: what the scorecards add up to, and the bands they pay in. */}
        <section className="panel-shadow rounded-2xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <Trophy className="size-3.5 text-brand" /> {running ? "Worth today" : "Earned"} · {q.label}
              </div>
              <div className={`mt-0.5 text-3xl font-bold tabular-nums ${total > 0 ? "text-success" : "text-muted"}`}>{m(total)}</div>
              <p className="mt-1 max-w-xl text-xs text-muted">
                {earning === 0
                  ? "Nobody is in a paying band for this quarter."
                  : `${earning} of ${cards.length} ${cards.length === 1 ? "person is" : "people are"} in a paying band.`}
                {running ? " The quarter is still running, so these still move." : ""}
              </p>
            </div>
            <div className="grid grid-cols-4 gap-1.5 text-center">
              {[...BONUS_BANDS].reverse().map((b) => (
                <div key={b.min} className="rounded-lg border border-border px-2 py-1.5">
                  <div className="text-[10px] font-medium text-muted-2">{b.short}</div>
                  <div className={`text-xs font-bold tabular-nums ${b.amount > 0 ? "text-success" : "text-muted-2"}`}>{b.amount > 0 ? m(b.amount) : "nothing"}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {cards.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            Nobody on the roster is covered by the bonus: it covers active photographers and the creative manager, never you.
          </p>
        )}

        {/* ONE CARD PER PERSON: the same areas, points and band they see. */}
        {cards.map((c) => {
          const shown = c.score == null ? null : Math.round(c.score);
          return (
            <section key={c.memberId} className="panel-shadow rounded-2xl border border-border bg-surface">
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <TrendingUp className="size-4 text-brand" />
                  {c.name}
                </span>
                <span className="ml-auto flex flex-wrap items-center justify-end gap-3">
                  <span className="text-xs text-muted">{c.shoots} shoot{c.shoots === 1 ? "" : "s"}</span>
                  <span className="text-sm font-bold tabular-nums">{shown == null ? "no score yet" : `${shown}/100`}</span>
                  {c.band && shown != null && <span className="text-xs text-muted">{c.band.label}</span>}
                  <span className={`text-sm font-bold tabular-nums ${c.bonus > 0 ? "text-success" : "text-muted-2"}`}>{m(c.bonus)}</span>
                  {paidTo.has(c.memberId) ? (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">paid {m(paidTo.get(c.memberId) ?? 0)}</span>
                  ) : c.provisional ? (
                    // The running quarter's score still moves; paying now would
                    // permanently cap this person at the mid-quarter figure
                    // (per-quarter idempotency). Pay when closed.
                    c.bonus > 0 && <span className="text-[10px] text-muted-2">payable when the quarter closes</span>
                  ) : (
                    c.bonus > 0 && <PayBonusButton memberId={c.memberId} name={c.name.split(" ")[0]} amount={c.bonus} quarter={q.key} />
                  )}
                </span>
              </div>
              {shown == null && c.thinReason && <p className="border-b border-border/60 px-5 py-2 text-xs text-muted">{c.thinReason}</p>}
              <div className="divide-y divide-border/60">
                {c.areas.map((a) => {
                  const scored = a.measured && a.maxPoints > 0;
                  return (
                    <div key={a.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-5 py-2 text-sm">
                      <span className="min-w-0 font-medium sm:w-44 sm:shrink-0">
                        {a.label}
                        <span className="ml-1.5 text-[10px] font-normal text-muted-2">{a.weight} pts</span>
                      </span>
                      <span className="min-w-0 flex-1 text-xs text-muted">{a.measured ? a.value : (a.why ?? a.value)}</span>
                      <span className="shrink-0 text-right text-xs font-semibold tabular-nums">
                        {scored ? `${Math.round(a.points)}/${Math.round(a.maxPoints)}` : a.measured ? "measured" : "not measured"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        <p className="px-1 text-[11px] text-muted-2">
          Each card is the scorecard that person sees on My Performance: seven areas, re-weighted over the ones the hub can
          measure, and the whole-number score decides the band (up to {m(MAX_QUARTERLY_BONUS)} a quarter). Nothing pays
          automatically. The Pay button works the figure out again on the server, refuses if it no longer matches what is on
          this screen, and writes it onto that person&rsquo;s next payout (visible on Payroll). That is the only money path.
        </p>
      </div>
    </div>
  );
}
