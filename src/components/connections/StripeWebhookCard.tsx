"use client";

import { useActionState, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Circle, CreditCard, Loader2 } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { connectApiKey, disconnectProvider, type ActionResult } from "@/app/connections/actions";
import type { StripeWebhookStatus } from "@/lib/stripeSignups";

// ---------------------------------------------------------------------------
// THE STRIPE WEBHOOK, ON ONE CARD (unified handoff, Sep 25 2026).
//
// Website signups activate from the hourly check of Stripe whatever this card
// says; the webhook only makes it seconds instead of up to an hour. So the
// card's job is to say, in plain words, three separate facts that are easy to
// run together: whether a signing secret is saved (and readable), whether
// Stripe is actually delivering, and whether the hourly check has had to
// cover for a delivery that never came. The secret goes in once, through the
// same encrypted path as every API key, and is never shown back.
//
// Registering the endpoint with Stripe is NOT done from here: that is a write
// to the live Stripe account (scripts/_ops/register-stripe-webhook.ts, run by
// hand, saves the secret itself). Pasting here is for a secret made in the
// Stripe dashboard.
// ---------------------------------------------------------------------------

const REFUSAL: Record<string, string> = {
  "no-secret": "refused, because no signing secret was saved",
  "bad-signature": "refused, because the signature did not match the saved secret",
  "unreadable-secret": "refused, because the saved secret could not be read",
};

export function StripeWebhookCard({ status }: { status: StripeWebhookStatus }) {
  const [state, action, saving] = useActionState<ActionResult | null, FormData>(connectApiKey, null);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [busy, start] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const usable = status.secretReadable || status.envFallback;
  const unreadable = status.secretStored && !status.secretReadable;
  const missedLine = usable && status.missed.count > 0;

  return (
    <section className="rounded-2xl border bg-surface p-4" data-card="stripe-webhook">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: "#635bff1a", color: "#635bff" }}>
          <CreditCard className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">Stripe webhook</h2>
            {usable && !unreadable ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                <CheckCircle2 className="size-3" /> Secret saved
              </span>
            ) : unreadable ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
                <AlertTriangle className="size-3" /> Secret unreadable
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                <Circle className="size-3" /> Not set up
              </span>
            )}
          </div>
          <p className="text-xs text-muted">Makes website signups arrive in seconds. Without it they arrive within the hour.</p>
        </div>
      </div>

      {/* WHERE THINGS STAND, as sentences. */}
      <div className="mt-3 space-y-1.5 rounded-xl border bg-surface-2/50 p-3 text-xs">
        <p>
          {unreadable
            ? "A secret is saved but the hub can't read it any more, so every Stripe post is being refused. Paste the secret again below."
            : status.secretReadable
              ? `A signing secret is saved${status.savedAt ? ` (${etDateTime(status.savedAt)})` : ""}. Every Stripe post is checked against it.`
              : status.envFallback
                ? "The signing secret is set on the server rather than saved here. Every Stripe post is checked against it."
                : "No signing secret is saved, so anything posted to the webhook address is refused. Nothing is lost: the hourly check activates every paid signup."}
        </p>
        <p className="text-muted">
          Last delivery from Stripe:{" "}
          {status.lastProcessed ? (
            <span className="text-foreground">
              {etDateTime(status.lastProcessed.at)}
              {status.lastProcessed.type ? ` (${status.lastProcessed.type})` : ""}
            </span>
          ) : (
            "none yet"
          )}
          .
        </p>
        <p className="text-muted">
          Last refused post:{" "}
          {status.lastRejected ? (
            <span className="text-foreground">
              {etDateTime(status.lastRejected.at)}, {REFUSAL[status.lastRejected.code ?? ""] ?? "refused"}
            </span>
          ) : (
            "none"
          )}
          .
        </p>
        <p className="text-muted">
          Last 30 days: <span className="text-foreground">{status.pollOnly30d}</span> signup{status.pollOnly30d === 1 ? "" : "s"} activated
          by the hourly check, <span className="text-foreground">{status.webhook30d}</span> by the webhook.
        </p>
        {missedLine && (
          <p className="flex items-start gap-1.5 font-medium text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Stripe did not deliver {status.missed.count} signup{status.missed.count === 1 ? "" : "s"} the webhook should have caught
              {status.missed.lastAt ? ` (last ${etDateTime(status.missed.lastAt)})` : ""}. The hourly check activated
              {status.missed.count === 1 ? " it" : " them"}. If this keeps happening, check the endpoint in Stripe.
            </span>
          </p>
        )}
      </div>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-medium text-muted hover:text-foreground">Registration details</summary>
        <div className="mt-2 space-y-1.5 text-muted">
          <p>
            Address: <code className="break-all font-mono text-foreground">{status.endpointUrl}</code>
          </p>
          <p>Events: {status.events.join(", ")}</p>
          <p>Saving a secret here doesn&apos;t register anything with Stripe; the endpoint is set up in Stripe itself.</p>
        </div>
      </details>

      <form action={action} className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3">
        <input type="hidden" name="provider" value="stripe_webhook" />
        <label className="block text-xs font-medium" htmlFor="stripe-whsec">
          Signing secret
        </label>
        <input
          id="stripe-whsec"
          name="key"
          type="password"
          autoComplete="off"
          placeholder="whsec_…"
          className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
        <p className="text-[11px] text-muted">
          Stripe shows it once, on the endpoint&apos;s page (Developers → Webhooks → the endpoint → Signing secret). It&apos;s encrypted before
          it&apos;s stored and never shown again.
        </p>
        <button
          type="submit"
          disabled={saving}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save secret
        </button>
        {state && (
          <p role="status" className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>
            {state.message}
          </p>
        )}
      </form>

      {status.secretStored && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {confirmRemove ? (
            <>
              <span className="text-muted">Stripe posts will be refused until a secret is saved again. Signups still arrive hourly.</span>
              <button
                onClick={() =>
                  start(async () => {
                    setMsg(await disconnectProvider("stripe_webhook"));
                    setConfirmRemove(false);
                  })
                }
                disabled={busy}
                className="rounded-lg border border-danger/50 px-2 py-1 font-medium text-danger hover:bg-danger-soft disabled:opacity-60"
              >
                {busy ? "Removing…" : "Remove it"}
              </button>
              <button onClick={() => setConfirmRemove(false)} className="px-2 py-1 text-muted hover:text-foreground">
                Keep it
              </button>
            </>
          ) : (
            <button onClick={() => setConfirmRemove(true)} className="font-medium text-muted hover:text-danger">
              Remove secret
            </button>
          )}
        </div>
      )}
      {msg && (
        <p role="status" className={`mt-2 text-xs ${msg.ok ? "text-success" : "text-danger"}`}>
          {msg.message}
        </p>
      )}
    </section>
  );
}
