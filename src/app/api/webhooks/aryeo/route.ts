import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getConnection, getSecret } from "@/lib/integrations/connections";
import {
  syncAryeoOrders, syncAryeoAppointments, syncAryeoSocialPlans, syncAryeoCustomers,
  upsertAryeoCustomerClient, orderIdForListing, type AryeoCustomer,
} from "@/lib/integrations/aryeo";
import { syncClientSegments } from "@/lib/segmentSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives Aryeo webhooks (order fulfilled, customer created, invoice paid,
// media delivered, …). Logs every event for audit/replay, verifies the
// signature when a webhook secret is configured, then processes known events.

// Stamped on the WebhookEvent row of every event we let through WITHOUT
// verifying it, so an unsigned acceptance is self-describing forever instead of
// looking identical to a verified one. /connections counts rows on this prefix,
// and the OpenPhone receiver stamps the same marker — keep the three in step.
const UNSIGNED_MARKER = "UNSIGNED: accepted without verification — no webhook secret configured";

// The signing secret for inbound Aryeo webhooks. Saved from /connections into
// the same encrypted store as every other credential ("aryeo_webhook"); the
// legacy PLAINTEXT Connection.webhookSecret column is still read as a fallback
// so a secret pasted in by hand before this change keeps verifying.
async function aryeoWebhookSecret(): Promise<string | null> {
  return (await getSecret("aryeo_webhook")) || (await getConnection("aryeo"))?.webhookSecret || null;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  // Signature verification (HMAC-SHA256 of the raw body). Aryeo signs with a
  // header literally named `Signature` (see docs: "Setting Up Webhooks").
  // FAIL CLOSED once a secret exists. Until one does we still accept — pulling
  // the plug outright would sever live order/appointment events before the
  // owner can press the button — but every such acceptance is logged and
  // counted as unsigned rather than silently waved through.
  const secret = await aryeoWebhookSecret();
  const unsigned = !secret;
  if (secret) {
    const sig =
      req.headers.get("signature") ||
      req.headers.get("x-aryeo-signature") ||
      req.headers.get("x-signature") ||
      req.headers.get("aryeo-signature") ||
      "";
    // Compare BYTES, and gate on BYTE length. timingSafeEqual THROWS when the
    // two buffers differ in length, and a JS string's .length counts characters,
    // not bytes — so a `Signature` header of 64 multibyte characters cleared a
    // character gate and then blew up inside the compare, turning what should be
    // a clean 401 into a 500 (same defect as the OpenPhone `?t=` check).
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
    const provided = Buffer.from(sig.replace(/^sha256=/, ""), "utf8");
    const ok = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
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
  } else {
    // Nothing was verified. Say so on every request (Vercel logs) as well as on
    // the stored row — the receiver URL became guessable when the app moved to
    // hub.realtourpilot.com, and a forged POST here reconciles real projects.
    console.warn("[webhook] aryeo: UNSIGNED event accepted — no signing secret configured. Save one on /connections to close this.");
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
    data: {
      provider: "aryeo",
      eventType,
      externalId,
      payload: raw || "{}",
      // Marker only — status stays on its normal RECEIVED→PROCESSED path so
      // dedupe and the hourly retry sweep behave exactly as before.
      error: unsigned ? UNSIGNED_MARKER : null,
    },
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

// ---------------------------------------------------------------------------
// The CUSTOMER payload → a client row, a ping, and a first-pass brief.
//
// Shape, verified against 182 stored CUSTOMER_CHANGED payloads (live, Sep 7):
//   { object:"GROUP", id, type:"AGENT", name, email, phone, avatar_url,
//     internal_notes, office_name, license_number,
//     owner:{ object:"USER", id, full_name, email, phone, … },
//     users:[ …the same person… ] }
// The agent therefore appears TWICE, at the top level and nested. On every
// payload checked the two ids are identical, but the API does not promise that,
// so both are handed to the matcher as candidates for the (unique)
// aryeoCustomerId slot — and the nested record fills any blank the group left.
// ---------------------------------------------------------------------------
type AryeoNestedUser = {
  id?: string; email?: string; full_name?: string; phone?: string;
  avatar_url?: string | null; internal_notes?: string;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

async function handleAryeoCustomer(payload: Record<string, unknown>) {
  // Flat resource, or the documented ACTIVITY wrapper's `resource`/`data`.
  const body = ((payload.resource ?? payload.data ?? payload) || {}) as Record<string, unknown>;
  const users = Array.isArray(body.users) ? (body.users as AryeoNestedUser[]) : [];
  const owner = ((body.owner as AryeoNestedUser | undefined) ?? users[0]) ?? null;

  const cust: AryeoCustomer = {
    id: str(body.id),
    name: str(body.name) ?? owner?.full_name,
    email: str(body.email) ?? owner?.email,
    phone: str(body.phone) ?? owner?.phone,
    office_name: str(body.office_name),
    license_number: str(body.license_number),
    internal_notes: str(body.internal_notes) ?? owner?.internal_notes,
    avatar_url: str(body.avatar_url) ?? owner?.avatar_url ?? null,
  };

  const res = await upsertAryeoCustomerClient(cust, { via: "aryeo-webhook", altIds: [owner?.id] });
  if (!res?.created) return; // already ours — enrichment below handles the rest

  // The ping goes FIRST: it is the thing a person is waiting on, and it is two
  // cheap writes. The brief makes an AI call, so it must never sit between the
  // create and the notification Jordan and Kyle actually see.
  // greetNewClient awaits the bell and schedules the AI brief with next/server
  // after() — a model call inside the webhook request risked a platform timeout
  // that left the WebhookEvent stuck in RECEIVED (review, Sep 7).
  try {
    const { greetNewClient } = await import("@/lib/newClients");
    await greetNewClient(res.clientId);
  } catch { /* the create stands on its own */ }
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
    // Scoped to THIS order when the id is known. The bare incremental sweep
    // stops at a 45-day created_at floor, so an event about an older order
    // (632 Greenridge: created Jun 30, items changed Aug 26) never reached the
    // update pass — its price, fulfilment and line items stayed frozen.
    if (id) {
      try { await syncAryeoOrders({ orderId: id }); } catch { /* fall through to the sweep */ }
    }
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
      // NO PROJECT CARRIES THIS LISTING (Sep 16, Kyle call — 39 Saratoga Ln).
      // That is not "a listing we don't know about": far more often it is one
      // of ours whose project was created from a thin/ghost ORDER webhook
      // before the listing existed, so aryeoListingId was never written. The
      // old fallback — a bare incremental order sweep — could not repair it
      // either (the update pass ignored the listing id, and the sweep stops at
      // a 45-day floor). Go the other way: ask the listing which ORDER it
      // belongs to and re-sync THAT order, which now backfills the link and
      // lets the status engine finally see the media. Cheap: two calls.
      try {
        const orderId = await orderIdForListing(id);
        if (orderId) {
          await syncAryeoOrders({ orderId });
          const linked = await prisma.project.findUnique({ where: { aryeoOrderId: orderId }, select: { id: true } });
          if (linked) {
            try { await restatusProject(linked.id); } catch { /* non-fatal */ }
            await retaskProject(linked.id);
            return;
          }
        }
      } catch { /* fall through to the sweep below */ }
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
    // Bounded window: a webhook is about a change happening NOW — no need to
    // re-walk appointment history (the sort=-start_at early-break makes this
    // ~1 page instead of ~15). The nightly full sync remains the backstop.
    try { await syncAryeoAppointments({ recentOnlyDays: 21 }); } catch { /* non-fatal */ }
    await syncAryeoOrders();
    if (id) {
      const appt = await prisma.appointment.findUnique({
        where: { aryeoId: id },
        select: { projectId: true, startAt: true, project: { select: { aryeoOrderId: true } } },
      });
      if (appt) {
        // The bounded sync skips DATED rows older than its window, so a
        // retro-cancel/reassign of an old appointment would otherwise sit
        // unpropagated until the reconcile slices reach it. Rare path: re-sync
        // THIS order's appointments (2-4 calls, ~1s) — never the unbounded
        // pass, which is ~190s of API and can't fit a webhook.
        if (appt.startAt && appt.startAt.getTime() < Date.now() - 21 * 86_400_000 && appt.project?.aryeoOrderId) {
          try { await syncAryeoAppointments({ orderId: appt.project.aryeoOrderId }); } catch { /* non-fatal */ }
        }
        try { await restatusProject(appt.projectId); } catch { /* non-fatal */ }
        await retaskProject(appt.projectId);
        // Dropbox folders the moment the booking lands (took over from the
        // broken Zapier Zap) — the hourly sweep is the net if this misses.
        try {
          const { ensureProjectFolders } = await import("@/lib/dropboxFolders");
          const proj = await prisma.project.findUnique({
            where: { id: appt.projectId },
            select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, status: true, dropboxFolder: true, client: { select: { name: true } } },
          });
          if (proj) await ensureProjectFolders(proj); // handles create, reschedule-move, AND cancel-archive
        } catch { /* non-fatal — hourly sweep covers it */ }
      }
    }
    return;
  }

  // CUSTOMER_* — new/updated client (the classifier folds GROUP/USER payloads
  // into CUSTOMER). CREATE first, then re-enrich, re-score segments, and
  // refresh social-content plans. Each only writes the rows that actually
  // changed.
  if (object === "CUSTOMER" || name.startsWith("CUSTOMER")) {
    // A GENUINELY NEW CONTACT BECOMES A CLIENT NOW, NOT TOMORROW (Jordan,
    // Sep 7). syncAryeoCustomers() below only ENRICHES rows it can match by
    // email — the only door that created was syncAllAryeoClients on the daily
    // cron, so a contact added at 9am was invisible here until the small hours.
    // upsertAryeoCustomerClient re-uses the same identity signals that sweep
    // does (Aryeo id, email, phone+name, name+brokerage, backupEmail+name), so
    // this door cannot re-mint a client a merge has already repaired.
    try {
      await handleAryeoCustomer(payload);
    } catch (e) {
      // Never fail the webhook over the new-client path: the daily roster sweep
      // is still the backstop that creates whoever this missed.
      console.warn("[webhook] aryeo: new-client path failed", e);
    }
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
    try { await syncAryeoAppointments({ recentOnlyDays: 21 }); } catch { /* non-fatal */ }
    await syncAryeoOrders();
    return;
  }
  if (type.includes("order") || type.includes("customer") || type.includes("invoice")) {
    if (id) { try { await syncAryeoOrders({ orderId: id }); } catch { /* non-fatal */ } }
    await syncAryeoOrders();
    try { await syncClientSegments(); } catch { /* non-fatal */ }
    return;
  }
}

// Lightweight GET so you can confirm the endpoint is reachable in a browser.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "aryeo-webhook" });
}
