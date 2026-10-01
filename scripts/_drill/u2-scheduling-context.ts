// C08 / UX15: signed client context, Pro addresses and all returned date pages.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Real readers/actions + a cached fixture calendar and fake geocoder. No
// booking request, provider booking, invitation or client message is sent.
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { currentSessionSlot, portalMonthHref, portalMonthKey, portalSessionIndex, selectedPortalMonth, sessionDatePage, sessionOfferKey } from "../../src/lib/portalScheduling";

const RealDate = Date;
const NOW = RealDate.UTC(2026, 9, 1, 14);
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) { return args.length ? Reflect.construct(target, args) : new target(NOW); },
  get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
}) as DateConstructor;
installNextStubs();
let cookie: string | null = null;
interceptModule((request) => request === "@/lib/portal" || /[\\/]src[\\/]lib[\\/]portal$/.test(request), (loaded) => {
  const portalModule = loaded as typeof import("@/lib/portal");
  return { ...portalModule, resolvePortalViewer: (input: Parameters<typeof portalModule.resolvePortalViewer>[0]) => portalModule.resolvePortalViewer({ ...input, cookies: input.cookies ?? { get: (name) => name === "rtp_client" ? cookie ?? undefined : undefined } }) };
});

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5927), env: { AUTH_ENFORCE: "true", APP_SECRET: "u2-context-isolated-secret" } });
  const fence = fenceFetch(async (url) => {
    if (url.startsWith("https://geocoding.geo.census.gov/")) return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: "FIXTURE ADDRESS" }] } }));
    return null;
  });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { signClientSession } = await import("@/lib/auth/clientSession");
    const portal = await import("@/lib/portal");
    const actions = await import("@/app/portal/actions");
    const { portalBookingLinks } = await import("@/lib/callBooking");
    const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
    const f = await buildContentMonth(prisma, { name: "U2 Pro Context TEST", package: "Pro", monthKey: "2026-10", project: false, owner: { name: "Alex", email: "info+u2context@realtourpilot.com" } });
    const november = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-11", videosOwed: f.videosPerMonth, status: "OPEN" } });
    const other = await buildContentMonth(prisma, { name: "Other Context TEST", package: "Starter", monthKey: "2026-12", project: false });
    const auth = { enrollmentId: f.enrollmentId };
    cookie = await signClientSession({ cu: f.clientUserId!, email: "info+u2context@realtourpilot.com" });
    const resolved = await portal.resolvePortalViewer({ ...auth, cookies: { get: (name) => name === "rtp_client" ? cookie! : undefined } });
    if (!resolved.ok) throw new Error(`Signed owner failed: ${resolved.reason}`);
    const viewer = resolved.viewer;
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date("2026-09-25T14:00:00Z"), scheduledEnd: new Date("2026-09-25T14:30:00Z"), transcriptState: "ANALYZED" } });
    const months = await portal.portalScheduleMonths(viewer.enrollment);
    c.ok("month query resolves only among the signed enrollment's open months", selectedPortalMonth(months, "2026-11")?.monthId === november.id && selectedPortalMonth(months, "2026-12") === null && selectedPortalMonth(months, "2026-09") === null);
    c.ok("malformed month and impossible Pro session query are refused", portalMonthKey("2026-13") === null && portalMonthKey("2026-1") === null && portalSessionIndex("3", 2) === null && portalSessionIndex("2", 2) === 2);
    const link = portalMonthHref(`?e=${f.enrollmentId}&tab=plan&pv=month&iv=oldinterview&page=7&q=private+draft&token=private-token`, "2026-11", 2);
    c.ok("context link is query-only and retains client/month/session without private search or bearer material", link.startsWith("?") && link.includes(`e=${f.enrollmentId}`) && link.includes("month=2026-11&session=2") && !/iv=|page=|q=|token=|private|\/portal/.test(link));
    c.ok("changing month clears the old session unless explicitly selected", !portalMonthHref(link, "2026-10").includes("session="));
    const call = await portalBookingLinks(viewer, { layout: "v2", planHref: link, monthId: november.id });
    c.ok("call booking context uses the selected month even without provider setup", call.view?.monthId === november.id && call.view.monthKey === "2026-11");
    c.ok("selected call context refuses another enrollment's month", (await portalBookingLinks(viewer, { layout: "v2", planHref: link, monthId: other.monthId })).view === null);

    const exact = (street: string) => ({ street, city: "West Chester", state: "PA", zip: "19382" });
    const firstAddress = await actions.portalSaveSessionPlanAddress(auth, f.monthId, 1, exact("117 First Lane"));
    const secondAddress = await actions.portalSaveSessionPlanAddress(auth, f.monthId, 2, exact("220 Second Lane"));
    c.ok("signed Pro client saves each session's own address and distinct plan", firstAddress.ok && secondAddress.ok && firstAddress.planId !== secondAddress.planId, `${firstAddress.message} / ${secondAddress.message}`);
    const days: import("@/lib/portal").PortalSlotDay[] = Array.from({ length: 21 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 9, i + 2, 12));
      const slots = [new Date(Date.UTC(2026, 9, i + 2, 15)).toISOString(), new Date(Date.UTC(2026, 9, i + 2, 18)).toISOString()];
      return { date: date.toISOString().slice(0, 10), slots, fitsMinutes: 240, creatives: ["Fixture photographer"], slotCreatives: Object.fromEntries(slots.map((slot) => [slot, [{ teamMemberId: "fixture-u2-photographer", name: "Fixture photographer" }]])) };
    }).filter((day) => ![0, 6].includes(new Date(`${day.date}T12:00:00Z`).getUTCDay()));
    // The cache represents a provider response that already passed product,
    // duration and weekday checks. The action still applies its real gate and
    // travel presentation; unrelated gate/provider cases are covered by b3.
    const product = ARYEO_CONTENT_PRODUCTS.Pro;
    await prisma.appSetting.create({ data: { key: `portal-aryeo-slots:v4:${product.productId}:240:21`, value: JSON.stringify({ at: Date.now(), days }) } });
    const one = await actions.portalSessionSlots(auth, f.monthId, 1);
    const two = await actions.portalSessionSlots(auth, f.monthId, 2);
    c.ok("signed session-two calendar carries only its own address-version identity", one.ok && two.ok && one.days.length > 6 && one.planId === firstAddress.planId && two.planId === secondAddress.planId && two.addressLine?.includes("220 Second Lane") === true, JSON.stringify({ one: one.message, two: two.message, days: two.days.length }));
    const last = two.days[two.days.length - 1];
    const lastPage = sessionDatePage(two.days, Math.floor((two.days.length - 1) / 6), last.date);
    const offeredKey = sessionOfferKey(`${f.monthId}:2`, two);
    const picked = { key: offeredKey, value: last.slots[last.slots.length - 1] };
    c.ok("more-than-six returned dates reach the last date and every time on it", lastPage.visible.some((day) => day.date === last.date) && lastPage.active?.date === last.date && currentSessionSlot(picked, offeredKey, lastPage.active) === picked.value);
    c.ok("shorter refreshed calendar clamps the date page and cannot retain a removed time", sessionDatePage(two.days.slice(0, 2), 4, last.date).page === 0 && currentSessionSlot(picked, offeredKey, two.days[0]) === null);
    c.ok("session one cannot reuse the selection from session two", currentSessionSlot(picked, sessionOfferKey(`${f.monthId}:1`, one), last) === null);
    const changed = await actions.portalSaveSessionPlanAddress(auth, f.monthId, 2, exact("330 Changed Lane"));
    const refreshed = await actions.portalSessionSlots(auth, f.monthId, 2);
    c.ok("saved exact-address change increments its version and invalidates the old slot selection", changed.ok && refreshed.addressVersion! > two.addressVersion! && currentSessionSlot(picked, sessionOfferKey(`${f.monthId}:2`, refreshed), last) === null);
    c.ok("changing session two keeps session one's saved address unchanged", (await actions.portalSessionSlots(auth, f.monthId, 1)).addressLine === one.addressLine);

    // Static rendering of the real page/components, without browser access.
    const load = createRequire(__filename);
    for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
      navigation.useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} });
      navigation.usePathname = () => "/portal/me";
      navigation.useSearchParams = () => new URLSearchParams();
    }
    const { PortalPage } = await import("@/components/portal/PortalPage");
    const { PortalScheduler, SlotTimes } = await import("@/components/portal/PortalScheduler");
    const { PortalCallPicker } = await import("@/components/portal/PortalCallPicker");
    const octoberCall = await portalBookingLinks(viewer, { layout: "v2", planHref: link, monthId: f.monthId });
    c.ok("actual call picker has a distinct React identity for each program month", !!call.view && !!octoberCall.view && PortalCallPicker({ view: call.view }).key !== PortalCallPicker({ view: octoberCall.view }).key);
    const scheduleHtml = renderToStaticMarkup(await PortalPage({ viewer, path: "/portal/me", baseQuery: `e=${f.enrollmentId}`, query: { tab: "schedule", month: "2026-11", session: "2" } }));
    c.ok("actual Schedule page keeps selected month/session in Plan, Library and Schedule links", ["plan", "library", "schedule"].every((tab) => scheduleHtml.includes(`month=2026-11&amp;session=2&amp;tab=${tab}`)) && scheduleHtml.includes("November 2026") && scheduleHtml.includes("Sessions · all program months"));
    const schedulerHtml = renderToStaticMarkup(createElement(PortalScheduler, { months, bookingUrl: "?tab=plan", selectedMonthId: f.monthId, selectedSessionIndex: 2 }));
    c.ok("actual Pro picker marks session two selected on a cold render", /aria-selected="true"[^>]*>Session <!-- -->2<!-- --> of/.test(schedulerHtml) || /aria-selected="true"[^>]*>Session 2 of/.test(schedulerHtml), schedulerHtml.match(/aria-selected="true"[^>]*>.{0,70}/g)?.join(" | "));
    const timesHtml = renderToStaticMarkup(createElement(SlotTimes, { day: last, slot: picked.value, tz: "America/New_York", onPick: () => {} }));
    c.ok("actual last-day times expose all slots and selected-state semantics", (timesHtml.match(/<button/g) ?? []).length === last.slots.length && timesHtml.includes('aria-pressed="true"'));
    const planHtml = renderToStaticMarkup(await PortalPage({ viewer, path: "/portal/me", baseQuery: `e=${f.enrollmentId}`, query: { tab: "plan", month: "2026-11", session: "2" } }));
    c.ok("actual guided month keeps the selected future month through script/library navigation", planHtml.includes("November 2026") && planHtml.includes("month=2026-11&amp;session=2&amp;tab=plan&amp;pv=scripts") && !planHtml.includes("other client's"));
    const invalidHtml = renderToStaticMarkup(await PortalPage({ viewer, path: "/portal/me", baseQuery: `e=${f.enrollmentId}`, query: { tab: "schedule", month: "2026-12", session: "2" } }));
    c.ok("unavailable month context is dropped rather than borrowing another client's month", !invalidHtml.includes("month=2026-12") && !invalidHtml.includes("December 2026"));
    c.ok("no provider booking, client send or automation activation occurred", fence.blocked.length === 0 && await prisma.programSessionRequest.count() === 0 && await prisma.programCallBooking.count() === 0 && await prisma.outboxMessage.count() === 0 && await prisma.programAutomation.count({ where: { enabled: true } }) === 0);
    c.summary();
  } finally { fence.restore(); await drill.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
