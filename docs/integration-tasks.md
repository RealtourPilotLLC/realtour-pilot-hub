# Integration tasks for Jordan

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

**A second correction, and then a correction to the correction (Sep 22).** I first wrote that there
was no media-added or listing-updated subscription. I then told Jordan that `LISTING_CHANGED` fires
carrying a `videos` array, that this was the missing media-added signal, and that wiring it was a
code change we could make. I measured it properly before building on it, and two of those three
claims were wrong.

- **`LISTING_CHANGED` does fire** — 5 events in 45 days, all PROCESSED (against
  LISTING_CONTENT_DOWNLOADED 100, LISTING_DELIVERED 22, LISTING_CREATED 7). There is no
  `LISTING_UPDATED` in Aryeo, but this one exists and arrives.
- **It is NOT a media-added signal.** The `videos` array on the Sep 3 payloads is present and
  **empty** (`videos[0]`), and the Sep 6 ones carry no `videos` key at all. The body never
  evidenced a video. All five also predate the Sep 18 re-registration — none has arrived since.
- **The receiver already handles it, and better than the handler I wrote.** A flat LISTING payload
  is classified `LISTING_CHANGED` and lands in the generic LISTING branch, which restatuses the
  project, re-tasks it, repairs a missing listing link, and calls `proveListingNow` — the same
  evidence function the hourly sweep and the delivery handler call. My handler would have
  intercepted the event ahead of all of that. Reverted.

So there is **no Aryeo work here and no hub work here**. The early catch for a video appearing on a
delivered listing remains `LISTING_CONTENT_DOWNLOADED` (100 events in 45 days), and the hourly
sweep is the backstop, exactly as before.

## 2. Stripe signups — polling is the activation path. Nothing to register.

**Corrected Sep 24 2026 (completion audit CP-14).** This section used to tell Jordan to register a
Stripe webhook at `/api/webhooks/stripe` (and `content-program-checklist.md` said the same thing with
a different list of events). There was no receiver at that address, so Stripe would have posted to a
404, retried for days, emailed about the failures and eventually disabled the endpoint. No data would
have been lost, because polling was already doing the work, but it was an instruction to break
something. The "authorize me and I will create it" offer that followed is withdrawn too.

**How a paid signup becomes a client today (unchanged, and deliberate):** the hub reads Stripe.
`sweepStripeSignups()` pages the last 30 days of Checkout Sessions and activates each one that is
`complete` and `paid`, exactly once (the claim is the unique checkout id).

- **When:** every hour at :00 (the `stripeSignups` step of `/api/cron/sync`), and immediately when
  someone presses **Sync now** on `/content`.
- **The honest delay:** a paid signup is activated within the hour. Occasionally two, if an hourly
  run ran out of time before that step; the run's summary on `/connections` shows it as `skipped`.
- **Asynchronous payments** (a bank debit that settles days later) activate on the first pass after
  Stripe marks them paid. An unpaid checkout never activates.
- **A $0 checkout** (a 100% coupon, or a trial Stripe reports as "no payment required") does NOT
  activate. That is Jordan's decision, and it is a named constant in the code
  (`ACTIVATING_PAYMENT_STATUS` in `src/lib/stripeSignups.ts`).
- **Billing dates are Stripe's.** Nothing in the hub writes to Stripe. The enrollment starts on the
  paid date; production months are Eastern calendar months; the subscription's billing anchor is
  recorded (owner-only) when the hub checks the subscription.

**The receiver now exists, and is optional.** `src/app/api/webhooks/stripe/route.ts` verifies
Stripe's signature (refusing everything while no signing secret is saved), then activates through the
SAME claim and activation the poll uses, reading Stripe's own copy of the session. The drill
(`scripts/_drill/cp14-stripe-activation.ts`) proves a webhook and the poll racing on one payment make
one enrollment, one account seat and one welcome, that invalid signatures are refused, that async
payments activate only when paid, and that a $0 checkout does not.

**Only if Jordan wants activation within seconds instead of within the hour** (it is his call, and a
write to his live Stripe account, so it is never done from here):

1. Stripe dashboard → Developers → Webhooks → Add endpoint:
   `https://hub.realtourpilot.com/api/webhooks/stripe`, subscribed to exactly these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
2. Give the hub the endpoint's `whsec_…` signing secret. Today that means the Vercel environment
   variable `STRIPE_WEBHOOK_SECRET` (there is no field for it on `/connections` yet; the receiver also
   reads a `stripe_webhook` connection first, so a field can be added without touching it).
3. Nothing else changes: the hourly poll stays on as the backstop.

**A related decision, not urgent.** The hub stores a full-access `sk_live_` key while
`src/lib/integrations/stripe.ts` documents a restricted read key. Either keep full access or rotate to
an `rk_live_` restricted key, which would need read on Checkout Sessions, Products, Prices,
Subscriptions, Customers, Balance and Balance Transactions. Neither polling nor the receiver needs
write access. Full access is the larger blast radius; the restricted key is the tidier posture. Your
call.

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
