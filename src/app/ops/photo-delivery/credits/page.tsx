import Link from "next/link";
import { redirect } from "next/navigation";
import { BellRing, Coins, ExternalLink, LineChart, ListOrdered, PieChart } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor, isCreativeLead, isOffice } from "@/lib/auth/access";
import { etDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { GlobalStrip } from "@/components/photoDelivery/GlobalStrip";
import { BalanceSparkline } from "@/components/photoDelivery/CreditsParts";
import { CheckBalanceButton, ThresholdsForm } from "@/components/photoDelivery/CreditsControls";
import { usd } from "@/components/photoDelivery/format";
import { loadCreditsPage, loadStrip, loadViewer } from "../data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/photo-delivery/credits: THE AUTOHDR CREDITS PAGE (docs/photo-delivery/
// 01 section 10.4). The live balance, 30 days of balance readings, spend by
// kind over 14 and 30 days (kinds that did not move are left out), the alert
// levels (where the alert state stands is folded away), and the ledger
// (newest first). Owner and admin; dollars and the
// threshold form are the owner's only. The hub never buys credits: top-ups
// happen in the AutoHDR web app.
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  BALANCE_SNAPSHOT: "Balance check",
  DOWNLOAD: "Download",
  TRANSFORM: "Fix (transform)",
  STYLE: "Style re-render",
  PRESET: "Preset",
  REFUND: "Refund",
  ADJUSTMENT: "Adjustment",
};

const LEVEL: Record<string, { label: string; cls: string }> = {
  ok: { label: "Healthy", cls: "bg-success-soft text-success ring-success/30" },
  warn: { label: "Running low", cls: "bg-warning-soft text-warning ring-warning/30" },
  critical: { label: "Critical", cls: "bg-danger-soft text-danger ring-danger/40" },
  unknown: { label: "Not read yet", cls: "bg-surface-2 text-muted ring-border" },
};

type SP = { checks?: string | string[]; limit?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function CreditsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePageAccess("photos");
  const viewer = await loadViewer();
  if (!viewer) redirect("/login?next=/ops/photo-delivery/credits");
  // Credits are the office's: the creative manager's view-only desk has no
  // Credits page and goes back to the queue (Oct 22 2026); anyone else home.
  if (!isOffice(viewer.role)) redirect(isCreativeLead(viewer.role) ? "/ops/photo-delivery" : homeFor(viewer.role));

  const sp = await searchParams;
  const showChecks = one(sp.checks) === "1";
  const limit = Math.max(100, Math.min(1000, Number(one(sp.limit)) || 100));
  const [strip, page] = await Promise.all([
    loadStrip(viewer),
    loadCreditsPage(viewer, { showChecks, limit }).catch((e) => {
      console.error("[photo-delivery] credits page failed", e);
      return null;
    }),
  ]);
  // Only the kinds that moved in the last 30 days (the 30 days include the 14).
  const spend = page ? page.spend.filter((r) => r.d14 !== 0 || r.d30 !== 0) : [];
  const href = (o: { checks?: boolean; limit?: number }) => {
    const q = new URLSearchParams();
    if (o.checks ?? showChecks) q.set("checks", "1");
    const l = o.limit ?? limit;
    if (l !== 100) q.set("limit", String(l));
    const s = q.toString();
    return `/ops/photo-delivery/credits${s ? `?${s}` : ""}`;
  };

  return (
    <div>
      <div className="border-b border-border px-4 py-2 sm:px-6">
        <BackLink href="/ops/photo-delivery" label="Photo Delivery" />
      </div>
      <PageHeader eyebrow="Photo Delivery" title="AutoHDR credits" subtitle="The live balance, what was spent and where, and the low-balance alerts. Times are Eastern." />
      <div className="mx-auto max-w-6xl space-y-5 p-4 pb-16 sm:p-6">
        <GlobalStrip strip={strip} current="credits" />
        {!page ? (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">The credits page could not be read. Refresh to try again.</p>
        ) : (
          <>
            <Section icon={Coins} title="Balance">
              <div className="flex flex-wrap items-start gap-6">
                <div>
                  <p className="text-3xl font-semibold tabular-nums">{page.credit.balance != null ? page.credit.balance.toLocaleString("en-US") : "Unknown"}</p>
                  <p className="text-sm text-muted">credits{page.credit.usdPerCredit != null && page.credit.balance != null ? ` · about ${usd(page.credit.balance * page.credit.usdPerCredit)}` : ""}</p>
                  <span className={cn("mt-2 inline-flex rounded-full px-2.5 py-0.5 text-ui-status font-semibold ring-1 ring-inset", LEVEL[page.credit.connected ? page.credit.level : "unknown"].cls)}>{page.credit.connected ? LEVEL[page.credit.level].label : "API not connected"}</span>
                </div>
                <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted">Runway</dt>
                    <dd>{page.credit.runwayDays != null ? `${page.credit.runwayDays < 1 ? "Under a day" : `About ${page.credit.runwayDays} day${page.credit.runwayDays === 1 ? "" : "s"}`} at ${page.credit.perDay} a day (14-day average)` : "No recent spend to project from"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">AutoHDR plan</dt>
                    <dd data-plan-credits={page.credit.planCreditsPerMonth ?? ""}>{page.credit.planCreditsPerMonth != null ? `${page.credit.planCreditsPerMonth.toLocaleString("en-US")} credits a month` : "Not recorded yet"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Committed</dt>
                    <dd>{page.credit.committed.toLocaleString("en-US")} credits for approved fixes not yet run</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Last read</dt>
                    <dd>{page.credit.checkedAt ? etDateTime(page.credit.checkedAt) : "Never"} (read every 15 minutes)</dd>
                  </div>
                  {page.credit.lastError && (
                    <div>
                      <dt className="text-muted">Last error</dt>
                      <dd className="text-warning">{page.credit.lastError}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <div className="mt-4 flex flex-wrap items-start gap-4 border-t border-border pt-4">
                <CheckBalanceButton connected={page.credit.connected} />
                <div className="text-sm">
                  <a href={page.billingUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 font-semibold hover:bg-surface-2">
                    Open AutoHDR billing <ExternalLink aria-hidden className="size-4" />
                  </a>
                  <p className="mt-1 text-[13px] text-muted">Top up in AutoHDR: the hub never buys credits.</p>
                </div>
                {!page.credit.connected && (
                  <p className="text-[13px] text-muted">
                    The AutoHDR API is not connected.{" "}
                    {viewer.isOwner ? (
                      <Link href="/connections" className="font-medium text-brand hover:underline">Connect it on Connections</Link>
                    ) : (
                      "Jordan connects it on Connections."
                    )}
                  </p>
                )}
              </div>
            </Section>

            <Section icon={LineChart} title="Last 30 days">
              <BalanceSparkline points={page.snapshots} warn={page.credit.warn} critical={page.credit.critical} />
            </Section>

            <Section icon={PieChart} title="Spend by kind" flush>
              {spend.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">Nothing spent or added in the last 30 days.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[30rem] text-sm">
                    <caption className="sr-only">Credits spent and added by kind, last 14 and 30 days</caption>
                    <thead className="text-left text-[12px] uppercase tracking-wide text-muted">
                      <tr>
                        <th scope="col" className="px-5 py-2 font-medium">Kind</th>
                        <th scope="col" className="px-5 py-2 text-right font-medium">Last 14 days</th>
                        <th scope="col" className="px-5 py-2 text-right font-medium">Last 30 days</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {spend.map((r) => (
                        <tr key={r.key}>
                          <th scope="row" className="px-5 py-2 text-left font-normal">{r.label}</th>
                          {[r.d14, r.d30].map((n, i) => (
                            <td key={i} className={cn("px-5 py-2 text-right tabular-nums", n === 0 && "text-muted")}>
                              {n === 0 ? "None" : n < 0 ? `${(-n).toLocaleString("en-US")} spent` : `${n.toLocaleString("en-US")} added`}
                              {page.credit.usdPerCredit != null && n !== 0 ? <span className="block text-[12px] text-muted">{usd(Math.abs(n) * page.credit.usdPerCredit)}</span> : null}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="px-5 pb-3 pt-1 text-[12px] text-muted">&ldquo;Used outside the pipeline&rdquo; is the difference between two balance readings that the hub&rsquo;s own spends don&rsquo;t explain: AutoHDR&rsquo;s Dropbox watcher editing uploads, the web app, or Aryeo&rsquo;s integration.</p>
            </Section>

            <Section icon={BellRing} title="Alerts">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-1.5 text-sm">
                  <dl className="space-y-1.5">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Warning below</dt>
                      <dd className="tabular-nums">{page.credit.warn}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Critical below</dt>
                      <dd className="tabular-nums">{page.credit.critical}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Re-arms after a refill of</dt>
                      <dd className="tabular-nums">{page.credit.resetBuffer} above a level</dd>
                    </div>
                  </dl>
                  <p className="pt-1 text-[12px] text-muted">Alerts go to Jordan and Kyle by Slack or text and in the hub bell, once per low spell.</p>
                  <details>
                    <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-medium text-muted hover:text-foreground">Where the alerts stand</summary>
                    <dl className="space-y-1.5">
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Warning alert</dt>
                        <dd>{page.alert.below250Sent ? "Sent for this low spell" : "Armed"}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Critical alert</dt>
                        <dd>{page.alert.below100Sent ? "Sent for this low spell" : "Armed"}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted">Last evaluated</dt>
                        <dd>{page.alert.lastCheckedAt ? `${etDateTime(page.alert.lastCheckedAt)}${page.alert.lastBalance != null ? ` at ${page.alert.lastBalance}` : ""}` : "Never"}</dd>
                      </div>
                    </dl>
                  </details>
                </div>
                {viewer.isOwner ? (
                  <ThresholdsForm initial={{ warn: page.credit.warn, critical: page.credit.critical, resetBuffer: page.credit.resetBuffer, usdPerCredit: page.credit.usdPerCredit ?? 0.5, planCreditsPerMonth: page.credit.planCreditsPerMonth }} />
                ) : (
                  <p className="text-sm text-muted">Jordan sets these levels.</p>
                )}
              </div>
            </Section>

            <Section
              icon={ListOrdered}
              title="Ledger"
              count={page.ledger.length}
              flush
              action={
                <Link href={href({ checks: !showChecks, limit: 100 })} className="text-[13px] font-medium text-muted hover:text-foreground">
                  {showChecks ? "Hide balance checks" : "Show balance checks"}
                </Link>
              }
            >
              {page.ledger.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">Nothing recorded yet. Entries appear once the AutoHDR API is connected and the balance is read.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <caption className="sr-only">AutoHDR credit ledger, newest first</caption>
                    <thead className="text-left text-[12px] uppercase tracking-wide text-muted">
                      <tr>
                        <th scope="col" className="px-5 py-2 font-medium">When</th>
                        <th scope="col" className="px-3 py-2 font-medium">Kind</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Credits</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Balance after</th>
                        <th scope="col" className="px-3 py-2 font-medium">Job</th>
                        <th scope="col" className="px-5 py-2 font-medium">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {page.ledger.map((r) => (
                        <tr key={r.id} className="align-top">
                          <td className="whitespace-nowrap px-5 py-2">{etDateTime(r.at)}</td>
                          <td className="px-3 py-2">{KIND_LABEL[r.kind] ?? r.kind}</td>
                          <td className={cn("px-3 py-2 text-right tabular-nums", r.credits < 0 ? "text-warning" : r.credits > 0 ? "text-success" : "text-muted")}>{r.credits > 0 ? `+${r.credits}` : r.credits}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.balanceAfter ?? ""}</td>
                          <td className="px-3 py-2">{r.jobId ? <Link href={`/ops/photo-delivery/${r.jobId}`} className="text-brand hover:underline">{r.jobLabel ?? "Job"}</Link> : <span className="text-muted">None</span>}</td>
                          <td className="px-5 py-2 text-muted">{r.note ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {page.ledgerHasMore && (
                <div className="border-t border-border px-5 py-3">
                  <Link href={href({ limit: Math.min(1000, limit + 200) })} className="inline-flex min-h-11 items-center rounded-lg border border-border-strong px-3 text-sm font-medium hover:bg-surface-2">
                    Show more
                  </Link>
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
