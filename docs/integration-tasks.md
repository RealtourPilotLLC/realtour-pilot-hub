# Three integration tasks for Jordan

Tracked separately from the content-program build because each one needs Jordan or an external
party, and none of them blocks the rest of the implementation. Verified read-only in Phase 0 on
Sep 21 2026 against head `8e1f153`.

---

## 1. Aryeo webhooks — WORKING. One old subscription still needs purging.

**Corrected Sep 22 2026.** I previously wrote here that the subscriptions were dead and told Jordan
to ask Aryeo to re-register them. That was wrong, and he caught it: they were re-registered on
Sep 18 and they have been working ever since. The Phase 0 agent said plainly that it had not
re-probed this and was repeating a standing note; I passed it on as live fact without checking.

**Measured state (read-only, Sep 22):**

- 935 events in 30 days, 213 in 7 days, **46 in the last 24 hours**. Most recent
  `LISTING_DELIVERED`, processed, Sep 21 20:46.
- 20 event types arriving and processing cleanly: `ORDER_CHANGED` 315, `APPOINTMENT_CHANGED` 232,
  `CUSTOMER_CHANGED` 132, `LISTING_CONTENT_DOWNLOADED` 99, `LISTING_DELIVERED` 22,
  `APPOINTMENT_SCHEDULED`/`RESCHEDULED` 12, and the rest.

**The real issue, which is smaller and different.** 50 events were **refused on signature**, oldest
Sep 8, most recent **Sep 21 19:45** — an hour before a good event landed. So two senders are
posting: one signing correctly, one not. That second sender is almost certainly the pre-Sep-8
subscription, created when the secret was saved in the hub and never given to Aryeo.

Of those 50: **11 were duplicates** we also received from the good sender, and **39 were genuinely
lost** — never seen any other way. By name: `ORDER_PLACED` 2, `ORDER_CREATED`, `ORDER_RECEIVED`,
`ORDER_PAYMENT_ENTERED`, `ORDER_PAYMENT_COMPLETED`, `ORDER_SYNCED_TO_QUICKBOOKS`,
`MEDIA_REQUEST_CREATED`, `CUSTOMER_TEAM_INTERNAL_NOTE_UPDATED`, and 6 customer-shaped payloads.

Nothing is permanently lost — orders and appointments are re-read by the hourly reconcile, which is
why this went unnoticed. But those events were dropped at the door, and the rate is roughly two a
week and continuing.

**The exact action:** ask Aryeo support to **delete the old webhook subscription** for the Realtour
Pilot, LLC group (`a34b1908-d279-475e-8ec3-a7d8b9a459aa`) pointing at
`https://hub.realtourpilot.com/api/webhooks/aryeo` — the one created before Sep 18, which is still
posting with a stale signing secret. Keep the current one. Our key cannot manage subscriptions
itself (401), which is why this needs them.

**A second correction: the "media added" signal exists.** I wrote that there was no media-added or
listing-updated subscription. There is no event named `LISTING_UPDATED` in Aryeo, but
**`LISTING_CHANGED` fires and its payload carries a `videos` array** when the listing has them
(seen on the Sep 3 event; the Sep 6 ones omit it, so the payload only includes non-empty
collections). It arrives about 5 times in 30 days and the receiver does not handle it today.

So the instant "a video was added to an already-delivered listing" path is a **code change we can
make**, not something to ask Aryeo for. It belongs with the ready-to-send work, and the hourly
sweep stays as the backstop either way.

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

- **Aryeo webhook re-registration** — done Sep 18, verified working Sep 22. Only the old duplicate
  subscription needs purging (see task 1).
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
