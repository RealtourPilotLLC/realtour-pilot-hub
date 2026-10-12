// ---------------------------------------------------------------------------
// DRILL: film a late month's session this month (Oct 12 2026).
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct12-late-session.ts
//
// Jordan: "We have been waiting on Arielle to schedule her September content
// session. I already sent the scripts. We also need her to schedule her
// October session and strategy call, or pick topics instead (she preferred
// that). Can we make sure we have an option for that?"
//
//   §1 the picker: an over, OPEN, PLANNED month with no session is pickable;
//      a month with nothing planned (forfeited) and one with a shoot say why;
//      the over month's own page offers "Film September's session in October".
//   §2 auth: owner/admin only for apply, undo, the message and the planning
//      control — an editor, a signed-out caller and a "view as" preview are
//      refused and nothing is written; the portal has no such action.
//   §3 apply: nothing moves (both months keep their videos and one session),
//      September stays OPEN, the record + ledger say who/when, September's
//      old escalation closes, it is NOT forfeited, the skip toggle and a
//      catch-up can't half-undo it, and a second one is refused.
//   §4 September's own readers: not overdue on the roster, "Filming late, in
//      October", due Oct 31; its reminders run on October's calendar with
//      "booking in October" (no roll-over warning, no September deadline).
//   §5 the portal: Your Month for October says "Your September session still
//      needs booking, and October's too", one scheduler with both sessions —
//      "September session (your scripts are ready)" gated by September's plan
//      (open), "October session" gated by October's (locked) — September's
//      released scripts in full; Home offers "Book your September session";
//      ?month=2026-09 keeps Your Month on October.
//   §6 the staff planning control: October → client picks topics (what the
//      portal's own choice writes); a held call refuses the written route.
//   §7 copy a message: Jordan's words, her portal link, no em dash — and
//      nothing sent.
//   §8 booking the September slot: the address and the times accept the late
//      month (an over month without the record is still refused), the request
//      is filed on SEPTEMBER, Kyle's desk task says so, the Aryeo shoot dated
//      in October is attached to SEPTEMBER (October's own shoot stays on
//      October), the reconcile confirms it; office counts: September 1/1,
//      October 0/1; the portal line moves to "booked for Wednesday, October 21".
//   §9 undo: refused once booked; on a second client exact while nothing is
//      booked. The scripts gate: no scripts and none sent → locked in plain
//      words, the tab drops "(your scripts are ready)"; sent outside → open.
//  §10 nothing sent, nothing booked with a provider.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness). Production is never opened;
// every non-loopback call is fenced (the census geocoder answers from here).
// THE CLOCK IS PINNED to Mon Oct 12 2026 10:00 ET.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5651);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 12, 14, 0, 0); // Mon Oct 12 2026, 10:00 EDT
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
/** An EDT wall-clock time in 2026. */
const et = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
const now = () => new RealDate(RealDate.now() + offset);

installNextStubs();
process.env.PROGRAM_DESK_TASKS_FOR_TEST = "1"; // Kyle's desk row for a TEST client, so its words can be read

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct12-late-session" } });
  const fence = fenceFetch(async (url) => {
    if (url.startsWith("https://geocoding.geo.census.gov/")) return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: "FIXTURE ADDRESS" }] } }));
    return null;
  });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/content/actions");
    const portalActions = await import("@/app/portal/actions");
    const ls = await import("@/lib/monthLateSession");
    const core = await import("@/lib/lateSession");
    const pm = await import("@/lib/programMonths");
    const portal = await import("@/lib/portal");
    const mp = await import("@/lib/monthProgress");
    const srq = await import("@/lib/sessionRequests");
    const reminders = await import("@/lib/programReminders");
    const cu = await import("@/lib/monthCatchUp");
    const { forfeitedMonths } = await import("@/lib/monthForfeit");
    const { programOverview } = await import("@/lib/programOverview");
    const { attachMonthlyProjects } = await import("@/lib/contentProgram");
    const { homeActions } = await import("@/lib/portalHome");
    const { appBase } = await import("@/lib/appUrl");

    // Client components render for real (renderToStaticMarkup); the router is a no-op.
    const load = createRequire(__filename);
    for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
      navigation.useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} });
      navigation.usePathname = () => "/portal/x";
      navigation.useSearchParams = () => new URLSearchParams();
    }
    const { YourMonth } = await import("@/components/portal/YourMonth");
    const { PortalPage } = await import("@/components/portal/PortalPage");
    const { LateSessionControl } = await import("@/components/content/LateSessionControl");
    const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
    const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|\u2019/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@late.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@late.test", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Kim", email: "kim@late.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    // ---- Arielle, as production holds her (Oct 12) --------------------------
    // Starter, 1 session × 2 videos, strategy calls on (callMode unset, the
    // flag true). September: call held Sep 11, its two scripts written and
    // shared (here they are in the hub; §9 covers "sent outside it"), no
    // session. October: open, nothing yet. August: open, nothing at all
    // (forfeited). July: open, a shoot linked.
    const A = await buildContentMonth(prisma, { name: "Arielle Roemer TEST", package: "Starter", monthKey: "2026-10", project: false, owner: false });
    await prisma.client.update({ where: { id: A.clientId }, data: { email: "info+latedrill@realtourpilot.com" } });
    await prisma.contentEnrollment.update({ where: { id: A.enrollmentId }, data: { strategyCallRequired: true, callMode: null } });
    const sep = await prisma.contentMonth.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthKey: "2026-09", videosOwed: 2, status: "OPEN", strategyCallStatus: "COMPLETED", strategyCallAt: et(9, 11, 14, 30) } });
    const sepCall = await prisma.programCallRecord.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, callType: "MONTHLY_STRATEGY", monthId: sep.id, targetMonthKey: "2026-09", status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(9, 11, 14, 30), scheduledEnd: et(9, 11, 15), transcriptState: "CONFIRMED" } });
    await prisma.contentMonth.update({ where: { id: sep.id }, data: { callRecordId: sepCall.id } });
    const sepScripts: { title: string; body: string }[] = [
      { title: "Why spring listings sell faster", body: "Hook: Spring buyers move fast.\nTalking Point 1: Inventory is low.\nClose: Call me before you list." },
      { title: "Three fixes before photos", body: "Hook: Fix these three things first.\nTalking Point 1: Paint the front door.\nClose: Want my checklist? Message me." },
    ];
    for (const [i, s] of sepScripts.entries()) {
      const t = await prisma.contentTopic.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: sep.id, title: s.title, source: "staff", status: "SCRIPTED", clientVisible: true } });
      await prisma.contentTopicSelection.create({ data: { topicId: t.id, monthId: sep.id, enrollmentId: A.enrollmentId, clientId: A.clientId, status: "SELECTED", source: "staff", rank: i + 1 } });
      await prisma.contentScript.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: sep.id, topicId: t.id, title: s.title, body: s.body, status: "APPROVED", releaseState: "released" } });
    }
    await pm.recalcProgramMonth(sep.id, { now: now() });
    const aug = await prisma.contentMonth.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthKey: "2026-08", videosOwed: 2, status: "OPEN", strategyCallStatus: "NOT_SCHEDULED" } });
    const jul = await prisma.contentMonth.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthKey: "2026-07", videosOwed: 2, status: "OPEN", strategyCallStatus: "COMPLETED" } });
    await prisma.project.create({ data: { clientId: A.clientId, contentMonthId: jul.id, title: "July shoot TEST", status: "SHOT", shootDate: et(7, 20, 10) } });
    // Kyle's escalation for September's unbooked session (the old chasing).
    const esc = await prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title: "Arielle: 2026-09 still needs a content session booking", clientId: A.clientId, dedupeKey: `program-reminder-escalation:${sep.id}:BOOK_SESSION` } });

    const viewerOf = async (token: string | null) => { const r = await portal.resolvePortalViewer({ token: token ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; };
    const auth = { token: A.portalToken };
    const monthRow = (id: string) => prisma.contentMonth.findUniqueOrThrow({ where: { id } });
    const strip = <T extends { updatedAt?: Date }>(r: T) => { const { updatedAt: _u, ...rest } = r; void _u; return JSON.stringify(rest); };
    const bagOf = async (enrollmentId = A.enrollmentId) => (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: enrollmentId }, select: { overridesJson: true } })).overridesJson;
    const counts = async () => ({ outbox: await prisma.outboxMessage.count(), attempts: await prisma.programBookingAttempt.count() });
    const start = await counts();

    // The appointment feed is fresh (a reminder never chases off a dark feed).
    await prisma.connection.create({ data: { provider: "aryeo", status: "CONNECTED", lastSyncedAt: now() } });
    // Before anything: September's reminders chase an over month on its own calendar.
    const remBefore = (await reminders.previewReminders(sep.id, { now: now() })).lanes.find((l) => l.lane === "PRIMARY")!.candidate;
    c.ok("setup: September's booking reminder is due on September's calendar (the roll-over milestone, a passed Sep 28 deadline, an escalation)",
      remBefore.action === "BOOK_SESSION" && !remBefore.lateIn && remBefore.milestone === "MID_MONTH" && !!remBefore.escalation?.due && (remBefore.deadlineAt?.getTime() ?? 0) < et(10, 1, 0).getTime(),
      JSON.stringify({ a: remBefore.action, m: remBefore.milestone, d: remBefore.deadlineAt, e: remBefore.escalation, r: remBefore.reason }));
    const ovBefore = (await programOverview({ enrollmentIds: [A.enrollmentId], monthKey: "2026-09", now: now() })).rows.find((r) => r.monthKey === "2026-09")!;
    c.ok("setup: the roster reads September as overdue (its month is over, nothing booked)", ovBefore.flags.includes("overdue") && ovBefore.lateIn === null, JSON.stringify({ f: ovBefore.flags, n: ovBefore.nextAction.text }));

    // =======================================================================
    c.head("§1 · the picker: an over, planned month with no session");
    // =======================================================================
    const panel0 = (await ls.lateSessionPanel(A.monthId, { now: now() }))!;
    const opt = (key: string) => panel0.options.find((o) => o.monthKey === key);
    c.ok("October can bring one in, and lists its over OPEN months, newest first", panel0.hostRefusal === null && !panel0.carrying && panel0.options.map((o) => o.monthKey).join(",") === "2026-09,2026-08,2026-07", panel0.options.map((o) => `${o.monthKey}:${o.refusal}`).join(" | "));
    c.ok("September is pickable, with its 2 released scripts counted", opt("2026-09")?.refusal === null && opt("2026-09")?.scriptsReleased === 2, JSON.stringify(opt("2026-09")));
    c.ok("August (nothing planned) is refused: forfeited, approve a catch-up instead", /August has nothing planned \(no strategy call, topics or scripts\), so it is forfeited\. If you're making an exception, approve a catch-up instead\./.test(opt("2026-08")?.refusal ?? ""), opt("2026-08")?.refusal ?? "");
    c.ok("July is refused because a shoot is linked to it", /July already has a shoot linked to it \(Mon, Jul 20\)/.test(opt("2026-07")?.refusal ?? ""), opt("2026-07")?.refusal ?? "");
    const sepPanel0 = (await ls.lateSessionPanel(sep.id, { now: now() }))!;
    c.ok("September's own page offers 'Film September's session in October' (the first open month from now)", sepPanel0.offer?.hostMonthId === A.monthId && sepPanel0.offer.hostLabel === "October" && sepPanel0.offer.refusal === null && !sepPanel0.filmingIn, JSON.stringify(sepPanel0.offer));
    const offerHtml = text(html(createElement(LateSessionControl, { monthId: sep.id, monthName: "September", carrying: null, options: [], filmingIn: null, offer: { hostMonthId: A.monthId, hostLabel: "October", refusal: null, scriptsReleased: 2 } })));
    c.ok("…as one quiet link (an exception, not a step)", /Film September's session in October…/.test(offerHtml) && !/Bring September/.test(offerHtml), offerHtml.slice(0, 200));
    const nov = await prisma.contentMonth.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthKey: "2026-11", videosOwed: 2, status: "OPEN", strategyCallStatus: "NOT_SCHEDULED" } });
    const novPanel = (await ls.lateSessionPanel(nov.id, { now: now() }))!;
    c.ok("a future month can host too, but never lists October (not over yet)", !novPanel.options.some((o) => o.monthKey === "2026-10"));

    // =======================================================================
    c.head("§2 · auth: owner/admin only");
    // =======================================================================
    const bagBefore = await bagOf();
    const octBefore = await monthRow(A.monthId), sepBefore = await monthRow(sep.id);
    await clearSession();
    const anon = await actions.lateSessionAction(A.monthId, sep.id, false);
    const anonMsg = await actions.lateSessionMessageAction(sep.id);
    const anonPlan = await actions.setMonthPlanningAction(A.monthId, "TOPICS");
    await signIn(editor);
    const asEditor = await actions.lateSessionAction(A.monthId, sep.id, false);
    const editorUndo = await actions.undoLateSessionAction(sep.id);
    const editorPlan = await actions.setMonthPlanningAction(A.monthId, "TOPICS");
    await signIn(owner, admin.id);
    const asPreview = await actions.lateSessionAction(A.monthId, sep.id, false);
    c.ok("signed out, an editor, and an owner previewing as someone else are refused (apply, undo, message, planning)",
      [anon, anonMsg, anonPlan, asEditor, editorUndo, editorPlan, asPreview].every((r) => !r.ok), [anon, asEditor, asPreview].map((r) => r.message).join(" | "));
    c.ok("…and nothing was written", (await bagOf()) === bagBefore && strip(await monthRow(A.monthId)) === strip(octBefore) && strip(await monthRow(sep.id)) === strip(sepBefore));
    c.ok("the client's portal has no late-session or planning-override action", !Object.keys(portalActions).some((k) => /lateSession|filmLate|setMonthPlanning/i.test(k)));

    // =======================================================================
    c.head("§3 · apply (as Kyle, admin): nothing moves, September is booked in October");
    // =======================================================================
    await signIn(admin);
    const applied = await actions.lateSessionAction(A.monthId, sep.id, false);
    const oct1 = await monthRow(A.monthId), sep1 = await monthRow(sep.id);
    c.ok("applied with a plain sentence", applied.ok && applied.message === "October now brings in September's session: the client books both in the portal. September keeps its own topics, scripts and videos, and the session booked for it is filed on September.", applied.message);
    c.ok("September stays OPEN with its 2 videos; October keeps its 2; neither month row changed", sep1.status === "OPEN" && sep1.videosOwed === 2 && oct1.videosOwed === 2 && strip(sep1) === strip(sepBefore) && strip(oct1) === strip(octBefore));
    c.ok("each month still owes exactly one session (no catch-up count)", (await pm.sessionsRequiredForMonth(sep.id)) === 1 && (await pm.sessionsRequiredForMonth(A.monthId)) === 1);
    const rec = core.lateSessionOf(await bagOf(), "2026-09");
    c.ok("the record names both months, who and when", !!rec && rec.lateMonthId === sep.id && rec.hostMonthKey === "2026-10" && rec.hostMonthId === A.monthId && rec.by === "Kyle" && rec.scriptsSentOutside === false && Math.abs(new RealDate(rec.at).getTime() - now().getTime()) < 60_000, JSON.stringify(rec));
    const ledger = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId: A.enrollmentId } });
    c.ok("one ledger row says what happened, by Kyle", ledger.length === 1 && ledger[0].changedBy === "Kyle" && /Film September's session in October/.test(ledger[0].reason ?? "") && ledger[0].billingTruth === false && ledger[0].effectiveMonthKey === "2026-09", ledger.map((l) => l.reason).join(" | "));
    c.ok("Kyle's old escalation for September's booking is closed", (await prisma.smartTask.findUniqueOrThrow({ where: { id: esc.id } })).status === "COMPLETED");
    const forfeitNow = await forfeitedMonths([sep.id, aug.id], { now: now() });
    c.ok("September is not forfeited; August (untouched) still is", !forfeitNow.has(sep.id) && forfeitNow.has(aug.id));
    {
      // The rule itself: a month carrying the record is never forfeited, whatever its evidence (August, briefly).
      const kept = await bagOf();
      await prisma.contentEnrollment.update({ where: { id: A.enrollmentId }, data: { overridesJson: core.withLateSession(kept, "2026-08", { lateMonthKey: "2026-08", lateMonthId: aug.id, hostMonthKey: "2026-11", hostMonthId: nov.id, scriptsSentOutside: false, by: "drill", at: now().toISOString() }) } });
      const withRecord = await forfeitedMonths([aug.id], { now: now() });
      await prisma.contentEnrollment.update({ where: { id: A.enrollmentId }, data: { overridesJson: kept } });
      c.ok("(a month carrying the record is never forfeited — the reader's own rule)", !withRecord.has(aug.id) && (await forfeitedMonths([aug.id], { now: now() })).has(aug.id));
    }
    const again = await actions.lateSessionAction(A.monthId, aug.id, false);
    c.ok("a second one into October is refused", !again.ok && /October already brings in September's session/.test(again.message), again.message);
    const skipSep = await actions.setMonthSkipped(sep.id, true), skipOct = await actions.setMonthSkipped(A.monthId, true);
    c.ok("the skip toggle can't half-undo it (either month points at Undo)", !skipSep.ok && /being booked in October\. Undo that first/.test(skipSep.message) && !skipOct.ok && /books September's session too\. Undo that first/.test(skipOct.message) && (await monthRow(sep.id)).status === "OPEN" && (await monthRow(A.monthId)).status === "OPEN", `${skipSep.message} | ${skipOct.message}`);
    const cuPanel = (await cu.catchUpPanel(A.monthId, { now: now() }))!;
    c.ok("…and a catch-up can't fold September away now", /September's session is being booked late, in October\. Undo that first\./.test(cuPanel.options.find((o) => o.monthKey === "2026-09")?.refusal ?? ""), cuPanel.options.find((o) => o.monthKey === "2026-09")?.refusal ?? "");
    const hostPanel = (await ls.lateSessionPanel(A.monthId, { now: now() }))!;
    c.ok("the Overview card: October carries September (to book, 2 scripts released, 2 videos on September, undo allowed)", hostPanel.carrying?.lateMonthKey === "2026-09" && hostPanel.carrying.state === "TO_BOOK" && hostPanel.carrying.scriptsReleased === 2 && hostPanel.carrying.lateVideosOwed === 2 && hostPanel.carrying.undoRefusal === null, JSON.stringify(hostPanel.carrying));
    const cardHtml = text(html(createElement(LateSessionControl, {
      monthId: A.monthId, monthName: "October", options: [], filmingIn: null, offer: null,
      carrying: { lateMonthId: sep.id, lateLabel: "September", state: "TO_BOOK", filmed: false, startsAtISO: null, scriptsReleased: 2, scriptsReady: true, scriptsSentOutside: false, lateVideosOwed: 2, by: "Kyle", at: now().toISOString(), undoRefusal: null, lateHref: "/content/x?month=2026-09" },
    })));
    c.ok("…renders 'October also books September's session', the status, Copy a message and Undo", /October also books September's session\./.test(cardHtml) && /September's session: not booked yet/.test(cardHtml) && /Copy a message/.test(cardHtml) && /Undo/.test(cardHtml), cardHtml.slice(0, 300));
    const sepPanel1 = (await ls.lateSessionPanel(sep.id, { now: now() }))!;
    c.ok("September's own page says its session is being booked in October", sepPanel1.filmingIn?.hostMonthKey === "2026-10" && sepPanel1.filmingIn.state === "TO_BOOK" && !sepPanel1.offer);

    // =======================================================================
    c.head("§4 · September's own readers: not overdue, booking in October");
    // =======================================================================
    const ov = (await programOverview({ enrollmentIds: [A.enrollmentId], monthKey: "2026-09", now: now() })).rows.find((r) => r.monthKey === "2026-09")!;
    c.ok("the roster's September row: 'Filming late, in October 2026: September's session isn't booked yet', waiting on the client", ov.nextAction.text === "Filming late, in October 2026: September's session isn't booked yet" && ov.nextAction.blocked === "client" && ov.lateIn === "2026-10", ov.nextAction.text);
    c.ok("…due when October ends, and not flagged overdue", !ov.flags.includes("overdue") && new RealDate(ov.nextAction.deadlineISO ?? 0).getTime() > et(10, 30, 0).getTime() && new RealDate(ov.nextAction.deadlineISO ?? 0).getTime() < et(11, 2, 0).getTime(), JSON.stringify({ f: ov.flags, d: ov.nextAction.deadlineISO }));
    const progSep = (await mp.monthProgress(A.enrollmentId, sep.id, { now: now() }))!;
    c.ok("month progress: September is filming late in October, owes 1 session and 2 videos, not muted or forfeited", progSep.late.filmingIn?.hostMonthKey === "2026-10" && progSep.sessions.required === 1 && progSep.videosOwed === 2 && !progSep.muted && !progSep.forfeited && progSep.nextAction?.text === "Filming late, in October: September's session isn't booked yet", progSep.nextAction?.text ?? "");
    const progOct0 = (await mp.monthProgress(A.enrollmentId, A.monthId, { now: now() }))!;
    c.ok("…and October says it brings September in, with its own 1 session / 2 videos", progOct0.late.bringsIn.map((x) => x.lateMonthKey).join() === "2026-09" && progOct0.sessions.required === 1 && progOct0.videosOwed === 2);
    const rem = (await reminders.previewReminders(sep.id, { now: now() })).lanes.find((l) => l.lane === "PRIMARY")!.candidate;
    c.ok("September's booking reminder now runs on OCTOBER's calendar: no roll-over warning, October's booking deadline (Oct 20), no escalation yet",
      rem.action === "BOOK_SESSION" && rem.lateIn === "2026-10" && rem.milestone !== "MID_MONTH" && (rem.calendar?.monthOpenAt.getTime() ?? 0) >= et(10, 1, 0).getTime() && rem.deadlineAt?.getTime() === et(10, 20, 17).getTime() && !rem.escalation,
      JSON.stringify({ m: rem.milestone, d: rem.deadlineAt, e: rem.escalation, r: rem.reason }));
    c.ok("…and its words say 'booking in October' (no em dash)", rem.extraParagraph === "Your September session is booking in October, alongside October's own. Your September scripts are ready, so pick a time in your portal and we'll confirm it." && !/—/.test(rem.extraParagraph ?? ""), rem.extraParagraph ?? "none");

    // =======================================================================
    c.head("§5 · the portal: both sessions, September's gated by September's plan");
    // =======================================================================
    const v = await viewerOf(A.portalToken);
    const planning = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("Your Month's planning carries the line", planning.late?.line === "Your September session still needs booking, and October's too." && planning.late.state === "TO_BOOK" && planning.late.scriptsReady, planning.late?.line ?? "none");
    c.ok("…and the September slot's label", planning.late?.slotLabel === "September session (your scripts are ready)", planning.late?.slotLabel ?? "");
    const sm = await portal.portalScheduleMonths(v.enrollment);
    const sSep = sm.find((m) => m.monthId === sep.id), sOct = sm.find((m) => m.monthId === A.monthId);
    c.ok("the scheduler lists September FIRST, as 'September session (your scripts are ready)', then 'October session'", sm[0]?.monthId === sep.id && sSep?.tabLabel === "September session (your scripts are ready)" && sSep.late?.hostMonthKey === "2026-10" && sOct?.tabLabel === "October session", sm.map((m) => `${m.monthKey}:${m.tabLabel}`).join(" | "));
    c.ok("September's tab is OPEN on its own plan (the Sep 11 call), 1 session, capacity 1", !!sSep && !sSep.locked && sSep.sessionsRequired === 1 && sSep.capacity.remaining === 1 && sSep.callStatus === "COMPLETED", JSON.stringify({ l: sSep?.locked, r: sSep?.reason, cap: sSep?.capacity }));
    c.ok("October's tab is gated by OCTOBER's plan (not chosen yet), not September's", !!sOct && sOct.locked && /Choose how to plan this month first|Book your strategy call first/.test(sOct.reason), sOct?.reason ?? "");
    const gSep = await portal.sessionGate(A.enrollmentId, sep.id, { now: now(), sessionIndex: 1 });
    c.ok("September's gate: open, earliest is the 24-hour floor (its 72 weekday hours ran out in September)", !gSep.locked && gSep.earliest.getTime() >= now().getTime() + 24 * 3600_000 - 1000, `${gSep.locked} ${gSep.earliest.toISOString()}`);
    const scripts = await ls.portalLateScripts(v.enrollment, sep.id);
    c.ok("September's two released scripts, words in full, for prep", scripts.length === 2 && scripts.map((s) => s.title).join("|") === sepScripts.map((s) => s.title).join("|") && scripts[0].body.includes("Spring buyers move fast"), JSON.stringify(scripts.map((s) => s.title)));
    const topics = await portal.portalTopics(v.enrollment);
    const ym = text(html(createElement(YourMonth, { d: {
      topics, planning, planningFailed: false, schedule: sOct ?? null, scheduleFailed: false, slotDays: [], bookingUrl: "https://calendly.invalid", can: { suggest: true, session: true }, readOnly: false,
      hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts", schedule: "?tab=schedule" },
      late: { schedule: sSep ?? null, scripts }, selectedScheduleMonthId: null,
    } })));
    c.ok("Your Month (October) renders the line, both tabs and September's scripts", ym.includes("Your September session still needs booking, and October's too.") && ym.includes("September session (your scripts are ready)") && ym.includes("October session") && ym.includes("Your September scripts (2)") && ym.includes("Spring buyers move fast"), ym.slice(0, 400));
    c.ok("…says September's scripts are ready and October's session follows October's own plan", ym.includes("Your September scripts are ready, so you can book that session now.") && ym.includes("October's session follows October's own plan."));
    const pageHtml = text(html(await PortalPage({ viewer: v, path: "/portal/x", query: { tab: "plan" } })));
    c.ok("the real portal page (Your Month) shows it", pageHtml.includes("Your September session still needs booking, and October's too.") && pageHtml.includes("September session (your scripts are ready)"), pageHtml.slice(0, 300));
    const pageSep = text(html(await PortalPage({ viewer: v, path: "/portal/x", query: { tab: "plan", month: "2026-09" } })));
    c.ok("?month=2026-09 (the September tab remembered) keeps Your Month on October, with no 'not available' notice", pageSep.includes("October 2026") && pageSep.includes("Your September session still needs booking") && !pageSep.includes("That planning month is not available here"), pageSep.slice(0, 300));
    const homeHtml = text(html(await PortalPage({ viewer: v, path: "/portal/x", query: {} })));
    c.ok("Home shows the line and offers 'Book your September session'", homeHtml.includes("Your September session still needs booking, and October's too.") && homeHtml.includes("Book your September session"), homeHtml.slice(0, 300));
    const schedHtml = text(html(await PortalPage({ viewer: v, path: "/portal/x", query: { tab: "schedule" } })));
    c.ok("Schedule shows the line and the September tab", schedHtml.includes("Your September session still needs booking") && schedHtml.includes("September session (your scripts are ready)"));
    const ha = homeActions({ status: "ACTIVE", readOnly: false, perms: { session: true, suggest: true, request: true, approve: true, profile: true }, review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: [], unread: 0, planning: null, month: null, toAnswer: [], session: { offerBooking: false, required: 1, missing: 1 }, addressNeeded: 0, setup: null, ready: { count: 0, withFile: false, single: null }, lateSession: { label: "September", open: true } });
    c.ok("(the Home action lands on the late card)", ha.primary?.kind === "BOOK_SESSION" && ha.primary.title === "Book your September session" && ha.primary.href.endsWith("#step-late"), JSON.stringify(ha.primary));

    // =======================================================================
    c.head("§6 · the staff planning control: October → the client picks topics");
    // =======================================================================
    const heldRefusal = await actions.setMonthPlanningAction(sep.id, "TOPICS");
    c.ok("September (call held) can't switch to picking topics", !heldRefusal.ok && heldRefusal.message === "September's strategy call was held, so the month stays planned on it.", heldRefusal.message);
    const topicsSet = await actions.setMonthPlanningAction(A.monthId, "TOPICS");
    const octP = await monthRow(A.monthId);
    c.ok("October: the client picks topics — the same columns the portal's own choice writes", topicsSet.ok && octP.planningMode === "WRITTEN" && octP.planningChosenBy === `staff:${admin.id}` && !!octP.planningChosenAt, `${topicsSet.message} ${octP.planningMode} ${octP.planningChosenBy}`);
    const planning2 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    const gOct = await portal.sessionGate(A.enrollmentId, A.monthId, { now: now(), sessionIndex: 1 });
    c.ok("…the portal reads it: written route, not office-planned, October's tab now asks for its topics", planning2.planningMode === "WRITTEN" && !planning2.officePlanned && gOct.locked && /topics/.test(gOct.reason), gOct.reason);
    const officeSet = await actions.setMonthPlanningAction(nov.id, "OFFICE");
    const novRow = await monthRow(nov.id);
    c.ok("'We planned it' stamps the office's choice (as the script upload does)", officeSet.ok && !/—/.test(officeSet.message) && novRow.planningMode === "WRITTEN" && novRow.planningChosenBy === "office:kyle@late.test" && !!(await portal.portalPlanning(v.enrollment, nov.id))?.officePlanned, officeSet.message);
    const same = await actions.setMonthPlanningAction(A.monthId, "TOPICS");
    c.ok("choosing the same route again is a no-op that says so", same.ok && /already planned by the client picking topics/.test(same.message), same.message);

    // =======================================================================
    c.head("§7 · copy a message (never sent)");
    // =======================================================================
    const outboxBefore = await prisma.outboxMessage.count();
    const copy = await actions.lateSessionMessageAction(sep.id);
    const link = `${appBase()}/portal/${A.portalToken}`;
    c.ok("Jordan's message, filled in with her first name and portal link, October's topics line",
      copy.ok && copy.body === `Hi Arielle! We still need to get your September content session on the calendar, and to get you caught back up we also need to schedule October. You can book both here: ${link}. For October you can pick your topics right in the portal.`,
      copy.body ?? copy.message);
    c.ok("…no em dash, the link is the lasting page link, and nothing was queued or sent", !/—/.test(copy.body ?? "") && copy.url === link && (await prisma.outboxMessage.count()) === outboxBefore && /Paste it/.test(copy.message), copy.message);
    c.ok("(the words follow the month: a call to book, a choice, or October already booked)",
      core.lateSessionMessage({ firstName: "Arielle", lateMonthKey: "2026-09", hostMonthKey: "2026-10", link: "L", lateState: "TO_BOOK", hostSessionBooked: false, hostPlanning: "CALL_TO_BOOK" }).endsWith("For October, you can book your strategy call there too.") &&
      core.lateSessionMessage({ firstName: "Arielle", lateMonthKey: "2026-09", hostMonthKey: "2026-10", link: "L", lateState: "TO_BOOK", hostSessionBooked: true, hostPlanning: "TOPICS" }) === "Hi Arielle! We still need to get your September content session on the calendar. You can book it here: L.");

    // =======================================================================
    c.head("§8 · booking the September slot: filed on September, shoot linked to September");
    // =======================================================================
    const exact = { street: "12 Spruce Street", city: "West Chester", state: "PA", zip: "19382" };
    const addr = await portalActions.portalSaveSessionPlanAddress(auth, sep.id, 1, exact);
    c.ok("the September session's exact address is accepted (an over month, because it is booked late)", addr.ok && !!addr.planId, addr.message);
    const augAddr = await portalActions.portalSaveSessionPlanAddress(auth, aug.id, 1, exact);
    const augSlots = await portalActions.portalSessionSlots(auth, aug.id, 1);
    c.ok("…an over month WITHOUT the record is still refused, on both doors", !augAddr.ok && augAddr.message === "Pick one of your open program months." && !augSlots.ok && augSlots.message === "Pick one of your open program months.", `${augAddr.message} | ${augSlots.message}`);
    const slots = await portalActions.portalSessionSlots(auth, sep.id, 1);
    c.ok("September's times are read for its own session (past the month guard, from its address)", slots.message !== "Pick one of your open program months." && !slots.needsAddress && slots.planId === addr.planId, JSON.stringify({ ok: slots.ok, m: slots.message, p: slots.planId }));
    const slot = et(10, 21, 10); // Wed Oct 21, 10:00 AM EDT
    const ask = await portalActions.portalRequestSession(auth, { monthId: sep.id, slotISO: slot.toISOString(), planId: addr.planId!, addressVersion: addr.addressVersion!, sessionIndex: 1 });
    const req = ask.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: ask.requestId } }) : null;
    c.ok("the client books it from the portal: the request is filed on SEPTEMBER, session 1", ask.ok && req?.monthId === sep.id && req.sessionIndex === 1 && req.slotStart?.getTime() === slot.getTime(), ask.message);
    const desk = req ? await prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${req.id}` } }) : null;
    c.ok("Kyle's desk task says it is September's session, filmed late in October, and to keep the job on September", !!desk && (desk.description ?? "").includes("This is September's session, approved to film late in October. It uses September's scripts. Once it's booked, check the job sits on September (Production › Sessions), not on October."), (desk?.description ?? "").split("\n").slice(0, 3).join(" / "));
    const capSep = await srq.sessionCapacity(A.enrollmentId, sep.id, { now: now() }), capOct = await srq.sessionCapacity(A.enrollmentId, A.monthId, { now: now() });
    c.ok("capacity: September's one session is taken, October's is untouched", capSep.remaining === 0 && capOct.remaining === 1, JSON.stringify({ capSep, capOct }));
    const second = await portalActions.portalRequestSession(auth, { monthId: sep.id, slotISO: et(10, 22, 10).toISOString(), planId: addr.planId!, addressVersion: addr.addressVersion!, sessionIndex: 1 });
    c.ok("a second ask on September is refused (one session)", !second.ok, second.message);
    const planning3 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("the portal line: 'Your September session is requested, and we'll confirm the time. October's still needs booking.'", planning3.late?.line === "Your September session is requested, and we'll confirm the time. October's still needs booking.", planning3.late?.line ?? "none");
    // Kyle books it in Aryeo by hand: the job lands with no month link, dated
    // in October. October's OWN shoot (Oct 23) is booked too.
    const sepJob = await prisma.project.create({ data: { clientId: A.clientId, title: "Arielle September session TEST", status: "SCHEDULED", shootDate: slot, packageName: "Video Starter", aryeoOrderId: "late-order-sep" } });
    await prisma.deliverable.create({ data: { projectId: sepJob.id, type: "SOCIAL_REEL", label: "Video Starter", productTitle: "Video Starter", quantity: 2 } });
    await prisma.appointment.create({ data: { projectId: sepJob.id, aryeoId: "late-appt-sep", status: "SCHEDULED", startAt: slot, endAt: new RealDate(slot.getTime() + 2 * 3_600_000), durationMin: 120 } });
    const octJob = await prisma.project.create({ data: { clientId: A.clientId, title: "Arielle October session TEST", status: "SCHEDULED", shootDate: et(10, 23, 10), packageName: "Video Starter", aryeoOrderId: "late-order-oct" } });
    await prisma.deliverable.create({ data: { projectId: octJob.id, type: "SOCIAL_REEL", label: "Video Starter", productTitle: "Video Starter", quantity: 2 } });
    await attachMonthlyProjects();
    const sepJobRow = await prisma.project.findUniqueOrThrow({ where: { id: sepJob.id } }), octJobRow = await prisma.project.findUniqueOrThrow({ where: { id: octJob.id } });
    c.ok("the hourly attach puts the Oct 21 job on SEPTEMBER (its own request names it), and October's own Oct 23 job on October", sepJobRow.contentMonthId === sep.id && octJobRow.contentMonthId === A.monthId, `${sepJobRow.contentMonthId} / ${octJobRow.contentMonthId}`);
    const rc = await srq.reconcileSessionRequests({ now: now() });
    const reqC = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: req!.id } });
    c.ok("the reconcile confirms September's request on that job (month link evidence)", rc.confirmed >= 1 && reqC.status === "CONFIRMED" && reqC.projectId === sepJob.id && reqC.aryeoAppointmentId === "late-appt-sep" && reqC.matchState === "MONTH_LINK", JSON.stringify({ s: reqC.status, m: reqC.matchState, p: reqC.projectId }));
    c.ok("(pure: a late request matches its host month's dates; without the record it would not)", (() => {
      const appt = { id: "a", aryeoId: "x", startAt: slot, projectId: "p", project: { contentMonthId: null, aryeoOrderId: null, deliverables: [{ label: "Video Starter" }] } };
      const base = { monthId: "sep", monthKey: "2026-09", slotStart: slot, createdAt: et(10, 12, 9) };
      return srq.chooseSessionAppointment({ ...base, hostMonthKey: "2026-10" }, [appt], new Set()).verdict === "CONFIRM" && srq.chooseSessionAppointment(base, [appt], new Set()).verdict === "NONE";
    })());
    const progSep2 = (await mp.monthProgress(A.enrollmentId, sep.id, { now: now() }))!;
    const progOct2 = (await mp.monthProgress(A.enrollmentId, A.monthId, { now: now() }))!;
    c.ok("office counts: September 1 of 1 session, 2 videos owed on September", progSep2.sessions.required === 1 && progSep2.sessions.count.accountedFor === 1 && progSep2.sessions.missing === 0 && progSep2.videosOwed === 2, JSON.stringify({ r: progSep2.sessions.required, a: progSep2.sessions.count.accountedFor }));
    c.ok("…October: its own Oct 23 job counts, September's does not (1 of 1 from its own shoot, 2 videos on October)", progOct2.sessions.required === 1 && progOct2.sessions.count.accountedFor === 1 && progOct2.sessions.list.every((s) => s.projectId === octJob.id) && progOct2.videosOwed === 2, JSON.stringify(progOct2.sessions.list.map((s) => s.projectId)));
    const editorMonth = await prisma.project.findMany({ where: { contentMonthId: sep.id }, select: { id: true } });
    c.ok("the September job (and so its scripts, videos and editor brief) is September's", editorMonth.map((p) => p.id).join() === sepJob.id);
    const ovSep2 = (await programOverview({ enrollmentIds: [A.enrollmentId], monthKey: "2026-09", now: now() })).rows.find((r) => r.monthKey === "2026-09")!;
    c.ok("the roster's September row moves to 'Filming Wed, Oct 21', still not overdue", /^Filming Wed, Oct 21/.test(ovSep2.nextAction.text) && !ovSep2.flags.includes("overdue"), `${ovSep2.nextAction.text} ${ovSep2.flags.join(",")}`);
    const planning4 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("the portal line: 'Your September session is booked for Wednesday, October 21.'", planning4.late?.line === "Your September session is booked for Wednesday, October 21." && planning4.late.state === "BOOKED", planning4.late?.line ?? "none");

    // =======================================================================
    c.head("§9 · undo, and the scripts gate");
    // =======================================================================
    const bagB = await bagOf();
    const refused = await actions.undoLateSessionAction(sep.id);
    c.ok("Undo is refused once September's session is booked, with the plain reason; nothing changes", !refused.ok && refused.message === "September's session is already booked or asked for (Wed, Oct 21). Cancel it first, then undo." && (await bagOf()) === bagB, refused.message);
    c.ok("…the Overview card shows that reason beside a disabled Undo", (await ls.lateSessionPanel(A.monthId, { now: now() }))?.carrying?.undoRefusal === refused.message);

    // Bea: September planned on a call, scripts NOT in the hub.
    const B = await buildContentMonth(prisma, { name: "Bea Late TEST", package: "Starter", monthKey: "2026-10", project: false, owner: false });
    const bSep = await prisma.contentMonth.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, monthKey: "2026-09", videosOwed: 2, status: "OPEN", strategyCallStatus: "COMPLETED", strategyCallAt: et(9, 10, 11) } });
    await prisma.programCallRecord.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, callType: "MONTHLY_STRATEGY", monthId: bSep.id, targetMonthKey: "2026-09", status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(9, 10, 11), scheduledEnd: et(9, 10, 11, 30), transcriptState: "CONFIRMED" } });
    const bBefore = await bagOf(B.enrollmentId);
    const bApply = await actions.lateSessionAction(B.monthId, bSep.id, false);
    const vB = await viewerOf(B.portalToken);
    const gB = await portal.sessionGate(B.enrollmentId, bSep.id, { now: now(), sessionIndex: 1 });
    const pB = (await portal.portalPlanning(vB.enrollment, B.monthId))!;
    const smB = (await portal.portalScheduleMonths(vB.enrollment)).find((m) => m.monthId === bSep.id);
    c.ok("no scripts shared and none sent: September's session stays shut, in the client's words (no em dash)", bApply.ok && gB.locked && gB.reason === "We're finishing your September scripts. Booking for that session opens as soon as they're ready." && !/—/.test(gB.reason), gB.reason);
    c.ok("…the tab drops '(your scripts are ready)' and the reminders hold the booking ask", smB?.tabLabel === "September session" && smB.locked && pB.late?.slotLabel === "September session" && !pB.late.scriptsReady && (await reminders.previewReminders(bSep.id, { now: now() })).lanes.find((l) => l.lane === "PRIMARY")!.candidate.suppressionReason === "session_not_open", `${smB?.tabLabel} ${pB.late?.slotLabel}`);
    const bUndo = await actions.undoLateSessionAction(bSep.id);
    c.ok("Undo while nothing is booked: exact (the bag is back as it was, a second ledger row)", bUndo.ok && bUndo.message === "Undone. September's session is no longer offered in October." && (await bagOf(B.enrollmentId)) === bBefore && (await prisma.programEnrollmentChange.count({ where: { enrollmentId: B.enrollmentId } })) === 2, bUndo.message);
    c.ok("…and the portal stops offering it", !(await portal.portalScheduleMonths(vB.enrollment)).some((m) => m.monthId === bSep.id) && !(await portal.portalPlanning(vB.enrollment, B.monthId))?.late);
    const bApply2 = await actions.lateSessionAction(B.monthId, bSep.id, true);
    const gB2 = await portal.sessionGate(B.enrollmentId, bSep.id, { now: now(), sessionIndex: 1 });
    const pB2 = (await portal.portalPlanning(vB.enrollment, B.monthId))!;
    const ymB = text(html(createElement(YourMonth, { d: {
      topics: await portal.portalTopics(vB.enrollment), planning: pB2, planningFailed: false, schedule: null, scheduleFailed: false, slotDays: [], bookingUrl: "https://calendly.invalid", can: { suggest: true, session: true }, readOnly: false,
      hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts", schedule: "?tab=schedule" },
      late: { schedule: (await portal.portalScheduleMonths(vB.enrollment)).find((m) => m.monthId === bSep.id) ?? null, scripts: [] },
    } })));
    c.ok("re-applied with 'scripts sent outside the hub' (Jordan emailed them): open, labelled ready, and the card says they were sent directly", bApply2.ok && !gB2.locked && pB2.late?.slotLabel === "September session (your scripts are ready)" && ymB.includes("We sent your September scripts to you directly."), ymB.slice(0, 300));

    // =======================================================================
    c.head("§10 · nothing sent, nothing booked with a provider");
    // =======================================================================
    const end = await counts();
    c.ok("no outbox message and no provider booking attempt", end.outbox === start.outbox && end.attempts === start.attempts, JSON.stringify({ start, end }));
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
