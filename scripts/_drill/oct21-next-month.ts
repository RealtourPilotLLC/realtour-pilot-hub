// ---------------------------------------------------------------------------
// DRILL: next month opens early, so clients can get ahead (Oct 21 2026).
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct21-next-month.ts
//
// Jordan, Oct 21: "Can we allow people to prep for content for the next month
// too? Like, it shows October, but I'd like it to show November too, so
// people can schedule the next month ahead of time."
//
//   §1 creation: ensureNextMonths makes November for every ACTIVE, non-bulk
//      enrollment (the same defaults; a package change scheduled for Nov 1 is
//      counted), skips bulk and paused programs, and a second run makes
//      nothing. The opening rule is one constant (ALWAYS by default); a
//      "7 days before" rule would make nothing on Oct 21.
//   §2 the portal shows both months: Your Month offers "October" and
//      "November · getting ahead"; November's page says so; an old ?month=
//      link still works; Home stays about October and points at November
//      only once October's steps are done.
//   §3 booking: a November date lands on NOVEMBER and uses November's own
//      allowance (October's is untouched); November never starts before its
//      first weekday; an October session can't take a November date (nor a
//      move); the slots each month offers are its own dates; weekends and
//      the 24-hour line still hold; a planned client's November stays gated
//      on November's own plan.
//   §4 no early nagging: no reminder lane (dry run and live) touches
//      November before its 1st, and November is evaluated once it starts; it
//      is never forfeited before it ends; the dashboard card stays quiet for
//      an untouched November and shows one the client started; the sessions
//      ledger doesn't count it as owed; October can't be "caught up" while it
//      runs; the roster's last month stays October.
//   §5 script flows: a topic chosen for November, its questions and its
//      script work all sit on November, not October.
//   §6 a self-planned client's late session is not locked behind scripts we
//      never write (lateGateLock), and the card says so.
//   §7 nothing left the machine; nothing about November was sent.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness). Production is never opened;
// every non-loopback call is fenced; Aryeo's availability is a seeded cache row.
// THE CLOCK IS PINNED to Wed Oct 21 2026 10:00 ET.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5761);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 21, 14, 0, 0); // Wed Oct 21 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
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
const now = () => new RealDate(RealDate.now() + offset);
/** An ET wall-clock time in late 2026: EDT through Nov 1, EST after. */
const et = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + (month > 11 || (month === 11 && day >= 2) ? 5 : 4), minute));
const etMonth = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7);

// ---- Aryeo's availability, answered from the slot cache ----------------------
// Every weekday from Oct 22 to Nov 20, 10:00 and 14:00 ET, one creative (the
// rows programSlotDays reads before it would ever ask Aryeo).
const SLOT_DAYS = (() => {
  const out: { date: string; slots: string[] }[] = [];
  for (let t = RealDate.UTC(2026, 9, 22, 12); t <= RealDate.UTC(2026, 10, 20, 12); t += 86_400_000) {
    const d = new RealDate(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const m = d.getUTCMonth() + 1, day = d.getUTCDate();
    out.push({ date: d.toISOString().slice(0, 10), slots: [et(m, day, 10).toISOString(), et(m, day, 14).toISOString()] });
  }
  return out;
})();
installNextStubs();
const fence = fenceFetch();

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct21-next-month" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const cp = await import("@/lib/contentProgram");
    const pm = await import("@/lib/programMonths");
    const portal = await import("@/lib/portal");
    const portalActions = await import("@/app/portal/actions");
    const { yourMonthTabs, aheadLine } = await import("@/lib/yourMonth");
    const { homeActions } = await import("@/lib/portalHome");
    const { INSIDE_24H_MESSAGE } = await import("@/lib/sessionBooking");
    const { sessionCapacity } = await import("@/lib/sessionRequests");
    const { sessionSlotsFor } = await import("@/lib/sessionTravel");
    const { recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
    const R = await import("@/lib/programReminders");
    const forfeit = await import("@/lib/forfeit");
    const { forfeitedMonths, isMonthForfeited } = await import("@/lib/monthForfeit");
    const { monthlyContentActions } = await import("@/lib/contentActions");
    const { monthProgress } = await import("@/lib/monthProgress");
    const { entitlementSummary } = await import("@/lib/entitlements");
    const { catchUpPanel } = await import("@/lib/monthCatchUp");
    const { scriptWorkForMonth } = await import("@/lib/contentDrafting");
    const ls = await import("@/lib/monthLateSession");

    // Client components render for real (renderToStaticMarkup); the router is a no-op.
    const load = createRequire(__filename);
    for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
      navigation.useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} });
      navigation.usePathname = () => "/portal/x";
      navigation.useSearchParams = () => new URLSearchParams();
    }
    const { YourMonth } = await import("@/components/portal/YourMonth");
    const { PortalPage } = await import("@/components/portal/PortalPage");
    const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
    const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const viewerOf = async (token: string | null) => { const r = await portal.resolvePortalViewer({ token: token ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; };
    const setSwitch = (key: string, enabled: boolean, config: Record<string, unknown> | null = null) => {
      const configJson = config ? JSON.stringify(config) : null;
      return prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new RealDate(PINNED - 10 * 86_400_000), configJson }, update: { enabled, configJson } });
    };
    const nov = (enrollmentId: string) => prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId, monthKey: "2026-11" } } });
    const mapped = (f: { enrollmentId: string; clientId: string }, monthId: string) => prisma.programSessionPlan.create({
      data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId, sessionIndex: 1, streetNumber: "117", streetName: "Main St", city: "Doylestown", stateCode: "PA", postalCode: "18901", latitude: 40.31, longitude: -75.13, geocodeSource: "drill", addressValidatedAt: now(), addressVersion: 1 },
    });
    const outboxAtStart = await prisma.outboxMessage.count();

    // ---- the clients (all TEST) -------------------------------------------------
    // Nina: Accelerator, we plan her content, no strategy calls in her program.
    const N = await buildContentMonth(prisma, { name: "Nina Ahead TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    await prisma.contentEnrollment.update({ where: { id: N.enrollmentId }, data: { callMode: "NOT_INCLUDED", strategyCallRequired: false } });
    // Sam: Starter, plans his own videos ("we show up and shoot").
    const S = await buildContentMonth(prisma, { name: "Sam Self TEST", package: "Starter", monthKey: "2026-10", project: false });
    await prisma.contentEnrollment.update({ where: { id: S.enrollmentId }, data: { clientSuppliesTopics: true } });
    // Tess: Starter, we plan hers (the planned twin for §6).
    const T = await buildContentMonth(prisma, { name: "Tess Planned TEST", package: "Starter", monthKey: "2026-10", project: false });
    // Xavier: Accelerator, raised to 6 videos from November (scheduled, not applied yet).
    const X = await buildContentMonth(prisma, { name: "Xavier Raise TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    await recordEnrollmentChange({ enrollmentId: X.enrollmentId, clientId: X.clientId, field: "videosPerMonth", from: X.videosPerMonth, to: 6, effectiveAt: et(11, 1, 0), effectiveMonthKey: "2026-11", changedBy: "drill", source: "manual" });
    // Bob: a bulk plan (no calendar months). Pat: paused.
    const B = await buildContentMonth(prisma, { name: "Bob Bulk TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { programKind: "BULK" } });
    const P = await buildContentMonth(prisma, { name: "Pat Paused TEST", package: "Starter", monthKey: "2026-10", project: false, enrollmentStatus: "PAUSED" });
    for (const f of [N, S, T, X]) await pm.recalcProgramMonth(f.monthId, { now: now() });

    // =======================================================================
    c.head("§1 · November is made early: every active, non-bulk program, once");
    // =======================================================================
    c.ok("the opening rule is ONE constant, ALWAYS by default (null)", cp.NEXT_MONTH_OPENS_DAYS_BEFORE === null && cp.nextMonthOpen(now()) && cp.portalLastMonthKey(now()) === "2026-11");
    c.ok("…a '7 days before' rule would keep November closed on Oct 21 and open it on Oct 25", !cp.nextMonthOpen(now(), 7) && cp.nextMonthOpen(et(10, 25, 9), 7) && cp.nextMonthKeyOf("2026-12") === "2027-01");
    const closed = await cp.ensureNextMonths({ now: now(), daysBefore: 7 });
    c.ok("…and under it, ensureNextMonths makes nothing yet", closed.created === 0 && closed.monthKey === null && (await prisma.contentMonth.count({ where: { monthKey: "2026-11" } })) === 0, JSON.stringify(closed));
    const first = await cp.ensureNextMonths({ now: now() });
    const [nN, nS, nT, nX, nB, nP] = await Promise.all([N, S, T, X, B, P].map((f) => nov(f.enrollmentId)));
    c.ok("ensureNextMonths makes November for Nina, Sam, Tess and Xavier", first.created === 4 && first.monthKey === "2026-11" && !!nN && !!nS && !!nT && !!nX, JSON.stringify(first));
    c.ok("…and none for the bulk plan or the paused program", !nB && !nP);
    c.ok("…with the same defaults as this month: OPEN, live, the package's videos, the call status", !!nN && nN.status === "OPEN" && !nN.historical && nN.videosOwed === N.videosPerMonth && nN.strategyCallStatus === "NOT_REQUIRED" && nT?.strategyCallStatus === ((await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: T.enrollmentId } })).strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED"), JSON.stringify({ status: nN?.status, owed: nN?.videosOwed, call: nN?.strategyCallStatus }));
    const xOct = await prisma.contentMonth.findUniqueOrThrow({ where: { id: X.monthId } });
    c.ok("a raise scheduled for Nov 1 is counted in November (6) while October keeps its 4", nX?.videosOwed === 6 && xOct.videosOwed === X.videosPerMonth, `${nX?.videosOwed} / ${xOct.videosOwed}`);
    const again = await cp.ensureNextMonths({ now: now() });
    c.ok("a second run makes nothing (idempotent), and November stays one row each", again.created === 0 && (await prisma.contentMonth.count({ where: { monthKey: "2026-11" } })) === 4, JSON.stringify(again));
    c.ok("the hourly sweep and a new signup both run it (beside ensureCurrentMonths)", /const next = await ensureNextMonths\(\);/.test(src("src/lib/contentProgram.ts")) && /await ensureNextMonths\(\)\.catch/.test(src("src/lib/stripeSignups.ts")));

    // =======================================================================
    c.head("§2 · the portal shows October and November, clearly labelled");
    // =======================================================================
    const vN = await viewerOf(N.portalToken);
    const topicsN = await portal.portalTopics(vN.enrollment);
    const schedN = await portal.portalScheduleMonths(vN.enrollment);
    c.ok("Nina's open months: October, then November", topicsN.months.map((m) => m.monthKey).join(",") === "2026-10,2026-11" && schedN.map((m) => m.monthKey).join(",") === "2026-10,2026-11", topicsN.months.map((m) => m.monthKey).join(","));
    const tabs = yourMonthTabs(topicsN.months, N.monthId, "2026-10");
    c.ok("the switch: 'October' first, then 'November · getting ahead'", tabs.map((t) => `${t.label}${t.active ? "*" : ""}`).join(" | ") === "October* | November · getting ahead" && tabs[1].ahead && !tabs[0].ahead, tabs.map((t) => t.label).join(" | "));
    c.ok("…and the ahead line has no em dash", !aheadLine("2026-11").includes("—") && /getting ahead on November/.test(aheadLine("2026-11")) && /Add your plan/.test(aheadLine("2026-11", true)));
    const defPlanning = await portal.portalPlanning(vN.enrollment);
    const novPlanning = await portal.portalPlanning(vN.enrollment, nN!.id);
    c.ok("Your Month opens on October; November is one tap away", defPlanning?.monthKey === "2026-10" && novPlanning?.monthKey === "2026-11");
    const ymNov = text(html(createElement(YourMonth, { d: {
      topics: topicsN, planning: novPlanning, planningFailed: false, schedule: schedN.find((m) => m.monthId === nN!.id) ?? null, scheduleFailed: false, slotDays: [], bookingUrl: "https://calendly.invalid",
      can: { suggest: true, session: true }, readOnly: false, hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts" }, months: schedN,
    } })));
    c.ok("Your Month on November: both tabs, 'getting ahead', and nothing due before November", ymNov.includes("October") && ymNov.includes("November · getting ahead") && ymNov.includes("November 2026 · getting ahead") && ymNov.includes("Nothing for November is due before November 1."), ymNov.slice(0, 300));
    const pagePlan = html(await PortalPage({ viewer: vN, path: "/portal/x", query: { tab: "plan" } }));
    c.ok("the real page (Your Month): October's plan, with a link to November", text(pagePlan).includes("October 2026") && text(pagePlan).includes("November · getting ahead") && pagePlan.includes("month=2026-11"), text(pagePlan).slice(0, 300));
    const pageNov = text(html(await PortalPage({ viewer: vN, path: "/portal/x", query: { tab: "plan", month: "2026-11" } })));
    c.ok("?month=2026-11 opens November, labelled as getting ahead", pageNov.includes("November 2026 · getting ahead") && pageNov.includes("You're getting ahead on November.") && !pageNov.includes("That planning month is not available here"), pageNov.slice(0, 300));
    const pageOct = text(html(await PortalPage({ viewer: vN, path: "/portal/x", query: { tab: "plan", month: "2026-10" } })));
    c.ok("an old ?month=2026-10 link still opens October", pageOct.includes("October 2026") && !pageOct.includes("November 2026 · getting ahead") && !pageOct.includes("That planning month is not available here"));
    const homeNov = text(html(await PortalPage({ viewer: vN, path: "/portal/x", query: { month: "2026-11" } })));
    c.ok("Home stays about October, even with November in the address", homeNov.includes("October 2026") && !homeNov.includes("No topics chosen for November 2026"), homeNov.slice(0, 300));
    const homeBase = {
      status: "ACTIVE", readOnly: false, perms: { session: true, suggest: true, request: true, approve: true, profile: true },
      review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: [], unread: 0,
      planning: { planningMode: "WRITTEN", callStatus: "NOT_REQUIRED", noCallEligible: true },
      month: { monthKey: "2026-10", label: "October 2026", owed: 4, selected: 4 }, toAnswer: [],
      session: { offerBooking: false, required: 1, missing: 0 }, addressNeeded: 0, setup: null, ready: { count: 0, withFile: false, single: null },
      ahead: { label: "November", href: "?tab=plan&month=2026-11" },
    } as Parameters<typeof homeActions>[0];
    const doneOct = homeActions(homeBase);
    const busyOct = homeActions({ ...homeBase, month: { monthKey: "2026-10", label: "October 2026", owed: 4, selected: 1 } });
    const kinds = (r: ReturnType<typeof homeActions>) => [r.primary, ...r.more].filter(Boolean).map((a) => a!.kind);
    c.ok("October done: Home's next step is 'Get ahead on November', to November's page", doneOct.primary?.kind === "GET_AHEAD" && doneOct.primary.title === "Get ahead on November" && doneOct.primary.href === "?tab=plan&month=2026-11" && !`${doneOct.primary.title}${doneOct.primary.detail}`.includes("—"), JSON.stringify(doneOct.primary));
    c.ok("October still has a step: Home asks for October's, and doesn't mention November", busyOct.primary?.kind === "PICK_TOPICS" && !kinds(busyOct).includes("GET_AHEAD"), kinds(busyOct).join(","));

    // =======================================================================
    c.head("§3 · booking November: its own dates, its own allowance, every gate");
    // =======================================================================
    const vS = await viewerOf(S.portalToken);
    const sOctPlan = await mapped(S, S.monthId);
    const sNovPlan = await mapped(S, nS!.id);
    const gOct = await portal.sessionGate(S.enrollmentId, S.monthId, { now: now() });
    const gNov = await portal.sessionGate(S.enrollmentId, nS!.id, { now: now() });
    c.ok("this month's gate is unchanged: open from the 24-hour floor", !gOct.locked && Math.abs(gOct.earliest.getTime() - (now().getTime() + 24 * 3_600_000)) < 60_000, gOct.earliest.toISOString());
    c.ok("November's gate: open (Sam plans his own), from Monday November 2, never earlier", !gNov.locked && gNov.earliest.getTime() === et(11, 2, 0).getTime(), `${gNov.locked} ${gNov.earliest.toISOString()}`);
    const gNina = await portal.sessionGate(N.enrollmentId, nN!.id, { now: now() });
    c.ok("Nina's November is still gated on November's own plan (nothing chosen yet)", gNina.locked, gNina.reason);
    {
      const { PROGRAM_SLOT_HORIZON_DAYS } = await import("@/lib/portalScheduling");
      const { availabilityFromDay } = await import("@/lib/integrations/aryeo");
      const creative = { teamMemberId: "tm-drill-shooter", name: "Drill Shooter" };
      const days = SLOT_DAYS.map((d) => ({ ...d, fitsMinutes: 120, creatives: [creative.name], slotCreatives: Object.fromEntries(d.slots.map((s) => [s, [creative]])) }));
      for (const from of [gOct.earliest, gNov.earliest]) {
        const fromDay = availabilityFromDay(from);
        const key = `portal-aryeo-slots:v4:${cp.ARYEO_CONTENT_PRODUCTS.Starter.productId}:120:${PROGRAM_SLOT_HORIZON_DAYS}${fromDay ? `:from:${fromDay}` : ""}`;
        const value = JSON.stringify({ at: Date.now(), days });
        await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
    }
    const slotsOct = await sessionSlotsFor({ enrollmentId: S.enrollmentId, monthId: S.monthId, sessionIndex: 1, package: "Starter", now: now() });
    const slotsNov = await sessionSlotsFor({ enrollmentId: S.enrollmentId, monthId: nS!.id, sessionIndex: 1, package: "Starter", now: now() });
    const allOct = slotsOct.days.flatMap((d) => d.slots), allNov = slotsNov.days.flatMap((d) => d.slots);
    c.ok("October offers October dates and the first week of November only (Oct 22 2026)", allOct.length > 0 && allOct.every((s) => etMonth(new RealDate(s)) === "2026-10" || (etMonth(new RealDate(s)) === "2026-11" && new RealDate(s).getTime() < et(11, 8, 0).getTime())), `${allOct.length} ${allOct[0]} … ${allOct.at(-1)} ${slotsOct.ok} ${slotsOct.message}`);
    c.ok("November offers only November dates, from Monday November 2", allNov.length > 0 && allNov.every((s) => etMonth(new RealDate(s)) === "2026-11") && allNov[0] === et(11, 2, 10).toISOString(), `${allNov.length} ${allNov[0]} … ${allNov.at(-1)} ${slotsNov.ok} ${slotsNov.message}`);
    const ask = (monthId: string, slot: Date, planId: string) => portalActions.portalRequestSession({ token: S.portalToken }, { monthId, slotISO: slot.toISOString(), planId, addressVersion: 1 });
    const early = await ask(nS!.id, et(10, 27, 10), sNovPlan.id);
    c.ok("an October date for November is refused, as the wrong month", !early.ok && early.message === "October dates are booked under October. Pick a date in November or the first week of December for this session.", early.message);
    const crossed = await ask(S.monthId, et(11, 9, 10), sOctPlan.id);
    c.ok("a November date past the first week is refused for October, in plain words", !crossed.ok && crossed.message === "November dates are booked under November. Pick a date in October or the first week of November for this session.", crossed.message);
    const weekend = await ask(nS!.id, et(11, 7, 10), sNovPlan.id);
    c.ok("weekends still refused in November", !weekend.ok && /Monday through Friday/.test(weekend.message ?? ""), weekend.message);
    const booked = await ask(nS!.id, et(11, 4, 10), sNovPlan.id);
    const novRows = await prisma.programSessionRequest.findMany({ where: { enrollmentId: S.enrollmentId } });
    c.ok("a November date for November is taken, and the request sits on NOVEMBER's month", booked.ok && novRows.length === 1 && novRows[0].monthId === nS!.id && novRows[0].slotStart?.getTime() === et(11, 4, 10).getTime(), `${booked.message} ${novRows.map((r) => r.monthId)}`);
    const second = await ask(nS!.id, et(11, 6, 10), sNovPlan.id);
    c.ok("November's allowance holds: Sam's one November session can't be asked for twice", !second.ok && (await prisma.programSessionRequest.count({ where: { monthId: nS!.id } })) === 1, second.message);
    const [capNov, capOct] = await Promise.all([sessionCapacity(S.enrollmentId, nS!.id, { now: now() }), sessionCapacity(S.enrollmentId, S.monthId, { now: now() })]);
    c.ok("…November is full, October's session is still free", capNov.remaining === 0 && capOct.remaining === 1, `${JSON.stringify(capNov)} ${JSON.stringify(capOct)}`);
    const soon = await ask(S.monthId, new RealDate(now().getTime() + 3 * 3_600_000), sOctPlan.id);
    c.ok("the 24-hour line still holds", !soon.ok && soon.message === INSIDE_24H_MESSAGE, soon.message);
    const octBooked = await ask(S.monthId, et(10, 27, 10), sOctPlan.id);
    const octRow = await prisma.programSessionRequest.findFirst({ where: { enrollmentId: S.enrollmentId, monthId: S.monthId } });
    c.ok("October books on its own (Oct 27), on October's month", octBooked.ok && !!octRow && octRow.slotStart?.getTime() === et(10, 27, 10).getTime(), octBooked.message);
    const moved = await portalActions.portalRescheduleSession({ token: S.portalToken }, octRow!.id, { slotISO: et(11, 10, 10).toISOString() });
    c.ok("moving October's session past the first week of November is refused", !moved.ok && /November dates are booked under November/.test(moved.message ?? ""), moved.message);
    // The rule itself (portal.sessionDateFits), on the edges the portal can't show today.
    const fits = portal.sessionDateFits;
    const octRule = { own: ["2026-10"], elsewhere: ["2026-11"] };
    c.ok("rule: this month keeps its old reach only where the date's month has no open workspace", !fits(octRule, et(11, 9, 10), et(10, 22, 10)) && fits({ ...octRule, elsewhere: [] }, et(11, 9, 10), et(10, 22, 10)));
    c.ok("rule (Oct 22 2026): a month's session may fall in the first 7 days of the next month even when it is open", fits(octRule, et(11, 4, 10), et(10, 22, 10)) && fits(octRule, et(11, 6, 10), et(10, 22, 10)) && !fits(octRule, et(11, 9, 10), et(10, 22, 10)));
    c.ok("rule: a preparation window that already runs past the month's end books on from its earliest start (A18/A20)", fits(octRule, et(11, 11, 10), et(11, 10, 10)) && !fits(octRule, et(11, 9, 10), et(11, 10, 10)));
    c.ok("rule: next month the same way: with December open it keeps to November; with none, its old reach", !fits({ own: ["2026-11"], elsewhere: ["2026-12"] }, et(12, 9, 10), et(11, 2, 0)) && fits({ own: ["2026-11"], elsewhere: [] }, et(12, 9, 10), et(11, 2, 0)) && fits({ own: ["2026-11"], elsewhere: ["2026-12"] }, et(11, 30, 10), et(11, 2, 0)));
    const schedS = await portal.portalScheduleMonths(vS.enrollment);
    const sNovCard = schedS.find((m) => m.monthId === nS!.id);
    c.ok("Your Month's November card: its own session, 'from November 2'", !!sNovCard && sNovCard.capacity.remaining === 0 && sNovCard.requests.length === 1 && sNovCard.earliestISO === et(11, 2, 0).toISOString(), JSON.stringify({ cap: sNovCard?.capacity, earliest: sNovCard?.earliestISO }));

    // =======================================================================
    c.head("§4 · no early nagging: reminders, forfeits, the dashboard, owed counts");
    // =======================================================================
    c.ok("monthStarted: October yes, November not until Nov 1", forfeit.monthStarted("2026-10", now()) && !forfeit.monthStarted("2026-11", now()) && forfeit.monthStarted("2026-11", et(11, 1, 0)));
    const dry = await R.evaluateReminders({ dryRun: true, now: now() });
    const novIds = new Set([nN, nS, nT, nX].map((m) => m!.id));
    const novCands = dry.candidates.filter((x) => novIds.has(x.monthId));
    c.ok("dry run on Oct 21: October is evaluated, November not at all (no planning, booking or review lane)", dry.candidates.some((x) => x.monthKey === "2026-10") && novCands.length === 0, novCands.map((x) => `${x.clientName}:${x.lane}:${x.action}:${x.decision}`).join(" | "));
    c.ok("…no brand-kit reminder rides on November either", !dry.brandKitLane.some((x) => novIds.has(x.monthId)));
    c.ok("…and no session-bound lane fires for November: no booked session is inside its window", !dry.addressLane.some((x) => novIds.has(x.monthId) && x.decision === "send") && !dry.scriptApprovalLane.some((x) => novIds.has(x.monthId) && x.decision === "send"));
    const tasksBefore = await prisma.smartTask.count();
    await setSwitch("reminders", true, { testClientsOnly: false });
    await R.evaluateReminders({ dryRun: false, now: now() });
    await setSwitch("reminders", false, null);
    const novReminders = await prisma.programReminder.count({ where: { monthKey: "2026-11" } });
    const novTasks = await prisma.smartTask.findMany({ where: { createdAt: { gte: new RealDate(PINNED - 60_000) }, OR: [{ title: { contains: "2026-11" } }, { title: { contains: "November" } }, { description: { contains: "2026-11" } }] }, select: { title: true } });
    c.ok("live run on Oct 21: no reminder row, task or escalation for November", novReminders === 0 && novTasks.length === 0, `${novReminders} ${novTasks.map((t) => t.title).join(" | ")} (tasks before ${tasksBefore})`);
    const dryNov = await R.evaluateReminders({ dryRun: true, now: et(11, 2, 10) });
    c.ok("…and on Nov 2 November is a month like any other: evaluated", dryNov.candidates.some((x) => novIds.has(x.monthId)), String(dryNov.candidates.length));
    const novRow = { monthKey: "2026-11", status: "OPEN", historical: false, strategyCallStatus: "NOT_REQUIRED" };
    c.ok("forfeit: November can't be forfeited before it ends", !forfeit.forfeitCandidate(novRow, now()) && !(await isMonthForfeited(nN!.id, { now: now() })) && (await forfeitedMonths([...novIds], { now: now() })).size === 0);
    c.ok("…the rule still applies once it HAS ended untouched (Dec 2)", (await forfeitedMonths([nN!.id], { now: et(12, 2, 10) })).has(nN!.id));
    const nProg = await monthProgress(N.enrollmentId, nN!.id, { now: now() });
    const card1 = await monthlyContentActions({ now: now() });
    c.ok("the dashboard card: no row for Nina's untouched November", !card1.rows.some((r) => r.monthKey === "2026-11" && r.clientName.startsWith("Nina")), `${JSON.stringify(nProg?.nextAction)} | ${card1.rows.map((r) => `${r.clientName} ${r.monthKey}: ${r.items.map((i) => i.words).join(", ")}`).join(" / ")}`);
    const ent = await entitlementSummary(N.enrollmentId, { now: now() });
    const entNov = ent?.sessions?.perMonth.find((m) => m.monthKey === "2026-11");
    c.ok("the sessions ledger: November reads 'next month' and isn't counted as owed", ent?.sessions?.available === 1 && entNov?.state === "next month", JSON.stringify(ent?.sessions));
    const cu = await catchUpPanel(nN!.id, { now: now() });
    const octOption = cu?.options.find((o) => o.monthKey === "2026-10");
    c.ok("November's catch-up panel won't treat a running October as missed", !!octOption && /isn't over yet/.test(octOption.refusal ?? ""), JSON.stringify(octOption));
    const roster = await cp.getProgramRoster({ now: now() });
    c.ok("the roster's 'last month' stays October", roster.find((r) => r.enrollmentId === N.enrollmentId)?.lastMonthKey === "2026-10");
    c.ok("the drafting sweeps read this month first, then next month (40 at most)", (src("src/lib/contentDrafting.ts").match(/await openMonthsCurrentFirst\(live\.map\(\(e\) => e\.id\)\)/g) ?? []).length === 2 && /monthKey: \{ gt: cur \} \}, select, orderBy: \{ monthKey: "asc" \}/.test(src("src/lib/contentDrafting.ts")));
    c.ok("the script-approval desk reads this month first", /monthKey: \{ gte: curKey \} \}, select: \{[^}]*\}, orderBy: \{ monthKey: "asc" \}/.test(src("src/lib/programDeskTasks.ts")));

    // =======================================================================
    c.head("§5 · topics, questions and scripts for November sit on November");
    // =======================================================================
    const idea = await portalActions.portalSuggestTopic({ token: N.portalToken }, { title: "Why November is the best month to list", monthId: nN!.id });
    const sel = idea.id ? await prisma.contentTopicSelection.findMany({ where: { topicId: idea.id } }) : [];
    c.ok("a topic chosen on November's page is November's selection, not October's", idea.ok && idea.selected === true && idea.monthId === nN!.id && sel.length === 1 && sel[0].monthId === nN!.id, `${idea.message} ${sel.map((s) => s.monthId)}`);
    const iv = idea.id ? await portalActions.portalOpenInterview({ token: N.portalToken }, idea.id, nN!.id) : null;
    const ivRow = iv?.id ? await prisma.contentInterview.findUnique({ where: { id: iv.id } }) : null;
    c.ok("its questions open on November", !!iv?.ok && ivRow?.monthId === nN!.id, iv?.message);
    const [workNov, workOct] = await Promise.all([scriptWorkForMonth(nN!.id), scriptWorkForMonth(N.monthId)]);
    c.ok("its script is November's work (the drafting sweep reads it there), not October's", workNov.some((w) => w.topicId === idea.id) && !workOct.some((w) => w.topicId === idea.id), `${workNov.length} / ${workOct.length}`);
    const card2 = await monthlyContentActions({ now: now() });
    const ninaNov = card2.rows.find((r) => r.monthKey === "2026-11" && r.clientName.startsWith("Nina"));
    c.ok("now Nina has started November, the dashboard card shows it", !!ninaNov && ninaNov.items.length > 0, card2.rows.map((r) => `${r.clientName} ${r.monthKey}: ${r.items.map((i) => i.words).join(", ")}`).join(" / "));

    // =======================================================================
    c.head("§6 · a self-planned client's late session isn't locked behind our scripts");
    // =======================================================================
    const sepOf = async (f: typeof S) => prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-09", videosOwed: 2, status: "OPEN", strategyCallStatus: "COMPLETED" } });
    const sSep = await sepOf(S), tSep = await sepOf(T);
    await ls.applyLateSession(S.monthId, sSep.id, "drill", { now: now() });
    await ls.applyLateSession(T.monthId, tSep.id, "drill", { now: now() });
    const asMonth = (m: { id: string; monthKey: string; status: string; historical: boolean }) => ({ id: m.id, monthKey: m.monthKey, status: m.status, historical: m.historical });
    const [lockS, lockT] = await Promise.all([ls.lateGateLock(S.enrollmentId, asMonth(sSep), now()), ls.lateGateLock(T.enrollmentId, asMonth(tSep), now())]);
    c.ok("Sam (plans his own): no lock on his late September session", lockS === null, lockS ?? "");
    c.ok("Tess (we plan): still waits on her September scripts", !!lockT && /script/i.test(lockT), lockT ?? "");
    const [gS, gT] = await Promise.all([portal.sessionGate(S.enrollmentId, sSep.id, { now: now() }), portal.sessionGate(T.enrollmentId, tSep.id, { now: now() })]);
    c.ok("…so Sam's September gate is open and Tess's is shut", !gS.locked && gT.locked, `${gS.reason} | ${gT.reason}`);
    c.ok("Sam's late session films on October dates (its host month)", JSON.stringify((await portal.sessionDateRule(S.enrollmentId, sSep.id, now()))?.own) === '["2026-10"]');
    const lateS = await ls.portalLateSession(vS.enrollment, S.monthId, { now: now() });
    c.ok("the portal's late card knows Sam plans his own (ready to book)", !!lateS && lateS.clientPlanned && lateS.scriptsReady, JSON.stringify({ cp: lateS?.clientPlanned, ready: lateS?.scriptsReady }));
    const planS = await portal.portalPlanning(vS.enrollment, S.monthId);
    const schedS2 = await portal.portalScheduleMonths(vS.enrollment);
    const ymS = text(html(createElement(YourMonth, { d: {
      topics: await portal.portalTopics(vS.enrollment), planning: planS, planningFailed: false, schedule: schedS2.find((m) => m.monthId === S.monthId) ?? null, scheduleFailed: false, slotDays: [], bookingUrl: "https://calendly.invalid",
      can: { suggest: true, session: true }, readOnly: false, hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts" }, months: schedS2,
      late: { schedule: schedS2.find((m) => m.monthId === sSep.id) ?? null, scripts: [] }, selectedScheduleMonthId: null,
    } })));
    c.ok("Your Month's late card says so: 'You plan these videos yourself, so you can book that session now.'", ymS.includes("You plan these videos yourself, so you can book that session now.") && !ymS.includes("That session opens as soon as your September scripts are ready."), ymS.slice(0, 400));

    // =======================================================================
    c.head("§7 · nothing left the machine; nothing about November was sent");
    // =======================================================================
    const novMail = await prisma.outboxMessage.findMany({ where: { createdAt: { gte: new RealDate(PINNED - 60_000) } }, select: { body: true, dedupeKey: true } });
    c.ok("no message mentions November", !novMail.some((m) => /November|2026-11/.test(`${m.body ?? ""}${m.dedupeKey ?? ""}`)), `${novMail.length} message(s) since start (${outboxAtStart} before)`);
    c.ok("no request left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
    console.log(await drill.evidence());
  } finally {
    quiet.restore();
    c.summary();
    try { await drill.stop(); } finally { fence.restore(); }
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
