import Link from "next/link";
import { Plug, ShieldCheck, ShieldOff, AlertTriangle, CheckCircle2, Landmark, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { ProviderCard, type ConnState } from "@/components/connections/ProviderCard";
import { PROVIDERS, SEGMENTS } from "@/lib/integrations/registry";
import { getAllConnections, getSecret } from "@/lib/integrations/connections";
import { dropboxAuthorizeUrl, dropboxConfigured } from "@/lib/integrations/dropbox";
import { googleAuthorizeUrl, googleConfigured, gmailSendHealth } from "@/lib/integrations/google";
import { slackBotScopes } from "@/lib/integrations/slack";
import { webhookHealthByProvider, webhookLaneHealth, unresolvedWebhookFailures, webhookErrorCount } from "@/lib/webhookRetry";
import { SyncHealth, type CronJobHealth } from "@/components/connections/SyncHealth";
import { WebhookHealthStrip } from "@/components/connections/WebhookHealthStrip";
import { AryeoCutover, type CutoverState } from "@/components/connections/AryeoCutover";
import { TopazLane, type TopazLaneJob, type TopazLaneStats } from "@/components/connections/TopazLane";
import { topazDashboard, topazJobRows } from "@/lib/topazJobs";
import { TranscriptionCard } from "@/components/connections/TranscriptionCard";
import { InstagramCard } from "@/components/connections/InstagramCard";
import { transcriptionCardData } from "@/lib/cutTranscripts";
import { instagramCardData } from "@/lib/publishing";
import { aryeoEndpointUrl, aryeoSupportMessage, ARYEO_EVENTS, RECOMMENDED_TOKEN_HEADER } from "@/lib/webhookArming";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// A read that leaves this machine gets a hard ceiling: null rather than a page
// that hangs on somebody else's API. Declared out here, not inline, because the
// timer handle is assigned inside a callback and a `let` written during render
// is exactly what the immutability lint (rightly) refuses.
function capped<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(
    () => clearTimeout(timer), // no stray timer once the real answer is in
  );
}


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
        let timedOut: string[] = [];
        let slowest: string | null = null;
        try {
          const s = r.summary ? (JSON.parse(r.summary) as { skipped?: string[]; timedOut?: string[]; ms?: Record<string, number> }) : null;
          if (Array.isArray(s?.skipped)) skipped = s.skipped;
          if (Array.isArray(s?.timedOut)) timedOut = s.timedOut;
          // Per-step timings are checkpointed after every step (lib/cron), so
          // even a hard-killed run says which step was the hog.
          const ms = s?.ms && typeof s.ms === "object" ? Object.entries(s.ms) : [];
          if (ms.length) {
            const [name, t] = ms.reduce((a, b) => (b[1] > a[1] ? b : a));
            slowest = `${name} ${Math.round(t / 1000)}s`;
          }
        } catch { /* unreadable summary */ }
        entry.runs.push({
          id: r.id,
          at: r.startedAt.toISOString(),
          // No finishedAt = still running or hard-killed mid-run: unknown, shown grey.
          ok: r.finishedAt ? r.ok : null,
          error: r.error,
          skipped,
          timedOut,
          slowest,
        });
      }
      byJob.set(r.job, entry);
    }
    return { crons: [...byJob.values()].sort((a, b) => a.job.localeCompare(b.job)), ready: true };
  } catch {
    return { crons: [], ready: false };
  }
}

// How many events each receiver has actually waved through UNVERIFIED, from the
// marker the receivers stamp on every unsigned acceptance. A number makes the
// exposure concrete: "anyone can post here" reads as theory until you see the
// count of things that already arrived unchecked. Best-effort — this page must
// render even if the query fails.
async function unsignedAcceptedByProvider(days = 7): Promise<Map<string, number>> {
  try {
    const rows = await prisma.webhookEvent.groupBy({
      by: ["provider"],
      where: { createdAt: { gt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }, error: { startsWith: "UNSIGNED" } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.provider, r._count._all]));
  } catch {
    return new Map();
  }
}

// Every outcome of the mailbox connect round trip (/api/google/connect → Google
// → /api/google/callback) comes back here as ?gmail=…. Without somewhere to say
// so, all five outcomes render a page identical to the one the owner left, so a
// failed connect is indistinguishable from a button that did nothing — and the
// most likely failure is the most innocent one: the anti-forgery cookie outliving
// its window while he picks between info@, hello@ and a personal account on
// Google's screen. Each line has to say what to DO, not just what happened.
const GMAIL_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: {
    ok: true,
    text: "Mailbox connected. It starts feeding comms and the morning brief on the next 5-minute sync.",
  },
  state: {
    ok: false,
    text: "That attempt expired before it came back from Google — press “Connect Gmail” again and finish picking the account.",
  },
  denied: {
    ok: false,
    text: "Only an owner or admin can attach a mailbox, and not while previewing another user. Leave “view as” and try again.",
  },
  config: {
    ok: false,
    text: "Google isn’t configured on this deployment (client ID/secret missing), so the consent screen can’t open. Nothing was changed.",
  },
  error: {
    ok: false,
    text: "Google refused the connection, or returned no refresh token. Remove this app under your Google account’s third-party access, then press “Connect Gmail” again.",
  },
};

// A card whose data read failed. Says so, rather than an all-clear it never checked.
function CardUnavailable({ name }: { name: string }) {
  return (
    <div className="rounded-2xl border bg-surface p-4 text-sm">
      <p className="font-semibold">{name}</p>
      <p className="mt-1 text-xs text-warning">Couldn&apos;t read this card&apos;s state just now — reload to try again.</p>
    </div>
  );
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string }>;
}) {
  // Middleware gates /connections as owner-only, but its allow-decision trusts a
  // session claim that can be days stale — the pages are the fresh-data
  // authority (see requirePageAccess). This screen shows every integration's
  // wiring, so it re-checks on each click.
  await requirePageAccess("connections");
  const { gmail } = await searchParams;
  const gmailResult = gmail ? GMAIL_RESULT[gmail] : undefined;
  const connections = await getAllConnections();
  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  const [
    // RTP-28 (Sep 16): per-lane delivery health. Best-effort — a screen that
    // 500s tells the office nothing about a dead webhook — but a FAILED read
    // lands on null, not [], so the strip can say "I couldn't look" instead of
    // rendering an all-clear it never checked (RTP-28 review, Sep 16).
    webhookLanes,
    webhookFailures,
    webhookUnresolvedTotal,
    webhookHealth,
    { crons, ready: cronLogReady },
    gmailSend,
    reconcile,
    unsignedAccepted,
    openphoneWebhookSecret,
    aryeoWebhookSecret,
    slackScopes,
    topaz,
    topazOpen,
    topazHistory,
    transcription,
    instagram,
  ] = await Promise.all([
    webhookLaneHealth().catch(() => null),
    unresolvedWebhookFailures().catch(() => null),
    webhookErrorCount().catch(() => null),
    webhookHealthByProvider().catch(() => []),
    cronHealth(),
    // Live per-mailbox send-scope probe (finding #41: "connected" hid a token
    // that could read but not send). Capped so a slow Google can't hold the
    // whole page hostage — null = unknown, the card simply omits the chips.
    Promise.race([
      gmailSendHealth().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]),
    // The full order reconcile's cursor — proves the daily safety net completes.
    import("@/lib/integrations/aryeo")
      .then(({ readReconcileCursor }) => readReconcileCursor())
      .then((c) => ({ lastCompletedAt: c.lastCompletedAt, inProgressPage: c.startedAt ? c.page : null, startedAt: c.startedAt }))
      .catch(() => null),
    unsignedAcceptedByProvider(),
    // Resolve both signing secrets through the SAME call the receivers make.
    // See webhookSigned below for why a row check isn't good enough. The catch
    // is only for a DB blip (getSecret already swallows decrypt failures) so one
    // hiccup can't 500 the page — and it lands on "unsigned", the loud side.
    getSecret("openphone_webhook").catch(() => null),
    getSecret("aryeo_webhook").catch(() => null),
    // The Slack bot token's REAL scopes (Sep 15), read off auth.test — so the
    // pending re-install click knows what to tick: People's "Find on Slack"
    // needs users:read + users:read.email, which today's install lacks.
    // Capped like the Gmail probe; null = unknown, the card omits the line.
    byProvider.get("slack")?.status === "CONNECTED"
      ? (() => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return Promise.race([
            slackBotScopes().catch(() => null),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 4000); }),
          ]).finally(() => clearTimeout(timer)); // no stray 4s timer once Slack has answered
        })()
      : Promise.resolve(null),
    // The 1080p pass. Reading it asks Topaz for the credit balance (free — it
    // starts nothing), so it gets the same treatment as the Gmail and Slack
    // probes: a hard cap, and null rather than a page that hangs on somebody
    // else's API. The panel says "couldn't read it" instead of showing zeroes.
    capped(topazDashboard().catch(() => null), 6000),
    // The jobs themselves are a plain database read — fast, and worth showing
    // even on the tick where the balance couldn't be reached. Two reads, not
    // one: a video parked by a spending limit can legitimately wait days, and a
    // straight "last 12" would push it off the list behind newer finished ones
    // — leaving the panel saying 3 are waiting with none of them on screen.
    // Anything live or failed is always listed; the rest is the recent history.
    topazJobRows({ states: ["queued", "estimated", "uploading", "processing", "saving", "failed"], limit: 20 }).catch(() => []),
    topazJobRows({ limit: 12 }).catch(() => []),
    // The two content-program cards (Sep 16): speech-to-text keys (§9) and
    // Instagram publishing (§12). Both are plain database reads plus a
    // no-network configured() check — nothing here can reach a provider.
    // null = the read failed; the card slot then says so instead of 500ing.
    transcriptionCardData().catch(() => null),
    instagramCardData().catch(() => null),
  ]);

  // Dates out, ISO strings in: the card is a client component, and the house
  // rule is that every date crosses that line already formatted for ET.
  const topazStats: TopazLaneStats | null = topaz
    ? {
        connected: topaz.connected,
        enabled: topaz.enabled,
        balance: topaz.balance,
        balanceError: topaz.balanceError,
        today: topaz.today,
        month: topaz.month,
        inFlight: topaz.inFlight,
        concurrencyCap: topaz.concurrencyCap,
        waitingOnKyle: topaz.waitingOnKyle,
        recentFailures: topaz.recentFailures,
        minBalanceCredits: topaz.settings.minBalanceCredits,
        aryeoNote: topaz.aryeoNote,
      }
    : null;
  // Live and failed first — "what is happening right now" is the question this
  // panel exists to answer — then the recent history, each job only once.
  const topazSeen = new Set(topazOpen.map((j) => j.id));
  const topazJobs = [...topazOpen, ...topazHistory.filter((j) => !topazSeen.has(j.id))].slice(0, 16);
  const topazRows: TopazLaneJob[] = topazJobs.map((j) => ({
    id: j.id,
    projectId: j.projectId,
    street: j.street,
    fileName: j.fileName,
    state: j.state,
    // Already a finished sentence for a non-technical reader, failure reason
    // and all — rendered as written, never re-composed.
    says: j.says,
    estimateCredits: j.estimateCredits,
    creditsCharged: j.creditsCharged,
    sourceLabel: j.sourceLabel,
    outputLabel: j.outputLabel,
    durationSec: j.durationSec,
    finalPath: j.finalPath,
    deliveredAt: j.deliveredAt ? j.deliveredAt.toISOString() : null,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  }));

  // Per-receiver webhook security. A receiver is "signed" once a secret exists
  // for it: the OpenPhone shared token (stored by "Enable real-time" under the
  // "openphone_webhook" provider row) and the Aryeo HMAC secret (saved on this
  // page under "aryeo_webhook", with the legacy plaintext column still honoured).
  // Until then the receiver accepts anything posted to its URL — which stopped
  // being unguessable when the app moved to hub.realtourpilot.com.
  //
  // Derived from getSecret(), NOT from "a ciphertext row exists". The receivers
  // decide with getSecret(), which DECRYPTS and returns null on any failure — so
  // if APP_SECRET is ever missing or rotated on a deploy, the stored blobs stop
  // opening and both receivers silently fall back to accepting unsigned posts.
  // A row check would leave this page showing green through exactly that: a
  // safety light that can be wrong in the unsafe direction is worse than none.
  // Stored-but-undecryptable therefore reads as UNSIGNED here, which is what the
  // receivers are actually doing.
  //
  // And for Aryeo, a readable secret is STILL not enough (Sep 16): between
  // saving a secret and Aryeo actually holding it, the receiver is deliberately
  // accepting unverified posts, and this banner would otherwise go green over a
  // door that is still open. "Signed" here means what it says — posts are being
  // checked — which is only true once enforcement is armed.
  const aryeoLane = webhookLanes?.find((l) => l.provider === "aryeo") ?? null;
  const webhookSigned: Record<string, boolean> = {
    openphone: Boolean(openphoneWebhookSecret),
    aryeo: Boolean(aryeoWebhookSecret || byProvider.get("aryeo")?.webhookSecret) && aryeoLane?.armMode === "armed",
  };
  const unsignedProviders = (["openphone", "aryeo"] as const).filter(
    (p) => byProvider.get(p)?.status === "CONNECTED" && !webhookSigned[p],
  );

  // Deployed = we have a public base URL configured (set on Vercel).
  const deployed = Boolean(process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL);

  // THE ARYEO CUTOVER CARD (Sep 16). Everything Jordan needs to get the live
  // feed back on, assembled here rather than in the component: the endpoint URL
  // comes from the one origin helper (the hub moved host on Sep 2 — a literal
  // here is how you re-register the old address), and the support message is
  // dated from the lane's real last delivery so it can't overstate or
  // understate the outage. A failed health read lands on a safe-but-honest
  // shape rather than hiding the card: the steps are still the steps.
  const aryeoSecretRow = byProvider.get("aryeo_webhook");
  const cutover: CutoverState = {
    endpointUrl: aryeoEndpointUrl(),
    supportMessage: aryeoSupportMessage({
      url: aryeoEndpointUrl(),
      silentSince: aryeoLane?.lastAcceptedAt ? new Date(aryeoLane.lastAcceptedAt) : null,
    }),
    events: ARYEO_EVENTS,
    armMode: aryeoLane?.armMode ?? null,
    // Falls back to the row check when lane health couldn't be read, so the
    // card never claims "no secret saved" just because a query failed.
    secretStored: aryeoLane?.secretStored ?? Boolean(aryeoSecretRow?.secretEncrypted),
    secretReadable: aryeoLane?.secretReadable ?? Boolean(aryeoWebhookSecret),
    secretSavedAt: aryeoSecretRow?.updatedAt ? aryeoSecretRow.updatedAt.toISOString() : null,
    lastDeliveredAt: aryeoLane?.lastAcceptedAt ?? null,
    quietHours: aryeoLane?.quietHours ?? null,
    quietThresholdHours: aryeoLane?.quietThresholdHours ?? 32,
    reconcileLastCompletedAt: reconcile?.lastCompletedAt ?? null,
    tokenHeader: RECOMMENDED_TOKEN_HEADER,
    // The no-secret rule, carried onto the card because the card has a button
    // that removes the secret. With one saved this setting does nothing; the
    // instant it is gone it decides everything. Lane health already reads it.
    enforcedWhenNoSecret: aryeoLane?.enforced ?? false,
  };

  // "N of M connected" is a ratio against the cards below, so it counts only
  // rows that ARE one of those cards. Webhook-signing secrets ride in their own
  // Connection rows ("openphone_webhook", "aryeo_webhook") and would otherwise
  // inflate the numerator past M.
  const providerIds = new Set(PROVIDERS.map((p) => p.id));
  const connectedCount =
    connections.filter((c) => providerIds.has(c.provider) && c.status === "CONNECTED").length +
    // The two Sep 16 cards have no Connection row under their own id:
    // speech-to-text keys live under transcription_openai/_deepgram, and an
    // Instagram connection is a ProgramPublishingAccount row.
    (transcription?.providers.some((p) => p.configured) ? 1 : 0) +
    (instagram?.accounts.some((a) => a.status === "CONNECTED") ? 1 : 0);

  // "Needs attention" is NOT a ratio — it's the alarm, so it covers every row
  // this screen is responsible for, minus only what's deliberately not a card:
  // the *_webhook signing-secret helpers, and rows left behind by retired
  // integrations (Frame.io, removed d012d91) that nobody can act on any more.
  // Scoping it to PROVIDERS instead would drop Plaid, which has no PROVIDERS
  // entry (its banks live on /connections/banks, linked below) yet marks the
  // "plaid" row ERROR when an item needs re-auth — the open PNC watch is exactly
  // that, and it would raise no count at all.
  const hiddenFromCount = (p: string) => p.endsWith("_webhook") || p.startsWith("frameio");
  const errorCount = connections.filter((c) => c.status === "ERROR" && !hiddenFromCount(c.provider)).length;

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
        {/* An open receiver is the loudest thing on this page, above everything
            else. A forged POST to the OpenPhone endpoint injects a message
            attributed to a named client — which mints tasks, can raise a
            revision, and is fed to the AI as that client's own words. */}
        {unsignedProviders.length > 0 && (
          <div className="flex items-start gap-3 rounded-2xl border-2 border-danger/60 bg-danger-soft p-4">
            <ShieldOff className="mt-0.5 size-5 shrink-0 text-danger" />
            <div className="text-sm">
              <p className="font-semibold text-danger">
                {unsignedProviders.length === 1 ? "1 webhook receiver is" : `${unsignedProviders.length} webhook receivers are`} accepting
                UNSIGNED posts — anyone who knows the URL can post to {unsignedProviders.length === 1 ? "it" : "them"}.
              </p>
              <ul className="mt-1 space-y-0.5 text-muted">
                {unsignedProviders.map((p) => {
                  const n = unsignedAccepted.get(p) ?? 0;
                  return (
                    <li key={p}>
                      <span className="font-medium text-foreground">{p}</span> — nothing is verified
                      {n > 0 && ` · ${n.toLocaleString()} event${n === 1 ? "" : "s"} accepted unchecked in the last 7 days`}.{" "}
                      {p === "openphone"
                        ? "Fix: press “Enable real-time” on the OpenPhone card to register a signing token."
                        : "Fix: work through “Aryeo real-time feed” below — make a secret, put it into Aryeo, then turn checking on."}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-muted">
                OpenPhone starts rejecting unsigned posts the moment its token is registered — the same press does both ends, so
                nothing can be refused before the other side has the token. Aryeo can&apos;t work that way: only Aryeo can put the
                secret into Aryeo, so the hub keeps accepting its posts until one arrives proving Aryeo has it, and only then starts
                refusing. Saving a secret and demanding one are separate steps there, on purpose — doing both at once on 8 September
                is what took the Aryeo feed off the air for eight days.
              </p>
            </div>
          </div>
        )}

        {/* The answer to the "Connect Gmail" click that just happened — kept
            below the unsigned-receiver banner (a standing security condition
            outranks a one-shot result) but above the fold either way. Sits at
            page level, not on the card, because the round trip lands here and
            the Gmail card is three sections down. */}
        {gmailResult && (
          <div
            className={`flex items-start gap-3 rounded-2xl border p-4 text-sm ${
              gmailResult.ok ? "border-success/40 bg-success-soft" : "border-warning/40 bg-warning/10"
            }`}
          >
            {gmailResult.ok ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
            ) : (
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            )}
            <p className="font-medium">{gmailResult.text}</p>
          </div>
        )}

        {/* The Aryeo cutover, above the health strip: the strip says WHAT is
            wrong, this card is the three steps that fix it. Only shown when
            Aryeo is actually connected — there is nothing to re-enable
            otherwise. */}
        {byProvider.get("aryeo")?.status === "CONNECTED" && <AryeoCutover state={cutover} />}

        {/* Webhook health (RTP-28, Sep 16): per provider, when something last
            ARRIVED, when something was last REFUSED and why, the plain sentence
            for the office, the per-provider verification switch, and every
            unresolved event with Retry/Dismiss. Above Sync health because a
            provider that stopped talking to us outranks how the crons ran.
            This replaced a standalone "N events failed in the last 7 days"
            banner whose 7-day window was itself hiding the oldest failures. */}
        <WebhookHealthStrip
          lanes={webhookLanes ?? []}
          failures={webhookFailures ?? []}
          unresolvedTotal={webhookUnresolvedTotal}
          degraded={webhookLanes === null || webhookFailures === null}
        />

        {/* Sync health: cron run history + webhook rejections + unsigned receivers. */}
        <SyncHealth crons={crons} webhooks={webhookHealth} unsignedProviders={unsignedProviders} cronLogReady={cronLogReady} reconcile={reconcile} />

        {/* The 1080p pass (Sep 16). It sits with the other lane-health panels
            rather than on the Topaz card below, because it answers an
            operational question — what is running, what did it cost, what
            failed — and not a wiring one. Aryeo's half of Jordan's ask has no
            API to build against at all, so the card says that in plain words
            where it is explained. */}
        <TopazLane stats={topazStats} jobs={topazRows} />
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
                  // The two Sep 16 cards carry their own state and actions.
                  if (provider.id === "transcription") {
                    return transcription ? (
                      <TranscriptionCard key={provider.id} {...transcription} />
                    ) : (
                      <CardUnavailable key={provider.id} name={provider.name} />
                    );
                  }
                  if (provider.id === "instagram") {
                    return instagram ? (
                      <InstagramCard key={provider.id} {...instagram} deployed={deployed} />
                    ) : (
                      <CardUnavailable key={provider.id} name={provider.name} />
                    );
                  }
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
                      slackScopes={provider.id === "slack" ? slackScopes : undefined}
                      // Only the two providers that POST into this app have a
                      // receiver to secure; every other card omits the chip.
                      webhookSecurity={
                        provider.id in webhookSigned
                          ? {
                              signed: webhookSigned[provider.id],
                              unsignedAccepted: unsignedAccepted.get(provider.id) ?? 0,
                              // Whether this receiver currently REFUSES what it
                              // can't verify (RTP-28). Default is each
                              // receiver's long-standing behaviour, so an
                              // untouched hub reads exactly as it did before.
                              enforced: webhookLanes?.find((l) => l.provider === provider.id)?.enforced ?? false,
                              armMode: webhookLanes?.find((l) => l.provider === provider.id)?.armMode ?? null,
                            }
                          : undefined
                      }
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
