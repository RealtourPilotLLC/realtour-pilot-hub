# Three integration tasks for Jordan

Tracked separately from the content-program build because each one needs Jordan or an external
party, and none of them blocks the rest of the implementation. Verified read-only in Phase 0 on
Sep 21 2026 against head `8e1f153`.

---

## 1. Aryeo webhook registration — needs Aryeo support

**State:** Aryeo's webhook subscriptions are dead. Our API key cannot manage them: subscription
management returns 401 on this key, which is a documented account limitation rather than a scope
we can widen ourselves. This is a standing issue, not something this week's work introduced.

**What it costs while it stays broken:** nothing is lost, but everything is late. Order changes,
appointment changes and delivery confirmations reach the hub through the hourly reconcile
(`/api/cron/sync` at `:00`) instead of arriving on the event. So a booking confirmed at 9:05 is
not visible in the hub until 10:00, and the same is true of a delivery. The hub is already built
to reconcile rather than depend on the push, so this degrades freshness, not correctness.

**The exact action:** email Aryeo support and ask them to re-register the webhook subscriptions
for the Realtour Pilot, LLC group (`a34b1908-d279-475e-8ec3-a7d8b9a459aa`) against
`https://hub.realtourpilot.com/api/webhooks/aryeo`, and to confirm which event types are enabled.
Ask specifically whether a **media-added or listing-updated** event exists — zero `LISTING_UPDATED`
events have arrived in ten days out of 176 received, which is why a video added to an
already-delivered listing still waits for the hourly sweep.

**After it lands:** nothing to deploy. The receiver already exists and already recognises the
event types; the reconcile stays as the backstop.

---

## 2. Stripe webhook registration — Jordan, five minutes

**State:** `GET /v1/webhook_endpoints` returns 200 with **count = 0**. There are no endpoints
registered at all, so signup activation is polling-only: `sweepStripeSignups()` pages the last 30
days of Checkout Sessions on a schedule and claims each paid one atomically.

**What it costs while it stays unregistered:** a paying client's account is created on the next
sweep rather than at the moment they pay, so the welcome and portal access lag the payment. The
spec is explicit that a browser checkout-success redirect is not payment evidence, so the sweep is
the correct floor — this is about latency, not trust.

**The exact action:** in the Stripe dashboard, Developers → Webhooks → Add endpoint,
`https://hub.realtourpilot.com/api/webhooks/stripe`, subscribed to `checkout.session.completed`
and `checkout.session.async_payment_succeeded`. Copy the signing secret it gives you into the hub
as `STRIPE_WEBHOOK_SECRET`.

**Alternatively, authorize me** and I will create it — the stored key is a full-access `sk_live_`
so it is technically possible, but registering an endpoint is a write to your live Stripe account
and I will not do it without you saying so.

**A related decision, not urgent.** The hub stores a full-access `sk_live_` key while
`src/lib/integrations/stripe.ts` documents a restricted read key. Either keep full access (needed
if the hub is ever to self-manage the endpoint) or rotate to an `rk_live_` restricted key, which
would need read on Checkout Sessions, Products, Prices, Subscriptions, Customers, Balance and
Balance Transactions. Full access is the larger blast radius; the restricted key is the tidier
posture. Your call.

---

## 3. The `hello@realtourpilot.com` reconnection — Jordan, two minutes

**State:** the stored refresh token for that mailbox is dead. `POST oauth2.googleapis.com/token`
returns `400 invalid_grant`, which means the grant was revoked or expired rather than
misconfigured.

**What it costs:** `hello@` cannot send or receive through the hub. **`info@` is healthy and holds
`gmail.send`**, so the content program's own email rail is not blocked — this only matters for
whatever you intend `hello@` to carry. Worth noting the OpenPhone user map resolves
`hello@realtourpilot.com` to Kyle, so if client email is meant to reach him at that address it is
currently not reaching the hub at all.

**The exact action:** open `/connections` in the hub, find the Google connection for `hello@`, and
reconnect it. Grant `gmail.send` as well as read while you are there.

**Decide at the same time:** should `hello@` be a hub-connected mailbox, or is `info@` the only one
the hub needs? If the answer is `info@` only, say so and I will retire the `hello@` connection
rather than leave a permanently broken one on the connections page.

---

## Not blockers, recorded so they are not re-investigated

- **Calendly Notetaker** returns 403, "required features are not enabled". Jordan, Sep 21:
  transcripts come from Google Meet via Google Drive and Calendly identifies the booking, so
  Notetaker is not a requirement. Closed.
- **Neon branch feasibility** could not be established — there is no `NEON_API_KEY` in `.env` or in
  the Vercel production environment and `neonctl` is not installed. Needed before any restore
  rehearsal away from live records. Project `cool-sun-51091200`, branch `br-polished-bar-ai5lbq8s`.
- **Aryeo appointment creation** requires an existing `order_id`, so a hub-driven booking must
  create an order first. Both writes are permitted by the key (`APPOINTMENTS_MANAGE`,
  `ORDERS_MANAGE`) and neither has ever been exercised by this codebase. That is a build-and-test
  task, not an external blocker.
