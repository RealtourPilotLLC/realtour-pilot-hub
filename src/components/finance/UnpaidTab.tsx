import Link from "next/link";
import { Receipt, FileText, ExternalLink, CreditCard, ListTodo, Building2, CalendarClock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NudgeActions } from "@/components/billing/NudgeActions";
import { RemoveFromAr } from "@/components/billing/RemoveFromAr";
import { RestoreToAr } from "@/components/billing/RestoreToAr";
import { RefreshUnpaid } from "@/components/billing/RefreshUnpaid";
import { getBillingRows, getClearedArRows, type BillingRow } from "@/lib/queries";
import { usd } from "@/lib/money";
import { etDate } from "@/lib/datetime";
import { FinanceTabs, type FinanceTab } from "./FinanceTabs";
import { aryeoListingUrl, aryeoOrderUrl } from "@/lib/aryeoUrl";

// Unpaid tab = the old Billing AR page (aging buckets + nudge actions). The
// owner's by default; a non-owner sees it only through a per-person `sales`
// grant (ADMIN's default page set has no "sales" since Sep 2). Runs its own
// getBillingRows() query — the other tabs never do. Amounts print with cents
// (audit G18), the same figure the reminder text quotes.
//
// MONEY IS NOT THE PAGE GRANT (Jordan, Oct 21 2026: "A page-access override
// never grants money"). Two flags since Oct 27 2026 (Jordan: "Admins can see
// prices of services and billing"):
//   · `amounts` = canSeePrices (OWNER, ADMIN): the outstanding and invoice
//     figures, subtotals, the invoice and payment links (both open pages that
//     print the balance) and the paid/removed notes. Without it the tab is a
//     read-only list of which delivered jobs are unpaid and how old they are.
//   · `actions` = canSeeMoney (OWNER): the chase, mark-paid, remove and
//     restore buttons, whose server actions are owner-only too.
const STATUS_TONE: Record<string, string> = {
  UNPAID: "bg-danger/10 text-danger",
  PARTIALLY_PAID: "bg-warning/10 text-warning",
  PARTIALLY_REFUNDED: "bg-warning/10 text-warning",
  REFUNDED: "bg-surface-2 text-muted",
};

// Aging buckets (by delivery date, else order date) — collections work oldest
// first, so 90+ renders at the top.
const BUCKETS = [
  { key: "90", label: "90+ days", min: 90, color: "text-danger", chip: "bg-danger/10 text-danger" },
  { key: "60", label: "60–89 days", min: 60, color: "text-danger", chip: "bg-danger/10 text-danger" },
  { key: "30", label: "30–59 days", min: 30, color: "text-warning", chip: "bg-warning/10 text-warning" },
  { key: "0", label: "Under 30 days", min: 0, color: "text-muted", chip: "bg-surface-2 text-muted" },
] as const;

function ageDays(r: BillingRow): number {
  const anchor = r.deliveredAt ?? r.orderedAt;
  if (!anchor) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(anchor).getTime()) / 86400000));
}

function BillingCard({ r, amounts, actions }: { r: BillingRow; amounts: boolean; actions: boolean }) {
  const tone = (r.paymentStatus && STATUS_TONE[r.paymentStatus]) || "bg-danger/10 text-danger";
  return (
    <div className="panel-shadow rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Left: job + what was delivered */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/projects/${r.id}`} className="font-semibold leading-snug hover:text-brand">{r.title}</Link>
            {r.paymentStatus && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
                {r.paymentStatus.replace(/_/g, " ").toLowerCase()}
              </span>
            )}
            {r.possiblyPaidQbo && (
              <span
                className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success"
                title="A QuickBooks payment from this customer on/after the order covers this balance — Aryeo's paid flag lags for QuickBooks-rail clients. Verify before chasing."
              >
                possibly paid — check QuickBooks
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            {r.clientName && <span className="inline-flex items-center gap-1"><Building2 className="size-3" /> {r.clientName}</span>}
            {r.deliveredAt && <span>Delivered {etDate(r.deliveredAt)}</span>}
            {r.orderedAt && <span className="text-muted-2">Ordered {etDate(r.orderedAt)}</span>}
          </div>
          {r.deliverables.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {r.deliverables.map((d) => (
                <span key={d} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{d}</span>
              ))}
            </div>
          )}
        </div>

        {/* Right: the amounts (owner and admin), otherwise how long it has been owed */}
        {amounts ? (
          <div className="text-right">
            <div className="text-[11px] text-muted-2">Outstanding</div>
            <div className="text-lg font-semibold text-warning">{usd(r.outstanding)}</div>
            {r.invoiceTotal != null && (
              <div className="text-[11px] text-muted-2">of {usd(r.invoiceTotal)} invoice</div>
            )}
          </div>
        ) : (
          <div className="text-right">
            <div className="text-[11px] text-muted-2">Unpaid for</div>
            <div className="text-lg font-semibold text-warning">{ageDays(r)} day{ageDays(r) === 1 ? "" : "s"}</div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs">
        {actions && <NudgeActions projectId={r.id} lastNudgedAt={r.lastNudgedAt} />}
        {actions && <RemoveFromAr projectId={r.id} />}
        <Link href={`/projects/${r.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
          <ListTodo className="size-3.5" /> {r.openTasks} open {r.openTasks === 1 ? "task" : "tasks"}
        </Link>
        {amounts && r.invoiceUrl && (
          <a href={r.invoiceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
            <FileText className="size-3.5" /> Invoice
          </a>
        )}
        {amounts && r.paymentUrl && (
          <a href={r.paymentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-action px-2.5 py-1.5 font-medium text-white hover:opacity-90">
            <CreditCard className="size-3.5" /> Payment link
          </a>
        )}
        {r.aryeoOrderId && (
          <a href={aryeoOrderUrl(r.aryeoOrderId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
            <ExternalLink className="size-3.5" /> Order
          </a>
        )}
        {r.aryeoListingId && (
          <a href={aryeoListingUrl(r.aryeoListingId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
            <ExternalLink className="size-3.5" /> Listing
          </a>
        )}
      </div>
    </div>
  );
}

export async function UnpaidTab({ show, amounts, actions }: { show: FinanceTab[]; amounts: boolean; actions: boolean }) {
  const [{ rows, totalOutstanding }, cleared] = await Promise.all([getBillingRows(), getClearedArRows()]);

  // Group into aging buckets (90+ first — chase the oldest money).
  const grouped = BUCKETS.map((b, i) => {
    const max = i === 0 ? Infinity : BUCKETS[i - 1].min;
    const items = rows.filter((r) => {
      const a = ageDays(r);
      return a >= b.min && a < max;
    });
    return { ...b, items, subtotal: items.reduce((s, r) => s + r.outstanding, 0) };
  });

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Unpaid" subtitle="Delivered Aryeo jobs that still owe — your outstanding accounts receivable." />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="unpaid" show={show} />
        {/* Outstanding total */}
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-border bg-surface p-5 panel-shadow">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
              <Receipt className="size-3.5" /> {amounts ? "Total outstanding" : "Unpaid jobs"}
            </div>
            <div className="mt-1 text-3xl font-semibold tracking-tight text-warning">{amounts ? usd(totalOutstanding) : rows.length}</div>
            {!amounts && <p className="mt-1 text-xs text-muted">Amounts and the chase buttons are Jordan&rsquo;s. This list shows which jobs are still owed and for how long.</p>}
            {amounts && !actions && <p className="mt-1 text-xs text-muted">Chasing a client and marking a job paid are Jordan&rsquo;s. This list shows what each job still owes and for how long.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-right text-sm text-muted">
            {/* Aging at a glance */}
            {grouped.filter((g) => g.items.length > 0 && g.key !== "0").map((g) => (
              <span key={g.key} className={`text-xs font-medium ${g.color}`}>
                {g.label}: {amounts ? usd(g.subtotal) : `${g.items.length} job${g.items.length === 1 ? "" : "s"}`}
              </span>
            ))}
            <span>
              <span className="font-semibold text-foreground">{rows.length}</span> delivered {rows.length === 1 ? "job" : "jobs"} unpaid
            </span>
            <RefreshUnpaid />
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted">
            <Receipt className="mx-auto mb-2 size-6 text-muted-2" /> Nothing outstanding — every delivered job is paid. 🎉
          </div>
        ) : (
          grouped.map((g) =>
            g.items.length === 0 ? null : (
              <section key={g.key} className="space-y-3">
                <div className="flex items-center gap-2 px-1 pt-1">
                  <h2 className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${g.color}`}>
                    <CalendarClock className="size-3.5" /> {g.label}
                  </h2>
                  <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${g.chip}`}>
                    {amounts ? `${g.items.length} · ${usd(g.subtotal)}` : g.items.length}
                  </span>
                </div>
                {g.items.map((r) => (
                  <BillingCard key={r.id} r={r} amounts={amounts} actions={actions} />
                ))}
              </section>
            ),
          )
        )}

      {/* Rows no longer counted as owed — marked paid, or removed as junk.
          Collapsed but never invisible, and both are undoable (review HIGH).
          Inside the page container now, so it lines up with the rest. */}
      {cleared.length > 0 && (
        <details className="rounded-2xl border border-border bg-surface">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-muted hover:text-foreground">
            Cleared from AR · {cleared.length}
            <span className="ml-2 text-xs text-muted-2">
              {amounts ? `${usd(cleared.reduce((n, r) => n + r.outstanding, 0))} no longer counted as owed` : "no longer counted as owed"}
            </span>
          </summary>
          <div className="space-y-2 border-t border-border p-3">
            {cleared.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    r.kind === "paid" ? "bg-success/15 text-success" : "bg-surface-2 text-muted-2"
                  }`}
                >
                  {r.kind === "paid" ? "PAID" : "REMOVED"}
                </span>
                {/* Phone layout (Jordan, Oct 28 2026): the client and amount wrap under the job instead of squeezing it. */}
                <Link href={`/projects/${r.id}`} className="min-w-0 flex-1 basis-48 truncate text-sm font-medium hover:text-brand">
                  {r.title}
                </Link>
                <span className="ml-auto shrink-0 text-xs text-muted">{r.clientName}{amounts ? ` · ${usd(r.outstanding)}` : ""}</span>
                {/* The paid/removed note is free text and often quotes the money. */}
                {amounts && r.note && <span className="w-full text-[11px] text-muted-2">{r.note}</span>}
                {actions && <RestoreToAr projectId={r.id} />}
              </div>
            ))}
          </div>
        </details>
      )}
      </div>
    </div>
  );
}
