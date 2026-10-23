// ---------------------------------------------------------------------------
// DRILL: THE CLIENT PORTAL, HONEST AND SIMPLE (Oct 13 2026, Jordan approved
// A1-A5 and C14 from the read-only portal audit).
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
// Pure: homeActions, yourMonthSteps and businessDaysWords run on fixtures;
// the coming-up list (Schedule's, folded into Home and Your Month on Oct 21
// 2026: ComingUp.tsx) renders to static markup from fixture months; the client
// components are read as source for what they no longer show. No database,
// no provider, no message.
//
//   A1  the shared link is asked to sign in (Home and the video review), never
//       told to approve; it is still never given approval rights.
//   A2  every call change / cancel goes to Your Month's call step; Schedule has
//       no Calendly wording.
//   A3  a client who plans their own content gets no strategy-call step and no
//       Book-the-call action, even with calls on.
//   C14 Schedule is read-only; Home's late + regular booking is ONE action (the
//       duplicate React key); the client copy says "three business days".
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const REPO = path.resolve(__dirname, "..", "..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
/** The source without its comments: what the page can show, not what a note about it says. */
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main() {
  const c = makeChecker();
  const { homeActions } = await import("../../src/lib/portalHome");
  const { yourMonthSteps } = await import("../../src/lib/yourMonth");
  const { businessDaysWords } = await import("../../src/lib/portalWords");
  const { emptyCounts } = await import("../../src/lib/planningState");
  const { ComingUpList } = await import("../../src/components/portal/ComingUp");
  const nav = await import("../../src/lib/portalNav");
  const { LEGACY_TOKEN_CAN_APPROVE } = await import("../../src/lib/portalAccess").then((m) => ({ LEGACY_TOKEN_CAN_APPROVE: m.can({ access: "FULL", actor: { kind: "TOKEN" }, enrollment: { id: "e", clientId: "c", clientName: "X" } } as unknown as Parameters<typeof m.can>[0], "approveEdits") }));

  type In = Parameters<typeof homeActions>[0];
  const base: In = {
    status: "ACTIVE", readOnly: false,
    perms: { session: true, suggest: true, request: true, approve: true, profile: true },
    review: { count: 0, single: null, soonestDeadlineLabel: null },
    scripts: [], unread: 0,
    planning: { planningMode: "CALL", callStatus: "NOT_SCHEDULED", noCallEligible: false },
    month: { monthKey: "2026-10", label: "October 2026", owed: 4, selected: 4 },
    toAnswer: [],
    session: { offerBooking: false, required: 1, missing: 1 },
    addressNeeded: 0, setup: null, ready: { count: 0, withFile: false, single: null },
  };
  const all = (o: { primary: { kind: string } | null; more: { kind: string }[] }) => [o.primary, ...o.more].filter(Boolean) as { kind: string; title: string; detail: string | null; cta: string; href: string }[];

  // =========================================================================
  c.head("A1 · the shared link watches; signing in decides");
  // =========================================================================
  c.ok("the shared link still can never approve (portalAccess.can, TOKEN, approveEdits)", LEGACY_TOKEN_CAN_APPROVE === false);
  const review = { count: 1, single: { id: "v1", title: "Kitchen tour" }, soonestDeadlineLabel: "Friday, October 16" };
  const owner = homeActions({ ...base, review, perms: { ...base.perms, approve: true } });
  c.ok("a signed-in owner is asked to review it", owner.primary?.kind === "REVIEW_VIDEOS" && owner.primary.title === "Review “Kitchen tour”");
  const link = homeActions({ ...base, review, perms: { ...base.perms, approve: false }, linkVisitor: { signInHref: "/portal/login" } });
  c.ok("the link's next step says to sign in, links to sign-in, and never says 'approve it'", link.primary?.kind === "REVIEW_VIDEOS" && link.primary.cta === "Sign in" && link.primary.href === "/portal/login" && /Sign in to approve or request changes/.test(link.primary.detail ?? "") && !/approve it/.test(`${link.primary.title} ${link.primary.detail}`), JSON.stringify(link.primary));
  const linkOff = homeActions({ ...base, review, perms: { ...base.perms, approve: false }, linkVisitor: { signInHref: null } });
  c.ok("…with email sign-in not live, it watches the video and is told to sign in from the invitation", linkOff.primary?.cta === "Watch it" && linkOff.primary.href === "?tab=library&v=v1" && /invitation email/.test(linkOff.primary.detail ?? ""), JSON.stringify(linkOff.primary));
  const cut = src("src/components/portal/CutReview.tsx");
  c.ok("the video review shows 'Sign in to approve or request changes.' to the link, with no note box or decision buttons", /Sign in to approve or request changes\./.test(cut) && /const canWrite = !readOnly && perms\.comment && \(!approved \|\| reopenable\) && !linkVisitor;/.test(cut) && /const reopenable = [^;]*!linkVisitor[^;]*;/.test(cut) && /\{!linkVisitor && !readOnly && \(!approved \|\| \(reopenable && open\.length > 0\)\) && \(perms\.request \|\| perms\.approve\)/.test(cut));
  c.ok("…and the page passes the link flag only for a TOKEN actor", /linkVisitor: actor\.kind === "TOKEN",/.test(src("src/components/portal/PortalPage.tsx")));

  // =========================================================================
  c.head("A3 · a client who plans their own content");
  // =========================================================================
  const cpHome = homeActions({ ...base, planning: { planningMode: "UNDECIDED", callStatus: "NOT_SCHEDULED", noCallEligible: false }, clientPlanned: { briefIn: false, monthLabel: "October 2026" }, session: { offerBooking: true, required: 1, missing: 1 } });
  const cpKinds = all(cpHome).map((a) => a.kind);
  c.ok("Home: book filming first, the brief after; never a call, a route or topics", cpHome.primary?.kind === "BOOK_SESSION" && cpKinds.includes("ADD_BRIEF") && !cpKinds.some((k) => ["BOOK_CALL", "CHOOSE_ROUTE", "PICK_TOPICS", "ANSWER_QUESTIONS"].includes(k)), cpKinds.join(","));
  const month = { route: "UNDECIDED", call: "NONE", videosOwed: 4, chosen: 0, extras: 0, counts: emptyCounts(), answersOwed: 0, missingAnswers: 0, approved: 0, topics: [], headline: { key: "CLIENT_PLANNED", text: "x" }, progress: null, clientPlanned: true } as unknown as Parameters<typeof yourMonthSteps>[0]["month"];
  const stepsFor = (callMode: string, callStatus: string) => yourMonthSteps({
    monthLabel: "October", month, can: { suggest: true, session: true }, readOnly: false,
    planning: { callMode, planningMode: "UNDECIDED", callStatus, callAtISO: null, noCallEligible: false, chosenAtISO: null, deferredAtISO: null },
    schedule: { locked: false, reason: "", earliestISO: null, sessionsRequired: 1, sessionsMissing: 1, pendingRequest: false, capacityRemaining: 1 },
    hrefs: { bank: "?b", month: "?m", scripts: "?s", bookingUrl: "?tab=plan#step-call" },
    clientPlanned: { briefFiles: 0, briefNotes: false },
  }).map((s) => s.key).join(",");
  c.ok("Your Month: brief, then filming, with calls off", stepsFor("NOT_INCLUDED", "NOT_REQUIRED") === "brief,filming", stepsFor("NOT_INCLUDED", "NOT_REQUIRED"));
  c.ok("…and with calls on: still no strategy-call step", stepsFor("REQUIRED", "NOT_SCHEDULED") === "brief,filming", stepsFor("REQUIRED", "NOT_SCHEDULED"));
  const normal = homeActions({ ...base, session: { offerBooking: false, required: 1, missing: 1 } });
  c.ok("a client we plan for is still asked to book the strategy call", normal.primary?.kind === "BOOK_CALL");

  // =========================================================================
  c.head("C14 · one booking action, one place to book");
  // =========================================================================
  const both = homeActions({ ...base, planning: { planningMode: "WRITTEN", callStatus: "NOT_REQUIRED" }, session: { offerBooking: true, required: 1, missing: 1 }, lateSession: { label: "September", open: true, combined: false } });
  const books = all(both).filter((a) => a.kind === "BOOK_SESSION");
  c.ok("a late session and this month's both open: ONE action, to the card that books both (no duplicate key)", books.length === 1 && books[0].href === "?tab=plan#step-late" && /September/.test(books[0].detail ?? ""), JSON.stringify(books));
  const lateOnly = homeActions({ ...base, planning: { planningMode: "WRITTEN", callStatus: "NOT_REQUIRED" }, lateSession: { label: "September", open: true, combined: false } });
  c.ok("…only the late one open: 'Book your September session'", all(lateOnly).filter((a) => a.kind === "BOOK_SESSION").map((a) => a.title).join("|") === "Book your September session");
  const addr = homeActions({ ...base, planning: { planningMode: "WRITTEN", callStatus: "NOT_REQUIRED" }, addressNeeded: 1 });
  c.ok("the missing address is added in Your Month's filming step, not Schedule", all(addr).find((a) => a.kind === "COMPLETE_ADDRESS")?.href === "?tab=plan#step-filming");
  c.ok("Home keys 'Also waiting on you' by kind and address", /key=\{`\$\{a\.kind\}:\$\{a\.href\}`\}/.test(src("src/components/portal/tabs/HomeTab.tsx")));

  const futureCall = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const futureShoot = new Date(Date.now() + 9 * 86_400_000).toISOString();
  const sm = (over: Record<string, unknown>) => ({
    monthId: "m10", monthKey: "2026-10", locked: false, reason: "", earliestISO: null, callStatus: "SCHEDULED", callAtISO: futureCall, planningMode: "CALL",
    capacity: { allowed: 1, used: 1, remaining: 0 }, requests: [], bookedShootISO: futureShoot,
    sessions: [{ key: "s1", sessionIndex: 1, startISO: futureShoot, state: "BOOKED", label: "Booked", area: "Media, PA", addressNeeded: false, addressNote: null }],
    sessionsRequired: 1, sessionsMissing: 0, bookingMode: "SELF", sessionIndex: null, sessionGates: [], takenIndexes: [1], deferredAtISO: null, ...over,
  });
  const planning = { monthId: "m10", monthKey: "2026-10", timezone: "America/New_York", callStatus: "SCHEDULED", callAtISO: futureCall, meetLink: null, catchUp: null, late: null } as never;
  const html = renderToStaticMarkup(createElement(ComingUpList, {
    planning, perms: { session: true }, readOnly: false, topicsHref: "?tab=plan", topicsLabel: "Your Month",
    months: [sm({}) as never, sm({ monthId: "m11", monthKey: "2026-11", sessions: [], sessionsMissing: 1, capacity: { allowed: 1, used: 0, remaining: 1 }, takenIndexes: [] }) as never],
  }));
  c.ok("Coming up lists the booked call and filming session, each changed in Your Month", /Strategy call/.test(html) && /Filming session/.test(html) && html.includes("?tab=plan&amp;month=2026-10#step-call") && html.includes("?tab=plan&amp;month=2026-10#step-filming"), html.slice(0, 300));
  c.ok("…the month still to book links to Your Month, and there is no picker, history or Calendly wording", /Still to book/.test(html) && html.includes("?tab=plan&amp;month=2026-11#step-filming") && !/Calendly|all program months|Book the call|Pick a day/.test(html));
  const sched = src("src/components/portal/ComingUp.tsx");
  c.ok("the coming-up list imports no picker and no booking control", !/PortalScheduler|PortalCallPicker|ScheduleLaterButton/.test(sched));
  const yourMonthHtml = renderToStaticMarkup(createElement(ComingUpList, {
    planning, perms: { session: true }, readOnly: false, topicsHref: "?tab=plan", topicsLabel: "Your Month", excludeMonthIds: ["m10"], includeCall: false,
    months: [sm({}) as never, sm({ monthId: "m11", monthKey: "2026-11", sessions: [], sessionsMissing: 1, capacity: { allowed: 1, used: 0, remaining: 1 }, takenIndexes: [] }) as never],
  }));
  c.ok("Your Month's 'Also coming up' leaves out the month its steps already show (no call, no October session), and keeps November to book", !/Strategy call|Filming session/.test(yourMonthHtml) && /Still to book/.test(yourMonthHtml) && yourMonthHtml.includes("?tab=plan&amp;month=2026-11#step-filming"), yourMonthHtml.slice(0, 300));

  // =========================================================================
  c.head("Oct 21 2026 · Messages in the bottom bar");
  // =========================================================================
  const bar = nav.portalNav({ publishedResources: 0, badges: { messages: 2, plan: 1 } });
  c.ok("the bar: Home, Month, Library, Messages, More (Schedule's slot is Messages')", bar.primary.map((i) => i.dest).join(",") === "home,plan,library,messages,more", bar.primary.map((i) => i.dest).join(","));
  c.ok("the unread count rides on Messages, not More", bar.primary.find((i) => i.dest === "messages")?.badge === 2 && bar.primary.find((i) => i.dest === "more")?.badge === 0);
  c.ok("More reaches booking, changing and cancelling a session (Your Month's filming step), and no longer lists Messages", bar.more.some((i) => i.dest === "plan" && i.anchor === "step-filming") && !bar.more.some((i) => i.dest === "messages"));
  const old = nav.resolvePortalRoute({ tab: "schedule" });
  c.ok("an old ?tab=schedule lands on Your Month", old.dest === "plan" && old.planView === "month" && !(nav.PORTAL_DESTS as readonly string[]).includes("schedule"));
  c.ok("Messages lights itself in the bar, not More", nav.primaryDestOf("messages") === "messages");
  const home = src("src/components/portal/tabs/HomeTab.tsx");
  c.ok("Home's month card lists what is coming up from the one list, and no longer links to a Schedule page", /<ComingUpList \{\.\.\.props\} \/>/.test(home) && !/href\("schedule"\)/.test(home));
  c.ok("the bar's targets stay 48px on a phone", /min-h-12/.test(src("src/components/portal/PortalShell.tsx")));

  // =========================================================================
  c.head("C14 · hidden controls and plain words");
  // =========================================================================
  const ym = src("src/components/portal/YourMonth.tsx");
  c.ok("Your Month: no 'Schedule later' button and no link out to Schedule for filming", !/ScheduleLaterButton/.test(ym) && !/Manage filming in Schedule|Reschedule or cancel/.test(ym));
  c.ok("Your Month: a call booked with no call step is managed here (#step-call)", /id="step-call"/.test(ym) && /<PortalCallPicker view=\{d\.callBooking\} \/>/.test(ym));
  const tb = code("src/components/portal/TopicBank.tsx");
  c.ok("Topic bank: keeps Choose and Suggest; hides Discuss, Not interested, the swap strip, the filter chips and the topic history", /CTA_WORDS\.CHOOSE/.test(tb) && /Suggest a video idea of your own/.test(tb) && !/> Discuss<|Not interested|Scripted, not filmed<|aria-label="Filter topics"|More about this topic/.test(tb) && /Topic area \(optional\)/.test(tb));
  c.ok("Posting kit: no 'Mark as posted'", !/Mark as posted|Posted\?/.test(code("src/components/portal/PostingKitPanel.tsx")));
  const plan = src("src/components/portal/tabs/PlanTab.tsx");
  // Oct 20 2026 (audit E9): the switched-off correction box is deleted, so read-only is the only shape left.
  // Oct 23 2026 (Jordan): the Strategy sub-tab is back for every client, still read-only.
  c.ok("Your Month: a Strategy sub-tab for every client, read-only", /\{ key: "strategy" as const, label: "Strategy"/.test(plan) && !/\.\.\.\(d\.view === "strategy" \?/.test(plan) && !/canSuggest|ProposeCorrection/.test(src("src/components/portal/tabs/StrategyTab.tsx")));
  c.ok("Settings & Team: the shared link gets a sign-in prompt, never 'switched on'", /if \(d\.viewerKind === "TOKEN"\)/.test(src("src/components/portal/tabs/SettingsTab.tsx")) && !/switched on/.test(src("src/components/portal/tabs/SettingsTab.tsx")));
  c.ok("the videographer is chosen for the client when more than one is free (booking needs one named)", /const defaultCreative = /.test(src("src/components/portal/PortalScheduler.tsx")) && /!!slot && slotCreatives\.length > 1 && !chosenCreative/.test(src("src/components/portal/PortalScheduler.tsx")));
  c.ok("businessDaysWords: 72 → 'three business days', 96 → 'four business days', 24 → 'one business day'", businessDaysWords(72) === "three business days" && businessDaysWords(96) === "four business days" && businessDaysWords(24) === "one business day");
  const clientFiles = ["src/components/portal/PortalScheduler.tsx", "src/components/portal/PlanningChoice.tsx", "src/components/portal/PortalPage.tsx", "src/components/portal/ComingUp.tsx", "src/components/portal/tabs/HomeTab.tsx", "src/components/portal/PortalSignIn.tsx"];
  c.ok("no '72 weekday hours', 'Planning in writing', 'Content session' or 'switched on' in the client pages", clientFiles.every((f) => !/72 weekday hours|weekday hours after|Planning in writing|Content session|switched on yet/.test(src(f))), clientFiles.filter((f) => /72 weekday hours|weekday hours after|Planning in writing|Content session|switched on yet/.test(src(f))).join(", "));
  c.ok("no unfinished-sounding copy: 'still linking your earlier topics', 'until the program launches'", !/still linking your earlier topics/.test(src("src/components/portal/tabs/HomeTab.tsx")) && !/until the program launches/.test(src("src/lib/postingKit.ts")));
  const dashFiles = ["src/lib/clientDecisions.ts", "src/lib/cutEntitlement.ts", "src/lib/portalTeam.ts"];
  const clientMessages = dashFiles.flatMap((f) => [...src(f).matchAll(/message: ([`"])([^`"]*)\1/g)].map((m) => m[2]));
  c.ok("client decision messages carry no em dash", clientMessages.length > 10 && clientMessages.every((m) => !/—/.test(m)), clientMessages.filter((m) => /—/.test(m)).slice(0, 2).join(" | "));
  const ent = src("src/lib/cutEntitlement.ts");
  c.ok("the download block's words carry no em dash", !/(CHANGES|DRIFT|REISSUE|UNPAIRED|NOT_YET): [`"][^`"]*—/.test(ent));

  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
