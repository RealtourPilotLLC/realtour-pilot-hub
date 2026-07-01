import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getConnection } from "@/lib/integrations/connections";
import { Aryeo, syncAryeoOrders, syncAryeoAppointments, syncAryeoSocialPlans, syncAryeoCustomers } from "@/lib/integrations/aryeo";
import { syncClientSegments } from "@/lib/segmentSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives Aryeo webhooks (order fulfilled, customer created, invoice paid,
// media delivered, …). Logs every event for audit/replay, verifies the
// signature when a webhook secret is configured, then processes known events.
export async function POST(req: NextRequest) {
  const raw = await req.text();

  // Optional signature verification (HMAC-SHA256 of the raw body). Aryeo signs
  // with a header literally named `Signature` (see docs: "Setting Up Webhooks").
  // Verification only runs if we've configured a webhookSecret on the Connection;
  // it's safe to leave off because processAryeoEvent never trusts the payload's
  // contents — it re-fetches the authoritative record from Aryeo's API.
  const conn = await getConnection("aryeo");
  const secret = conn?.webhookSecret;
  if (secret) {
    const sig =
      req.headers.get("signature") ||
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
      // Log the rejection so a real-but-mismatched Aryeo signature is VISIBLE
      // (rather than a silent 401 with no trace) — makes a signing-format
      // mismatch diagnosable. Best-effort; never block the response on it.
      try {
        await prisma.webhookEvent.create({
          data: { provider: "aryeo", eventType: "signature.rejected", status: "REJECTED", payload: (raw || "{}").slice(0, 2000) },
        });
      } catch { /* ignore */ }
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    /* keep empty */
  }

  // Real Aryeo activity payload is { object:"ACTIVITY", id, name:"ORDER_FULFILLED",
  // occurred_at, resource:{ object:"ORDER", id } }. `name` is the event; `id` is
  // the activity id (used for idempotency). Fall back to older shapes too.
  const eventType =
    (payload.name as string) ||
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

// The activity's subject — { object:"ORDER"|"LISTING"|"APPOINTMENT"|"CUSTOMER", id }.
// Falls back to older/flat payload shapes.
function resourceFrom(payload: Record<string, unknown>): { object: string; id?: string } {
  const r = (payload.resource ?? payload.data ?? {}) as Record<string, unknown>;
  const object = String((r.object as string) || (payload.resource_type as string) || "").toUpperCase();
  const id =
    (r.id as string) ||
    (r.order_id as string) ||
    (payload.resource_id as string) ||
    ((r.order as Record<string, unknown>)?.id as string) ||
    undefined;
  return { object, id };
}

async function restatusProject(projectId: string) {
  const { syncProjectStatuses } = await import("@/lib/projectStatus");
  await syncProjectStatuses({ projectId });
}

// Capture/reconcile this project's tasks at event time (new order → confirmation
// task; delivered gallery → QC/deliver tasks flip) instead of waiting for the
// hourly cron. Best-effort — never block the webhook on it.
async function retaskProject(projectId: string) {
  try {
    const { generateTasksForProject } = await import("@/lib/tasks");
    await generateTasksForProject(projectId);
  } catch { /* non-fatal */ }
}

// Routes a real Aryeo activity. Aryeo's webhook API is create-only (no list /
// delete), and the verified event names are: ORDER_CREATED/FULFILLED/PAID,
// LISTING_UPDATED, APPOINTMENT_SCHEDULED/ASSIGNED/RESCHEDULED/CANCELED,
// CUSTOMER_CREATED/UPDATED. We route on the resource type first, then the verb,
// and always re-fetch authoritative data from Aryeo rather than trusting the body.
export async function processAryeoEvent(eventType: string, payload: Record<string, unknown>) {
  const name = eventType.toUpperCase();
  const { object, id } = resourceFrom(payload);

  // ORDER_* — new order, fulfilled (delivery), or paid (billing). Re-fetch the
  // single order, refresh the order table, and on a fulfil/deliver/paid event
  // re-run the smart status engine for that project (cross-checks real media).
  if (object === "ORDER" || name.startsWith("ORDER")) {
    if (id) { try { await Aryeo.order(id); } catch { /* fall through to full sync */ } }
    await syncAryeoOrders();
    if (id) {
      const project = await prisma.project.findUnique({ where: { aryeoOrderId: id }, select: { id: true } });
      if (project) {
        // A fulfil/deliver/paid event means real media may have landed — re-check
        // status first so QC/delivery tasks reconcile against what's now live.
        if (name.includes("FULFIL") || name.includes("DELIVER") || name.includes("PAID")) {
          try { await restatusProject(project.id); } catch { /* non-fatal */ }
        }
        // Any order event (incl. CREATED) → (re)generate this job's tasks now:
        // a new order gets its confirmation task without waiting for the cron.
        await retaskProject(project.id);
      }
    }
    try { await syncClientSegments(); } catch { /* non-fatal */ }
    return;
  }

  // LISTING_* — media/listing changed. Re-check that project's status live so a
  // delivered gallery or added media flows through immediately, then reconcile
  // its tasks (QC closes as each category goes live).
  if (object === "LISTING" || name.startsWith("LISTING")) {
    if (id) {
      const project = await prisma.project.findFirst({ where: { aryeoListingId: id }, select: { id: true } });
      if (project) {
        try { await restatusProject(project.id); } catch { /* non-fatal */ }
        await retaskProject(project.id);
        return;
      }
    }
    await syncAryeoOrders(); // listing may not be linked yet — refresh orders
    return;
  }

  // APPOINTMENT_* — scheduled / assigned / rescheduled / canceled. Refresh the
  // appointment-driven schedule + morning brief, then orders so the shoot date follows.
  if (object === "APPOINTMENT" || name.startsWith("APPOINTMENT")) {
    try { await syncAryeoAppointments(); } catch { /* non-fatal */ }
    await syncAryeoOrders();
    return;
  }

  // CUSTOMER_* (or USER) — new/updated client. Re-enrich, re-score segments, and
  // refresh social-content plans. Each only writes the rows that actually changed.
  if (object === "CUSTOMER" || object === "USER" || name.startsWith("CUSTOMER")) {
    try { await syncAryeoCustomers(); } catch { /* non-fatal */ }
    try { await syncClientSegments(); } catch { /* non-fatal */ }
    try { await syncAryeoSocialPlans(); } catch { /* non-fatal */ }
    return;
  }

  // Unknown / legacy shape — fall back to substring routing so nothing is dropped.
  const type = name.toLowerCase();
  if (type.includes("fulfil") || type.includes("media") || type.includes("deliver")) {
    if (id) {
      const project = await prisma.project.findUnique({ where: { aryeoOrderId: id }, select: { id: true } });
      if (project) { try { await restatusProject(project.id); } catch { /* non-fatal */ } }
    }
    return;
  }
  if (type.includes("appointment") || type.includes("schedul") || type.includes("booking")) {
    try { await syncAryeoAppointments(); } catch { /* non-fatal */ }
    await syncAryeoOrders();
    return;
  }
  if (type.includes("order") || type.includes("customer") || type.includes("invoice")) {
    if (id) { try { await Aryeo.order(id); } catch { /* non-fatal */ } }
    await syncAryeoOrders();
    try { await syncClientSegments(); } catch { /* non-fatal */ }
    return;
  }
}

// Lightweight GET so you can confirm the endpoint is reachable in a browser.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "aryeo-webhook" });
}
