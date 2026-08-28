import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";

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
//                   billing terms parsed from the product name
//                 → current-month workspace
//                 → owner/admin bell (package only — no dollar amounts, no
//                   billing term; how a client pays is owner-only)
//
// Polling, not a webhook, on purpose: the hub's restricted read key can see
// checkout sessions but registering a webhook endpoint writes to the Stripe
// account, and the hourly cron + Sync-now button already give the freshness
// this flow needs. Reading Stripe's ledger IS the "verified by Stripe" truth
// the spec demands — the browser redirect is never consulted.
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

type SessionRow = {
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

// The program's catalog, by name convention. Everything else Stripe sells
// (photo shoots, biography videos, brand launch sessions) is NOT a recurring
// program signup and is left alone.
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

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : v?.id ?? null;

// How long a PROCESSING claim is trusted before another sweep may retry it —
// long enough for any single activation, short enough that a crashed run
// doesn't orphan the signup for a day.
const CLAIM_STALE_MS = 30 * 60_000;

/**
 * Activate paid website signups. Idempotent (checkoutId unique = the claim);
 * safe to run hourly and from the Sync-now button, concurrently.
 */
export async function sweepStripeSignups(): Promise<{ scanned: number; activated: number; skippedKnown: number; parked: number }> {
  const since = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
  const sessions: SessionRow[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < 5; page++) {
    const q: Record<string, string | number | string[]> = {
      limit: 50,
      "created[gte]": since,
      "expand[]": ["data.line_items"],
    };
    if (startingAfter) q.starting_after = startingAfter;
    const res = await stripeGet<{ data: SessionRow[]; has_more: boolean }>("/checkout/sessions", q);
    sessions.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }

  const productName = new Map<string, string>();
  const lookupProduct = async (id: string): Promise<string> => {
    if (productName.has(id)) return productName.get(id)!;
    const p = await stripeGet<{ id: string; name: string }>(`/products/${id}`, {});
    productName.set(id, p.name);
    return p.name;
  };

  let scanned = 0, activated = 0, skippedKnown = 0, parked = 0;
  for (const s of sessions) {
    if (s.status !== "complete" || s.payment_status !== "paid") continue;
    scanned++;

    // What was bought — first line item wins (the website sells one product
    // per checkout).
    let item = s.line_items?.data?.[0] ?? null;
    if (!item) {
      const full = await stripeGet<SessionRow>(`/checkout/sessions/${s.id}`, { "expand[]": ["line_items"] }).catch(() => null);
      item = full?.line_items?.data?.[0] ?? null;
    }
    const productId = idOf(item?.price?.product ?? null);
    if (!productId) continue;
    const name =
      (typeof item?.price?.product === "object" && item?.price?.product?.name) ||
      item?.description ||
      (await lookupProduct(productId).catch(() => ""));
    const recurring = s.mode === "subscription";
    const amount = Math.round(((s.amount_total ?? 0) / 100) * 100) / 100;
    const terms = name ? parseProgramProduct(name, { recurring, amount }) : null;
    if (!terms) continue; // not a program product — a photo payment, a bio video, etc.

    const base = {
      subscriptionId: idOf(s.subscription),
      stripeCustomerId: idOf(s.customer),
      email: s.customer_details?.email?.trim() || null,
      name: s.customer_details?.name?.trim() || null,
      phone: s.customer_details?.phone?.trim() || null,
      productId,
      productName: name || productId,
      priceId: item?.price?.id ?? null,
      amount,
      recurring,
      paidAt: new Date(s.created * 1000),
    };

    // --- THE CLAIM. Creating the row IS the lock: a concurrent runner's
    // create hits the unique checkoutId and bows out. An earlier failed run
    // left NEEDS_REVIEW (no enrollment) or a stale PROCESSING row — retry
    // those; a finished row (ACTIVATED, or reviewed-with-enrollment) is done.
    let claimId: string;
    try {
      const claim = await prisma.programSignup.create({
        data: { checkoutId: s.id, ...base, status: "PROCESSING" },
        select: { id: true },
      });
      claimId = claim.id;
    } catch {
      const row = await prisma.programSignup.findUnique({
        where: { checkoutId: s.id },
        select: { id: true, status: true, enrollmentId: true, createdAt: true },
      });
      if (!row) continue; // create failed for a non-duplicate reason — next sweep retries
      const retryable =
        row.enrollmentId == null &&
        (row.status === "NEEDS_REVIEW" ||
          (row.status === "PROCESSING" && Date.now() - row.createdAt.getTime() > CLAIM_STALE_MS));
      if (!retryable) { skippedKnown++; continue; }
      claimId = row.id;
      await prisma.programSignup.update({ where: { id: row.id }, data: { status: "PROCESSING", ...base } });
    }

    try {
      const done = await activateSignup({ checkoutId: s.id, ...base, terms });
      await prisma.programSignup.update({
        where: { id: claimId },
        data: {
          clientId: done.clientId,
          enrollmentId: done.enrollmentId,
          status: done.note ? "NEEDS_REVIEW" : "ACTIVATED",
          note: done.note,
        },
      });
      activated++;
    } catch (e) {
      parked++;
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
    }
  }
  return { scanned, activated, skippedKnown, parked };
}

async function activateSignup(sig: {
  checkoutId: string; subscriptionId: string | null; stripeCustomerId: string | null;
  email: string | null; name: string | null; phone: string | null;
  productId: string; productName: string; priceId: string | null;
  amount: number; recurring: boolean; paidAt: Date;
  terms: NonNullable<ReturnType<typeof parseProgramProduct>>;
}): Promise<{ clientId: string; enrollmentId: string; note: string | null }> {
  // --- Find the client: checkout email first; exact full-name second, but
  // ONLY a row whose email is blank or already matches — a same-name client
  // with a DIFFERENT email may be a different person, and a wrong merge is
  // worse than a duplicate the owner merges by hand. Oldest row wins so the
  // pick is deterministic when Aryeo made several stubs.
  let client =
    (sig.email
      ? await prisma.client.findFirst({
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
      ? await prisma.client.findFirst({
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
    if (Object.keys(patch).length) await prisma.client.update({ where: { id: client.id }, data: patch });
  } else {
    if (!sig.name && !sig.email) throw new Error("Checkout carried no name or email to build a client from.");
    client = await prisma.client.create({
      data: { name: sig.name ?? sig.email!, email: sig.email, phone: sig.phone },
      select: { id: true, name: true, email: true, backupEmail: true, phone: true },
    });
  }

  // --- The enrollment. One per client; a payment on an already-enrolled
  // client updates status + fills blanks rather than duplicating.
  const { PACKAGE_RULES } = await import("@/lib/contentProgram");
  const rules = PACKAGE_RULES[sig.terms.package] ?? PACKAGE_RULES.Accelerator;
  const existing = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id } });
  let enrollmentId: string;
  let note: string | null = sig.terms.guessed
    ? `Billing terms guessed from "${sig.productName}" — confirm them on the settings card.`
    : null;
  if (!existing) {
    const created = await prisma.contentEnrollment.create({
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
    await prisma.contentEnrollment.update({
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

  // The month workspace, immediately — the hourly pass would also catch it,
  // but the owner clicking the bell should land on a live workspace.
  const { ensureCurrentMonths } = await import("@/lib/contentProgram");
  await ensureCurrentMonths().catch(() => {});

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
    select: { id: true, subscriptionId: true, name: true, email: true, enrollmentId: true },
  });
  let checked = 0, alerts = 0;
  for (const r of rows) {
    const sub = await stripeGet<{ id: string; status: string }>(`/subscriptions/${r.subscriptionId}`, {}).catch(() => null);
    if (!sub) continue;
    checked++;
    if (["canceled", "unpaid", "past_due", "incomplete_expired"].includes(sub.status)) {
      try {
        const { notifyInApp } = await import("@/lib/notify");
        await notifyInApp({
          kind: "program_signup",
          title: `Content subscription ${sub.status.replace("_", " ")} — ${r.name ?? r.email ?? "client"}`,
          body: "Stripe reports the monthly plan lapsed. The enrollment stays active until you pause it.",
          href: `/content/${r.enrollmentId}`,
          targets: [{ roles: ["OWNER"] }],
          dedupeKey: `sub-${r.subscriptionId}-${sub.status}`,
        });
        alerts++;
      } catch { /* bell is best-effort */ }
    }
  }
  return { checked, alerts };
}
