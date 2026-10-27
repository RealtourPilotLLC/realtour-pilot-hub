"use client";

import { useState, useTransition } from "react";
import { Loader2, Mail } from "lucide-react";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { checkBookingReminder, sendBookingReminderNow } from "@/app/content/bookingReminderActions";

// ---------------------------------------------------------------------------
// "Send reminder now" (Oct 27 2026, Jordan, on Monitoring: "a button to be
// able to send ... reminders when they're not scheduled"). Click → the hub
// reads what would go (nothing is written) → a confirm names the client and
// the address → Send. The daily booking reminder's own email, through the
// reminder engine's rules (bookingReminderActions.ts).
// ---------------------------------------------------------------------------

type Check = Awaited<ReturnType<typeof checkBookingReminder>>;

export function SendReminderButton({ monthId, clientName, className }: { monthId: string; clientName: string; className?: string }) {
  const [busy, start] = useTransition();
  const [check, setCheck] = useState<Check | null>(null);
  const [done, setDone] = useState<{ ok: boolean; message: string } | null>(null);
  const first = clientName.split(" ")[0] || clientName;

  const open = () => start(async () => {
    setDone(null);
    try { setCheck(await checkBookingReminder(monthId)); } catch { setCheck({ ok: false, message: "Couldn't reach the server. Try again." }); }
  });
  const send = () => start(async () => {
    let r: { ok: boolean; message: string };
    try { r = await sendBookingReminderNow(monthId); } catch { r = { ok: false, message: "Couldn't reach the server. Nothing was sent." }; }
    setCheck(null);
    setDone(r);
  });

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(); }}
        disabled={busy}
        className={className ?? "inline-flex min-h-8 items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground/85 hover:bg-surface-2 disabled:opacity-50"}
      >
        {busy && !check ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Mail className="size-3.5" aria-hidden />}
        Send reminder now
      </button>
      {done && <span role="status" className={done.ok ? "text-xs text-success" : "text-xs text-warning"}>{done.message}</span>}
      {check && (
        <ModalDialog label={`Send ${first} a booking reminder`} busy={busy} onCancel={() => setCheck(null)} className="w-[min(94vw,28rem)]">
          <h2 className="text-base font-semibold">Send {first} a booking reminder?</h2>
          {check.ok ? (
            <p className="mt-2 text-sm leading-relaxed text-muted">
              The same email the daily reminder sends: it asks {first} to book the content session.{" "}
              {check.to ? <>It goes to <span className="font-medium text-foreground">{check.to}</span> right away</> : "It goes out right away"} and is added to the reminder history.
            </p>
          ) : (
            <p className="mt-2 text-sm leading-relaxed text-warning">{check.message}</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setCheck(null)} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface-2">
              {check.ok ? "Cancel" : "Close"}
            </button>
            {check.ok && (
              <button type="button" data-modal-initial-focus onClick={send} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-action px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Send it now
              </button>
            )}
          </div>
        </ModalDialog>
      )}
    </span>
  );
}
