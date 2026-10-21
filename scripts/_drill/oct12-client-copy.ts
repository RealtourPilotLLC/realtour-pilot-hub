// Oct 12 2026 — CLIENT COPY (Jordan): "In the 'Welcome to your Realtour Pilot
// Content Portal', 'RealTour' should be 'Realtour'. And 'Here's the way
// forward: 1. Book your brand discovery call at …' should not be shown. When
// someone signs up, they book their brand discovery call right after signing
// up … They only need to book a discovery call if they have not yet, or if we
// didn't put together a content strategy for them."
//
//   §1 the REAL composeWelcomeEmail (portalAccess) over an in-memory prisma:
//      no discovery step with an approved strategy, with a strategy still in
//      progress, or with a booked / held discovery call; the step (and only
//      then) when nothing is booked and no strategy is on file; the
//      conditional wording for a booking that may be theirs; steps numbered
//      from what is shown; the month's steps follow the client's program style.
//   §2 every client-facing template, rendered across its variants (reminders,
//      strategy and scripts notices, welcome, teammate welcome, office reply,
//      late-session message, subjects, default texts): no "RealTour", no em
//      dash, and the template sources never spell the brand with a capital T.
//
// No database is booted (an unreachable loopback URL is pinned as a backstop),
// nothing is sent, and no provider is called.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { installNextStubs, makeChecker, pinDrillEnv } from "./_harness";

installNextStubs();
pinDrillEnv(5981);
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 12, 15, 0); // Mon Oct 12, 11 AM ET
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) { return args.length ? Reflect.construct(target, args) : new target(PINNED); },
  get(target, prop, receiver) { return prop === "now" ? () => PINNED : Reflect.get(target, prop, receiver); },
}) as DateConstructor;

const DISCOVERY_URL = "https://calendly.com/realtourpilot-info/brand-discovery-call";
const REPO = path.resolve(__dirname, "../..");

/** One client's facts, as the welcome reads them. */
type Fixture = {
  enrollment: { id: string; callMode: string | null; strategyCallRequired: boolean; noCallEligible: boolean | null; clientSuppliesTopics: boolean; sessionsPerMonth: number } | null;
  discovery: { scheduledStart: Date } | null;
  strategies: number;
  released: number;
  onboarding: { discoveryRequired: boolean; discoveryWaivedAt: Date | null; status: string } | null;
  monthlyHeld: number;
  candidates: number;
  setupMissing: string[];
};
const BASE: Fixture = {
  enrollment: { id: "enr-fixture", callMode: null, strategyCallRequired: true, noCallEligible: null, clientSuppliesTopics: false, sessionsPerMonth: 1 },
  discovery: null, strategies: 0, released: 0, onboarding: null, monthlyHeld: 0, candidates: 0, setupMissing: [],
};

const EM_DASH = /—/;
const CAPITAL_T = /RealTour/;

async function main() {
  const c = makeChecker(), req = createRequire(__filename);
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (relative: string, exports: Record<string, unknown>) => {
    const file = req.resolve(relative);
    originals.set(file, req.cache[file]);
    req.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: exports, ...exports } } as NodeModule;
  };
  let fx: Fixture = BASE;
  let writes = 0;
  const refuse = async () => { writes++; throw new Error("fixture refuses writes"); };
  const where = (q: unknown) => ((q as { where?: Record<string, unknown> })?.where ?? {}) as Record<string, unknown>;
  stub("../../src/lib/prisma.ts", { prisma: new Proxy({}, {
    get(_t, model: string) {
      const reads: Record<string, Record<string, (q: unknown) => Promise<unknown>>> = {
        contentEnrollment: { findUnique: async () => fx.enrollment },
        programCallRecord: {
          findFirst: async (q) => (where(q).callType === "BRAND_DISCOVERY" ? fx.discovery : null),
          count: async (q) => (where(q).callType === "MONTHLY_STRATEGY" ? fx.monthlyHeld : 0),
        },
        contentStrategy: { count: async () => fx.strategies },
        contentStrategyVersion: { count: async () => fx.released },
        programOnboarding: { findUnique: async () => fx.onboarding },
        programCalendlyEventMapping: { findFirst: async (q) => (where(q).purpose === "BRAND_DISCOVERY" ? { publicUrl: DISCOVERY_URL } : null) },
      };
      return new Proxy({}, {
        get(_m, op: string) {
          const fn = reads[model]?.[op];
          if (fn) return fn;
          if (/^(create|update|upsert|delete)/.test(op)) return refuse;
          return async () => { throw new Error(`fixture has no ${model}.${op}`); };
        },
      });
    },
  }) });
  stub("../../src/lib/contentCallRecords.ts", { candidateDiscoveryBookingsFor: async () => Array.from({ length: fx.candidates }, (_, i) => ({ id: `cand-${i}` })) });
  stub("../../src/lib/portalSetup.ts", { setupMissingWords: async () => fx.setupMissing });

  try {
    const { composeWelcomeEmail } = await import("@/lib/portalAccess");
    const W = await import("@/lib/welcomeEmail");
    const welcome = async (f: Partial<Fixture>) => { fx = { ...BASE, ...f }; return composeWelcomeEmail({ name: "Sarah Agent", clientName: "Sarah Agent", reason: "welcome", clientId: "client-fixture" }); };
    const hasDiscoveryStep = (body: string) => /^\d\. .*brand discovery call/m.test(body);
    const numbersInOrder = (body: string) => {
      // Each numbered list restarts at 1 and counts up with no gap.
      let last = 0;
      for (const line of body.split("\n")) {
        const m = /^(\d+)\. /.exec(line);
        if (!m) continue;
        const n = Number(m[1]);
        if (n !== 1 && n !== last + 1) return false;
        last = n;
      }
      return true;
    };

    c.head("§1 · the welcome's discovery step follows Jordan's rule");
    const approved = await welcome({ strategies: 1, released: 1 });
    c.ok("an approved strategy on file: no discovery step, no 'way forward', no discovery link", !hasDiscoveryStep(approved) && !/way forward/i.test(approved) && !approved.includes(DISCOVERY_URL));
    c.ok("…the portal's purpose instead: monthly strategy call, topics, filming, scripts, videos",
      /1\. Book your monthly strategy call\. That's where we plan the month's videos and choose your topics together\./.test(approved) &&
      /2\. Book your filming session/.test(approved) && /3\. Read and approve your scripts/.test(approved) && /4\. Review your videos\. Approve them or tell us what to change, then download the finished ones\./.test(approved));
    c.ok("…under the right brand, signed by Jordan and the team, sign-in page not a one-time link",
      approved.includes("Welcome to your Realtour Pilot content portal") && approved.trimEnd().endsWith("Jordan and the Realtour Pilot team") && approved.includes("/portal/login") && !approved.includes("/portal/auth/"));

    const drafting = await welcome({ strategies: 1, released: 0 });
    c.ok("a strategy still being put together (imported draft): no discovery step", !hasDiscoveryStep(drafting) && !drafting.includes(DISCOVERY_URL));

    const upcoming = new RealDate(PINNED + 2 * 86_400_000);
    const booked = await welcome({ discovery: { scheduledStart: upcoming } });
    c.ok("a booked discovery call (no strategy yet): named with its time, never 'book it'",
      booked.includes("Your brand discovery call is booked for Wednesday, October 14 at 11:00 AM Eastern") && !hasDiscoveryStep(booked) && !/book it here/i.test(booked), booked.split("\n").find((l) => /discovery/.test(l)));

    const held = await welcome({ discovery: { scheduledStart: new RealDate(PINNED - 5 * 86_400_000) } });
    c.ok("a held discovery call, strategy not ready: thanks them and says the strategy follows; no step", /Thanks for your brand discovery call on October 7\..*we'll let you know when it's ready/.test(held) && !hasDiscoveryStep(held));
    const heldReady = await welcome({ discovery: { scheduledStart: new RealDate(PINNED - 5 * 86_400_000) }, strategies: 1, released: 1 });
    c.ok("…and once the strategy is released, says it's ready to read", /it's ready to read in your portal\./.test(heldReady) && !/we'll let you know when/.test(heldReady));

    const none = await welcome({});
    c.ok("nothing booked and no strategy: the discovery step IS there, as step 1, with the link at the end of its line",
      /^1\. If you haven't booked your brand discovery call yet, book it here: https:\/\/calendly\.com\/realtourpilot-info\/brand-discovery-call$/m.test(none), none.split("\n").find((l) => l.startsWith("1.")));
    c.ok("…then 'Then, each month in your portal:' restarts at 1", /Here's what's next:\n1\. [^\n]+\n[^\n]+\n\nThen, each month in your portal:\n1\. Book your monthly strategy call/.test(none));

    const maybe = await welcome({ candidates: 1 });
    c.ok("a booking that may be theirs (another address): the conditional wording, never a bare 'Book your…'",
      /^1\. If you've already booked your brand discovery call, you're all set and we'll confirm it with you\. If not, book it here: https:\/\/\S+$/m.test(maybe) && !maybe.includes("Book your brand discovery call") && !maybe.includes("is booked for"));

    const waived = await welcome({ onboarding: { discoveryRequired: false, discoveryWaivedAt: null, status: "WAIVED" } });
    c.ok("discovery waived by the office: no step", !hasDiscoveryStep(waived));
    const established = await welcome({ monthlyHeld: 1 });
    c.ok("an established client (a monthly strategy call already held): no step, and the month may be planned in writing",
      !hasDiscoveryStep(established) && /1\. Book your monthly strategy call\. That's where we plan the month's videos and choose your topics together\. Or skip the call and select your topics and answer a few questions here in your portal\./.test(established));
    // Jordan, Oct 12 2026: an approved, released strategy opens the written route too (not only a held monthly call).
    const strategyOnly = await welcome({ strategies: 1, released: 1 });
    c.ok("a released strategy (no monthly call held yet): the call OR topics-in-the-portal step", /Or skip the call and select your topics/.test(strategyOnly));
    const pinnedCall = await welcome({ monthlyHeld: 1, enrollment: { ...BASE.enrollment!, noCallEligible: false } });
    c.ok("…unless they are switched off the written route: call only", /1\. Book your monthly strategy call\. That's where/.test(pinnedCall) && !/skip the call/.test(pinnedCall));

    const callsOff = await welcome({ strategies: 1, released: 1, enrollment: { ...BASE.enrollment!, callMode: "NOT_INCLUDED", strategyCallRequired: false } });
    c.ok("strategy calls switched off: no call promised; topics and answers in the portal", !/strategy call/i.test(callsOff) && /1\. Choose your video topics and answer a few short questions about each\./.test(callsOff));

    const selfPlanned = await welcome({ enrollment: { ...BASE.enrollment!, callMode: null, strategyCallRequired: false, clientSuppliesTopics: true } });
    c.ok("a client who plans their own content (no strategy on file): no discovery step, no call, no topics or scripts asked",
      !hasDiscoveryStep(selfPlanned) && !/strategy call|topics|scripts before/i.test(selfPlanned.split("Here's what you'll do")[1] ?? selfPlanned) && /1\. Add your plan for the month if you'd like \(optional\)/.test(selfPlanned) && /2\. Book your filming session\.\n3\. Review your videos/.test(selfPlanned));

    const pro = await welcome({ strategies: 1, released: 1, enrollment: { ...BASE.enrollment!, sessionsPerMonth: 2 } });
    c.ok("a two-session package (Pro): 'Book your two filming sessions', times plural", /2\. Book your two filming sessions\. You can pick times as soon as your call is booked or your answers are in\./.test(pro));
    c.ok("a self-planned client's intro doesn't promise topics or scripts from us", !/video topics|your scripts/.test(selfPlanned.split("\n")[2] ?? ""));
    const brand = await welcome({ strategies: 1, released: 1, setupMissing: ["logo", "headshot", "brand colors", "fonts", "music style"] });
    c.ok("missing Brand Profile items: one short step (three named and 'the rest'), the month's list renumbered after it",
      /Here's what's next:\n1\. Fill in your Brand Profile in the portal \(your logo, headshot, brand colors and the rest\) so your videos match your look\./.test(brand) && /Then, each month in your portal:\n1\. /.test(brand));
    const both = await welcome({ setupMissing: ["logo"] });
    c.ok("discovery needed AND a missing item: steps 1 and 2, in that order", /\n1\. If you haven't booked[^\n]*\n[^\n]*\n2\. Fill in your Brand Profile in the portal \(your logo\)/.test(both));

    const all = [pro, approved, drafting, booked, held, heldReady, none, maybe, waived, established, pinnedCall, callsOff, selfPlanned, brand, both];
    c.ok("every welcome variant: steps numbered without gaps", all.every(numbersInOrder));
    c.ok("every welcome variant: no em dash, no 'RealTour', no unresolved token", all.every((b) => !EM_DASH.test(b) && !CAPITAL_T.test(b) && !/\{\w+\}|undefined|null/.test(b)));
    const teammate = await composeWelcomeEmail({ name: "Alex Assistant", clientName: "Sarah Agent", reason: "teammate", clientId: "client-fixture" });
    c.ok("the teammate welcome: names the client, no discovery talk, no em dash, right brand",
      teammate.startsWith("Hi Alex,") && teammate.includes("Sarah Agent added you to their Realtour Pilot content portal") && !/discovery/i.test(teammate) && !EM_DASH.test(teammate) && !CAPITAL_T.test(teammate));
    const invite = W.renderPortalInviteEmail({ firstName: "Alex", clientName: "Sarah Agent", signInUrl: "https://drill.invalid/portal/login" });
    const signIn = W.renderSignInLinkEmail({ firstName: "Alex", url: "https://drill.invalid/portal/auth/tok" });
    c.ok("the staff invitation and the sign-in link email: right brand, no em dash, the link on its own line",
      [invite, signIn].every((b) => !EM_DASH.test(b) && !CAPITAL_T.test(b) && b.includes("Realtour Pilot")) && signIn.split("\n").includes("https://drill.invalid/portal/auth/tok"));
    c.ok("the pure rule agrees: a booking beats everything; a strategy, a waiver, self-planning or a held monthly call each mean 'not needed'",
      W.discoveryStateOf({ now: new RealDate(PINNED), booking: null, candidate: false, hasStrategy: false, waived: false, clientPlanned: false, monthlyCallHeld: false }).state === "needed" &&
      (["hasStrategy", "waived", "clientPlanned", "monthlyCallHeld"] as const).every((k) => W.discoveryStateOf({ now: new RealDate(PINNED), booking: null, candidate: true, hasStrategy: false, waived: false, clientPlanned: false, monthlyCallHeld: false, [k]: true }).state === "not_needed"));

    c.head("§2 · no client-facing template says 'RealTour' or uses an em dash");
    const RT = await import("@/lib/reminderTemplates");
    const base = {
      firstName: "Sarah", month: "October", portalLink: "https://drill.invalid/portal/me", bookCallLink: "https://calendly.com/realtourpilot-info/content-program-strategy-call",
      noCallEligible: false, answersStarted: false, sessionNote: null, earliestSession: null, itemCount: 1, titles: ["Why I love Lititz"], updatedTitles: [] as string[], deadline: null,
    };
    const variants = [
      {}, { noCallEligible: true }, { deadline: "October 20" }, { sessionNote: "Once your strategy call is booked you can pick your October filming time in the same portal right away, before the call." },
      { answersStarted: true }, { earliestSession: "Thursday, October 15" }, { callUpcoming: "Tuesday, October 13 at 2:00 PM ET", sessionOrdinalWord: "second" },
      { itemCount: 3, titles: ["A", "B", "C"], updatedTitles: ["B"] }, { reviewDeadline: "Thu, Oct 15, 5:00 PM ET", reviewAutoApprove: true },
      { sessionWhen: "Monday, October 19 at 10:00 AM ET", areaText: "West Chester, PA", addressLink: "https://drill.invalid/portal/address/x" },
      { sessionDay: "Thursday, October 15", approvalDeadline: "Wednesday, October 14 at 10:00 AM ET" },
      { firstCallAtET: "Tuesday, October 13 at 2:00 PM ET" }, { callLink: "https://calendly.com/x", setupMissing: ["logo", "headshot", "brand colors", "fonts"] },
      { strategyUpdate: true }, { strategyCallsOff: true, setupMissing: ["logo"] }, { bookCallLink: null },
    ];
    const rendered: { id: string; body: string }[] = [];
    for (const t of Object.values(RT.REMINDER_TEMPLATES)) for (const v of variants) rendered.push({ id: t.id, body: RT.renderReminder(t, { ...base, ...v }) });
    const badTemplates = rendered.filter((r) => EM_DASH.test(r.body) || CAPITAL_T.test(r.body));
    c.ok(`all ${Object.keys(RT.REMINDER_TEMPLATES).length} reminder/notice templates × ${variants.length} variants: no em dash, no 'RealTour'`, badTemplates.length === 0, badTemplates.slice(0, 2).map((r) => `${r.id}: ${r.body.split("\n").find((l) => EM_DASH.test(l) || CAPITAL_T.test(l))}`).join(" | "));
    c.ok("every template signs off 'Jordan and the Realtour Pilot team'", rendered.every((r) => r.body.includes(RT.SIGN_OFF_FIRST_LINE)) && RT.SIGN_OFF_FIRST_LINE === "Jordan and the Realtour Pilot team");
    c.ok("review emails say 'video', never the editor's word 'cut'", rendered.filter((r) => r.id.startsWith("reminder.review_work")).every((r) => /new videos? (is|are) waiting/.test(r.body) && !/\bcuts?\b/.test(r.body)));
    const off = RT.renderReminder(RT.reminderTemplate("strategy_ready.v2"), { ...base, strategyCallsOff: true, callLink: null, setupMissing: [] });
    c.ok("strategy ready, calls switched off: no 'book your first strategy call', topics in the portal instead", !/strategy call/i.test(off) && /2\. Choose your first month's video topics/.test(off));
    const { withExtraParagraph } = await import("@/lib/programReminders");
    const withPara = withExtraParagraph(RT.renderReminder(RT.reminderTemplate("reminder.book_session.v2"), base), "One note on timing.");
    c.ok("a milestone paragraph still lands ABOVE the new sign-off", /One note on timing\.\n\nJordan and the Realtour Pilot team/.test(withPara));

    const { subjectFor } = await import("@/lib/outbox");
    const kinds = ["confirmation", "delivery", "welcome", "afterhours", "portal_login", "portal_invite", "program_reminder", "script_share", "strategy_ready", "program_message", "manual", "onboarding", null] as const;
    const keys = [null, "portal_invite:m1:welcome", "portal_invite:m1:2026-10-12T15:00:00.000Z", "program_reminder:BOOK_SESSION:r1:2026-10", "program_reminder:CONFIRM_ADDRESS:r1:2026-10", "onboarding:welcome:c1:abcdefgh12", "onboarding:note:c1:abcdefgh12"];
    const subjects = kinds.flatMap((k) => keys.map((d) => subjectFor(k as Parameters<typeof subjectFor>[0], d)));
    c.ok("every email subject: no em dash, no 'RealTour'", subjects.every((s) => !EM_DASH.test(s) && !CAPITAL_T.test(s)), subjects.filter((s) => EM_DASH.test(s) || CAPITAL_T.test(s)).join(" | "));
    c.ok("the payer's welcome goes out as 'Welcome to your Realtour Pilot content portal'; a later invitation says they were added",
      subjectFor("portal_invite", "portal_invite:m1:welcome") === "Welcome to your Realtour Pilot content portal" && subjectFor("portal_invite", "portal_invite:m1:2026-10-12T15:00:00.000Z") === "You've been added to your Realtour Pilot content portal");
    const OB = await import("@/lib/clientOnboardingCore");
    c.ok("onboarding subjects: Realtour, no em dash", OB.ONBOARDING_MESSAGES.every((m) => !EM_DASH.test(m.subject) && !CAPITAL_T.test(m.subject)) && OB.messageOf("welcome").subject === "Welcome to your Realtour Pilot content portal");

    const { composeReplyNotice } = await import("@/lib/programMessages");
    const notice = composeReplyNotice({ name: "Sarah Agent", staffName: "Kyle Smith", body: "Moved it to October — see you then" });
    c.ok("the office-replied notice: Realtour, no em dash (even when the reply had one)", notice.includes("Kyle replied to your message in your Realtour Pilot content portal") && !EM_DASH.test(notice) && !CAPITAL_T.test(notice));

    const LS = await import("@/lib/lateSession");
    const lateBodies = (["TOPICS", "CHOOSE", "CALL_TO_BOOK", "CALL_BOOKED", "OFFICE", "CLIENT_PLANNED", "PLANNED"] as const).flatMap((hostPlanning) =>
      ([["TO_BOOK", false], ["TO_BOOK", true], ["BOOKED", false], ["BOOKED", true]] as const).map(([lateState, hostSessionBooked]) =>
        LS.lateSessionMessage({ firstName: "Arielle", lateMonthKey: "2026-09", hostMonthKey: "2026-10", link: "https://drill.invalid/portal/t", lateState: lateState as never, hostSessionBooked, hostPlanning })));
    c.ok("the late-session message, every shape: no em dash, and the link ends the message (never a period glued to it)", lateBodies.every((b) => !EM_DASH.test(b) && b.endsWith("https://drill.invalid/portal/t")), lateBodies.find((b) => !b.endsWith("https://drill.invalid/portal/t")));

    const S = await import("@/lib/settings");
    // Oct 21 2026: the client texts' words live in lib/textTemplates
    // (textTemplateDefaults was only the retired "Text wording" card's display copy).
    const TT = await import("@/lib/textTemplates");
    const texts = [S.DEFAULT_WELCOME_TEXT, S.DEFAULT_DELIVERY_FEEDBACK_TEXT, S.DEFAULT_AFTER_HOURS_REPLY, ...TT.TEXT_TEMPLATE_KEYS.filter((k) => TT.TEXT_TEMPLATES[k].audience === "client").map((k) => TT.TEXT_TEMPLATES[k].body)];
    c.ok("default client texts (welcome, delivery, after hours, confirmation): no em dash, no 'RealTour'", texts.every((t) => !EM_DASH.test(t) && !CAPITAL_T.test(t)) && S.DEFAULT_WELCOME_TEXT.includes("welcome to Realtour Pilot!"));

    // The template sources themselves: the brand is never spelled with a capital T.
    const sources = [
      "src/lib/reminderTemplates.ts", "src/lib/welcomeEmail.ts", "src/lib/portalAccess.ts", "src/lib/programMessages.ts", "src/lib/clientOnboarding.ts",
      "src/lib/clientOnboardingCore.ts", "src/lib/outbox.ts", "src/lib/settings.ts", "src/lib/textTemplates.ts", "src/lib/lateSession.ts",
      "src/lib/statusTexts.ts", "src/lib/delivery.ts", "src/lib/scriptShare.ts", "src/lib/contentCalls.ts", "src/app/billing/actions.ts", "src/app/quality/actions.ts",
    ];
    const withCapitalT = sources.filter((f) => CAPITAL_T.test(fs.readFileSync(path.join(REPO, f), "utf8")));
    c.ok("no client-template source spells it 'RealTour'", withCapitalT.length === 0, withCapitalT.join(", "));
    // The message bodies written inline (sign-in link, invitation, onboarding, feedback reply): every
    // `Hi …` array joined into an email must be em-dash free.
    const inlineBodies = ["src/lib/portalAccess.ts", "src/lib/programMessages.ts", "src/lib/clientOnboarding.ts", "src/app/quality/actions.ts", "src/app/billing/actions.ts"].flatMap((f) => {
      const src = fs.readFileSync(path.join(REPO, f), "utf8");
      return [...src.matchAll(/\[\s*`Hi \$\{[\s\S]*?\]\.join\("(?:\\n| )"\)/g)].map((m) => ({ f, text: m[0] }));
    });
    // Comments, and a regex that STRIPS dashes from quoted text, are not words a client reads.
    const words = (t: string) => t.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\/[^/\n]*[—–][^/\n]*\/g?/g, "");
    const dashed = inlineBodies.filter((b) => EM_DASH.test(words(b.text)));
    c.ok(`the ${inlineBodies.length} inline client message bodies: no em dash`, inlineBodies.length >= 4 && dashed.length === 0, dashed.map((d) => d.f).join(", "));
    c.ok("the fixture wrote nothing", writes === 0);
    c.summary();
  } finally {
    globalThis.Date = RealDate;
    for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
