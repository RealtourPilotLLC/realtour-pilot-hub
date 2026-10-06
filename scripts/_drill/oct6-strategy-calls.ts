// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: OCT 6 2026 — STRATEGY CALLS BOOKED ON THE GENERIC CALENDLY TYPE.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct6-strategy-calls.ts --logs <scratch dir>
//
// Jordan: "Maybe having an option to look through the strategy calls over the
// past 30 days to manually assign to a client's month would be great." Most
// October calls were booked on "30 Minute Strategy Call", a type the hub did
// not read, so John P. Collins' call today and Joe Sutow's Sep 24 call (the
// one October's topics were chosen on) never reached their months.
//
//   0  OLD: with only the dedicated types mapped, the generic type's bookings
//      get no record at all — John's and Joe's months stay as they were.
//   1  Settings accepts the generic type as STRATEGY_CANDIDATE (the clash rule
//      for one-type-per-purpose does not apply to it).
//   2  INGEST (the hourly sync's own path, 30 days back / 14 ahead): a verified
//      client (John, by email) is filed on October by the sweep; everyone else
//      (Joe from an address not on file, Lauren, Mike) is a CANDIDATE with NO
//      review task, NO alias proposal; a known client whose call would plan a
//      month already over (Kristin, Sep 8) is NOT filed by the sweep — it
//      waits with her named; a second pass changes nothing.
//   3  The desk: window, discovery excluded, statuses, suggestions (Joe by
//      name; never Mike by domain), month default (last 10 days → next month).
//   4  ASSIGN Joe → October: record CONFIRMED_BY_STAFF with who/when; the
//      month's callRecordId, COMPLETED at Sep 24, route CALL; topics and the
//      booked shoot untouched; the next sync keeps it, even on day-rule edges.
//   5  UNASSIGN puts Joe's month back EXACTLY; the next sync does not re-file
//      it by email; assign again.
//   6  John (auto-filed, written route kept): assigning moves the route to the
//      call — SCHEDULED at 4 PM ET; unassign → WRITTEN/SKIPPED again; after the
//      call ends, COMPLETED.
//   7  NOT A PROGRAM CALL / RESTORE; ignoring a WRONGLY assigned call gives that
//      month its state back.
//   8  Refusals: cancelled booking, discovery call, a client with no active
//      program, bad month.
//   9  AUTH: signed out, EDITOR, PHOTOGRAPHER, owner previewing ("view as")
//      refused, nothing written; ADMIN and OWNER allowed; the page redirects a
//      non-admin.
//  10  The portal's reading of both months (portalPlanning).
//  11  Nothing messaged, nothing written to Calendly, nothing left the box.
//
// ISOLATION: PGlite on 127.0.0.1:6870; production is never opened; Calendly is
// the in-process fake; every other non-loopback call is fenced and counted.
// THE CLOCK IS PINNED: Tue Oct 6 2026 10:00 EDT (moves forward only).
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { makeFakeCalendly } from "./_fake-calendly";

const PORT = Number(process.env.DRILL_PORT ?? 6870);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const edt = (m: number, d: number, h: number, min = 0) => new RealDate(RealDate.UTC(2026, m - 1, d, h + 4, min));
let offset = edt(10, 6, 10).getTime() - RealDate.now();
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
let last = edt(10, 6, 10).getTime();
const setClock = (d: Date) => {
  if (d.getTime() < last) throw new Error(`drill clock may only move forward (${d.toISOString()})`);
  last = d.getTime();
  offset = d.getTime() - RealDate.now();
};
const now = () => new RealDate(RealDate.now() + offset);

installNextStubs();
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
navigation.redirect = (href) => { throw new Redirect(href); };

const fake = makeFakeCalendly({ now: () => now().getTime() });
const fence = fenceFetch((url, init) => fake.handle(url, init));

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct6-strategy-calls" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const ccr = await import("@/lib/contentCallRecords");
    const desk = await import("@/lib/strategyCallDesk");
    const A = await import("@/app/content/calls/actions");
    const S = await import("@/app/settings/calendlyActions");
    const { setPlanningMode, recalcProgramMonth } = await import("@/lib/programMonths");
    const { portalPlanning } = await import("@/lib/portal");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { default: page } = await import("@/app/content/calls/page");

    await saveSecret("calendly", "drill-calendly-key-not-real");
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@calls.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@calls.test", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Kim", email: "kim@calls.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const shooter = await prisma.appUser.create({ data: { name: "Harrison", email: "harrison@calls.test", role: "PHOTOGRAPHER", status: "ACTIVE" } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    // ---- Calendly: the three real types ------------------------------------
    const MONTHLY = fake.addEventType({ id: "ET-MONTHLY", name: "Content Program - Strategy Call", slug: "content-program-strategy-call", duration: 30 });
    const DISC = fake.addEventType({ id: "ET-DISC", name: "Brand Discovery Call", slug: "brand-discovery-call", duration: 60 });
    const THIRTY = fake.addEventType({ id: "ET-30", name: "30 Minute Strategy Call", slug: "strategy-call", duration: 30 });
    await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: DISC.uri, eventName: DISC.name, purpose: "BRAND_DISCOVERY", enabled: true, validationStatus: "VALID", publicUrl: DISC.scheduling_url } });
    await prisma.programCalendlyEventMapping.create({ data: { eventTypeUri: MONTHLY.uri, eventName: MONTHLY.name, purpose: "MONTHLY_STRATEGY", enabled: true, validationStatus: "VALID", publicUrl: MONTHLY.scheduling_url } });

    // ---- clients (production's shapes) -------------------------------------
    // John: October planned in WRITING (chosen by staff today), topics chosen.
    const J = await buildContentMonth(prisma, { name: "John Collins TEST", monthKey: "2026-10", project: false, owner: false, topics: [{ title: "Market update", selection: "SELECTED" }, { title: "First-time buyers", selection: "SELECTED" }] });
    // Joe: October's topics chosen on his Sep 24 call; shoot booked; month stamped COMPLETED with no record.
    const Jo = await buildContentMonth(prisma, {
      name: "Joseph Sutow TEST", monthKey: "2026-10", owner: false,
      appointments: [{ startAt: edt(10, 14, 10) }],
      topics: [{ title: "Main Line moves", selection: "RECONCILED", excerpts: ["I want to talk about the Main Line market"] }, { title: "Listing prep", selection: "RECONCILED", excerpts: ["prep is everything"] }],
    });
    // Arielle: an enrolled client whose booking address is not on file.
    const Ar = await buildContentMonth(prisma, { name: "Arielle Roemer TEST", monthKey: "2026-10", project: false, owner: false });
    // Kristin: enrolled, booked the generic type on Sep 8 from her address on file.
    const Kr = await buildContentMonth(prisma, { name: "Kristin Ciarmella TEST", monthKey: "2026-10", project: false, owner: false });
    // Real names (the suggestion ignores TEST clients for non-TEST invitees, like production).
    await prisma.client.update({ where: { id: J.clientId }, data: { name: "John Collins", email: "john@calljohncollins.com" } });
    await prisma.client.update({ where: { id: Jo.clientId }, data: { name: "Joseph Sutow", email: "jcsutow@gmail.com", backupEmail: null } });
    await prisma.client.update({ where: { id: Ar.clientId }, data: { name: "Arielle Roemer", email: "arielle.roemer@gmail.com" } });
    await prisma.client.update({ where: { id: Kr.clientId }, data: { name: "Kristin Ciarmella", email: "klciarmella@gmail.com" } });
    // An ENDED program with a matching address: never a program identity.
    const ended = await prisma.client.create({ data: { name: "Susan McFadden", email: "susan@ended.example" } });
    await prisma.contentEnrollment.create({ data: { clientId: ended.id, status: "ENDED", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 } });

    await setPlanningMode(J.monthId, "WRITTEN", "staff:drill");
    await prisma.contentMonth.update({ where: { id: Jo.monthId }, data: { strategyCallStatus: "COMPLETED", strategyCallAt: null } });
    const monthOf = (id: string) => prisma.contentMonth.findUnique({ where: { id }, select: { strategyCallStatus: true, strategyCallAt: true, planningMode: true, planningChosenAt: true, planningChosenBy: true, callRecordId: true, preparationStatus: true } });
    const johnBefore = await monthOf(J.monthId);
    const joeBefore = await monthOf(Jo.monthId);
    const arBefore = await monthOf(Ar.monthId);
    c.ok("setup: John's October is WRITTEN / SKIPPED, Joe's is a bare COMPLETED stamp", johnBefore?.planningMode === "WRITTEN" && johnBefore.strategyCallStatus === "SKIPPED" && joeBefore?.strategyCallStatus === "COMPLETED" && !joeBefore.planningMode, JSON.stringify({ johnBefore, joeBefore }));

    // ---- the bookings (what Calendly holds, Oct 6 2026) --------------------
    const book = (type: { uri: string }, at: Date, name: string, email: string) => fake.bookFromPage(type.uri, at.toISOString(), { name, email });
    const mike = book(THIRTY, edt(9, 7, 9), "Mike Flatley", "mike@garymercerteam.com");
    const kristin = book(THIRTY, edt(9, 8, 13, 30), "Kristin Ciarmella", "klciarmella@gmail.com");
    const arielle = book(MONTHLY, edt(9, 11, 14, 30), "Arielle Roemer", "arielle.roemer@foxroach.com");
    const joe = book(THIRTY, edt(9, 24, 10), "Joe Sutow", "jsutow@garymercerteam.com");
    const disc = book(DISC, edt(9, 28, 14, 30), "Janice Pigga", "janicepigga@gmail.com");
    const susan = book(THIRTY, edt(10, 1, 11), "Susan McFadden", "susan@ended.example");
    const johnOld = book(THIRTY, edt(10, 6, 15), "John P. Collins", "john@calljohncollins.com");
    fake.cancelFromPage(johnOld.event.uri);
    const john = book(THIRTY, edt(10, 6, 16), "John P. Collins", "john@calljohncollins.com");
    const lauren = book(THIRTY, edt(10, 7, 13, 45), "Lauren Spackman", "lauren.metzinger@yahoo.com");
    const tooOld = book(THIRTY, edt(8, 20, 10), "Old Booking", "old@example.com");
    const tooFar = book(THIRTY, edt(10, 30, 10), "Far Booking", "far@example.com");
    const rec = (ev: { event: { uri: string } }) => prisma.programCallRecord.findUnique({ where: { calendlyEventUri: ev.event.uri } });
    const reviewTasks = () => prisma.smartTask.count({ where: { dedupeKey: { startsWith: "content-call-review-" } } });

    // =========================================================================
    c.head("0 · OLD: the generic type is not read at all");
    {
      await ccr.syncCallRecordsFromCalendly({ now: now(), lookBackDays: 30, lookAheadDays: 14 });
      c.ok("OLD: John's and Joe's 30-minute bookings have no record", !(await rec(john)) && !(await rec(joe)) && !(await rec(lauren)));
      c.ok("OLD: the dedicated type IS read (Arielle → UNMATCHED_INVITEE, no month)", (await rec(arielle))?.matchState === "UNMATCHED_INVITEE" && !(await rec(arielle))?.monthId);
      const jm = await monthOf(J.monthId), om = await monthOf(Jo.monthId);
      c.ok("OLD: John's October still WRITTEN/SKIPPED, Joe's has no call record", jm?.strategyCallStatus === "SKIPPED" && !jm.callRecordId && !om?.callRecordId && !om?.strategyCallAt);
    }

    // =========================================================================
    c.head("1 · Settings maps the generic type as a possible strategy call");
    {
      await signIn(owner);
      const r = await S.saveCalendlyMapping({ eventTypeUri: THIRTY.uri, purpose: "STRATEGY_CANDIDATE", enabled: true });
      c.ok("saved and enabled (no clash with the dedicated monthly type)", r.ok && /possible strategy call/.test(r.message), r.message);
      const row = await prisma.programCalendlyEventMapping.findUnique({ where: { eventTypeUri: THIRTY.uri } });
      c.ok("the row: purpose STRATEGY_CANDIDATE, enabled, VALID, named from the live type", row?.purpose === "STRATEGY_CANDIDATE" && row.enabled && row.validationStatus === "VALID" && row.eventName === "30 Minute Strategy Call");
      const clash = await S.saveCalendlyMapping({ eventTypeUri: DISC.uri, purpose: "MONTHLY_STRATEGY", enabled: true });
      c.ok("a SECOND monthly type is still refused (the old rule stands)", !clash.ok && /already the monthly strategy type/.test(clash.message), clash.message);
      await S.saveCalendlyMapping({ eventTypeUri: DISC.uri, purpose: "BRAND_DISCOVERY", enabled: true });
      await clearSession();
    }

    // =========================================================================
    c.head("2 · Ingest: a verified client is filed, everyone else waits");
    const tasksBefore = await reviewTasks();
    const aliasesBefore = await prisma.clientEmailAlias.count();
    {
      const r = await ccr.syncCallRecordsFromCalendly({ now: now(), lookBackDays: 30, lookAheadDays: 14 });
      c.ok("the sync ran with no errors", !("skipped" in r) && r.errors === 0, JSON.stringify(r));
      const rj = await rec(john);
      c.ok("John (address on file) → MATCHED, MONTHLY_STRATEGY, on October", rj?.matchState === "MATCHED" && rj.callType === "MONTHLY_STRATEGY" && rj.monthId === J.monthId && rj.targetMonthKey === "2026-10", JSON.stringify({ m: rj?.matchState, t: rj?.callType, k: rj?.targetMonthKey }));
      const rjo = await rec(johnOld);
      c.ok("John's cancelled 3 PM booking → recorded CANCELLED, does not hold the month", rjo?.status === "CANCELLED" && (await monthOf(J.monthId))?.callRecordId === rj?.id);
      const jm = await monthOf(J.monthId);
      c.ok("the sweep never changes a route: John's October stays WRITTEN (call shows SCHEDULED)", jm?.planningMode === "WRITTEN" && jm.strategyCallStatus === "SCHEDULED", JSON.stringify(jm));
      for (const [label, ev] of [["Joe (address not on file)", joe], ["Lauren Spackman (not a client)", lauren], ["Mike Flatley (same company as Joe)", mike], ["Susan (program ENDED)", susan]] as const) {
        const x = await rec(ev);
        c.ok(`${label} → CANDIDATE, UNCLASSIFIED, no client, no month`, x?.matchState === "CANDIDATE" && x.callType === "UNCLASSIFIED" && !x.clientId && !x.monthId, `${x?.matchState}/${x?.callType}/${x?.clientId}`);
      }
      const xk = await rec(kristin);
      c.ok("Kristin (address on file) on Sep 8 → CANDIDATE, not filed: it would plan September, a month already over", xk?.matchState === "CANDIDATE" && !xk.monthId && !xk.clientId && /already over/.test(JSON.parse(xk.rawJson ?? "{}").identity?.candidates?.[0]?.reason ?? ""), `${xk?.matchState} ${xk?.matchNote}`);
      c.ok("…no September month was created for her", (await prisma.contentMonth.count({ where: { enrollmentId: Kr.enrollmentId, monthKey: "2026-09" } })) === 0);
      c.ok("no review task for any candidate (the page is the review)", (await reviewTasks()) === tasksBefore, `${tasksBefore} → ${await reviewTasks()}`);
      c.ok("no alias proposal from a candidate", (await prisma.clientEmailAlias.count()) === aliasesBefore);
      c.ok("outside the window: nothing recorded (30 back, 14 ahead)", !(await rec(tooOld)) && !(await rec(tooFar)));
      c.ok("the discovery booking is still discovery", (await rec(disc))?.callType === "BRAND_DISCOVERY");
      const om = await monthOf(Jo.monthId);
      c.ok("Joe's month untouched by the candidate", !om?.callRecordId && om?.strategyCallStatus === "COMPLETED" && !om.planningMode);
      const n = await prisma.programCallRecord.count();
      const again = await ccr.syncCallRecordsFromCalendly({ now: now(), lookBackDays: 30, lookAheadDays: 14 });
      c.ok("a second pass: no new rows, same states", !("skipped" in again) && again.created === 0 && (await prisma.programCallRecord.count()) === n && (await rec(lauren))?.matchState === "CANDIDATE" && (await rec(john))?.matchState === "MATCHED");
    }

    // =========================================================================
    c.head("3 · The desk (what /content/calls reads)");
    {
      const d = await desk.strategyCallDesk({ now: now() });
      const byUri = async (ev: { event: { uri: string } }) => { const x = await rec(ev); return d.rows.find((r) => r.id === x?.id) ?? null; };
      const rJoe = await byUri(joe), rJohn = await byUri(john), rLauren = await byUri(lauren), rMike = await byUri(mike), rDisc = await byUri(disc), rOld = await byUri(johnOld), rAr = await byUri(arielle);
      c.ok("the generic type is mapped (no banner)", d.candidateMapped);
      c.ok("discovery calls are not listed", rDisc === null);
      c.ok("Joe: OPEN, completed, '30 Minute Strategy Call', default month OCTOBER (Sep 24 = last 10 days)", rJoe?.state === "OPEN" && rJoe.status === "completed" && rJoe.eventType === "30 Minute Strategy Call" && rJoe.defaultMonthKey === "2026-10", JSON.stringify(rJoe));
      c.ok("Joe: suggested Joseph Sutow ('Joe' = Joseph, same last name)", rJoe?.suggestion?.clientId === Jo.clientId, JSON.stringify(rJoe?.suggestion));
      c.ok("John: ASSIGNED by email, October, scheduled", rJohn?.state === "ASSIGNED" && rJohn.assignedBy === "auto" && rJohn.month?.key === "2026-10" && rJohn.status === "scheduled" && rJohn.client?.id === J.clientId);
      c.ok("John's cancelled booking reads cancelled", rOld?.status === "cancelled");
      c.ok("Lauren: OPEN, no suggestion (nobody enrolled by that name or address)", rLauren?.state === "OPEN" && rLauren.suggestion === null && rLauren.defaultMonthKey === "2026-10");
      const rKr = await byUri(kristin);
      c.ok("Kristin: OPEN, suggested by the address on file, default SEPTEMBER", rKr?.state === "OPEN" && rKr.suggestion?.clientId === Kr.clientId && rKr.suggestion.reason === "same email as on file" && rKr.defaultMonthKey === "2026-09", JSON.stringify(rKr?.suggestion));
      c.ok("Mike: no suggestion — a shared company domain is not a person", rMike?.suggestion === null, JSON.stringify(rMike?.suggestion));
      c.ok("Arielle (dedicated type, unmatched): suggested by full name, default SEPTEMBER (Sep 11)", rAr?.suggestion?.clientId === Ar.clientId && rAr.defaultMonthKey === "2026-09" && rAr.eventType === "Content Program - Strategy Call", JSON.stringify({ s: rAr?.suggestion, k: rAr?.defaultMonthKey }));
      c.ok("month options: one before → two after the call's month", JSON.stringify(rJoe?.monthOptions) === JSON.stringify(["2026-08", "2026-09", "2026-10", "2026-11"]), JSON.stringify(rJoe?.monthOptions));
      // The page's rows as staff see them (server-rendered client component).
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { createElement } = await import("react");
      const { StrategyCallsDesk } = await import("@/components/content/StrategyCallsDesk");
      const html = renderToStaticMarkup(createElement(StrategyCallsDesk, { data: JSON.parse(JSON.stringify(d)) }));
      const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
      c.ok("the page: Joe's row offers \"Assign to Joseph Sutow · October\" with the suggestion shown", text.includes("Assign to Joseph Sutow · October") && text.includes("Suggested: Joseph Sutow"), text.slice(0, 400));
      c.ok("the page: John's row reads \"John Collins · October 2026 (matched by email)\", times in ET", text.includes("John Collins · October 2026") && text.includes("matched by email") && text.includes("Tue, Oct 6, 4:00 PM ET"), text.slice(0, 600));
      c.ok("the page: two groups, cancelled hidden by default", text.includes("Coming up · next 14 days") && text.includes("Past 30 days") && !text.includes("Cancelled"));
      c.ok("the client picker lists ACTIVE enrollments only (no ended program)", d.clients.some((x) => x.id === Jo.clientId) && !d.clients.some((x) => x.id === ended.id));
      // The month rule, pure — ET days.
      const k = desk.suggestedPlanMonthKey;
      const cases: [Date, string][] = [
        [edt(9, 24, 10), "2026-10"], [edt(9, 21, 10), "2026-10"], [edt(9, 20, 10), "2026-09"], [edt(10, 6, 16), "2026-10"],
        [edt(10, 21, 10), "2026-10"], [edt(10, 22, 10), "2026-11"], [new RealDate("2026-10-01T03:00:00Z"), "2026-10"], [new RealDate("2026-12-25T15:00:00Z"), "2027-01"],
      ];
      const bad = cases.filter(([d0, want]) => k(d0) !== want).map(([d0, want]) => `${d0.toISOString()}→${k(d0)}≠${want}`);
      c.ok("month default: last 10 days of the ET month plan the next (Sep 21+, Oct 22+; 11 PM ET Sep 30 is Sep → Oct; Dec 25 → Jan)", bad.length === 0, bad.join(", "));
      const s = desk.suggestClient;
      const pool = [{ clientId: "joe", name: "Joseph Sutow", emails: ["jcsutow@gmail.com", "jsutow@garymercerteam.com"] }, { clientId: "kc", name: "Kristin Ciarmella", emails: ["klciarmella@gmail.com"] }];
      c.ok("suggest: an address on file wins", s({ name: "Someone Else", email: "JSUTOW@garymercerteam.com" }, pool)?.clientId === "joe");
      c.ok("suggest: Mike Flatley @garymercerteam.com is NOT Joe", s({ name: "Mike Flatley", email: "mike@garymercerteam.com" }, pool) === null);
      c.ok("suggest: a first name alone is not a match ('Kristin Pavillard')", s({ name: "Kristin Pavillard", email: "k@foxroach.com" }, pool) === null);
      c.ok("suggest: middle initials ignored ('Kristin L. Ciarmella')", s({ name: "Kristin L. Ciarmella", email: "x@y.com" }, pool)?.clientId === "kc");
    }

    // =========================================================================
    c.head("4 · Assign Joe's Sep 24 call to October");
    const joeRec = (await rec(joe))!;
    const selsBefore = await prisma.contentTopicSelection.findMany({ where: { monthId: Jo.monthId }, select: { id: true, status: true, topicId: true }, orderBy: { id: "asc" } });
    const apptsBefore = await prisma.appointment.findMany({ where: { projectId: Jo.projectId! }, select: { id: true, startAt: true, status: true } });
    {
      await signIn(owner);
      const r = await A.assignStrategyCallAction(joeRec.id, Jo.clientId, "2026-10");
      c.ok("assigned", r.ok && r.monthStatus === "COMPLETED", JSON.stringify(r));
      const x = await prisma.programCallRecord.findUnique({ where: { id: joeRec.id } });
      c.ok("record: Joe, his ACTIVE enrollment, MONTHLY_STRATEGY, CONFIRMED_BY_STAFF by jordan@, now", x?.clientId === Jo.clientId && x.enrollmentId === Jo.enrollmentId && x.callType === "MONTHLY_STRATEGY" && x.matchState === "CONFIRMED_BY_STAFF" && x.confirmedBy === "jordan@calls.test" && !!x.confirmedAt);
      c.ok("record: monthId = October, targetMonthKey 2026-10, rule 'staff'", x?.monthId === Jo.monthId && x.targetMonthKey === "2026-10" && JSON.parse(x.rawJson ?? "{}").target?.rule === "staff");
      const m = await monthOf(Jo.monthId);
      c.ok("month: callRecordId → the call", m?.callRecordId === joeRec.id);
      c.ok("month: COMPLETED, strategyCallAt = Sep 24 10:00 AM ET", m?.strategyCallStatus === "COMPLETED" && m.strategyCallAt?.toISOString() === edt(9, 24, 10).toISOString(), JSON.stringify(m));
      c.ok("month: route CALL, chosen by jordan@", m?.planningMode === "CALL" && m.planningChosenBy === "jordan@calls.test");
      const selsAfter = await prisma.contentTopicSelection.findMany({ where: { monthId: Jo.monthId }, select: { id: true, status: true, topicId: true }, orderBy: { id: "asc" } });
      c.ok("topics chosen on the call untouched", JSON.stringify(selsAfter) === JSON.stringify(selsBefore));
      const apptsAfter = await prisma.appointment.findMany({ where: { projectId: Jo.projectId! }, select: { id: true, startAt: true, status: true } });
      c.ok("the booked shoot untouched", JSON.stringify(apptsAfter) === JSON.stringify(apptsBefore));
      // The hourly sync after a staff decision: kept, never re-ruled.
      await ccr.syncCallRecordsFromCalendly({ now: now(), lookBackDays: 30, lookAheadDays: 14 });
      const y = await prisma.programCallRecord.findUnique({ where: { id: joeRec.id } });
      c.ok("next sync keeps it: CONFIRMED_BY_STAFF, October, MONTHLY_STRATEGY", y?.matchState === "CONFIRMED_BY_STAFF" && y.monthId === Jo.monthId && y.callType === "MONTHLY_STRATEGY");
      // Assign again to the same place: idempotent, keeps the original snapshot.
      const r2 = await A.assignStrategyCallAction(joeRec.id, Jo.clientId, "2026-10");
      c.ok("assigning again is harmless", r2.ok && (await monthOf(Jo.monthId))?.callRecordId === joeRec.id);
      await clearSession();
    }

    // =========================================================================
    c.head("5 · Unassign puts Joe's month back exactly — and the sync leaves it");
    {
      await signIn(admin);
      const r = await A.unassignStrategyCallAction(joeRec.id);
      c.ok("unassigned (an ADMIN may)", r.ok, r.message);
      const m = await monthOf(Jo.monthId);
      c.ok("month: COMPLETED stamp with no time, no route, no call record — as before", m?.strategyCallStatus === joeBefore?.strategyCallStatus && !m?.strategyCallAt && !m?.planningMode && !m?.planningChosenAt && !m?.callRecordId, JSON.stringify(m));
      const x = await prisma.programCallRecord.findUnique({ where: { id: joeRec.id } });
      c.ok("record: CANDIDATE, UNCLASSIFIED, no client/month", x?.matchState === "CANDIDATE" && x.callType === "UNCLASSIFIED" && !x.clientId && !x.monthId && !x.targetMonthKey);
      // Now Joe's address IS on file — the sweep would match it. A person said no.
      await prisma.client.update({ where: { id: Jo.clientId }, data: { backupEmail: "jsutow@garymercerteam.com" } });
      await ccr.syncCallRecordsFromCalendly({ now: now(), lookBackDays: 30, lookAheadDays: 14 });
      const y = await prisma.programCallRecord.findUnique({ where: { id: joeRec.id } });
      c.ok("the next sync does NOT re-file an unassigned call by email", y?.matchState === "CANDIDATE" && !y.monthId && !(await monthOf(Jo.monthId))?.callRecordId);
      const again = await A.assignStrategyCallAction(joeRec.id, Jo.clientId, "2026-10");
      c.ok("assign again → back on October, COMPLETED, CALL", again.ok && (await monthOf(Jo.monthId))?.planningMode === "CALL" && (await monthOf(Jo.monthId))?.strategyCallStatus === "COMPLETED");
      await clearSession();
    }

    // =========================================================================
    c.head("6 · John: the call today puts October on the call route");
    const johnRec = (await rec(john))!;
    const jSels = await prisma.contentTopicSelection.findMany({ where: { monthId: J.monthId }, select: { id: true, status: true }, orderBy: { id: "asc" } });
    {
      await signIn(owner);
      const r = await A.assignStrategyCallAction(johnRec.id, J.clientId, "2026-10");
      c.ok("assigned", r.ok && r.monthStatus === "SCHEDULED", JSON.stringify(r));
      const m = await monthOf(J.monthId);
      c.ok("month: SCHEDULED at 4:00 PM ET today, route CALL, call record linked", m?.strategyCallStatus === "SCHEDULED" && m.strategyCallAt?.toISOString() === edt(10, 6, 16).toISOString() && m.planningMode === "CALL" && m.callRecordId === johnRec.id, JSON.stringify(m));
      c.ok("John's chosen topics untouched", JSON.stringify(await prisma.contentTopicSelection.findMany({ where: { monthId: J.monthId }, select: { id: true, status: true }, orderBy: { id: "asc" } })) === JSON.stringify(jSels));
      const x = await prisma.programCallRecord.findUnique({ where: { id: johnRec.id } });
      c.ok("record: CONFIRMED_BY_STAFF (was MATCHED by email)", x?.matchState === "CONFIRMED_BY_STAFF" && x.confirmedBy === "jordan@calls.test");
      // Unassign → back to the written route exactly.
      await A.unassignStrategyCallAction(johnRec.id);
      const back = await monthOf(J.monthId);
      c.ok("unassign → WRITTEN / SKIPPED, chosen by the original chooser, no call", back?.planningMode === "WRITTEN" && back.strategyCallStatus === "SKIPPED" && back.planningChosenBy === "staff:drill" && !back.callRecordId && !back.strategyCallAt, JSON.stringify(back));
      await A.assignStrategyCallAction(johnRec.id, J.clientId, "2026-10");
      c.ok("re-assigned → CALL / SCHEDULED", (await monthOf(J.monthId))?.planningMode === "CALL" && (await monthOf(J.monthId))?.strategyCallStatus === "SCHEDULED");
      await clearSession();
    }

    // =========================================================================
    c.head("7 · Not a program call / Restore");
    {
      await signIn(owner);
      const lr = (await rec(lauren))!;
      const r = await A.ignoreStrategyCallAction(lr.id);
      const x = await prisma.programCallRecord.findUnique({ where: { id: lr.id } });
      c.ok("Lauren → IGNORED / UNRELATED, nobody's", r.ok && x?.matchState === "IGNORED" && x.callType === "UNRELATED" && !x.clientId && !x.monthId);
      await ccr.syncCallRecordsFromCalendly({ now: now(), lookBackDays: 30, lookAheadDays: 14 });
      c.ok("the next sync keeps it ignored", (await prisma.programCallRecord.findUnique({ where: { id: lr.id } }))?.matchState === "IGNORED");
      const d = await desk.strategyCallDesk({ now: now() });
      c.ok("the desk shows it as set aside", d.rows.find((y) => y.id === lr.id)?.state === "IGNORED");
      await A.unassignStrategyCallAction(lr.id);
      c.ok("Restore → CANDIDATE again", (await prisma.programCallRecord.findUnique({ where: { id: lr.id } }))?.matchState === "CANDIDATE");
      // A WRONG assignment, then "Not a program call": that month gets its state back.
      const wrong = await A.assignStrategyCallAction(lr.id, Ar.clientId, "2026-10");
      c.ok("(wrongly) assigned Lauren's call to Arielle's October", wrong.ok && (await monthOf(Ar.monthId))?.callRecordId === lr.id);
      await A.ignoreStrategyCallAction(lr.id);
      const am = await monthOf(Ar.monthId);
      c.ok("ignored → Arielle's October exactly as before", am?.strategyCallStatus === arBefore?.strategyCallStatus && !am?.callRecordId && (am?.planningMode ?? null) === (arBefore?.planningMode ?? null) && !am?.strategyCallAt, JSON.stringify({ am, arBefore }));
      await clearSession();
    }

    // =========================================================================
    c.head("8 · Refusals");
    {
      await signIn(owner);
      const old = (await rec(johnOld))!;
      const a = await A.assignStrategyCallAction(old.id, J.clientId, "2026-10");
      c.ok("a cancelled booking cannot be assigned", !a.ok && /cancelled or moved/.test(a.message), a.message);
      const dr = (await rec(disc))!;
      const b = await A.assignStrategyCallAction(dr.id, J.clientId, "2026-10");
      c.ok("a discovery call cannot be assigned to a month", !b.ok && /brand discovery/.test(b.message));
      const sr = (await rec(susan))!;
      const e = await A.assignStrategyCallAction(sr.id, ended.id, "2026-10");
      c.ok("a client with no ACTIVE program is refused", !e.ok && /no active content program/.test(e.message));
      const f = await A.assignStrategyCallAction(sr.id, J.clientId, "2026-13");
      c.ok("a bad month is refused", !f.ok && /Pick a month/.test(f.message));
      const g = await A.assignStrategyCallAction(sr.id, "", "2026-10");
      c.ok("no client is refused", !g.ok);
      c.ok("…and none of these touched the record", (await prisma.programCallRecord.findUnique({ where: { id: sr.id } }))?.matchState === "CANDIDATE");
      await clearSession();
    }

    // =========================================================================
    c.head("9 · Auth");
    {
      const lr = (await rec(lauren))!;
      const snap = async () => JSON.stringify(await prisma.programCallRecord.findUnique({ where: { id: lr.id }, select: { matchState: true, monthId: true, clientId: true } }));
      const before = await snap();
      await clearSession();
      const out = await A.assignStrategyCallAction(lr.id, J.clientId, "2026-10");
      c.ok("signed out → refused", !out.ok && /sign in/i.test(out.message), out.message);
      for (const u of [editor, shooter]) {
        await signIn(u);
        const r1 = await A.assignStrategyCallAction(lr.id, J.clientId, "2026-10");
        const r2 = await A.ignoreStrategyCallAction(lr.id);
        const r3 = await A.refreshStrategyCallsAction();
        c.ok(`${u.role} → assign, ignore and re-read all refused`, !r1.ok && !r2.ok && !r3.ok, `${r1.message} | ${r3.message}`);
        let redirected: string | null = null;
        try { await page(); } catch (e) { redirected = e instanceof Redirect ? e.href : String(e); }
        c.ok(`${u.role} → the page redirects away`, !!redirected && !redirected.includes("/content/calls"), String(redirected));
      }
      await signIn(owner, admin.id);
      const viewAs = await A.unassignStrategyCallAction(lr.id);
      c.ok("owner previewing another user ('view as') → refused", !viewAs.ok && /previewing/.test(viewAs.message), viewAs.message);
      c.ok("…nothing was written by any refused call", (await snap()) === before);
      await signIn(admin);
      let el: unknown = null;
      try { el = await page(); } catch (e) { el = e; }
      c.ok("ADMIN → the page renders", !!el && !(el instanceof Error), String(el instanceof Error ? el.message : "ok"));
      const rr = await A.refreshStrategyCallsAction();
      c.ok("ADMIN → Re-read Calendly runs the backfill (no new rows)", rr.ok && /0 new/.test(rr.message), rr.message);
      await clearSession();
    }

    // =========================================================================
    c.head("10 · What the portal reads for both months");
    {
      const pj = await portalPlanning({ id: J.enrollmentId, clientId: J.clientId }, J.monthId);
      c.ok("John (before the call): call SCHEDULED at 4 PM ET, route CALL, call time on the card", pj?.callStatus === "SCHEDULED" && pj.planningMode === "CALL" && pj.callAtISO === edt(10, 6, 16).toISOString(), JSON.stringify({ s: pj?.callStatus, m: pj?.planningMode, at: pj?.callAtISO, undo: pj?.undoBlocked, step: pj?.planning?.headline }));
      const po = await portalPlanning({ id: Jo.enrollmentId, clientId: Jo.clientId }, Jo.monthId);
      c.ok("Joe: call COMPLETED (Sep 24), route CALL, undo refused because the call was held", po?.callStatus === "COMPLETED" && po.planningMode === "CALL" && /already happened/.test(po.undoBlocked ?? ""), JSON.stringify({ s: po?.callStatus, m: po?.planningMode, at: po?.callAtISO, undo: po?.undoBlocked, filming: po?.filmingBooked, head: po?.planning?.headline }));
      console.log(`   John headline: ${JSON.stringify(pj?.planning?.headline)} · Joe headline: ${JSON.stringify(po?.planning?.headline)}`);
      // After John's call ends: held.
      setClock(edt(10, 6, 16, 45));
      await recalcProgramMonth(J.monthId);
      c.ok("after 4:30 PM ET John's October reads COMPLETED", (await monthOf(J.monthId))?.strategyCallStatus === "COMPLETED");
      await ccr.syncCallRecordsFromCalendly({ now: now(), lookBackDays: 30, lookAheadDays: 14 });
      const x = await prisma.programCallRecord.findUnique({ where: { id: johnRec.id } });
      c.ok("…and the sync marks the record COMPLETED, still John's October", x?.status === "COMPLETED" && x.monthId === J.monthId && x.matchState === "CONFIRMED_BY_STAFF");
    }

    // =========================================================================
    c.head("11 · Nothing messaged, nothing written to Calendly, nothing left the box");
    {
      c.ok("Calendly: no booking and no cancellation was ever POSTed", fake.state.posts === 0 && fake.state.cancels === 0, `${fake.state.posts}/${fake.state.cancels}`);
      c.ok("no non-loopback call escaped the fence", fence.blocked.length === 0, fence.blocked.join(", "));
      const msgs = await prisma.programMessage.count().catch(() => 0);
      c.ok("no program message was written", msgs === 0, String(msgs));
      c.ok("no review task was created for any candidate during the whole run", (await reviewTasks()) === tasksBefore);
    }
  } finally {
    c.summary();
    quiet.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
