"use client";

import { useActionState, useState, useTransition } from "react";
import {
  Camera,
  CreditCard,
  Calculator,
  Folder,
  Mail,
  Phone,
  MessageSquare,
  Users,
  MessageCircle,
  Music,
  Send,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Circle,
  ExternalLink,
  RefreshCw,
  Loader2,
  ShieldCheck,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";
import type { ProviderDef } from "@/lib/integrations/registry";
import { SLACK_SCOPE_NEEDS } from "@/lib/slackScopes";
import { ink } from "@/components/ui/Badge";
import { etDateTime } from "@/lib/datetime";
import Link from "next/link";
import {
  connectAryeo,
  connectApiKey,
  connectDropbox,
  syncAryeoNow,
  syncAryeoProductsNow,
  enableOpenPhoneRealtime,
  syncOpenPhoneContactsNow,
  syncDropboxFoldersNow,
  syncGmailNow,
  syncQuickBooksNow,
  recheckStatusesNow,
  disconnectProvider,
  saveAryeoWebhookSecret,
  clearAryeoWebhookSecret,
  testEpidemicSoundNow,
  type ActionResult,
} from "@/app/connections/actions";

const ICONS: Record<string, LucideIcon> = {
  Camera, CreditCard, Calculator, Folder, Mail, Phone, MessageSquare, Users, MessageCircle, Send, Sparkles, Music,
};

export type ConnState = {
  status: string;
  accountLabel: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

// Per-mailbox Gmail scope probe result (null canSend = the check itself failed,
// so the card says nothing rather than something wrong).
export type GmailSendHealth = { email: string; canSend: boolean | null };

// Whether THIS provider's inbound receiver verifies what it's sent, plus how
// many events it has already accepted unverified (last 7 days). Only the two
// providers that POST into the hub (OpenPhone, Aryeo) pass this.
// `enforced` (RTP-28, Sep 16) is the office setting: with no secret AND
// enforcement on, the receiver isn't open — it's refusing everything, which is
// a different emergency and must not read as "anyone can post here".
export type WebhookSecurity = {
  signed: boolean;
  unsignedAccepted: number;
  enforced: boolean;
  /** Aryeo only: where a signing cutover has got to. "watching" means a secret
   *  is saved but Aryeo hasn't proved it has it, so posts are still accepted —
   *  a deliberate, temporary state that must not be painted as a breach. */
  armMode?: "watching" | "armed" | "holding" | null;
};

// The Slack bot token's granted scopes (auth.test, read-only). Null = the
// probe failed; the card then says nothing rather than something wrong.
export type SlackScopeHealth = { scopes: string[]; team: string | null };

export function ProviderCard({
  provider,
  conn,
  deployed,
  dropboxAuthorizeUrl,
  googleAuthorizeUrl,
  gmailSendHealth,
  webhookSecurity,
  slackScopes,
}: {
  provider: ProviderDef;
  conn: ConnState | null;
  deployed: boolean;
  dropboxAuthorizeUrl?: string;
  googleAuthorizeUrl?: string;
  gmailSendHealth?: GmailSendHealth[] | null;
  webhookSecurity?: WebhookSecurity;
  slackScopes?: SlackScopeHealth | null;
}) {
  const Icon = ICONS[provider.icon] ?? Circle;
  const connected = conn?.status === "CONNECTED";
  const errored = conn?.status === "ERROR";
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-2xl border bg-surface p-4">
      <div className="flex items-start gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${provider.color}1a`, color: ink(provider.color) }}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{provider.name}</span>
            <StatusPill connected={connected} errored={errored} ready={provider.ready} />
          </div>
          <p className="text-xs text-muted">{provider.blurb}</p>
        </div>
      </div>

      {/* Status / meta line */}
      {connected && (
        <div className="mt-2 text-xs text-muted">
          {conn?.accountLabel && <span>{conn.accountLabel} · </span>}
          {conn?.lastSyncedAt
            ? `Last sync ${etDateTime(conn.lastSyncedAt)}`
            : "Not synced yet"}
        </div>
      )}
      {errored && conn?.lastError && (
        <div className="mt-2 rounded-lg bg-danger-soft px-2 py-1 text-xs text-danger">{conn.lastError}</div>
      )}

      {/* Webhook security, at a glance. "Connected" said nothing about whether
          this provider's receiver checks WHO is posting to it — and both ran
          open for 30 days without one rejection. Loud when it's open. */}
      {webhookSecurity && connected && (
        <div className="mt-2">
          {webhookSecurity.signed ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
              <ShieldCheck className="size-3" /> Webhook signed — verified
            </span>
          ) : webhookSecurity.armMode === "watching" ? (
            /* Mid-cutover: a secret is saved, Aryeo hasn't used it yet, and the
               receiver is accepting posts ON PURPOSE. Amber and specific — the
               red "anyone can post here" below is true but reads as a fault,
               and this state is a step in fixing one. */
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning">
              <ShieldOff className="size-3" /> Secret saved — waiting for Aryeo to start signing
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
              <ShieldOff className="size-3" />
              {webhookSecurity.enforced ? (
                <>Webhook has no secret — every post is being REFUSED. Save the secret, or switch this receiver back in Webhook health.</>
              ) : (
                <>
                  Webhook UNSIGNED — anyone can post here
                  {webhookSecurity.unsignedAccepted > 0 &&
                    ` · ${webhookSecurity.unsignedAccepted.toLocaleString()} accepted unchecked in 7 days`}
                </>
              )}
            </span>
          )}
        </div>
      )}

      {/* Gmail: what each mailbox's token can actually DO. "Connected" hid a
          token that could read but not send (finding #41) — surface the send
          scope per mailbox so a silent-failure state is visible at a glance. */}
      {provider.id === "gmail" && connected && !!gmailSendHealth?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {gmailSendHealth.map((m) =>
            m.canSend === null ? null : m.canSend ? (
              <span
                key={m.email}
                className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success"
              >
                <CheckCircle2 className="size-3" /> {m.email} · read ✓ · send ✓
              </span>
            ) : (
              <span
                key={m.email}
                className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning"
              >
                <AlertCircle className="size-3" /> {m.email} · read ✓ · send ✗ — reconnect to grant sending
              </span>
            ),
          )}
        </div>
      )}

      {/* Slack: what the bot token can actually DO, against what the hub
          needs (Sep 15). "Connected" hid a token that can post but cannot
          look anyone up — People's "Find on Slack" needs users:read +
          users:read.email — so the pending re-install click is informed. */}
      {provider.id === "slack" && connected && slackScopes && (() => {
        const have = new Set(slackScopes.scopes);
        const missing = SLACK_SCOPE_NEEDS.filter((n) => n.required && !have.has(n.scope)).map((n) => n.scope);
        return (
          <div className="mt-2 space-y-1.5" data-slack-scopes>
            <div className="flex flex-wrap gap-1.5">
              {SLACK_SCOPE_NEEDS.map((n) =>
                have.has(n.scope) ? (
                  <span key={n.scope} title={n.why} className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                    <CheckCircle2 className="size-3" /> {n.scope} ✓
                  </span>
                ) : n.required ? (
                  <span key={n.scope} title={n.why} className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning">
                    <AlertCircle className="size-3" /> {n.scope} — needed: {n.why}
                  </span>
                ) : (
                  <span key={n.scope} title={n.why} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                    <Circle className="size-3" /> {n.scope} — optional
                  </span>
                ),
              )}
            </div>
            {missing.length > 0 && (
              <p className="text-[11px] text-warning">
                Re-install the Ops Hub Slack app with <span className="font-mono">{missing.join(", ")}</span> added (Slack app → OAuth &amp;
                Permissions → Bot Token Scopes → Reinstall to Workspace), then paste the bot token again here if Slack issued a new one.
              </p>
            )}
            <p className="text-[11px] text-muted-2">
              Token scopes now: {slackScopes.scopes.length ? slackScopes.scopes.join(", ") : "none reported"}
            </p>
          </div>
        );
      })()}

      {/* Capabilities */}
      <ul className="mt-3 space-y-1">
        {provider.capabilities.map((c) => (
          <li key={c} className="flex items-start gap-1.5 text-xs text-foreground/75">
            <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-success" /> {c}
          </li>
        ))}
      </ul>

      {/* Action area */}
      <div className="mt-4">
        {provider.id === "aryeo" ? (
          <AryeoActions connected={connected} onExpand={() => setExpanded((e) => !e)} expanded={expanded} />
        ) : provider.id === "gmail" ? (
          <GmailActions connected={connected} authorizeUrl={googleAuthorizeUrl} deployed={deployed} />
        ) : provider.id === "quickbooks" ? (
          <QuickBooksActions connected={connected} deployed={deployed} />
        ) : provider.id === "dropbox" && provider.ready ? (
          <GenericApiKeyActions
            provider={provider}
            connected={connected}
            onExpand={() => setExpanded((e) => !e)}
            expanded={expanded}
          />
        ) : provider.authType === "apikey" && provider.ready ? (
          <GenericApiKeyActions
            provider={provider}
            connected={connected}
            onExpand={() => setExpanded((e) => !e)}
            expanded={expanded}
            // OpenPhone's fix IS "Enable real-time" (it registers the hook and
            // stores the signing token) — promote it while the receiver is open,
            // otherwise it reads like an optional nicety next to Sync contacts.
            urgentRealtime={webhookSecurity ? !webhookSecurity.signed : false}
          />
        ) : provider.authType === "oauth" && !deployed ? (
          <button
            disabled
            title="OAuth services need the app deployed to a public URL first"
            className="w-full cursor-not-allowed rounded-lg border bg-surface px-3 py-2 text-sm font-medium opacity-60"
          >
            Connect (after deploy)
          </button>
        ) : (
          <button
            disabled
            title="Integration code lands next — framework is ready"
            className="w-full cursor-not-allowed rounded-lg border bg-surface px-3 py-2 text-sm font-medium opacity-60"
          >
            {provider.authType === "apikey" ? "Add API key (coming next)" : "Connect (coming next)"}
          </button>
        )}
      </div>

      {provider.docsUrl && (
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs text-muted-2 hover:text-foreground"
        >
          <ExternalLink className="size-3" /> API docs
        </a>
      )}

      {/* Aryeo's inbound receiver has no secret of its own until it's pasted
          here — the API key above doesn't sign anything coming IN. */}
      {provider.id === "aryeo" && connected && webhookSecurity && (
        <AryeoWebhookSecret signed={webhookSecurity.signed} />
      )}

      {provider.id === "aryeo" && expanded && <AryeoConnectForm />}
      {provider.id !== "aryeo" && provider.authType === "apikey" && provider.ready && expanded && (
        <GenericApiKeyForm provider={provider} />
      )}
      {provider.id === "dropbox" && expanded && !connected && (
        <DropboxConnectForm authorizeUrl={dropboxAuthorizeUrl} />
      )}
    </div>
  );
}

function DropboxConnectForm({ authorizeUrl }: { authorizeUrl?: string }) {
  const [state, action, pending] = useActionState(connectDropbox, null);
  return (
    <div className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3">
      <ol className="list-decimal space-y-1.5 pl-4 text-[11px] text-muted">
        <li>
          {authorizeUrl ? (
            <a href={authorizeUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand underline">
              Open Dropbox to authorize →
            </a>
          ) : (
            <span className="text-danger">Dropbox app key not configured.</span>
          )}{" "}
          and click <strong>Allow</strong>.
        </li>
        <li>Copy the authorization code Dropbox shows you.</li>
        <li>Paste it below.</li>
      </ol>
      <form action={action} className="space-y-2">
        <input
          name="code"
          type="text"
          autoComplete="off"
          placeholder="Paste authorization code"
          className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
        <button
          type="submit"
          disabled={pending}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Connect Dropbox
        </button>
      </form>
      {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
    </div>
  );
}

function StatusPill({ connected, errored, ready }: { connected: boolean; errored: boolean; ready: boolean }) {
  if (connected)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
        <CheckCircle2 className="size-3" /> Connected
      </span>
    );
  if (errored)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
        <AlertCircle className="size-3" /> Error
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
      <Circle className="size-3" /> {ready ? "Not connected" : "Ready to wire"}
    </span>
  );
}

function AryeoActions({
  connected,
  onExpand,
  expanded,
}: {
  connected: boolean;
  onExpand: () => void;
  expanded: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);

  if (!connected) {
    return (
      <button
        onClick={onExpand}
        className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90"
      >
        {expanded ? "Cancel" : "Connect Aryeo"}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={() => startTransition(async () => setMsg(await syncAryeoNow()))}
          disabled={pending}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Sync orders
        </button>
        <button
          onClick={() => startTransition(async () => setMsg(await syncAryeoProductsNow()))}
          disabled={pending}
          className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          Sync catalog
        </button>
        <button
          onClick={() => startTransition(async () => setMsg(await disconnectProvider("aryeo")))}
          disabled={pending}
          className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          Disconnect
        </button>
      </div>
      <button
        onClick={() => startTransition(async () => setMsg(await recheckStatusesNow()))}
        disabled={pending}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        title="Cross-check ordered deliverables against live Aryeo media + Dropbox to fix project statuses"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        Recheck statuses (cross-check media)
      </button>
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>
      )}
    </div>
  );
}

function AryeoConnectForm() {
  const [state, action, pending] = useActionState(connectAryeo, null);
  return (
    <form action={action} className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3">
      <label className="text-xs font-medium text-foreground/80">Aryeo API key</label>
      <input
        name="key"
        type="password"
        autoComplete="off"
        placeholder="Paste your Aryeo API key"
        className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
      />
      <p className="text-[11px] text-muted">
        In Aryeo: <strong>Group Settings → Developers → API Keys → Generate</strong>. The key is
        encrypted before it&apos;s stored and never shown again.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
      >
        {pending && <Loader2 className="size-4 animate-spin" />}
        Test &amp; connect
      </button>
      {state && (
        <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>
      )}
    </form>
  );
}

// Aryeo webhook signing. Same shape as the API-key forms (password field, the
// value is encrypted server-side and never read back), but for the secret that
// protects the INBOUND direction. Once saved, the receiver rejects anything
// whose `Signature` header doesn't match — including, if the secret is wrong,
// real Aryeo events; hence the plain-English warning and the Remove button, so
// Jordan can undo it himself instead of waiting for a deploy.
function AryeoWebhookSecret({ signed }: { signed: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(saveAryeoWebhookSecret, null);
  const [clearing, startClear] = useTransition();
  const [clearMsg, setClearMsg] = useState<ActionResult | null>(null);

  if (signed && !open) {
    return (
      <div className="mt-3 rounded-xl border bg-surface-2 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">Inbound webhooks are signature-verified.</span>
          <div className="flex gap-2">
            <button onClick={() => setOpen(true)} className="text-[11px] font-medium text-brand hover:underline">
              Replace secret
            </button>
            <button
              onClick={() => startClear(async () => setClearMsg(await clearAryeoWebhookSecret()))}
              disabled={clearing}
              className="text-[11px] font-medium text-muted hover:text-danger disabled:opacity-60"
              title="Delete the saved secret. This is NOT the way to stop real events bouncing — use “Stop checking” on the Aryeo real-time feed card for that, which keeps the secret."
            >
              Remove
            </button>
          </div>
        </div>
        {clearMsg && <p className={`mt-1 text-[11px] ${clearMsg.ok ? "text-success" : "text-danger"}`}>{clearMsg.message}</p>}
      </div>
    );
  }

  // NOT "secure this webhook — add signing secret", which is what this button
  // said. Saving a secret does not secure anything on its own: the hub keeps
  // accepting posts until Aryeo proves it has the secret, which is the whole
  // design and the whole lesson of 8 September. A button promising the door is
  // shut the moment a value is pasted is that same false equation in miniature.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 w-full rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm font-medium text-danger hover:opacity-90"
      >
        Nothing is checked here — paste a secret Aryeo already has
      </button>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3">
      <label className="text-xs font-medium text-foreground/80">Aryeo webhook signing secret</label>
      <input
        name="secret"
        type="password"
        autoComplete="off"
        placeholder="Paste the signing secret"
        className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
      />
      <p className="text-[11px] text-muted">
        Only for a secret Aryeo has ALREADY got. To set one up from scratch, use <strong>Aryeo real-time feed</strong> at the top of
        this page — it makes the secret for you and walks through putting it into Aryeo. Either way, saving is safe: nothing starts
        being refused until a post arrives that&apos;s genuinely signed with it. Encrypted before it&apos;s stored and never shown again.
      </p>
      <p className="text-[11px] text-warning">
        A secret saved on 8 Sep didn&apos;t match what Aryeo signs with: 36 real events bounced that morning and Aryeo stopped
        delivering for eight days — the hourly sync covered it, so nothing looked wrong. Saving no longer switches refusing on, which
        is the half of that fault the hub could fix. You can still check a value first with <strong>Test a secret</strong> in Webhook
        health above: it replays a candidate against a post Aryeo already sent, without calling Aryeo.
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Save this secret
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface">
          Cancel
        </button>
      </div>
      {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
    </form>
  );
}

// Gmail uses a Google OAuth redirect (Connect → authorize → callback).
function GmailActions({
  connected,
  authorizeUrl,
  deployed,
}: {
  connected: boolean;
  authorizeUrl?: string;
  deployed: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);

  if (!connected) {
    if (!authorizeUrl) {
      return (
        <button
          disabled
          title={deployed ? "Set GOOGLE_CLIENT_ID/SECRET to enable Gmail" : "Deploy first, then connect"}
          className="w-full cursor-not-allowed rounded-lg border bg-surface px-3 py-2 text-sm font-medium opacity-60"
        >
          Connect Gmail (needs Google app)
        </button>
      );
    }
    return (
      <a
        href={authorizeUrl}
        className="block w-full rounded-lg bg-brand px-3 py-2 text-center text-sm font-medium text-brand-fg hover:opacity-90"
      >
        Connect Gmail
      </a>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={() => startTransition(async () => setMsg(await syncGmailNow()))}
          disabled={pending}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Scan recent emails
        </button>
        <button
          onClick={() => startTransition(async () => setMsg(await disconnectProvider("gmail")))}
          disabled={pending}
          className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          Disconnect
        </button>
      </div>
      {authorizeUrl && (
        <a href={authorizeUrl} className="block text-center text-xs font-medium text-brand hover:underline">
          + Add another mailbox (hello@ / info@)
        </a>
      )}
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}

// QuickBooks uses Intuit OAuth. App credentials (QBO_CLIENT_ID/SECRET) live in
// env, so there's no secret form here — just Connect, then Sync. Jordan signs in
// on Intuit's own screen; we never handle his QuickBooks password.
function QuickBooksActions({ connected, deployed }: { connected: boolean; deployed: boolean }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);

  if (connected) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => startTransition(async () => setMsg(await syncQuickBooksNow()))}
          disabled={pending}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : "Sync the books"}
        </button>
        <button
          onClick={() => startTransition(async () => setMsg(await disconnectProvider("quickbooks")))}
          disabled={pending}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          Disconnect
        </button>
        {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
      </div>
    );
  }
  if (!deployed) {
    return (
      <button disabled title="Deploy first, then connect" className="w-full cursor-not-allowed rounded-lg border bg-surface px-3 py-2 text-sm font-medium opacity-60">
        Connect QuickBooks (after deploy)
      </button>
    );
  }
  return (
    <a
      href="/api/quickbooks/connect"
      className="block w-full rounded-lg bg-brand px-3 py-2 text-center text-sm font-medium text-brand-fg hover:opacity-90"
    >
      Connect QuickBooks
    </a>
  );
}

// Generic connect/disconnect for any ready API-key provider (OpenPhone, …).
function GenericApiKeyActions({
  provider,
  connected,
  onExpand,
  expanded,
  urgentRealtime = false,
}: {
  provider: ProviderDef;
  connected: boolean;
  onExpand: () => void;
  expanded: boolean;
  urgentRealtime?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);

  if (!connected) {
    return (
      <button
        onClick={onExpand}
        className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90"
      >
        {expanded ? "Cancel" : `Connect ${provider.name}`}
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {provider.id === "openphone" && (
          <>
            <Link
              href="/communications"
              className="flex flex-1 items-center justify-center rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90"
            >
              View communications
            </Link>
            <button
              onClick={() => startTransition(async () => setMsg(await enableOpenPhoneRealtime()))}
              disabled={pending}
              title={
                urgentRealtime
                  ? "Registers the webhook and stores a signing token — until then this receiver accepts anything posted to it"
                  : "Re-register the webhook (rotates the signing token)"
              }
              className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60 ${
                urgentRealtime
                  ? "border border-danger/40 bg-danger-soft text-danger hover:opacity-90"
                  : "border hover:bg-surface-2"
              }`}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : urgentRealtime ? "Enable real-time & sign webhooks" : "Enable real-time"}
            </button>
            <button
              onClick={() => startTransition(async () => setMsg(await syncOpenPhoneContactsNow()))}
              disabled={pending}
              className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : "Sync contacts"}
            </button>
          </>
        )}
        {provider.id === "dropbox" && (
          <button
            onClick={() => startTransition(async () => setMsg(await syncDropboxFoldersNow()))}
            disabled={pending}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : "Check folders → update status"}
          </button>
        )}
        {/* Epidemic Sound (Sep 15): the key works + what the agreement
            reaches — moods, collections, full search or curated only. */}
        {provider.id === "epidemic_sound" && (
          <button
            onClick={() => startTransition(async () => setMsg(await testEpidemicSoundNow()))}
            disabled={pending}
            title="Re-check the key and what the partner agreement reaches (moods, collections, catalogue search)"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : "Test connection"}
          </button>
        )}
        <button
          onClick={() => startTransition(async () => setMsg(await disconnectProvider(provider.id)))}
          disabled={pending}
          className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          Disconnect
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}

function GenericApiKeyForm({ provider }: { provider: ProviderDef }) {
  const [state, action, pending] = useActionState(connectApiKey, null);
  return (
    <form action={action} className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3">
      <input type="hidden" name="provider" value={provider.id} />
      <label className="text-xs font-medium text-foreground/80">{provider.keyLabel ?? "API key"}</label>
      <input
        name="key"
        type="password"
        autoComplete="off"
        placeholder={`Paste your ${provider.name} API key`}
        className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
      />
      {provider.keyHelp && <p className="text-[11px] text-muted">{provider.keyHelp}</p>}
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
      >
        {pending && <Loader2 className="size-4 animate-spin" />}
        Test &amp; connect
      </button>
      {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
    </form>
  );
}
