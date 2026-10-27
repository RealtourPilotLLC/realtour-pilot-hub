// ---------------------------------------------------------------------------
// DRILL: Monthly Content, cleaned up (Jordan's Loom, Oct 27 2026, 15:54-30:49).
//
//   DRILL_PORT=5624 node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-content-ui.ts
//
// "this is really messy ... all of these little chips ... make it look much
//  nicer and easy to identify where people are at and what they're waiting on."
//
//   1. The status line: one sentence per client saying who it waits on
//      ("Waiting on Bernadette: answer 1 topic and book the October session"),
//      the other side's asks in one "also" clause, the booking-reminder line.
//   2. On a real database (PGlite): an unbooked session is the CLIENT's
//      ("That's not on us, that's on them"); "overdue" says what is overdue
//      and never fires for a client still waiting on their strategy; the
//      brand discovery call is shown for new clients only.
//   3. "1 of 3" page markers are gone from the strategy (staff and portal).
//   4. Strategy proposals talk to the content manager, not editors; month
//      notes go to the month's priorities.
//   5. Revisions: done means done (task closed, approved later cut, or every
//      item ticked), not "0 of 1 done".
//   6. Brand: "Colors" with swatches; no "N filled" counter; the agent
//      profile is not printed twice.
//   7. The term starts at the earliest evidence (imported history counts),
//      not "August 2026" for everyone.
//   8. The page wiring: Send reminder now asks first and is office-only; the
//      roster opens on the table; Settings is grouped; "Add one manually".
//
// ISOLATION: PGlite via the shared harness; nothing is sent (fenceFetch).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5624);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
/** The source without its comments: the dated comments quote Jordan's old words on purpose. */
const code = (rel: string) => read(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
function et(y: number, mo: number, d: number, h: number, mi = 0): Date {
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, mo - 1, d, h + off, mi));
    const p = Object.fromEntries(ET_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error(`no such ET wall time ${y}-${mo}-${d} ${h}:${mi}`);
}

installNextStubs();
const fence = fenceFetch();

async function main() {
  const c = makeChecker();

  // =========================================================================
  c.head("1 · one plain status line per client");
  // =========================================================================
  const S = await import("@/lib/contentStatusLine");
  const base = {
    monthKey: "2026-10", closed: false, strategy: null, callProblem: false, reconcile: false, callAsk: null,
    answersOwed: 0, topicsToPick: 0, strategyToApprove: 0, scriptsToApprove: 0, scriptsToWrite: 0, sessionRequests: 0,
    sessionsToBook: 0, lateHostMonthKey: null, unverified: 0, heldUnconfirmed: 0, videosToApprove: 0, videosToSend: 0,
    cutsWithClient: 0, videosInProduction: 0, scriptRequests: 0,
  } as const;
  const bern = S.waitingFor({ ...base, answersOwed: 1, sessionsToBook: 1 });
  const bernLine = S.statusLine({ clientName: "Bernadette Rabel", waiting: bern, nextAction: { blocked: "client", text: "Book the session" } });
  c.ok("Bernadette: 'Waiting on Bernadette: answer 1 topic and book the October session'", bernLine.sentence === "Waiting on Bernadette: answer 1 topic and book the October session" && bernLine.side === "them", bernLine.sentence);
  const ours = S.waitingFor({ ...base, scriptsToApprove: 1, sessionsToBook: 1 });
  const oursLine = S.statusLine({ clientName: "Kristen Smith", waiting: ours, nextAction: { blocked: "us", text: "Approve the script" } });
  c.ok("ours first when the next step is ours, theirs as one 'also' clause", oursLine.sentence === "Waiting on us: approve 1 script" && oursLine.also === "Kristen also needs to book the October session", `${oursLine.sentence} | ${oursLine.also}`);
  const two = S.waitingFor({ ...base, sessionsToBook: 2 });
  c.ok("two sessions: 'book 2 October sessions'", two.them[0]?.text === "book 2 October sessions", two.them[0]?.text);
  const late = S.waitingFor({ ...base, monthKey: "2026-09", sessionsToBook: 1, lateHostMonthKey: "2026-10" });
  c.ok("a late month says where it films", late.them[0]?.text === "book September's session (filming in October)", late.them[0]?.text);
  const newClient = S.waitingFor({ ...base, strategy: "discovery_needed", answersOwed: 3, sessionsToBook: 1 });
  c.ok("a new client waits on the brand discovery call, and nothing else is asked yet", newClient.them.length === 1 && newClient.them[0].key === "book_discovery" && newClient.us.length === 0, JSON.stringify(newClient));
  const writeHeld = S.waitingFor({ ...base, answersOwed: 1, scriptsToWrite: 4 });
  c.ok("'write 4 scripts' waits until the answers are in (no noise beside 'answer 1 topic')", !writeHeld.us.some((x) => x.key === "write_scripts") && S.waitingFor({ ...base, scriptsToWrite: 4 }).us[0]?.text === "write 4 scripts");
  const none = S.statusLine({ clientName: "Joe Sutow", waiting: { them: [], us: [] }, nextAction: { blocked: "nobody", text: "Filming Wed, Oct 28 — all set" } });
  c.ok("nothing pending: plain words, no side, no dash", none.side === "none" && none.sentence === "Filming Wed, Oct 28. all set", none.sentence);
  c.ok("names: first name for a person, whole name for a business, TEST dropped", S.clientCallName("Bernadette Rabel") === "Bernadette" && S.clientCallName("The Smith Group") === "The Smith Group" && S.clientCallName("Wes Written TEST") === "Wes", S.clientCallName("Wes Written TEST"));
  const now = et(2026, 10, 27, 12);
  c.ok("booking reminder: emailed daily, last sent Oct 27", S.bookingReminderLine({ lastBookingSentAt: et(2026, 10, 27, 9), snoozedUntil: null }, now).text === "Booking reminder emailed daily, last sent Oct 27");
  c.ok("booking reminder: none yet is worth a look", S.bookingReminderLine({ lastBookingSentAt: null, snoozedUntil: null }, now).tone === "attention");
  c.ok("booking reminder: paused (Mike Ciunci's October snooze) says so", /^Booking reminders paused until Nov/.test(S.bookingReminderLine({ lastBookingSentAt: et(2026, 10, 20, 9), snoozedUntil: et(2026, 11, 1, 0) }, now).text));
  c.ok("booking reminder: a week quiet is worth a look", S.bookingReminderLine({ lastBookingSentAt: et(2026, 10, 19, 9), snoozedUntil: null }, now).tone === "attention");
  const anyDash = [bernLine, oursLine, none].some((l) => /[—–]/.test(`${l.sentence} ${l.also ?? ""}`));
  c.ok("no em or en dashes in the status words", !anyDash);

  // =========================================================================
  c.head("2 · on a database: whose move, and what is overdue");
  // =========================================================================
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  try {
    const B = await buildContentMonth(db, { name: "Bernie Booker TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", project: false, owner: { email: "info+drill-bernie@realtourpilot.com" } });
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { clientSuppliesTopics: true, strategyCallRequired: false } });
    const N = await buildContentMonth(db, { name: "Nadia Newcomer TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", project: false, strategy: false, owner: { email: "info+drill-nadia@realtourpilot.com" } });
    const { programOverview } = await import("@/lib/programOverview");
    const all = await programOverview({ monthKey: "2026-10", now });
    const b = all.rows.find((r) => r.enrollmentId === B.enrollmentId);
    const n = all.rows.find((r) => r.enrollmentId === N.enrollmentId);
    c.ok("both clients have a row", !!b && !!n, all.rows.map((r) => r.clientName).join(", "));
    if (b && n) {
      c.ok("Bernie: the next step is booking the session, and it is the CLIENT's", b.nextAction.kind === "book_session" && b.nextAction.blocked === "client", `${b.nextAction.kind} / ${b.nextAction.blocked} / ${b.nextAction.text}`);
      c.ok("Bernie's line: 'Waiting on Bernie: book the October session'", S.statusLine(b).sentence === "Waiting on Bernie: book the October session", S.statusLine(b).sentence);
      c.ok("the button no longer says 'Book the session' (we don't book it)", b.nextAction.cta !== "Book the session", String(b.nextAction.cta));
      c.ok("Oct 27 with no session booked: 'Due soon', with the reason in words", b.overdue?.kind === "soon" && /October ends .+ and no filming session is booked/.test(b.overdue.why), JSON.stringify(b.overdue));
      c.ok("an established client is not a new client (no brand discovery line)", b.newClient === null);
      c.ok("Nadia (strategy not released yet) is never 'overdue'", n.overdue === null, JSON.stringify(n.overdue));
      c.ok("Nadia waits on her strategy only: the brand discovery call or our build", (n.waiting.them.some((x) => x.key === "book_discovery") || n.waiting.us.some((x) => x.key === "build_strategy")) && !n.waiting.them.some((x) => x.key === "book_session"), JSON.stringify(n.waiting));
      c.ok("Nadia is marked a new client", n.newClient !== null, JSON.stringify(n.newClient));
      const filter = (await import("@/lib/programOverview")).OVERVIEW_FILTERS.find((f) => f.key === "overdue");
      c.ok("the filter says what it means: 'Overdue or due soon'", filter?.label === "Overdue or due soon", filter?.label);
    }

    // =======================================================================
    c.head("7 · the term starts at the earliest evidence");
    // =======================================================================
    const E = await import("@/lib/entitlements");
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { startedAt: null } });
    const before = await E.entitlementSummary(B.enrollmentId, { now, sessions: false });
    c.ok("no history: the first live month (October 2026)", before?.term.start === "2026-10", JSON.stringify(before?.term));
    await prisma.contentMonth.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, monthKey: "2025-06", videosOwed: 1, status: "CLOSED", historical: true } });
    const after = await E.entitlementSummary(B.enrollmentId, { now, sessions: false });
    c.ok("an imported June 2025 month: the term started June 2025, not the hub's first month", after?.term.start === "2025-06" && /first program month/.test(after.term.basis), JSON.stringify(after?.term));
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { startedAt: et(2025, 3, 10, 12) } });
    const started = await E.entitlementSummary(B.enrollmentId, { now, sessions: false });
    c.ok("an enrollment started in March 2025: March 2025", started?.term.start === "2025-03", JSON.stringify(started?.term));
    await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { termStartMonth: "2025-01" } });
    const signed = await E.entitlementSummary(B.enrollmentId, { now, sessions: false });
    c.ok("a signed start on file still wins", signed?.term.start === "2025-01" && /set by the office/.test(signed.term.basis), JSON.stringify(signed?.term));
    const core = await import("@/lib/entitlementsCore");
    c.ok("earliestMonthKey ignores junk and takes the earliest", core.earliestMonthKey([null, "2026-08", "junk", "2025-11", undefined]) === "2025-11" && core.earliestMonthKey([]) === null);
  } finally {
    quiet.restore();
  }

  // =========================================================================
  c.head("3 · no '1 of 3' in the strategy");
  // =========================================================================
  const D = await import("@/components/content/StrategyDocView");
  const raw = "Who she serves\nFirst-time buyers in Malvern.\n\n-- 1 of 3 --\n\nWhat she is known for\n3 of 3\nLocal knowledge. -- 2 of 3 -- Straight talk.";
  const stripped = D.stripPageMarkers(raw);
  c.ok("page markers are stripped, every other word kept", !/\bof 3\b/.test(stripped) && ["Who she serves", "First-time buyers in Malvern.", "What she is known for", "Local knowledge.", "Straight talk."].every((w) => stripped.includes(w)), JSON.stringify(stripped));
  const blocks = D.sectionBlocks({ id: "x", heading: "Positioning", text: raw });
  c.ok("the staff view's blocks carry no marker", !JSON.stringify(blocks).includes("of 3"), JSON.stringify(blocks));
  c.ok("isPageMarker: '3 of 3', '-- 1 of 3 --', 'Page 2 of 3' yes; a sentence no", D.isPageMarker("3 of 3") && D.isPageMarker("-- 1 of 3 --") && D.isPageMarker("Page 2 of 3") && !D.isPageMarker("1 of 3 buyers here are first-timers"));
  const portalStrategy = read("src/components/portal/tabs/StrategyTab.tsx");
  c.ok("the client portal's strategy drops the markers too", /isPageMarker/.test(portalStrategy) && /stripPageMarkers/.test(portalStrategy));

  // =========================================================================
  c.head("4 · proposals talk to the content manager; month notes go to the priorities");
  // =========================================================================
  const P = await import("@/lib/proposalWording");
  c.ok("'Editors should weight educational content' → the content manager", P.forContentManager("Editors should weight educational content as the default.") === "The content manager should weight educational content as the default.", P.forContentManager("Editors should weight educational content as the default."));
  c.ok("the editor brief stays the editor brief", P.forContentManager("Add it to the editor brief.") === "Add it to the editor brief.");
  c.ok("a note about October belongs to October's priorities", P.isMonthScopedProposal({ summary: "Lead October with the open house series", impact: null }, "October 2026") && P.isMonthScopedProposal({ summary: "Ask about this on the follow-up call", impact: null }, "October 2026"));
  c.ok("a lasting positioning change stays a strategy proposal", !P.isMonthScopedProposal({ summary: "Position her as the Main Line downsizing expert", impact: "Every month's topics lean on it" }, "October 2026"));
  c.ok("'may' the verb is not May the month", !P.isMonthScopedProposal({ summary: "She may want more skits", impact: null }, "May 2026"));
  const panel = code("src/components/content/StrategyPanel.tsx");
  c.ok("'How to apply it, optional' is gone from the Strategy tab", !/how to apply it/i.test(panel), "");
  c.ok("the month's priorities say where they are used", /Used when the hub writes this month(?:'|&rsquo;)s topic ideas and scripts/.test(panel));

  // =========================================================================
  c.head("5 · revisions: done means done");
  // =========================================================================
  const R = await import("@/lib/revisionAskStatus");
  c.ok("the revision task closed: Done (not '0 of 1 done')", R.revisionAskStatus({ total: 1, done: 0, taskStatus: "COMPLETED", editorName: "Kim", laterCut: null }).word === "Done");
  c.ok("a later cut approved: done", !R.revisionAskStatus({ total: 1, done: 0, taskStatus: null, editorName: null, laterCut: { status: "APPROVED" } }).open);
  c.ok("a later cut waiting: 'New cut uploaded, waiting for review'", R.revisionAskStatus({ total: 2, done: 0, taskStatus: "OPEN", editorName: "Kim", laterCut: { status: "PENDING" } }).word === "New cut uploaded, waiting for review");
  c.ok("with the editor: who has it", R.revisionAskStatus({ total: 2, done: 1, taskStatus: "OPEN", editorName: "Kim", laterCut: null }).word === "With Kim, 1 of 2 items ticked");
  c.ok("nobody on it says so", R.revisionAskStatus({ total: 1, done: 0, taskStatus: null, editorName: null, laterCut: null }).word === "Not with an editor yet");
  const prod = read("src/app/content/[id]/tabs/ProductionTab.tsx");
  c.ok("each ask shows the client's words and when it came in", /clientWords/.test(prod) && /Came in/.test(prod));
  const filming = prod.slice(prod.indexOf('title="Filming sessions"'));
  c.ok("'Repair a missing session link' lives inside Filming sessions now", filming.indexOf("<UnlinkedSessionLinker") > -1 && filming.indexOf("<UnlinkedSessionLinker") < filming.indexOf("</Section>") && !/Repair a missing session link/.test(code("src/components/content/UnlinkedSessionLinker.tsx")));
  const lib = code("src/components/content/ContentLibraryPanel.tsx");
  c.ok("'never shown to them' is said plainly", !/never shown to them/.test(lib) && /not sent to the client yet/.test(lib));

  // =========================================================================
  c.head("6 · brand: Colors, swatches, no counters, no repeats");
  // =========================================================================
  const CS = await import("@/lib/colorSwatches");
  const sw = CS.colorSwatches("Navy #1B2A4A and gold (#D4AF37), no hue shift");
  c.ok("hex codes and color names become swatches, in order", JSON.stringify(sw.map((s) => s.css)) === JSON.stringify(["navy", "#1b2a4a", "gold", "#d4af37"]), JSON.stringify(sw));
  c.ok("words with no color get no swatch", CS.colorSwatches("Warm, bright, no hue").length === 0 && CS.colorSwatches(null).length === 0);
  const assets = await import("@/lib/clientAssets");
  c.ok("the palette is labelled 'Colors'", assets.ASSET_TYPE_WORDS.COLOR_PALETTE === "Colors");
  const bap = code("src/components/content/BrandAssetsPanel.tsx");
  c.ok("the brand card shows 'Colors' with swatches and no longer repeats the agent profile", /label: "Colors"/.test(bap) && /<ColorText/.test(bap) && !/AI profile ·/.test(bap) && !/Brand colours/.test(bap));
  const ws = code("src/components/content/Workspace.tsx");
  c.ok("no 'N filled' counter on the agent profile", !/filled`/.test(ws) && !/\bfilled\b.*: "empty"/.test(ws));

  // =========================================================================
  c.head("8 · the page wiring");
  // =========================================================================
  const btn = read("src/components/content/SendReminderButton.tsx");
  const act = read("src/app/content/bookingReminderActions.ts");
  c.ok("Send reminder now asks first (a confirm dialog), then sends", /<ModalDialog/.test(btn) && /checkBookingReminder\(/.test(btn) && /sendBookingReminderNow\(/.test(btn));
  c.ok("…office only, the booking ask only, through the reminder engine's own send", /requireAdmin/.test(act) && /BOOK_SESSION/.test(act) && /sendReminderNow\(/.test(act));
  const mon = read("src/app/content/monitoring/page.tsx");
  c.ok("Monitoring lists the sessions not booked, with the button for the office", /title="Sessions not booked"/.test(mon) && /canRemind && r\.monthId && <span className="ml-auto"><SendReminderButton/.test(mon));
  const page = read("src/app/content/page.tsx");
  c.ok("the roster groups by who it waits on", /Waiting on us/.test(page) && /Waiting on the client/.test(page));
  const nav = await import("@/lib/contentNav");
  c.ok("the roster opens on the table ('The table looks okay')", nav.resolveRosterView(null, null) === "table" && nav.resolveRosterView("cards", null) === "cards");
  c.ok("the chips are gone: no BlockedChip, no MonthJourney on the card", !/BlockedChip/.test(code("src/components/content/OverviewRow.tsx")) && !/<MonthJourney\b/.test(code("src/components/content/ClientMonthCard.tsx")));
  const settings = read("src/app/content/[id]/tabs/SettingsTab.tsx");
  c.ok("Settings is grouped, each group with one line", (settings.match(/<SettingsGroup title=/g) ?? []).length === 4);
  c.ok("complaints: adding one by hand is the quiet 'Add one manually'", /addManually \/>/.test(settings) && /"Add one manually"/.test(read("src/components/clientCare/ClientIssuesCard.tsx")));
  const tabs = read("src/app/content/[id]/page.tsx");
  c.ok("the Messages tab shows a message-with-a-dot and 'N new' when the client wrote", /MessageSquareDot/.test(tabs) && /`\$\{n\} new`/.test(tabs));

  c.ok("nothing left this process", fence.blocked.length === 0, fence.blocked.join(" "));
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
