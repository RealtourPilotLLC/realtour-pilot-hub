import Link from "next/link";
import { Trophy, TrendingUp, Scale, PenLine } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { prisma } from "@/lib/prisma";
import { etDayKey } from "@/lib/datetime";
import {
  agreedTerms,
  payReadiness,
  periodFor,
  scoreLegacyRoster,
  scorePeriodRoster,
  type KpiPeriod,
  type KpiScorecard,
} from "@/lib/kpi";
import { readTermsVersions } from "@/lib/kpiStore";
import { agreementYearFor, ptoBalance, ptoRoster } from "@/lib/pto";
import { PayBonusButton } from "@/components/finance/PayBonusButton";
import { ManualEntryForm, ManualEntryRow, TermsForm, type ManualPerson } from "@/components/finance/KpiControls";
import { QuarterScoreCard } from "@/components/mypay/QuarterScoreCard";
import { PtoCard } from "@/components/mypay/PtoCard";
import { usd0 as m } from "@/lib/money";

export const dynamic = "force-dynamic";

// The KPI bonus, one engine (Jordan, Oct 21 2026), on the creative team's
// compensation terms (Oct 22 2026). Every card here is lib/kpi scorePeriod(),
// the same card each person watches on My Performance, with the owner's
// tools on it: resolving disputes, the monthly check-in and agreed deadlines.
// Above the cards: entries added by hand (add, edit, remove; Jordan, Oct 22:
// "I should have a page that can add things there too"), and below them each
// person's weights and bands (changed only from a period that has not
// started) and their paid time off (lib/pto).
// A period that began before the terms (2026-Q3 and earlier) shows the old
// seven-area scorecard it was measured under (lib/kpiLegacy).
//
// This page COMPUTES; the owner's Pay button is the only thing that moves
// money (a PayoutAdjustment per person, visible on Payroll), and the server
// works the amount out again with the same scorecard before it pays.
export async function BonusTab({ show, back = 0 }: { show: FinanceTab[]; back?: number }) {
  const p = periodFor(undefined, back);
  const already = await prisma.payoutAdjustment.findMany({
    where: { label: { startsWith: `Quarterly bonus ${p.key}` } },
    select: { teamMemberId: true, amount: true },
  });
  const paidTo = new Map(already.map((a) => [a.teamMemberId, a.amount]));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="KPI bonus and time off" subtitle={`${p.label}: each person's My Performance scorecard, paid in fixed bands`} />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="bonus" show={show} />

        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          {[0, 1, 2].map((b) => {
            const pp = periodFor(undefined, b);
            return (
              <Link key={b} href={`/sales?tab=bonus&back=${b}`}
                className={b === back ? "inline-flex min-h-9 items-center rounded-lg bg-brand-action px-3 py-1.5 text-xs font-semibold text-white sm:min-h-0" : "inline-flex min-h-9 items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 sm:min-h-0"}>
                {pp.label}{pp.legacy ? " (before the terms)" : ""}
              </Link>
            );
          })}
        </div>

        {p.legacy ? <LegacyPeriod p={p} paidTo={paidTo} /> : <ContractPeriod p={p} paidTo={paidTo} />}
        <PtoSection />
      </div>
    </div>
  );
}

async function ContractPeriod({ p, paidTo }: { p: KpiPeriod; paidTo: Map<string, number> }) {
  const cards = await scorePeriodRoster(p);
  const running = cards.length ? cards.some((c) => c.provisional) : p.endKey >= etDayKey(new Date());
  const total = cards.reduce((s, c) => s + c.bonus, 0);
  const earning = cards.filter((c) => c.bonus > 0).length;
  const disputes = cards.reduce((s, c) => s + c.openDisputes, 0);

  return (
    <>
      <section className="panel-shadow rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <Trophy className="size-3.5 text-brand" /> {running ? "Worth today" : "Earned"} · {p.label}
        </div>
        <div className={`mt-0.5 text-3xl font-bold tabular-nums ${total > 0 ? "text-success" : "text-muted"}`}>{m(total)}</div>
        <p className="mt-1 max-w-xl text-xs text-muted">
          {earning === 0 ? "Nobody is in a paying band for this period." : `${earning} of ${cards.length} ${cards.length === 1 ? "person is" : "people are"} in a paying band.`}
          {running ? " The period is still running, so these still move." : ` Settle by ${new Date(`${p.settleByKey}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.`}
          {disputes > 0 ? ` ${disputes} open dispute${disputes === 1 ? "" : "s"} to decide.` : ""}
        </p>
      </section>

      {cards.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface px-4 py-8 text-center text-sm text-muted">
          Nobody on the roster is covered by the bonus: it covers active photographers and the creative manager, never you.
        </p>
      ) : (
        <ManualEntries p={p} cards={cards} paidTo={paidTo} />
      )}

      {cards.map((c) => <PersonCard key={c.memberId} c={c} p={p} paid={paidTo.get(c.memberId)} />)}

      {cards.filter((c) => c.terms.personKey !== "specialist").map((c) => <TermsPanel key={c.memberId} card={c} />)}

      <p className="px-1 text-[11px] text-muted-2">
        Each card is the scorecard that person sees on My Performance: Harrison&rsquo;s five categories and weights from the terms, which James is
        scored on too (Jordan, Oct 22 2026), each with their own bands. Nothing pays automatically. The Pay button needs the period closed, every
        dispute decided and the check-in categories filled in; it works the figure out again on the server, refuses if it no longer matches this
        screen, and writes it onto that person&rsquo;s next payout (visible on Payroll). That is the only money path.
      </p>
    </>
  );
}

/** Entries added by hand: add one for anyone on the bonus, and edit or remove the ones already there. */
function ManualEntries({ p, cards, paidTo }: { p: KpiPeriod; cards: KpiScorecard[]; paidTo: Map<string, number> }) {
  const open = cards.filter((c) => !paidTo.has(c.memberId));
  const people: ManualPerson[] = open.map((c) => ({
    memberId: c.memberId,
    name: c.name,
    areas: c.terms.categories.map((cat) => ({ key: cat.areas[0], label: cat.label })),
    jobs: c.shootList.map((s) => ({ id: s.projectId, label: `${s.street} (${new Date(`${s.day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})` })),
  }));
  const todayKey = etDayKey(new Date());
  const defaultDay = todayKey < p.startKey ? p.startKey : todayKey > p.endKey ? p.endKey : todayKey;
  const rows = open.flatMap((c) => c.entries.filter((e) => e.kind === "manual").map((e) => ({ c, e })));
  return (
    <section className="panel-shadow rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <PenLine className="size-3.5 text-brand" /> Entries added by hand · {p.label}
      </div>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        Something the hub cannot see (a missed meeting, a late arrival, a compliment told in person): it shows on their scorecard like the
        hub&rsquo;s own entries, in the category you pick, and they can dispute it. Points move that category&rsquo;s 100; a note moves nothing.
      </p>
      {people.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted">Every scorecard for this period is paid, so it is closed.</p>
      ) : (
        <details className="mt-2">
          <summary className="flex min-h-9 cursor-pointer items-center text-xs font-semibold text-brand">Add an entry</summary>
          <div className="pt-2">
            <ManualEntryForm people={people} periodKey={p.key} minDay={p.startKey} maxDay={p.endKey} defaultDay={defaultDay} />
          </div>
        </details>
      )}
      {rows.length > 0 && (
        <ul className="mt-3 divide-y divide-border/60 rounded-lg border border-border">
          {rows.map(({ c, e }) => {
            const raw = e.id.replace(/^manual:/, "");
            const area = e.area;
            return (
              <li key={e.id} className="px-3 py-2">
                <ManualEntryRow
                  people={people}
                  periodKey={p.key}
                  minDay={p.startKey}
                  maxDay={p.endKey}
                  initial={{ memberId: c.memberId, id: raw, area, day: e.day, title: e.title, note: e.note ?? "", points: e.points ?? 0, projectId: e.projectId }}
                >
                  <div className="text-sm font-medium">{c.name.split(" ")[0]}: {e.title}</div>
                  <div className="text-[11px] text-muted">
                    {new Date(`${e.day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · {c.terms.categories.find((cat) => cat.key === e.category)?.label ?? e.area} ·{" "}
                    {e.points ? `${e.points > 0 ? "+" : ""}${e.points} points` : "note"}
                    {e.status === "disputed" ? " · disputed" : e.status === "removed" ? " · removed after a dispute" : ""}
                  </div>
                </ManualEntryRow>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PersonCard({ c, p, paid }: { c: KpiScorecard; p: KpiPeriod; paid: number | undefined }) {
  const shown = c.score == null ? null : Math.round(c.score);
  const ready = payReadiness(c);
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 px-1">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <TrendingUp className="size-4 text-brand" />
          {c.name}
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <span className="text-xs text-muted">{c.shoots} shoot{c.shoots === 1 ? "" : "s"}</span>
          <span className="text-sm font-bold tabular-nums">{shown == null ? "no score yet" : `${shown}/100`}</span>
          <span className={`text-sm font-bold tabular-nums ${c.bonus > 0 ? "text-success" : "text-muted-2"}`}>{m(c.bonus)} <span className="text-[11px] font-normal text-muted-2">of {m(c.possible)}</span></span>
          {paid != null ? (
            <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">paid {m(paid)}</span>
          ) : ready.ok ? (
            <PayBonusButton memberId={c.memberId} name={c.name.split(" ")[0]} amount={c.bonus} quarter={p.key} />
          ) : (
            <span className="max-w-xs text-right text-[10px] text-muted-2">{ready.why}</span>
          )}
        </span>
      </div>
      <QuarterScoreCard card={c} viewer={paid != null ? "preview" : "owner"} />
    </section>
  );
}

/** A person's weights and bands: in force now, and a change from a period that has not started. */
async function TermsPanel({ card }: { card: KpiScorecard }) {
  const personKey = card.terms.personKey as "harrison" | "james";
  const versions = await readTermsVersions(personKey);
  const future = [-1, -2, -3].map((b) => periodFor(undefined, b)).map((pp) => ({ key: pp.key, label: pp.label }));
  const base = agreedTerms(personKey);
  const first = card.name.split(" ")[0];
  return (
    <section className="panel-shadow rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Scale className="size-3.5 text-brand" /> {first}&rsquo;s weights and bands
      </div>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        In force for {card.period.label}: {card.terms.categories.map((c) => `${c.label} ${c.weight}`).join(", ")}; {card.terms.bands.filter((b) => b.amount > 0).map((b) => `${b.label} ${m(b.amount)}`).join(", ")}
        {card.terms.version ? ` (changed from ${card.terms.version.fromPeriodKey} by ${card.terms.version.savedBy}).` : " (as agreed in the terms)."} A change applies from a period that has not started, never to one already running.
      </p>
      {versions.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
          {versions.map((v) => (
            <li key={`${v.fromPeriodKey}-${v.savedAt}`}>
              From {v.fromPeriodKey}: {base.categories.map((c) => `${c.label} ${v.weights[c.key] ?? 0}`).join(", ")}; bands {v.bands.filter((b) => b.min > 0).map((b) => `${b.min}+ ${m(b.amount)}`).join(", ")}. Saved by {v.savedBy}{v.note ? `: ${v.note}` : ""}.
            </li>
          ))}
        </ul>
      )}
      <details className="mt-3">
        <summary className="flex min-h-9 cursor-pointer items-center text-xs font-semibold text-brand">Change {first}&rsquo;s weights or bands from a later period</summary>
        <div className="pt-2">
          <TermsForm
            personKey={personKey}
            name={first}
            categories={base.categories.map((c) => ({ key: c.key, label: c.label }))}
            cap={base.cap}
            periods={future}
            current={{ weights: Object.fromEntries(card.terms.categories.map((c) => [c.key, c.weight ?? 0])), bands: card.terms.bands.map((b) => ({ min: b.min, amount: b.amount })) }}
          />
        </div>
      </details>
    </section>
  );
}

/** Paid time off for the people on the terms: this agreement year, and the next when days are already booked in it. */
async function PtoSection() {
  const people = await ptoRoster();
  if (!people.length) return null;
  const todayKey = etDayKey(new Date());
  const year = agreementYearFor(todayKey);
  const nextKey = `${Number(year.startKey.slice(0, 4)) + 1}-${year.startKey.slice(5)}`;
  const cards: Awaited<ReturnType<typeof ptoBalance>>[] = [];
  for (const person of people) {
    cards.push(await ptoBalance(person.id, person.name, year.key));
    const next = await ptoBalance(person.id, person.name, nextKey);
    if (next.entries.length) cards.push(next);
  }
  return (
    <section className="space-y-3">
      <h2 className="px-1 text-sm font-semibold">Paid time off</h2>
      {cards.map((bal) => <PtoCard key={`${bal.memberId}-${bal.year.key}`} bal={bal} viewer="owner" todayKey={todayKey} />)}
    </section>
  );
}

/** A quarter that began before the terms: the old seven-area scorecard, frozen. */
async function LegacyPeriod({ p, paidTo }: { p: KpiPeriod; paidTo: Map<string, number> }) {
  const { BONUS_BANDS } = await import("@/lib/kpiLegacy");
  const cards = await scoreLegacyRoster(p);
  const running = cards.some((c) => c.provisional);
  const total = cards.reduce((s, c) => s + c.bonus, 0);
  const earning = cards.filter((c) => c.bonus > 0).length;
  return (
    <>
      <section className="panel-shadow rounded-2xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <Trophy className="size-3.5 text-brand" /> {running ? "Worth today" : "Earned"} · {p.label}
            </div>
            <div className={`mt-0.5 text-3xl font-bold tabular-nums ${total > 0 ? "text-success" : "text-muted"}`}>{m(total)}</div>
            <p className="mt-1 max-w-xl text-xs text-muted">
              {earning === 0 ? "Nobody is in a paying band for this quarter." : `${earning} of ${cards.length} ${cards.length === 1 ? "person is" : "people are"} in a paying band.`}{" "}
              This quarter began before the compensation terms, so it keeps the old seven-area scorecard it was measured under.
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
                  c.bonus > 0 && <span className="text-[10px] text-muted-2">payable when the quarter closes</span>
                ) : (
                  c.bonus > 0 && <PayBonusButton memberId={c.memberId} name={c.name.split(" ")[0]} amount={c.bonus} quarter={p.key} />
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
                    {/* Phone layout (Jordan, Oct 28 2026): the result wraps under the label instead of being squeezed beside it. */}
                    <span className="min-w-0 flex-1 basis-40 text-xs text-muted">{a.measured ? a.value : (a.why ?? a.value)}</span>
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
    </>
  );
}
