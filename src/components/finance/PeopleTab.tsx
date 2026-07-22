import { Users, CreditCard, UserCheck, CalendarDays } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { peoplePayments } from "@/lib/bookkeeping";

export const dynamic = "force-dynamic";

const YEAR_START = "2026-01-01";
const m0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

const CHANNEL_COLOR: Record<string, string> = {
  Venmo: "#6ba3d6", Wise: "#5cb98a", ACH: "#8b93e6", "Debit card": "#d4a95f",
  PayPal: "#4fb3a6", Zelle: "#b389d6", Check: "#9aa4b2", Cash: "#d782ac", Wire: "#e96320", Other: "#6a6a6a",
};
const chColor = (c: string) => CHANNEL_COLOR[c] ?? "#6a6a6a";

// Who you pay — every contractor/editor/vendor, grouped by person AND by the
// rail you paid them on (Venmo, Wise, ACH, debit, …). The answer to
// "what am I paying people monthly, through what."
export async function PeopleTab({ show }: { show: FinanceTab[] }) {
  const now = new Date();
  const endKey = now.toISOString().slice(0, 10);
  const monthKey = endKey.slice(0, 7);
  const data = await peoplePayments(YEAR_START, endKey);

  const thisMonth = data.monthTotals[monthKey] ?? 0;
  const top = data.list[0];
  const channels = Object.entries(data.channelTotals).sort(([, a], [, b]) => b - a).map(([channel, amount]) => ({ channel, amount }));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="People" subtitle="Everyone you pay — by person, and by how you pay them" />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="people" show={show} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={Users} accent="#5cb98a" label="Paid to people · YTD" value={m0(data.total)} sub={`${data.count} people & vendors`} />
          <Kpi icon={CalendarDays} accent="#6ba3d6" label="This month" value={m0(thisMonth)} sub="paid out so far" />
          <Kpi icon={UserCheck} accent="#8b93e6" label="Top recipient" value={top ? m0(top.total) : "—"} sub={top?.payee ?? "—"} />
          <Kpi icon={CreditCard} accent="#d4a95f" label="Payment channels" value={String(channels.length)} sub={channels.slice(0, 3).map((c) => c.channel).join(", ")} />
        </div>

        {/* HOW YOU PAY — channel donut */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <CreditCard className="size-4 text-brand" /> How you pay
          </div>
          <p className="mb-4 text-xs text-muted">Total paid out by rail. Contractors are paid via Venmo, Wise, ACH and debit — never Stripe (that's money coming in).</p>
          <Donut total={data.total} slices={channels.map((c) => ({ key: c.channel, label: c.channel, amount: c.amount, color: chColor(c.channel) }))} />
        </section>

        {/* PER-PERSON ROSTER */}
        <section className="rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-sm font-semibold">
            <Users className="size-4 text-brand" /> Everyone you pay
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-2">
                  <th className="px-5 py-2 font-medium">Person / vendor</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 text-right font-medium">This month</th>
                  <th className="px-3 py-2 text-right font-medium">Payments</th>
                  <th className="px-5 py-2 text-right font-medium">YTD total</th>
                </tr>
              </thead>
              <tbody>
                {data.list.map((p) => (
                  <tr key={p.payee} className="border-b border-border/60 last:border-0 hover:bg-surface-2">
                    <td className="px-5 py-2.5 font-medium text-foreground/90">{p.payee}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: `${chColor(p.primaryChannel)}22`, color: chColor(p.primaryChannel) }}>
                        <span className="size-1.5 rounded-full" style={{ backgroundColor: chColor(p.primaryChannel) }} />
                        {p.primaryChannel}
                        {Object.keys(p.channels).length > 1 && <span className="text-muted-2">+{Object.keys(p.channels).length - 1}</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{m0(p.months[monthKey] ?? 0)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-2">{p.count}</td>
                    <td className="px-5 py-2.5 text-right font-semibold tabular-nums">{m0(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, accent, label, value, sub }: { icon: LucideIcon; accent: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${accent}1a`, color: accent }}>
          <Icon className="size-4" />
        </span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}

function Donut({ total, slices }: { total: number; slices: { key: string; label: string; amount: number; color: string }[] }) {
  if (total <= 0 || slices.length === 0) return <div className="flex h-40 items-center justify-center text-sm text-muted">No payments recorded yet.</div>;
  const r = 42, cx = 60, cy = 60, C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = slices.map((s) => {
    const len = (s.amount / total) * C;
    const el = (
      <circle key={s.key} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={16}
        strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${cx} ${cy})`} />
    );
    offset += len;
    return el;
  });
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-7">
      <svg viewBox="0 0 120 120" className="size-40 shrink-0">
        {arcs}
        <text x={cx} y={cy - 3} textAnchor="middle" className="fill-foreground" style={{ fontSize: 15, fontWeight: 700 }}>{m0(total)}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-muted" style={{ fontSize: 7, letterSpacing: 0.5 }}>PAID OUT</text>
      </svg>
      <div className="grid w-full gap-1.5 sm:grid-cols-2">
        {slices.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-sm">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="flex-1 truncate text-foreground/85">{s.label}</span>
            <span className="tabular-nums font-medium text-foreground">{m0(s.amount)}</span>
            <span className="w-9 text-right tabular-nums text-xs text-muted-2">{Math.round((s.amount / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
