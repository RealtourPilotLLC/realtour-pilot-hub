import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// STRIPE → HUB (CP-14, Sep 24 2026). BUILT AND DRILLED, NOT REGISTERED.
//
// Signup activation is by POLLING (stripeSignups.sweepStripeSignups, hourly at
// :00 and on /content "Sync now"). This receiver only makes it faster, and only
// once Jordan registers the endpoint in his Stripe dashboard and saves its
// signing secret — both his to do; nothing here registers anything.
//
//   no secret saved   → 401, a REJECTED row (no-secret), nothing read
//   bad signature     → 400, a REJECTED row (bad-signature), nothing read
//   verified          → a WebhookEvent row holding ONLY the event's identity
//                       ({id, type, objectId, livemode, created}); Stripe's
//                       own record is re-read for everything else
//   already processed → 200, nothing done twice (Stripe re-delivers)
//   handler failure   → 200 with the row ERROR; webhookRetry replays it
//
// A refused Stripe post is NOT stored: its body is a customer's email and an
// amount, the post is by definition unauthenticated, and the "test a secret
// against the last rejection" tool on /connections cannot replay Stripe's
// `t.<body>` scheme anyway. The header and the refusal reason are kept.
// ---------------------------------------------------------------------------

const HEADER = "stripe-signature";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const { stripeWebhookSecret, verifyStripeSignature, summarizeStripeEvent, handleStripeEvent } = await import("@/lib/stripeWebhook");
  const { refuseWebhook } = await import("@/lib/webhookRetry");
  const presented = req.headers.get(HEADER);

  const secret = await stripeWebhookSecret();
  if (!secret) {
    await refuseWebhook("stripe", { code: "no-secret", header: HEADER, sig: presented, alert: false });
    return NextResponse.json({ error: "Unverified" }, { status: 401 });
  }
  const check = verifyStripeSignature(raw, presented, secret);
  if (!check.ok) {
    await refuseWebhook("stripe", { code: "bad-signature", header: HEADER, sig: presented, alert: false });
    // The reason goes to the stored row, not to the caller (RTP-28): a refused
    // post is unauthenticated.
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* not JSON — refused below */ }
  const ev = summarizeStripeEvent(body);
  if (!ev) return NextResponse.json({ error: "Not a Stripe event" }, { status: 400 });

  // Stripe delivers at least once. A second copy of an event we already
  // processed is acknowledged and dropped here; one that is still ERROR is
  // processed again (it is the same thing the retry would do).
  const done = await prisma.webhookEvent.findFirst({ where: { provider: "stripe", externalId: ev.id, status: "PROCESSED" }, select: { id: true } }).catch(() => null);
  if (done) return NextResponse.json({ ok: true, duplicate: true });

  const row = await prisma.webhookEvent
    .create({ data: { provider: "stripe", eventType: ev.type, externalId: ev.id, payload: JSON.stringify(ev) }, select: { id: true } })
    .catch(() => null);
  try {
    const r = await handleStripeEvent(ev);
    if (row) {
      await prisma.webhookEvent
        .update({ where: { id: row.id }, data: { status: "PROCESSED", processedAt: new Date(), error: r.outcome === "ignored" && r.detail ? `ignored: ${r.detail}`.slice(0, 200) : null } })
        .catch(() => {});
    }
    return NextResponse.json({ ok: true, outcome: r.outcome });
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    if (row) await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "ERROR", error: message } }).catch(() => {});
    // 200: our retry loop owns it, and a 5xx would only have Stripe resend an
    // event the hourly poll will cover anyway.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
