"use client";

import { useActionState, useState, useTransition } from "react";
import { Loader2, RefreshCw, PowerOff } from "lucide-react";
import { saveAryeoWebLogin, retestAryeoWebLogin, disconnectAryeoWebLogin, type AryeoWebActionResult } from "@/app/connections/aryeoWebActions";

// The owner enters the hub's own Aryeo login; the hub signs in to test it
// before saving. Nobody else sees this form.
export function AryeoWebConnectForm() {
  const [state, action, pending] = useActionState<AryeoWebActionResult | null, FormData>(saveAryeoWebLogin, null);
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 space-y-2">
      <ol className="space-y-1 pl-1 text-xs text-muted">
        <li>
          <span className="font-medium text-foreground">1.</span> In Aryeo, invite a new team member for the hub (for example hub@realtourpilot.com) with access to listings, and activate it from the invitation email.
        </li>
        <li>
          <span className="font-medium text-foreground">2.</span> Enter that login here. The hub signs in once to check it.
        </li>
      </ol>
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2">
          Add the hub&rsquo;s Aryeo login
        </button>
      ) : (
        <form action={action} className="space-y-2 rounded-xl border bg-surface-2 p-3">
          <label className="block text-xs font-medium text-foreground/80" htmlFor="aryeo-web-email">Email</label>
          <input id="aryeo-web-email" name="email" type="email" autoComplete="off" spellCheck={false} className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          <label className="block text-xs font-medium text-foreground/80" htmlFor="aryeo-web-password">Password</label>
          <input id="aryeo-web-password" name="password" type="password" autoComplete="new-password" spellCheck={false} className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
          <p className="text-[11px] text-muted">Checked by signing in and opening one listing page, which changes nothing. A login Aryeo refuses is not saved. The password is encrypted before it is stored and is never shown again.</p>
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

export function AryeoWebConnectedControls() {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<AryeoWebActionResult | null>(null);
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => start(async () => setMsg(await retestAryeoWebLogin()))} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-60">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Test the login
        </button>
        <button
          disabled={busy}
          onClick={() => {
            if (!confirm("Remove the hub's Aryeo login? The hub stops uploading and delivering; Kyle does it by hand.")) return;
            start(async () => setMsg(await disconnectAryeoWebLogin()));
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-surface-2 disabled:opacity-60"
        >
          <PowerOff className="size-3.5" /> Disconnect
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}
