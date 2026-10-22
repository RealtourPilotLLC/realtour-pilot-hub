import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { PTO_TYPES, rangeLabel, type PtoBalance } from "@/lib/pto";
import { PtoForm, PtoRow } from "@/components/finance/PtoControls";

// ---------------------------------------------------------------------------
// PAID TIME OFF, ONE PERSON'S AGREEMENT YEAR (Oct 22 2026, lib/pto). The
// creative sees their own bank, days and the company holidays on My
// Performance ("self", read-only); Jordan sees the same card on Finance →
// Bonus with Add, Edit and Remove ("owner"). Days only: no pay amounts.
// ---------------------------------------------------------------------------

const typeLabel = (k: string) => PTO_TYPES.find((t) => t.key === k)?.label ?? k;
const dayNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
const holidayDate = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function PtoCard({ bal, viewer, todayKey }: { bal: PtoBalance; viewer: "self" | "owner"; todayKey: string }) {
  const types = PTO_TYPES.map((t) => ({ key: t.key, label: t.label }));
  const pct = Math.min(100, Math.round((bal.used / bal.bank) * 100));
  return (
    <div className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <CalendarDays className="size-3.5 text-brand" /> Paid time off{viewer === "owner" ? ` · ${bal.name}` : ""}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-2">Agreement year {bal.year.label}</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">
              {dayNum(bal.remaining)}
              <span className="text-sm font-medium text-muted-2"> of {bal.bank} days left</span>
            </div>
            <div className="text-[11px] text-muted-2">{dayNum(bal.used)} used{bal.over > 0 ? `, ${dayNum(bal.over)} over the paid bank` : ""}</div>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div className={cn("h-full rounded-full", bal.over > 0 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-brand")} style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      </div>

      {bal.entries.length === 0 ? (
        <p className="px-4 py-3 text-[11px] text-muted">No time off recorded in this agreement year.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {bal.entries.map((e) => {
            const body = (
              <div className="min-w-0">
                <div className="text-sm font-medium">{rangeLabel(e.startKey, e.endKey)}</div>
                <div className="text-[11px] text-muted">
                  {typeLabel(e.type)} · {dayNum(e.days)} day{e.days === 1 ? "" : "s"} from the bank
                  {e.fraction !== 1 ? ` (${e.fraction} of a day)` : ""}
                  {e.holidaysSkipped.length ? ` · ${e.holidaysSkipped.map((h) => h.name).join(", ")} not counted` : ""}
                </div>
                {e.note && <div className="text-[11px] text-muted-2">{e.note}</div>}
              </div>
            );
            return (
              <li key={e.id} className="px-4 py-2.5">
                {viewer === "owner" ? (
                  <PtoRow memberId={bal.memberId} types={types} initial={{ id: e.id, yearKey: bal.year.key, startKey: e.startKey, endKey: e.endKey, type: e.type, fraction: e.fraction, note: e.note }}>
                    {body}
                  </PtoRow>
                ) : body}
              </li>
            );
          })}
        </ul>
      )}

      {viewer === "owner" && (
        <details className="border-t border-border px-4 py-2">
          <summary className="flex min-h-9 cursor-pointer items-center text-xs font-semibold text-brand">Add time off for {bal.name.split(" ")[0]}</summary>
          <div className="pb-2 pt-1">
            <PtoForm memberId={bal.memberId} types={types} defaultDay={todayKey} />
          </div>
        </details>
      )}

      <div className="border-t border-border bg-surface-2/40 px-4 py-2.5">
        <div className="text-[11px] font-semibold text-muted">Company holidays (they do not use the bank)</div>
        <ul className="mt-1 grid gap-x-4 gap-y-0.5 text-[11px] text-muted sm:grid-cols-2">
          {bal.holidays.map((h) => (
            <li key={h.day}>
              {h.name}: {holidayDate(h.day)}
              {!h.serviceDay ? " (a weekend)" : ""}
            </li>
          ))}
        </ul>
      </div>
      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-2">
        {bal.bank} paid service days each agreement year (from Sep 25), one bank for vacation, personal, sick and family care, all available
        at once. Only Monday to Friday counts; a part day uses the matching part. Unused days do not carry over and are not paid out. Paid time
        off does not reduce regular pay.
      </p>
    </div>
  );
}
