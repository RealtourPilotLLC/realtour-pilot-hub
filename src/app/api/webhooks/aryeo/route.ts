import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { getConnection, getSecret } from "@/lib/integrations/connections";
// Static, not a dynamic import like the heavier helpers below: this module is
// already in this route's startup graph for constantTimeEqual, so deferring the
// rest would only disguise where the arming decision comes from.
import { constantTimeEqual, readArmState, noteRefusalWhileArmed, noteVerifiedDelivery, TOKEN_HEADERS } from "@/lib/webhookArming";
// Also static, and for the same reason: lib/aryeoDelivery's own imports are
// prisma and integrations/aryeo, both already in this route's startup graph
// above, so it costs nothing to load here — and the list of activity names it
// owns has to live in ONE place or the receiver and the handler will drift
// apart. Everything heavy it needs (the status engine, the task reconciler,
// the Topaz jobs) it imports dynamically inside itself.
import { isAryeoDeliveryActivity, handleAryeoActivity, refreshSurfaces } from "@/lib/aryeoDelivery";
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

// The same idea for the middle of a cutover: a secret IS saved, but Aryeo has
// not yet proved it has it, so the post is accepted and the row says exactly
// why. Shares the "UNSIGNED" prefix deliberately — /connections counts unsigned
// acceptances on that prefix and lib/webhookRetry carries it across retries, so
// a third spelling would quietly drop these rows out of both.
const WATCHING_MARKER =
  "UNSIGNED: accepted while waiting for Aryeo to start signing — a secret is saved here but no post has proved Aryeo has it yet";

// And the third: a secret is saved and PROVED, but checking was deliberately
// switched off (by an owner, or by the probation guard after real events
// started bouncing). A row from that period must not claim we were still
// waiting on Aryeo — the reason it was unchecked is entirely different, and in
// eight months' time the row is all anyone will have.
const HOLDING_MARKER =
  "UNSIGNED: accepted with checking switched off — a secret is saved here but the hub was told not to enforce it";

// ---------------------------------------------------------------------------
// SAYING "THIS ONE IS MINE" (Sep 17 2026).
//
// The health panel decides whether Aryeo is still alive by looking for the most
// recent event this lane accepted — so every post WE make while testing the
// endpoint tells it the feed is fine. That is not a theoretical problem: a
// hand-rolled probe at 17:39 today took Aryeo's measured silence from 234 hours
// to zero, and a nine-day-dead lane would have rendered as "Aryeo is
// delivering" with a green tick. Checking the door is the thing you do most
// while a feed is down, and it was hiding the outage.
//
// Bodies cannot be told apart — replaying a stored Aryeo payload IS an Aryeo
// payload, byte for byte, which is exactly why replaying one is the honest way
// to test this route. So the CALLER says so, on a header, and the row is
// labelled at the door. Everything else about the request is unchanged: it is
// still verified (or not) the same way, still routed the same way, still
// processed the same way, and still stored. Only the label differs, and the
// label is what the "has this lane delivered?" measurement reads.
//
// It is not a security control and it does not need to be. Setting it can only
// make the lane look QUIETER — an attacker's post that claims to be a self-test
// is a post that does not silence the alarm — so the worst it can do is make
// the hub shout. The one thing it must never be is the reverse.
//
// The label lives in lib/webhookRetry (SELF_TEST_TYPES); keep the two in step.
const SELFTEST_HEADER = "x-realtour-selftest";
const SELFTEST_EVENT_TYPE = "selftest";

// ---------------------------------------------------------------------------
// AND WHEN SOMEBODY FORGETS THE HEADER (Sep 17, review).
//
// A declaration you have to remember is a declaration that gets forgotten, and
// the one test method this comment recommends — replay a stored Aryeo payload,
// because it IS an Aryeo payload — is exactly the one that defeats the label
// when it is: the replay classifies as ORDER_CHANGED like any real event, and
// the alarm goes quiet for another day and a half. So two things are worked out
// from the REQUEST rather than taken on trust, and either one is enough:
//
//   1. WHERE IT ARRIVED. Aryeo cannot post to a laptop. A request whose Host is
//      localhost (or 127.0.0.1, or a .local name) came from a dev server — and
//      a dev server here runs against the LIVE database, which is precisely how
//      fifteen test posts came to be sitting in the production event log this
//      afternoon.
//
//   2. HOW OLD THE BODY IS. Aryeo posts about something that has just changed:
//      across the 371 ORDER_CHANGED and 319 APPOINTMENT_CHANGED bodies on file,
//      the payload's own `updated_at` is within an hour of the moment it landed
//      for all but thirty of them (and all thirty are retries of six events). A
//      body whose own newest timestamp is more than two days old is a copy of
//      something that already happened, whoever posted it.
//
// Both only ever make the lane look QUIETER, which is the safe direction for
// the one measurement meant to notice a dead feed: the cost of being wrong is a
// louder alarm. Bodies that carry no timestamp at all (every flat LISTING and
// CUSTOMER payload Aryeo sends) are left alone rather than guessed about —
// "we cannot tell" is not evidence of a test.
const REPLAY_EVENT_TYPE = "replay";
/** Two days. A real event's body is minutes old; a replay of a stored one is
 *  days. Wide enough that the six genuine appointment events whose `updated_at`
 *  lagged by a day are still counted as deliveries. */
const STALE_BODY_MS = 48 * 3600_000;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];
/** The timestamp fields a real Aryeo body moves when the thing it describes
 *  changes. Read at the top level and one level into the documented ACTIVITY
 *  wrapper — deliberately NOT recursively, because a customer's own `created_at`
 *  or a listing's nested records say nothing about when this event happened. */
const BODY_MOMENT_KEYS = ["occurred_at", "occurredAt", "updated_at", "updatedAt", "modified_at"];

function newestMomentIn(payload: Record<string, unknown>): number | null {
  const objects = [payload];
  const resource = (payload.resource ?? payload.data) as Record<string, unknown> | undefined;
  if (resource && typeof resource === "object" && !Array.isArray(resource)) objects.push(resource);
  let newest: number | null = null;
  for (const o of objects) {
    for (const k of BODY_MOMENT_KEYS) {
      const v = o[k];
      if (typeof v !== "string") continue;
      const t = Date.parse(v);
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    }
  }
  return newest;
}

/** Why this post does not count as a delivery on the health panel, or null when
 *  it does. The label it returns is what the row is stored under.
 *
 *  Exported so it can be exercised directly — the local dev server answers on
 *  localhost, which trips the first rule before the other two are ever reached,
 *  so the only honest way to test the rest is to call this with the request you
 *  mean. (classifyAryeoPayload and processAryeoEvent are exported from here for
 *  the same reason.) */
export function notADelivery(req: NextRequest, payload: Record<string, unknown>): { label: string; why: string } | null {
  if (req.headers.get(SELFTEST_HEADER) !== null) {
    return { label: SELFTEST_EVENT_TYPE, why: "posted by us, not by Aryeo" };
  }
  // The Host header on a real request; the URL's own hostname when there is
  // none (a request object built in a probe rather than received off a socket).
  const host = ((req.headers.get("host") || req.nextUrl.hostname) ?? "").split(":")[0].toLowerCase();
  if (LOCAL_HOSTS.includes(host) || host.endsWith(".local")) {
    return { label: SELFTEST_EVENT_TYPE, why: `posted to ${host || "a local address"}, which Aryeo cannot reach — so this came from a dev server, not from Aryeo` };
  }
  const moment = newestMomentIn(payload);
  if (moment !== null && Date.now() - moment > STALE_BODY_MS) {
    const days = Math.floor((Date.now() - moment) / 86_400_000);
    return { label: REPLAY_EVENT_TYPE, why: `a replay: the body's own newest timestamp is ${days} day${days === 1 ? "" : "s"} old, so it describes something that already happened` };
  }
  return null;
}

// The signing secret for inbound Aryeo webhooks. Saved from /connections into
// the same encrypted store as every other credential ("aryeo_webhook"); the
// legacy PLAINTEXT Connection.webhookSecret column is still read as a fallback
// so a secret pasted in by hand before this change keeps verifying.
async function aryeoWebhookSecret(): Promise<string | null> {
  return (await getSecret("aryeo_webhook")) || (await getConnection("aryeo"))?.webhookSecret || null;
}

// Which header Aryeo signed with, so a header-NAME mismatch is diagnosable
// instead of looking like a wrong secret. Order matters only for the label.
const SIG_HEADERS = ["signature", "x-aryeo-signature", "x-signature", "aryeo-signature"] as const;

// THE ALTERNATIVE CREDENTIAL (names live in lib/webhookArming, so the screen
// that tells Aryeo which header to use reads from the same list this does).
// Aryeo's docs offer custom headers for "additional validation", and custom
// endpoint setup may have to go through their support team — who may enable a
// static header rather than signing. So the same stored secret is also accepted
// as a bare token on one of those headers.
//
// Worth being clear-eyed about what it is worth. A signature is a MAC over THIS
// body — it proves the body was not touched and cannot be replayed onto a
// different one. A header token only proves the sender knows a string, and that
// string is sent in full on every request. It is the weaker mechanism, offered
// because a working weaker check beats an endpoint that is wide open; the
// precedence rule below makes sure it can never WEAKEN the stronger one.

/**
 * PRECEDENCE, stated once so nobody has to infer it from the branches:
 *
 *   1. A signature header is present  → the HMAC decides, full stop.
 *      A failed signature is a REFUSAL. We do NOT then look at the token
 *      header. Falling through would mean anyone who learned the token could
 *      bolt a junk signature onto a forged body and still get in — and, just as
 *      bad, a genuinely broken signing setup would be silently "rescued" by the
 *      token and nobody would ever find out.
 *   2. No signature, but a token header → the token decides.
 *   3. Neither                          → nothing was presented. The arming
 *      state (lib/webhookArming) decides whether that is accepted or refused.
 *
 * In short: the strongest credential OFFERED is the one that must pass.
 */
type CredentialCheck =
  | { kind: "signature" | "header"; ok: boolean; header: string; presented: string | null }
  | { kind: "none" };

function checkCredential(req: NextRequest, raw: string, secret: string): CredentialCheck {
  const sigHeader = SIG_HEADERS.find((h) => req.headers.get(h)) ?? null;
  if (sigHeader) {
    const sig = req.headers.get(sigHeader) || "";
    // Compare BYTES, and gate on BYTE length. timingSafeEqual THROWS when the
    // two buffers differ in length, and a JS string's .length counts characters,
    // not bytes — so a `Signature` header of 64 multibyte characters cleared a
    // character gate and then blew up inside the compare, turning what should be
    // a clean 401 into a 500 (same defect as the OpenPhone `?t=` check).
    // `raw` came from req.text(), so the bytes we MAC are that string re-encoded
    // as UTF-8. Exact for every valid UTF-8 body, which is all JSON Aryeo can
    // legally send — but a body containing invalid UTF-8 bytes would have been
    // turned into U+FFFD on the way in, and would then fail this check for a
    // reason no amount of staring at the signature would explain. Noted rather
    // than fixed: reading the raw bytes instead would change nothing for real
    // traffic and is not worth touching a check that is currently correct.
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
    const provided = Buffer.from(sig.replace(/^sha256=/, ""), "utf8");
    const ok = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    return { kind: "signature", ok, header: sigHeader, presented: sig };
  }
  const tokenHeader = TOKEN_HEADERS.find((h) => req.headers.get(h)) ?? null;
  if (tokenHeader) {
    // constantTimeEqual gates on byte length for the same reason as above — a
    // multibyte token must not be able to throw its way past the compare.
    const token = req.headers.get(tokenHeader) || "";
    return { kind: "header", ok: constantTimeEqual(token, secret), header: tokenHeader, presented: null };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// HOW MUCH OF AN UNVERIFIED BODY WE KEEP
//
// The refusal path has had a cap and a burst guard since RTP-28, on the
// reasoning that a refused body is attacker-controlled. Every word of that
// applies harder to the ACCEPT path now, because WATCHING is the steady state
// of an endpoint anyone who knows the URL can post to — and that path wrote the
// body whole, with nothing bounding it (review, Sep 16).
//
// The sizes are measured, not picked. Real Aryeo payloads are big: median 26KB,
// 95th percentile 116KB, largest ever stored 273KB. So the cap for a body that
// looks like a real Aryeo resource has to sit above that or a cutover would
// quietly stop being able to replay its own events; anything that does NOT look
// like one gets far less, because there is nothing in it worth keeping beyond
// "here is what somebody posted at us".
const REAL_BODY_CAP = 320_000;
const JUNK_BODY_CAP = 4_000;
/** Unverified acceptances in an hour past which we keep the row and drop the
 *  body. The busiest real hour Aryeo has ever given us is 34 events, so 100 is
 *  three times anything genuine — high enough that a burst of real traffic
 *  during a cutover stays replayable, low enough to bound what an open endpoint
 *  can be made to store. */
const UNVERIFIED_BURST = 100;

async function storableUnverifiedBody(raw: string, looksReal: string): Promise<{ body: string; clipped: boolean }> {
  if (!raw) return { body: "{}", clipped: false };
  try {
    const recent = await prisma.webhookEvent.count({
      where: { provider: "aryeo", status: { not: "REJECTED" }, error: { startsWith: "UNSIGNED" }, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= UNVERIFIED_BURST) return { body: "{}", clipped: true };
  } catch {
    /* can't count — fall through to the caps, which bound it anyway */
  }
  const body = raw.slice(0, looksReal ? REAL_BODY_CAP : JUNK_BODY_CAP);
  return { body, clipped: body.length < raw.length };
}

/** Keep the row readable once its eventType has been relabelled. The real verb
 *  goes into the note, so "what was this a test OF?" is answerable from the row
 *  alone. Deliberately APPENDED: every reader matches the "UNSIGNED" prefix at
 *  the FRONT of this field (see the markers above), and a prefix of our own
 *  would drop these rows out of all of them. */
function selfTestNote(marker: string | null, realEventType: string | null, why: string | null): string | null {
  if (!realEventType || !why) return marker;
  const note = `SELF-TEST: ${why} — it does not count as a delivery on the webhook health panel (body: ${realEventType}).`;
  return marker ? `${marker} — ${note}` : note;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  // WHO IS ALLOWED IN, AND WHEN WE START INSISTING.
  //
  // Aryeo signs with a header literally named `Signature` (docs: "Setting Up
  // Webhooks") — HMAC-SHA256 of the raw body, hex. That check is unchanged and
  // correct. What changed on Sep 16 is WHEN a failed check is fatal.
  //
  // Saving a secret no longer flips this receiver to refusing. At the instant a
  // secret is saved, Aryeo does not have it yet — that is not an edge case, it
  // is the normal state of every cutover, and treating it as an attack is what
  // took Aryeo off the air for eight days on Sep 8. So a saved secret starts in
  // WATCHING: posts are accepted, every credential is still evaluated, and the
  // first post that genuinely verifies proves Aryeo has the secret and arms
  // enforcement from then on. See lib/webhookArming for the state machine, the
  // probation climb-down, and why the escape hatch does not return to watching.
  //
  // With NO secret at all, behaviour is unchanged: a per-provider SETTING whose
  // default is this receiver's long-standing accept-and-stamp.
  const secret = await aryeoWebhookSecret();
  const cred: CredentialCheck = secret ? checkCredential(req, raw, secret) : { kind: "none" };
  // The credential that PASSED, or null. Held as the object rather than a bare
  // boolean so the arming call below gets a properly narrowed value instead of
  // leaning on inference from a flag set forty lines earlier.
  const proven = cred.kind !== "none" && cred.ok ? cred : null;
  const verified = proven !== null;
  // Null when the post verified; otherwise the marker that will describe this
  // row forever. Set below on each accept-without-verifying path.
  let acceptedMarker: string | null = null;

  if (secret && !verified) {
    const arm = await readArmState("aryeo", secret);
    if (arm.mode === "armed") {
      // Record the refusal WITH the evidence needed to diagnose it offline: the
      // header that carried the digest, the digest itself, and the whole body
      // (the old 2,000-char slice is why not one of the 36 Sep 8 rejections can
      // be replayed against a candidate secret today). refuseWebhook also runs
      // the hourly spike alert. Best-effort; never block the response on it.
      const { refuseWebhook } = await import("@/lib/webhookRetry");
      await refuseWebhook("aryeo", {
        code: cred.kind === "header" ? "bad-token" : "bad-signature",
        rawBody: raw,
        header: cred.kind === "none" ? null : cred.header,
        sig: cred.kind === "signature" ? cred.presented : null,
      });
      // If real Aryeo traffic starts bouncing in the hours right after a
      // cutover, climb back down by ourselves rather than waiting for someone
      // to notice. Aryeo gives up after two retries; nobody checked for eight
      // days last time.
      await noteRefusalWhileArmed("aryeo", secret).catch(() => false);
      // The CALLER is told nothing but "invalid": the plain-English refusal lives
      // on the stored row and the owner-only Connections strip. A refused post is
      // unauthenticated by definition, and "no secret is saved" / "the app secret
      // changed" is a map of how the door is hung (RTP-28 review, Sep 16).
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    // WATCHING or HOLDING — accept, and make the row say so. This is the window
    // in which Aryeo has the URL but not yet the secret, and refusing here is
    // the whole of the Sep 8 fault.
    acceptedMarker = arm.mode === "holding" ? HOLDING_MARKER : WATCHING_MARKER;
    console.warn(
      `[webhook] aryeo: accepted WITHOUT verification (${arm.mode}) — a secret is saved but this post did not carry a matching one. ${
        arm.mode === "holding"
          ? "Checking is switched off; turn it back on from /connections."
          : "Checking starts by itself when Aryeo sends a post that verifies."
      }`,
    );
  } else if (!secret) {
    // No usable secret. The office setting decides: refuse (and say why), or
    // accept and stamp the row so the acceptance is self-describing forever.
    const { gateMissingSecret, refuseWebhook } = await import("@/lib/webhookRetry");
    const gate = await gateMissingSecret("aryeo", "aryeo_webhook");
    if (!gate.allow) {
      await refuseWebhook("aryeo", { code: gate.code, rawBody: raw, header: null, sig: null });
      return NextResponse.json({ error: "Unverified" }, { status: 401 });
    }
    acceptedMarker = UNSIGNED_MARKER;
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

  // PROOF. This post verified against the stored secret, so Aryeo demonstrably
  // has it — which is the only evidence that makes it safe to start refusing.
  // Deliberately after classification: noteVerifiedDelivery will only arm on a
  // payload that is a real Aryeo resource, never on a signed probe or an empty
  // body. Best-effort; a missed arm just means the next event arms instead.
  if (secret && proven) {
    try {
      await noteVerifiedDelivery("aryeo", {
        secret,
        credential: proven.kind,
        header: proven.header,
        eventType: cls.eventName,
        payload,
      });
    } catch {
      /* never let the cutover bookkeeping cost us a real event */
    }
  }
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

  // An unverified body is bounded before it is stored; a verified one is kept
  // whole, because it came from Aryeo and replaying it is the point.
  const kept = acceptedMarker ? await storableUnverifiedBody(raw, cls.object) : null;
  // A post that declared itself a test is STORED under the self-test label so
  // it cannot pass for a delivery from Aryeo. `eventType` itself is untouched —
  // routing below still sees the real verb, so a test exercises the same code
  // a real event would. See SELFTEST_HEADER.
  const selfTest = notADelivery(req, payload);
  const log = await prisma.webhookEvent.create({
    data: {
      provider: "aryeo",
      eventType: selfTest ? selfTest.label : eventType,
      externalId,
      payload: kept ? kept.body : raw || "{}",
      // Marker only — status stays on its normal RECEIVED→PROCESSED path so
      // dedupe and the hourly retry sweep behave exactly as before. Null when
      // the post verified; otherwise it says WHY it was let through unverified,
      // and whether the copy on this row is the whole of what arrived. (Every
      // reader matches on the "UNSIGNED" PREFIX, so a suffix is safe — check
      // that is still true before changing the front of these strings.)
      error: selfTestNote(
        acceptedMarker && kept?.clipped ? `${acceptedMarker} — body not kept in full` : acceptedMarker,
        selfTest ? eventType : null,
        selfTest?.why ?? null,
      ),
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

/**
 * WHAT A NAME ASKS THE HUB TO DO.
 *
 * Sep 17 2026: Aryeo enabled webhook management on the account and Jordan
 * subscribed to all 54 activities. Until then the receiver routed on the
 * resource PREFIX — anything starting ORDER/LISTING/APPOINTMENT/CUSTOMER got
 * the full treatment for that resource — which was right for ten subscriptions
 * and wrong for fifty-four. One order being placed now fires ORDER_CREATED,
 * ORDER_PLACED, ORDER_RECEIVED, ORDER_PAYMENT_ENTERED, ORDER_PAYMENT_COMPLETED
 * and ORDER_SYNCED_TO_QUICKBOOKS within seconds of each other, and the prefix
 * rule would have run the same three-second resync six times — while Aryeo
 * gives up on a post after 10 seconds and retries it.
 *
 * So each name says what it actually needs:
 *   "money"    the order's money changed (paid, refunded, disputed, fee, a
 *              QuickBooks sync) — re-read the order, nothing else. This is what
 *              finally kills the paid-status lag.
 *   "order"    the order itself changed — the full pass (re-read, re-status,
 *              re-task), as before.
 *   "listing" / "appointment" / "customer" — that resource's own pass.
 *   "delivery" the named delivery activities, handled above by aryeoDelivery.
 *   null       recorded and nothing else. Every event is stored either way, so
 *              a name we do not act on is still there to look back at.
 */
const ARYEO_ACTION: Record<string, "money" | "order" | "listing" | "appointment" | "customer" | null> = {
  // — the money, which is why the hub's paid status has always lagged —
  ORDER_PAYMENT_COMPLETED: "money", ORDER_PAYMENT_ENTERED: "money", ORDER_PAYMENT_DELETED: "money",
  ORDER_PAYMENT_DISPUTED: "money", ORDER_REFUNDED: "money", ORDER_FEE_CREATED: "money", ORDER_FEE_DELETED: "money",
  ORDER_PAYMENT_SYNCED_TO_QUICKBOOKS: "money", ORDER_SYNCED_TO_QUICKBOOKS: "money",
  // A failed QuickBooks sync is the silent kind of failure this hub exists to
  // catch: the money moved in Aryeo and the books never heard. Re-read the
  // order so what we show is at least true, and the event is on the record.
  ORDER_SYNC_TO_QUICKBOOKS_FAILED: "money",
  // — the order as a piece of work —
  ORDER_CREATED: "order", ORDER_PLACED: "order", ORDER_RECEIVED: "order", ORDER_ATTACHED_TO_LISTING: "order",
  // — appointments: the whole life of one —
  APPOINTMENT_SCHEDULED: "appointment", APPOINTMENT_REQUESTED: "appointment", APPOINTMENT_ACCEPTED: "appointment",
  APPOINTMENT_ASSIGNED: "appointment", APPOINTMENT_UNASSIGNED: "appointment", APPOINTMENT_DECLINED: "appointment",
  APPOINTMENT_CANCELED: "appointment", APPOINTMENT_POSTPONED: "appointment", APPOINTMENT_RESCHEDULED: "appointment",
  APPOINTMENT_CUSTOMER_COMPANY_TEAM_MEMBER_PREFERRED: "appointment",
  // — listings —
  LISTING_CREATED: "listing", LISTING_UPDATED: "listing", LISTING_MERGED: "listing",
  MARKETING_MATERIAL_CREATED: "listing",
  // — the client's own record: who is on the team, what they are charged —
  CUSTOMER_TEAM_CREATED: "customer", CUSTOMER_TEAM_ARCHIVED: "customer",
  CUSTOMER_TEAM_MEMBERSHIP_CREATED: "customer", CUSTOMER_TEAM_MEMBERSHIP_ARCHIVED: "customer",
  CUSTOMER_TEAM_MEMBERSHIP_DELETED: "customer", CUSTOMER_TEAM_MEMBERSHIP_REACTIVATED: "customer",
  CUSTOMER_TEAM_MEMBERSHIP_REVOKED: "customer", CUSTOMER_TEAM_MEMBERSHIP_INVITATION_ACCEPTED: "customer",
  DEFAULT_CUSTOMER_TEAM_MEMBERSHIP_ADDED: "customer", DEFAULT_CUSTOMER_TEAM_MEMBERSHIP_REMOVED: "customer",
  CUSTOMER_TEAM_PRICE_OVERRIDES_UPDATED: "customer", CUSTOMER_TEAM_PRICING_PLAN_APPLIED: "customer",
  CUSTOMER_TEAM_PRICING_PLAN_REMOVED: "customer", CUSTOMER_TEAM_PRESELECTED_PRODUCTS_UPDATED: "customer",
  CUSTOMER_TEAM_BILLING_TEAM_MEMBERSHIP_UPDATED: "customer", CUSTOMER_TEAM_BILLING_TEAM_MEMBERSHIP_REMOVED: "customer",
  // — recorded, acted on by nobody: an internal note or a download setting is
  //   history worth keeping and not a reason to re-read anything —
  CUSTOMER_TEAM_INTERNAL_NOTE_UPDATED: null, CUSTOMER_TEAM_DOWNLOAD_SETTINGS_UPDATED: null,
  MEDIA_REQUEST_CREATED: null, MEDIA_REQUEST_ACCEPTED: null, MEDIA_REQUEST_ASSIGNED: null,
  MEDIA_REQUEST_DECLINED: null, MEDIA_REQUEST_CANCELED: null, MEDIA_REQUEST_TRANSFERRED: null,
};

/**
 * Did we just do this exact work? A burst about one resource is the normal
 * shape of an Aryeo event now, and the work each branch does is a reconcile
 * against Aryeo's own state — so doing it once for the burst is not a
 * shortcut, it is the same answer for less. 90 seconds, keyed by what we would
 * do and to what; a marker write is far cheaper than the pass it prevents.
 */
async function recentlyReconciled(action: string, key: string): Promise<boolean> {
  const settingKey = `aryeo-reconciled:${action}:${key}`;
  const seen = await getSetting<{ at: number }>(settingKey, { at: 0 });
  if (Date.now() - (seen.at ?? 0) < 90_000) return true;
  await putSetting(settingKey, { at: Date.now() }, "webhook:aryeo").catch(() => {});
  return false;
}

// Routes a real Aryeo event. The 10 registered subscriptions are:
// ORDER_CREATED/FULFILLED/PAID, LISTING_UPDATED, APPOINTMENT_SCHEDULED/
// ASSIGNED/RESCHEDULED/CANCELED, CUSTOMER_CREATED/UPDATED — but flat payloads
// don't say WHICH verb fired, so we route on the resource type and reconcile
// authoritative state (never trusting the body). That covers every verb.
export async function processAryeoEvent(eventType: string, payload: Record<string, unknown>) {
  const name = eventType.toUpperCase();
  const { object, id } = classifyAryeoPayload(payload);

  // THE NAMED DELIVERY ACTIVITIES, FIRST (Sep 16 2026).
  //
  // Kyle uploads and delivers by hand in Aryeo's web UI — there is no API that
  // can do it, and there never will be — but Aryeo tells us the instant he
  // does, through the ACTIVITY envelope: LISTING_DELIVERED,
  // LISTING_CONTENT_DOWNLOADED, MEDIA_REQUEST_DELIVERED. Nothing in the hub
  // acted on any of them until now; a delivery only reached us when the hourly
  // status sweep next happened to read that listing.
  //
  // This block sits ABOVE the resource-routed branches deliberately: every one
  // of these names also starts with "LISTING"/"MEDIA", so the generic branch
  // below would swallow them and do only half the job (a restatus, but no
  // closing of Kyle's upload card and no timeline line). lib/aryeoDelivery
  // confirms the fact against Aryeo's own API before writing anything, claims
  // the activity so a 10-second retry cannot run it twice, and falls through to
  // nothing at all if the event is not really ours. See that file for the
  // forgery and idempotency reasoning — it is the whole point of it.
  //
  // `handled` is about the NAME, not about whether anything moved: one of these
  // three events is this hub's business whatever the body turns out to contain,
  // so it never falls through to the branches below. That is deliberate. The
  // one thing falling through would add is the generic LISTING branch's
  // unbounded syncAryeoOrders() sweep for a listing nothing is linked to, which
  // is exactly the lever an unauthenticated post must not have — and the
  // handler already does the useful half itself (it re-checks any job that IS
  // linked, even when Aryeo will not confirm the event). It reads listing ids
  // out of the same three places classifyAryeoPayload does, so there is no
  // shape that reaches here with an id and leaves without one being tried.
  if (isAryeoDeliveryActivity(name)) {
    const r = await handleAryeoActivity(name, payload);
    if (r.handled) {
      console.info(`[webhook] aryeo ${name}: ${r.note}`);
      return;
    }
  }

  // What does this NAME ask for? An unknown name keeps the old prefix
  // behaviour, so an activity Aryeo adds next year still reconciles instead of
  // being silently ignored — the map narrows what we know, it does not become
  // the only thing we answer to.
  const known = name in ARYEO_ACTION;
  const action = known ? ARYEO_ACTION[name] : undefined;

  // Known, and deliberately nothing to do. It is already recorded, which is the
  // whole point of subscribing to it.
  if (known && action === null) {
    console.info(`[webhook] aryeo ${name}: recorded, nothing to reconcile`);
    return;
  }

  // MONEY ONLY. A payment landing, a refund, a fee, a QuickBooks sync — re-read
  // the order and stop. Re-statusing and re-tasking a job because its invoice
  // was paid is work that changes nothing, and these are the events that arrive
  // in bursts. This is also what finally kills the paid-status lag: until now a
  // payment only reached the hub when the hourly reconcile next looked.
  if (action === "money") {
    if (id && !(await recentlyReconciled("money", id))) {
      try { await syncAryeoOrders({ orderId: id }); } catch { /* the hourly reconcile still covers it */ }
      console.info(`[webhook] aryeo ${name}: re-read order ${id}`);
    }
    return;
  }

  // A MERGE IS NOT A LISTING UPDATE. Two listings become one, and every job
  // pointing at the absorbed side keeps an id that now answers for a different
  // property — media counts, delivery checks and the Aryeo link all read off
  // it. Handled on its own, above the generic listing pass, because that pass
  // would cheerfully restatus the job against whatever the id resolves to now.
  if (name === "LISTING_MERGED") {
    const { handleListingMerged } = await import("@/lib/listingMerge");
    const m = await handleListingMerged(payload);
    console.info(`[webhook] aryeo LISTING_MERGED: ${m.note}`);
    return;
  }

  // ORDER — created, fulfilled (delivery), paid, or unknown-verb flat change.
  // Refresh the order table, then re-run the smart status engine + task
  // reconciler for that project (cheap, idempotent — and since flat payloads
  // hide the verb, a fulfil/paid must not wait for the cron to be noticed).
  if (action === "order" || (!known && (object === "ORDER" || name.startsWith("ORDER")))) {
    // One burst, one pass. Six names arrive for a single order placement.
    if (id && (await recentlyReconciled("order", id))) {
      console.info(`[webhook] aryeo ${name}: order ${id} was just reconciled`);
      return;
    }
    // Scoped to THIS order when the id is known. The bare incremental sweep
    // stops at a 45-day created_at floor, so an event about an older order
    // (632 Greenridge: created Jun 30, items changed Aug 26) never reached the
    // update pass — its price, fulfilment and line items stayed frozen.
    let syncedThisOrder = false;
    if (id) {
      try {
        await syncAryeoOrders({ orderId: id });
        syncedThisOrder = true;
      } catch { /* fall through to the sweep */ }
    }
    // THE SWEEP IS THE FALLBACK, NOT THE ROUTINE PATH. It ran on every order
    // event, after the scoped read had already done the job, and it is what
    // made a real ORDER_CHANGED take 23 seconds end to end — while Aryeo gives
    // up on a post after 10 seconds and retries, and a flat ORDER payload
    // carries no activity id to dedupe the retry against. Turned back on in
    // that state, one order change would have been processed two or three
    // times at once. The scoped read covers the order the event names; the
    // sweep is for when we could not do that, and the hourly reconcile still
    // catches anything either of them missed.
    if (!syncedThisOrder) await syncAryeoOrders();
    if (id) {
      const project = await prisma.project.findUnique({ where: { aryeoOrderId: id }, select: { id: true } });
      if (project) {
        try { await restatusProject(project.id); } catch { /* non-fatal */ }
        // (Re)generate this job's tasks now: a new order gets its confirmation
        // task, a delivered one flips QC — without waiting for the cron.
        await retaskProject(project.id);
        // Mark the screens that show this job stale, so the first person to
        // look gets what the event just changed rather than a copy their
        // browser kept. See refreshSurfaces for what this is and is not worth.
        await refreshSurfaces(project.id);
      }
    }
    try { await syncClientSegments(); } catch { /* non-fatal */ }
    return;
  }

  // LISTING_* — media/listing changed. Re-check that project's status live so a
  // delivered gallery or added media flows through immediately, then reconcile
  // its tasks (QC closes as each category goes live).
  if (action === "listing" || (!known && (object === "LISTING" || name.startsWith("LISTING")))) {
    if (id) {
      const project = await prisma.project.findFirst({ where: { aryeoListingId: id }, select: { id: true } });
      if (project) {
        try { await restatusProject(project.id); } catch { /* non-fatal */ }
        await retaskProject(project.id);
        await refreshSurfaces(project.id);
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
            await refreshSurfaces(linked.id);
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
  if (action === "appointment" || (!known && (object === "APPOINTMENT" || name.startsWith("APPOINTMENT")))) {
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
  if (action === "customer" || (!known && (object === "CUSTOMER" || name.startsWith("CUSTOMER")))) {
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
