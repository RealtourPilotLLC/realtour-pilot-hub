// ---------------------------------------------------------------------------
// DRILL: unified handoff batch 3 — IN-PORTAL CALENDLY BOOKING (W03), Sep 25 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b3-calendly.ts
//
// OLD behaviour first: the tree at 810b29f (pinned, never HEAD) — its sweep is
// loaded for real and run on the same bookings.
//
//    0. OLD: the portal linked a hard-coded Calendly URL; the Calendly client
//       could not write; a portal booking made from another address sat
//       UNMATCHED, and a late-month call for October was filed on November.
//    1. The token: format, verification, tampering, another account's month,
//       an ended program, a stale page.
//    2. The mode: NONE / EMBED / API, the switch, R02's fixture and pilot
//       scopes, the probe (ok and 403), never the discovery type.
//    3. EMBED: the widget's "scheduled" is re-read from Calendly; the booking
//       is MATCHED by token (not by email), locked to the portal month although
//       the call is on the 30th, and the filming gate opens at the call's END +
//       72 weekday hours in the same request — Fri 2:30 pm EDT → Wed 2:30 pm
//       EST, across the weekend AND the DST change.
//    4. EMBED refusals with no record: a discovery event, the generic 30-minute
//       type, another account's token, a forged token; A04 by name alone.
//    5. The hourly sweep after a portal ingest: no duplicate, still MATCHED and
//       locked; a booking the sweep sees first is filed the same way; staff
//       retargeting still wins.
//    6. Change and cancel through Calendly's own pages: the replacement
//       inherits by old_invitee, the old one is RESCHEDULED at once, the gate
//       moves with the call; a cancel releases the month.
//    7. API mode: 7-day pages, each slot's filming start (Mon 2:30 → Thu 2:30,
//       Fri 2:00 → Wed 2:00); one POST per booking; a double click, a second
//       slot and two concurrent tabs cannot POST twice; a timeout after commit
//       is adopted by READ, a timeout that never committed fails only after
//       the grace; a taken slot; a 403 falls back to the embed; the guard.
//    8. The ops scripts against the fake: the probe (dry run, --apply) and the
//       supervised test (dry run, switch off, a non-TEST name, --apply, and a
//       timeout that committed) — one invitee booked, read back, cancelled.
//   7b. (batch-3 review) Late in the month: on Oct 29 a client planning October
//       books Mon Nov 2 — October's token is judged by when it was BOOKED, so
//       the call is October's (API and EMBED), its gate opens, the view shows
//       it; a page left open since September is still refused. The supervised
//       test's arm/disarm is the audited fixture script, never a whole-config
//       setAutomation, and it refuses while call_booking carries a pilot.
//    9. Wiring: Your Month's call step, the links per layout, the embed's
//       origin check, the portal actions' permission.
//
// ISOLATION: PGlite on 127.0.0.1:5665 (the harness). Production is never
// opened; Calendly is a fake answering api.calendly.com in-process; every other
// non-loopback call is fenced and counted (and must be zero).
// THE CLOCK IS PINNED (and moved): Wed Oct 28 2026 10:00 EDT to start — the
// week DST ends (Sun Nov 1, 2 AM), with a Friday-afternoon call.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PortalViewer } from "@/lib/portal";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { makeFakeCalendly, CAL } from "./_fake-calendly";

const PORT = Number(process.env.DRILL_PORT ?? 5665);
const BASE = "810b29f"; // pinned: the tree batch 3 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
let offset = RealDate.UTC(2026, 9, 28, 14, 0, 0) - RealDate.now(); // Wed Oct 28 2026, 10:00 EDT
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const setClock = (d: Date) => { offset = d.getTime() - RealDate.now(); };
const now = () => new RealDate(RealDate.now() + offset);
/** ET wall clocks: EDT (UTC-4) until Sun Nov 1 2026 2 AM, EST (UTC-5) after. */
const edt = (m: number, d: number, h: number, min = 0) => new RealDate(RealDate.UTC(2026, m - 1, d, h + 4, min));
const est = (m: number, d: number, h: number, min = 0) => new RealDate(RealDate.UTC(2026, m - 1, d, h + 5, min));
const START = edt(10, 28, 10);

installNextStubs();
const fake = makeFakeCalendly();
const fence = fenceFetch((url, init) => fake.handle(url, init));

// ---- the old code, runnable ------------------------------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-calendly-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
async function loadBase<T>(rel: string): Promise<T> {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, show(rel).replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return (await import(file)) as T;
}
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const cb = await import("@/lib/callBooking");
  const cal = await import("@/lib/integrations/calendly");
  const ccr = await import("@/lib/contentCallRecords");
  const { sessionGate } = await import("@/lib/portal");
  const { setAutomation } = await import("@/lib/programAutomation");
  const { saveSecret } = await import("@/lib/integrations/connections");
  setClock(START);

  await saveSecret("calendly", "drill-calendly-key-not-real");
  const MONTHLY = fake.addEventType({ id: "ET-MONTHLY", name: "Content Program - Strategy Call", slug: "content-program-strategy-call", duration: 30 });
  const DISC = fake.addEventType({ id: "ET-DISC", name: "Brand Discovery Call", slug: "brand-discovery-call", duration: 60 });
  const THIRTY = fake.addEventType({ id: "ET-30", name: "30 Minute Strategy Call", slug: "30min", duration: 30 });
  // Discovery is mapped FIRST, so "the first mapping" would be the wrong one.
  await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: DISC.uri, eventName: DISC.name, purpose: "BRAND_DISCOVERY", enabled: true, validationStatus: "VALID", publicUrl: DISC.scheduling_url, createdAt: edt(9, 18, 9) } });

  const A = await buildContentMonth(prisma, { name: "Jordan Spackman TEST", monthKey: "2026-10", project: false, owner: { email: "info+a@realtourpilot.com", name: "Jordan Spackman TEST" } });
  const B = await buildContentMonth(prisma, { name: "Other Client TEST", monthKey: "2026-10", project: false, owner: { email: "owner-b@example.com", name: "Bea Other" } });
  await prisma.client.update({ where: { id: A.clientId }, data: { email: "info@realtourpilot.com" } });
  await prisma.client.update({ where: { id: B.clientId }, data: { email: "owner-b@example.com" } });
  const viewerOf = (f: ContentMonthFixture, email: string, name: string, role: "OWNER" | "VIEWER" = "OWNER"): PortalViewer => ({
    enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
    actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email, name, membershipId: f.membershipId!, membershipRole: role },
    access: "FULL", via: "LOGIN",
  });
  const vA = viewerOf(A, "info+a@realtourpilot.com", "Jordan Spackman TEST");
  const vB = viewerOf(B, "owner-b@example.com", "Bea Other");
  const tokA = cb.portalCallToken(A.enrollmentId, A.monthId);
  const tokB = cb.portalCallToken(B.enrollmentId, B.monthId);
  const recOf = (uri: string) => prisma.programCallRecord.findUnique({ where: { calendlyEventUri: uri } });
  const clearFake = () => { fake.events.clear(); fake.invitees.clear(); };

  // =========================================================================
  c.head("0 · OLD behaviour at 810b29f");
  {
    const oldCal = show("src/lib/integrations/calendly.ts");
    c.ok("old Calendly client could not write (no POST anywhere; 'Read-only')", !/method:\s*"POST"/.test(oldCal) && /Read-only: the hub never books or\s*\n?\/\/ cancels/.test(oldCal));
    const oldPage = show("src/components/portal/PortalPage.tsx");
    c.ok("old portal linked the hard-coded constant (STRATEGY_CALL_BOOKING_URL ×4)", (oldPage.match(/STRATEGY_CALL_BOOKING_URL/g) ?? []).length >= 4);
    c.ok("old portal had no in-portal booking component", !/PortalCallPicker|CalendlyInline/.test(oldPage + show("src/components/portal/YourMonth.tsx")));
    await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: MONTHLY.uri, eventName: MONTHLY.name, purpose: "MONTHLY_STRATEGY", enabled: true, validationStatus: "VALID", publicUrl: MONTHLY.scheduling_url } });
    const oldCcr = await loadBase<typeof import("@/lib/contentCallRecords")>("src/lib/contentCallRecords.ts");
    // Booked from the portal for OCTOBER (the token says so) by the client's
    // assistant's address, on Friday the 30th.
    const x = fake.bookFromPage(MONTHLY.uri, edt(10, 30, 14).toISOString(), { name: "Jordan Spackman TEST", email: "assistant@elsewhere.example", tracking: { utm_source: "rtp-portal", utm_content: tokA } });
    // And one from the address on file, on the 29th.
    const y = fake.bookFromPage(MONTHLY.uri, edt(10, 29, 10).toISOString(), { name: "Jordan Spackman TEST", email: "info@realtourpilot.com", tracking: {} });
    await oldCcr.syncCallRecordsFromCalendly({ now: now() });
    const rx = await recOf(x.event.uri);
    const ry = await recOf(y.event.uri);
    c.ok("OLD: the portal-token booking from another address sat UNMATCHED, on no month", rx?.matchState === "UNMATCHED_INVITEE" && rx.monthId === null, `${rx?.matchState} month=${rx?.monthId}`);
    c.ok("OLD: an October planning call held on the 29th was filed on NOVEMBER by the day rule", ry?.matchState === "MATCHED" && ry.targetMonthKey === "2026-11", `${ry?.targetMonthKey}`);
    // Clean slate for the new code.
    await prisma.programCallRecord.deleteMany({});
    await prisma.contentMonth.updateMany({ where: { enrollmentId: A.enrollmentId }, data: { callRecordId: null } });
    await prisma.contentMonth.deleteMany({ where: { enrollmentId: A.enrollmentId, monthKey: "2026-11" } });
    await prisma.smartTask.deleteMany({ where: { dedupeKey: { startsWith: "content-call-review-" } } });
    clearFake();
  }

  // =========================================================================
  c.head("1 · The token");
  {
    c.ok("shape rtp1.<monthId>.<10-char HMAC>", new RegExp(`^rtp1\\.${A.monthId}\\.[A-Za-z0-9_-]{10}$`).test(tokA), tokA);
    const v = await cb.verifyPortalCallToken(tokA);
    c.ok("verifies to A's enrollment, client and October", v?.enrollmentId === A.enrollmentId && v.clientId === A.clientId && v.monthKey === "2026-10");
    const sig = tokA.split(".")[2];
    const flipped = `${tokA.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    c.ok("a tampered signature is refused", (await cb.verifyPortalCallToken(flipped)) === null);
    c.ok("A's signature on B's month is refused (a token cannot be re-pointed)", (await cb.verifyPortalCallToken(`rtp1.${B.monthId}.${sig}`)) === null);
    c.ok("garbage is refused", (await cb.verifyPortalCallToken("rtp1.nope")) === null && (await cb.verifyPortalCallToken(null)) === null);
    c.ok("a stale page: October's token BOOKED in November is refused", (await cb.verifyPortalCallToken(tokA, { bookedAt: est(11, 2, 9), callStart: est(11, 3, 11) })) === null);
    c.ok("…booked in October it is accepted, even for a call early in November (7b)", !!(await cb.verifyPortalCallToken(tokA, { bookedAt: edt(10, 29, 9), callStart: est(11, 3, 11) })));
    c.ok("…with no booking time on record, the call's month is the fallback (a November call refused)", (await cb.verifyPortalCallToken(tokA, { callStart: est(11, 3, 11) })) === null);
    c.ok("…and an October call accepted", !!(await cb.verifyPortalCallToken(tokA, { callStart: edt(10, 30, 14) })));
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { status: "ENDED" } });
    c.ok("an ENDED program's token is refused", (await cb.verifyPortalCallToken(tokB)) === null);
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { status: "ACTIVE" } });
  }

  // =========================================================================
  c.head("2 · The mode and the scope");
  const R = await (async () => {
    const client = await prisma.client.create({ data: { name: "Real Person Realty", email: "agent@realperson.example" }, select: { id: true } });
    const e = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4 }, select: { id: true } });
    return { clientId: client.id, enrollmentId: e.id };
  })();
  {
    await prisma.programCalendlyEventMapping.updateMany({ where: { purpose: "MONTHLY_STRATEGY" }, data: { enabled: false } });
    c.ok("no enabled monthly mapping → NONE (discovery is never used)", (await cb.callBookingMode(A.clientId)).mode === "NONE" && (await cb.monthlyStrategyMapping()) === null);
    await prisma.programCalendlyEventMapping.updateMany({ where: { purpose: "MONTHLY_STRATEGY" }, data: { enabled: true } });
    const m = await cb.monthlyStrategyMapping();
    c.ok("the mapping is the MONTHLY_STRATEGY one, not the older discovery row", m?.eventTypeUri === MONTHLY.uri);
    c.ok("switch OFF (no row) → EMBED for everyone", (await cb.callBookingMode(A.clientId)).mode === "EMBED" && (await cb.callBookingMode(R.clientId)).mode === "EMBED");
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [A.clientId] }));
    const noProbe = await cb.callBookingMode(A.clientId, { inviteeEmail: "info+a@realtourpilot.com" });
    c.ok("API config, fixture listed, but no probe → EMBED", noProbe.mode === "EMBED" && /probe has not been run/.test(noProbe.reason), noProbe.reason);
    fake.state.plan = "free";
    const p403 = await cb.runSchedulingProbe({ store: true, by: "drill" });
    c.ok("probe on a plan without the Scheduling API → 'plan' (403), stored", p403.status === "plan" && p403.httpStatus === 403 && (await cb.storedSchedulingProbe())?.status === "plan");
    c.ok("…→ EMBED", (await cb.callBookingMode(A.clientId, { inviteeEmail: "info+a@realtourpilot.com" })).mode === "EMBED");
    fake.state.plan = "paid";
    const pOk = await cb.runSchedulingProbe({ store: true, by: "drill" });
    c.ok("probe on a paid plan → ok (200), stored with the event type", pOk.status === "ok" && (await cb.storedSchedulingProbe())?.eventTypeUri === MONTHLY.uri);
    const apiA = await cb.callBookingMode(A.clientId, { inviteeEmail: "info+a@realtourpilot.com" });
    c.ok("TEST fixture, listed, test inbox, probe ok → API (FIXTURE)", apiA.mode === "API" && apiA.scope === "FIXTURE", apiA.reason);
    const wrongInbox = await cb.callBookingMode(A.clientId, { inviteeEmail: "someone@gmail.com" });
    c.ok("the same fixture booking as a non-test inbox → EMBED (renaming a row does not move its inbox)", wrongInbox.mode === "EMBED" && /verified test inbox/.test(wrongInbox.reason), wrongInbox.reason);
    c.ok("an unlisted TEST client → EMBED", (await cb.callBookingMode(B.clientId, { inviteeEmail: "info+b@realtourpilot.com" })).mode === "EMBED");
    const scope = (id: string, name: string, op: "invitees.create" | "scheduled_events.cancel" = "invitees.create") => cb.callBookingScope({ client: { id, name }, operation: op, inviteeEmail: "agent@realperson.example" });
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [A.clientId, R.clientId] }));
    const inFixtures = await scope(R.clientId, "Real Person Realty");
    c.ok("a REAL client in the fixture list is refused (misconfiguration)", !inFixtures.ok && /misconfiguration/.test(inFixtures.ok ? "" : inFixtures.reason));
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [A.clientId, B.clientId] }));
    const renamed = await cb.callBookingScope({ client: { id: B.clientId, name: B.clientName }, operation: "invitees.create", inviteeEmail: "info+b@realtourpilot.com" });
    c.ok("a listed TEST-named row whose OWN email is a real inbox is refused (a renamed real row)", !renamed.ok && /own email/.test(renamed.ok ? "" : renamed.reason), renamed.ok ? "" : renamed.reason);
    const lied = await cb.callBookingScope({ client: { id: R.clientId, name: "Real Person Realty TEST" }, operation: "invitees.create", inviteeEmail: "info@realtourpilot.com" });
    c.ok("the guard re-reads the row: a caller passing a TEST name for a real client gets nothing", !lied.ok);
    const pilot = (p: Record<string, unknown>) => setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [A.clientId], pilot: p }));
    await pilot({ clientIds: [R.clientId], operations: ["scheduled_events.cancel"], approvedBy: "jordan", approvedAt: "2026-10-01T12:00:00Z" });
    c.ok("pilot without the operation → refused", !(await scope(R.clientId, "Real Person Realty")).ok);
    await pilot({ clientIds: [R.clientId], operations: ["invitees.create"], approvedBy: null, approvedAt: null });
    c.ok("pilot without a recorded approval → refused", !(await scope(R.clientId, "Real Person Realty")).ok);
    await pilot({ clientIds: [R.clientId], operations: ["invitees.create"], approvedBy: "jordan", approvedAt: "2026-10-01T12:00:00Z", expiresAt: "2026-10-15T00:00:00Z" });
    c.ok("an expired pilot → refused", !(await scope(R.clientId, "Real Person Realty")).ok);
    await pilot({ clientIds: [R.clientId], operations: ["invitees.create"], approvedBy: "jordan", approvedAt: "2026-10-01T12:00:00Z", expiresAt: null });
    const ok = await scope(R.clientId, "Real Person Realty");
    c.ok("approved, unexpired pilot with the operation → PILOT", ok.ok && ok.scope === "PILOT");
    c.ok("an unrelated real client → refused", !(await scope("someone-else-id", "Another Realty")).ok);
    // Back to: switch OFF, empty lists — the shipped state.
    await setAutomation("call_booking", false, "drill", JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [] }));
    c.ok("switch OFF again → every write refused before a socket opens", !(await cb.callBookingScope({ client: { id: A.clientId, name: A.clientName }, operation: "invitees.create", inviteeEmail: "info@realtourpilot.com" })).ok && fake.state.posts === 0);
  }

  // =========================================================================
  c.head("3 · EMBED: the booking is re-read, matched by token, locked, and opens filming at once");
  let firstEvent = "";
  {
    const view = await cb.portalCallBookingView(vA, A.monthId);
    c.ok("A's view: EMBED, can book, nothing booked yet", view?.mode === "EMBED" && view.canBook && view.booked === null);
    const embed = new URL(view!.embedUrl!);
    c.ok("the embed is the MAPPED page, prefilled (name, email) and tokened", `${embed.origin}${embed.pathname}` === MONTHLY.scheduling_url && embed.searchParams.get("email") === "info+a@realtourpilot.com" && embed.searchParams.get("name") === "Jordan Spackman TEST" && embed.searchParams.get("utm_content") === tokA);
    c.ok("the new-tab fallback carries the token but no personal details", new URL(view!.linkUrl!).searchParams.get("utm_content") === tokA && !new URL(view!.linkUrl!).searchParams.has("email"));
    // The client books on Calendly's page — Friday Oct 30, 2:00–2:30 pm EDT —
    // from an address that is NOT on the client's record.
    const b = fake.bookFromPage(MONTHLY.uri, edt(10, 30, 14).toISOString(), { name: "Jordan Spackman TEST", email: "assistant@elsewhere.example", tracking: { utm_source: "rtp-portal", utm_content: tokA } });
    firstEvent = b.event.uri;
    const gateBefore = await sessionGate(A.enrollmentId, A.monthId, { now: now() });
    c.ok("before: filming is locked (no call booked)", gateBefore.locked, gateBefore.reason);
    const reads0 = fake.state.log.length;
    const r = await cb.confirmEmbeddedBooking(vA, { eventUri: b.event.uri });
    c.ok("confirm → CREATED", r.ok && r.state === "CREATED", r.message);
    c.ok("the server READ the event and its invitees from Calendly itself", fake.state.log.slice(reads0).some((l) => l.startsWith(`GET /scheduled_events/${b.event.uri.split("/").pop()}`)) && fake.state.log.slice(reads0).some((l) => /\/invitees/.test(l)));
    const rec = await recOf(b.event.uri);
    const raw = JSON.parse(rec?.rawJson ?? "{}");
    c.ok("MATCHED by the portal token — the invitee address is on no record", rec?.matchState === "MATCHED" && /portal booking token/.test(rec.matchNote ?? "") && rec.clientId === A.clientId, rec?.matchNote ?? "");
    c.ok("locked to OCTOBER (rule 'portal') although the call is on the 30th (≥ 24)", rec?.monthId === A.monthId && rec.targetMonthKey === "2026-10" && raw.target?.rule === "portal");
    c.ok("bookingSource PORTAL_EMBED, token kept", rec?.bookingSource === "PORTAL_EMBED" && rec.portalToken === tokA);
    const month = await prisma.contentMonth.findUnique({ where: { id: A.monthId }, select: { callRecordId: true } });
    c.ok("the month points at this call", month?.callRecordId === rec?.id);
    const gate = await sessionGate(A.enrollmentId, A.monthId, { now: now() });
    const wed = est(11, 4, 14, 30);
    c.ok("A19/A20: filming opens NOW, from the call's END + 72 weekday hours: Fri Oct 30 2:30 pm EDT → Wed Nov 4 2:30 pm EST", !gate.locked && gate.earliest.getTime() === wed.getTime(), `${gate.earliest.toISOString()} (want ${wed.toISOString()})`);
    c.ok("…and the client is told that same moment", r.filmingFromISO === wed.toISOString(), r.filmingFromISO ?? "null");
    c.ok("never from the click (Wed Oct 28 10:00 + 72 weekday h would be Mon Nov 2 10:00 EST)", gate.earliest.getTime() !== est(11, 2, 10).getTime());
    const ledger = await prisma.programCallBooking.findFirst({ where: { calendlyEventUri: b.event.uri } });
    c.ok("the ledger row: CREATED, this month, this token", ledger?.state === "CREATED" && ledger.monthId === A.monthId && ledger.token === tokA);
    const again = await cb.confirmEmbeddedBooking(vA, { eventUri: b.event.uri });
    c.ok("the widget firing twice changes nothing (one record, one ledger row)", again.ok && (await prisma.programCallRecord.count({ where: { calendlyEventUri: b.event.uri } })) === 1 && (await prisma.programCallBooking.count({ where: { monthId: A.monthId } })) === 1);
    const v2 = await cb.portalCallBookingView(vA, A.monthId);
    c.ok("the view now shows the booking with Calendly's own change/cancel pages", v2?.booked?.startISO === edt(10, 30, 14).toISOString() && /reschedulings/.test(v2.booked.rescheduleUrl ?? "") && /cancellations/.test(v2.booked.cancelUrl ?? "") && v2.booked.inPortal);
    const vView = await cb.portalCallBookingView({ ...vA, actor: { ...(vA.actor as Extract<PortalViewer["actor"], { kind: "CLIENT" }>), membershipRole: "VIEWER" } }, A.monthId);
    c.ok("a VIEWER seat sees the booking but not the change/cancel pages", !!vView?.booked && vView.booked.rescheduleUrl === null && vView.booked.cancelUrl === null && !vView.canBook);
  }

  // =========================================================================
  c.head("4 · EMBED refusals — no record, no month");
  {
    const before = await prisma.programCallRecord.count();
    const disc = fake.bookFromPage(DISC.uri, edt(10, 29, 15).toISOString(), { name: "Jordan Spackman TEST", email: "info@realtourpilot.com", tracking: { utm_content: tokA } });
    const r1 = await cb.confirmEmbeddedBooking(vA, { eventUri: disc.event.uri });
    c.ok("a DISCOVERY event through the monthly embed → refused", !r1.ok && r1.state === "REFUSED" && !(await recOf(disc.event.uri)), r1.message);
    const thirty = fake.bookFromPage(THIRTY.uri, edt(10, 29, 16).toISOString(), { name: "Jordan Spackman TEST", email: "info@realtourpilot.com", tracking: { utm_content: tokA } });
    const r2 = await cb.confirmEmbeddedBooking(vA, { eventUri: thirty.event.uri });
    c.ok("the generic 30-minute type → refused", !r2.ok && !(await recOf(thirty.event.uri)));
    const other = fake.bookFromPage(MONTHLY.uri, edt(10, 29, 11).toISOString(), { name: "Bea Other", email: "b-assistant@x.example", tracking: { utm_content: tokB } });
    const r3 = await cb.confirmEmbeddedBooking(vA, { eventUri: other.event.uri });
    c.ok("another account's token, confirmed by A → refused (A04)", !r3.ok && r3.state === "REFUSED" && /different account/.test(r3.message) && !(await recOf(other.event.uri)), r3.message);
    const forged = fake.bookFromPage(MONTHLY.uri, edt(10, 29, 12).toISOString(), { name: "Jordan Spackman TEST", email: "x@x.example", tracking: { utm_content: `rtp1.${A.monthId}.AAAAAAAAAA` } });
    const r4 = await cb.confirmEmbeddedBooking(vA, { eventUri: forged.event.uri });
    c.ok("a forged token → not filed by the portal", !r4.ok && !(await recOf(forged.event.uri)));
    const r5 = await cb.confirmEmbeddedBooking(vA, { eventUri: "https://evil.example/scheduled_events/abc" });
    c.ok("a URI that is not Calendly's → refused without a read", !r5.ok);
    c.ok("no record was written by any refusal", (await prisma.programCallRecord.count()) === before);
    // A04, the sweep: the client's FULL name from an unknown address, no token.
    const byName = fake.bookFromPage(MONTHLY.uri, edt(10, 29, 13).toISOString(), { name: "Jordan Spackman TEST", email: "stranger@else.example", tracking: {} });
    await ccr.syncCallRecordsFromCalendly({ now: now() });
    const rn = await recOf(byName.event.uri);
    c.ok("A04: a name match alone never attaches a call to a month", rn?.matchState === "UNMATCHED_INVITEE" && rn.monthId === null, `${rn?.matchState}`);
    const rf = await recOf(forged.event.uri);
    c.ok("the sweep ignores the forged token too", rf?.matchState !== "MATCHED" && rf?.monthId === null, `${rf?.matchState}`);
    // Tidy the noise away so later counts are about the journeys.
    for (const e of [disc, thirty, forged, byName]) { fake.cancelFromPage(e.event.uri); }
  }

  // =========================================================================
  c.head("5 · The hourly sweep keeps what the portal filed");
  {
    const out = await ccr.syncCallRecordsFromCalendly({ now: now() });
    c.ok("the sweep ran", !("skipped" in out), JSON.stringify("skipped" in out ? out : { created: out.created, updated: out.updated }));
    c.ok("no duplicate record for the portal booking", (await prisma.programCallRecord.count({ where: { calendlyEventUri: firstEvent } })) === 1);
    const rec = await recOf(firstEvent);
    c.ok("still MATCHED by token, still OCTOBER, still PORTAL_EMBED", rec?.matchState === "MATCHED" && rec.targetMonthKey === "2026-10" && rec.monthId === A.monthId && rec.bookingSource === "PORTAL_EMBED");
    // B booked on the page and closed the tab before the widget spoke: the
    // sweep sees it FIRST (the event from §4 carries B's token).
    const bUri = (await prisma.programCallRecord.findFirst({ where: { clientId: B.clientId } }))?.calendlyEventUri ?? null;
    const recB = bUri ? await recOf(bUri) : null;
    c.ok("a booking the sweep sees first: MATCHED by token to B, B's October, PORTAL_TOKEN", recB?.matchState === "MATCHED" && recB.monthId === B.monthId && recB.bookingSource === "PORTAL_TOKEN" && JSON.parse(recB.rawJson ?? "{}").target?.rule === "portal", `${recB?.matchState} ${recB?.bookingSource}`);
    const late = await cb.confirmEmbeddedBooking(vB, { eventUri: bUri! });
    const recB2 = await recOf(bUri!);
    c.ok("…the portal's own confirm then upgrades it to PORTAL_EMBED, no duplicate", late.ok && recB2?.bookingSource === "PORTAL_EMBED" && (await prisma.programCallRecord.count({ where: { calendlyEventUri: bUri! } })) === 1);
    // A person still wins over the token.
    await ccr.setCallRecordTargetMonth(recB2!.id, "2026-11", "kyle");
    await ccr.syncCallRecordsFromCalendly({ now: now() });
    const recB3 = await recOf(bUri!);
    c.ok("staff retargeted B's call to November; the sweep keeps November (rule 'staff')", recB3?.targetMonthKey === "2026-11" && JSON.parse(recB3.rawJson ?? "{}").target?.rule === "staff");
    await ccr.ignoreCallRecord(recB3!.id, "kyle", "drill: staff ignored it");
    const afterIgnore = await cb.confirmEmbeddedBooking(vB, { eventUri: bUri! });
    c.ok("a booking staff IGNORED stays ignored; the widget firing again does not say 'booked'", !afterIgnore.ok && (await recOf(bUri!))?.matchState === "IGNORED", afterIgnore.message);
  }

  // =========================================================================
  c.head("6 · Change and cancel on Calendly's own pages");
  {
    const moved = fake.rescheduleFromPage(firstEvent, edt(10, 29, 15).toISOString(), { carryTracking: false });
    const r = await cb.confirmEmbeddedBooking(vA, { eventUri: moved.event.uri });
    const nu = await recOf(moved.event.uri);
    const old = await recOf(firstEvent);
    c.ok("the replacement (no token of its own) is A's by Calendly's old_invitee link", r.ok && nu?.matchState === "MATCHED" && nu.clientId === A.clientId && nu.monthId === A.monthId && /rescheduled from a portal booking/.test(nu.matchNote ?? ""), nu?.matchNote ?? "");
    c.ok("the old booking is RESCHEDULED at once (not at the hour) and points forward", old?.status === "RESCHEDULED" && nu?.rescheduledFromId === old?.id);
    const gate = await sessionGate(A.enrollmentId, A.monthId, { now: now() });
    const tue = est(11, 3, 15, 30);
    c.ok("the gate moved with the call: Thu Oct 29 3:30 pm EDT end → Tue Nov 3 3:30 pm EST", !gate.locked && gate.earliest.getTime() === tue.getTime(), gate.earliest.toISOString());
    fake.cancelFromPage(moved.event.uri);
    const rr = await cb.refreshPortalCall(vA, A.monthId);
    const gone = await recOf(moved.event.uri);
    const month = await prisma.contentMonth.findUnique({ where: { id: A.monthId }, select: { callRecordId: true } });
    c.ok("cancel on Calendly's page → refresh → CANCELLED, the month let go of it", rr.ok && gone?.status === "CANCELLED" && month?.callRecordId !== gone?.id, rr.message);
    const gate2 = await sessionGate(A.enrollmentId, A.monthId, { now: now() });
    c.ok("…and filming is shut again until a call is booked (no silent shoot change)", gate2.locked, `${gate2.reason} ${gate2.earliest.toISOString()} ${gate2.callStatus} ${gate2.planningMode} ${JSON.stringify(await prisma.programCallRecord.findMany({ where: { monthId: A.monthId }, select: { status: true, scheduledStart: true, matchState: true } }))}`);
    const recon = await cb.reconcileCallBookings({ now: now() });
    c.ok("the ledger rows of both dead bookings are CANCELLED", recon.cancelled >= 1 && (await prisma.programCallBooking.count({ where: { monthId: A.monthId, state: "CREATED" } })) === 0, JSON.stringify(recon));
  }

  // =========================================================================
  c.head("7 · API mode: the hub books through the Scheduling API");
  const C = await buildContentMonth(prisma, { name: "API Client TEST", monthKey: "2026-11", project: false, owner: { email: "info+c@realtourpilot.com", name: "Cal API TEST" } });
  await prisma.client.update({ where: { id: C.clientId }, data: { email: "info+c@realtourpilot.com" } });
  const vC = viewerOf(C, "info+c@realtourpilot.com", "Cal API TEST");
  const tokC = cb.portalCallToken(C.enrollmentId, C.monthId);
  {
    clearFake();
    // Open times: Fri Oct 30 1:30 pm EDT (ends 2:00), Mon Nov 2 2:00 pm EST
    // (ends 2:30), Tue Nov 3 9:00 EST, and one 9 days out (the next page).
    const fri = edt(10, 30, 13, 30), mon = est(11, 2, 14), tue = est(11, 3, 9), later = est(11, 6, 10);
    fake.openSlots(MONTHLY.uri, [fri, mon, tue, later, edt(10, 28, 9) /* already past */]);
    await setAutomation("call_booking", false, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [C.clientId] }));
    const off = await cb.bookStrategyCall(vC, C.monthId, mon.toISOString(), { now: now() });
    c.ok("switch OFF: bookStrategyCall refuses, nothing posted", !off.ok && fake.state.posts === 0, off.message);
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [C.clientId] }));
    c.ok("switch ON, C listed, probe ok → C's view is API", (await cb.portalCallBookingView(vC, C.monthId))?.mode === "API");

    const page1 = await cb.callSlots(vC, C.monthId, null, { now: now() });
    c.ok("page 1: the open times inside 7 days, none in the past", page1.ok && page1.slots.length === 3 && page1.slots.every((s) => Date.parse(s.startISO) > now().getTime()), page1.ok ? page1.slots.map((s) => s.startISO).join(",") : page1.message);
    c.ok("each Calendly read asked ≤ 7 days (the fake refuses more)", fake.state.log.filter((l) => l.startsWith("GET /event_type_available_times")).length > 0 && page1.ok && Date.parse(page1.toISO) - Date.parse(page1.fromISO) <= 7 * 864e5);
    const f = page1.ok ? page1.slots.find((s) => s.startISO === fri.toISOString()) : null;
    const mo = page1.ok ? page1.slots.find((s) => s.startISO === mon.toISOString()) : null;
    c.ok("Fri 1:30–2:00 pm EDT call → filming from Wed Nov 4 2:00 pm EST (Fri 2 pm → Wed 2 pm, across DST)", f?.filmingFromISO === est(11, 4, 14).toISOString(), f?.filmingFromISO);
    c.ok("Mon 2:00–2:30 pm EST call → filming from Thu Nov 5 2:30 pm EST (Mon 2:30 → Thu 2:30)", mo?.filmingFromISO === est(11, 5, 14, 30).toISOString(), mo?.filmingFromISO);
    const page2 = page1.ok ? await cb.callSlots(vC, C.monthId, page1.nextFromISO, { now: now() }) : null;
    c.ok("page 2 (the next 7 days) has the later time", !!page2?.ok && page2.slots.some((s) => s.startISO === later.toISOString()));

    const booked = await cb.bookStrategyCall(vC, C.monthId, mon.toISOString(), { now: now() });
    c.ok("book Mon 2:00 pm → CREATED, exactly one POST", booked.ok && booked.state === "CREATED" && fake.state.posts === 1 && fake.state.postsCommitted === 1, booked.message);
    const inv = fake.activeInvitees().find((i) => i.tracking.utm_content === tokC);
    c.ok("the invitee: C's person, their timezone, the token in tracking.utm_content", inv?.email === "info+c@realtourpilot.com" && inv.name === "Cal API TEST" && inv.timezone === "America/New_York");
    const ledger = await prisma.programCallBooking.findFirst({ where: { monthId: C.monthId, startAt: mon } });
    const rec = ledger?.calendlyEventUri ? await recOf(ledger.calendlyEventUri) : null;
    c.ok("the attempt went INTENT → CREATED with Calendly's event and invitee", ledger?.state === "CREATED" && !!ledger.calendlyEventUri && !!ledger.calendlyInviteeUri && ledger.attempts === 1);
    c.ok("read back into a call record: MATCHED by token, PORTAL_API, C's November locked", rec?.matchState === "MATCHED" && rec.bookingSource === "PORTAL_API" && rec.monthId === C.monthId && rec.targetMonthKey === "2026-11");
    c.ok("the client is told when filming may start (the gate's own answer)", booked.filmingFromISO === est(11, 5, 14, 30).toISOString(), booked.filmingFromISO ?? "null");
    const dbl = await cb.bookStrategyCall(vC, C.monthId, mon.toISOString(), { now: now() });
    c.ok("a double click on the same time → 'already booked', no second POST", dbl.ok && dbl.duplicate === true && fake.state.posts === 1);
    const second = await cb.bookStrategyCall(vC, C.monthId, tue.toISOString(), { now: now() });
    c.ok("another time while one is booked → refused, no POST", !second.ok && second.state === "REFUSED" && fake.state.posts === 1, second.message);

    // Two tabs at once on a fresh month: at most one POST.
    const D = await buildContentMonth(prisma, { name: "Twin Tabs TEST", monthKey: "2026-11", project: false, owner: { email: "info+d@realtourpilot.com", name: "Twin TEST" } });
    await prisma.client.update({ where: { id: D.clientId }, data: { email: "info+d@realtourpilot.com" } });
    const vD = viewerOf(D, "info+d@realtourpilot.com", "Twin TEST");
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [C.clientId, D.clientId] }));
    const postsBefore = fake.state.posts;
    const [t1, t2] = await Promise.all([
      cb.bookStrategyCall(vD, D.monthId, fri.toISOString(), { now: now() }),
      cb.bookStrategyCall(vD, D.monthId, tue.toISOString(), { now: now() }),
    ]);
    c.ok("two tabs, two different times, at once → exactly ONE POST", fake.state.posts - postsBefore === 1 && [t1, t2].filter((x) => x.state === "CREATED" && !x.duplicate).length === 1, `${t1.state}/${t2.state}`);
    c.ok("…one active booking for that month on Calendly", fake.activeInvitees().filter((i) => i.tracking.utm_content === cb.portalCallToken(D.enrollmentId, D.monthId)).length === 1);

    // A timeout AFTER Calendly committed: adopted by READ, never re-posted.
    const E = await buildContentMonth(prisma, { name: "Timeout Case TEST", monthKey: "2026-11", project: false, owner: { email: "info+e@realtourpilot.com", name: "Tim TEST" } });
    await prisma.client.update({ where: { id: E.clientId }, data: { email: "info+e@realtourpilot.com" } });
    const vE = viewerOf(E, "info+e@realtourpilot.com", "Tim TEST");
    const tokE = cb.portalCallToken(E.enrollmentId, E.monthId);
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [C.clientId, D.clientId, E.clientId] }));
    const eSlot = est(11, 3, 15);
    fake.openSlots(MONTHLY.uri, [eSlot, est(11, 3, 16)]);
    fake.state.commitThenTimeout = 1;
    const p0 = fake.state.posts;
    const te = await cb.bookStrategyCall(vE, E.monthId, eSlot.toISOString(), { now: now() });
    c.ok("POST committed, the answer was lost (timeout) → UNKNOWN → READ finds it by token → CREATED", te.ok && te.state === "CREATED" && fake.state.posts - p0 === 1, te.message);
    c.ok("exactly one invitee for that month on Calendly", fake.activeInvitees().filter((i) => i.tracking.utm_content === tokE).length === 1);
    const teAgain = await cb.bookStrategyCall(vE, E.monthId, eSlot.toISOString(), { now: now() });
    c.ok("retrying the same time → duplicate, still one POST", teAgain.ok && fake.state.posts - p0 === 1);
    const eRec = await prisma.programCallRecord.findFirst({ where: { clientId: E.clientId } });
    c.ok("the adopted booking is on file: MATCHED, PORTAL_API", eRec?.matchState === "MATCHED" && eRec.bookingSource === "PORTAL_API");

    // A timeout that never committed (a 503): PENDING inside the grace, FAILED after.
    const F = await buildContentMonth(prisma, { name: "Nothing Landed TEST", monthKey: "2026-11", project: false, owner: { email: "info+f@realtourpilot.com", name: "Nil TEST" } });
    await prisma.client.update({ where: { id: F.clientId }, data: { email: "info+f@realtourpilot.com" } });
    const vF = viewerOf(F, "info+f@realtourpilot.com", "Nil TEST");
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [C.clientId, D.clientId, E.clientId, F.clientId] }));
    const fSlot = est(11, 3, 16);
    fake.state.failNextPost = 503;
    const p1 = fake.state.posts;
    const tf = await cb.bookStrategyCall(vF, F.monthId, fSlot.toISOString(), { now: now() });
    const fRow = await prisma.programCallBooking.findFirst({ where: { monthId: F.monthId } });
    c.ok("503 → UNKNOWN, READ finds nothing → PENDING (the client is told we're confirming)", !tf.ok && tf.state === "PENDING" && fRow?.state === "UNKNOWN", `${tf.state} ${fRow?.state}`);
    const tf2 = await cb.bookStrategyCall(vF, F.monthId, fSlot.toISOString(), { now: now() });
    c.ok("a retry inside the grace READS again and does NOT post", tf2.state === "PENDING" && fake.state.posts - p1 === 1);
    setClock(new RealDate(now().getTime() + 6 * 60_000));
    const tf3 = await cb.bookStrategyCall(vF, F.monthId, fSlot.toISOString(), { now: now() });
    c.ok("after the grace, READ-negative → FAILED ('pick again'), still no second POST", tf3.state === "FAILED" && fake.state.posts - p1 === 1, tf3.message);
    const tf4 = await cb.bookStrategyCall(vF, F.monthId, fSlot.toISOString(), { now: now() });
    c.ok("only then does a new pick post — and it books", tf4.ok && tf4.state === "CREATED" && fake.state.posts - p1 === 2);
    const fLedger = await prisma.programCallBooking.findFirst({ where: { monthId: F.monthId } });
    c.ok("…on the SAME attempt row (attempts 2), no duplicate row", fLedger?.attempts === 2 && (await prisma.programCallBooking.count({ where: { monthId: F.monthId } })) === 1);
    setClock(START);

    // A slot taken on the page between the list and the click.
    const G = await buildContentMonth(prisma, { name: "Taken Slot TEST", monthKey: "2026-11", project: false, owner: { email: "info+g@realtourpilot.com", name: "Gee TEST" } });
    await prisma.client.update({ where: { id: G.clientId }, data: { email: "info+g@realtourpilot.com" } });
    const vG = viewerOf(G, "info+g@realtourpilot.com", "Gee TEST");
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [C.clientId, D.clientId, E.clientId, F.clientId, G.clientId] }));
    const gSlot = est(11, 4, 10);
    fake.openSlots(MONTHLY.uri, [gSlot]);
    fake.bookFromPage(MONTHLY.uri, gSlot.toISOString(), { name: "Someone Else", email: "else@x.example" });
    const tg = await cb.bookStrategyCall(vG, G.monthId, gSlot.toISOString(), { now: now() });
    c.ok("the time was taken meanwhile → FAILED 'just taken', nothing booked for G", !tg.ok && tg.state === "FAILED" && /just taken/.test(tg.message) && fake.activeInvitees().every((i) => i.tracking.utm_content !== cb.portalCallToken(G.enrollmentId, G.monthId)));

    // A crash between INTENT and the answer: the hourly reconcile adopts by token.
    const H = await buildContentMonth(prisma, { name: "Crash Case TEST", monthKey: "2026-11", project: false, owner: { email: "info+h@realtourpilot.com", name: "Hal TEST" } });
    const tokH = cb.portalCallToken(H.enrollmentId, H.monthId);
    const hSlot = est(11, 4, 11);
    fake.openSlots(MONTHLY.uri, [hSlot]);
    fake.bookFromPage(MONTHLY.uri, hSlot.toISOString(), { name: "Hal TEST", email: "info+h@realtourpilot.com", tracking: { utm_content: tokH } });
    await prisma.programCallBooking.create({ data: { enrollmentId: H.enrollmentId, clientId: H.clientId, monthId: H.monthId, eventTypeUri: MONTHLY.uri, startAt: hSlot, token: tokH, state: "INTENT", attempts: 1 } });
    const rh = await cb.reconcileCallBookings({ now: now() });
    const hRow = await prisma.programCallBooking.findFirst({ where: { monthId: H.monthId } });
    c.ok("an attempt left INTENT by a crash is settled by the hourly READ → CREATED", rh.created >= 1 && hRow?.state === "CREATED" && !!hRow.calendlyEventUri, JSON.stringify(rh));

    // The plan lost the Scheduling API: fall back to the embed, and remember it.
    fake.state.plan = "free";
    const s403 = await cb.callSlots(vC, C.monthId, null, { now: now() });
    c.ok("a 403 while listing → fallback EMBED, the stored probe now says 'plan'", !s403.ok && s403.fallback === "EMBED" && (await cb.storedSchedulingProbe())?.status === "plan");
    c.ok("…so the next render is the embed", (await cb.portalCallBookingView(vC, C.monthId))?.mode === "EMBED");
    fake.state.plan = "paid";
    await cb.runSchedulingProbe({ store: true, by: "drill" });

    // The guard itself.
    const forgedPermit = Object.freeze({ clientId: C.clientId, operation: "invitees.create" as const, scope: "FIXTURE" as const, issuedAt: Date.now() });
    let threw = "";
    try { await cal.createInvitee(forgedPermit, { eventTypeUri: MONTHLY.uri, startISO: tue.toISOString(), invitee: { name: "x", email: "x@x.x", timezone: "America/New_York" } }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    c.ok("a hand-made permit is refused before any request", /no write permit/.test(threw) && fake.state.log.every((l) => !l.includes("x@x.x")), threw);
    const realPermit = await cal.calendlyWritePermit({ client: { id: R.clientId, name: "Real Person Realty" }, operation: "invitees.create", inviteeEmail: "agent@realperson.example" });
    c.ok("a real client outside any pilot → no permit", !realPermit.ok);
    const viewerBook = await cb.bookStrategyCall({ ...vC, actor: { ...(vC.actor as Extract<PortalViewer["actor"], { kind: "CLIENT" }>), membershipRole: "VIEWER" } }, C.monthId, tue.toISOString(), { now: now() });
    c.ok("a VIEWER seat cannot book", !viewerBook.ok && viewerBook.state === "REFUSED");
  }

  // =========================================================================
  c.head("8 · The ops scripts, against the fake");
  {
    const { runCapabilityProbe } = await import("../_ops/calendly-capability-probe");
    const { runSupervisedTest } = await import("../_ops/calendly-supervised-test");
    const lines: string[] = [];
    const log = (l: string) => { lines.push(l); };
    await prisma.appSetting.deleteMany({ where: { key: cb.SCHEDULING_PROBE_KEY } });
    const d = await runCapabilityProbe([], log);
    c.ok("probe dry run: asks (read-only), stores nothing", d.status === "ok" && d.mode === "dry-run" && (await cb.storedSchedulingProbe()) === null);
    const a = await runCapabilityProbe(["--apply"], log);
    c.ok("probe --apply: stores 'ok' for the mapped type", a.stored && (await cb.storedSchedulingProbe())?.status === "ok");

    // The real TEST fixture's shape: "Jordan Spackman TEST" on info@. (A.)
    await setAutomation("call_booking", false, "drill", JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [] }));
    clearFake();
    const s1 = edt(10, 29, 13), s2 = edt(10, 30, 11);
    fake.openSlots(MONTHLY.uri, [s1, s2]);
    const p0 = fake.state.posts, c0 = fake.state.cancels;
    lines.length = 0;
    const dry = await runSupervisedTest([], log);
    c.ok("supervised dry run: 0 bookings, 0 cancels; prints the POST body with the token", dry.code === 0 && fake.state.posts === p0 && fake.state.cancels === c0 && lines.some((l) => l.includes('"utm_content":"' + tokA + '"')), lines.find((l) => l.startsWith("POST")) ?? "");
    // Batch-3 review: the printed arm command used to be setAutomation(…, JSON.stringify({…})),
    // which replaced the whole config (an approved pilot would vanish, unaudited).
    c.ok("…and, with the guard not armed, the audited arm command (the fixture list and the on/off only) and the disarm", lines.some((l) => l.includes("scripts/_ops/hub-write-fixture.ts --switch call_booking --add " + A.clientId + " --on --apply")) && lines.some((l) => l.includes("--remove " + A.clientId + " --off --apply")) && !lines.some((l) => /setAutomation\(/.test(l)), lines.filter((l) => /hub-write-fixture|setAutomation/.test(l)).join(" | "));
    await setAutomation("call_booking", false, "drill", JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [A.clientId], pilot: { clientIds: [R.clientId], operations: ["invitees.create"], approvedBy: "jordan@realtourpilot.com", approvedAt: edt(10, 1, 9).toISOString(), expiresAt: null, note: null } }));
    lines.length = 0;
    const withPilot = await runSupervisedTest(["--apply"], log);
    c.ok("--apply refuses while call_booking carries a pilot with real clients (arming it would write for them too)", withPilot.code === 2 && /pilot/.test(withPilot.refused ?? "") && fake.state.posts === p0, withPilot.refused ?? "");
    await setAutomation("call_booking", false, "drill", JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [] }));
    const offRun = await runSupervisedTest(["--apply"], log);
    c.ok("--apply with call_booking OFF → refused, nothing booked", offRun.code !== 0 && !!offRun.refused && fake.state.posts === p0, offRun.refused ?? "");
    const notTest = await runSupervisedTest(["--apply", "--client-name", "Real Person Realty"], log);
    c.ok("--client-name of a real client → refused before anything", !!notTest.refused && /not a TEST client/.test(notTest.refused) && fake.state.posts === p0);
    await setAutomation("call_booking", true, "supervised-test", JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [A.clientId] }));
    lines.length = 0;
    const run = await runSupervisedTest(["--apply"], log);
    c.ok("--apply: ONE invitee booked, read back, would MATCH by token, cancelled and read back canceled", run.code === 0 && run.booked === true && run.wouldMatch === true && run.cancelled === true && fake.state.posts - p0 === 1 && fake.state.cancels - c0 === 1, lines.filter((l) => /FAIL|REFUSED|NOT/.test(l)).join(" | "));
    c.ok("…nothing left on the calendar", fake.activeInvitees().length === 0);
    c.ok("…every read-back check passed", lines.filter((l) => l.trim().startsWith("PASS")).length === 7 && !lines.some((l) => l.trim().startsWith("FAIL")));
    c.ok("…and it ends with the disarm step (switch off, fixture off the list)", lines.some((l) => /^CLEANUP: switch call_booking off/.test(l)) && lines.some((l) => l.includes("--switch call_booking --remove " + A.clientId + " --off --apply")));
    fake.state.commitThenTimeout = 1;
    lines.length = 0;
    const tRun = await runSupervisedTest(["--apply", "--start", s2.toISOString()], log);
    c.ok("--apply whose POST times out after committing: found by token (no second POST), then cancelled", tRun.code === 0 && tRun.cancelled === true && fake.state.posts - p0 === 2 && fake.activeInvitees().length === 0, lines.join(" | ").slice(0, 300));
    await setAutomation("call_booking", false, "drill", JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [] }));
  }

  // =========================================================================
  // Batch-3 review (Sep 25 2026). The stale-page rule used to read the CALL's
  // month, so a client planning October who picked the first open time on
  // Oct 29 — Mon Nov 2 — had October's token refused: the call was filed on
  // November by email and date, the portal still said "Booked", October's
  // filming stayed shut and every new pick was "already booked". That code was
  // this batch's own (uncommitted), so the rule is asserted directly.
  c.head("7b · Late in the month: THIS month's call on the first open time, early next month, is this month's");
  {
    setClock(edt(10, 29, 10)); // Thu Oct 29, 10:00 EDT
    const K = await buildContentMonth(prisma, { name: "Late Month TEST", monthKey: "2026-10", project: false, owner: { email: "info+k@realtourpilot.com", name: "Kay TEST" } });
    await prisma.client.update({ where: { id: K.clientId }, data: { email: "info+k@realtourpilot.com" } });
    const vK = viewerOf(K, "info+k@realtourpilot.com", "Kay TEST");
    const tokK = cb.portalCallToken(K.enrollmentId, K.monthId);
    await setAutomation("call_booking", true, "drill", JSON.stringify({ mode: "API", authorizedFixtureClientIds: [K.clientId] }));
    clearFake();
    const nov2 = est(11, 2, 14);
    fake.openSlots(MONTHLY.uri, [nov2, est(11, 3, 9)]);
    const links = await cb.portalBookingLinks(vK, { layout: "v2", planHref: "?tab=plan", now: now() });
    c.ok("on Oct 29 the portal's call step is OCTOBER's, in API mode", links.view?.monthId === K.monthId && links.view.mode === "API", `${links.view?.monthKey} ${links.view?.mode}`);
    const page = await cb.callSlots(vK, K.monthId, null, { now: now() });
    c.ok("October's picker offers Mon Nov 2, 2:00 pm", page.ok && page.slots.some((s) => s.startISO === nov2.toISOString()), page.ok ? page.slots.map((s) => s.startISO).join(",") : page.message);
    const p0 = fake.state.posts;
    const bk = await cb.bookStrategyCall(vK, K.monthId, nov2.toISOString(), { now: now() });
    const recK = await prisma.programCallRecord.findFirst({ where: { clientId: K.clientId } });
    c.ok("'Booked', and the record is on OCTOBER by its token (not November by its date)", bk.ok && bk.state === "CREATED" && recK?.monthId === K.monthId && recK.portalToken === tokK && recK.bookingSource === "PORTAL_API", `${bk.state}: ${bk.message} | month ${recK?.monthId === K.monthId ? "October" : recK?.monthId} token ${recK?.portalToken ? "kept" : "none"} src ${recK?.bookingSource}`);
    const viewK = await cb.portalCallBookingView(vK, K.monthId, { now: now() });
    c.ok("October's view shows the booked call (the picker is not offered again)", viewK?.booked?.startISO === nov2.toISOString(), JSON.stringify(viewK?.booked));
    const gK = await sessionGate(K.enrollmentId, K.monthId, { now: now() });
    c.ok("October's filming gate opens: Mon 2:30 pm end → Thu Nov 5, 2:30 pm EST", !gK.locked && gK.earliest.toISOString() === est(11, 5, 14, 30).toISOString(), gK.locked ? gK.reason : gK.earliest.toISOString());
    c.ok("…and the client is told so", bk.filmingFromISO === est(11, 5, 14, 30).toISOString(), bk.filmingFromISO ?? "null");
    const again = await cb.bookStrategyCall(vK, K.monthId, est(11, 3, 9).toISOString(), { now: now() });
    c.ok("a second pick is 'already booked' (true now), no second POST", !again.ok && /already booked/.test(again.message) && fake.state.posts - p0 === 1, again.message);
    await ccr.syncCallRecordsFromCalendly({ now: now() });
    const recK2 = await prisma.programCallRecord.findFirst({ where: { clientId: K.clientId } });
    c.ok("the hourly sweep keeps it on October, MATCHED", recK2?.monthId === K.monthId && recK2.matchState === "MATCHED", `${recK2?.matchState} ${recK2?.targetMonthKey}`);
    // EMBED: the same late-month booking made on Calendly's own page.
    const L = await buildContentMonth(prisma, { name: "Late Embed TEST", monthKey: "2026-10", project: false, owner: { email: "info+l@realtourpilot.com", name: "Lee TEST" } });
    await prisma.client.update({ where: { id: L.clientId }, data: { email: "info+l@realtourpilot.com" } });
    const vL = viewerOf(L, "info+l@realtourpilot.com", "Lee TEST");
    await setAutomation("call_booking", false, "drill", JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [] }));
    const ev = fake.bookFromPage(MONTHLY.uri, est(11, 3, 9).toISOString(), { name: "Lee TEST", email: "lee.assistant@elsewhere.example", tracking: { utm_source: "rtp-portal", utm_content: cb.portalCallToken(L.enrollmentId, L.monthId) } });
    const ce = await cb.confirmEmbeddedBooking(vL, { eventUri: ev.event.uri }, { now: now() });
    const recL = await recOf(ev.event.uri);
    c.ok("EMBED: filed on October at once, by token (not 'within the hour', not November by date)", ce.ok && ce.state === "CREATED" && recL?.monthId === L.monthId && recL.matchState === "MATCHED", `${ce.state}: ${ce.message} | ${recL?.matchState} ${recL?.targetMonthKey}`);
    // The stale page itself is still refused — judged by when it was BOOKED.
    const S = await buildContentMonth(prisma, { name: "Stale Page TEST", monthKey: "2026-09", project: false, owner: { email: "info+s@realtourpilot.com", name: "Sam TEST" } });
    const tokS = cb.portalCallToken(S.enrollmentId, S.monthId);
    c.ok("a page left open since SEPTEMBER, booked on Oct 29: refused", (await cb.verifyPortalCallToken(tokS, { bookedAt: now(), callStart: edt(10, 30, 9) })) === null);
    c.ok("…the same September page booked on Sep 29 for Oct 2: September's", !!(await cb.verifyPortalCallToken(tokS, { bookedAt: edt(9, 29, 16), callStart: edt(10, 2, 9) })));
    setClock(START);
  }

  // =========================================================================
  c.head("9 · Wiring");
  {
    const { yourMonthSteps } = await import("@/lib/yourMonth");
    const { planningForMonth } = await import("@/lib/planningFacts");
    const pf = await planningForMonth(A.monthId);
    const base = {
      monthLabel: "October", month: pf!.planning, schedule: null, can: { suggest: true, session: true }, readOnly: false,
      planning: { callMode: "REQUIRED", planningMode: "CALL", callStatus: "NOT_SCHEDULED", callAtISO: null, noCallEligible: false, chosenAtISO: null, deferredAtISO: null },
    };
    const inPortal = yourMonthSteps({ ...base, hrefs: { bank: "?tab=plan&pv=bank", month: "?tab=plan", scripts: "?tab=plan&pv=scripts", bookingUrl: "?tab=plan#step-call" } }).find((s) => s.key === "call");
    const outside = yourMonthSteps({ ...base, hrefs: { bank: "?tab=plan&pv=bank", month: "?tab=plan", scripts: "?tab=plan&pv=scripts", bookingUrl: MONTHLY.scheduling_url } }).find((s) => s.key === "call");
    c.ok("Your Month's 'Book the call' stays in the page when booking is in the portal", inPortal?.cta?.href.endsWith("#step-call") === true && inPortal.cta.external === false);
    c.ok("…and opens a new tab only for a Calendly address", outside?.cta?.external === true);
    const v1 = await cb.portalBookingLinks(vA, { layout: "v1", planHref: null });
    c.ok("v1 (every real client today): the mapping's page — same URL as the old constant, no token", v1.bookingUrl === MONTHLY.scheduling_url && v1.view === null);
    await prisma.programCalendlyEventMapping.updateMany({ where: { purpose: "MONTHLY_STRATEGY" }, data: { enabled: false } });
    const v1none = await cb.portalBookingLinks(vA, { layout: "v1", planHref: null });
    const v2none = await cb.portalBookingLinks(vA, { layout: "v2", planHref: "?tab=plan" });
    c.ok("with no mapping: v1 keeps the old public link (as the reminder emails do); v2 offers no Calendly at all (Kyle)", v1none.bookingUrl === cal.STRATEGY_CALL_BOOKING_URL && v2none.view?.mode === "NONE" && v2none.bookingUrl === "?tab=plan#step-call" && v2none.view.embedUrl === null);
    await prisma.programCalendlyEventMapping.updateMany({ where: { purpose: "MONTHLY_STRATEGY" }, data: { enabled: true } });
    const v2 = await cb.portalBookingLinks(vA, { layout: "v2", planHref: "?tab=plan" });
    c.ok("v2: 'Book the call' lands on Your Month's call step, with the month's view", v2.bookingUrl === "?tab=plan#step-call" && v2.view?.monthId === A.monthId);
    await prisma.contentMonth.update({ where: { id: A.monthId }, data: { planningMode: "WRITTEN" } });
    const v2w = await cb.portalBookingLinks(vA, { layout: "v2", planHref: "?tab=plan" });
    c.ok("v2 on the written route ('book one anyway'): the mapped page with the token", !!v2w.bookingUrl && new URL(v2w.bookingUrl).searchParams.get("utm_content") === tokA);
    await prisma.contentMonth.update({ where: { id: A.monthId }, data: { planningMode: null } });
    const page = code(read("src/components/portal/PortalPage.tsx"));
    c.ok("PortalPage no longer names the hard-coded URL (it asks portalBookingLinks)", !/STRATEGY_CALL_BOOKING_URL/.test(page) && /portalBookingLinks/.test(page));
    const ym = code(read("src/components/portal/YourMonth.tsx"));
    c.ok("Your Month renders the picker in the call step, never after the call is held", /step\.key === "call" && d\.callBooking && planning\.call !== "HELD"/.test(ym) && /<PortalCallPicker/.test(ym));
    const inline = code(read("src/components/portal/CalendlyInline.tsx"));
    c.ok("the embed believes only https://calendly.com AND its own iframe", /e\.origin !== CALENDLY_ORIGIN/.test(inline) && /e\.source !== frame\.current\.contentWindow/.test(inline) && /CALENDLY_ORIGIN = "https:\/\/calendly\.com"/.test(inline));
    for (const f of ["src/components/portal/tabs/ScheduleTab.tsx", "src/components/portal/tabs/HomeTab.tsx", "src/components/portal/PortalScheduler.tsx"]) {
      const src = code(read(f));
      c.ok(`${path.basename(f)}: the booking link opens a new tab only for an outside address`, !/href=\{(d\.)?bookingUrl\} target="_blank"/.test(src));
    }
    // The server actions, through the real resolver (the link's token → TOKEN actor).
    const actions = await import("@/app/portal/actions");
    const fresh = fake.bookFromPage(MONTHLY.uri, edt(10, 30, 9).toISOString(), { name: "Bea Other", email: "b@x.example", tracking: { utm_content: tokB } });
    const viaLink = await actions.portalCallScheduled({ token: B.portalToken! }, { eventUri: fresh.event.uri });
    c.ok("portalCallScheduled through B's link files B's booking", viaLink.ok, viaLink.message);
    const wrongLink = await actions.portalCallScheduled({ token: A.portalToken! }, { eventUri: fresh.event.uri });
    c.ok("…the same event through A's link is refused (different account)", !wrongLink.ok && /different account/.test(wrongLink.message));
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { status: "PAUSED" } });
    const paused = await actions.portalCallSlots({ token: B.portalToken! }, B.monthId, null);
    c.ok("a paused program cannot list or book (read-only)", !paused.ok && /paused/i.test(paused.message), paused.ok ? "" : paused.message);
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { status: "ACTIVE" } });
  }

  c.head("Isolation");
  c.ok("nothing left the machine: every non-loopback call was the fake Calendly", fence.blocked.length === 0 && fence.faked.every((u) => u.startsWith(CAL)), fence.blocked.slice(0, 3).join(", "));

  quiet.restore();
  c.summary();
  await stop();
  fs.rmSync(baseDir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
