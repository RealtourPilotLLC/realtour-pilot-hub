// ---------------------------------------------------------------------------
// DRILL: a late month and its host filmed in ONE session (Oct 13 2026).
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct13-late-combined.ts
//
// Jordan: "the videos still need to be filmed though. I'd like to give the
// option to film 4 in one session if needing to catch up or 2 separate
// sessions." "So essentially they would be using the video accelerator
// package to catch up." Arielle: Starter (2 videos, one 2-hour session a
// month); September planned but never filmed, booked in October.
//
//   §1 the record: `combined` parses (a missing field reads false); the words.
//   §2 not on Accelerator: the choice is not offered, and both doors refuse it.
//   §3 auth: the staff switch is owner/admin only; nothing written otherwise.
//   §4 the client chooses one session: the record + ledger; the card shows the
//      two options, the current one marked.
//   §5 the scheduler shows ONE entry, "September and October session (all 4
//      videos)", and no October tab; the portal line follows.
//   §6 the gate: October not planned yet → the one session is shut, in plain
//      words that offer two sessions instead; slots and the booking door refuse.
//   §7 October's call held → open, never earlier than October's own gate allows.
//   §8 times use 240 minutes on the Video Accelerator product.
//   §9 the booking: filed on SEPTEMBER, 4 hours, the Accelerator product, desk-
//      assisted, Kyle's task names ONE 4-hour Video Accelerator appointment.
//  §10 counting: October counts it (capacity, indexes, progress, the portal
//      line, the reminders stop asking October to book); October's own door
//      refuses a second session.
//  §11 the choice can't change while it is live; undo refused too.
//  §12 cancel reopens both months; switching back and forth works again.
//  §13 booked and confirmed: both months 1 of 1; October not forfeited.
//  §14 the shoot readers carry ALL 4 topics and scripts; a filming
//      confirmation files each video on its own month.
//  §15 nothing sent, nothing booked with a provider.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness). Production is never opened.
// THE CLOCK IS PINNED to Tue Oct 13 2026 10:00 ET.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5653);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 13, 14, 0, 0); // Tue Oct 13 2026, 10:00 EDT
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
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct13-late-combined" } });
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
    const ft = await import("@/lib/filmedTopics");
    const outputs = await import("@/lib/deliverableOutputs");
    const { forfeitedMonths } = await import("@/lib/monthForfeit");
    const { attachMonthlyProjects, ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
    const { availabilityFromDay } = await import("@/lib/integrations/aryeo");
    const { PROGRAM_SLOT_HORIZON_DAYS } = await import("@/lib/portalScheduling");

    const load = createRequire(__filename);
    for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
      navigation.useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} });
      navigation.usePathname = () => "/portal/x";
      navigation.useSearchParams = () => new URLSearchParams();
    }
    const { YourMonth } = await import("@/components/portal/YourMonth");
    const { LateSessionControl } = await import("@/components/content/LateSessionControl");
    const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
    const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@combined.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@combined.test", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Kim", email: "kim@combined.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    void owner;
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await prisma.connection.create({ data: { provider: "aryeo", status: "CONNECTED", lastSyncedAt: now() } });

    /** An approved script released to the client, with its shared version (what the shoot brief reads). */
    const sharedScript = async (d: { enrollmentId: string; clientId: string; monthId: string; topicId: string; title: string; body: string }) => {
      const sc = await prisma.contentScript.create({ data: { ...d, status: "APPROVED", releaseState: "released" } });
      const ver = await prisma.contentScriptVersion.create({ data: { scriptId: sc.id, enrollmentId: d.enrollmentId, clientId: d.clientId, versionNo: 1, title: d.title, hook: d.title, pointsJson: "[]", close: "Call me.", body: d.body, source: "MANUAL", status: "SHARED" } });
      await prisma.contentScript.update({ where: { id: sc.id }, data: { sharedVersionId: ver.id, currentVersionId: ver.id } });
    };
    /** A planned September (call held Sep 11, its scripts released) for a fresh client on `pkg`, brought into October by Kyle. */
    const lateClient = async (name: string, pkg: "Starter" | "Accelerator") => {
      const f = await buildContentMonth(prisma, { name, package: pkg, monthKey: "2026-10", project: false, owner: false });
      await prisma.contentEnrollment.update({ where: { id: f.enrollmentId }, data: { strategyCallRequired: true, callMode: null } });
      const sep = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-09", videosOwed: 2, status: "OPEN", strategyCallStatus: "COMPLETED", strategyCallAt: et(9, 11, 14, 30) } });
      const call = await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId: sep.id, targetMonthKey: "2026-09", status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(9, 11, 14, 30), scheduledEnd: et(9, 11, 15), transcriptState: "CONFIRMED" } });
      await prisma.contentMonth.update({ where: { id: sep.id }, data: { callRecordId: call.id } });
      const topicIds: string[] = [];
      for (const [i, title] of ["Why spring listings sell faster", "Three fixes before photos"].entries()) {
        const t = await prisma.contentTopic.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: sep.id, title, source: "staff", status: "SCRIPTED", clientVisible: true } });
        await prisma.contentTopicSelection.create({ data: { topicId: t.id, monthId: sep.id, enrollmentId: f.enrollmentId, clientId: f.clientId, status: "SELECTED", source: "staff", rank: i + 1 } });
        await sharedScript({ enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: sep.id, topicId: t.id, title, body: `Hook: ${title}.\nClose: Call me.` });
        topicIds.push(t.id);
      }
      await pm.recalcProgramMonth(sep.id, { now: now() });
      await signIn(admin);
      const applied = await actions.lateSessionAction(f.monthId, sep.id, false);
      if (!applied.ok) throw new Error(`setup: ${applied.message}`);
      return { ...f, sep, sepTopicIds: topicIds };
    };
    const bagOf = async (enrollmentId: string) => (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: enrollmentId }, select: { overridesJson: true } })).overridesJson;
    const counts = async () => ({ outbox: await prisma.outboxMessage.count(), attempts: await prisma.programBookingAttempt.count() });
    const start = await counts();

    // =======================================================================
    c.head("§1 · the record and its words (pure)");
    // =======================================================================
    const bag0 = core.withLateSession(null, "2026-09", { lateMonthKey: "2026-09", lateMonthId: "sep", hostMonthKey: "2026-10", hostMonthId: "oct", scriptsSentOutside: false, by: "x", at: "t" });
    const bag1 = core.withLateSession(null, "2026-09", { lateMonthKey: "2026-09", lateMonthId: "sep", hostMonthKey: "2026-10", hostMonthId: "oct", scriptsSentOutside: false, combined: true, by: "x", at: "t" });
    c.ok("a record without the field reads two sessions; with it, one (the parser keeps the line)", core.readLateSessions(bag0)[0]?.combined === false && core.readLateSessions(bag1)[0]?.combined === true && !core.combinedLateOf(bag0, "2026-09") && core.combinedLateOf(bag1, "2026-09")?.hostMonthId === "oct" && core.combinedLateInto(bag1, "2026-10")?.lateMonthId === "sep" && !core.combinedLateInto(bag0, "2026-10"));
    c.ok("the host month counts the late month's sessions only when combined (sessionSourcesFrom)", pm.sessionSourcesFrom("oct", "2026-10", bag1).join() === "oct,sep" && pm.sessionSourcesFrom("oct", "2026-10", bag0).join() === "oct" && pm.sessionSourcesFrom("sep", "2026-09", bag1).join() === "sep");
    const w = core.combineChoiceWords(4);
    c.ok("the client's words: 'How would you like to film?' / 'All 4 videos in one 4-hour session' / 'Two sessions, 2 hours each'", w.heading === "How would you like to film?" && w.combined === "All 4 videos in one 4-hour session" && w.separate === "Two sessions, 2 hours each");
    c.ok("only Starter may combine (Accelerator and Pro never)", core.combineOffered("Starter") && !core.combineOffered("Accelerator") && !core.combineOffered("Pro") && !core.combineOffered(null));

    // =======================================================================
    {
      // Oct 13 2026 (Jordan): "Arielle's says 0/2 topics, shouldn't it be 2/4? And also maybe mention 2 sessions."
      const { journeyWithLate } = await import("@/lib/monthProgress");
      const base = { callStatus: "SKIPPED", topicsSelected: 0, scriptsReady: 0, videosOwed: 2, sessionsRequired: 1, sessionsConfirmed: 0, sessionsFilmedConfirmed: 0, delivered: 0, inReview: 0 };
      const lateJ = { ...base, callStatus: "COMPLETED", topicsSelected: 2, scriptsReady: 2 };
      const two = journeyWithLate(base, lateJ, { lateMonthName: "September", combined: false });
      const one = journeyWithLate(base, lateJ, { lateMonthName: "September", combined: true });
      c.ok("October with September's session reads 2/4 topics, 2/4 scripts, 4 videos, 2 sessions, and says so", two.topicsSelected === 2 && two.videosOwed === 4 && two.scriptsReady === 2 && two.sessionsRequired === 2 && two.includes === "Includes September's session (2 videos), filmed this month: 2 sessions in all.", JSON.stringify(two));
      c.ok("…and ONE session when the two months are filmed together", one.sessionsRequired === 1 && one.videosOwed === 4 && one.includes === "Includes September's 2 videos: one 4-hour session films all 4.", JSON.stringify(one));
    }

    c.head("§2 · not offered on Accelerator");
    // =======================================================================
    const C = await lateClient("Cara Accel TEST", "Accelerator");
    const cRec = core.lateSessionOf(await bagOf(C.enrollmentId), "2026-09")!;
    const cChoice = await ls.combineChoice(cRec, { now: now() });
    c.ok("Cara (Accelerator): the choice is not offered", !cChoice.offered && !cChoice.combined, JSON.stringify(cChoice));
    const cBag = await bagOf(C.enrollmentId);
    const cStaff = await actions.setLateCombinedAction(C.sep.id, true);
    c.ok("…the office's button refuses, in plain words", !cStaff.ok && /only offered on the Starter package/.test(cStaff.message), cStaff.message);
    const cOffer = await actions.setLateCombineOfferAction(C.sep.id, true);
    c.ok("…and the office can't offer it either", !cOffer.ok && /only offered on the Starter package/.test(cOffer.message), cOffer.message);
    c.ok("…and nothing was written", (await bagOf(C.enrollmentId)) === cBag);
    const cPlanning = (await portal.portalPlanning((await viewer(C.portalToken)).enrollment, C.monthId))!;
    const cYm = text(html(createElement(YourMonth, { d: ymData(cPlanning, await portal.portalTopics((await viewer(C.portalToken)).enrollment), null) })));
    c.ok("…and Your Month shows no 'How would you like to film?'", !cYm.includes("How would you like to film?") && cYm.includes("Your September session still needs booking"), cYm.slice(0, 200));

    // =======================================================================
    c.head("§3 · auth: the staff switch is owner/admin only");
    // =======================================================================
    const A = await lateClient("Arielle Combined TEST", "Starter");
    const sep = A.sep;
    const auth = { token: A.portalToken };
    const aBag0 = await bagOf(A.enrollmentId);
    await clearSession();
    const anon = await actions.setLateCombinedAction(sep.id, true);
    await signIn(editor);
    const asEditor = await actions.setLateCombinedAction(sep.id, true);
    c.ok("signed out and an editor are refused, and nothing is written", !anon.ok && !asEditor.ok && (await bagOf(A.enrollmentId)) === aBag0, `${anon.message} | ${asEditor.message}`);
    await signIn(admin);

    // =======================================================================
    c.head("§4 · the office offers the 4-hour session; the client chooses (Jordan, Oct 13: \"Let her choose\")");
    // =======================================================================
    const v = await viewer(A.portalToken);
    const planning0 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("before: two sessions, not offered yet (the office may offer it), 4 videos in all", planning0.late?.combine.offered === false && planning0.late.combine.canOffer === true && planning0.late.combine.officeOffered === false && planning0.late.combine.combined === false && planning0.late.combine.videos === 4, JSON.stringify(planning0.late?.combine));
    const ym0Html = html(createElement(YourMonth, { d: ymData(planning0, await portal.portalTopics(v.enrollment), null) }));
    const ym0 = text(ym0Html);
    const checked = [...ym0Html.matchAll(/aria-checked="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => `${m[1]}:${text(m[2]).trim()}`);
    c.ok("before the office offers it, Your Month shows the client no choice", !ym0.includes("How would you like to film?") && checked.length === 0, `${checked.join("|")} · ${ym0.slice(0, 200)}`);
    const early = await portalActions.portalChooseFilmingSessions(auth, sep.id, true);
    c.ok("…and the client can't pick it before it's offered", !early.ok && /isn't offered for these months/.test(early.message) && !/—/.test(early.message), early.message);
    const offer = await actions.setLateCombineOfferAction(sep.id, true);
    c.ok("the office offers it: one button, plain words", offer.ok && /^Offered\. September and October: the client chooses one 4-hour session or two 2-hour sessions in their portal\.$/.test(offer.message), offer.message);
    const planningOffered = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    const ymOHtml = html(createElement(YourMonth, { d: ymData(planningOffered, await portal.portalTopics(v.enrollment), null) }));
    const ymO = text(ymOHtml);
    const checkedO = [...ymOHtml.matchAll(/aria-checked="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => `${m[1]}:${text(m[2]).trim()}`);
    c.ok("now Your Month asks 'How would you like to film?', two sessions marked until they pick", ymO.includes("How would you like to film?") && checkedO.join("|") === "false:All 4 videos in one 4-hour session|true:Two sessions, 2 hours each", `${checkedO.join("|")}`);
    await prisma.programEnrollmentChange.deleteMany({ where: { enrollmentId: A.enrollmentId, reason: { startsWith: "Offered the client" } } }); // keep the ledger counts below about the CHOICE
    const chose = await portalActions.portalChooseFilmingSessions(auth, sep.id, true);
    const rec1 = core.lateSessionOf(await bagOf(A.enrollmentId), "2026-09");
    c.ok("the client picks one session in their portal: saved, in plain words (no em dash)", chose.ok && chose.message === "Saved. September and October are filmed together in one 4-hour session (all 4 videos)." && rec1?.combined === true, chose.message);
    const ledger = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId: A.enrollmentId }, orderBy: { createdAt: "asc" } });
    c.ok("one more ledger row, stamped with the client", ledger.length === 2 && /Film September and October together in one 4-hour Video Accelerator session/.test(ledger[1].reason ?? "") && !!ledger[1].changedBy, ledger.map((l) => `${l.changedBy}: ${l.reason}`).join(" | "));
    const again = await actions.setLateCombinedAction(sep.id, true);
    c.ok("pressing it again is a no-op that says so", again.ok && /^Already set\./.test(again.message) && (await prisma.programEnrollmentChange.count({ where: { enrollmentId: A.enrollmentId } })) === 2, again.message);
    const notLate = await actions.setLateCombinedAction(A.monthId, true);
    c.ok("the button refuses a month that is not a late month", !notLate.ok, notLate.message);

    // =======================================================================
    c.head("§5 · ONE entry in the scheduler");
    // =======================================================================
    const sm = await portal.portalScheduleMonths(v.enrollment);
    const sSep = sm.find((m) => m.monthId === sep.id);
    c.ok("the scheduler lists the one session as 'September and October session (all 4 videos)', and no October tab", !!sSep && sSep.tabLabel === "September and October session (all 4 videos)" && sSep.late?.combined === true && !sm.some((m) => m.monthId === A.monthId), sm.map((m) => `${m.monthKey}:${m.tabLabel}`).join(" | "));
    const planning1 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("the portal line: 'Your September and October session (all 4 videos) still needs booking.'", planning1.late?.line === "Your September and October session (all 4 videos) still needs booking." && planning1.late.slotLabel === "September and October session (all 4 videos)", planning1.late?.line ?? "none");

    // =======================================================================
    c.head("§6 · the gate: October isn't planned yet, so the one session is shut");
    // =======================================================================
    const gOct0 = await portal.sessionGate(A.enrollmentId, A.monthId, { now: now(), sessionIndex: 1 });
    const gSep0 = await portal.sessionGate(A.enrollmentId, sep.id, { now: now(), sessionIndex: 1 });
    c.ok("October's own gate is shut (no plan yet)", gOct0.locked, gOct0.reason);
    c.ok("the one session is shut too, in plain words that offer two sessions instead (no em dash)",
      gSep0.locked && gSep0.reason.startsWith("Your September and October session films both months, so it opens once October is ready to film.") && gSep0.reason.endsWith("If you'd rather not wait, choose two sessions and book September's now.") && !/this month/.test(gSep0.reason) && !/—/.test(gSep0.reason), gSep0.reason);
    const exact = { street: "12 Spruce Street", city: "West Chester", state: "PA", zip: "19382" };
    const addr = await portalActions.portalSaveSessionPlanAddress(auth, sep.id, 1, exact);
    const slots0 = await portalActions.portalSessionSlots(auth, sep.id, 1);
    const slot = et(10, 21, 10); // Wed Oct 21, 10:00 AM EDT
    const ask0 = await portalActions.portalRequestSession(auth, { monthId: sep.id, slotISO: slot.toISOString(), planId: addr.planId!, addressVersion: addr.addressVersion!, sessionIndex: 1 });
    c.ok("the times and the booking door refuse with the same words", addr.ok && !slots0.ok && slots0.locked === true && slots0.message === gSep0.reason && !ask0.ok && ask0.message === gSep0.reason, `${slots0.message} | ${ask0.message}`);
    const remSep0 = (await reminders.previewReminders(sep.id, { now: now() })).lanes.find((l) => l.lane === "PRIMARY")!.candidate;
    c.ok("September's reminder holds its booking ask while October can't be filmed yet", remSep0.suppressionReason === "session_not_open" && /filmed together with October/.test(remSep0.reason ?? ""), `${remSep0.suppressionReason} ${remSep0.reason}`);
    const scheduleLocked = (await portal.portalScheduleMonths(v.enrollment)).find((m) => m.monthId === sep.id)!;
    c.ok("the scheduler's tab shows the lock and its reason", scheduleLocked.locked && scheduleLocked.reason === gSep0.reason);

    // =======================================================================
    c.head("§7 · October's call held: open, never earlier than October's own gate");
    // =======================================================================
    // October planned on a call that ended Oct 12, 9:00 AM: its 72 weekday hours run to Thu Oct 15, 9:00 AM.
    const octCall = await prisma.programCallRecord.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, callType: "MONTHLY_STRATEGY", monthId: A.monthId, targetMonthKey: "2026-10", status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(10, 12, 8, 30), scheduledEnd: et(10, 12, 9), transcriptState: "CONFIRMED" } });
    await prisma.contentMonth.update({ where: { id: A.monthId }, data: { callRecordId: octCall.id, strategyCallStatus: "COMPLETED", strategyCallAt: et(10, 12, 8, 30) } });
    // …and its two topics, scripted and released (§14 reads them).
    const octTopicIds: string[] = [];
    for (const [i, title] of ["Open house mistakes", "What a pre-listing inspection buys you"].entries()) {
      const t = await prisma.contentTopic.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, title, source: "staff", status: "SCRIPTED", clientVisible: true } });
      await prisma.contentTopicSelection.create({ data: { topicId: t.id, monthId: A.monthId, enrollmentId: A.enrollmentId, clientId: A.clientId, status: "SELECTED", source: "staff", rank: i + 1 } });
      await sharedScript({ enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, topicId: t.id, title, body: `Hook: ${title}.\nClose: Text me.` });
      octTopicIds.push(t.id);
    }
    await pm.recalcProgramMonth(A.monthId, { now: now() });
    const gOct = await portal.sessionGate(A.enrollmentId, A.monthId, { now: now(), sessionIndex: 1 });
    const gSep = await portal.sessionGate(A.enrollmentId, sep.id, { now: now(), sessionIndex: 1 });
    c.ok("October's gate opens on Thu Oct 15 (72 weekday hours after its call)", !gOct.locked && gOct.earliest.getTime() >= et(10, 15, 9).getTime() - 60_000, `${gOct.locked} ${gOct.reason} ${gOct.earliest.toISOString()}`);
    c.ok("the one session opens too, no earlier than October's gate (September alone would allow tomorrow)", !gSep.locked && gSep.earliest.getTime() === gOct.earliest.getTime() && gSep.earliest.getTime() > now().getTime() + 26 * 3600_000, `${gSep.locked} ${gSep.reason} ${gSep.earliest.toISOString()}`);
    const gates = await portal.sessionGatesFor(A.enrollmentId, sep.id, { now: now() });
    c.ok("(every session gate of the month reads the same floor)", gates.sessions.every((g) => !g.locked && g.earliest.getTime() === gOct.earliest.getTime()) && gates.next.earliest.getTime() === gOct.earliest.getTime());

    // =======================================================================
    c.head("§8 · the times: 240 minutes on the Video Accelerator product");
    // =======================================================================
    const fromDay = availabilityFromDay(gSep.earliest);
    const keyFor = (productId: string, minutes: number) => `portal-aryeo-slots:v4:${productId}:${minutes}:${PROGRAM_SLOT_HORIZON_DAYS}${fromDay ? `:from:${fromDay}` : ""}`;
    const day = (date: string, at: Date, minutes: number) => ({ date, slots: [at.toISOString()], fitsMinutes: minutes, slotCreatives: { [at.toISOString()]: [{ teamMemberId: "00000000-0000-4000-8000-00000000c0de", name: "James" }] } });
    await prisma.appSetting.create({ data: { key: keyFor(ARYEO_CONTENT_PRODUCTS.Accelerator.productId, 240), value: JSON.stringify({ at: Date.now(), days: [day("2026-10-21", slot, 240)] }) } });
    await prisma.appSetting.create({ data: { key: keyFor(ARYEO_CONTENT_PRODUCTS.Starter.productId, 120), value: JSON.stringify({ at: Date.now(), days: [day("2026-10-22", et(10, 22, 10), 120)] }) } });
    const slots = await portalActions.portalSessionSlots(auth, sep.id, 1);
    const dates = slots.days.map((d) => d.date);
    c.ok("the one session's times are the Accelerator product's 4-hour starts (Oct 21), not Starter's 2-hour ones (Oct 22)", slots.ok && dates.includes("2026-10-21") && !dates.includes("2026-10-22"), JSON.stringify({ ok: slots.ok, m: slots.message, dates }));
    c.ok("…from October's floor", slots.earliestISO === gSep.earliest.toISOString(), slots.earliestISO ?? "");

    // =======================================================================
    c.head("§9 · the booking: ONE request on September, 4 hours, Accelerator, booked like any other");
    // =======================================================================
    // Automatic booking ON (as in production), so the request goes through the real booking decision.
    await prisma.programAutomation.upsert({ where: { key: "session_booking" }, create: { key: "session_booking", enabled: true, enabledBy: "drill", enabledAt: now() }, update: { enabled: true } });
    const ask = await portalActions.portalRequestSession(auth, { monthId: sep.id, slotISO: slot.toISOString(), planId: addr.planId!, addressVersion: addr.addressVersion!, sessionIndex: 1 });
    const req = ask.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: ask.requestId } }) : null;
    c.ok("the client books it: filed on SEPTEMBER, session 1", ask.ok && req?.monthId === sep.id && req.sessionIndex === 1 && req.slotStart?.getTime() === slot.getTime(), ask.message);
    c.ok("…4 hours long, on the Video Accelerator product (product and variant)", !!req && req.slotEnd?.getTime() === slot.getTime() + 4 * 3_600_000 && req.productId === ARYEO_CONTENT_PRODUCTS.Accelerator.productId && req.variantId === ARYEO_CONTENT_PRODUCTS.Accelerator.variantId, JSON.stringify({ end: req?.slotEnd, p: req?.productId }));
    // Jordan, Oct 13: "I don't want Kyle to have to manually schedule anything."
    c.ok("…never sent to Kyle just for being a 4-hour session", !!req && !/office books by hand|filming September and October together/.test(req.lastError ?? ""), `${req?.bookingState} ${req?.lastError}`);
    // Audit, Oct 13: a leftover `!combined` skipped the whole booking decision, so the
    // request fell to the desk with NO reason. It must be queued for the hub, or name
    // an ordinary reason (no creative, no exact address, unchecked drive, scope).
    c.ok("…it goes through the same booking decision as any session (queued, or an ordinary named reason)", !!req && (req.bookingState === "QUEUED" || /^desk-assisted: \S/.test(req.lastError ?? "")), `${req?.bookingState} ${req?.lastError}`);
    const { bookingProductFor } = await import("@/lib/sessionBooking");
    c.ok("…and the automatic booking books the request's own product: Video Accelerator, 240 minutes", !!req && bookingProductFor(req, "Starter")?.productId === ARYEO_CONTENT_PRODUCTS.Accelerator.productId && bookingProductFor(req, "Starter")?.durationMinutes === 240 && bookingProductFor({ productId: null }, "Starter")?.durationMinutes === 120);
    const desk = req ? await prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${req.id}` } }) : null;
    const deskText = desk?.description ?? "";
    c.ok("if it does land on Kyle's desk (a fallback), his task still says ONE 4-hour Video Accelerator appointment",
      !desk || deskText.includes("One 4-hour Video Accelerator session covering September and October (4 videos): book ONE appointment, 4 hours, on the Video Accelerator product as the order's only product.") &&
      deskText.includes("together with October's own: it films September's and October's scripts in one session") && deskText.includes("check the job sits on September"),
      deskText.split("\n").slice(0, 4).join(" / "));

    // =======================================================================
    c.head("§10 · October counts it");
    // =======================================================================
    const capOct = await srq.sessionCapacity(A.enrollmentId, A.monthId, { now: now() });
    const capSep = await srq.sessionCapacity(A.enrollmentId, sep.id, { now: now() });
    c.ok("capacity: September's one session is taken, and so is October's (the pending combined ask holds both)", capSep.remaining === 0 && capOct.remaining === 0 && capOct.pendingRequests === 1, JSON.stringify({ capSep, capOct }));
    const occOct = await pm.monthSessionIndexes(A.monthId, A.clientId, 1, now());
    c.ok("…October's session index is taken (no 'next' session to book)", occOct.next === null && occOct.free.length === 0, JSON.stringify({ next: occOct.next, free: occOct.free }));
    const progOct = (await mp.monthProgress(A.enrollmentId, A.monthId, { now: now() }))!;
    c.ok("month progress: October has the ask waiting on the office", progOct.sessions.pendingRequests === 1 && progOct.sessions.required === 1, JSON.stringify({ p: progOct.sessions.pendingRequests, m: progOct.sessions.missing }));
    const planning2 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("the portal line: 'Your September and October session (all 4 videos) is requested, and we'll confirm the time.' (nothing about October still to book)", planning2.late?.line === "Your September and October session (all 4 videos) is requested, and we'll confirm the time.", planning2.late?.line ?? "none");
    const remOct = (await reminders.previewReminders(A.monthId, { now: now() })).lanes.find((l) => l.lane === "PRIMARY")!.candidate;
    c.ok("October's reminders no longer ask the client to book October", !(remOct.action === "BOOK_SESSION" && remOct.decision === "send"), JSON.stringify({ a: remOct.action, d: remOct.decision, s: remOct.suppressionReason, r: remOct.reason }));
    const octAddr = await portalActions.portalSaveSessionPlanAddress(auth, A.monthId, 1, exact);
    const octAsk = await portalActions.portalRequestSession(auth, { monthId: A.monthId, slotISO: et(10, 23, 10).toISOString(), planId: octAddr.planId!, addressVersion: octAddr.addressVersion!, sessionIndex: 1 });
    c.ok("October's own door refuses a second session", !octAsk.ok && (await prisma.programSessionRequest.count({ where: { monthId: A.monthId } })) === 0, octAsk.message);
    const copy = await actions.lateSessionMessageAction(sep.id);
    c.ok("the office's copy-a-message reads October as booked too", copy.ok && /You're all caught up/.test(copy.body ?? ""), copy.body ?? copy.message);

    // =======================================================================
    c.head("§11 · the choice can't change while the session is live");
    // =======================================================================
    const bagLive = await bagOf(A.enrollmentId);
    const back = await actions.setLateCombinedAction(sep.id, false);
    c.ok("switching back to two sessions is refused, in plain words", !back.ok && back.message === "The September and October session is already booked or requested, so this can't change now. Cancel that session first to change it." && (await bagOf(A.enrollmentId)) === bagLive, back.message);
    const undo = await actions.undoLateSessionAction(sep.id);
    c.ok("…and so is undoing the late session", !undo.ok && /already booked or asked for/.test(undo.message) && (await bagOf(A.enrollmentId)) === bagLive, undo.message);
    const planning3 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("the card's choice says why it can't change", planning3.late?.combine.refusal === back.message);
    const panel = (await ls.lateSessionPanel(A.monthId, { now: now() }))!;
    const staffHtml = text(html(createElement(LateSessionControl, {
      monthId: A.monthId, monthName: "October", options: [], filmingIn: null, offer: null,
      carrying: { lateMonthId: sep.id, lateLabel: "September", state: panel.carrying!.state, filmed: false, startsAtISO: null, scriptsReleased: 2, scriptsReady: true, scriptsSentOutside: false, lateVideosOwed: 2, by: "Kyle", at: now().toISOString(), undoRefusal: panel.carrying!.undoRefusal, lateHref: "/content/x?month=2026-09", combine: panel.carrying!.combine },
    })));
    c.ok("the office's card: offered, the client's pick, the button, and why it's locked", /4-hour catch-up session: offered ?\. The client chose one Video Accelerator 4-hour session \(all 4 videos\)/.test(staffHtml) && staffHtml.includes("Stop offering the 4-hour session") && staffHtml.includes(back.message), staffHtml.slice(0, 400));

    // =======================================================================
    c.head("§12 · cancel reopens both months");
    // =======================================================================
    const cancelled = await portalActions.portalCancelSessionRequest(auth, req!.id);
    const capOct2 = await srq.sessionCapacity(A.enrollmentId, A.monthId, { now: now() }), capSep2 = await srq.sessionCapacity(A.enrollmentId, sep.id, { now: now() });
    c.ok("cancelling the one request frees September's session AND October's", cancelled.ok && capOct2.remaining === 1 && capSep2.remaining === 1, JSON.stringify({ m: cancelled.message, capOct2, capSep2 }));
    const two = await actions.setLateCombinedAction(sep.id, false);
    const smTwo = await portal.portalScheduleMonths(v.enrollment);
    c.ok("now the office can switch back to two sessions: two tabs again, 'September session…' and 'October session'", two.ok && two.message === "Saved. September and October are filmed in two sessions, 2 hours each." && smTwo.find((m) => m.monthId === sep.id)?.tabLabel === "September session (your scripts are ready)" && smTwo.find((m) => m.monthId === A.monthId)?.tabLabel === "October session", `${two.message} ${smTwo.map((m) => m.tabLabel).join(" | ")}`);
    // Two sessions: September's own gate (tomorrow's floor) asks Starter's 2-hour calendar, with no later start day.
    await prisma.appSetting.create({ data: { key: `portal-aryeo-slots:v4:${ARYEO_CONTENT_PRODUCTS.Starter.productId}:120:${PROGRAM_SLOT_HORIZON_DAYS}`, value: JSON.stringify({ at: Date.now(), days: [day("2026-10-22", et(10, 22, 10), 120)] }) } });
    const twoSlots = await portalActions.portalSessionSlots(auth, sep.id, 1);
    c.ok("…and September's times are the Starter product's 2-hour ones again (Oct 22, not the 4-hour Oct 21)", twoSlots.ok && twoSlots.days.some((d) => d.date === "2026-10-22") && twoSlots.days.every((d) => d.date !== "2026-10-21"), JSON.stringify(twoSlots.days.map((d) => d.date)));
    const one = await actions.setLateCombinedAction(sep.id, true);
    c.ok("…and back to one session", one.ok && core.lateSessionOf(await bagOf(A.enrollmentId), "2026-09")?.combined === true && (await prisma.programEnrollmentChange.count({ where: { enrollmentId: A.enrollmentId } })) === 4, one.message);

    // =======================================================================
    c.head("§13 · booked and confirmed: both months 1 of 1");
    // =======================================================================
    const ask2 = await portalActions.portalRequestSession(auth, { monthId: sep.id, slotISO: slot.toISOString(), planId: addr.planId!, addressVersion: addr.addressVersion!, sessionIndex: 1 });
    c.ok("booked again (the same slot)", ask2.ok && !!ask2.requestId, ask2.message);
    // Kyle books ONE 4-hour Video Accelerator appointment in Aryeo; the job lands unlinked, dated in October.
    const job = await prisma.project.create({ data: { clientId: A.clientId, title: "Arielle Sep+Oct session TEST", status: "SCHEDULED", shootDate: slot, packageName: "Video Accelerator", aryeoOrderId: "combined-order" } });
    await prisma.deliverable.create({ data: { projectId: job.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", quantity: 4 } });
    await prisma.appointment.create({ data: { projectId: job.id, aryeoId: "combined-appt", status: "SCHEDULED", startAt: slot, endAt: new RealDate(slot.getTime() + 4 * 3_600_000), durationMin: 240 } });
    await attachMonthlyProjects();
    c.ok("the hourly attach puts the job on SEPTEMBER (its request names it)", (await prisma.project.findUniqueOrThrow({ where: { id: job.id } })).contentMonthId === sep.id);
    await srq.reconcileSessionRequests({ now: now() });
    const req2 = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: ask2.requestId! } });
    c.ok("the reconcile confirms it on that job", req2.status === "CONFIRMED" && req2.projectId === job.id, `${req2.status} ${req2.matchState}`);
    const pSep = (await mp.monthProgress(A.enrollmentId, sep.id, { now: now() }))!, pOct = (await mp.monthProgress(A.enrollmentId, A.monthId, { now: now() }))!;
    c.ok("September: 1 of 1 session", pSep.sessions.count.accountedFor === 1 && pSep.sessions.missing === 0);
    c.ok("October: 1 of 1 too, the same job (one session for both months)", pOct.sessions.count.accountedFor === 1 && pOct.sessions.missing === 0 && pOct.sessions.fullyScheduled && pOct.sessions.list.every((s) => s.projectId === job.id), JSON.stringify(pOct.sessions.list.map((s) => s.projectId)));
    const cnt = await pm.monthSessionCount(A.monthId, A.clientId, now());
    const booked = await mp.monthBookedSessions(A.monthId, A.clientId, now());
    c.ok("monthSessionCount and monthProgress's counter agree (one rule)", cnt.accountedFor === 1 && booked.accountedFor === 1 && cnt.sessions[0]?.key === booked.sessions[0]?.key);
    const st = await ls.lateMonthState(sep.id, A.clientId, now());
    const planning4 = (await portal.portalPlanning(v.enrollment, A.monthId))!;
    c.ok("the portal line: 'Your September and October session (all 4 videos) is booked for Wednesday, October 21.'", st.state === "BOOKED" && planning4.late?.line === "Your September and October session (all 4 videos) is booked for Wednesday, October 21.", planning4.late?.line ?? "none");
    const remOct2 = (await reminders.previewReminders(A.monthId, { now: now() })).lanes.find((l) => l.lane === "PRIMARY")!.candidate;
    c.ok("October's reminders don't chase a booking", remOct2.action !== "BOOK_SESSION", JSON.stringify({ a: remOct2.action, d: remOct2.decision, r: remOct2.reason }));
    const forfeitNov = await forfeitedMonths([A.monthId], { now: et(11, 20, 10) });
    c.ok("October is not forfeited once it's over", !forfeitNov.has(A.monthId));
    {
      // The forfeit rule itself: a host of a combined record is never forfeited for "no session" (the booking sits on the late month).
      const D = await buildContentMonth(prisma, { name: "Dee Empty TEST", package: "Starter", monthKey: "2026-08", project: false, owner: false });
      const dSep = await prisma.contentMonth.create({ data: { enrollmentId: D.enrollmentId, clientId: D.clientId, monthKey: "2026-07", videosOwed: 2, status: "OPEN", strategyCallStatus: "COMPLETED" } });
      const before = await forfeitedMonths([D.monthId], { now: now() });
      await prisma.contentEnrollment.update({ where: { id: D.enrollmentId }, data: { overridesJson: core.withLateSession(null, "2026-07", { lateMonthKey: "2026-07", lateMonthId: dSep.id, hostMonthKey: "2026-08", hostMonthId: D.monthId, scriptsSentOutside: false, combined: true, by: "drill", at: now().toISOString() }) } });
      const after = await forfeitedMonths([D.monthId], { now: now() });
      c.ok("(the reader's own rule: an untouched host month is forfeited, unless it hosts a combined session)", before.has(D.monthId) && !after.has(D.monthId));
    }

    // =======================================================================
    c.head("§14 · the shoot readers carry ALL 4 topics and scripts");
    // =======================================================================
    const sess = await ft.topicsForSession(job.id);
    const sepT = sess?.topics.filter((t) => t.monthId === sep.id) ?? [], octT = sess?.topics.filter((t) => t.monthId === A.monthId) ?? [];
    c.ok("topicsForSession: September's 2 topics, then October's 2, 4 owed", !!sess && sess.topics.length === 4 && sess.owed === 4 && sepT.length === 2 && octT.length === 2 && sess.topics[0].monthId === sep.id && octT.every((t) => t.monthKey === "2026-10" && !!t.scriptId), JSON.stringify(sess?.topics.map((t) => [t.monthKey, t.title, !!t.scriptId])));
    const brief = await outputs.sessionBriefFor(job.id);
    c.ok("the shoot brief carries all 4 scripts' words", !!brief && brief.topics.length === 4 && brief.topics.every((t) => !!t.script?.text) && brief.topics.some((t) => (t.script?.text ?? "").includes("Open house mistakes")), JSON.stringify(brief?.topics.map((t) => [t.title, !!t.script])));
    const conf = await ft.confirmFilmedTopics(job.id, [...A.sepTopicIds, ...octTopicIds], "kim@combined.test", { now: now() });
    const vids = await prisma.contentVideo.findMany({ where: { projectId: job.id }, select: { monthId: true, monthKey: true, topicId: true } });
    c.ok("a filming confirmation files each video on its OWN month (2 on September, 2 on October)", conf.confirmed === 4 && vids.filter((x) => x.monthId === sep.id && x.monthKey === "2026-09").length === 2 && vids.filter((x) => x.monthId === A.monthId && x.monthKey === "2026-10").length === 2, JSON.stringify({ conf, vids }));
    const noCombined = await ft.topicsForSession((await prisma.project.create({ data: { clientId: C.clientId, contentMonthId: C.sep.id, title: "Cara Sep TEST", status: "SCHEDULED", shootDate: slot } })).id);
    c.ok("(two sessions: a late month's shoot carries only its own topics)", !!noCombined && noCombined.topics.length === 2 && noCombined.owed === 2 && noCombined.topics.every((t) => t.monthId === C.sep.id));

    // =======================================================================
    c.head("§15 · nothing sent, nothing booked with a provider");
    // =======================================================================
    const end = await counts();
    c.ok("no outbox message and no provider booking attempt", end.outbox === start.outbox && end.attempts === start.attempts, JSON.stringify({ start, end }));
    c.ok("no request left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
    console.log(await drill.evidence());

    async function viewer(token: string | null) { const r = await portal.resolvePortalViewer({ token: token ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; }
    function ymData(planning: NonNullable<Awaited<ReturnType<typeof portal.portalPlanning>>>, topics: Awaited<ReturnType<typeof portal.portalTopics>>, lateSchedule: Awaited<ReturnType<typeof portal.portalScheduleMonths>>[number] | null) {
      const schedule = null;
      return {
        topics,
        planning, planningFailed: false, schedule, scheduleFailed: false, slotDays: [], bookingUrl: "https://calendly.invalid", can: { suggest: true, session: true }, readOnly: false,
        hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts", schedule: "?tab=schedule" },
        late: { schedule: lateSchedule, scripts: [] }, selectedScheduleMonthId: null,
      };
    }
  } finally {
    quiet.restore();
    c.summary();
    try { await drill.stop(); } finally { fence.restore(); }
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
