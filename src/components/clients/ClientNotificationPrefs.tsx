"use client";

import { useState, useTransition } from "react";
import { BellRing, Loader2, Check, TriangleAlert } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { saveClientNotificationPrefs } from "@/app/clients/[id]/notificationActions";

// Per-client switches for the two texts the hub sends on its own (Jordan,
// Sep 2 2026: "I'd like to be able to manually adjust notification preferences
// for each client"). Settings → Automated texts is the master switch for
// everybody; this card is the exception for ONE client.
//
// Saves on flip rather than behind a Save button: a switch that looks flipped
// but was never saved would quietly text a client who asked us not to. On a
// failed save the switch snaps back to what the database actually holds, so the
// screen never claims a preference the sweep won't honour.
//
// The timings on the card are the LIVE rules (passed in from the page), not
// hard-coded prose — change the lead time in Settings and this card changes
// with it. Same reason the global-off banner exists: a client switched ON here
// while the master switch is OFF is still not being texted, and the screen has
// to say so rather than imply a text is on its way.

export type AutoTextContext = {
  /** Settings → Automated texts master switch. */
  globalEnabled: boolean;
  /** Confirmation automation, for every client. */
  confirmationEnabled: boolean;
  /** Delivery/feedback automation, for every client. */
  deliveryEnabled: boolean;
  /** Lead time on the confirmation text, in hours. */
  hoursBefore: number;
  /** e.g. "9:00 AM – 4:00 PM ET" — the live send window. */
  windowLabel: string;
};

// Server-action failures can arrive as a several-thousand-character Prisma
// error. Show enough to act on, never enough to blow the sidebar apart.
function clip(s: string, max = 220): string {
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}

function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        on ? "bg-success" : "bg-surface-2 ring-1 ring-border",
      )}
    >
      <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

export function ClientNotificationPrefs({
  clientId,
  clientName,
  hasPhone,
  autoConfirmationText,
  autoDeliveryText,
  canEdit,
  rules,
}: {
  clientId: string;
  clientName: string;
  hasPhone: boolean;
  autoConfirmationText: boolean;
  autoDeliveryText: boolean;
  /** Owner/admin, not previewing as someone else. Everyone else sees it read-only. */
  canEdit: boolean;
  rules: AutoTextContext;
}) {
  const [prefs, setPrefs] = useState({ autoConfirmationText, autoDeliveryText });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  const anyOff = !prefs.autoConfirmationText || !prefs.autoDeliveryText;

  const flip = (patch: Partial<typeof prefs>) => {
    const previous = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next); // optimistic — the switch answers the click immediately
    setMsg(null);
    start(async () => {
      const res = await saveClientNotificationPrefs(clientId, next).catch((e: unknown) => ({
        ok: false,
        message: e instanceof Error ? e.message : "Couldn’t save — try again.",
      }));
      if (!res.ok) setPrefs(previous); // never show a setting the database doesn't hold
      setMsg({ ok: res.ok, text: res.message });
    });
  };

  return (
    <Section
      icon={BellRing}
      title="Client notifications"
      action={
        busy ? (
          <Loader2 className="size-4 animate-spin text-muted" />
        ) : msg?.ok ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
            <Check className="size-3.5 shrink-0" /> Saved
          </span>
        ) : null
      }
    >
      <div className="space-y-3">
        <Row
          title="Send shoot confirmation texts"
          detail={`Goes out ${rules.hoursBefore} hours before the shoot: the date, the time, who’s coming and what was ordered.`}
          on={prefs.autoConfirmationText}
          disabled={!canEdit || busy}
          onChange={(v) => flip({ autoConfirmationText: v })}
          // A per-client "on" is meaningless while the automation is off for
          // everyone — say which switch is actually holding the text back.
          overridden={prefs.autoConfirmationText && rules.globalEnabled && !rules.confirmationEnabled ? "Confirmation texts are switched off for every client in Settings → Automated texts." : null}
        />
        <Row
          title="Send the feedback ask after delivery"
          detail="Goes out once every ordered item has shipped: “how did we do?”, with the feedback link."
          on={prefs.autoDeliveryText}
          disabled={!canEdit || busy}
          onChange={(v) => flip({ autoDeliveryText: v })}
          overridden={prefs.autoDeliveryText && rules.globalEnabled && !rules.deliveryEnabled ? "Delivery texts are switched off for every client in Settings → Automated texts." : null}
        />

        {/* A failed save gets a full-width line, not a header chip: the message
            can be a whole Prisma/permission error, and a clipped chip would hide
            the reason a preference did NOT stick. The switch has already snapped
            back to the stored value by the time this renders. */}
        {msg && !msg.ok && (
          <p className="flex items-start gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-[12px] leading-snug text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">Not saved — the switch is back to what the hub actually has. {clip(msg.text)}</span>
          </p>
        )}
        {msg?.ok && <p className="text-[12px] text-muted-2">{msg.text}</p>}

        {/* What OFF actually means. This is the sentence that keeps a switched-off
            client from quietly falling through the cracks. */}
        <p className={cn("rounded-lg px-3 py-2 text-[13px] leading-snug", anyOff ? "bg-warning-soft/50 text-foreground/85" : "bg-surface-2 text-muted")}>
          {anyOff ? (
            <>
              The hub will <b>not</b> text {clientName} automatically for anything switched off. The reminder still
              appears on <b>Tasks</b> with the message written out — a person sends it by hand.
            </>
          ) : (
            <>
              Both send on their own, {rules.windowLabel}. Switch one off and the hub reminds a person on <b>Tasks</b>{" "}
              instead of texting — the job is never dropped, just handed to a human.
            </>
          )}
        </p>

        {!rules.globalEnabled && (
          <p className="flex items-start gap-1.5 text-[12px] text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            All automated client texts are switched off right now in Settings → Automated texts, so nothing sends on its
            own for anyone — whatever these two switches say.
          </p>
        )}

        {!hasPhone && (
          <p className="flex items-start gap-1.5 text-[12px] text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            No phone number on file for {clientName} — neither text can send today, whatever these switches say.
          </p>
        )}

        {!canEdit && <p className="text-[12px] text-muted-2">Read-only — an owner or admin can change these.</p>}
      </div>
    </Section>
  );
}

function Row({
  title,
  detail,
  on,
  disabled,
  onChange,
  overridden,
}: {
  title: string;
  detail: string;
  on: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  overridden: string | null;
}) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{detail}</p>
        </div>
        <Toggle on={on} onChange={onChange} label={title} disabled={disabled} />
      </div>
      {overridden && (
        <p className="mt-2 flex items-start gap-1.5 border-t border-border pt-2 text-[12px] text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {overridden}
        </p>
      )}
    </div>
  );
}
