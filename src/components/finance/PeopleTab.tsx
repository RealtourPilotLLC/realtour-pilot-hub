import { Users, CreditCard, UserCheck, CalendarDays, Camera, Scissors, MonitorSmartphone, Headset, Megaphone, Boxes } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { KpiCards } from "@/components/finance/KpiCards";
import { peoplePayments, PAYEE_GROUPS, type PayeeRow } from "@/lib/bookkeeping";

export const dynamic = "force-dynamic";

const YEAR_START = "2026-01-01";
const m0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const abbr = (n: number) => (Math.abs(n) >= 1000 ? `$${Math.round(n / 1000).toLocaleString("en-US")}k` : `$${Math.round(n)}`);

const CHANNEL_COLOR: Record<string, string> = {
  Venmo: "#6ba3d6", Wise: "#5cb98a", ACH: "#8b93e6", "Debit card": "#d4a95f",
  PayPal: "#4fb3a6", Zelle: "#b389d6", Check: "#9aa4b2", Cash: "#d782ac", Wire: "#e96320", Stripe: "#635bff", Other: "#6a6a6a",
};
const chColor = (c: string) => CHANNEL_COLOR[c] ?? "#6a6a6a";

const GROUP_META: Record<string, { icon: LucideIcon; color: string }> = {
  "Creative specialists": { icon: Camera, color: "#6ba3d6" },
  "Editors": { icon: Scissors, color: "#8b93e6" },
  "Software & tools": { icon: MonitorSmartphone, color: "#d4a95f" },
  "Staff & VA": { icon: Headset, color: "#5cb98a" },
  "Marketing": { icon: Megaphone, color: "#d782ac" },
  "Other": { icon: Boxes, color: "#9aa4b2" },
};

// Who you pay — every contractor/editor/vendor, grouped by KIND (creatives,
// editors, software, staff…) AND by the rail you paid them on.
export async function PeopleTab({ show }: { show: FinanceTab[] }) {
  const now = new Date();
  const endKey = now.toISOString().slice(0, 10);
  const monthKey = endKey.slice(0, 7);
  const data = await peoplePayments(YEAR_START, endKey);

  const thisMonth = data.monthTotals[monthKey] ?? 0;
  const top = data.list[0];
  const channels = Object.entries(data.channelTotals).sort(([, a], [, b]) => b - a).map(([channel, amount]) => ({ channel, amount }));
  const groups = PAYEE_GROUPS
    .map((g) => ({ group: g, total: data.groupTotals[g] ?? 0, members: data.list.filter((p) => p.group === g) }))
    .filter((g) => g.members.length > 0)
    .sort((a, b) => b.total - a.total);
  const maxGroup = Math.max(1, ...groups.map((g) => g.total));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="People" subtitle="Everyone you pay — by type, by person, and by how you pay them" />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="people" show={show} />

        <KpiCards
          items={[
            {
              key: "ytd", icon: <Users className="size-4" />, accent: "#5cb98a",
              label: "Paid to people · YTD", value: m0(data.total), sub: `${data.count} people & vendors`,
              detailTitle: "Who got paid · year to date",
              details: data.list.slice(0, 18).map((p) => ({ label: p.payee, value: m0(p.total), sub: `${p.count}× · ${p.group}` })),
            },
            {
              key: "month", icon: <CalendarDays className="size-4" />, accent: "#6ba3d6",
              label: "This month", value: m0(thisMonth), sub: "paid out so far",
              detailTitle: "Who got paid this month",
              details: data.list
                .map((p) => ({ p, mv: p.months[monthKey] ?? 0 }))
                .filter((x) => x.mv > 0)
                .sort((a, b) => b.mv - a.mv)
                .map((x) => ({ label: x.p.payee, value: m0(x.mv), sub: x.p.group })),
            },
            {
              key: "top", icon: <UserCheck className="size-4" />, accent: "#8b93e6",
              label: "Top recipient", value: top ? m0(top.total) : "—", sub: top?.payee ?? "—",
              detailTitle: top ? `${top.payee} — by rail and by month` : undefined,
              details: top
                ? [
                    ...Object.entries(top.channels).sort((a, b) => b[1] - a[1]).map(([ch, amt]) => ({ label: ch, value: m0(amt), sub: "rail" })),
                    ...Object.entries(top.months).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6).map(([mk, amt]) => ({ label: mk, value: m0(amt), sub: "month" })),
                  ]
                : undefined,
            },
            {
              key: "channels", icon: <CreditCard className="size-4" />, accent: "#d4a95f",
              label: "Payment channels", value: String(channels.length), sub: channels.slice(0, 3).map((c) => c.channel).join(", "),
              detailTitle: "Paid out by rail",
              details: channels.map((c) => ({ label: c.channel, value: m0(c.amount) })),
            },
          ]}
        />

        {/* BY TYPE + HOW YOU PAY, side by side */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Boxes className="size-4 text-brand" /> By type
            </div>
            <div className="space-y-2.5">
              {groups.map((g) => {
                const Icon = GROUP_META[g.group]?.icon ?? Boxes;
                const c = GROUP_META[g.group]?.color ?? "#9aa4b2";
                return (
                  <div key={g.group} className="flex items-center gap-3">
                    <Icon className="size-4 shrink-0" style={{ color: c }} />
                    <div className="w-28 shrink-0 truncate text-sm text-foreground/85">{g.group}</div>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full" style={{ width: `${(g.total / maxGroup) * 100}%`, backgroundColor: c }} />
                    </div>
                    <div className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums">{m0(g.total)}</div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <CreditCard className="size-4 text-brand" /> How you pay
            </div>
            <p className="mb-3 text-xs text-muted">By rail. Contractors go out via Venmo, Wise, ACH, debit &amp; Stripe — never inbound Stripe revenue.</p>
            <Donut total={data.total} slices={channels.map((c) => ({ key: c.channel, label: c.channel, amount: c.amount, color: chColor(c.channel) }))} />
          </section>
        </div>

        {/* GROUPED ROSTER */}
        {groups.map((g) => {
          const Icon = GROUP_META[g.group]?.icon ?? Boxes;
          const c = GROUP_META[g.group]?.color ?? "#9aa4b2";
          return (
            <section key={g.group} className="rounded-2xl border border-border bg-surface">
              <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3 text-sm font-semibold">
                <span className="flex items-center gap-2"><Icon className="size-4" style={{ color: c }} /> {g.group}</span>
                <span className="tabular-nums text-muted">{m0(g.total)}</span>
              </div>
              <div className="divide-y divide-border/60">
                {g.members.map((p) => (
                  <Row key={p.payee} p={p} monthKey={monthKey} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Row({ p, monthKey }: { p: PayeeRow; monthKey: string }) {
  const chans = Object.entries(p.channels).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground/90">{p.payee}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {chans.map(([ch, amt]) => (
            <span key={ch} className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: `${chColor(ch)}22`, color: chColor(ch) }}>
              <span className="size-1.5 rounded-full" style={{ backgroundColor: chColor(ch) }} />
              {ch} {chans.length > 1 && <span className="tabular-nums opacity-80">{m0(amt)}</span>}
            </span>
          ))}
          <span className="text-[10px] text-muted-2">· {p.count}×</span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{m0(p.total)}</div>
        <div className="text-[10px] tabular-nums text-muted-2">{m0(p.months[monthKey] ?? 0)} this mo.</div>
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
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6">
      <svg viewBox="0 0 120 120" className="size-36 shrink-0">
        {arcs}
        <text x={cx} y={cy - 2} textAnchor="middle" className="fill-foreground" style={{ fontSize: 17, fontWeight: 700 }}>{abbr(total)}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-muted" style={{ fontSize: 7, letterSpacing: 0.5 }}>PAID OUT</text>
      </svg>
      <div className="grid w-full gap-1.5">
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
