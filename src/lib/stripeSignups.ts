import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";
import type { StripeProgramPrice } from "@/lib/contentProgram";

// ---------------------------------------------------------------------------
// WEBSITE SIGNUP ACTIVATION (Jordan, Aug 28: "I already have website signup →
// agreement → Stripe Checkout → schedule brand discovery call on our website.
// No activation though.")
//
// The website sells the program; Stripe holds the truth about who paid. This
// sweep reads PAID Checkout sessions for the program's products ("Video
// Starter — 1-Year Commitment", "Video Pro — Pay in Full", the Give-It-a-Try
// trial …), and activates each one exactly once:
//
//   paid checkout → CLAIM a ProgramSignup row (unique checkoutId — the claim
//                   is atomic, so the hourly cron and a Sync-now click can
//                   race without double-activating; adversarial review found
//                   the check-then-act version of this)
//                 → find-or-create the Client (email first, then an exact-name
//                   stub — Aryeo often creates name-only rows with no email)
//                 → create/activate the ContentEnrollment with the package +
//                   billing terms read from the verified PRICE catalogue
//                   (the product name only as a fallback that parks the
//                   signup for review — Sep 25 2026, programTermsFor)
//                 → current-month workspace
//                 → DISCOVERY, in either order (§4.3): re-match a booking made
//                   before the payment, link it, or raise the task to make one
//                   (CP-14: this now runs BEFORE access, so the welcome is
//                   written from what is on file)
//                 → ACCOUNT ACCESS: a portal seat for the buyer and ONE
//                   welcome (Sep 21 2026 — see grantProgramAccess). Both are
//                   idempotent on (enrollment, email) and both are HELD while
//                   `portal_invites` is off, which it is.
//                 → owner/admin bell (package only — no dollar amounts, no
//                   billing term; how a client pays is owner-only)
//
// POLLING IS THE ACTIVATION PATH (Jordan, Sep 24 2026 — CP-14). Registering a
// webhook endpoint WRITES to the Stripe account, which is Jordan's to do, and
// the hourly cron (:00) + the /content Sync-now button give the freshness
// this flow needs: a paid signup is activated within the hour, occasionally
// two if an hourly run skips the step (CronRun.summary says so). Phase 0 (Sep
// 21 2026) confirmed GET /v1/webhook_endpoints returns count=0. Reading
// Stripe's ledger IS the "verified by Stripe" truth the spec demands; the
// browser redirect is never consulted.
//
// THE RECEIVER EXISTS NOW AND IS NOT REGISTERED (src/app/api/webhooks/stripe,
// src/lib/stripeWebhook.ts). It verifies Stripe's signature, then calls
// processCheckoutSessionById — the SAME claim and activateSignup the poll
// uses, reading Stripe's own copy of the session. The claim is the unique
// checkoutId, taken with INSERT … ON CONFLICT DO NOTHING, so a webhook and the
// poll racing on one checkout produce one activation, and grantProgramAccess
// collapses a repeated `checkout.session.completed` into the same seat and the
// same welcome (drilled: scripts/_drill/cp14-stripe-activation.ts). If Jordan
// never registers it, nothing is lost. (Sep 25 2026: Jordan authorised the
// registration through the API; scripts/_ops/register-stripe-webhook.ts is
// that operation, run by hand. The /connections "Stripe webhook" card holds
// the secret and checkWebhookCoverage below notices a dead endpoint.)
//
// Spec rule 15 honoured: web-activated enrollments get statusManual=true and
// packageSource="website", so the Aryeo social-flag sweep can never pause,
// re-package, or otherwise overwrite them.
//
// A signup that fails to activate is parked NEEDS_REVIEW with the error on
// the row, surfaced on /content (owner), and RETRIED on every later sweep
// until an enrollment exists — a transient Neon blip must not orphan a
// paying client behind a tombstone.
// ---------------------------------------------------------------------------

const BASE = "https://api.stripe.com/v1";

async function stripeGet<T>(path: string, query: Record<string, string | number | string[]>): Promise<T> {
  const key = await getSecret("stripe");
  if (!key) throw new Error("Stripe is not connected.");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, String(v));
  }
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message || `Stripe error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type StripeCheckoutSession = {
  id: string;
  status: string | null;
  payment_status: string | null;
  mode: string;
  amount_total: number | null;
  created: number;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  customer_details?: { email?: string | null; name?: string | null; phone?: string | null } | null;
  line_items?: { data: LineItem[] } | null;
};
type LineItem = {
  description?: string | null;
  price?: { id: string; product: string | { id: string; name?: string } | null } | null;
};

// The program's catalog, by name convention — the FALLBACK since Sep 25 2026:
// the price-keyed catalogue (contentProgram.STRIPE_PROGRAM_PRICES) is read
// first, see programTermsFor. Everything else Stripe sells (photo shoots,
// biography videos, brand launch sessions) is NOT a recurring program signup
// and is left alone.
const PROGRAM_PRODUCT_RE = /^Video (Starter|Accelerator|Pro)\b/i;

// Typographic dashes (en/em/non-breaking hyphen…) normalise to "-" before any
// term matching — the live catalog already mixes "—" and "-", and a U+2011 in
// "1‑Year" would otherwise silently downgrade a 12-month commitment to
// month-to-month (adversarial review, tested empirically).
const normDashes = (s: string) => s.replace(/[‐-―−­]/g, "-");

export function parseProgramProduct(rawName: string, opts: { recurring: boolean; amount: number }): {
  package: "Starter" | "Accelerator" | "Pro";
  billingType: "PAID_IN_FULL" | "MONTHLY_CONTRACT" | "MONTH_TO_MONTH" | "TRIAL";
  billingMonths: number | null;
  guessed: boolean; // no term marker in the name — a human should confirm
} | null {
  const name = normDashes(rawName);
  const m = name.match(PROGRAM_PRODUCT_RE);
  if (!m) return null;
  const pkg = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as "Starter" | "Accelerator" | "Pro";
  if (/give it a try|trial/i.test(name)) return { package: pkg, billingType: "TRIAL", billingMonths: 1, guessed: false };
  if (/pay in full/i.test(name)) return { package: pkg, billingType: "PAID_IN_FULL", billingMonths: 12, guessed: false };
  if (/1[\s-]?year/i.test(name)) return { package: pkg, billingType: "MONTHLY_CONTRACT", billingMonths: 12, guessed: false };
  if (/month[\s-]?to[\s-]?month/i.test(name)) return { package: pkg, billingType: "MONTH_TO_MONTH", billingMonths: null, guessed: false };
  // A program product with no term marker: best guess from payment shape, and
  // the signup is parked NEEDS_REVIEW so the owner confirms the terms.
  return opts.recurring
    ? { package: pkg, billingType: "MONTH_TO_MONTH", billingMonths: null, guessed: true }
    : opts.amount < 2000
      ? { package: pkg, billingType: "TRIAL", billingMonths: 1, guessed: true }
      : { package: pkg, billingType: "PAID_IN_FULL", billingMonths: 12, guessed: true };
}

export type ProgramTerms = NonNullable<ReturnType<typeof parseProgramProduct>>;
type CatalogueRow = Pick<StripeProgramPrice, "productId" | "productName" | "package" | "billingType" | "billingMonths" | "amountCents">;
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/**
 * WHAT WAS BOUGHT, PRICE FIRST (unified handoff §6.1, Sep 25 2026). Pure.
 *
 * The price-keyed catalogue (contentProgram.STRIPE_PROGRAM_PRICES, read from
 * the live account in Phase 0) existed for four days as dead code while
 * activation parsed the product NAME — so a product renamed in Stripe on a
 * price we know by heart would have left a paying client silently ignored
 * ("not_program": no row, no review, no bell). The order now:
 *   1. a KNOWN PRICE decides package and terms, whatever the product is called.
 *      A payment that differs from the list price is noted for information
 *      (a coupon is normal) and does not hold anything up.
 *   2. a known PRODUCT on an unknown price (a new price on an old product):
 *      terms from that product's catalogue row; parked for review.
 *   3. the NAME, as before; parked for review, because an unrecognised price
 *      is exactly when a human should look at the terms.
 * null = not a program purchase at all (a photo payment, a bio video).
 */
export function programTermsFor(
  input: { priceId: string | null; productId: string | null; name: string; recurring: boolean; amountCents: number | null },
  catalogue: Record<string, CatalogueRow>,
): { terms: ProgramTerms; source: "price" | "product" | "name"; reviewNote: string | null; infoNote: string | null } | null {
  const known = input.priceId ? catalogue[input.priceId] ?? null : null;
  if (known) {
    const paid = input.amountCents ?? 0;
    return {
      terms: { package: known.package, billingType: known.billingType, billingMonths: known.billingMonths, guessed: false },
      source: "price",
      reviewNote: null,
      infoNote:
        paid === known.amountCents
          ? null
          : `Paid ${usd(paid)} against the list price of ${usd(known.amountCents)} (${paid < known.amountCents ? "a coupon or discount?" : "tax, or a price change?"}).`,
    };
  }
  const unrecognised = `Unrecognised price ${input.priceId ?? "(the checkout carried none)"}: it is not in the hub's list of program prices (STRIPE_PROGRAM_PRICES), so`;
  const sameProduct = input.productId ? Object.values(catalogue).find((p) => p.productId === input.productId) ?? null : null;
  if (sameProduct) {
    return {
      terms: { package: sameProduct.package, billingType: sameProduct.billingType, billingMonths: sameProduct.billingMonths, guessed: false },
      source: "product",
      reviewNote: `${unrecognised} the package and terms were taken from the product it belongs to ("${sameProduct.productName}"). Confirm them on the settings card, and add the price to the list.`,
      infoNote: null,
    };
  }
  const parsed = input.name ? parseProgramProduct(input.name, { recurring: input.recurring, amount: (input.amountCents ?? 0) / 100 }) : null;
  if (!parsed) return null;
  return {
    terms: parsed,
    source: "name",
    reviewNote: `${unrecognised} the package and terms were read from the product name "${input.name}". Confirm them on the settings card, and add the price to the list.`,
    infoNote: null,
  };
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : v?.id ?? null;

// How long a PROCESSING claim is trusted before another sweep may retry it —
// long enough for any single activation, short enough that a crashed run
// doesn't orphan the signup for a day.
const CLAIM_STALE_MS = 30 * 60_000;

/**
 * THE ONLY PAYMENT STATE THAT ACTIVATES A PROGRAM (CP-14, named Sep 24 2026).
 *
 * A checkout activates only when Stripe says `status: complete` AND
 * `payment_status: paid`. Everything else is left alone, deliberately:
 *   · `unpaid` — an ASYNCHRONOUS payment (a bank debit) still settling. It
 *     activates when Stripe flips it to paid: the poll sees the flip on its
 *     next pass, the webhook sees `checkout.session.async_payment_succeeded`.
 *   · `no_payment_required` — a $0 checkout: a 100% coupon, or a trial Stripe
 *     reports as nothing owed. Jordan, Sep 24: a $0 checkout does NOT start a
 *     program on its own. That was already the behaviour; this constant is
 *     where it is now written down, so a later edit has to change it on
 *     purpose rather than by loosening a comparison.
 */
export const ACTIVATING_PAYMENT_STATUS = "paid" as const;
export const isActivatingSession = (s: { status: string | null; payment_status: string | null }): boolean =>
  s.status === "complete" && s.payment_status === ACTIVATING_PAYMENT_STATUS;

/** How a signup was activated — stamped on ProgramSignup.activatedVia. */
export type ActivationVia = "poll" | "webhook" | "manual";
export type CheckoutOutcome =
  | "not_paid" // not complete + paid (unpaid async, $0, open, expired) — nothing written
  | "not_program" // a photo payment, a bio video: not ours
  | "known" // already activated, or another runner holds the claim
  | "activated"
  | "parked"; // activation failed — NEEDS_REVIEW, retried by the next pass

type ProductLookup = (id: string) => Promise<string>;
/** Product names, cached for one pass (a sweep may see the same product fifty times). */
function productLookup(): ProductLookup {
  const cache = new Map<string, string>();
  return async (id: string) => {
    if (cache.has(id)) return cache.get(id)!;
    const p = await stripeGet<{ id: string; name: string }>(`/products/${id}`, {});
    cache.set(id, p.name);
    return p.name;
  };
}

/**
 * Activate paid website signups. Idempotent (checkoutId unique = the claim);
 * safe to run hourly and from the Sync-now button, concurrently — and, since
 * CP-14, concurrently with the Stripe webhook receiver, which calls the same
 * processCheckoutSession below.
 */
/** Pages of 50 one poll reads — 250 checkouts, newest first. */
export const SWEEP_MAX_PAGES = 5;

export async function sweepStripeSignups(): Promise<{ scanned: number; activated: number; skippedKnown: number; parked: number; truncated: boolean }> {
  const since = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
  const sessions: StripeCheckoutSession[] = [];
  let startingAfter: string | null = null;
  // TRUNCATION IS REPORTED, NOT SWALLOWED (§6.1, Sep 25 2026). The loop used
  // to stop at page 5 and say nothing, so a month with more than 250 checkouts
  // would quietly leave its oldest unread. `truncated` lands in
  // CronRun.summary (every step's return value does) and on Sync-now.
  let truncated = false;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const q: Record<string, string | number | string[]> = {
      limit: 50,
      "created[gte]": since,
      "expand[]": ["data.line_items"],
    };
    if (startingAfter) q.starting_after = startingAfter;
    const res = await stripeGet<{ data: StripeCheckoutSession[]; has_more: boolean }>("/checkout/sessions", q);
    sessions.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    if (page === SWEEP_MAX_PAGES - 1) truncated = true;
    startingAfter = res.data[res.data.length - 1].id;
  }

  const lookup = productLookup();
  let scanned = 0, activated = 0, skippedKnown = 0, parked = 0;
  for (const s of sessions) {
    if (!isActivatingSession(s)) continue;
    scanned++;
    const outcome = await processCheckoutSession(s, "poll", lookup);
    if (outcome === "activated") activated++;
    else if (outcome === "known") skippedKnown++;
    else if (outcome === "parked") parked++;
  }
  return { scanned, activated, skippedKnown, parked, truncated };
}

/**
 * Fetch ONE checkout session from Stripe and process it. The webhook receiver
 * calls this with the id from the event and nothing else: the event body is
 * never trusted for what was bought (it carries no line items anyway), who
 * paid, or whether it is paid — Stripe's own record is read, exactly as the
 * poll reads it.
 */
export async function processCheckoutSessionById(checkoutId: string, via: ActivationVia, opts: { paidAt?: Date } = {}): Promise<CheckoutOutcome> {
  if (!/^cs_[A-Za-z0-9_]{6,200}$/.test(checkoutId)) throw new Error(`"${checkoutId.slice(0, 40)}" is not a Stripe checkout session id.`);
  const s = await stripeGet<StripeCheckoutSession>(`/checkout/sessions/${checkoutId}`, { "expand[]": ["line_items"] });
  return processCheckoutSession(s, via, productLookup(), opts);
}

/**
 * One checkout, start to finish: paid? ours? claim it, activate it, stamp how.
 * The loop body of the old sweep, lifted out so the poll, the webhook and a
 * staff replay share one path — the audit's requirement that a webhook and the
 * poll racing on one checkout create ONE enrollment, ONE seat, ONE welcome.
 */
export async function processCheckoutSession(
  s: StripeCheckoutSession,
  via: ActivationVia,
  lookupProduct: ProductLookup = productLookup(),
  opts: { paidAt?: Date } = {},
): Promise<CheckoutOutcome> {
  if (!isActivatingSession(s)) return "not_paid";

  // What was bought — first line item wins (the website sells one product
  // per checkout).
  let item = s.line_items?.data?.[0] ?? null;
  if (!item) {
    const full = await stripeGet<StripeCheckoutSession>(`/checkout/sessions/${s.id}`, { "expand[]": ["line_items"] }).catch(() => null);
    item = full?.line_items?.data?.[0] ?? null;
  }
  // PRICE FIRST (§6.1, Sep 25 2026) — programTermsFor above. A known price
  // needs no name at all, so it is not looked up; any other checkout reads
  // the product name exactly as before.
  const { STRIPE_PROGRAM_PRICES } = await import("@/lib/contentProgram");
  const priceId = item?.price?.id ?? null;
  const knownPrice = priceId ? STRIPE_PROGRAM_PRICES[priceId] ?? null : null;
  const productId = idOf(item?.price?.product ?? null) ?? knownPrice?.productId ?? null;
  if (!productId) return "not_program";
  const name =
    (typeof item?.price?.product === "object" && item?.price?.product?.name) ||
    item?.description ||
    (knownPrice ? knownPrice.productName : await lookupProduct(productId).catch(() => ""));
  const recurring = s.mode === "subscription";
  const amount = Math.round(((s.amount_total ?? 0) / 100) * 100) / 100;
  const resolved = programTermsFor({ priceId, productId, name, recurring, amountCents: s.amount_total }, STRIPE_PROGRAM_PRICES);
  if (!resolved) return "not_program"; // not a program product — a photo payment, a bio video, etc.
  const { terms } = resolved;
  // What the owner must confirm (parks the row NEEDS_REVIEW) vs what is only
  // worth knowing (kept on the row, holds nothing up).
  const termsNote = resolved.reviewNote ?? (terms.guessed ? `Billing terms guessed from "${name}" — confirm them on the settings card.` : null);

  const base = {
    subscriptionId: idOf(s.subscription),
    stripeCustomerId: idOf(s.customer),
    email: s.customer_details?.email?.trim() || null,
    name: s.customer_details?.name?.trim() || null,
    phone: s.customer_details?.phone?.trim() || null,
    productId,
    productName: name || productId,
    priceId,
    amount,
    recurring,
    // An asynchronous payment settles days after the checkout opened; the
    // webhook passes the settlement moment. The poll cannot know it and keeps
    // the checkout's own timestamp, as it always has.
    paidAt: opts.paidAt ?? new Date(s.created * 1000),
  };

  // --- THE CLAIM. createMany + skipDuplicates is INSERT … ON CONFLICT DO
  // NOTHING: exactly one runner inserts (count 1) and every other runner gets
  // count 0 — no unique-violation exception to catch. The old
  // create-then-catch did the same job, but read any failure at all as "the
  // other runner won", so a database blip on the insert was indistinguishable
  // from a duplicate. An earlier failed run left NEEDS_REVIEW (no enrollment)
  // or a stale PROCESSING row — retry those; a finished row (ACTIVATED, or
  // reviewed-with-enrollment) is done.
  let claimId: string;
  const inserted = await prisma.programSignup.createMany({ data: [{ checkoutId: s.id, ...base, status: "PROCESSING" }], skipDuplicates: true });
  const row = await prisma.programSignup.findUnique({
    where: { checkoutId: s.id },
    select: { id: true, status: true, enrollmentId: true, createdAt: true },
  });
  if (!row) return "parked"; // cannot happen after an insert; the next pass retries
  if (inserted.count === 1) {
    claimId = row.id;
  } else {
    const stale = row.status === "PROCESSING" && Date.now() - row.createdAt.getTime() > CLAIM_STALE_MS;
    const retryable = row.enrollmentId == null && (row.status === "NEEDS_REVIEW" || stale);
    if (!retryable) return "known";
    // Compare-and-set on the state we read: of two runners retrying one
    // NEEDS_REVIEW row, only one moves it to PROCESSING. (A stale PROCESSING
    // row has no such witness — two runners could both retry it, and both
    // would land on the same enrollment, seat and welcome, which are
    // idempotent in their own right.)
    const took = await prisma.programSignup.updateMany({
      where: { id: row.id, status: row.status, enrollmentId: null },
      data: { status: "PROCESSING", ...base },
    });
    if (took.count === 0) return "known";
    claimId = row.id;
  }

  try {
    const done = await activateSignup({ checkoutId: s.id, ...base, terms, termsNote });
    await prisma.programSignup.update({
      where: { id: claimId },
      data: {
        clientId: done.clientId,
        enrollmentId: done.enrollmentId,
        status: done.note ? "NEEDS_REVIEW" : "ACTIVATED",
        note: [done.note, resolved.infoNote].filter(Boolean).join(" ") || null,
        activatedVia: via,
      },
    });
    // Only the poll can witness a webhook that never came.
    if (via === "poll") await checkWebhookCoverage(s, base).catch(() => false);
    return "activated";
  } catch (e) {
    await prisma.programSignup
      .update({
        where: { id: claimId },
        data: { status: "NEEDS_REVIEW", note: `Activation failed: ${(e as Error).message.slice(0, 250)} — will retry.` },
      })
      .catch(() => {});
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "program_signup",
        title: `Website signup needs a look — ${base.name ?? base.email ?? "unknown buyer"}`,
        body: "Payment confirmed on Stripe but the hub couldn't activate it automatically. It'll keep retrying.",
        href: "/content",
        targets: [{ roles: ["OWNER"] }],
        dedupeKey: `signup-fail-${s.id}`,
      });
    } catch { /* bell is best-effort */ }
    return "parked";
  }
}

// ---------------------------------------------------------------------------
// WEBHOOK COVERAGE (unified handoff, Stripe webhook readiness, Sep 25 2026).
//
// The Sep 8 Aryeo lesson: a feed that stops talking is invisible when
// something else papers over it. Once the Stripe endpoint is registered the
// hourly poll will still activate every signup — so an endpoint that is dead
// (wrong secret, disabled by Stripe after days of failures) would look exactly
// like a healthy one. The poll is the only witness: a checkout it activates,
// old enough that Stripe had every chance to deliver it, with no WebhookEvent
// naming it, is a delivery that did not happen. One owner bell per checkout,
// and a running count the Connections card reads.
//
// Silent when no secret is saved: then the poll IS the path and nothing was
// missed. Also silent for a checkout opened before the secret was saved —
// Stripe had nowhere to send those.
// ---------------------------------------------------------------------------
export const WEBHOOK_MISSED_GRACE_MS = 15 * 60_000;
export const WEBHOOK_COVERAGE_KEY = "stripe-webhook-coverage";
type CoverageCounter = { missed: number; lastMissedAt: string | null; lastCheckoutId: string | null };

async function checkWebhookCoverage(s: StripeCheckoutSession, who: { name: string | null; email: string | null }): Promise<boolean> {
  const { stripeWebhookSecret } = await import("@/lib/stripeWebhook");
  if (!(await stripeWebhookSecret())) return false;
  const openedAt = s.created * 1000;
  if (Date.now() - openedAt < WEBHOOK_MISSED_GRACE_MS) return false;
  const conn = await prisma.connection.findUnique({ where: { provider: "stripe_webhook" }, select: { updatedAt: true, secretEncrypted: true } });
  if (conn?.secretEncrypted && openedAt < conn.updatedAt.getTime()) return false;
  // The receiver stores {id, type, objectId, …} — objectId IS the checkout id.
  // A REFUSED post keeps no body, so it does not count as delivered: a wrong
  // secret is exactly the failure this is here to notice.
  const delivered = await prisma.webhookEvent.count({ where: { provider: "stripe", status: { not: "REJECTED" }, payload: { contains: s.id } } });
  if (delivered > 0) return false;
  const dedupeKey = `stripe-webhook-missed:${s.id}`;
  if ((await prisma.notification.count({ where: { dedupeKey: { startsWith: dedupeKey } } })) > 0) return false;
  const { notifyInApp } = await import("@/lib/notify");
  await notifyInApp({
    kind: "program_signup",
    title: "Stripe did not deliver a checkout; the hourly poll activated it",
    // No amounts; a name so the owner can find it.
    body: `${who.name ?? who.email ?? "A buyer"}'s signup never reached the Stripe webhook. If this repeats, check the Stripe webhook card on Connections.`,
    href: "/connections",
    targets: [{ roles: ["OWNER"] }],
    dedupeKey,
  });
  // A read-modify-write, not a transaction: two sweeps missing two different
  // checkouts in the same instant could undercount by one. The count is a
  // headline for the card; the bells are the record.
  const prev = await prisma.appSetting.findUnique({ where: { key: WEBHOOK_COVERAGE_KEY }, select: { value: true } }).catch(() => null);
  let c: CoverageCounter = { missed: 0, lastMissedAt: null, lastCheckoutId: null };
  try { if (prev?.value) c = { ...c, ...(JSON.parse(prev.value) as Partial<CoverageCounter>) }; } catch { /* a hand-edited row restarts the count */ }
  const next = JSON.stringify({ missed: (Number(c.missed) || 0) + 1, lastMissedAt: new Date().toISOString(), lastCheckoutId: s.id } satisfies CoverageCounter);
  await prisma.appSetting.upsert({ where: { key: WEBHOOK_COVERAGE_KEY }, create: { key: WEBHOOK_COVERAGE_KEY, value: next }, update: { value: next } });
  return true;
}

/** Where Stripe posts, once registered. The hub's canonical host, never a preview deployment's. */
export const STRIPE_WEBHOOK_URL = "https://hub.realtourpilot.com/api/webhooks/stripe";

export type StripeWebhookStatus = {
  endpointUrl: string;
  events: string[];
  /** An encrypted secret is on the Connection row. */
  secretStored: boolean;
  /** …and it decrypts, which is what the receiver actually uses. */
  secretReadable: boolean;
  /** STRIPE_WEBHOOK_SECRET is set on this deployment (the receiver's second source). */
  envFallback: boolean;
  savedAt: string | null;
  lastProcessed: { at: string; type: string | null } | null;
  lastRejected: { at: string; code: string | null } | null;
  /** Signups activated in the last 30 days, by path. */
  pollOnly30d: number;
  webhook30d: number;
  missed: { count: number; lastAt: string | null };
};

/**
 * The /connections "Stripe webhook" card's facts. Database only — nothing here
 * calls Stripe, and the secret itself never leaves the server (only whether it
 * exists and decrypts).
 */
export async function stripeWebhookStatus(): Promise<StripeWebhookStatus> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [{ STRIPE_WEBHOOK_EVENTS }, { decodeRejection }] = await Promise.all([import("@/lib/stripeWebhook"), import("@/lib/webhookRetry")]);
  const [row, readable, processed, rejected, poll30, hook30, counter] = await Promise.all([
    prisma.connection.findUnique({ where: { provider: "stripe_webhook" }, select: { secretEncrypted: true, updatedAt: true } }),
    getSecret("stripe_webhook").catch(() => null),
    prisma.webhookEvent.findFirst({ where: { provider: "stripe", status: "PROCESSED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, eventType: true } }),
    prisma.webhookEvent.findFirst({ where: { provider: "stripe", status: "REJECTED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, error: true } }),
    prisma.programSignup.count({ where: { activatedVia: "poll", createdAt: { gte: since } } }),
    prisma.programSignup.count({ where: { activatedVia: "webhook", createdAt: { gte: since } } }),
    prisma.appSetting.findUnique({ where: { key: WEBHOOK_COVERAGE_KEY }, select: { value: true } }),
  ]);
  let missed = { count: 0, lastAt: null as string | null };
  try {
    if (counter?.value) {
      const c = JSON.parse(counter.value) as Partial<CoverageCounter>;
      missed = { count: Number(c.missed) || 0, lastAt: c.lastMissedAt ?? null };
    }
  } catch { /* unreadable → zero, said as zero */ }
  return {
    endpointUrl: STRIPE_WEBHOOK_URL,
    events: [...STRIPE_WEBHOOK_EVENTS],
    secretStored: Boolean(row?.secretEncrypted),
    secretReadable: Boolean(readable?.trim()),
    envFallback: Boolean(process.env.STRIPE_WEBHOOK_SECRET?.trim()),
    savedAt: row?.secretEncrypted ? row.updatedAt.toISOString() : null,
    lastProcessed: processed ? { at: processed.createdAt.toISOString(), type: processed.eventType } : null,
    lastRejected: rejected ? { at: rejected.createdAt.toISOString(), code: decodeRejection(rejected.error)?.code ?? null } : null,
    pollOnly30d: poll30,
    webhook30d: hook30,
    missed,
  };
}

/**
 * A conflict a machine must not resolve (§4.4 / A02). Two addresses, or two
 * people with one name, are routed to Kyle with the evidence — never merged,
 * never guessed. One task per checkout, reopened if somebody closed it early.
 */
async function routeIdentityConflict(input: { checkoutId: string; clientId: string | null; clientName: string; title: string; lines: string[] }): Promise<void> {
  const { isTestClientName } = await import("@/lib/testClients");
  if (isTestClientName(input.clientName)) return; // synthetic records make no real desk work
  const dedupeKey = `program-identity-conflict:${input.checkoutId}`;
  const description = [
    ...input.lines,
    "",
    "Do not merge these by hand in the database. Confirm with the client which address is theirs, then add the other one as a verified alias on their client page.",
  ].join("\n");
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true } }).catch(() => null);
  if (existing) {
    if (["DONE", "CLOSED", "CANCELLED"].includes(existing.status)) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { status: "OPEN", completedAt: null, description } }).catch(() => {});
    }
    return;
  }
  await prisma.smartTask
    .create({
      data: {
        title: input.title.slice(0, 140), description, summary: input.title.slice(0, 200),
        taskType: "todo", status: "OPEN", source: "content_program", priority: "HIGH",
        clientId: input.clientId, dedupeKey, assignedKey: "kyle",
        dueAt: new Date(Date.now() + 2 * 864e5),
        reasonCreated: "A paid signup and an existing record disagree about who this person is",
      },
    })
    .catch(() => {});
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "program_signup",
      title: input.title.slice(0, 90),
      body: "A paid signup does not line up with the records on file. Nothing was merged.",
      href: "/content",
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey,
    });
  } catch { /* bell is best-effort */ }
}

async function activateSignup(sig: {
  checkoutId: string; subscriptionId: string | null; stripeCustomerId: string | null;
  email: string | null; name: string | null; phone: string | null;
  productId: string; productName: string; priceId: string | null;
  amount: number; recurring: boolean; paidAt: Date;
  terms: ProgramTerms;
  /** What the owner must confirm about the terms themselves (unrecognised price, guessed terms). */
  termsNote: string | null;
}): Promise<{ clientId: string; enrollmentId: string; note: string | null }> {
  if (!sig.name && !sig.email) throw new Error("Checkout carried no name or email to build a client from.");
  const { PACKAGE_RULES } = await import("@/lib/contentProgram");
  const { lockAdvisory } = await import("@/lib/dbLocks");
  const rules = PACKAGE_RULES[sig.terms.package] ?? PACKAGE_RULES.Accelerator;

  // ---- FIND-OR-CREATE, ONE BUYER AT A TIME (A03(b), Sep 25 2026).
  // The claim above makes ONE checkout activate once. It did nothing for two
  // DIFFERENT checkouts from the same brand-new address (a double click on the
  // website, a retry after a card decline that went through twice): both found
  // no client, both created one — Client.email is not unique, and cannot be
  // made so on the live table — and the second enrollment then hit the unique
  // clientId and parked NEEDS_REVIEW on a second, orphaned client. A
  // transaction-scoped advisory lock on the buyer (dbLocks, with its ::int4
  // casts) makes the second one wait, find the first one's client, and take
  // the existing-enrollment path below, which says so on its signup row.
  // Everything inside uses `tx`; the desk task and bell for a namesake are
  // raised after COMMIT so they never hold the lock.
  const lockKey = `signup-client:${(sig.email || sig.name || "").trim().toLowerCase()}`;
  const held = await prisma.$transaction(
    async (tx) => {
      await lockAdvisory(tx, lockKey);
      // Anything the identity checks below want to say on the signup row.
      let identityNote: string | null = null;
      let namesakes: { id: string; name: string; email: string | null }[] = [];

      // --- Find the client: checkout email first; exact full-name second, but
      // ONLY a row whose email is blank or already matches — a same-name client
      // with a DIFFERENT email may be a different person, and a wrong merge is
      // worse than a duplicate the owner merges by hand. Oldest row wins so the
      // pick is deterministic when Aryeo made several stubs.
      let client =
        (sig.email
          ? await tx.client.findFirst({
              where: {
                OR: [
                  { email: { equals: sig.email, mode: "insensitive" } },
                  { backupEmail: { equals: sig.email, mode: "insensitive" } },
                ],
              },
              orderBy: { createdAt: "asc" },
              select: { id: true, name: true, email: true, backupEmail: true, phone: true },
            })
          : null) ??
        (sig.name
          ? await tx.client.findFirst({
              where: {
                name: { equals: sig.name.trim(), mode: "insensitive" },
                ...(sig.email ? { OR: [{ email: null }, { email: { equals: sig.email, mode: "insensitive" } }] } : { email: null }),
              },
              orderBy: { createdAt: "asc" },
              select: { id: true, name: true, email: true, backupEmail: true, phone: true },
            })
          : null);

      if (client) {
        // Enrich, never overwrite: the checkout's contact details fill blanks only.
        const patch: { email?: string; backupEmail?: string; phone?: string } = {};
        if (sig.email && !client.email) patch.email = sig.email;
        else if (sig.email && client.email && client.email.toLowerCase() !== sig.email.toLowerCase() && !client.backupEmail)
          patch.backupEmail = sig.email;
        if (sig.phone && !client.phone) patch.phone = sig.phone;
        if (Object.keys(patch).length) await tx.client.update({ where: { id: client.id }, data: patch });
      } else {
        // NEVER a name derived from the address (§4.4). When Stripe gave us no
        // name at all the row is created under the address itself and says so,
        // rather than inventing "Klciarmella" out of klciarmella@gmail.com.
        const displayName = sig.name?.trim() || `${sig.email} (name not given at checkout)`;
        // A same-name client on a DIFFERENT address is the A02 case: it may be the
        // same person paying from a brokerage address, or it may be two people. We
        // create the new record (a duplicate a human can merge beats a wrong merge
        // nobody can unpick) and hand Kyle the decision with both addresses.
        namesakes = sig.name
          ? await tx.client.findMany({
              where: { name: { equals: sig.name.trim(), mode: "insensitive" }, email: { not: null } },
              select: { id: true, name: true, email: true },
              take: 3,
            })
          : [];
        client = await tx.client.create({
          data: { name: displayName, email: sig.email, phone: sig.phone },
          select: { id: true, name: true, email: true, backupEmail: true, phone: true },
        });
        if (namesakes.length > 0) identityNote = "A client with this name already exists on a different address. Kyle has the decision; nothing was merged.";
      }

      // --- The enrollment. One per client; a payment on an already-enrolled
      // client updates status + fills blanks rather than duplicating.
      const existing = await tx.contentEnrollment.findUnique({ where: { clientId: client.id } });
      let enrollmentId: string;
      let note: string | null = sig.termsNote;
      if (identityNote) note = `${note ? note + " " : ""}${identityNote}`;
      if (!existing) {
        const created = await tx.contentEnrollment.create({
          data: {
            clientId: client.id,
            package: sig.terms.package,
            ...rules,
            status: "ACTIVE",
            statusManual: true, // the Aryeo flag sweep must never pause a paying web client
            packageSource: "website",
            billingType: sig.terms.billingType,
            billingRate: sig.amount,
            billingMonths: sig.terms.billingMonths,
            startedAt: sig.paidAt,
            notes: `Signed up on the website ${sig.paidAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })} — ${sig.productName}.`,
          },
          select: { id: true },
        });
        enrollmentId = created.id;
      } else {
        enrollmentId = existing.id;
        // A SECOND PAID CHECKOUT FOR A PROGRAM THAT IS ALREADY RUNNING (A03(b)).
        // Another signup row for this buyer — by enrollment, or by address
        // while the first is still mid-activation and has no enrollment on its
        // row yet — means this is money paid twice, or a deliberate second
        // purchase. Either way a person looks at Stripe; nothing is refunded
        // or credited here. A PAUSED/ENDED program restarting is not this.
        if (existing.status === "ACTIVE") {
          const other = await tx.programSignup.findFirst({
            where: {
              checkoutId: { not: sig.checkoutId },
              OR: [{ enrollmentId: existing.id }, ...(sig.email ? [{ email: { equals: sig.email, mode: "insensitive" as const } }] : [])],
            },
            orderBy: { createdAt: "asc" },
            select: { checkoutId: true },
          });
          if (other) {
            note = `${note ? note + " " : ""}This client already had an active program (existing enrollment, from an earlier checkout ${other.checkoutId}) when this one was paid: a renewal, an upgrade or a double payment. Check Stripe before anything is refunded or credited.`;
          }
        }
        // Reactivate + FILL BLANKS ONLY. The owner hand-entered billing terms for
        // the founding clients — a checkout must never rewrite those; a mismatch
        // is recorded on the signup row for a human instead of silently resolved.
        if (existing.package !== sig.terms.package && existing.packageSource !== "aryeo") {
          note = `${note ? note + " " : ""}Paid for ${sig.terms.package} but the enrollment is set to ${existing.package} — left as-is, check the settings card.`;
        }
        const billingBlank = existing.billingType == null;
        if (!billingBlank && existing.billingType !== sig.terms.billingType) {
          note = `${note ? note + " " : ""}Checkout terms (${sig.terms.billingType}) differ from the terms on file (${existing.billingType}) — billing left as the owner entered it.`;
        }
        await tx.contentEnrollment.update({
          where: { id: existing.id },
          data: {
            status: "ACTIVE",
            statusManual: true,
            ...(existing.packageSource === "aryeo" ? { package: sig.terms.package, ...rules, packageSource: "website" } : {}),
            ...(billingBlank
              ? { billingType: sig.terms.billingType, billingRate: sig.amount, billingMonths: sig.terms.billingMonths }
              : {}),
            startedAt: existing.startedAt ?? sig.paidAt,
          },
        });
      }
      return { client, enrollmentId, note, namesakes };
    },
    // The second buyer waits on the lock for as long as the first holds it —
    // a handful of reads and writes — so these are generous, not tight.
    { maxWait: 10_000, timeout: 20_000 },
  );
  const { client, enrollmentId, namesakes } = held;
  let note = held.note;
  if (namesakes.length > 0) {
    await routeIdentityConflict({
      checkoutId: sig.checkoutId,
      clientId: client.id,
      clientName: client.name,
      title: `Two records for ${sig.name} after a paid signup`,
      lines: [
        `A Content Program checkout was paid by ${sig.name} <${sig.email ?? "no email"}>.`,
        `${namesakes.length} existing client record(s) carry that same name on a different address:`,
        ...namesakes.map((n) => `  · ${n.name} <${n.email}> (client ${n.id})`),
        "",
        `A new client record was created (${client.id}) and the program was set up on it. Nothing was merged.`,
      ],
    });
  }

  // The month workspace, immediately — the hourly pass would also catch it,
  // but the owner clicking the bell should land on a live workspace.
  const { ensureCurrentMonths } = await import("@/lib/contentProgram");
  await ensureCurrentMonths().catch(() => {});

  // ---- DISCOVERY FIRST, THEN ACCESS (CP-14, Sep 24 2026). The two blocks
  // below used to run the other way round, and the audit's own acceptance case
  // failed on it: a client who booked discovery before the payment was polled
  // had their welcome composed while the booking was still unmatched (no
  // ACTIVE enrollment existed for the matcher to find), so it told them to
  // book the call they had booked, and Kyle got a task to chase it. Now the
  // booking is re-matched against the new enrollment, the onboarding record
  // and Kyle's task read it, and only THEN is the welcome composed — from
  // what is actually on file. (While `portal_invites` is off the welcome is
  // held and composed at release, which reads the same facts.)
  try {
    const { rematchDiscoveryForClient } = await import("@/lib/contentCallRecords");
    await rematchDiscoveryForClient(client.id);
  } catch { /* the sync's next pass matches it; nothing here depends on it succeeding */ }

  // ---- DISCOVERY, IN EITHER ORDER (§4.3). Payment may land before the call
  // is booked or after it; both arrive here, and both are idempotent. This
  // links a booking that already exists, clears the "book the discovery call"
  // task when it does, raises it when it does not, and routes a payer/invitee
  // address mismatch to Kyle rather than merging it.
  const discovery = await (async () => {
    try {
      const { onProgramActivated } = await import("@/lib/programOnboarding");
      return await onProgramActivated(enrollmentId, { payerEmail: sig.email, payerName: sig.name, checkoutId: sig.checkoutId });
    } catch (e) {
      return { outcome: "error" as const, detail: e instanceof Error ? e.message : String(e) };
    }
  })();

  // ---- ACCOUNT ACCESS (F02 / §4.1, Sep 21 2026). Until today the chain
  // stopped at the enrollment, and Phase 0 measured what that meant on live
  // data: three verified buyers, zero seats, no welcome ever composed. The
  // grant is idempotent on (enrollment, email), so the hourly poll, a retry
  // and a future Stripe webhook can all run it without a second account or a
  // second welcome. While `portal_invites` is off it creates nothing and
  // records the debt instead — Jordan has not authorised client invitations.
  let access: string;
  if (sig.email) {
    const { grantProgramAccess } = await import("@/lib/portalAccess");
    const g = await grantProgramAccess({
      enrollmentId, emailRaw: sig.email,
      // The buyer's real name as Stripe captured it, or nothing. Never the
      // email's local part (§4.4).
      name: sig.name, role: "OWNER", reason: "welcome", requestedBy: "stripe-signup",
    }).catch((e: unknown) => ({ outcome: "CONFLICT" as const, note: e instanceof Error ? e.message : "access grant failed" }));
    access = g.outcome === "GRANTED" ? `access granted (welcome ${g.welcome})` : g.outcome === "HELD" ? "access HELD (invitations are off)" : `access needs a person: ${g.note}`;
    if (g.outcome === "CONFLICT") note = `${note ? note + " " : ""}${g.note}`;
  } else {
    access = "no checkout email — no account could be opened";
    note = `${note ? note + " " : ""}The checkout carried no email address, so there is nobody to open an account for.`;
  }

  console.info(`[signup] ${sig.checkoutId}: ${access}; discovery ${discovery.outcome}${"detail" in discovery && discovery.detail ? ` (${discovery.detail})` : ""}`);
  if (discovery.outcome === "conflict" && "detail" in discovery && discovery.detail) note = `${note ? note + " " : ""}${discovery.detail}`;

  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "program_signup",
      title: `New Content Program signup — ${client.name}`,
      // Package only. NO dollar amounts and no billing TERM: this bell reaches
      // ADMIN, and how a client pays is owner-only — the full terms are on the
      // enrollment card's owner block.
      body: `Video ${sig.terms.package} · signed up on the website${note ? " · needs a look" : ""}`,
      href: `/content/${enrollmentId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `signup-${sig.checkoutId}`,
    });
  } catch { /* bell is best-effort */ }

  await prisma.auditLog
    .create({
      data: {
        actor: "system:stripe-signup",
        action: "content_enrollment_activated",
        target: client.email ?? client.name,
        detail: `${client.name} · ${sig.productName} · checkout ${sig.checkoutId}`,
      },
    })
    .catch(() => {});

  return { clientId: client.id, enrollmentId, note };
}

/** NEEDS_REVIEW signups for the owner's /content strip. */
export async function signupsNeedingReview(): Promise<
  { id: string; name: string | null; email: string | null; productName: string; note: string | null; paidAt: Date; enrollmentId: string | null }[]
> {
  return prisma.programSignup.findMany({
    where: { status: "NEEDS_REVIEW" },
    orderBy: { paidAt: "desc" },
    take: 10,
    select: { id: true, name: true, email: true, productName: true, note: true, paidAt: true, enrollmentId: true },
  });
}

/** Mark a reviewed signup as handled (owner clicked "Got it"). */
export async function resolveSignupReview(id: string): Promise<void> {
  await prisma.programSignup.update({ where: { id }, data: { status: "ACTIVATED" } }).catch(() => {});
}

/**
 * Watch activated subscriptions for lapses. A canceled / unpaid / past-due
 * subscription rings the OWNER once per state change — it never auto-pauses
 * the enrollment (ending service over a card hiccup is Jordan's call).
 */
export async function sweepSubscriptionHealth(): Promise<{ checked: number; alerts: number }> {
  const rows = await prisma.programSignup.findMany({
    where: { subscriptionId: { not: null }, enrollmentId: { not: null } },
    orderBy: { paidAt: "desc" },
    take: 25,
    select: { subscriptionId: true },
  });
  let checked = 0, alerts = 0;
  for (const r of rows) {
    const c = await checkSubscription(r.subscriptionId!).catch(() => null);
    if (!c) continue;
    checked++;
    if (c.alerted) alerts++;
  }
  return { checked, alerts };
}

const LAPSED = ["canceled", "unpaid", "past_due", "incomplete_expired"];

/**
 * One subscription, read from Stripe (never from an event body): ring the
 * owner once per lapsed state, and record the billing anchor. Shared by the
 * hourly health sweep and the webhook's `customer.subscription.*` events
 * (CP-14). null = not a program subscription we activated.
 *
 * The anchor is recorded, never acted on: billing stays on its Stripe
 * anniversary, production runs by ET calendar month (ensureCurrentMonths),
 * and nothing in the hub writes to Stripe.
 */
export async function checkSubscription(subscriptionId: string): Promise<{ status: string; alerted: boolean } | null> {
  const r = await prisma.programSignup.findFirst({
    where: { subscriptionId, enrollmentId: { not: null } },
    orderBy: { paidAt: "desc" },
    select: { name: true, email: true, enrollmentId: true },
  });
  if (!r) return null;
  const sub = await stripeGet<{ id: string; status: string; billing_cycle_anchor?: number | null }>(`/subscriptions/${subscriptionId}`, {});
  if (typeof sub.billing_cycle_anchor === "number") {
    await prisma.programSignup.updateMany({ where: { subscriptionId }, data: { billingAnchorAt: new Date(sub.billing_cycle_anchor * 1000) } }).catch(() => {});
  }
  let alerted = false;
  if (LAPSED.includes(sub.status)) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "program_signup",
        title: `Content subscription ${sub.status.replace("_", " ")} — ${r.name ?? r.email ?? "client"}`,
        body: "Stripe reports the monthly plan lapsed. The enrollment stays active until you pause it.",
        href: `/content/${r.enrollmentId}`,
        targets: [{ roles: ["OWNER"] }],
        dedupeKey: `sub-${subscriptionId}-${sub.status}`,
      });
      alerted = true;
    } catch { /* bell is best-effort */ }
  }
  return { status: sub.status, alerted };
}
