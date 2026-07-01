import { Plug, ShieldCheck, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ProviderCard, type ConnState } from "@/components/connections/ProviderCard";
import { PROVIDERS, SEGMENTS } from "@/lib/integrations/registry";
import { getAllConnections } from "@/lib/integrations/connections";
import { dropboxAuthorizeUrl, dropboxConfigured } from "@/lib/integrations/dropbox";
import { googleAuthorizeUrl, googleConfigured } from "@/lib/integrations/google";
import { frameioConfigured } from "@/lib/integrations/frameio";
import { webhookErrorCount } from "@/lib/webhookRetry";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const connections = await getAllConnections();
  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  const webhookErrors = await webhookErrorCount();

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
