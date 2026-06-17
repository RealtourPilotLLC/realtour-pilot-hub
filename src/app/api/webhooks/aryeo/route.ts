import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getConnection } from "@/lib/integrations/connections";
import { Aryeo, syncAryeoOrders } from "@/lib/integrations/aryeo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives Aryeo webhooks (order fulfilled, customer created, invoice paid,
// media delivered, …). Logs every event for audit/replay, verifies the
// signature when a webhook secret is configured, then processes known events.
export async function POST(req: NextRequest) {
  const raw = await req.text();

  // Optional signature verification (HMAC-SHA256 of the raw body).
  const conn = await getConnection("aryeo");
  const secret = conn?.webhookSecret;
  if (secret) {
    const sig =
      req.headers.get("x-aryeo-signature") ||
      req.headers.get("x-signature") ||
      req.headers.get("aryeo-signature") ||
      "";
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const provided = sig.replace(/^sha256=/, "");
    const ok =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    /* keep empty */
  }

  const eventType =
    (payload.event as string) ||
    (payload.type as string) ||
    (payload.topic as string) ||
    "unknown";
  const externalId =
    (payload.id as string) || (payload.event_id as string) || undefined;

  // Idempotency: skip if we've already processed this event id.
  if (externalId) {
    const seen = await prisma.webhookEvent.findFirst({
      where: { provider: "aryeo", externalId, status: "PROCESSED" },
    });
    if (seen) return NextResponse.json({ ok: true, deduped: true });
  }

  const log = await prisma.webhookEvent.create({
    data: { provider: "aryeo", eventType, externalId, payload: raw || "{}" },
  });

  try {
    await processAryeoEvent(eventType, payload);
    await prisma.webhookEvent.update({
      where: { id: log.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  } catch (e) {
    await prisma.webhookEvent.update({
      where: { id: log.id },
      data: { status: "ERROR", error: e instanceof Error ? e.message : String(e) },
    });
    // Still 200 so Aryeo doesn't hammer retries for a processing bug we'll fix.
  }

  return NextResponse.json({ ok: true });
}

// Pull the affected order id out of a few likely payload shapes.
function orderIdFrom(payload: Record<string, unknown>): string | undefined {
  const data = (payload.data ?? payload.resource ?? payload) as Record<string, unknown>;
  return (
    (data.order_id as string) ||
    (data.id as string) ||
    ((data.order as Record<string, unknown>)?.id as string) ||
    undefined
  );
}

async function processAryeoEvent(eventType: string, payload: Record<string, unknown>) {
  const type = eventType.toLowerCase();

  // Media delivered / order fulfilled → mark the matching project Delivered.
  if (type.includes("fulfil") || type.includes("media") || type.includes("deliver")) {
    const orderId = orderIdFrom(payload);
    if (orderId) {
      const project = await prisma.project.findUnique({ where: { aryeoOrderId: orderId } });
      if (project && project.status !== "DELIVERED") {
        await prisma.project.update({
          where: { id: project.id },
          data: { status: "DELIVERED", deliveredAt: new Date() },
        });
        await prisma.activity.create({
          data: { projectId: project.id, type: "SYSTEM", body: `Aryeo: ${eventType} → marked Delivered.` },
        });
      }
    }
    return;
  }

  // New/updated order or customer → re-sync (creates or refreshes records).
  if (type.includes("order") || type.includes("customer") || type.includes("invoice")) {
    const orderId = orderIdFrom(payload);
    if (orderId) {
      // Fetch the single order and let the sync upsert path handle it.
      try {
        await Aryeo.order(orderId);
      } catch {
        /* fall through to full sync */
      }
    }
    await syncAryeoOrders();
    return;
  }
}

// Lightweight GET so you can confirm the endpoint is reachable in a browser.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "aryeo-webhook" });
}
