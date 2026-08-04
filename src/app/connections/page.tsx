import Link from "next/link";
import { Plug, ShieldCheck, AlertTriangle, Landmark, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ProviderCard, type ConnState } from "@/components/connections/ProviderCard";
import { PROVIDERS, SEGMENTS } from "@/lib/integrations/registry";
import { getAllConnections } from "@/lib/integrations/connections";
import { dropboxAuthorizeUrl, dropboxConfigured } from "@/lib/integrations/dropbox";
import { googleAuthorizeUrl, googleConfigured, gmailSendHealth } from "@/lib/integrations/google";
import { frameioConfigured } from "@/lib/integrations/frameio";
import { webhookErrorCount, webhookHealthByProvider } from "@/lib/webhookRetry";
import { SyncHealth, type CronJobHealth } from "@/components/connections/SyncHealth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Last 5 cron runs per job, for the Sync health panel. Best-effort: the CronRun
// table is additive and may not be pushed to this database yet — the page must
// render either way.
async function cronHealth(): Promise<{ crons: CronJobHealth[]; ready: boolean }> {
  try {
    const rows = await prisma.cronRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 60,
      select: { id: true, job: true, startedAt: true, finishedAt: true, ok: true, error: true, summary: true },
    });
    const byJob = new Map<string, CronJobHealth>();
    for (const r of rows) {
      const entry = byJob.get(r.job) ?? { job: r.job, runs: [] };
      if (entry.runs.length < 5) {
        let skipped: string[] = [];
        try {
          const s = r.summary ? (JSON.parse(r.summary) as { skipped?: string[] }) : null;
          if (Array.isArray(s?.skipped)) skipped = s.skipped;
        } catch { /* unreadable summary */ }
        entry.runs.push({
          id: r.id,
          at: r.startedAt.toISOString(),
          // No finishedAt = still running or hard-killed mid-run: unknown, shown grey.
          ok: r.finishedAt ? r.ok : null,
          error: r.error,
          skipped,
        });
      }
      byJob.set(r.job, entry);
    }
    return { crons: [...byJob.values()].sort((a, b) => a.job.localeCompare(b.job)), ready: true };
  } catch {
    return { crons: [], ready: false };
  }
}

export default async function ConnectionsPage() {
  const connections = await getAllConnections();
  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  const [webhookErrors, webhookHealth, { crons, ready: cronLogReady }, gmailSend] = await Promise.all([
    webhookErrorCount(),
    webhookHealthByProvider().catch(() => []),
    cronHealth(),
    // Live per-mailbox send-scope probe (finding #41: "connected" hid a token
    // that could read but not send). Capped so a slow Google can't hold the
    // whole page hostage — null = unknown, the card simply omits the chips.
    Promise.race([
      gmailSendHealth().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]),
  ]);

  // Receivers currently accepting UNSIGNED posts: connected providers whose
  // signing token/secret was never stored (the checks pass everything through
  // until a token exists — by design, but it should be visible, not silent).
  const unsignedProviders: string[] = [];
  if (byProvider.get("openphone")?.status === "CONNECTED" && !byProvider.get("openphone_webhook")?.secretEncrypted) {
    unsignedProviders.push("openphone");
  }
  if (byProvider.get("frameio")?.status === "CONNECTED" && !byProvider.get("frameio_webhook")?.secretEncrypted) {
    unsignedProviders.push("frameio");
  }
  if (byProvider.get("aryeo")?.status === "CONNECTED" && !byProvider.get("aryeo")?.webhookSecret) {
    unsignedProviders.push("aryeo");
  }

  // Deployed = we have a public base URL configured (set on Vercel).
  const deployed = Boolean(process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL);

  const connectedCount = connections.filter((c) => c.status === "CONNECTED").length;
  const errorCount = connections.filter((c) => c.status === "ERROR").length;
  const frameioReady = await frameioConfigured();

  return (
    <div>
      <PageHeader
        title="Connections"
        subtitle={
          `${connectedCount} of ${PROVIDERS.length} services connected` +
          (errorCount > 0 ? ` · ${errorCount} need${errorCount === 1 ? "s" : ""} attention` : "")
        }
      />
      <div className="space-y-6 p-6">
        {/* Sync health: cron run history + webhook rejections + unsigned receivers. */}
        <SyncHealth crons={crons} webhooks={webhookHealth} unsignedProviders={unsignedProviders} cronLogReady={cronLogReady} />
        {webhookErrors > 0 && (
          <div className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-medium">{webhookErrors} incoming event{webhookErrors === 1 ? "" : "s"} failed to process in the last 7 days.</p>
              <p className="text-muted">
                These are auto-retried once on the hourly sync. Any that still show here couldn’t be
                recovered — a delivered/paid/inbound event may not have registered. Usually a transient
                blip; if the number keeps climbing, a provider connection likely needs attention.
              </p>
            </div>
          </div>
        )}
        <div className="flex items-start gap-3 rounded-2xl border bg-brand-soft/40 p-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" />
          <div className="text-sm">
            <p className="font-medium">Your keys are encrypted and stay server-side.</p>
            <p className="text-muted">
              API keys are encrypted at rest and never sent back to the browser. Aryeo is wired and
              ready to connect now. OAuth services (Gmail, Slack, HubSpot, Facebook, Dropbox,
              QuickBooks) light up once the app is deployed to a public URL.
            </p>
          </div>
        </div>

        {/* Plaid — bank & card connections live on their own screen (Link flow). */}
        <Link
          href="/connections/banks"
          className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 hover:border-brand/50 hover:bg-surface-2"
        >
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl" style={{ backgroundColor: "#00b8951a", color: "#00b895" }}>
              <Landmark className="size-5" />
            </span>
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                Bank &amp; card accounts <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand">Plaid</span>
                {byProvider.get("plaid")?.status === "CONNECTED" && (
                  <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">Connected</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted">
                Link your personal account (…0942), Venmo &amp; Capital One card — read-only — to complete the money picture the audit found missing.
              </p>
            </div>
          </div>
          <ChevronRight className="size-5 shrink-0 text-muted-2" />
        </Link>

        {SEGMENTS.map((segment) => {
          const items = PROVIDERS.filter((p) => p.segment === segment);
          if (items.length === 0) return null;
          return (
            <section key={segment}>
              <div className="mb-3 flex items-center gap-2">
                <Plug className="size-4 text-muted" />
                <h2 className="text-sm font-semibold">{segment}</h2>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {items.map((provider) => {
                  const c = byProvider.get(provider.id);
                  const conn: ConnState | null = c
                    ? {
                        status: c.status,
                        accountLabel: c.accountLabel,
                        lastSyncedAt: c.lastSyncedAt ? c.lastSyncedAt.toISOString() : null,
                        lastError: c.lastError,
                      }
                    : null;
                  return (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      conn={conn}
                      deployed={deployed}
                      dropboxAuthorizeUrl={
                        provider.id === "dropbox" && dropboxConfigured() ? dropboxAuthorizeUrl() : undefined
                      }
                      googleAuthorizeUrl={
                        provider.id === "gmail" && googleConfigured() ? googleAuthorizeUrl() : undefined
                      }
                      gmailSendHealth={provider.id === "gmail" ? gmailSend : undefined}
                      frameioReady={provider.id === "frameio" ? frameioReady : undefined}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
