import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, CreditCard, Landmark, PiggyBank, Receipt, TrendingUp, Wallet } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { AuditTaskButton, VenmoUpload } from "@/components/finance/AuditControls";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { financeAuditYtd } from "@/lib/financeAudit";
import { STATUS_WORDS, type AuditStatus, type MoneyGroup } from "@/lib/financeAuditCore";
import { StripeCard } from "@/components/finance/StripeCard";

// ---------------------------------------------------------------------------
// FINANCE → AUDIT (Oct 24 2026). The year-to-date books audit Jordan asked
// for, as a page he can come back to: the totals up top in the dashboard's
// card style, Stripe at a glance, what to do, the tie-out checks, where the
// money went and how sure each number is. Everything reads lib/financeAudit,
// which reads the same engines as the other Finance tabs. Owner only.
// ---------------------------------------------------------------------------

const CARD = "panel-shadow rounded-2xl border border-border bg-surface";
const money = (n: number | null | undefined, cents = false) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const niceDay = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const STATUS_STYLE: Record<AuditStatus, { chip: string; icon: typeof CheckCircle2; bar: string }> = {
  ok: { chip: "bg-success/10 text-success", icon: CheckCircle2, bar: "bg-success" },
  flag: { chip: "bg-warning/15 text-warning", icon: AlertTriangle, bar: "bg-warning" },
  gap: { chip: "bg-danger/10 text-danger", icon: CircleDashed, bar: "bg-danger" },
};

function Card({ title, id, right, children, className }: { title: string; id: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn(CARD, "min-w-0 scroll-mt-20 p-4 sm:p-5", className)} data-audit-section={id}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id={`${id}-title`} className="mr-auto text-lg font-semibold tracking-tight">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Figure({ icon: Icon, label, value, sub, tone }: { icon: typeof Wallet; label: string; value: string; sub?: string | null; tone?: "ok" | "warn" | "bad" | null }) {
  return (
    <div className="flex min-w-0 gap-2.5 p-1 lg:px-4" data-audit-figure={label}>
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-brand" />
      <div className="min-w-0">
        <p className="text-[13px] text-muted">{label}</p>
        <p className={cn("text-xl font-bold tabular-nums sm:text-2xl", tone === "ok" && "text-success", tone === "warn" && "text-warning", tone === "bad" && "text-danger")}>{value}</p>
        {sub && <p className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</p>}
      </div>
    </div>
  );
}

function GroupBlock({ g, max }: { g: MoneyGroup; max: number }) {
  return (
    <div className="min-w-0" data-audit-group={g.key}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{g.label}</h3>
        <span className="text-sm font-bold tabular-nums">{money(g.total)}</span>
      </div>
      <p className="text-[11px] text-muted">{g.note}</p>
      {g.rows.length ? (
        <ul className="mt-2 space-y-1.5">
          {g.rows.slice(0, 8).map((r) => (
            <li key={r.category} className="text-[13px]">
              <div className="flex justify-between gap-2"><span className="truncate">{r.category}</span><span className="shrink-0 tabular-nums text-muted">{money(r.sum)}</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand/70" style={{ width: `${Math.max(2, Math.min(100, (r.sum / max) * 100))}%` }} /></div>
            </li>
          ))}
          {g.rows.length > 8 && <li className="text-[12px] text-muted">+ {g.rows.length - 8} smaller categories ({money(g.rows.slice(8).reduce((s, r) => s + r.sum, 0))})</li>}
        </ul>
      ) : (
        <p className="mt-2 text-[13px] text-muted">None found in any connected account.</p>
      )}
    </div>
  );
}

export async function AuditTab({ show }: { show: FinanceTab[] }) {
  const a = await financeAuditYtd();
  const fixes = a.checks.filter((c) => c.status !== "ok").length;
  const passing = a.checks.length - fixes;
  const max = Math.max(1, ...a.groups.flatMap((g) => g.rows.map((r) => r.sum)));
  const unsorted = a.review.out + a.review.incoming;
  const spend = a.businessTotal + a.personalTotal;
  const provenPct = a.provenPct ?? 0;
  const unsortedPct = spend > 0 ? unsorted / (spend + unsorted) : 0;
  const rulePct = Math.max(0, 1 - provenPct - unsortedPct);
  const now = a.actions.filter((x) => x.when === "now");
  const monthly = a.actions.filter((x) => x.when === "monthly");

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Books audit" subtitle={`${niceDay(a.startKey)} to ${niceDay(a.endKey)} · checked against Stripe, QuickBooks, the bank and card feeds and your Venmo statements`} />
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6" data-books-audit>
        <FinanceTabs tab="audit" show={show} />

        <section aria-label="The year so far" className={cn(CARD, "p-4 sm:p-5")}>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 lg:gap-0 lg:divide-x lg:divide-border">
            <Figure icon={TrendingUp} label="Revenue" value={money(a.revenue.total)} sub={`QuickBooks ${money(a.revenue.quickbooks)} · Stripe ${money(a.revenue.stripe)} · Venmo ${money(a.revenue.venmo)}`} />
            <Figure icon={Receipt} label="Business costs" value={money(a.businessTotal)} sub="Editing, creative pay, software, fees" />
            <Figure icon={Wallet} label="Profit" value={money(a.profit)} sub={`${pct(a.margin)} margin`} tone={a.profit >= 0 ? "ok" : "bad"} />
            <Figure icon={PiggyBank} label="Personal living" value={money(a.groups.find((g) => g.key === "living")?.total ?? 0)} sub={`Plus ${money(a.groups.find((g) => g.key === "debt")?.total ?? 0)} of loan payments`} />
            <Figure icon={fixes ? AlertTriangle : CheckCircle2} label="Checks" value={`${passing} of ${a.checks.length}`} sub={fixes ? `tie out · ${fixes} to look at` : "all tie out"} tone={fixes ? "warn" : "ok"} />
          </div>
          {a.revenue.notes.length > 0 && <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{a.revenue.notes.join(" ")}</p>}
        </section>

        <StripeCard s={a.stripe} />

        <Card title="What to do" id="actions" right={<AuditTaskButton count={a.actions.length} />}>
          {a.actions.length === 0 ? (
            <p className="text-sm text-muted">Nothing to fix: every check ties out.</p>
          ) : (
            <ol className="space-y-3" data-audit-actions={a.actions.length}>
              {[...now, ...monthly].map((x) => (
                <li key={x.key} className="rounded-xl border border-border p-3" data-audit-action={x.key}>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="mr-auto text-sm font-semibold [overflow-wrap:anywhere]">{x.title}</p>
                    <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", x.when === "now" ? "bg-danger/10 text-danger" : "bg-surface-2 text-muted")}>{x.when === "now" ? "Now" : "Every month"}</span>
                  </div>
                  <p className="mt-1 text-[13px] text-muted">{x.why}</p>
                  <p className="mt-1 text-[13px]"><span className="font-medium">How: </span>{x.how}</p>
                  {x.href && (x.href.startsWith("/") ? <Link href={x.href} className="mt-1 inline-flex min-h-9 items-center gap-1 text-[13px] font-semibold text-brand hover:underline">Open <ArrowRight aria-hidden className="size-3.5" /></Link> : <a href={x.href} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-9 items-center gap-1 text-[13px] font-semibold text-brand hover:underline">Open <ArrowRight aria-hidden className="size-3.5" /></a>)}
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-[12px] text-muted">Each one is also a task on your list. The hub re-runs this audit every morning: a task closes itself once the problem is gone, and next month&rsquo;s statement reminders arrive on their own.</p>
        </Card>

        <Card title="Does it all add up?" id="checks">
          <ul className="divide-y divide-border" data-audit-checks={a.checks.length}>
            {a.checks.map((c) => {
              const st = STATUS_STYLE[c.status];
              const Icon = st.icon;
              return (
                <li key={c.key} className="flex gap-3 py-3" data-audit-check={c.key} data-status={c.status}>
                  <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", c.status === "ok" ? "text-success" : c.status === "flag" ? "text-warning" : "text-danger")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="mr-auto text-sm font-semibold">{c.title}</p>
                      <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", st.chip)}>{STATUS_WORDS[c.status]}</span>
                    </div>
                    <p className="mt-0.5 text-[13px] [overflow-wrap:anywhere]">{c.result}</p>
                    {c.detail && <p className="mt-0.5 text-[12px] text-muted [overflow-wrap:anywhere]">{c.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Where the money went" id="groups" right={<Link href="/sales?tab=spending" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline">Every line <ArrowRight aria-hidden className="size-4" /></Link>}>
          <div className="grid gap-6 md:grid-cols-2">
            {a.groups.map((g) => <GroupBlock key={g.key} g={g} max={max} />)}
          </div>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="How sure are these numbers?" id="proof">
            <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="bg-success" style={{ width: `${provenPct * 100}%` }} />
              <div className="bg-brand/60" style={{ width: `${rulePct * 100}%` }} />
              <div className="bg-warning" style={{ width: `${unsortedPct * 100}%` }} />
            </div>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              <li className="flex gap-2"><span className="mt-1 size-2.5 shrink-0 rounded-full bg-success" /> <span><span className="font-semibold">{pct(provenPct)} proven:</span> on a Venmo or Stripe statement, or a call you made by hand.</span></li>
              <li className="flex gap-2"><span className="mt-1 size-2.5 shrink-0 rounded-full bg-brand/60" /> <span><span className="font-semibold">{pct(rulePct)} matched:</span> the bank or card feed names the merchant and a house rule sorted it (Luma is video editing, Target is household).</span></li>
              <li className="flex gap-2"><span className="mt-1 size-2.5 shrink-0 rounded-full bg-warning" /> <span><span className="font-semibold">{pct(unsortedPct)} unsorted:</span> {money(unsorted)} waiting for your call on <Link href="/sales?tab=spending" className="font-medium text-brand hover:underline">Categories</Link>.</span></li>
            </ul>
          </Card>

          <Card title="QuickBooks payments, month by month" id="quickbooks">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] tabular-nums" data-audit-qb={a.qbMonths.length}>
                <thead><tr className="text-left text-[12px] text-muted"><th className="py-1 font-medium">Month</th><th className="py-1 text-right font-medium">QuickBooks recorded</th><th className="py-1 text-right font-medium">Bank received</th><th className="py-1 text-right font-medium">Running gap</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {a.qbMonths.map((m) => (
                    <tr key={m.month}>
                      <td className="py-1.5">{new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</td>
                      <td className="py-1.5 text-right">{money(m.recorded)}</td>
                      <td className="py-1.5 text-right">{money(m.banked)}</td>
                      <td className={cn("py-1.5 text-right", Math.abs(m.running) >= 1000 && "font-semibold text-warning")}>{money(m.running)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[12px] text-muted">A payment on the 30th lands in the bank on the 2nd, so single months swing. A running gap that stays put is money that never landed (QuickBooks ahead) or a payment never recorded (bank ahead).</p>
          </Card>
        </div>

        <Card title="Venmo statements" id="venmo" right={<span className="inline-flex items-center gap-1 text-[12px] text-muted"><CreditCard aria-hidden className="size-3.5" /> Yours and Lauren&rsquo;s</span>}>
          <p className="text-[13px] text-muted">Venmo has no connection the hub can read, so each month&rsquo;s statement is what says who a Venmo payment went to. On venmo.com → Statements, pick the month and press Download CSV, then add it here. Adding a month twice is safe.</p>
          <VenmoUpload />
        </Card>

        <p className="flex items-center gap-1.5 text-[11px] text-muted"><Landmark aria-hidden className="size-3.5" /> Revenue is counted where the money is taken (Stripe, QuickBooks Payments, Venmo), never from bank deposits, so nothing counts twice. Spending comes from every connected bank and card plus the statements. Audited {etDateTime(a.asOf)}.</p>
      </div>
    </div>
  );
}
