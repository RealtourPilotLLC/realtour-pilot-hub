// ---------------------------------------------------------------------------
// DRILL: CP-14 — Stripe activation: polling stays the path, the signed
// receiver is real, and a webhook racing the poll makes ONE account
// (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp14-stripe-activation.ts
//
// What it proves, the OLD behaviour first wherever it can be observed (HEAD's
// stripeSignups.ts and portalAccess.ts are loaded for real from git, their
// `@/` imports pointed at this tree):
//   0. OLD — the docs send Jordan to register a URL HEAD has no route for; and
//      a client who booked discovery BEFORE the payment was polled is welcomed
//      with "Book your brand discovery call", the booking stays unmatched,
//      and Kyle gets a task to chase a call that is already booked.
//   1. Poll: a paid "Video Accelerator - 1-Year Commitment" becomes one
//      ACTIVATED signup (activatedVia poll), an Accelerator MONTHLY_CONTRACT
//      12-month enrollment dated from the checkout, and this month's workspace.
//   2. Duplicates: poll ×2 + fetch-by-id ×2 → 1 signup, 1 enrollment, 1 seat,
//      1 welcome, 1 signup bell.
//   3. Race: the poll and the webhook path on a fresh checkout, together,
//      three times → exactly one activation each, nothing thrown.
//   4. Async: an unpaid completed checkout writes nothing (poll or event);
//      async_payment_succeeded after Stripe flips it activates it, dated at
//      the settlement; a late `completed` is "known"; failed/expired write nothing.
//   5. $0: a no_payment_required checkout never activates — the named constant.
//   6. Signature unit cases: valid, wrong secret, tampered body, stale,
//      several v1 with one valid, malformed.
//   7. The route: no secret → 401 + REJECTED (body not kept, no ops page);
//      bad signature → 400 + REJECTED; valid → 200 PROCESSED; the same event
//      again → processed once; livemode false → ignored.
//   8. Discovery booked first → matched at activation, the welcome says "is
//      booked for", one onboarding record, no discovery task.
//   9. Payment first (a real client) → the welcome carries the booking link
//      and Kyle has one discovery task; the booking lands later → the task
//      closes and no second welcome is queued.
//  10. An existing enrollment's owner-entered billing is kept; the note says so.
//  11. Subscriptions: an event re-reads Stripe, records the billing anchor
//      and rings once for a lapse; someone else's subscription is not ours.
//  12. A Stripe row left ERROR is replayed by webhookRetry.
//  13. Docs guard: every doc naming /api/webhooks/stripe has a route behind it.
//
// ISOLATION: PGlite on 127.0.0.1:5521 via the shared harness. Stripe, Google's
// token endpoint and Gmail's send are FAKES answering inside the fence (GET-
// only for Stripe; a write to Stripe is refused); nothing else may leave.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5521);
const REPO = path.resolve(__dirname, "../..");
const BASE = "e26cacd"; // pinned: the commit batches B–D start from (HEAD moved on once they were committed)

installNextStubs();

// ---- the fake Stripe -------------------------------------------------------
type FakeSession = {
  id: string; object: "checkout.session"; status: string; payment_status: string; mode: string; amount_total: number; created: number;
  customer: string; subscription: string | null;
  customer_details: { email: string | null; name: string | null; phone: string | null };
  line_items: { data: { description: string; price: { id: string; product: string } }[] };
};
const sessions = new Map<string, FakeSession>();
const products = new Map<string, string>();
const subs = new Map<string, { id: string; status: string; billing_cycle_anchor: number }>();
const stripeWrites: string[] = [];
let sessionFetches = 0;

// ---- the fake Gmail (token + send) -------------------------------------------
type Mail = { to: string; subject: string; body: string };
const mails: Mail[] = [];
function decodeMime(raw: string): Mail {
  const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const [head, ...rest] = text.split("\r\n\r\n");
  const to = /^To: (.+)$/m.exec(head)?.[1] ?? "";
  const subjB64 = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
  return { to, subject: Buffer.from(subjB64, "base64").toString("utf8"), body: rest.join("\r\n\r\n") };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    mails.push(decodeMime(raw));
    return json({ id: `gm-${mails.length}` });
  }
  if (u.hostname !== "api.stripe.com") return null;
  if ((init?.method ?? "GET").toUpperCase() !== "GET") { stripeWrites.push(url); return json({ error: { message: "drill: the hub never writes to Stripe" } }, 405); }
  const p = u.pathname;
  if (p === "/v1/checkout/sessions") {
    const gte = Number(u.searchParams.get("created[gte]") ?? 0);
    return json({ data: [...sessions.values()].filter((s) => s.created >= gte).sort((a, b) => b.created - a.created), has_more: false });
  }
  let m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(p);
  if (m) { sessionFetches++; const s = sessions.get(m[1]); return s ? json(s) : json({ error: { message: "No such checkout.session" } }, 404); }
  m = /^\/v1\/products\/([^/]+)$/.exec(p);
  if (m) return products.has(m[1]) ? json({ id: m[1], name: products.get(m[1]) }) : json({ error: { message: "No such product" } }, 404);
  m = /^\/v1\/subscriptions\/([^/]+)$/.exec(p);
  if (m) { const s = subs.get(m[1]); return s ? json(s) : json({ error: { message: "No such subscription" } }, 404); }
  return json({ error: { message: `drill: unknown Stripe path ${p}` } }, 404);
});

let seq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);
function addProduct(name: string): string { const id = `prod_drill${++seq}`; products.set(id, name); return id; }
function addSession(o: { name: string | null; email: string | null; product: string; amount?: number; mode?: string; status?: string; payment_status?: string; created?: number; subscription?: string | null }): FakeSession {
  const id = `cs_live_drill${String(++seq).padStart(4, "0")}${crypto.randomBytes(3).toString("hex")}`;
  const s: FakeSession = {
    id, object: "checkout.session", status: o.status ?? "complete", payment_status: o.payment_status ?? "paid", mode: o.mode ?? "subscription",
    amount_total: o.amount ?? 149900, created: o.created ?? nowSec() - 600, customer: `cus_drill${seq}`, subscription: o.subscription ?? null,
    customer_details: { email: o.email, name: o.name, phone: null },
    line_items: { data: [{ description: products.get(o.product) ?? "?", price: { id: `price_drill${seq}`, product: o.product } }] },
  };
  sessions.set(id, s);
  return s;
}

/** HEAD's copies, their `@/` imports aimed at this tree — except the old
 *  stripeSignups' portalAccess, which is aimed at the old portalAccess. */
function writeBaseCopies(): { dir: string; signups: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp14-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const access = path.join(dir, "portalAccess.base.ts");
  fs.writeFileSync(access, point(show("src/lib/portalAccess.ts")));
  const signups = path.join(dir, "stripeSignups.base.ts");
  fs.writeFileSync(signups, point(show("src/lib/stripeSignups.ts")).split(JSON.stringify(path.join(REPO, "src", "lib/portalAccess"))).join(JSON.stringify(access)));
  return { dir, signups };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const ss = await import("@/lib/stripeSignups");
  const sw = await import("@/lib/stripeWebhook");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const { decodeRejection, retryFailedWebhooks } = await import("@/lib/webhookRetry");
  const { reconcileDiscoveryTasks } = await import("@/lib/programOnboarding");
  const base = writeBaseCopies();

  await saveSecret("stripe", "sk_test_drill_not_a_key");
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
  // Isolated database only: invitations ON, so welcome rows can be counted.
  await prisma.programAutomation.create({ data: { key: "portal_invites", enabled: true, enabledBy: "drill", enabledAt: new Date() } });
  await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: "https://api.calendly.com/event_types/drill-discovery", eventName: "Brand discovery", publicUrl: "https://calendly.com/realtourpilot/brand-discovery", purpose: "BRAND_DISCOVERY", enabled: true, validationStatus: "VALID" } });
  const ACC_1Y = addProduct("Video Accelerator - 1-Year Commitment");
  const START_M2M = addProduct("Video Starter — Month-to-Month");
  const PHOTO = addProduct("Listing Photos — 25 images");

  const signupRow = (checkoutId: string) => prisma.programSignup.findUnique({ where: { checkoutId } });
  const clientOf = (email: string) => prisma.client.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  const mailsTo = (email: string) => mails.filter((m) => m.to.toLowerCase() === email.toLowerCase());
  const counts = async (checkoutId: string, email: string) => {
    const cl = await clientOf(email);
    return {
      signups: await prisma.programSignup.count({ where: { checkoutId } }),
      enrollments: cl ? await prisma.contentEnrollment.count({ where: { clientId: cl.id } }) : 0,
      seats: cl ? await prisma.clientMembership.count({ where: { clientId: cl.id } }) : 0,
      welcomes: await prisma.outboxMessage.count({ where: { toRef: email.toLowerCase(), body: { contains: "You're in" } } }),
      bells: await prisma.notification.count({ where: { dedupeKey: { startsWith: `signup-${checkoutId}-` } } }),
    };
  };
  const discoveryRecord = async (email: string, name: string, start: Date) =>
    prisma.programCallRecord.create({
      data: {
        callType: "BRAND_DISCOVERY", calendlyEventUri: `https://api.calendly.com/scheduled_events/drill-${++seq}`, calendlyEventTypeUri: "https://api.calendly.com/event_types/drill-discovery",
        inviteeEmail: email.toLowerCase(), inviteeName: name, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 3_600_000),
        status: "SCHEDULED", matchState: "UNMATCHED_INVITEE", matchNote: "no client has this address",
      },
      select: { id: true },
    });
  const discoveryTask = (enrollmentId: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `program-discovery-booking:${enrollmentId}` } });

  // =========================================================================
  c.head("0 · OLD (HEAD): a URL with no route, and a welcome that asks for a booking that exists");
  // =========================================================================
  {
    const headDocs = execFileSync("git", ["show", `${BASE}:docs/integration-tasks.md`], { cwd: REPO, encoding: "utf8" });
    let headRoute = true;
    try { execFileSync("git", ["cat-file", "-e", `${BASE}:src/app/api/webhooks/stripe/route.ts`], { cwd: REPO, stdio: "ignore" }); } catch { headRoute = false; }
    c.ok("OLD: HEAD's docs tell Jordan to register /api/webhooks/stripe…", /hub\.realtourpilot\.com\/api\/webhooks\/stripe/.test(headDocs) && /authorize me/i.test(headDocs));
    c.ok("OLD: …and HEAD has no route there (Stripe would have posted to a 404)", !headRoute);

    const old = (await import(base.signups)) as { sweepStripeSignups: () => Promise<{ activated: number }> };
    const start = new Date(Date.now() + 3 * 86_400_000);
    const rec = await discoveryRecord("olive.old@example.com", "Olive Old", start);
    const s = addSession({ name: "Olive Old", email: "olive.old@example.com", product: ACC_1Y });
    const r = await old.sweepStripeSignups();
    c.ok("OLD: the old sweep activated the signup", r.activated === 1, JSON.stringify(r));
    const welcome = mailsTo("olive.old@example.com")[0];
    c.ok("OLD: the welcome told her to BOOK the discovery call she had already booked", !!welcome && welcome.body.includes("Book your brand discovery call"), welcome?.body.split("\n").find((l) => l.startsWith("1.")));
    const after = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: rec.id } });
    c.ok("OLD: her booking was still UNMATCHED after activation", after.matchState === "UNMATCHED_INVITEE" && after.clientId === null, after.matchState);
    const enr = await prisma.contentEnrollment.findFirstOrThrow({ where: { clientId: (await clientOf("olive.old@example.com"))!.id } });
    const task = await discoveryTask(enr.id);
    c.ok("OLD: and Kyle was handed 'Book the brand discovery call' for it", task?.status === "OPEN", task?.title);
    c.ok("OLD: the signup row carries no activatedVia", (await signupRow(s.id))?.activatedVia == null);
  }

  // =========================================================================
  c.head("1 · the poll activates a paid program checkout once");
  // =========================================================================
  const paula = addSession({ name: "Paula Poll", email: "paula.poll@example.com", product: ACC_1Y, created: nowSec() - 3600 });
  addSession({ name: "Photo Buyer", email: "photos@example.com", product: PHOTO, mode: "payment", amount: 29900 });
  {
    const r = await ss.sweepStripeSignups();
    c.ok("the sweep activated exactly the new program checkout", r.activated === 1, JSON.stringify(r));
    const row = await signupRow(paula.id);
    c.ok("one ProgramSignup, ACTIVATED, activatedVia poll", row?.status === "ACTIVATED" && row.activatedVia === "poll", `${row?.status} / ${row?.activatedVia}`);
    const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: row!.enrollmentId! } });
    c.ok("the enrollment is Accelerator, MONTHLY_CONTRACT, 12 months", e.package === "Accelerator" && e.billingType === "MONTHLY_CONTRACT" && e.billingMonths === 12, `${e.package} ${e.billingType} ${e.billingMonths}`);
    c.ok("startedAt is the checkout's own time", e.startedAt?.getTime() === paula.created * 1000);
    c.ok("this month's workspace exists", (await prisma.contentMonth.count({ where: { enrollmentId: e.id, monthKey: etMonthKey() } })) === 1);
    c.ok("a photo payment is not a program signup", (await prisma.programSignup.count({ where: { email: "photos@example.com" } })) === 0);
    c.ok("the welcome went out once, through the outbox, to the payer", mailsTo("paula.poll@example.com").length === 1);
  }

  // =========================================================================
  c.head("2 · duplicates: poll twice, fetch-by-id twice");
  // =========================================================================
  {
    await ss.sweepStripeSignups();
    await ss.sweepStripeSignups();
    const o1 = await ss.processCheckoutSessionById(paula.id, "webhook");
    const o2 = await ss.processCheckoutSessionById(paula.id, "manual");
    c.ok("a repeat is 'known'", o1 === "known" && o2 === "known", `${o1} ${o2}`);
    const n = await counts(paula.id, "paula.poll@example.com");
    c.ok("1 signup · 1 enrollment · 1 seat · 1 welcome · 1 signup bell", n.signups === 1 && n.enrollments === 1 && n.seats === 1 && n.welcomes === 1 && n.bells === 1, JSON.stringify(n));
    c.ok("still activatedVia poll (a repeat does not restamp)", (await signupRow(paula.id))?.activatedVia === "poll");
  }

  // =========================================================================
  c.head("3 · race: the poll and the webhook path on one fresh checkout");
  // =========================================================================
  for (let i = 1; i <= 3; i++) {
    const email = `racer${i}@example.com`;
    const s = addSession({ name: `Rae Racer${i}`, email, product: ACC_1Y });
    let threw: unknown = null;
    const res = await Promise.all([
      ss.sweepStripeSignups().then((r) => `poll:${r.activated}`),
      ss.processCheckoutSessionById(s.id, "webhook"),
      ss.processCheckoutSessionById(s.id, "webhook"),
    ]).catch((e) => { threw = e; return [] as string[]; });
    const n = await counts(s.id, email);
    const activations = res.filter((x) => x === "activated" || x === "poll:1").length;
    c.ok(`race ${i}: nothing threw`, threw === null, threw ? String(threw) : res.join(" "));
    c.ok(`race ${i}: exactly one activation`, activations === 1, res.join(" "));
    c.ok(`race ${i}: 1 signup · 1 enrollment · 1 seat · 1 welcome · 1 bell`, n.signups === 1 && n.enrollments === 1 && n.seats === 1 && n.welcomes === 1 && n.bells === 1, JSON.stringify(n));
  }
  // The sweep lists first, which hands the webhook a head start. So race the
  // poll's own per-checkout step against the webhook's — the two claims leave
  // the gate together.
  for (let i = 1; i <= 3; i++) {
    const email = `photo-finish${i}@example.com`;
    const s = addSession({ name: `Pat Finish${i}`, email, product: ACC_1Y });
    const res = await Promise.all([ss.processCheckoutSession(JSON.parse(JSON.stringify(s)), "poll"), ss.processCheckoutSessionById(s.id, "webhook")]);
    const n = await counts(s.id, email);
    const row = await signupRow(s.id);
    c.ok(`head-to-head ${i}: one 'activated', one 'known'`, res.filter((x) => x === "activated").length === 1 && res.filter((x) => x === "known").length === 1, res.join(" "));
    c.ok(`head-to-head ${i}: one of everything, stamped by the winner (${row?.activatedVia})`, n.signups === 1 && n.enrollments === 1 && n.seats === 1 && n.welcomes === 1 && n.bells === 1 && row?.activatedVia === (res[0] === "activated" ? "poll" : "webhook"), JSON.stringify(n));
  }

  // =========================================================================
  c.head("4 · asynchronous payments: nothing until paid, then once");
  // =========================================================================
  const ada = addSession({ name: "Ada Async", email: "ada.async@example.com", product: ACC_1Y, payment_status: "unpaid" });
  {
    await ss.sweepStripeSignups();
    const viaEvent = await sw.handleStripeEvent({ id: "evt_drill_ada_completed", type: "checkout.session.completed", objectId: ada.id, livemode: true, created: nowSec() });
    c.ok("unpaid: the poll and the completed event write nothing", (await prisma.programSignup.count({ where: { checkoutId: ada.id } })) === 0 && viaEvent.outcome === "not_paid", viaEvent.outcome);
    ada.payment_status = "paid";
    const settled = nowSec() - 30;
    const r = await sw.handleStripeEvent({ id: "evt_drill_ada_paid", type: "checkout.session.async_payment_succeeded", objectId: ada.id, livemode: true, created: settled });
    const row = await signupRow(ada.id);
    c.ok("async_payment_succeeded activates it (activatedVia webhook)", r.outcome === "activated" && row?.status === "ACTIVATED" && row.activatedVia === "webhook", `${r.outcome} ${row?.activatedVia}`);
    c.ok("dated at the settlement, not the checkout", row?.paidAt.getTime() === settled * 1000);
    const late = await sw.handleStripeEvent({ id: "evt_drill_ada_late", type: "checkout.session.completed", objectId: ada.id, livemode: true, created: nowSec() });
    c.ok("a late completed event is 'known'", late.outcome === "known", late.outcome);
    const failedS = addSession({ name: "Fay Failed", email: "fay@example.com", product: ACC_1Y, payment_status: "unpaid" });
    const expiredS = addSession({ name: "Eli Expired", email: "eli@example.com", product: ACC_1Y, status: "expired", payment_status: "unpaid" });
    const f = await sw.handleStripeEvent({ id: "evt_drill_fail", type: "checkout.session.async_payment_failed", objectId: failedS.id, livemode: true, created: nowSec() });
    const x = await sw.handleStripeEvent({ id: "evt_drill_exp", type: "checkout.session.expired", objectId: expiredS.id, livemode: true, created: nowSec() });
    await ss.sweepStripeSignups();
    c.ok("async_payment_failed and expired are recorded, never activated", f.outcome === "recorded" && x.outcome === "recorded" && (await prisma.programSignup.count({ where: { checkoutId: { in: [failedS.id, expiredS.id] } } })) === 0);
  }

  // =========================================================================
  c.head("5 · a $0 checkout does not activate");
  // =========================================================================
  {
    const zero = addSession({ name: "Zed Zero", email: "zed@example.com", product: ACC_1Y, amount: 0, payment_status: "no_payment_required" });
    await ss.sweepStripeSignups();
    const o = await ss.processCheckoutSessionById(zero.id, "webhook");
    c.ok("no_payment_required writes nothing from the poll or the event", o === "not_paid" && (await prisma.programSignup.count({ where: { checkoutId: zero.id } })) === 0, o);
    c.ok("the rule is a named constant: only 'paid' activates", ss.ACTIVATING_PAYMENT_STATUS === "paid" && !ss.isActivatingSession({ status: "complete", payment_status: "no_payment_required" }) && !ss.isActivatingSession({ status: "complete", payment_status: "unpaid" }));
  }

  // =========================================================================
  c.head("6 · the signature check");
  // =========================================================================
  {
    const secret = "whsec_drill_secret_value";
    const body = JSON.stringify({ id: "evt_sig", type: "checkout.session.completed" });
    const t = nowSec();
    const sign = (sec: string, b: string, ts = t) => crypto.createHmac("sha256", sec).update(`${ts}.${b}`).digest("hex");
    c.ok("valid", sw.verifyStripeSignature(body, `t=${t},v1=${sign(secret, body)}`, secret).ok === true);
    const wrong = sw.verifyStripeSignature(body, `t=${t},v1=${sign("whsec_other", body)}`, secret);
    c.ok("wrong secret → bad-signature", !wrong.ok && wrong.reason === "bad-signature");
    const tampered = sw.verifyStripeSignature(body.replace("completed", "expired"), `t=${t},v1=${sign(secret, body)}`, secret);
    c.ok("tampered body → bad-signature", !tampered.ok && tampered.reason === "bad-signature");
    const old = t - 301;
    const stale = sw.verifyStripeSignature(body, `t=${old},v1=${sign(secret, body, old)}`, secret);
    c.ok("a genuine signature more than 300s old → stale", !stale.ok && stale.reason === "stale");
    c.ok("several v1 values, one valid (a secret being rolled) → valid", sw.verifyStripeSignature(body, `t=${t},v1=${sign("whsec_old", body)},v1=${sign(secret, body)},v0=abc`, secret).ok === true);
    const bad = ["", "garbage", `v1=${sign(secret, body)}`, `t=${t}`, `t=abc,v1=${sign(secret, body)}`].map((h) => sw.verifyStripeSignature(body, h, secret));
    c.ok("malformed headers → malformed", bad.every((r) => !r.ok && r.reason === "malformed"), bad.map((r) => (r.ok ? "ok" : r.reason)).join(","));
  }

  // =========================================================================
  c.head("7 · the route: fail closed, verify, process once");
  // =========================================================================
  {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const { NextRequest } = await import("next/server");
    const post = (raw: string, sig: string | null) =>
      POST(new NextRequest("http://127.0.0.1/api/webhooks/stripe", { method: "POST", body: raw, headers: sig ? { "stripe-signature": sig } : {} }));
    const event = (id: string, type: string, objectId: string, livemode = true) => JSON.stringify({ id, object: "event", type, livemode, created: nowSec(), data: { object: { id: objectId, object: "checkout.session" } } });
    const sign = (sec: string, raw: string) => { const t = nowSec(); return `t=${t},v1=${crypto.createHmac("sha256", sec).update(`${t}.${raw}`).digest("hex")}`; };
    const quietS = addSession({ name: "Quinn Route", email: "quinn.route@example.com", product: ACC_1Y });

    const raw1 = event("evt_drill_route_1", "checkout.session.completed", quietS.id);
    const noSecret = await post(raw1, sign("whsec_anything", raw1));
    const rej1 = await prisma.webhookEvent.findFirst({ where: { provider: "stripe", status: "REJECTED" }, orderBy: { createdAt: "desc" } });
    c.ok("no secret saved → 401", noSecret.status === 401, String(noSecret.status));
    c.ok("… a REJECTED row, code no-secret, and the customer's body NOT kept", decodeRejection(rej1?.error)?.code === "no-secret" && rej1?.payload === "{}", rej1?.payload);
    c.ok("… and no signup", (await prisma.programSignup.count({ where: { checkoutId: quietS.id } })) === 0);

    const SECRET = "whsec_drill_route_secret";
    await saveSecret("stripe_webhook", SECRET);
    const bad = await post(raw1, sign("whsec_wrong", raw1));
    const rej2 = await prisma.webhookEvent.findFirst({ where: { provider: "stripe", status: "REJECTED" }, orderBy: { createdAt: "desc" } });
    c.ok("bad signature → 400 + a REJECTED bad-signature row, no signup", bad.status === 400 && decodeRejection(rej2?.error)?.code === "bad-signature" && (await prisma.programSignup.count({ where: { checkoutId: quietS.id } })) === 0, String(bad.status));
    c.ok("refusals on the unregistered receiver page nobody (no 'bouncing' bell)", (await prisma.notification.count({ where: { dedupeKey: { startsWith: "whrej-stripe" } } })) === 0);

    const ok = await post(raw1, sign(SECRET, raw1));
    const okBody = (await ok.json()) as { outcome?: string };
    const evRow = await prisma.webhookEvent.findFirst({ where: { provider: "stripe", externalId: "evt_drill_route_1" } });
    c.ok("valid → 200, activated, the row PROCESSED", ok.status === 200 && okBody.outcome === "activated" && evRow?.status === "PROCESSED", `${ok.status} ${okBody.outcome} ${evRow?.status}`);
    c.ok("the stored row is the event's identity only — no email, no amount", !!evRow && !/@|amount|quinn/i.test(evRow.payload), evRow?.payload);
    c.ok("activatedVia webhook", (await signupRow(quietS.id))?.activatedVia === "webhook");
    const fetchesBefore = sessionFetches;
    const again = await post(raw1, sign(SECRET, raw1));
    const againBody = (await again.json()) as { duplicate?: boolean };
    c.ok("the same event delivered again → 200, processed once", again.status === 200 && againBody.duplicate === true && sessionFetches === fetchesBefore && (await prisma.webhookEvent.count({ where: { provider: "stripe", externalId: "evt_drill_route_1" } })) === 1);
    const testS = addSession({ name: "Tess Testmode", email: "tess@example.com", product: ACC_1Y });
    const rawT = event("evt_drill_route_test", "checkout.session.completed", testS.id, false);
    const t = await post(rawT, sign(SECRET, rawT));
    const tBody = (await t.json()) as { outcome?: string };
    c.ok("livemode false → 200, ignored, nothing activated", t.status === 200 && tBody.outcome === "ignored" && (await prisma.programSignup.count({ where: { checkoutId: testS.id } })) === 0, tBody.outcome);
  }

  // =========================================================================
  c.head("8 · discovery booked BEFORE the payment was polled");
  // =========================================================================
  {
    const email = "dana.discovery@example.com";
    const start = new Date(Date.now() + 4 * 86_400_000);
    const rec = await discoveryRecord(email, "Dana Discovery", start);
    const s = addSession({ name: "Dana Discovery", email, product: ACC_1Y });
    const o = await ss.processCheckoutSessionById(s.id, "webhook");
    const cl = await clientOf(email);
    const after = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: rec.id } });
    c.ok("activated", o === "activated", o);
    c.ok("the booking is now MATCHED to the new client", after.matchState === "MATCHED" && after.clientId === cl?.id, `${after.matchState} ${after.clientId === cl?.id}`);
    const w = mailsTo(email);
    c.ok("ONE welcome, and it says the call 'is booked for' — never 'Book your brand discovery call'", w.length === 1 && w[0].body.includes("is booked for") && !w[0].body.includes("Book your brand discovery call"), w[0]?.body.split("\n").find((l) => l.startsWith("1.")));
    const enr = await prisma.contentEnrollment.findFirstOrThrow({ where: { clientId: cl!.id } });
    c.ok("one onboarding record, pointed at that booking", (await prisma.programOnboarding.count({ where: { enrollmentId: enr.id } })) === 1 && (await prisma.programOnboarding.findUnique({ where: { enrollmentId: enr.id } }))?.discoveryCallRecordId === rec.id);
    const task = await discoveryTask(enr.id);
    c.ok("no open 'book the discovery call' task for Kyle", !task || task.status === "COMPLETED" || task.status === "CANCELLED", task?.status ?? "none");
  }

  // =========================================================================
  c.head("9 · payment FIRST, the booking later (a real client)");
  // =========================================================================
  {
    const email = "rita.real@example.com";
    const s = addSession({ name: "Rita Real", email, product: ACC_1Y });
    await ss.sweepStripeSignups();
    const cl = await clientOf(email);
    const enr = await prisma.contentEnrollment.findFirstOrThrow({ where: { clientId: cl!.id } });
    const w = mailsTo(email);
    c.ok("the welcome carries the booking link", w.length === 1 && w[0].body.includes("https://calendly.com/realtourpilot/brand-discovery"), w[0]?.body.split("\n").find((l) => l.startsWith("1.")));
    c.ok("Kyle has ONE open discovery task", (await discoveryTask(enr.id))?.status === "OPEN" && (await prisma.smartTask.count({ where: { dedupeKey: `program-discovery-booking:${enr.id}` } })) === 1);
    // The booking lands: the call-record sync matches it by email (the path it always takes).
    const rec = await discoveryRecord(email, "Rita Real", new Date(Date.now() + 5 * 86_400_000));
    await prisma.programCallRecord.update({ where: { id: rec.id }, data: { matchState: "MATCHED", clientId: cl!.id, enrollmentId: enr.id } });
    await reconcileDiscoveryTasks();
    c.ok("reconcileDiscoveryTasks closes it", (await discoveryTask(enr.id))?.status === "COMPLETED");
    await ss.sweepStripeSignups();
    c.ok("and no second welcome is queued", mailsTo(email).length === 1 && (await prisma.outboxMessage.count({ where: { toRef: email } })) === 1);
    c.ok("signup still one row", (await prisma.programSignup.count({ where: { checkoutId: s.id } })) === 1);
  }

  // =========================================================================
  c.head("10 · an existing enrollment keeps what the owner entered");
  // =========================================================================
  {
    const cl = await prisma.client.create({ data: { name: "Evan Existing", email: "evan.existing@example.com" } });
    const e = await prisma.contentEnrollment.create({ data: { clientId: cl.id, package: "Accelerator", videosPerMonth: 5, sessionsPerMonth: 1, sessionHours: 4, status: "ACTIVE", packageSource: "manual", billingType: "PAID_IN_FULL", billingRate: 15588, billingMonths: 12 } });
    const s = addSession({ name: "Evan Existing", email: "evan.existing@example.com", product: START_M2M, amount: 129900 });
    await ss.sweepStripeSignups();
    const after = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: e.id } });
    const row = await signupRow(s.id);
    c.ok("package, allowance and billing are untouched", after.package === "Accelerator" && after.videosPerMonth === 5 && after.billingType === "PAID_IN_FULL" && after.billingRate === 15588, `${after.package} ${after.videosPerMonth} ${after.billingType}`);
    c.ok("the signup note records both mismatches for a person", row?.status === "NEEDS_REVIEW" && /Paid for Starter/.test(row.note ?? "") && /billing left as the owner entered it/.test(row.note ?? ""), row?.note ?? "");
  }

  // =========================================================================
  c.head("11 · subscription events re-read Stripe");
  // =========================================================================
  {
    const email = "sam.sub@example.com";
    const sub = { id: "sub_drill_sam", status: "active", billing_cycle_anchor: nowSec() - 5 * 86_400 };
    subs.set(sub.id, sub);
    const s = addSession({ name: "Sam Sub", email, product: ACC_1Y, subscription: sub.id });
    await ss.processCheckoutSessionById(s.id, "webhook");
    sub.status = "past_due";
    const r = await sw.handleStripeEvent({ id: "evt_drill_sub", type: "customer.subscription.updated", objectId: sub.id, livemode: true, created: nowSec() });
    const row = await signupRow(s.id);
    c.ok("checked, and the billing anchor recorded (owner-only)", r.outcome === "subscription_checked" && row?.billingAnchorAt?.getTime() === sub.billing_cycle_anchor * 1000, r.detail);
    c.ok("a lapse rings the owner once", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `sub-${sub.id}-past_due` } } })) === 1);
    const stranger = await sw.handleStripeEvent({ id: "evt_drill_sub2", type: "customer.subscription.deleted", objectId: "sub_not_ours", livemode: true, created: nowSec() });
    c.ok("someone else's subscription is not ours", stranger.outcome === "not_ours");
  }

  // =========================================================================
  c.head("12 · a Stripe row left ERROR is replayed by the retry job");
  // =========================================================================
  {
    const s = addSession({ name: "Rory Retry", email: "rory.retry@example.com", product: ACC_1Y });
    const summary = { id: "evt_drill_retry", type: "checkout.session.completed", objectId: s.id, livemode: true, created: nowSec() };
    const row = await prisma.webhookEvent.create({ data: { provider: "stripe", eventType: summary.type, externalId: summary.id, payload: JSON.stringify(summary), status: "ERROR", error: "Stripe error 500" } });
    const r = await retryFailedWebhooks();
    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    c.ok("replayed → PROCESSED, and the signup activated", after.status === "PROCESSED" && (await signupRow(s.id))?.status === "ACTIVATED", `${after.status} ${JSON.stringify(r)}`);
  }

  // =========================================================================
  c.head("13 · docs guard");
  // =========================================================================
  {
    const routeExists = fs.existsSync(path.join(REPO, "src/app/api/webhooks/stripe/route.ts"));
    const docs = execFileSync("grep", ["-rl", "/api/webhooks/stripe", path.join(REPO, "docs")], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    c.ok("every doc that names /api/webhooks/stripe has a route behind it", docs.length > 0 && routeExists, docs.map((d) => path.relative(REPO, d)).join(", "));
    const now = fs.readFileSync(path.join(REPO, "docs/integration-tasks.md"), "utf8");
    c.ok("the 'authorize me and I will create it' offer is gone", !/Alternatively, authorize me/i.test(now));
    c.ok("the docs state polling and its real delay", /every hour at :00/.test(now) && /within the hour/.test(now));
  }

  c.head("isolation");
  c.ok("nothing was written to Stripe", stripeWrites.length === 0, stripeWrites.join(", "));
  c.ok("nothing left the machine except the fakes (Stripe, Google token, Gmail send)", fence.blocked.length === 0, fence.blocked.join(", "));
  console.log(`  (faked calls: ${fence.faked.length} · emails captured: ${mails.length} · prisma error lines swallowed: ${quiet.count})`);

  c.summary();
  quiet.restore();
  try { fs.unlinkSync(path.join(base.dir, "node_modules")); fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  await stop();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
