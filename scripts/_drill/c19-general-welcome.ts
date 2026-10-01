// C19: approved general welcome URL, kept separate from monthly planning.
// Actual settings resolver, welcome sweep, template rendering, portal monthly
// link reader and Calendly classifiers. Prisma/outbox are in-memory fakes;
// Calendly responses are faked behind the committed isolation boundary.
import { createRequire } from "node:module";
import type { PortalViewer } from "../../src/lib/portal";
import type { AutoTextRules } from "../../src/lib/settings";
import { fenceFetch, installNextStubs, makeChecker, pinDrillEnv } from "./_harness";

installNextStubs();
pinDrillEnv(5997); // unreachable loopback backstop; no database is booted
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 1, 15, 0); // Thu 11 AM ET
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) { return args.length ? Reflect.construct(target, args) : new target(PINNED); },
  get(target, prop, receiver) { return prop === "now" ? () => PINNED : Reflect.get(target, prop, receiver); },
}) as DateConstructor;

const GENERAL = "https://calendly.com/realtourpilot-info/strategy-call";
const MONTHLY = "https://calendly.com/realtourpilot-info/content-program-strategy-call";
const GENERAL_URI = "https://api.calendly.com/event_types/general-fixture";
const MONTHLY_URI = "https://api.calendly.com/event_types/monthly-fixture";
type WelcomePlan = { channel: string; toRef: string; body: string; dedupeKey: string; clientId: string; requestedBy: string };
type Candidate = { id: string; name: string; phone: string | null; email: string | null; autoConfirmationText: boolean; autoDeliveryText: boolean };

async function main() {
  const c = makeChecker(), req = createRequire(__filename);
  const originalModules = new Map<string, NodeModule | undefined>();
  const stub = (relative: string, exports: Record<string, unknown>) => {
    const file = req.resolve(relative);
    originalModules.set(file, req.cache[file]);
    req.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: exports, ...exports } } as NodeModule;
  };
  const rows = new Map<string, string>(), planned: WelcomePlan[] = [];
  let candidates: Candidate[] = [], candidateQuery: unknown;
  const waiting = new Set<string>(), markers = new Set<string>();
  const mapping = { id: "monthly-mapping-fixture", eventTypeUri: MONTHLY_URI, eventName: "Dedicated monthly fixture", publicUrl: MONTHLY, purpose: "MONTHLY_STRATEGY", enabled: true, validationStatus: "VALID" };
  let mappings = [mapping];
  let unrelatedWrites = 0;
  const refuseWrite = async () => { unrelatedWrites++; throw new Error("fixture refuses business mutations"); };
  stub("../../src/lib/prisma.ts", { prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => markers.has(where.key) ? { key: where.key, value: "already handed over" } : rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => { rows.set(where.key, rows.has(where.key) ? update.value : create.value); },
      create: refuseWrite,
    },
    client: { findMany: async (query: unknown) => { candidateQuery = query; return candidates; }, update: refuseWrite },
    smartTask: { findFirst: async ({ where }: { where: { clientId: string } }) => waiting.has(where.clientId) ? { id: "waiting-fixture" } : null },
    commLog: { findFirst: async ({ where }: { where: { direction: string } }) => ({ occurredAt: new Date(PINNED - (where.direction === "in" ? 1_000 : 10_000)) }) },
    programCalendlyEventMapping: {
      findMany: async () => mappings,
      findUnique: async ({ where }: { where: { eventTypeUri: string } }) => mappings.find((row) => row.eventTypeUri === where.eventTypeUri) ?? null,
    },
  } });
  stub("../../src/lib/outbox.ts", {
    sendThroughOutbox: async (plan: WelcomePlan) => { planned.push(plan); return { outcome: "busy", id: "fixture-held" }; },
    welcomeKey: (id: string) => `welcome:${id}`,
  });
  stub("../../src/lib/commLog.ts", { logComm: refuseWrite });
  stub("../../src/lib/tasks.ts", { MONTHLY_BATCH_INCOMPLETE: "fixture-monthly", DELIVERED_LONG_AGO: "fixture-long-ago", SEND_UNVERIFIED: "fixture-unverified" });
  stub("../../src/lib/integrations/openphone.ts", {
    phoneKey: (phone: string) => phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""),
    defaultOpenPhoneNumber: async () => "+16105550100",
  });
  stub("../../src/lib/integrations/connections.ts", { getSecret: async () => "fixture-only-key" });
  const fence = fenceFetch((url, init) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error("fixture refuses Calendly writes");
    const parsed = new URL(url);
    if (parsed.host !== "api.calendly.com") return null;
    const json = (body: unknown) => new Response(JSON.stringify(body));
    if (parsed.pathname === "/users/me") return json({ resource: { uri: "https://api.calendly.com/users/fixture" } });
    if (parsed.pathname === "/event_types") return json({ collection: [
      { uri: GENERAL_URI, slug: "strategy-call", name: "Strategy call", scheduling_url: GENERAL },
      { uri: MONTHLY_URI, slug: "content-program-strategy-call", name: "Content program strategy call", scheduling_url: MONTHLY },
    ] });
    if (parsed.pathname === "/scheduled_events") return json({ collection: [
      { uri: "https://api.calendly.com/scheduled_events/general-fixture", event_type: GENERAL_URI, name: "Strategy call" },
      { uri: "https://api.calendly.com/scheduled_events/monthly-fixture", event_type: MONTHLY_URI, name: "Content program strategy call" },
    ] });
    if (parsed.pathname === "/scheduled_events/monthly-fixture/invitees") return json({ collection: [] });
    return null;
  });
  try {
    const S = await import("@/lib/settings");
    const { sweepWelcomeTexts } = await import("@/lib/clientTextSweeps");
    const calendly = await import("@/lib/integrations/calendly");
    const { portalBookingLinks } = await import("@/lib/callBooking");
    const save = (rules: Partial<AutoTextRules>) => S.putSetting("auto_texts", rules, "fixture-only");
    const run = async (texted = new Set<string>()) => { planned.length = 0; return sweepWelcomeTexts(texted); };
    const sms: Candidate = { id: "sms-fixture", name: "Morgan Fixture", phone: "+16105550101", email: "morgan@example.test", autoConfirmationText: true, autoDeliveryText: true };
    const email: Candidate = { ...sms, id: "email-fixture", name: "Taylor Fixture", phone: null, email: "taylor@example.test" };
    c.ok("general welcome default is the approved link", S.DEFAULT_WELCOME.strategyCallUrl === GENERAL && S.GENERAL_STRATEGY_CALL_BOOKING_URL === GENERAL);
    c.ok("default wording and master/rule switches retain their existing values", S.DEFAULT_WELCOME.message === S.DEFAULT_WELCOME_TEXT && S.DEFAULT_WELCOME.enabled && S.DEFAULT_AUTO_TEXTS.enabled && S.DEFAULT_AUTO_TEXTS.sendUntilMinute === 30 && S.DEFAULT_AUTO_TEXTS.weekdaysOnly);
    candidates = [sms, email];
    const initial = await run();
    c.ok("actual welcome sweep composes both SMS and email with the approved general link", planned.length === 2 && planned.every((plan) => plan.body.includes(GENERAL) && !plan.body.includes(MONTHLY)));
    c.ok("actual recipient planning keeps the existing rail and one-shot identity", planned[0]?.channel === "sms" && planned[0]?.toRef === "6105550101" && planned[0]?.dedupeKey === "welcome:sms-fixture" && planned[1]?.channel === "email" && planned[1]?.toRef === "taylor@example.test" && planned[1]?.dedupeKey === "welcome:email-fixture");
    c.ok("actual default rendering keeps first name, portal, website and no unresolved tokens", planned[0]?.body.includes("Hey Morgan,") && planned[0]?.body.includes("media.realtourpilot.com") && planned[0]?.body.includes("realtourpilot.com") && !planned.some((plan) => /\{\w+\}/.test(plan.body)));
    c.ok("held fake plans are never reported as sent or stamped as provider proof", initial.sent === 0 && initial.skipped === 2 && unrelatedWrites === 0);
    const query = candidateQuery as { where: { welcomeTextAt: null; parentClientId: null; firstSeenAt: { gt: Date }; projects: { some: { status: { notIn: string[] }; shootDate: { not: null }; aryeoMissingAt: null } } }; take: number };
    c.ok("existing eligibility still requires a recent new client and a live booked shoot", query.where.welcomeTextAt === null && query.where.parentClientId === null && query.where.firstSeenAt.gt.getTime() === PINNED - 30 * 86_400_000 && query.where.projects.some.status.notIn.includes("CANCELLED") && query.where.projects.some.shootDate.not === null && query.where.projects.some.aryeoMissingAt === null && query.take === 25);

    const customUrl = "https://example.test/approved-custom-call";
    const customMessage = "Hello {first}!\nCall: {strategyCallLink}\nPortal: {portal}";
    const saved: Partial<AutoTextRules> = { enabled: true, sendFromHour: 8, sendUntilHour: 17, sendUntilMinute: 15, weekdaysOnly: false, confirmation: { enabled: false, hoursBefore: 72 }, delivery: { enabled: false, maxTaskAgeHours: 90, requireMonthlyBatch: false }, welcome: { enabled: true, strategyCallUrl: customUrl, message: customMessage }, skipWhenClientWaiting: true, onePerClientPerRun: true };
    await save(saved);
    const storedBytes = rows.get("auto_texts"), resolved = await S.autoTextRules();
    c.ok("saved custom welcome URL and exact message take precedence over the new default", resolved.welcome.strategyCallUrl === customUrl && resolved.welcome.message === customMessage);
    c.ok("unrelated saved windows, enabled choices and delivery rules are preserved", resolved.sendFromHour === 8 && resolved.sendUntilHour === 17 && resolved.sendUntilMinute === 15 && !resolved.weekdaysOnly && !resolved.confirmation.enabled && resolved.confirmation.hoursBefore === 72 && !resolved.delivery.enabled && resolved.delivery.maxTaskAgeHours === 90 && !resolved.delivery.requireMonthlyBatch);
    await run();
    c.ok("actual sweep uses saved custom text and URL without rewriting the overlay", planned[0]?.body === `Hello Morgan!\nCall: ${customUrl}\nPortal: media.realtourpilot.com` && rows.get("auto_texts") === storedBytes);
    await save({ welcome: { enabled: false, strategyCallUrl: customUrl, message: customMessage } });
    const off = await run();
    c.ok("saved welcome OFF remains off and makes no recipient plan", planned.length === 0 && off.sent === 0 && off.notes.some((note) => note.includes("switched OFF")));
    await save({ enabled: false }); await run();
    c.ok("saved master OFF remains off", planned.length === 0 && !(await S.autoTextRules()).enabled);
    for (const strategyCallUrl of ["", "not a URL"]) {
      await save({ welcome: { enabled: true, strategyCallUrl, message: "" } });
      await run();
      c.ok(`${strategyCallUrl ? "malformed" : "empty"} saved welcome URL falls back to the general link and original wording`, planned[0]?.body === S.DEFAULT_WELCOME_TEXT.replace("{first}", "Morgan").replace("{strategyCallLink}", GENERAL).replace("{portal}", "media.realtourpilot.com").replace("{website}", "realtourpilot.com"));
    }
    await save({}); candidates = [{ ...sms, autoConfirmationText: false, autoDeliveryText: false }]; await run();
    c.ok("client automatic-text opt-out is preserved", planned.length === 0);
    candidates = [sms]; waiting.add(sms.id); await run(); waiting.clear();
    c.ok("an unanswered client question still holds the welcome", planned.length === 0);
    await run(new Set([sms.id]));
    c.ok("one-per-client-per-run still holds a client already texted this tick", planned.length === 0);
    markers.add(`auto-welcome-${sms.id}`); await run(); markers.clear();
    c.ok("an existing welcome identity still prevents another plan", planned.length === 0);
    await save({ sendFromHour: 12, sendUntilHour: 16 }); await run();
    c.ok("the send window still holds the welcome outside allowed hours", planned.length === 0);

    c.ok("monthly strategy constant remains the dedicated content-program URL", calendly.STRATEGY_CALL_BOOKING_URL === MONTHLY);
    const viewer = { enrollment: { id: "enrollment-fixture" } } as unknown as PortalViewer;
    c.ok("portal v1 monthly mapped booking still uses the dedicated URL", (await portalBookingLinks(viewer, { layout: "v1", planHref: null })).bookingUrl === MONTHLY);
    mappings = [];
    c.ok("portal v1 monthly fallback keeps the dedicated URL", (await portalBookingLinks(viewer, { layout: "v1", planHref: null })).bookingUrl === MONTHLY);
    mappings = [mapping];
    c.ok("program classification still accepts only the mapped monthly event URI", await calendly.purposeForEventType(MONTHLY_URI) === "MONTHLY_STRATEGY" && await calendly.purposeForEventType(GENERAL_URI) === null);
    c.ok("legacy monthly classifier still resolves only the dedicated slug", await calendly.strategyCallEventType() === MONTHLY_URI);
    const calls = await calendly.listStrategyCalls("2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z");
    c.ok("legacy monthly scan excludes general strategy-call bookings", calls.length === 1 && calls[0]?.event.event_type === MONTHLY_URI);
    c.ok("fixture performs no business mutations or real provider requests", unrelatedWrites === 0 && fence.blocked.length === 0 && fence.faked.length > 0);
    c.summary();
  } finally {
    globalThis.Date = RealDate;
    fence.restore();
    for (const [file, original] of originalModules) { if (original) req.cache[file] = original; else delete req.cache[file]; }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
