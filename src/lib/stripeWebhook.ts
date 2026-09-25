import "server-only";
import crypto from "crypto";
import { getSecret } from "@/lib/integrations/connections";
import { processCheckoutSessionById, checkSubscription, type CheckoutOutcome } from "@/lib/stripeSignups";

// ---------------------------------------------------------------------------
// THE STRIPE WEBHOOK RECEIVER'S LOGIC (CP-14, Sep 24 2026).
//
// Why it exists now: two documents told Jordan to register
// https://hub.realtourpilot.com/api/webhooks/stripe (and disagreed about which
// events), and there was no route there — Stripe would have posted to a 404,
// retried for days, emailed him about the failures and eventually disabled the
// endpoint. Polling was, and still is, the activation path; this makes the
// URL real, verified and drilled, so registering it (Jordan's act, a write to
// his live Stripe account — never done from here) only makes activation
// faster.
//
// Three rules:
//   1. FAIL CLOSED. No signing secret saved → every post is refused. There is
//      no "accept unsigned" mode for this receiver: the poll is the floor, so
//      a refusal loses nothing.
//   2. THE EVENT IS A DOORBELL, NOT THE TRUTH. Only the event's id, type and
//      the object's id are used. What was bought, who paid and whether it is
//      paid are read from Stripe's own record (processCheckoutSessionById),
//      exactly as the poll reads them — the same claim, the same activation.
//   3. NOTHING HERE WRITES TO STRIPE, and nothing here messages anyone that the
//      poll would not have. A test-mode event is ignored (the hub's key is a
//      live key and cannot read test-mode sessions anyway).
// ---------------------------------------------------------------------------

/** Stripe's own default tolerance for the signed timestamp. */
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

/** The events to subscribe to, IF Jordan registers the endpoint. Everything
 *  else Stripe might send is acknowledged and ignored. */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: "malformed" | "stale" | "bad-signature" };

/**
 * Stripe's scheme: header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`,
 * signature = HMAC-SHA256(secret, `${t}.${rawBody}`) in hex. Several v1 values
 * appear while a secret is being rolled; any one matching is enough. The
 * timestamp is checked AFTER the signature, so a stale-but-genuine post says
 * "stale" and a forged one says "bad-signature".
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): SignatureCheck {
  if (!header || !secret) return { ok: false, reason: "malformed" };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (t === null || v1.length === 0) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex"), "utf8");
  const match = v1.some((sig) => {
    const got = Buffer.from(sig, "utf8");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!match) return { ok: false, reason: "bad-signature" };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? STRIPE_SIGNATURE_TOLERANCE_SEC)) return { ok: false, reason: "stale" };
  return { ok: true, timestamp: t };
}

/**
 * The signing secret (`whsec_…`). A Connection row the hub can read and test
 * first — the Sep 8 lesson: an env var nobody can see from the hub is a secret
 * nobody can prove is set — then STRIPE_WEBHOOK_SECRET for a deployment that
 * sets it in Vercel. Neither exists today, so the receiver refuses everything.
 */
export async function stripeWebhookSecret(): Promise<string | null> {
  const stored = await getSecret("stripe_webhook").catch(() => null);
  return stored?.trim() || process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

/** All of an event the hub keeps: its identity. No amounts, no addresses. */
export type StripeEventSummary = { id: string; type: string; objectId: string | null; livemode: boolean; created: number };

/** From a Stripe event body — or from the summary a WebhookEvent row stored, which is the same shape. */
export function summarizeStripeEvent(body: unknown): StripeEventSummary | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : null;
  const type = typeof b.type === "string" ? b.type : null;
  if (!id || !type || !/^evt_[A-Za-z0-9_]+$/.test(id)) return null;
  const data = b.data as { object?: { id?: unknown } } | undefined;
  const objectId = typeof data?.object?.id === "string" ? data.object.id : typeof b.objectId === "string" ? b.objectId : null;
  return { id, type, objectId, livemode: b.livemode === true, created: typeof b.created === "number" ? b.created : 0 };
}

export type StripeEventResult = { outcome: CheckoutOutcome | "ignored" | "recorded" | "subscription_checked" | "not_ours"; detail?: string };

/** Route one verified event. Throws on a provider or database failure — the receiver marks the row ERROR and webhookRetry replays it. */
export async function handleStripeEvent(e: StripeEventSummary): Promise<StripeEventResult> {
  if (!e.livemode) return { outcome: "ignored", detail: "test-mode event" };
  switch (e.type) {
    case "checkout.session.completed":
      if (!e.objectId) return { outcome: "ignored", detail: "no session id on the event" };
      return { outcome: await processCheckoutSessionById(e.objectId, "webhook") };
    case "checkout.session.async_payment_succeeded":
      // The money settled now, not when the checkout opened: that moment is
      // the paid date the enrollment starts from.
      if (!e.objectId) return { outcome: "ignored", detail: "no session id on the event" };
      return { outcome: await processCheckoutSessionById(e.objectId, "webhook", { paidAt: e.created ? new Date(e.created * 1000) : undefined }) };
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      // Recorded on the WebhookEvent row and nothing else: an unpaid checkout
      // never activates, and there is nothing to undo because nothing was done.
      return { outcome: "recorded", detail: e.type };
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!e.objectId) return { outcome: "ignored", detail: "no subscription id on the event" };
      const r = await checkSubscription(e.objectId);
      return r ? { outcome: "subscription_checked", detail: r.status } : { outcome: "not_ours", detail: "not a program subscription the hub activated" };
    }
    default:
      return { outcome: "ignored", detail: `unhandled type ${e.type}` };
  }
}
