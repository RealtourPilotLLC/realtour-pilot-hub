import Link from "next/link";
import { Receipt, FileText, ExternalLink, CreditCard, ListTodo, Building2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { getBillingRows } from "@/lib/queries";
import { formatMoney } from "@/lib/utils";
import { etDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  UNPAID: "bg-danger/10 text-danger",
  PARTIALLY_PAID: "bg-warning/10 text-warning",
  PARTIALLY_REFUNDED: "bg-warning/10 text-warning",
  REFUNDED: "bg-surface-2 text-muted",
};

export default async function BillingPage() {
  const { rows, totalOutstanding } = await getBillingRows();

  return (
    <div>
      <PageHeader title="Billing" subtitle="Delivered Aryeo jobs that still owe — your outstanding accounts receivable." />
      <div className="space-y-5 p-4 sm:p-6">
        {/* Outstanding total */}
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-border bg-surface p-5 panel-shadow">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
              <Receipt className="size-3.5" /> Total outstanding
            </div>
            <div className="mt-1 text-3xl font-semibold tracking-tight text-warning">{formatMoney(totalOutstanding)}</div>
          </div>
          <div className="text-right text-sm text-muted">
            <span className="font-semibold text-foreground">{rows.length}</span> delivered {rows.length === 1 ? "job" : "jobs"} unpaid
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted">
            <Receipt className="mx-auto mb-2 size-6 text-muted-2" /> Nothing outstanding — every delivered job is paid. 🎉
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const tone = (r.paymentStatus && STATUS_TONE[r.paymentStatus]) || "bg-danger/10 text-danger";
              return (
                <div key={r.id} className="panel-shadow rounded-2xl border border-border bg-surface p-4">
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

                    {/* Right: money */}
                    <div className="text-right">
                      <div className="text-[11px] text-muted-2">Outstanding</div>
                      <div className="text-lg font-semibold text-warning">{formatMoney(r.outstanding)}</div>
                      {r.invoiceTotal != null && (
                        <div className="text-[11px] text-muted-2">of {formatMoney(r.invoiceTotal)} invoice</div>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs">
                    <Link href={`/projects/${r.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
                      <ListTodo className="size-3.5" /> {r.openTasks} open {r.openTasks === 1 ? "task" : "tasks"}
                    </Link>
                    {r.invoiceUrl && (
                      <a href={r.invoiceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
                        <FileText className="size-3.5" /> Invoice
                      </a>
                    )}
                    {r.paymentUrl && (
                      <a href={r.paymentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 font-medium text-white hover:opacity-90">
                        <CreditCard className="size-3.5" /> Payment link
                      </a>
                    )}
                    {r.aryeoOrderId && (
                      <a href={`https://app.aryeo.com/orders/${r.aryeoOrderId}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
                        <ExternalLink className="size-3.5" /> Order
                      </a>
                    )}
                    {r.aryeoListingId && (
                      <a href={`https://app.aryeo.com/listings/${r.aryeoListingId}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-medium hover:bg-surface-2">
                        <ExternalLink className="size-3.5" /> Listing
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
