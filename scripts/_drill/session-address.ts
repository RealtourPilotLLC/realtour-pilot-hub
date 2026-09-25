// ---------------------------------------------------------------------------
// DRILL: CP-05 — a general area at booking, the exact address later, verified
// on the Aryeo booking (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/session-address.ts
//
// What it proves, the OLD behaviour first (the OLD programReminders.ts is
// loaded for real from HEAD, its `@/` imports pointed at this tree):
//   0. OLD — the address lane was computed on a dry run only ("its client
//      template is not built"); a real run wrote and sent nothing for it.
//   1. Thursday: the Monday session's reminder waits for Friday 09:00 ET.
//   2. Friday 09:05: exactly ONE email, keyed on the session, with the
//      session's own link and Kyle's number, no em dash, subject "Where are we
//      filming your October session?" — and it takes the day's one email, so
//      the planning reminder due the same morning waits.
//   3. Re-runs Friday, Saturday, Monday: no second email.
//   4. The link: an area is refused; the exact address is SAVED (never
//      "confirmed"); the same address again changes nothing.
//   5. address_sync OFF: zero PATCH, Kyle's task; when Kyle's hand edit
//      reaches the order sync, the local readback confirms and closes it.
//   6. address_sync ON (authorised fixture): one PATCH with the fields, read
//      back equal → SYNCED; a second run patches nothing; another client's
//      address is never touched.
//   7. Address before Friday: no email. A queued email is cancelled
//      (address_received) when the address arrives.
//   8. PATCH timeout after commit → readback settles it, one PATCH; timeout
//      before commit → exactly one re-PATCH; 422 → FAILED + Kyle, and the
//      client is told Kyle is updating it by hand.
//   9. Shared addresses: two sessions on one order, or two jobs on one listing
//      → CONFLICT, zero PATCH, Kyle.
//  10. The link is bound to its session: closed at shoot start, refused for a
//      cancelled session (whose reminder is then not offered either).
//  11. Travel: same creative within 90 minutes that day → Kyle is told; the
//      session time never moves.
//  12. Clock variants: Tuesday → Friday, Wednesday → Monday, a Saturday
//      booking for Monday → Monday's opening, with ONE urgent Kyle task.
//  13. Fence: only the fake Aryeo, the stub geocoder, the stub Gmail.
//
// ISOLATION: PGlite on 127.0.0.1:5517 via the shared harness.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
// (Gmail is faked at the fence, not by module interception: the outbox reaches
// it through a dynamic import, which Node's ESM loader serves without passing
// the CommonJS loader the interceptor hooks.)
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 5517);
const REPO = path.resolve(__dirname, "../..");

installNextStubs();

let fake: ReturnType<typeof createFakeAryeo>;
// Gmail, answered at the network edge: the hub's real send code runs (token,
// MIME, POST), and the message it would have sent lands here instead.
const emails: { to: string; subject: string; body: string }[] = [];
const fence = fenceFetch(async (url, init) => {
  if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "drill-access", expires_in: 3600 }), { status: 200 });
  if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
    const raw = (JSON.parse(String(init?.body ?? "{}")) as { raw?: string }).raw ?? "";
    const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const [head, ...rest] = mime.split("\r\n\r\n");
    const to = /^To: (.+)$/m.exec(head)?.[1]?.trim() ?? "";
    const subj = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
    emails.push({ to, subject: Buffer.from(subj, "base64").toString("utf8"), body: rest.join("\r\n\r\n") });
    return new Response(JSON.stringify({ id: `drill-msg-${emails.length}` }), { status: 200 });
  }
  if (url.startsWith("https://geocoding.geo.census.gov/")) {
    return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: "117 KYLE LN, WEST CHESTER, PA, 19382" }] } }), { status: 200 });
  }
  if (url.startsWith("https://nominatim.openstreetmap.org/")) return new Response("[]", { status: 200 });
  return fake ? fake.handle(url, init) : null;
});


function writeBaseCopy(file: string): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp05-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `e26cacd:${file}`], { cwd: REPO, encoding: "utf8" });
  const out = path.join(dir, path.basename(file).replace(/\.ts$/, ".base.ts"));
  fs.writeFileSync(out, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return { dir, path: out };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
  fake = createFakeAryeo({ products: { [ARYEO_CONTENT_PRODUCTS.Accelerator.productId]: [DRILL_TEAM.james.tm] } });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-key-not-a-real-one");
  await saveSecret("calendly", "drill-calendly-not-real");
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-not-real" }));
  const rem = await import("@/lib/programReminders");
  const sa = await import("@/lib/sessionAddress");
  const base = writeBaseCopy("src/lib/programReminders.ts");

  // ET wall clock, October 2026 (EDT = UTC-4).
  const et = (day: string, h: number, m = 0) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h + 4, m));
  const HOUR = 3_600_000;
  let seq = 0;
  const james = await prisma.teamMember.create({ data: { name: "James Drill", email: "james-drill@example.com" }, select: { id: true } });

  const setSwitch = (key: string, enabled: boolean, config: Record<string, unknown> | null = null) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });
  /** Both booking feeds read as synced an hour before the simulated `now`. */
  const freshFeeds = async (now: Date) => {
    await prisma.connection.update({ where: { provider: "aryeo" }, data: { status: "CONNECTED", lastSyncedAt: new Date(now.getTime() - HOUR), lastError: null } });
    await prisma.connection.update({ where: { provider: "calendly" }, data: { status: "CONNECTED", lastSyncedAt: new Date(now.getTime() - HOUR), lastError: null } });
    await prisma.programCalendlyEventMapping.updateMany({ data: { lastSyncedAt: new Date(now.getTime() - HOUR), lastError: null } });
  };

  /** One content session: a project on its own Aryeo order, one appointment, a general area. */
  type Sess = { projectId: string; apptId: string; aryeoApptId: string; orderId: string; addressId: string; key: string };
  const addSession = async (f: ContentMonthFixture, start: Date, opts: { siblings?: Date[]; listingId?: string | null; assign?: boolean } = {}): Promise<Sess> => {
    const k = ++seq;
    const orderId = `0198dddd-0000-4000-8000-${String(k).padStart(12, "0")}`;
    const addressId = `0198eeee-0000-4000-8000-${String(k).padStart(12, "0")}`;
    const aryeoApptId = `0198ffff-0000-4000-8000-${String(k).padStart(12, "0")}`;
    const project = await prisma.project.create({
      data: { clientId: f.clientId, title: "October 2026 Social Content, West Chester, PA 19382", status: "SCHEDULED", contentMonthId: f.monthId, packageName: "Video Accelerator", shootDate: start, aryeoOrderId: orderId, aryeoListingId: opts.listingId ?? null, city: "West Chester", state: "PA", zip: "19382", addressLine: null },
      select: { id: true },
    });
    await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", quantity: 4 } });
    const appt = await prisma.appointment.create({ data: { projectId: project.id, aryeoId: aryeoApptId, startAt: start, endAt: new Date(start.getTime() + 4 * HOUR), durationMin: 240, status: "SCHEDULED", assignedToId: opts.assign === false ? null : james.id }, select: { id: true } });
    const siblings = (opts.siblings ?? []).map((s, i) => ({ id: `${aryeoApptId.slice(0, -2)}${String(90 + i)}`, start_at: s.toISOString().replace(".000Z", "Z"), end_at: new Date(s.getTime() + 4 * HOUR).toISOString().replace(".000Z", "Z"), tmIds: [DRILL_TEAM.james.tm] }));
    for (const s of siblings) await prisma.appointment.create({ data: { projectId: project.id, aryeoId: s.id, startAt: new Date(s.start_at), endAt: new Date(s.end_at), status: "SCHEDULED" } });
    const customerId = (await prisma.client.findUniqueOrThrow({ where: { id: f.clientId }, select: { aryeoCustomerId: true } })).aryeoCustomerId!;
    fake.seedOrder({
      id: orderId, number: 7000 + k, customerId, listingId: opts.listingId ?? null,
      address: { id: addressId, street_number: null, street_name: null, unit_number: null, city: "West Chester", state_or_province: "PA", postal_code: "19382", country: "US", latitude: 39.96, longitude: -75.6, unparsed_address: "October 2026 Social Content, West Chester, PA 19382" },
      appointments: [{ id: aryeoApptId, start_at: start.toISOString().replace(".000Z", "Z"), end_at: new Date(start.getTime() + 4 * HOUR).toISOString().replace(".000Z", "Z"), tmIds: [DRILL_TEAM.james.tm] }, ...siblings],
    });
    return { projectId: project.id, apptId: appt.id, aryeoApptId, orderId, addressId, key: `appt:${aryeoApptId}` };
  };
  const client = async (name: string, email: string): Promise<ContentMonthFixture> => {
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name, package: "Accelerator", monthKey: "2026-10", project: false, owner: { email } });
    await prisma.client.update({ where: { id: f.clientId }, data: { aryeoCustomerId: `0197cccc-0000-4000-8000-${String(++seq).padStart(12, "0")}` } });
    return f;
  };
  const EXACT = { street: "117 Kyle Lane", unit: "2", city: "West Chester", state: "PA", zip: "19382" };
  const rowOf = (key: string) => prisma.programSessionAddress.findUnique({ where: { sessionKey: key } });
  const tasksFor = (key: string) => prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: `program-session-address:${key}:` } } });

  // The one client who is emailed: Jordan's verified test inbox.
  const main = await client("Address Drill TEST", "info@realtourpilot.com");
  const A1 = await addSession(main, et("2026-10-05", 10));
  await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: "https://api.calendly.com/event_types/drill", eventName: "Monthly strategy", purpose: "MONTHLY_STRATEGY", enabled: true, validationStatus: "VALID", publicUrl: "https://calendly.com/drill/strategy" } });
  await setSwitch("reminders", true);
  const run = async (now: Date, dryRun = false) => { await freshFeeds(now); return rem.evaluateReminders({ dryRun, now, enrollmentIds: [main.enrollmentId], requestedBy: "drill" }); };
  const addrRows = () => prisma.programReminder.findMany({ where: { action: "CONFIRM_ADDRESS", enrollmentId: main.enrollmentId } });

  // ======================================================================
  c.head("0 · OLD: the address lane was preview-only");
  {
    const old = (await import(base.path)) as typeof rem;
    const fri = et("2026-10-02", 9, 5);
    await freshFeeds(fri);
    await prisma.programCalendlyEventMapping.updateMany({ data: { enabled: false } }); // the old run must not send its planning email either
    const e0 = emails.length;
    const r = await old.evaluateReminders({ dryRun: false, now: fri, enrollmentIds: [main.enrollmentId], requestedBy: "drill-old" });
    c.ok("OLD: a real Friday run wrote no address reminder", (await addrRows()).length === 0 && r.addressLane.length === 0, `${(await addrRows()).length} rows`);
    c.ok("OLD: and sent nothing", emails.length === e0, `${emails.length - e0}`);
    const d = await old.evaluateReminders({ dryRun: true, now: fri, enrollmentIds: [main.enrollmentId] });
    c.ok("OLD: only the dry run listed it — \"its client template is not built\"", d.addressLane.length === 1 && /template is not built/.test(d.addressLane[0].reason), d.addressLane[0]?.reason);
    await prisma.programCalendlyEventMapping.updateMany({ data: { enabled: true } });
  }

  // ======================================================================
  c.head("1 · Thursday: the Monday session's reminder waits for Friday");
  {
    const r = await run(et("2026-10-01", 12), true);
    const a = r.addressLane.find((x) => x.sessionKey === A1.key);
    c.ok("one address row for the session, decision wait", !!a && a.decision === "wait", a ? `${a.decision}: ${a.reason}` : "none");
    c.ok("due Friday 2026-10-02 09:00 ET (48 h before is Saturday → back to Friday)", a?.nextEligibleAt?.toISOString() === et("2026-10-02", 9).toISOString() && a.movedOffWeekend, a?.nextEligibleAt?.toISOString());
  }

  // ======================================================================
  c.head("2 · Friday 09:05: one email, the session's own link, the day's one email");
  let token = "";
  {
    const fri = et("2026-10-02", 9, 5);
    const dry = await run(fri, true);
    const primDry = dry.candidates.find((x) => x.lane === "PRIMARY");
    const e0 = emails.length;
    const r = await run(fri);
    const rows = await addrRows();
    c.ok("exactly one CONFIRM_ADDRESS row, SENT", rows.length === 1 && rows[0].state === "SENT", JSON.stringify(rows.map((x) => [x.state, x.lastError, x.suppressionReason])) + JSON.stringify(r.sent));
    c.ok("keyed on the session", rows[0]?.dedupeKey === `${main.enrollmentId}:2026-10:CONFIRM_ADDRESS:${A1.key}:1`, rows[0]?.dedupeKey ?? "");
    const mail = emails.slice(e0).find((m) => /filming/.test(m.subject));
    c.ok("one email went out", emails.length - e0 === 1 && !!mail, `${emails.length - e0}`);
    c.ok("subject: \"Where are we filming your October session?\"", mail?.subject === "Where are we filming your October session?", mail?.subject);
    c.ok("the body carries the session's own address link", /\/portal\/address\/[A-Za-z0-9_-]{40,}/.test(mail?.body ?? ""), (mail?.body ?? "").slice(0, 120));
    c.ok("and Kyle's number", !!mail?.body.includes("(215) 645-4889"));
    c.ok("and no em dash anywhere", !!mail && !mail.body.includes("—") && !mail.subject.includes("—"));
    c.ok("it names the session and the area on file", !!mail?.body.includes("Monday, October 5") && !!mail?.body.includes("West Chester"), (mail?.body ?? "").split("\n")[2]);
    const prim = r.candidates.find((x) => x.lane === "PRIMARY");
    c.ok(`the planning reminder due the same morning (${primDry?.decision}) waits: another_reminder_today`, primDry?.decision === "send" && prim?.decision === "wait" && prim.suppressionReason === "another_reminder_today", `${prim?.decision} ${prim?.suppressionReason}`);
    token = /\/portal\/address\/([A-Za-z0-9_-]+)/.exec(mail?.body ?? "")?.[1] ?? "";
    const row = await rowOf(A1.key);
    c.ok("only the token's HASH is stored", !!row?.linkTokenHash && row.linkTokenHash !== token && !JSON.stringify(rows).includes(token), row?.linkTokenHash?.slice(0, 12));
  }

  // ======================================================================
  c.head("3 · re-runs Friday, Saturday, Monday: no second email");
  {
    const e0 = emails.length;
    for (const at of [et("2026-10-02", 9, 40), et("2026-10-03", 10), et("2026-10-05", 8)]) await run(at);
    c.ok("still exactly one CONFIRM_ADDRESS row", (await addrRows()).length === 1);
    c.ok("and no further address email", emails.slice(e0).filter((m) => /filming/.test(m.subject)).length === 0, `${emails.length - e0} emails total`);
  }

  // ======================================================================
  c.head("4 · the link: an area is refused, an address is SAVED, a repeat is a no-op");
  {
    const area = await sa.submitSessionAddress({ kind: "TOKEN", token }, { ...EXACT, street: "West Chester, PA" });
    c.ok("\"West Chester, PA\" as the street is refused", !area.ok && /house or building number/.test(area.message), area.message);
    const ok = await sa.submitSessionAddress({ kind: "TOKEN", token }, EXACT);
    const row = await rowOf(A1.key);
    c.ok("117 Kyle Lane, unit 2 is saved: PENDING", ok.ok && row?.syncState === "PENDING" && row.streetNumber === "117" && row.streetName === "Kyle Lane" && row.unitNumber === "2", `${row?.syncState} ${row?.streetNumber} ${row?.streetName}`);
    c.ok("the client reads \"Saved. We are updating your booking.\" — never confirmed", ok.message === "Saved. We are updating your booking.", ok.message);
    const v = row?.version;
    const again = await sa.submitSessionAddress({ kind: "TOKEN", token }, { ...EXACT, street: "117 kyle ln" });
    const row2 = await rowOf(A1.key);
    c.ok("the same address again: no new version", again.ok && again.duplicate === true && row2?.version === v, `v${v} → v${row2?.version}`);
    const act = await prisma.activity.count({ where: { projectId: A1.projectId, body: { contains: "Exact filming address" } } });
    c.ok("one activity line on the job, old → new", act === 1, `${act}`);
    // The emailed form's action: the same save, answered on the same page.
    const { submitSessionAddressByToken } = await import("@/app/portal/address/actions");
    const fd = new FormData();
    for (const [k, val] of Object.entries({ token, ...EXACT })) fd.set(k, val);
    const thrown = await submitSessionAddressByToken(fd).then(() => "no redirect", (e: Error) => e.message);
    c.ok("the form action saves and redirects back to its own page", /redirect/.test(thrown), thrown);
  }

  // ======================================================================
  c.head("5 · address_sync OFF: Kyle's task; his hand edit is what confirms it");
  {
    const p0 = fake.count("PATCH", "/addresses/");
    const r = await sa.syncSessionAddresses({});
    const row = await rowOf(A1.key);
    c.ok("zero PATCH", fake.count("PATCH", "/addresses/") === p0 && r.patched === 0, JSON.stringify(r));
    c.ok("syncState DESK", row?.syncState === "DESK", row?.syncState);
    const t = await tasksFor(A1.key);
    c.ok("one Kyle task naming the address", t.length === 1 && /117 Kyle Lane/.test(t[0].description ?? ""), `${t.length}: ${t[0]?.title}`);
    c.ok("the client still reads \"Saved. Updating your booking.\"", sa.addressClientNote(row!.syncState) === "Saved. Updating your booking.");
    await sa.syncSessionAddresses({});
    c.ok("a second run adds no second task", (await tasksFor(A1.key)).length === 1);
    // Kyle types it into Aryeo; the order sync brings it home.
    const a = fake.addresses.get(A1.addressId)!;
    Object.assign(a, { street_number: "117", street_name: "Kyle Lane", unit_number: "2" });
    const { syncAryeoOrders } = await import("@/lib/integrations/aryeo");
    const s = await syncAryeoOrders({ orderId: A1.orderId }).catch((e: Error) => ({ error: e.message }));
    const proj = await prisma.project.findUnique({ where: { id: A1.projectId }, select: { addressLine: true, zip: true } });
    c.ok("the order sync copied the street onto the job", proj?.addressLine === "117 Kyle Lane", `${proj?.addressLine} ${JSON.stringify(s).slice(0, 80)}`);
    await sa.syncSessionAddresses({});
    const done = await rowOf(A1.key);
    c.ok("the local readback marks it SYNCED", done?.syncState === "SYNCED" && /order-sync/.test(done.readbackJson ?? ""), done?.syncState);
    c.ok("and Kyle's task closes", (await tasksFor(A1.key)).every((x) => x.status === "COMPLETED"));
    c.ok("the client now reads \"Confirmed on your booking.\"", sa.addressClientNote(done!.syncState) === "Confirmed on your booking.");
  }

  // ======================================================================
  // Review fix (Sep 24 2026). A correction used to leave the first version's
  // task open beside the new one: two tasks, two addresses, one session.
  // (sessionAddress.ts is new in this batch, so there is no older build to run.)
  c.head("5b · a corrected address cancels the old address's task; Kyle has one task, the new address");
  {
    const cf = await client("Address Correct TEST", "correct-drill@realtourpilot.com");
    const C1 = await addSession(cf, et("2026-10-07", 10));
    const s1 = (await sa.upcomingProgramSessions(cf.monthId, new Date())).find((x) => x.key === C1.key)!;
    const { rawToken } = await sa.ensureSessionAddressRow(s1);
    await sa.submitSessionAddress({ kind: "TOKEN", token: rawToken }, EXACT);
    await sa.syncSessionAddresses({});
    const t1 = await tasksFor(C1.key);
    c.ok("(v1: one open task naming 117 Kyle Lane)", t1.length === 1 && t1[0].status === "OPEN" && /117 Kyle Lane/.test(t1[0].description ?? ""), `${t1.length} ${t1[0]?.status}`);
    const v2 = await sa.submitSessionAddress({ kind: "TOKEN", token: rawToken }, { ...EXACT, street: "42 Oak Street", unit: "" });
    const mid = await tasksFor(C1.key);
    c.ok("the correction cancels the v1 task at once", v2.ok && mid.find((x) => (x.dedupeKey ?? "").endsWith(":v1"))?.status === "CANCELLED", mid.map((x) => `${x.dedupeKey?.slice(-3)}=${x.status}`).join(" "));
    await sa.syncSessionAddresses({});
    const open = (await tasksFor(C1.key)).filter((x) => x.status === "OPEN");
    c.ok("after the next tick Kyle has ONE open task, and it names 42 Oak Street", open.length === 1 && /42 Oak Street/.test(open[0].description ?? "") && !/117 Kyle Lane/.test(open[0].description ?? ""), open.map((x) => x.dedupeKey).join(", "));
  }

  // ======================================================================
  c.head("6 · address_sync ON for an authorised fixture: PATCH, read back, done");
  const syncer = await client("Address Sync TEST", "sync-drill@realtourpilot.com");
  const other = await client("Address Other TEST", "other-drill@realtourpilot.com");
  const S1 = await addSession(syncer, et("2026-10-06", 10));
  const O1 = await addSession(other, et("2026-10-06", 13), { assign: false });
  {
    await setSwitch("address_sync", true, { authorizedFixtureClientIds: [syncer.clientId] });
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: syncer.enrollmentId, sessionKey: S1.key, by: "kyle@drill" }, EXACT);
    const p0 = fake.writes.filter((w) => w.method === "PATCH").length;
    await sa.syncSessionAddresses({});
    const patches = fake.writes.filter((w) => w.method === "PATCH").slice(p0);
    const body = patches[0]?.body as Record<string, unknown> | undefined;
    c.ok("exactly one PATCH, to this session's address", patches.length === 1 && patches[0].path === `/addresses/${S1.addressId}`, patches.map((p) => p.path).join(","));
    c.ok("with number, street, unit, city, state, ZIP and lat/lng", body?.street_number === "117" && body?.street_name === "Kyle Lane" && body?.unit_number === "2" && body?.city === "West Chester" && body?.state_or_province === "PA" && body?.postal_code === "19382" && typeof body?.latitude === "number", JSON.stringify(body));
    const row = await rowOf(S1.key);
    c.ok("read back equal → SYNCED", row?.syncState === "SYNCED" && /"source":"aryeo"/.test(row.readbackJson ?? ""), row?.syncState);
    const proj = await prisma.project.findUnique({ where: { id: S1.projectId }, select: { addressLine: true } });
    c.ok("and the job shows the street after the order sync", proj?.addressLine === "117 Kyle Lane", proj?.addressLine ?? "(null)");
    // Jordan, Sep 24 2026: Aryeo is the authority on travel once it has the address.
    c.ok("once synced, Aryeo is asked whether the creative is still clear", fake.reads.some((r) => r.startsWith(`/appointments/${S1.aryeoApptId}/availability`) && r.includes(`assignee_id=${DRILL_TEAM.james.tm}`)), fake.reads.filter((r) => r.includes("availability")).join(" | ") || "no availability read");
    // In Aryeo, James also holds the other client's 13:00 session (O1), which
    // overlaps this 10:00–14:00 one — so Aryeo's answer is a clash, and it is
    // Aryeo's answer that reaches Kyle.
    c.ok("  …Aryeo reports James's overlapping 13:00 job, so Kyle gets the clash task", (await tasksFor(S1.key)).some((t) => /aryeo-conflict/.test(t.dedupeKey ?? "") && /Aryeo reports a clash/.test(t.title)));
    await sa.syncSessionAddresses({});
    c.ok("a second run: no further PATCH", fake.writes.filter((w) => w.method === "PATCH").length - p0 === 1);
    // Another client, not authorised, with an address of their own.
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: other.enrollmentId, sessionKey: O1.key, by: "kyle@drill" }, { ...EXACT, street: "9 Elm Street" });
    await sa.syncSessionAddresses({});
    c.ok("an unauthorised client's address is never PATCHed", fake.count("PATCH", `/addresses/${O1.addressId}`) === 0 && (await rowOf(O1.key))?.syncState === "DESK", (await rowOf(O1.key))?.syncState);
  }

  // ======================================================================
  c.head("7 · the address arrives first: no email, and a queued email is pulled back");
  {
    const g = await client("Address Early TEST", "early-drill@realtourpilot.com");
    const G1 = await addSession(g, et("2026-10-12", 10));
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: g.enrollmentId, sessionKey: G1.key, by: "kyle@drill" }, EXACT);
    await freshFeeds(et("2026-10-09", 9, 5));
    const r = await rem.evaluateReminders({ dryRun: true, now: et("2026-10-09", 9, 5), enrollmentIds: [g.enrollmentId] });
    c.ok("the Friday before: no address reminder for it at all", !r.addressLane.some((a) => a.sessionKey === G1.key), JSON.stringify(r.addressLane.map((a) => a.sessionKey)));
    // A reminder already in the outbox when the address lands.
    const h = await client("Address Queued TEST", "queued-drill@realtourpilot.com");
    const H1 = await addSession(h, et("2026-10-13", 10));
    const ob = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "queued-drill@realtourpilot.com", clientId: h.clientId, body: "held", state: "pending", dedupeKey: `program_reminder:CONFIRM_ADDRESS:held:2026-10` } });
    const rr = await prisma.programReminder.create({ data: { enrollmentId: h.enrollmentId, clientId: h.clientId, monthId: h.monthId, monthKey: "2026-10", action: "CONFIRM_ADDRESS", templateKey: "reminder.confirm_address.v1", channel: "email", state: "QUEUED", outboxMessageId: ob.id, dedupeKey: rem.addressReminderKey(h.enrollmentId, "2026-10", H1.key) } });
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: h.enrollmentId, sessionKey: H1.key, by: "kyle@drill" }, EXACT);
    await rem.reconcileReminderOutcomes({});
    const after = await prisma.programReminder.findUnique({ where: { id: rr.id } });
    c.ok("the queued email is CANCELLED: address_received", after?.state === "CANCELLED" && after.suppressionReason === "address_received", `${after?.state} ${after?.suppressionReason}`);
  }

  // ======================================================================
  c.head("8 · PATCH outcomes: timeout after commit, timeout before, a refusal");
  {
    const t = await client("Address Timeout TEST", "timeout-drill@realtourpilot.com");
    await setSwitch("address_sync", true, { authorizedFixtureClientIds: [syncer.clientId, t.clientId] });
    const T1 = await addSession(t, et("2026-10-14", 10));
    const T2 = await addSession(t, et("2026-10-15", 10));
    const T3 = await addSession(t, et("2026-10-16", 10));
    const now0 = new Date();
    // (a) Aryeo commits the PATCH, the answer never arrives.
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: t.enrollmentId, sessionKey: T1.key, by: "kyle@drill" }, EXACT);
    fake.script("PATCH /addresses/:id", "abort-after-commit");
    await sa.syncSessionAddresses({ now: now0 });
    c.ok("(a) UNKNOWN after the timeout", (await rowOf(T1.key))?.syncState === "UNKNOWN", (await rowOf(T1.key))?.syncState);
    await sa.syncSessionAddresses({ now: new Date(now0.getTime() + 11 * 60_000) });
    c.ok("(a) the next tick's readback settles it: SYNCED", (await rowOf(T1.key))?.syncState === "SYNCED", (await rowOf(T1.key))?.syncState);
    c.ok("(a) with ONE PATCH in total", fake.count("PATCH", `/addresses/${T1.addressId}`) === 1, `${fake.count("PATCH", `/addresses/${T1.addressId}`)}`);
    // (b) the PATCH never landed.
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: t.enrollmentId, sessionKey: T2.key, by: "kyle@drill" }, EXACT);
    fake.script("PATCH /addresses/:id", "abort-before-commit");
    await sa.syncSessionAddresses({ now: now0 });
    await sa.syncSessionAddresses({ now: new Date(now0.getTime() + 11 * 60_000) });
    c.ok("(b) the readback showed the old address → exactly one re-PATCH → SYNCED", (await rowOf(T2.key))?.syncState === "SYNCED" && fake.count("PATCH", `/addresses/${T2.addressId}`) === 2 && fake.count("PATCH", `/addresses/${T2.addressId}`, true) === 1, `${(await rowOf(T2.key))?.syncState} ${fake.count("PATCH", `/addresses/${T2.addressId}`)}`);
    // (c) Aryeo refuses.
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: t.enrollmentId, sessionKey: T3.key, by: "kyle@drill" }, EXACT);
    fake.script("PATCH /addresses/:id", { status: 422, message: "The postal code is invalid." });
    await sa.syncSessionAddresses({ now: now0 });
    const r3 = await rowOf(T3.key);
    c.ok("(c) a 422 is FAILED", r3?.syncState === "FAILED", r3?.syncState);
    c.ok("(c) with a Kyle task", (await tasksFor(T3.key)).some((x) => x.status === "OPEN" && /did not update/.test(x.title)), (await tasksFor(T3.key)).map((x) => x.title).join(" | "));
    c.ok("(c) and the client is told Kyle is updating it by hand", sa.addressClientNote(r3!.syncState) === "Saved. Kyle is updating your booking by hand.");
  }

  // ======================================================================
  c.head("9 · a shared Aryeo address is never changed by the hub");
  {
    const p = await client("Address Shared TEST", "shared-drill@realtourpilot.com");
    await setSwitch("address_sync", true, { authorizedFixtureClientIds: [syncer.clientId, p.clientId] });
    const P1 = await addSession(p, et("2026-10-19", 10), { siblings: [et("2026-10-20", 10)] });
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: p.enrollmentId, sessionKey: P1.key, by: "kyle@drill" }, EXACT);
    await sa.syncSessionAddresses({});
    c.ok("two sessions on one order → CONFLICT", (await rowOf(P1.key))?.syncState === "CONFLICT", (await rowOf(P1.key))?.lastError ?? "");
    c.ok("zero PATCH", fake.count("PATCH", `/addresses/${P1.addressId}`) === 0);
    c.ok("and a Kyle task", (await tasksFor(P1.key)).length === 1);
    const L1 = await addSession(p, et("2026-10-21", 10), { listingId: "listing-shared-1" });
    await prisma.project.create({ data: { clientId: p.clientId, title: "Another job on the same listing", status: "DELIVERED", aryeoListingId: "listing-shared-1" } });
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: p.enrollmentId, sessionKey: L1.key, by: "kyle@drill" }, EXACT);
    await sa.syncSessionAddresses({});
    c.ok("two jobs on one listing → CONFLICT, zero PATCH", (await rowOf(L1.key))?.syncState === "CONFLICT" && fake.count("PATCH", `/addresses/${L1.addressId}`) === 0, (await rowOf(L1.key))?.lastError ?? "");
  }

  // ======================================================================
  c.head("10 · the link is bound to its session");
  {
    const k = await client("Address Scope TEST", "scope-drill@realtourpilot.com");
    const K1 = await addSession(k, et("2026-10-22", 10));
    const K2 = await addSession(k, et("2026-10-23", 10));
    const sessions = await sa.upcomingProgramSessions(k.monthId, new Date());
    const s1 = sessions.find((s) => s.key === K1.key)!;
    const { rawToken } = await sa.ensureSessionAddressRow(s1);
    await sa.submitSessionAddress({ kind: "TOKEN", token: rawToken }, EXACT);
    c.ok("a token changes its own session only", !!(await rowOf(K1.key))?.submittedAt && !(await rowOf(K2.key))?.submittedAt);
    const late = await sa.submitSessionAddress({ kind: "TOKEN", token: rawToken }, { ...EXACT, street: "200 Late Road" }, { now: new Date(et("2026-10-22", 10).getTime() + 60_000) });
    c.ok("after the session starts the link is closed", !late.ok && /closed/.test(late.message), late.message);
    const s2 = sessions.find((s) => s.key === K2.key)!;
    const t2 = await sa.ensureSessionAddressRow(s2);
    await prisma.appointment.update({ where: { id: K2.apptId }, data: { status: "CANCELED" } });
    await prisma.project.update({ where: { id: K2.projectId }, data: { shootDate: null } });
    const gone = await sa.submitSessionAddress({ kind: "TOKEN", token: t2.rawToken }, EXACT);
    c.ok("a cancelled session's link refuses", !gone.ok && /no longer on the calendar/.test(gone.message), gone.message);
    await freshFeeds(et("2026-10-21", 9, 5));
    const r = await rem.evaluateReminders({ dryRun: true, now: et("2026-10-21", 9, 5), enrollmentIds: [k.enrollmentId] });
    c.ok("and the lane offers no reminder for it", !r.addressLane.some((a) => a.sessionKey === K2.key));
  }

  // ======================================================================
  c.head("11 · travel: same creative, same day, within 90 minutes");
  {
    const v = await client("Address Travel TEST", "travel-drill@realtourpilot.com");
    const V1 = await addSession(v, et("2026-10-26", 10));
    // James is filming someone else 15:00–16:00 — within 90 minutes of 14:00.
    const other2 = await prisma.project.create({ data: { clientId: v.clientId, title: "Listing shoot", status: "SCHEDULED" }, select: { id: true } });
    await prisma.appointment.create({ data: { projectId: other2.id, aryeoId: "travel-other-1", startAt: et("2026-10-26", 15), endAt: et("2026-10-26", 16), status: "SCHEDULED", assignedToId: james.id } });
    const before = await prisma.appointment.findUnique({ where: { id: V1.apptId }, select: { startAt: true } });
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: v.enrollmentId, sessionKey: V1.key, by: "kyle@drill" }, EXACT);
    const t = (await tasksFor(V1.key)).find((x) => /travel/.test(x.dedupeKey ?? ""));
    c.ok("Kyle is told the new location may affect travel", !!t && /may affect travel/.test(t.title), t?.title);
    const after = await prisma.appointment.findUnique({ where: { id: V1.apptId }, select: { startAt: true } });
    c.ok("and the session time did not move", before?.startAt?.getTime() === after?.startAt?.getTime());
  }

  // ======================================================================
  c.head("11b · travel, when the hub syncs the address: Aryeo decides, not our 90-minute rule");
  {
    // Jordan, Sep 24 2026: "Aryeo's scheduling API should show the live
    // availability and allow travel time between one address to another."
    const w = await client("Address Clash TEST", "clash-drill@realtourpilot.com");
    const W1 = await addSession(w, et("2026-10-27", 10));
    await setSwitch("address_sync", true, { authorizedFixtureClientIds: [w.clientId] });
    // In ARYEO (not in our DB), James has another job overlapping this session.
    fake.appts.set("0198ffff-0000-4000-8000-00000000c1a5", { id: "0198ffff-0000-4000-8000-00000000c1a5", status: "SCHEDULED", start_at: et("2026-10-27", 12).toISOString().replace(".000Z", "Z"), end_at: et("2026-10-27", 13).toISOString().replace(".000Z", "Z"), orderId: "elsewhere", tmIds: [DRILL_TEAM.james.tm], updated_at: new Date().toISOString() });
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: w.enrollmentId, sessionKey: W1.key, by: "kyle@drill" }, EXACT);
    c.ok("no home-made travel guess at submit — Aryeo will be asked", !(await tasksFor(W1.key)).some((t) => /:travel:/.test(t.dedupeKey ?? "")));
    await sa.syncSessionAddresses({});
    c.ok("the address synced", (await rowOf(W1.key))?.syncState === "SYNCED", (await rowOf(W1.key))?.syncState);
    const clash = (await tasksFor(W1.key)).find((t) => /aryeo-conflict/.test(t.dedupeKey ?? ""));
    c.ok("Aryeo reports the clash, so Kyle gets the task", !!clash && /Aryeo reports a clash/.test(clash.title), clash?.title ?? "none");
    const appt = await prisma.appointment.findUnique({ where: { id: W1.apptId }, select: { startAt: true } });
    c.ok("  …and nothing was moved", appt?.startAt?.getTime() === et("2026-10-27", 10).getTime());
    // The other job is cancelled in Aryeo and the client corrects the unit:
    // Aryeo now says clear, and no new clash task is raised for the new version.
    fake.appts.get("0198ffff-0000-4000-8000-00000000c1a5")!.status = "CANCELED";
    await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: w.enrollmentId, sessionKey: W1.key, by: "kyle@drill" }, { ...EXACT, unit: "3" });
    await sa.syncSessionAddresses({});
    const v = (await rowOf(W1.key))?.version;
    c.ok("with the clash gone, Aryeo says clear: no clash task for the new address", (await rowOf(W1.key))?.syncState === "SYNCED" && !(await tasksFor(W1.key)).some((t) => (t.dedupeKey ?? "").endsWith(`aryeo-conflict:v${v}`) && t.status !== "CANCELLED" && t.status !== "COMPLETED"), `v${v}`);
    await setSwitch("address_sync", false);
  }

  // ======================================================================
  c.head("12 · the clock: Tuesday → Friday, Wednesday → Monday, a Saturday booking for Monday");
  {
    const p = rem.REMINDER_DEFAULTS;
    c.ok("Tuesday 10:00 → the Friday before at 09:00", rem.addressReminderAt(et("2026-10-13", 10), p).toISOString() === et("2026-10-09", 9).toISOString());
    c.ok("Wednesday 10:00 → Monday 10:00", rem.addressReminderAt(et("2026-10-14", 10), p).toISOString() === et("2026-10-12", 10).toISOString());
    // Booked on Saturday Oct 17 for Monday Oct 19 10:00 — the Friday is gone.
    const A3 = await addSession(main, et("2026-10-19", 10));
    const sat = await run(et("2026-10-17", 11));
    const a = sat.addressLane.find((x) => x.sessionKey === A3.key);
    c.ok("Saturday: waits for Monday's opening (quiet hours)", a?.decision === "wait" && a.nextEligibleAt?.toISOString() === et("2026-10-19", 9).toISOString(), `${a?.decision} ${a?.nextEligibleAt?.toISOString()}`);
    const urgent = () => prisma.smartTask.count({ where: { dedupeKey: `program-address-urgent:${A3.key}` } });
    c.ok("and Kyle gets ONE urgent task now", (await urgent()) === 1);
    await run(et("2026-10-17", 15));
    const e0 = emails.length;
    const mon = await run(et("2026-10-19", 9, 2));
    const m = mon.addressLane.find((x) => x.sessionKey === A3.key);
    c.ok("Monday 09:02: sent at the window's opening", m?.decision === "send" && emails.slice(e0).some((x) => /filming/.test(x.subject)), `${m?.decision} ${m?.reason}`);
    c.ok("the urgent task was raised exactly once", (await urgent()) === 1);
  }

  // ======================================================================
  c.head("13 · nothing left the machine");
  {
    const other3 = fence.faked.filter((u) => !u.startsWith("https://api.aryeo.com/") && !u.startsWith("https://geocoding.geo.census.gov/") && !u.startsWith("https://nominatim.openstreetmap.org/") && !u.startsWith("https://oauth2.googleapis.com/") && !u.startsWith("https://gmail.googleapis.com/"));
    c.ok("only the fake Aryeo, the stub geocoder and the stub Gmail were answered", other3.length === 0, other3.join(", "));
    c.ok("nothing was blocked", fence.blocked.length === 0, fence.blocked.slice(0, 5).join(", "));
    c.ok("every email went to Jordan's verified test inbox", emails.every((e) => e.to === "info@realtourpilot.com"), emails.map((e) => e.to).join(","));
    const sent = await prisma.programReminder.count({ where: { action: "CONFIRM_ADDRESS", state: "SENT" } });
    c.ok("address emails = address ledger rows SENT (2)", emails.filter((e) => /filming/.test(e.subject)).length === sent && sent === 2, `${sent}`);
    console.log(`    emails: ${emails.length} (${emails.map((e) => e.subject).join(" | ")}); committed PATCHes: ${fake.writes.filter((w) => w.method === "PATCH" && w.committed).length}`);
  }

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
