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
  Send,
  Sparkles,
  Clapperboard,
  CheckCircle2,
  AlertCircle,
  Circle,
  ExternalLink,
  RefreshCw,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import type { ProviderDef } from "@/lib/integrations/registry";
import { etDateTime } from "@/lib/datetime";
import Link from "next/link";
import {
  connectAryeo,
  connectApiKey,
  connectDropbox,
  connectFrameioSecret,
  syncAryeoNow,
  syncAryeoProductsNow,
  enableOpenPhoneRealtime,
  syncOpenPhoneContactsNow,
  syncDropboxFoldersNow,
  syncGmailNow,
  recheckStatusesNow,
  disconnectProvider,
  type ActionResult,
} from "@/app/connections/actions";

const ICONS: Record<string, LucideIcon> = {
  Camera, CreditCard, Calculator, Folder, Mail, Phone, MessageSquare, Users, MessageCircle, Send, Sparkles, Clapperboard,
};

export type ConnState = {
  status: string;
  accountLabel: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export function ProviderCard({
  provider,
  conn,
  deployed,
  dropboxAuthorizeUrl,
  googleAuthorizeUrl,
  frameioReady,
}: {
  provider: ProviderDef;
  conn: ConnState | null;
  deployed: boolean;
  dropboxAuthorizeUrl?: string;
  googleAuthorizeUrl?: string;
  frameioReady?: boolean;
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
          style={{ backgroundColor: `${provider.color}1a`, color: provider.color }}
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
        ) : provider.id === "frameio" ? (
          <FrameioActions connected={connected} ready={!!frameioReady} deployed={deployed} />
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

// Frame.io uses Adobe IMS OAuth (Connect → Adobe consent → callback stores the
// refresh token). The connect link hits our /api/frameio/connect route.
function FrameioActions({ connected, ready, deployed }: { connected: boolean; ready: boolean; deployed: boolean }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);

  if (connected) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => startTransition(async () => setMsg(await disconnectProvider("frameio")))}
          disabled={pending}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : "Disconnect"}
        </button>
        {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
      </div>
    );
  }
  if (!deployed) {
    return (
      <button disabled title="Deploy first, then connect" className="w-full cursor-not-allowed rounded-lg border bg-surface px-3 py-2 text-sm font-medium opacity-60">
        Connect Frame.io (after deploy)
      </button>
    );
  }
  // Step 1: paste the Adobe Client Secret (encrypted). Step 2: the Connect button.
  if (!ready) return <FrameioSecretForm />;
  return (
    <a
      href="/api/frameio/connect"
      className="block w-full rounded-lg bg-brand px-3 py-2 text-center text-sm font-medium text-brand-fg hover:opacity-90"
    >
      Connect Frame.io
    </a>
  );
}

function FrameioSecretForm() {
  const [state, action, pending] = useActionState(connectFrameioSecret, null);
  return (
    <form action={action} className="space-y-2 rounded-xl border bg-surface-2 p-3">
      <label className="text-xs font-medium text-foreground/80">Adobe Client Secret</label>
      <input
        name="secret"
        type="password"
        autoComplete="off"
        placeholder="Paste the Client Secret from Adobe"
        className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
      />
      <p className="text-[11px] text-muted">
        In the Adobe Developer Console → Project 1 → <strong>OAuth Web App</strong> → click{" "}
        <strong>Retrieve client secret</strong> → copy → paste here. Encrypted before it&apos;s stored.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
      >
        {pending && <Loader2 className="size-4 animate-spin" />}
        Save secret
      </button>
      {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
    </form>
  );
}

// Generic connect/disconnect for any ready API-key provider (OpenPhone, …).
function GenericApiKeyActions({
  provider,
  connected,
  onExpand,
  expanded,
}: {
  provider: ProviderDef;
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
              className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : "Enable real-time"}
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
