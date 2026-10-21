import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import type { RailFreshness } from "@/lib/financeCategories";
import { etMonthDay, etDayKey } from "@/lib/datetime";
import { usd0 } from "@/lib/money";

// ---------------------------------------------------------------------------
// HOW CURRENT THE BOOKS ARE (Oct 21 2026, Jordan: "keeping up with my books").
//
// One place that answers "can I trust these numbers today?": how far each
// money source actually reaches, and how much is still waiting for a call.
//   · QuickBooks: the newest entry it holds (what has been entered there) and
//     when the hub last pulled it (every morning, or the Sync button).
//   · The bank and card feed (Plaid): its newest posted line and last sync.
//   · Lines this year still in review: spend to tag, deposits to identify.
//   · The statement-imported accounts (Venmo, Tilt), which only move when a
//     fresh export is imported, so a stale one reads as quiet, not as zero.
// Owner-only, like every Finance tab but Unpaid.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const daysSince = (d: Date | null, now: number) => (d ? Math.floor((now - d.getTime()) / DAY) : null);
// The QuickBooks pull and the bank sync run every morning; two days quiet
// means a run has failed, not that it is early.
const PULL_STALE_DAYS = 2;
// A bank line posts a day or two after the purchase, and weekends post none.
const BANK_STALE_DAYS = 4;
// Same line as the owner's bell (financeCategories.nagStaleStatements).
const STATEMENT_STALE_DAYS = 21;

type Tone = "ok" | "warn";

export function BooksFreshness({ fresh, now = new Date() }: { fresh: RailFreshness; now?: Date }) {
  const t = now.getTime();
  const pulledAgo = daysSince(fresh.quickbooksPulledAt, t);
  const qbBroken = fresh.quickbooksStatus === "ERROR";
  const qbConnected = fresh.quickbooksStatus != null && fresh.quickbooksStatus !== "DISCONNECTED";
  const qbTone: Tone = !qbConnected || qbBroken || pulledAgo == null || pulledAgo >= PULL_STALE_DAYS ? "warn" : "ok";
  const bankAgo = daysSince(fresh.bank.newest, t);
  const bankTone: Tone = fresh.bank.erroredItems > 0 || bankAgo == null || bankAgo >= BANK_STALE_DAYS ? "warn" : "ok";
  const reviewTone: Tone = fresh.review.lines > 0 ? "warn" : "ok";
  const yearLabel = fresh.review.since.slice(0, 4);

  const rows: { key: string; label: string; value: string; note?: React.ReactNode; tone: Tone }[] = [
    {
      key: "qb",
      label: "QuickBooks",
      value: fresh.quickbooks ? `entries through ${etMonthDay(fresh.quickbooks)}` : "no entries yet",
      tone: qbTone,
      note: !qbConnected
        ? <>Not connected. <Link href="/connections" className="font-medium text-brand hover:underline">Connect QuickBooks</Link>.</>
        : qbBroken
          ? <>The last pull failed{fresh.quickbooksError ? `: ${fresh.quickbooksError.slice(0, 140)}` : ""}. <Link href="/connections" className="font-medium text-brand hover:underline">Reconnect or sync on Connections</Link>.</>
          : fresh.quickbooksPulledAt
            ? `Pulled ${etMonthDay(fresh.quickbooksPulledAt)}${pulledAgo != null && pulledAgo >= PULL_STALE_DAYS ? ` (${pulledAgo} days ago)` : ""}. It pulls every morning; entries reach it once they are added in QuickBooks.`
            : "Never pulled yet.",
    },
    {
      key: "bank",
      label: "Bank and card feed",
      value: fresh.bank.newest ? `through ${etMonthDay(fresh.bank.newest)}` : "no lines yet",
      tone: bankTone,
      note: fresh.bank.erroredItems > 0
        ? <>{fresh.bank.erroredItems} bank login{fresh.bank.erroredItems === 1 ? " needs" : "s need"} reconnecting. <Link href="/connections/banks" className="font-medium text-brand hover:underline">Open Banks</Link>.</>
        : fresh.bank.syncedAt
          ? `Synced ${etMonthDay(fresh.bank.syncedAt)}, and sorted into categories the same morning.`
          : undefined,
    },
    {
      key: "stripe",
      label: "Stripe",
      value: fresh.stripe ? `through ${etMonthDay(fresh.stripe)}` : "no payments yet",
      tone: "ok",
    },
    {
      key: "review",
      label: "Waiting for a call",
      value: fresh.review.lines > 0 ? `${fresh.review.lines.toLocaleString("en-US")} line${fresh.review.lines === 1 ? "" : "s"}` : "none",
      tone: reviewTone,
      note: fresh.review.lines > 0
        ? <>
            {[
              fresh.review.out > 0 ? `${usd0(fresh.review.out)} of ${yearLabel} spend to tag` : null,
              fresh.review.deposits > 0 ? `${fresh.review.deposits} deposit${fresh.review.deposits === 1 ? "" : "s"} (${usd0(fresh.review.in)}) to identify` : null,
            ].filter(Boolean).join(", ")}
            . <Link href="/sales?tab=spending" className="font-medium text-brand hover:underline">Tag them on Categories</Link>.
          </>
        : `Every ${yearLabel} line is categorized.`,
    },
    ...fresh.manual.map((m) => {
      const stale = m.daysBehind == null || m.daysBehind >= STATEMENT_STALE_DAYS;
      return {
        key: `stmt-${m.mask}`,
        label: m.label,
        value: m.newest ? `through ${etMonthDay(m.newest)}` : "never imported",
        tone: (stale ? "warn" : "ok") as Tone,
        note: stale
          ? `Statement import${m.newest ? `, ${m.daysBehind} days behind (since ${etDayKey(m.newest)})` : ""}. Nothing after that date is counted until a fresh export is imported.`
          : "Statement import.",
      };
    }),
  ];

  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
        <Clock3 className="size-3.5 text-brand" /> How current the books are
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start gap-2 py-2 text-xs">
            {r.tone === "warn"
              ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              : <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium text-foreground">{r.label}</span>
                <span className={`tabular-nums ${r.tone === "warn" ? "font-medium text-warning" : "text-muted"}`}>{r.value}</span>
              </div>
              {r.note && <p className="mt-0.5 leading-relaxed text-muted-2">{r.note}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
