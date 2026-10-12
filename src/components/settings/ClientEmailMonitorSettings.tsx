"use client";

import { useState, useTransition } from "react";
import { saveClientEmailMonitorAction } from "@/app/settings/actions";
import { Button } from "@/components/ui/Action";

// ---------------------------------------------------------------------------
// Client email copies (Jordan, Oct 12 2026): one address and an off switch.
// What it does lives in src/lib/clientEmailMonitor.ts; this card only says it
// plainly and saves it. Owner-only to change; an admin reads it.
// ---------------------------------------------------------------------------

export function ClientEmailMonitorSettings({
  initial,
  isOwner,
}: {
  initial: { enabled: boolean; address: string; unreadable: boolean };
  isOwner: boolean;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [address, setAddress] = useState(initial.address);
  const [saved, setSaved] = useState({ enabled: initial.enabled, address: initial.address });
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = enabled !== saved.enabled || address.trim().toLowerCase() !== saved.address;

  const save = (next: { enabled: boolean; address: string }) =>
    start(async () => {
      const res = await saveClientEmailMonitorAction(next).catch(() => ({ ok: false, message: "Couldn’t save — try again." }) as { ok: boolean; message: string; enabled?: boolean; address?: string });
      if (res.ok && res.address !== undefined && res.enabled !== undefined) {
        setSaved({ enabled: res.enabled, address: res.address });
        setEnabled(res.enabled);
        setAddress(res.address);
      }
      setMsg(res.message);
    });

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <label htmlFor="client-email-monitor-address" className="min-w-0 text-sm font-semibold">
            Every email a client gets is also sent to:
          </label>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Copy client emails to this address"
            disabled={busy || !isOwner}
            onClick={() => setEnabled((v) => !v)}
            className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-brand" : "border border-border bg-surface-2"}`}
          >
            <span className={`block size-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <input
            id="client-email-monitor-address"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={address}
            disabled={!isOwner || busy}
            onChange={(e) => setAddress(e.target.value)}
            className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-1 text-sm outline-none focus:border-brand disabled:opacity-70 sm:w-80"
          />
          <span className="text-[13px] text-muted">(blind copy)</span>
        </div>
      </div>

      {!enabled && <p className="text-[13px] font-medium text-warning">Off: client emails are not copied to anyone.</p>}
      {initial.unreadable && (
        <p className="text-[13px] text-warning">The saved setting could not be read, so the default applies: copies go to info@realtourpilot.com. Saving here fixes it.</p>
      )}

      <p className="text-[13px] leading-relaxed text-muted">
        The client never sees it: the same sender, subject and words, and your address is not on their copy. An email
        with a one-time sign-in link comes to you as a separate copy with that link removed, so opening it can&rsquo;t
        sign you in as the client. Emails to the team are never copied.
      </p>

      {isOwner ? (
        <Button onClick={() => save({ enabled, address })} busy={busy} busyLabel="Saving…" disabled={!dirty}>
          Save
        </Button>
      ) : (
        <p className="text-[13px] text-muted-2">Only Jordan can change this one.</p>
      )}
      {msg && <p className="text-[13px] text-foreground/85" role="status">{msg}</p>}
    </div>
  );
}
