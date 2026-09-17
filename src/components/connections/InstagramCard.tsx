"use client";

import { Suspense, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Share2, CheckCircle2, Circle, AlertCircle, Loader2, PowerOff, ExternalLink, ShieldOff } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import {
  saveMetaApp,
  clearMetaApp,
  beginInstagramConnect,
  completeInstagramConnect,
  disconnectInstagramAccount,
  type IntegrationActionResult,
} from "@/app/connections/integrationActions";

// ---------------------------------------------------------------------------
// Instagram publishing (spec §12), Sep 16 2026. Until a Meta app exists this
// card is a requirements list — no connect control, no fake OAuth button —
// because nothing behind it could work. Once the App ID + Secret are saved and
// verified, the real Facebook Login flow appears: choose the client, connect,
// come back with ?code&state, and the account is recorded. Publishing itself
// is a separate switch that stays OFF; the card says so.
// ---------------------------------------------------------------------------

export type InstagramRequirement = { key: string; label: string; detail: string };

export type InstagramAccountState = {
  id: string;
  clientName: string;
  handle: string | null;
  displayName: string | null;
  status: string;
  connectedAt: string;
  tokenExpiresAt: string | null;
  lastError: string | null;
  openJobs: number;
};

export type InstagramCardProps = {
  configured: boolean;
  /** Where the app credentials came from; null when not configured. The app id is not a secret. */
  appId: string | null;
  credentialSource: "connection" | "env" | null;
  requirements: InstagramRequirement[];
  automation: { enabled: boolean; missing: boolean };
  accounts: InstagramAccountState[];
  enrollments: Array<{ id: string; clientName: string }>;
  redirectUri: string;
  deployed: boolean;
};

export function InstagramCard(props: InstagramCardProps) {
  const anyConnected = props.accounts.some((a) => a.status === "CONNECTED");
  return (
    <div className="rounded-2xl border bg-surface p-4" data-card="instagram">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: "#e1306c1a", color: "#c2185b" }}>
          <Share2 className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Instagram publishing</span>
            {anyConnected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                <CheckCircle2 className="size-3" /> Account connected
              </span>
            ) : props.configured ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                <Circle className="size-3" /> App ready — no account yet
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                <ShieldOff className="size-3" /> Not connected — needs a Meta app
              </span>
            )}
          </div>
          <p className="text-xs text-muted">Posts an approved cut with its caption straight to a client&apos;s Instagram (spec §12, a separate phase)</p>
        </div>
      </div>

      {/* The switch, separately and loudly. */}
      <div className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${props.automation.enabled ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>
        <PowerOff className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {props.automation.enabled
            ? "Publishing is switched ON — approved posts go out on the next pass."
            : "Publishing is switched OFF. Connecting an account here does not post anything; every post also needs an explicit approval, and the switch must be on."}
        </span>
      </div>

      {!props.configured ? (
        <NotConfigured requirements={props.requirements} redirectUri={props.redirectUri} />
      ) : (
        <Configured {...props} />
      )}

      <a
        href="https://developers.facebook.com/docs/instagram-platform/content-publishing/"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-xs text-muted-2 hover:text-foreground"
      >
        <ExternalLink className="size-3" /> Meta docs — content publishing
      </a>
    </div>
  );
}

// What is needed, verbatim from the adapter's REQUIREMENTS, plus the one form
// that can change this state: the Meta App ID + Secret. There is deliberately
// no "Connect Instagram" control here — a button that opened a login dialog
// for an app that does not exist would be a broken promise, not a feature.
function NotConfigured({ requirements, redirectUri }: { requirements: InstagramRequirement[]; redirectUri: string }) {
  const [state, action, pending] = useActionState(saveMetaApp, null);
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 space-y-3">
      <div>
        <p className="text-xs font-medium text-foreground/80">Nothing can be connected yet. What is needed, in order:</p>
        <ol className="mt-1.5 space-y-1.5 pl-1" data-requirements>
          {requirements.map((r, i) => (
            <li key={r.key} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-muted">{i + 1}</span>
              <span>
                <span className="font-medium">{r.label}</span>
                <span className="block text-muted">{r.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="text-[11px] text-muted">
        When the Meta app exists, add <span className="font-mono">{redirectUri}</span> to its <strong>Valid OAuth Redirect URIs</strong> and paste the credentials below. Everything else on this card unlocks from that.
      </p>
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2">
          I have a Meta App ID + Secret
        </button>
      ) : (
        <form action={action} className="space-y-2 rounded-xl border bg-surface-2 p-3">
          <label className="text-xs font-medium text-foreground/80">Meta App ID</label>
          <input name="appId" type="text" autoComplete="off" inputMode="numeric" placeholder="e.g. 1234567890123456" className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          <label className="text-xs font-medium text-foreground/80">Meta App Secret</label>
          <input name="appSecret" type="password" autoComplete="off" placeholder="Paste the App Secret" className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          <p className="text-[11px] text-muted">
            Checked by asking Meta for an app token — touches no account, posts nothing. A pair Meta rejects is not saved. The secret is encrypted before it is stored and never shown again.
          </p>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
              {pending && <Loader2 className="size-4 animate-spin" />}
              Test &amp; save
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface">
              Cancel
            </button>
          </div>
          {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
        </form>
      )}
    </div>
  );
}

function Configured(props: InstagramCardProps) {
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<IntegrationActionResult | null>(null);
  const [enrollmentId, setEnrollmentId] = useState(props.enrollments[0]?.id ?? "");

  return (
    <div className="mt-3 space-y-3">
      <p className="text-[11px] text-muted">
        Meta app {props.appId ?? "configured"} ({props.credentialSource === "env" ? "from the deployment's environment" : "saved on this card"}). Redirect URI registered with Meta must be <span className="font-mono">{props.redirectUri}</span>.
      </p>

      {/* The callback lands on /connections?code&state; finish it here, once. */}
      <Suspense fallback={null}>
        <FinishConnect onResult={setMsg} />
      </Suspense>

      {props.accounts.length > 0 && (
        <ul className="space-y-1.5" data-accounts>
          {props.accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border px-2 py-1.5 text-xs">
              {a.status === "CONNECTED" ? <CheckCircle2 className="size-3 shrink-0 text-success" /> : <Circle className="size-3 shrink-0 text-muted-2" />}
              <span className="font-medium">{a.handle ? `@${a.handle}` : a.displayName ?? "Instagram account"}</span>
              <span className="text-muted">· {a.clientName}</span>
              <span className="text-muted">· {a.status === "CONNECTED" ? `connected ${etDateTime(a.connectedAt)}` : a.status.toLowerCase()}</span>
              {a.tokenExpiresAt && a.status === "CONNECTED" && <span className="text-muted">· token to {etDateTime(a.tokenExpiresAt)}</span>}
              {a.openJobs > 0 && <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">{a.openJobs} queued</span>}
              {a.lastError && (
                <span className="inline-flex items-center gap-1 text-danger">
                  <AlertCircle className="size-3" /> {a.lastError}
                </span>
              )}
              {a.status === "CONNECTED" && (
                <span className="ml-auto flex gap-2">
                  <button
                    onClick={() => startTransition(async () => setMsg(await disconnectInstagramAccount(a.id, true)))}
                    disabled={busy}
                    className="text-[11px] font-medium text-muted hover:text-danger disabled:opacity-60"
                    title="Drops the stored token, cancels every queued post on this account, and revokes the grant at Meta."
                  >
                    Disconnect
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* THE REAL CONNECT FLOW. Only rendered when configured() is true. */}
      {props.deployed ? (
        <div className="space-y-2 rounded-xl border bg-surface-2 p-3">
          <label className="text-xs font-medium text-foreground/80">Connect an Instagram account for</label>
          <select value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40">
            {props.enrollments.length === 0 && <option value="">No active program clients</option>}
            {props.enrollments.map((e) => (
              <option key={e.id} value={e.id}>{e.clientName}</option>
            ))}
          </select>
          <p className="text-[11px] text-muted">
            Opens Facebook Login. The person signing in must admin the Facebook Page the client&apos;s Instagram is linked to. Every Instagram Business/Creator account that login can publish to is recorded under the client chosen here.
          </p>
          <button
            onClick={() =>
              startTransition(async () => {
                const r = await beginInstagramConnect(enrollmentId);
                if (r.ok) window.location.assign(r.url);
                else setMsg({ ok: false, message: r.message });
              })
            }
            disabled={busy || !enrollmentId}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Connect Instagram"}
          </button>
        </div>
      ) : (
        <button disabled title="Facebook Login needs the app deployed to a public URL first" className="w-full cursor-not-allowed rounded-lg border bg-surface px-3 py-2 text-sm font-medium opacity-60">
          Connect Instagram (after deploy)
        </button>
      )}

      <button
        onClick={() => startTransition(async () => setMsg(await clearMetaApp()))}
        disabled={busy}
        className="text-[11px] font-medium text-muted hover:text-danger disabled:opacity-60"
      >
        Remove Meta app credentials
      </button>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}

// Reads ?code&state off the URL exactly once, finishes the exchange, and
// cleans the URL so a refresh cannot replay the (already spent) code.
function FinishConnect({ onResult }: { onResult: (r: IntegrationActionResult) => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const ran = useRef(false);
  const code = params.get("code");
  const state = params.get("state");
  useEffect(() => {
    if (!code || !state || ran.current) return;
    ran.current = true;
    (async () => {
      onResult({ ok: true, message: "Finishing the Instagram connection…" });
      const r = await completeInstagramConnect(code, state);
      onResult(r);
      router.replace("/connections");
    })();
  }, [code, state, onResult, router]);
  return null;
}
