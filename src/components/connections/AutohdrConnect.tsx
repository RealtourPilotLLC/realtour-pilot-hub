"use client";

import { useActionState, useState, useTransition } from "react";
import { Loader2, ExternalLink, RefreshCw, PowerOff } from "lucide-react";
import { saveAutohdrCredentials, retestAutohdr, disconnectAutohdr, type AutohdrActionResult } from "@/app/connections/autohdrActions";

// The owner's half of "Set up the API on AutoHDR for me" (Oct 13 2026): paste
// the API client AutoHDR created, the hub tests it (sign in + read the balance,
// spends nothing) and stores the secret encrypted. Nobody else sees this form.
export function AutohdrConnectForm({ developerUrl }: { developerUrl: string }) {
  const [state, action, pending] = useActionState<AutohdrActionResult | null, FormData>(saveAutohdrCredentials, null);
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 space-y-2">
      <ol className="space-y-1 pl-1 text-xs text-muted">
        <li>
          <span className="font-medium text-foreground">1.</span> In AutoHDR, open Account settings, then Developer, and create an API client.{" "}
          <a href={developerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline">
            Open AutoHDR <ExternalLink className="size-3" />
          </a>
        </li>
        <li>
          <span className="font-medium text-foreground">2.</span> Copy the Client ID and the Client Secret (the secret is shown once) and paste both here.
        </li>
      </ol>
      {!open ? (
        <button onClick={() => setOpen(true)} className="min-h-11 w-full rounded-lg border border-border-strong px-3 text-sm font-medium hover:bg-surface-2">
          I have the AutoHDR Client ID and Secret
        </button>
      ) : (
        <form action={action} className="space-y-2 rounded-xl border bg-surface-2 p-3">
          <label className="block text-xs font-medium text-foreground/80" htmlFor="autohdr-client-id">Client ID</label>
          <input id="autohdr-client-id" name="clientId" type="text" autoComplete="off" spellCheck={false} className="min-h-11 w-full rounded-lg border border-border-strong bg-surface px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          <label className="block text-xs font-medium text-foreground/80" htmlFor="autohdr-client-secret">Client Secret</label>
          <input id="autohdr-client-secret" name="clientSecret" type="password" autoComplete="off" spellCheck={false} className="min-h-11 w-full rounded-lg border border-border-strong bg-surface px-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          <p className="text-xs text-muted">
            Checked by signing in and reading your credit balance. That spends nothing. A pair AutoHDR rejects is not saved. The secret is encrypted before it is stored and is never shown again.
          </p>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
              {pending && <Loader2 className="size-4 animate-spin" />}
              Test &amp; save
            </button>
            <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-lg border border-border-strong px-3 text-sm font-medium hover:bg-surface">
              Cancel
            </button>
          </div>
          {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
        </form>
      )}
    </div>
  );
}

export function AutohdrConnectedControls() {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<AutohdrActionResult | null>(null);
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={() => start(async () => setMsg(await retestAutohdr()))}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Check balance now
        </button>
        <button
          disabled={busy}
          onClick={() => {
            if (!confirm("Remove the AutoHDR API client from the hub? The hub stops sending shoots, fixing photos and reading the balance.")) return;
            start(async () => setMsg(await disconnectAutohdr()));
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm font-medium text-danger hover:bg-surface-2 disabled:opacity-60"
        >
          <PowerOff className="size-3.5" /> Disconnect
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}
