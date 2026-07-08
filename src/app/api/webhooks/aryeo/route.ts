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
        // Spike alert: >5 rejections in an hour means real events are bouncing
        // at the door (this ran silent for 13 days once). Best-effort.
        const { alertWebhookRejections } = await import("@/lib/notify");
        await alertWebhookRejections("aryeo");
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

  const cls = classifyAryeoPayload(payload);
  const eventType = cls.eventName;
  // Idempotency: ONLY when we have a true activity id (the documented ACTIVITY
  // wrapper). Flat resource payloads carry the RESOURCE's id — deduping on that
  // would skip every FUTURE event about the same order/appointment after the
  // first one processed (which is exactly what happened: real events silently
  // swallowed). Flat events therefore process every time; that's safe because
  // processAryeoEvent re-fetches authoritative state (idempotent reconciles).
  const externalId = cls.activityId;
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

// What did Aryeo just tell us about? Aryeo's docs describe an ACTIVITY wrapper
// ({ object:"ACTIVITY", id, name:"ORDER_FULFILLED", resource:{ object, id } }),
// but REAL deliveries (verified against stored WebhookEvent payloads, Jul 2026)
// are the FLAT RESOURCE itself: the order/listing/customer-group object at the
// top level — and appointment payloads carry no `object` key at all, just
// start_at/end_at/rescheduled_at/previous_start_at. The old parser only knew
// the wrapper shape, so every real event fell through unrouted ("unknown" or a
// customer's NAME as the event type) and was silently dropped. Detect both.
type AryeoClass = { object: "ORDER" | "LISTING" | "APPOINTMENT" | "CUSTOMER" | ""; id?: string; eventName: string; activityId?: string };
export function classifyAryeoPayload(payload: Record<string, unknown>): AryeoClass {
  const top = String((payload.object as string) || "").toUpperCase();
  const r = (payload.resource ?? payload.data ?? {}) as Record<string, unknown>;

  // Documented ACTIVITY wrapper (kept for forward-compat if Aryeo adopts it).
  if (top === "ACTIVITY" || (r && typeof r === "object" && (r.object || r.id))) {
    const object = String((r.object as string) || (payload.resource_type as string) || "").toUpperCase();
    const id = (r.id as string) || (r.order_id as string) || (payload.resource_id as string) || ((r.order as Record<string, unknown>)?.id as string) || undefined;
    const mapped = object === "GROUP" || object === "USER" ? "CUSTOMER" : object;
    return {
      object: (["ORDER", "LISTING", "APPOINTMENT", "CUSTOMER"].includes(mapped) ? mapped : "") as AryeoClass["object"],
      id,
      eventName: (payload.name as string) || (payload.event as string) || "unknown",
      activityId: (payload.id as string) || (payload.event_id as string) || undefined,
    };
  }

  // Flat resource with a top-level `object` discriminator.
  if (top === "ORDER" || top === "LISTING") {
    return { object: top, id: payload.id as string, eventName: `${top}_CHANGED` };
  }
  if (top === "GROUP" || top === "CUSTOMER" || top === "USER") {
    return { object: "CUSTOMER", id: payload.id as string, eventName: "CUSTOMER_CHANGED" };
  }
  if (top === "APPOINTMENT") {
    return { object: "APPOINTMENT", id: payload.id as string, eventName: "APPOINTMENT_CHANGED" };
  }

  // Flat appointment: no `object` key — recognize it by its scheduling shape.
  if (payload.start_at !== undefined && (payload.end_at !== undefined || payload.duration !== undefined || payload.requires_confirmation !== undefined)) {
    return { object: "APPOINTMENT", id: payload.id as string, eventName: "APPOINTMENT_CHANGED" };
  }

  // Legacy/unknown — surface whatever event-ish field exists for the log and
  // let the substring fallback in processAryeoEvent take a swing.
  return {
    object: "",
    id: (payload.resource_id as string) || undefined,
    eventName: (payload.name as string) || (payload.event as string) || (payload.type as string) || (payload.topic as string) || "unknown",
  };
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

// Routes a real Aryeo event. The 10 registered subscriptions are:
// ORDER_CREATED/FULFILLED/PAID, LISTING_UPDATED, APPOINTMENT_SCHEDULED/
// ASSIGNED/RESCHEDULED/CANCELED, CUSTOMER_CREATED/UPDATED — but flat payloads
// don't say WHICH verb fired, so we route on the resource type and reconcile
// authoritative state (never trusting the body). That covers every verb.
export async function processAryeoEvent(eventType: string, payload: Record<string, unknown>) {
  const name = eventType.toUpperCase();
  const { object, id } = classifyAryeoPayload(payload);

  // ORDER — created, fulfilled (delivery), paid, or unknown-verb flat change.
  // Refresh the order table, then re-run the smart status engine + task
  // reconciler for that project (cheap, idempotent — and since flat payloads
  // hide the verb, a fulfil/paid must not wait for the cron to be noticed).
  if (object === "ORDER" || name.startsWith("ORDER")) {
    if (id) { try { await Aryeo.order(id); } catch { /* fall through to full sync */ } }
    await syncAryeoOrders();
    if (id) {
      const project = await prisma.project.findUnique({ where: { aryeoOrderId: id }, select: { id: true } });
      if (project) {
        try { await restatusProject(project.id); } catch { /* non-fatal */ }
        // (Re)generate this job's tasks now: a new order gets its confirmation
        // task, a delivered one flips QC — without waiting for the cron.
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
  // appointment-driven schedule + morning brief (this also fires the
  // appointment_change notifications on real diffs), then orders so the shoot
  // date follows — and reconcile the affected project's status + task due
  // dates right now instead of on the next cron.
  if (object === "APPOINTMENT" || name.startsWith("APPOINTMENT")) {
    try { await syncAryeoAppointments(); } catch { /* non-fatal */ }
    await syncAryeoOrders();
    if (id) {
      const appt = await prisma.appointment.findUnique({ where: { aryeoId: id }, select: { projectId: true } });
      if (appt) {
        try { await restatusProject(appt.projectId); } catch { /* non-fatal */ }
        await retaskProject(appt.projectId);
      }
    }
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
