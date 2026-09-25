// ---------------------------------------------------------------------------
// DRILL: B2-SIGNUPS — the website-signup items of the unified handoff's batch 2
// (Sep 25 2026). The price catalogue, truncation and the webhook card's
// coverage bell are in cp14-stripe-activation.ts §14–16; this drill holds the
// rest:
//
//   1. A03(b): two DIFFERENT paid checkouts for one brand-new address,
//      processed at once. OLD (f2555f7): two Client rows. NEW: one client, one
//      enrollment, two signup rows (the second says "existing enrollment" and
//      waits for a person), one seat, one welcome.
//   2. §6.1 payer ≠ invitee, discovery booked FIRST (the live Arielle shape),
//      through the REAL Calendly sync against a fake Calendly. OLD: the welcome
//      says "Book your brand discovery call" and Kyle is told to book it. NEW:
//      the welcome's first step is the conditional wording, Kyle is asked to
//      CONFIRM the booking (it names it), the address is proposed — never
//      verified — and after a person verifies it and the next sync runs, the
//      booking is MATCHED, the onboarding points at it, Kyle's task closes,
//      and there is still exactly one welcome. A stranger's booking and a
//      first-name-only booking are NOT candidates.
//   3. Calendly event types (ALREADY_FIXED): a booking on an unmapped type
//      named "Brand Discovery Call" writes no record — URI, never the name.
//   4. Account scoping (ALREADY_FIXED): an address seated on another client is
//      refused, and its name is not rewritten.
//   5. Brand setup (ALREADY_FIXED): a new signup starts with every brand step
//      open (colours, logo, headshot, fonts, links, music).
//   6. scripts/_ops/register-stripe-webhook.ts against a FAKE Stripe account:
//      no key → refused; a stored key this machine's APP_SECRET cannot open →
//      refused (a secret saved from here would not open on the hub either); dry run → nothing sent or saved; --apply → one POST
//      with exactly the URL, 5 events and description, the secret saved
//      encrypted and never printed, read back, rollback printed; the receiver
//      then verifies with that secret; a second --apply is refused; a rollback
//      of someone else's endpoint is refused; our rollback deletes and
//      disconnects; a response without a secret is refused with the rollback.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/b2-signups.ts
//
// ISOLATION: PGlite on 127.0.0.1:5624. Stripe, Calendly, Google's token
// endpoint and Gmail's send are fakes inside the fence; the only Stripe writes
// allowed are the script's, to the fake /v1/webhook_endpoints.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5624);
const REPO = path.resolve(__dirname, "../..");
const OLD_BASE = "f2555f7"; // pinned: the commit batch 2 starts from

installNextStubs();

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
let seq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- fake Stripe: checkout sessions (read) + webhook endpoints (the script) --
type FakeSession = {
  id: string; object: "checkout.session"; status: string; payment_status: string; mode: string; amount_total: number; created: number;
  customer: string; subscription: string | null;
  customer_details: { email: string | null; name: string | null; phone: string | null };
  line_items: { data: { description: string; price: { id: string; product: string } }[] };
};
const sessions = new Map<string, FakeSession>();
type Endpoint = { id: string; url: string; status: string; enabled_events: string[]; description: string | null };
const endpoints = new Map<string, Endpoint>();
const FAKE_WHSEC = `whsec_${crypto.randomBytes(24).toString("hex")}`;
let omitSecret = false;
const endpointCalls: { method: string; path: string; body: string }[] = [];
const otherStripeWrites: string[] = [];

// ---- fake Calendly -----------------------------------------------------------
const CAL = "https://api.calendly.com";
const DISCOVERY_TYPE = `${CAL}/event_types/drill-discovery`;
const UNMAPPED_TYPE = `${CAL}/event_types/drill-unmapped`;
type CalEvent = { uri: string; name: string; status: string; start_time: string; end_time: string; event_type: string; location: { join_url: string } };
type CalInvitee = { email: string; name: string; status: string; uri: string; timezone: string; rescheduled: boolean };
const calendly = new Map<string, { event: CalEvent; invitee: CalInvitee }>();
function book(o: { email: string; name: string; start: Date; type?: string; title?: string }): string {
  const uuid = `drill-ev-${++seq}`;
  const uri = `${CAL}/scheduled_events/${uuid}`;
  calendly.set(uuid, {
    event: { uri, name: o.title ?? "Brand discovery call", status: "active", start_time: o.start.toISOString(), end_time: new Date(o.start.getTime() + 3_600_000).toISOString(), event_type: o.type ?? DISCOVERY_TYPE, location: { join_url: `https://meet.google.com/drill-${seq}` } },
    invitee: { email: o.email, name: o.name, status: "active", uri: `${uri}/invitees/inv-${seq}`, timezone: "America/New_York", rescheduled: false },
  });
  return uri;
}

// ---- fake Gmail --------------------------------------------------------------
type Mail = { to: string; subject: string; body: string };
const mails: Mail[] = [];
function decodeMime(raw: string): Mail {
  const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const [head, ...rest] = text.split("\r\n\r\n");
  const to = /^To: (.+)$/m.exec(head)?.[1] ?? "";
  const subjB64 = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
  return { to, subject: Buffer.from(subjB64, "base64").toString("utf8"), body: rest.join("\r\n\r\n") };
}

const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    mails.push(decodeMime(raw));
    return json({ id: `gm-${mails.length}` });
  }
  if (u.hostname === "api.calendly.com") {
    const p = u.pathname;
    if (p === "/users/me") return json({ resource: { uri: `${CAL}/users/DRILL`, current_organization: `${CAL}/organizations/DRILL` } });
    if (p === "/scheduled_events") {
      const min = Date.parse(u.searchParams.get("min_start_time") ?? "1970-01-01");
      const max = Date.parse(u.searchParams.get("max_start_time") ?? "2999-01-01");
      const collection = [...calendly.values()].map((x) => x.event).filter((e) => Date.parse(e.start_time) >= min && Date.parse(e.start_time) <= max);
      return json({ collection, pagination: { next_page: null } });
    }
    let m = /^\/scheduled_events\/([^/]+)\/invitees$/.exec(p);
    if (m) return json({ collection: calendly.has(m[1]) ? [calendly.get(m[1])!.invitee] : [] });
    m = /^\/scheduled_events\/([^/]+)$/.exec(p);
    if (m) return calendly.has(m[1]) ? json({ resource: calendly.get(m[1])!.event }) : json({ message: "not found" }, 404);
    return json({ message: `drill: unknown Calendly path ${p}` }, 404);
  }
  if (u.hostname !== "api.stripe.com") return null;
  const p = u.pathname;
  if (p === "/v1/webhook_endpoints" || p.startsWith("/v1/webhook_endpoints/")) {
    endpointCalls.push({ method, path: p, body: String(init?.body ?? "") });
    const id = p.split("/")[3] ?? null;
    if (!id && method === "GET") return json({ object: "list", data: [...endpoints.values()], has_more: false });
    if (!id && method === "POST") {
      const f = new URLSearchParams(String(init?.body ?? ""));
      const ep: Endpoint = { id: `we_drill${String(++seq).padStart(6, "0")}`, url: f.get("url") ?? "", status: "enabled", enabled_events: f.getAll("enabled_events[]"), description: f.get("description") };
      endpoints.set(ep.id, ep);
      return json(omitSecret ? ep : { ...ep, secret: FAKE_WHSEC });
    }
    if (id && method === "GET") return endpoints.has(id) ? json(endpoints.get(id)) : json({ error: { message: "No such webhook endpoint" } }, 404);
    if (id && method === "DELETE") {
      if (!endpoints.has(id)) return json({ error: { message: "No such webhook endpoint" } }, 404);
      endpoints.delete(id);
      return json({ id, object: "webhook_endpoint", deleted: true });
    }
    return json({ error: { message: "drill: unsupported" } }, 405);
  }
  if (method !== "GET") { otherStripeWrites.push(url); return json({ error: { message: "drill: the hub never writes to Stripe" } }, 405); }
  if (p === "/v1/checkout/sessions") {
    const gte = Number(u.searchParams.get("created[gte]") ?? 0);
    return json({ data: [...sessions.values()].filter((s) => s.created >= gte).sort((a, b) => b.created - a.created), has_more: false });
  }
  const m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(p);
  if (m) return sessions.has(m[1]) ? json(sessions.get(m[1])) : json({ error: { message: "No such checkout.session" } }, 404);
  return json({ error: { message: `drill: unknown Stripe path ${p}` } }, 404);
});

/** A paid Accelerator 1-Year checkout on its real catalogue price. */
function paid(name: string, email: string): FakeSession {
  const id = `cs_live_b2drill${String(++seq).padStart(4, "0")}${crypto.randomBytes(3).toString("hex")}`;
  const s: FakeSession = {
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "subscription", amount_total: 149900, created: nowSec() - 300,
    customer: `cus_b2drill${seq}`, subscription: null,
    customer_details: { email, name, phone: null },
    line_items: { data: [{ description: "Video Accelerator — 1-Year Commitment", price: { id: "price_1ToRWNRrlUAkQjeVnlqXzQZp", product: "prod_Uo3dmrwsPqyCVR" } }] },
  };
  sessions.set(id, s);
  return s;
}

/** `commit`'s copies of `files` (paths under src/, no extension), wired to each
 *  other; every other `@/` import aimed at this tree. */
function oldCopies(commit: string, files: string[]): { dir: string; at: (f: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b2-${commit}-`));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const at = (f: string) => path.join(dir, `${f.replace(/\//g, "_")}.old.ts`);
  for (const f of files) {
    const src = execFileSync("git", ["show", `${commit}:src/${f}.ts`], { cwd: REPO, encoding: "utf8" });
    fs.writeFileSync(at(f), src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${files.includes(p) ? at(p) : path.join(REPO, "src", p)}${q}`));
  }
  return { dir, at };
}

async function main() {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret, getSecret } = await import("@/lib/integrations/connections");
  const ss = await import("@/lib/stripeSignups");
  const { syncCallRecordsFromCalendly, verifyClientEmailAlias } = await import("@/lib/contentCallRecords");
  const { reconcileDiscoveryTasks } = await import("@/lib/programOnboarding");
  const { registerStripeWebhook, ENDPOINT_URL, ENDPOINT_DESCRIPTION } = await import("../_ops/register-stripe-webhook");
  const { STRIPE_WEBHOOK_EVENTS } = await import("@/lib/stripeWebhook");
  const logs: string[] = [];
  const run = (argv: string[]) => registerStripeWebhook(argv, (l) => logs.push(l));
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const mailsTo = (email: string) => mails.filter((m) => m.to.toLowerCase() === email.toLowerCase());
  const lineOne = (m?: Mail) => m?.body.split("\n").find((l) => l.startsWith("1.")) ?? "";
  const clientsWith = (email: string) => prisma.client.findMany({ where: { email: { equals: email, mode: "insensitive" } } });
  const discoveryTask = (enrollmentId: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `program-discovery-booking:${enrollmentId}` } });
  const enrollmentFor = async (email: string) => {
    const cl = (await clientsWith(email))[0];
    return cl ? prisma.contentEnrollment.findUnique({ where: { clientId: cl.id } }) : null;
  };

  // =========================================================================
  c.head("6a · the registration script with no Stripe key refuses");
  // =========================================================================
  {
    const r = await run([]);
    c.ok("no stored key → refused before any request", r.code === 1 && r.refused === "no-key" && endpointCalls.length === 0, JSON.stringify(r));
    // A key saved by a hub whose APP_SECRET is not this machine's: stored, but it will not open here.
    await prisma.connection.create({ data: { provider: "stripe", status: "CONNECTED", secretEncrypted: "not-a-blob-this-app-secret-can-open" } });
    const m = await run(["--apply"]);
    c.ok("a stored key that does not decrypt here (APP_SECRET is not production's) → refused, nothing sent", m.code === 1 && m.refused === "app-secret-mismatch" && endpointCalls.length === 0, JSON.stringify(m));
  }

  await saveSecret("stripe", ["sk", "live", "b2drillNotARealKey0000"].join("_") /* built at run time: a literal trips GitHub push protection */);
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
  await saveSecret("calendly", "drill-calendly-token");
  // Isolated database only: invitations ON, so welcome rows can be counted.
  await prisma.programAutomation.create({ data: { key: "portal_invites", enabled: true, enabledBy: "drill", enabledAt: new Date() } });
  await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: DISCOVERY_TYPE, eventName: "Brand discovery call", publicUrl: "https://calendly.com/realtourpilot-info/brand-discovery-call", purpose: "BRAND_DISCOVERY", enabled: true, validationStatus: "VALID" } });

  // =========================================================================
  c.head("1 · A03(b): two different checkouts, one brand-new address, at once");
  // =========================================================================
  {
    const old = oldCopies(OLD_BASE, ["lib/stripeSignups"]);
    const oldSs = (await import(old.at("lib/stripeSignups"))) as { processCheckoutSession: typeof ss.processCheckoutSession };
    const o1 = paid("Tia Twin", "tia.twin@example.com");
    const o2 = paid("Tia Twin", "tia.twin@example.com");
    const oldRes = await Promise.all([oldSs.processCheckoutSession(clone(o1), "poll"), oldSs.processCheckoutSession(clone(o2), "poll")]);
    const oldClients = await clientsWith("tia.twin@example.com");
    c.ok("OLD: the unlocked find-or-create made TWO client records for one person", oldClients.length === 2, `${oldClients.length} clients · ${oldRes.join(" ")}`);
    try { fs.unlinkSync(path.join(old.dir, "node_modules")); fs.rmSync(old.dir, { recursive: true, force: true }); } catch { /* harmless */ }

    const n1 = paid("Theo Twin", "theo.twin@example.com");
    const n2 = paid("Theo Twin", "theo.twin@example.com");
    const info: string[] = [];
    const realInfo = console.info;
    console.info = (...a: unknown[]) => { info.push(a.map(String).join(" ")); realInfo(...a); };
    const res = await Promise.all([ss.processCheckoutSession(clone(n1), "poll"), ss.processCheckoutSession(clone(n2), "webhook")]).finally(() => { console.info = realInfo; });
    const cl = await clientsWith("theo.twin@example.com");
    const rows = await prisma.programSignup.findMany({ where: { checkoutId: { in: [n1.id, n2.id] } }, orderBy: { createdAt: "asc" } });
    const enr = cl[0] ? await prisma.contentEnrollment.findMany({ where: { clientId: cl[0].id } }) : [];
    c.ok("NEW: both activate, nothing thrown", res.every((x) => x === "activated"), res.join(" "));
    c.ok("NEW: ONE client, ONE enrollment", cl.length === 1 && enr.length === 1, `${cl.length} clients · ${enr.length} enrollments`);
    c.ok("NEW: TWO signup rows, both on that enrollment", rows.length === 2 && rows.every((r) => r.enrollmentId === enr[0]?.id && r.clientId === cl[0]?.id));
    const second = rows.find((r) => r.status === "NEEDS_REVIEW");
    c.ok("NEW: the second says 'existing enrollment' and waits for a person; the first is clean", !!second && /existing enrollment/.test(second.note ?? "") && rows.filter((r) => r.status === "ACTIVATED" && !r.note).length === 1, second?.note ?? "");
    c.ok("NEW: both discovery steps completed — the second no longer trips on the onboarding row the first just made", info.filter((l) => l.startsWith("[signup]")).length === 2 && !info.some((l) => l.includes("discovery error")) && (await prisma.programOnboarding.count({ where: { enrollmentId: enr[0]?.id } })) === 1, info.filter((l) => l.includes("discovery")).map((l) => l.slice(0, 120)).join(" | "));
    c.ok("NEW: one seat, one welcome", (await prisma.clientMembership.count({ where: { clientId: cl[0]?.id } })) === 1 && mailsTo("theo.twin@example.com").length === 1 && (await prisma.outboxMessage.count({ where: { toRef: "theo.twin@example.com" } })) === 1);
    c.ok("(PGlite is one session, so this proves the path, not the lock under true contention — that is the R04 real-Postgres run)", true);
  }

  // =========================================================================
  c.head("2 · payer ≠ invitee, discovery booked FIRST (the Arielle shape)");
  // =========================================================================
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);
  {
    // --- OLD, f2555f7 end to end (signups, access, onboarding, call records).
    const files = ["lib/stripeSignups", "lib/portalAccess", "lib/programOnboarding", "lib/contentCallRecords"];
    const old = oldCopies(OLD_BASE, files);
    const oldSs = (await import(old.at("lib/stripeSignups"))) as { processCheckoutSession: typeof ss.processCheckoutSession };
    book({ email: "jo.oldfield@brokerage.example", name: "Jo Oldfield", start: inDays(3) });
    await syncCallRecordsFromCalendly();
    const s = paid("Jo Oldfield", "jo.oldfield@gmail.example");
    await oldSs.processCheckoutSession(clone(s), "poll");
    const w = mailsTo("jo.oldfield@gmail.example");
    const e = await enrollmentFor("jo.oldfield@gmail.example");
    const t = e ? await discoveryTask(e.id) : null;
    c.ok("OLD: the welcome tells her to book the call she already booked", w.length === 1 && lineOne(w[0]).startsWith("1. Book your brand discovery call at"), lineOne(w[0]));
    c.ok("OLD: and Kyle is handed 'Book the brand discovery call'", !!t && t.status === "OPEN" && t.title.startsWith("Book the brand discovery call"), t?.title);
    try { fs.unlinkSync(path.join(old.dir, "node_modules")); fs.rmSync(old.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  }
  {
    // --- NEW.
    const bookedUri = book({ email: "jane.doe@brokerage.example", name: "Jane Doe", start: inDays(4) });
    await syncCallRecordsFromCalendly();
    const rec0 = await prisma.programCallRecord.findUniqueOrThrow({ where: { calendlyEventUri: bookedUri } });
    const raw0 = JSON.parse(rec0.rawJson ?? "{}") as { identity?: { candidates?: unknown[] } };
    c.ok("(setup) the booking is on file UNMATCHED with no candidates — no program client existed to name", rec0.matchState === "UNMATCHED_INVITEE" && rec0.clientId === null && (raw0.identity?.candidates?.length ?? 0) === 0, rec0.matchState);

    const s = paid("Jane Doe", "jane.doe@gmail.example");
    const o = await ss.processCheckoutSessionById(s.id, "webhook");
    const e = await enrollmentFor("jane.doe@gmail.example");
    const cl = (await clientsWith("jane.doe@gmail.example"))[0];
    c.ok("activated: one client on the paying address, one enrollment", o === "activated" && !!e && (await clientsWith("jane.doe@gmail.example")).length === 1, o);
    const rec1 = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: rec0.id } });
    c.ok("activation did NOT match the booking — a different address is not proof", rec1.matchState === "UNMATCHED_INVITEE" && rec1.clientId === null);
    const w = mailsTo("jane.doe@gmail.example");
    c.ok("ONE welcome, and step 1 is the conditional wording", w.length === 1 && lineOne(w[0]).startsWith("1. If you've already booked your brand discovery call, you're all set and we'll confirm it with you. If not, book it at https://calendly.com/realtourpilot-info/brand-discovery-call"), lineOne(w[0]));
    c.ok("… never the bare 'Book your brand discovery call', and no booking named", !w[0].body.includes("Book your brand discovery call") && !w[0].body.includes("brokerage") && !w[0].body.includes("is booked for"));
    const t = await discoveryTask(e!.id);
    c.ok("Kyle's task asks him to CONFIRM the booking, on the same key", t?.status === "OPEN" && t.title === "Confirm the discovery booking is Jane Doe's", t?.title);
    c.ok("… and names it: invitee, record, payer, and where to verify", !!t?.description && t.description.includes("jane.doe@brokerage.example") && t.description.includes(rec0.id) && t.description.includes("jane.doe@gmail.example") && t.description.includes("Settings → Calendly & calls"));
    const alias = await prisma.clientEmailAlias.findFirst({ where: { clientId: cl.id, email: "jane.doe@brokerage.example" } });
    c.ok("the booking address is PROPOSED as her alias, not verified", !!alias && alias.verifiedAt === null && alias.active, alias?.source ?? "none");
    c.ok("one onboarding record", (await prisma.programOnboarding.count({ where: { enrollmentId: e!.id } })) === 1);
    const signup = await prisma.programSignup.findUnique({ where: { checkoutId: s.id } });
    c.ok("the signup itself is clean (the question is Kyle's task, not a parked payment)", signup?.status === "ACTIVATED", `${signup?.status} ${signup?.note ?? ""}`);

    // A person verifies the address; the next hourly sync and the onboarding reconcile run.
    await verifyClientEmailAlias(alias!.id, "drill:kyle");
    await syncCallRecordsFromCalendly();
    await reconcileDiscoveryTasks();
    const rec2 = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: rec0.id } });
    const ob = await prisma.programOnboarding.findUnique({ where: { enrollmentId: e!.id } });
    c.ok("after verification + a sync: the booking is MATCHED to her", rec2.matchState === "MATCHED" && rec2.clientId === cl.id && rec2.enrollmentId === e!.id, `${rec2.matchState} ${rec2.matchNote}`);
    c.ok("… the onboarding is pinned to it, still one onboarding row", ob?.discoveryCallRecordId === rec0.id && (await prisma.programOnboarding.count({ where: { enrollmentId: e!.id } })) === 1, ob?.status);
    c.ok("… Kyle's task COMPLETED", (await discoveryTask(e!.id))?.status === "COMPLETED");
    await ss.sweepStripeSignups();
    c.ok("… and still exactly one welcome", mailsTo("jane.doe@gmail.example").length === 1 && (await prisma.outboxMessage.count({ where: { toRef: "jane.doe@gmail.example" } })) === 1);
  }
  {
    // --- Not everyone is a candidate.
    book({ email: "sam.stranger@elsewhere.example", name: "Sam Stranger", start: inDays(5) });
    book({ email: "pat.other@elsewhere.example", name: "Pat", start: inDays(5) }); // first name only
    await syncCallRecordsFromCalendly();
    const s = paid("Pat Payer", "pat.payer@example.com");
    await ss.processCheckoutSessionById(s.id, "webhook");
    const e = await enrollmentFor("pat.payer@example.com");
    const cl = (await clientsWith("pat.payer@example.com"))[0];
    const w = mailsTo("pat.payer@example.com");
    c.ok("a stranger's booking and a first-name-only booking are not candidates: bare 'Book your…'", w.length === 1 && lineOne(w[0]).startsWith("1. Book your brand discovery call at"), lineOne(w[0]));
    c.ok("… Kyle gets the ordinary 'Book the brand discovery call' task", (await discoveryTask(e!.id))?.title.startsWith("Book the brand discovery call") === true);
    c.ok("… and no alias was proposed for either address", (await prisma.clientEmailAlias.count({ where: { clientId: cl.id } })) === 0);
  }

  // =========================================================================
  c.head("3 · Calendly: the URI decides, never the event's name (ALREADY_FIXED)");
  // =========================================================================
  {
    const uri = book({ email: "nina.name@example.com", name: "Nina Name", start: inDays(6), type: UNMAPPED_TYPE, title: "Brand Discovery Call" });
    const r = await syncCallRecordsFromCalendly();
    c.ok("a booking on an unmapped type called 'Brand Discovery Call' writes no record", (await prisma.programCallRecord.count({ where: { calendlyEventUri: uri } })) === 0 && "unrelated" in r && r.unrelated >= 1, JSON.stringify("unrelated" in r ? { unrelated: r.unrelated, created: r.created } : r));
  }

  // =========================================================================
  c.head("4 · account access stays with its client (ALREADY_FIXED)");
  // =========================================================================
  {
    const { grantProgramAccess } = await import("@/lib/portalAccess");
    const jane = await enrollmentFor("jane.doe@gmail.example");
    const jo = await prisma.clientUser.findUnique({ where: { email: "jo.oldfield@gmail.example" } });
    const g = await grantProgramAccess({ enrollmentId: jane!.id, emailRaw: "jo.oldfield@gmail.example", name: "Somebody Else", reason: "teammate" });
    const joAfter = await prisma.clientUser.findUnique({ where: { email: "jo.oldfield@gmail.example" } });
    c.ok("an address seated on another client is refused (CONFLICT), nothing seated here", g.outcome === "CONFLICT" && (await prisma.clientMembership.count({ where: { enrollmentId: jane!.id, clientUserId: jo?.id } })) === 0, g.outcome);
    c.ok("… and that person's name is not rewritten", !!jo && joAfter?.name === jo.name && jo.name === "Jo Oldfield", joAfter?.name ?? "");
  }

  // =========================================================================
  c.head("5 · brand setup starts open for a new signup (ALREADY_FIXED)");
  // =========================================================================
  {
    const { setupFacts, SETUP_ITEMS } = await import("@/lib/portalSetup");
    const e = await enrollmentFor("pat.payer@example.com");
    const f = await setupFacts(e!.id, e!.clientId);
    const keys = SETUP_ITEMS.map((i) => i.key as string);
    c.ok("the checklist carries colours, logo, headshot, fonts, links and music", ["colors", "logo", "headshot", "fonts", "links", "music"].every((k) => keys.includes(k)), keys.join(","));
    c.ok("… and every one is open for a client who has sent nothing", !f.colors && !f.logo && !f.headshot && !f.fonts && !f.links && !f.music, JSON.stringify(f));
  }

  // =========================================================================
  c.head("6 · scripts/_ops/register-stripe-webhook.ts against a fake Stripe");
  // =========================================================================
  {
    const posts = () => endpointCalls.filter((x) => x.method === "POST").length;
    logs.length = 0;
    const dry = await run([]);
    c.ok("dry run: exit 0, nothing POSTed, nothing saved", dry.code === 0 && dry.mode === "dry-run" && posts() === 0 && (await getSecret("stripe_webhook")) === null, JSON.stringify(dry));
    c.ok("… it prints the exact request: the URL, the 5 events, the description", logs.some((l) => l.includes(`url            = ${ENDPOINT_URL}`)) && STRIPE_WEBHOOK_EVENTS.every((ev) => logs.some((l) => l.endsWith(`enabled_events = ${ev}`))) && logs.some((l) => l.includes(ENDPOINT_DESCRIPTION)) && logs.some((l) => l.startsWith("DRY RUN")));
    c.ok("… and never the key", !logs.join("\n").includes("sk_live_b2drill"));

    logs.length = 0;
    const applied = await run(["--apply"]);
    const post = endpointCalls.find((x) => x.method === "POST");
    const f = new URLSearchParams(post?.body ?? "");
    c.ok("--apply: exit 0, ONE POST", applied.code === 0 && posts() === 1 && !!applied.endpointId, JSON.stringify(applied));
    c.ok("… url, events (all 5, in order) and description exactly", f.get("url") === "https://hub.realtourpilot.com/api/webhooks/stripe" && JSON.stringify(f.getAll("enabled_events[]")) === JSON.stringify([...STRIPE_WEBHOOK_EVENTS]) && f.get("description") === "RealTour Pilot hub: program signups", post?.body);
    c.ok("… the signing secret is saved encrypted and reads back", (await getSecret("stripe_webhook")) === FAKE_WHSEC && !(await prisma.connection.findUniqueOrThrow({ where: { provider: "stripe_webhook" } })).secretEncrypted!.includes(FAKE_WHSEC.slice(6)));
    c.ok("… it was NEVER printed", !logs.join("\n").includes(FAKE_WHSEC) && !logs.join("\n").includes(FAKE_WHSEC.slice(10, 30)));
    c.ok("… it read the endpoint back and printed the rollback", endpointCalls.some((x) => x.method === "GET" && x.path === `/v1/webhook_endpoints/${applied.endpointId}`) && logs.some((l) => l.includes(`--rollback ${applied.endpointId}`)) && logs.some((l) => l.includes("status enabled ✓") && l.includes("url ✓") && l.includes("events ✓")));

    // The receiver verifies with the secret the script saved.
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const { NextRequest } = await import("next/server");
    const s = paid("Reggie Registered", "reggie.registered@example.com");
    const raw = JSON.stringify({ id: "evt_b2_after_register", object: "event", type: "checkout.session.completed", livemode: true, created: nowSec(), data: { object: { id: s.id, object: "checkout.session" } } });
    const t = nowSec();
    const res = await POST(new NextRequest("http://127.0.0.1/api/webhooks/stripe", { method: "POST", body: raw, headers: { "stripe-signature": `t=${t},v1=${crypto.createHmac("sha256", FAKE_WHSEC).update(`${t}.${raw}`).digest("hex")}` } }));
    c.ok("the receiver verifies a post signed with that secret: 200, activated by webhook", res.status === 200 && (await prisma.programSignup.findUnique({ where: { checkoutId: s.id } }))?.activatedVia === "webhook", String(res.status));

    logs.length = 0;
    const again = await run(["--apply"]);
    c.ok("a second --apply is refused (an endpoint already has the hub's URL), no second POST", again.code === 1 && again.refused === "exists" && posts() === 1, JSON.stringify(again));

    endpoints.set("we_foreign00001", { id: "we_foreign00001", url: "https://elsewhere.example/hook", status: "enabled", enabled_events: ["charge.succeeded"], description: null });
    const foreign = await run(["--rollback", "we_foreign00001"]);
    c.ok("a rollback of someone else's endpoint is refused and deletes nothing", foreign.code === 1 && foreign.refused === "not-ours" && endpoints.has("we_foreign00001") && (await getSecret("stripe_webhook")) === FAKE_WHSEC);
    const junk = await run(["--rollback", "nonsense"]);
    const both = await run(["--apply", "--rollback", applied.endpointId!]);
    c.ok("a malformed id, or --apply with --rollback, is refused", junk.code === 2 && both.code === 2);
    // Batch-2 review: a well-formed id Stripe does not know (a typo, or an old
    // rollback line from before a second --apply) used to take the 404 branch
    // and wipe the WORKING endpoint's secret.
    logs.length = 0;
    const typo = await run(["--rollback", "we_typo0000000001"]);
    const connTypo = await prisma.connection.findUnique({ where: { provider: "stripe_webhook" }, select: { status: true } });
    c.ok("a rollback of an id Stripe does not know is refused; the working secret stays saved and connected", typo.code === 1 && typo.refused === "not-the-saved-endpoint" && (await getSecret("stripe_webhook")) === FAKE_WHSEC && connTypo?.status === "CONNECTED", JSON.stringify(typo));
    c.ok("… and it names the endpoint the secret belongs to", logs.some((l) => l.includes(`belongs to endpoint ${applied.endpointId}`)));

    const rb = await run(["--rollback", applied.endpointId!]);
    const conn = await prisma.connection.findUnique({ where: { provider: "stripe_webhook" } });
    c.ok("our rollback DELETEs the endpoint and disconnects the secret", rb.code === 0 && !endpoints.has(applied.endpointId!) && endpointCalls.some((x) => x.method === "DELETE") && (await getSecret("stripe_webhook")) === null && conn?.status === "DISCONNECTED", JSON.stringify(rb));
    const rb2 = await run(["--rollback", applied.endpointId!]);
    c.ok("a rollback of an endpoint already gone just clears the secret (exit 0)", rb2.code === 0);

    omitSecret = true;
    logs.length = 0;
    const noSecret = await run(["--apply"]);
    c.ok("a create response without a secret: nothing saved, exit 1, the rollback printed", noSecret.code === 1 && noSecret.refused === "no-secret-returned" && (await getSecret("stripe_webhook")) === null && logs.some((l) => l.includes(`--rollback ${noSecret.endpointId}`)), JSON.stringify(noSecret));
    omitSecret = false;
    await run(["--rollback", noSecret.endpointId!]);
    c.ok("(cleanup) the fake account holds only the foreign endpoint", endpoints.size === 1 && endpoints.has("we_foreign00001"));
  }

  c.head("isolation");
  c.ok("no Stripe write outside the script's /v1/webhook_endpoints", otherStripeWrites.length === 0, otherStripeWrites.join(", "));
  c.ok("nothing left the machine except the fakes (Stripe, Calendly, Google token, Gmail send)", fence.blocked.length === 0, fence.blocked.join(", "));
  console.log(`  (faked calls: ${fence.faked.length} · emails captured: ${mails.length} · prisma error lines swallowed: ${quiet.count})`);

  c.summary();
  quiet.restore();
  await stop();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
