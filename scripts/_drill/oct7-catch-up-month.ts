// ---------------------------------------------------------------------------
// DRILL: catch up a missed month (Oct 7 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct7-catch-up-month.ts
//
// Jordan: "For John, he missed a month so we are catching up and going to do
// two sessions for him this month. We need an option on the platform for that."
//
//   §1 the picker: only OPEN earlier months with nothing filmed, booked or
//      planned are pickable; the others say why (a linked shoot, planned topics).
//   §2 auth: owner and admin only — an editor, a signed-out caller and a
//      "view as" preview are refused and nothing is written; the client has no
//      such action at all.
//   §3 apply: October owes 2 sessions and 8 videos, September is closed as
//      caught up (who/when on record, ledgered), its escalation task closes and
//      its reminders stop.
//   §4 the portal: Your Month / Schedule / Home say "This month includes your
//      September catch-up", two sessions to book, 8 videos — the same shape a
//      Pro month has.
//   §5 booking: both sessions' gates read the SAME 72-weekday-hour anchor as
//      before, session 3 is not one of the month's, capacity is 2 (a third ask
//      is full), the session-2 cut quota is that session's four videos.
//   §6 a second strategy call filed on October from the desk: the first call
//      keeps anchoring the filming dates even after the second is held; the
//      desk row says what the second call is for.
//   §7 undo restores both months exactly; refused (plain reason) once the
//      extra session is booked; the skip toggle can't half-undo it.
//   §8 a Pro month (2 sessions) catching up becomes 3 sessions / 16 videos.
//   §9 nothing sent, nothing booked with a provider.
//
// ISOLATION: PGlite on 127.0.0.1:5647 (the harness). Production is never
// opened; every non-loopback call is fenced; nothing is sent.
// THE CLOCK IS PINNED to Wed Oct 7 2026 10:00 ET, moved forward once (§6).
// ---------------------------------------------------------------------------
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5647);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 7, 14, 0, 0); // Wed Oct 7 2026, 10:00 EDT
let offset = PINNED - RealDate.now();
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

// ---- modules that cannot load under the react-server build of React --------
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();
const fence = fenceFetch();

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Every string in a rendered element tree, joined (props and children alike). */
function textOf(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => textOf(x, out)); return out; }
  if (typeof n === "object" && "props" in n) for (const v of Object.values(n.props ?? {})) textOf(v, out);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct7-catch-up" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/content/actions");
    const deskActions = await import("@/app/content/calls/actions");
    const cu = await import("@/lib/monthCatchUp");
    const core = await import("@/lib/catchUp");
    const pm = await import("@/lib/programMonths");
    const portal = await import("@/lib/portal");
    const mp = await import("@/lib/monthProgress");
    const srq = await import("@/lib/sessionRequests");
    const reminders = await import("@/lib/programReminders");
    const desk = await import("@/lib/strategyCallDesk");
    const { programOverview } = await import("@/lib/programOverview");
    const { confirmedProgramSessionQuantities } = await import("@/lib/programSessionQuantity");
    const { YourMonth } = await import("@/components/portal/YourMonth");

    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@catchup.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@catchup.test", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Kim", email: "kim@catchup.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    // ---- John, as production holds him (Oct 7) ------------------------------
    // Accelerator, 1 session × 4 videos. October planned on a call HELD Oct 6
    // 4 PM (filed by staff), four topics chosen. September OPEN, no call, nothing planned.
    const J = await buildContentMonth(prisma, {
      name: "John Collins TEST", package: "Accelerator", monthKey: "2026-10", project: false,
      topics: ["Market update", "First-time buyers", "Main Line moves", "Listing prep"].map((title) => ({ title, selection: "SELECTED" as const })),
    });
    await prisma.contentMonth.update({ where: { id: J.monthId }, data: { planningMode: "CALL", planningChosenAt: et(10, 6, 16, 30), planningChosenBy: "staff:drill" } });
    const call1 = await prisma.programCallRecord.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, callType: "MONTHLY_STRATEGY", monthId: J.monthId, targetMonthKey: "2026-10", status: "COMPLETED", matchState: "CONFIRMED_BY_STAFF", scheduledStart: et(10, 6, 16), scheduledEnd: et(10, 6, 16, 30), transcriptState: "CONFIRMED" } });
    await prisma.contentMonth.update({ where: { id: J.monthId }, data: { callRecordId: call1.id } });
    await pm.recalcProgramMonth(J.monthId, { now: now() });
    const sep = await prisma.contentMonth.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthKey: "2026-09", videosOwed: 4, status: "OPEN", strategyCallStatus: "NOT_SCHEDULED" } });
    // August: OPEN, but a shoot is linked to it (production's John has one on September).
    const aug = await prisma.contentMonth.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthKey: "2026-08", videosOwed: 4, status: "OPEN", strategyCallStatus: "COMPLETED" } });
    await prisma.project.create({ data: { clientId: J.clientId, contentMonthId: aug.id, title: "Aug shoot TEST", status: "SHOT", shootDate: et(9, 24, 13) } });
    // July: OPEN with a topic planned on it.
    const jul = await prisma.contentMonth.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthKey: "2026-07", videosOwed: 4, status: "OPEN", strategyCallStatus: "COMPLETED" } });
    const julTopic = await prisma.contentTopic.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthId: jul.id, title: "July topic", status: "SELECTED" } });
    await prisma.contentTopicSelection.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthId: jul.id, topicId: julTopic.id, status: "SELECTED", source: "staff" } });
    // Kyle's escalation for September's unbooked call.
    const esc = await prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title: "John: 2026-09 still needs a strategy call", clientId: J.clientId, dedupeKey: `program-reminder-escalation:${sep.id}:BOOK_CALL` } });

    const viewer = async () => { const r = await portal.resolvePortalViewer({ token: J.portalToken ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; };
    const monthRow = (id: string) => prisma.contentMonth.findUniqueOrThrow({ where: { id } });
    const strip = <T extends { updatedAt?: Date }>(r: T) => { const { updatedAt: _u, ...rest } = r; void _u; return JSON.stringify(rest); };
    const bagOf = async () => (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: J.enrollmentId }, select: { overridesJson: true } })).overridesJson;
    const counts = async () => ({ outbox: await prisma.outboxMessage.count(), attempts: await prisma.programBookingAttempt.count() });
    const start = await counts();

    const gateBefore = await portal.sessionGatesFor(J.enrollmentId, J.monthId, { now: now() });
    c.ok("setup: October is a one-session month whose session opens from the Oct 6 call", gateBefore.sessions.length === 1 && !gateBefore.sessions[0].locked, JSON.stringify(gateBefore.sessions.map((s) => [s.locked, s.earliest])));
    c.ok("setup: before any catch-up the session-quantity reader gives an Accelerator job no per-session part", (await pm.sessionsRequiredForMonth(J.monthId)) === 1);

    // =======================================================================
    c.head("§1 · the picker: only an open, untouched earlier month");
    // =======================================================================
    const panel0 = (await cu.catchUpPanel(J.monthId, { now: now() }))!;
    const opt = (key: string) => panel0.options.find((o) => o.monthKey === key);
    c.ok("October can take a catch-up (no refusal) and lists its earlier OPEN months, newest first", panel0.refusal === null && panel0.options.map((o) => o.monthKey).join(",") === "2026-09,2026-08,2026-07", panel0.options.map((o) => o.monthKey).join(","));
    c.ok("September is pickable", opt("2026-09")?.refusal === null);
    c.ok("August is refused because a shoot is linked to it, in plain words", /August has a shoot linked to it \(Sep 24\)/.test(opt("2026-08")?.refusal ?? ""), opt("2026-08")?.refusal ?? "");
    c.ok("July is refused because topics are planned on it", /July already has topics, answers or scripts planned/.test(opt("2026-07")?.refusal ?? ""), opt("2026-07")?.refusal ?? "");
    const sepPanel = (await cu.catchUpPanel(sep.id, { now: now() }))!;
    c.ok("a past month (September) can't carry a catch-up itself", /September is over/.test(sepPanel.refusal ?? ""), sepPanel.refusal ?? "");

    // =======================================================================
    c.head("§2 · auth: owner/admin only");
    // =======================================================================
    const bagBefore = await bagOf();
    const octBefore = await monthRow(J.monthId), sepBefore = await monthRow(sep.id);
    await clearSession();
    const anon = await actions.catchUpMonthAction(J.monthId, sep.id);
    await signIn(editor);
    const asEditor = await actions.catchUpMonthAction(J.monthId, sep.id);
    await signIn(owner, admin.id);
    const asPreview = await actions.catchUpMonthAction(J.monthId, sep.id);
    await signIn(editor);
    const undoEditor = await actions.undoCatchUpAction(J.monthId);
    c.ok("signed out, an editor, and an owner previewing as someone else are all refused", !anon.ok && !asEditor.ok && !asPreview.ok && !undoEditor.ok, [anon.message, asEditor.message, asPreview.message].join(" | "));
    c.ok("…and nothing was written", (await bagOf()) === bagBefore && strip(await monthRow(J.monthId)) === strip(octBefore) && strip(await monthRow(sep.id)) === strip(sepBefore));
    const portalActions = await import("@/app/portal/actions");
    c.ok("the client's portal has no catch-up action at all", !Object.keys(portalActions).some((k) => /catch/i.test(k)));

    // =======================================================================
    c.head("§3 · apply (as Kyle, admin): October owes 2 sessions and 8 videos");
    // =======================================================================
    await signIn(admin);
    const applied = await actions.catchUpMonthAction(J.monthId, sep.id);
    const oct1 = await monthRow(J.monthId), sep1 = await monthRow(sep.id);
    c.ok("applied with a plain sentence", applied.ok && /^October now includes the September catch-up: one more filming session and 4 more videos\. September is closed as caught up in October\.$/.test(applied.message), applied.message);
    c.ok("October owes 8 videos; September is closed (SKIPPED) with its own count untouched", oct1.videosOwed === 8 && sep1.status === "SKIPPED" && sep1.videosOwed === 4);
    const rec = core.catchUpInto(await bagOf(), "2026-10");
    c.ok("the record names both months, who and when, and what each held before", !!rec && rec.missedMonthKey === "2026-09" && rec.missedMonthId === sep.id && rec.extraSessions === 1 && rec.extraVideos === 4 && rec.by === "Kyle" && Math.abs(new RealDate(rec.at).getTime() - now().getTime()) < 60_000 && rec.before.targetVideosOwed === 4 && rec.before.missedStatus === "OPEN", JSON.stringify(rec));
    c.ok("…and September reads as caught up in October (not 'skipped and forgotten')", core.catchUpFrom(await bagOf(), "2026-09")?.targetMonthKey === "2026-10");
    const ledger = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId: J.enrollmentId }, orderBy: { createdAt: "asc" } });
    c.ok("one ledger row says what happened, by Kyle", ledger.length === 1 && ledger[0].changedBy === "Kyle" && /Catch up September in October/.test(ledger[0].reason ?? "") && ledger[0].billingTruth === false, ledger.map((l) => l.reason).join(" | "));
    c.ok("the sessions reading is 2 for October and still 1 for every other month", core.sessionsForMonth({ sessionsPerMonth: 1, overridesJson: await bagOf() }, "2026-10") === 2 && core.sessionsForMonth({ sessionsPerMonth: 1, overridesJson: await bagOf() }, "2026-11") === 1 && (await pm.sessionsRequiredForMonth(J.monthId)) === 2);
    const d1 = (await pm.recalcProgramMonth(J.monthId, { now: now(), dryRun: true }))!.after;
    c.ok("the month derivation owes 2 sessions, plans 4 + 4 videos, 2 still to book", d1.sessionsRequired === 2 && d1.sessions.length === 2 && d1.sessions.every((s) => s.plannedVideos === 4) && d1.sessionsMissing === 2, JSON.stringify(d1.sessions.map((s) => s.plannedVideos)));
    c.ok("Kyle's escalation for September's call is closed", (await prisma.smartTask.findUniqueOrThrow({ where: { id: esc.id } })).status === "COMPLETED");
    const sepRem = await reminders.previewReminders(sep.id, { now: now() });
    c.ok("September's reminders stop (the evaluator reads a closed month)", sepRem.lanes.every((l) => l.candidate.action === null), JSON.stringify(sepRem.lanes.map((l) => [l.lane, l.candidate.action, l.candidate.reason])));
    const progOct = (await mp.monthProgress(J.enrollmentId, J.monthId, { now: now() }))!;
    const progSep = (await mp.monthProgress(J.enrollmentId, sep.id, { now: now() }))!;
    c.ok("the office counts: October owes 2 sessions (2 missing) and 8 videos, and says it carries September", progOct.sessions.required === 2 && progOct.sessions.missing === 2 && progOct.videosOwed === 8 && progOct.catchUp.into?.missedMonthKey === "2026-09", JSON.stringify({ r: progOct.sessions.required, m: progOct.sessions.missing, v: progOct.videosOwed }));
    c.ok("September's progress says it was caught up in October, muted", progSep.catchUp.from?.targetMonthKey === "2026-10" && progSep.muted);
    const ov = await programOverview({ enrollmentIds: [J.enrollmentId], monthKey: "2026-09", now: now() }).catch((e) => ({ error: String(e) }));
    const ovRow = "rows" in (ov as object) ? (ov as { rows: { monthKey: string; nextAction: { text: string } }[] }).rows.find((r) => r.monthKey === "2026-09") : null;
    c.ok("the roster's September row says 'Caught up in October 2026 — nothing owed here'", ovRow?.nextAction.text === "Caught up in October 2026 — nothing owed here", ovRow?.nextAction.text ?? JSON.stringify(ov).slice(0, 300));
    const again = await actions.catchUpMonthAction(J.monthId, aug.id);
    c.ok("a second catch-up on October is refused (one per month)", !again.ok && /already includes the September catch-up/.test(again.message), again.message);
    const unskip = await actions.setMonthSkipped(sep.id, false);
    const skipOct = await actions.setMonthSkipped(J.monthId, true);
    c.ok("the skip toggle can't half-undo it: reopening September or skipping October points at Undo", !unskip.ok && /undo the catch-up on October/.test(unskip.message) && !skipOct.ok && /Undo the catch-up first/.test(skipOct.message) && (await monthRow(sep.id)).status === "SKIPPED", `${unskip.message} | ${skipOct.message}`);

    // =======================================================================
    c.head("§4 · the portal: two sessions to book, 8 videos, the catch-up line");
    // =======================================================================
    const v = await viewer();
    const planning = (await portal.portalPlanning(v.enrollment, J.monthId))!;
    c.ok("Your Month's planning carries the line", planning.catchUp?.line === "This month includes your September catch-up: two filming sessions to book and 8 videos in all.", planning.catchUp?.line ?? "none");
    c.ok("…and the call card still names the HELD Oct 6 call", planning.callStatus === "COMPLETED" && planning.callAtISO === et(10, 6, 16).toISOString(), `${planning.callStatus} ${planning.callAtISO}`);
    const sched = (await portal.portalScheduleMonths(v.enrollment)).find((m) => m.monthId === J.monthId)!;
    c.ok("the scheduler shows 2 sessions required, 2 missing, a session gate for each, capacity 2", sched.sessionsRequired === 2 && sched.sessionsMissing === 2 && sched.sessionGates.length === 2 && sched.capacity.allowed === 2 && sched.sessionIndex === 1, JSON.stringify({ r: sched.sessionsRequired, m: sched.sessionsMissing, g: sched.sessionGates.length, cap: sched.capacity }));
    const topics = await portal.portalTopics(v.enrollment);
    const tm = topics.months.find((m) => m.id === J.monthId);
    c.ok("the topics count is out of 8 (4 chosen, 4 more to choose)", tm?.owed === 8 && tm.selected === 4, JSON.stringify({ owed: tm?.owed, sel: tm?.selected }));
    const tree = YourMonth({ d: { topics, planning, planningFailed: false, schedule: sched, scheduleFailed: false, slotDays: [], bookingUrl: "https://calendly.invalid", can: { suggest: true, session: true }, readOnly: false, hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts", schedule: "?tab=schedule" } } });
    const words = textOf(tree).join(" ");
    c.ok("Your Month renders 'This month includes your September catch-up' and 'of 8 videos'", /This month includes your September catch-up/.test(words) && /of/.test(words) && words.includes("8"), words.slice(0, 300));
    // Same shape as a Pro month: a Pro October with nothing booked.
    const P0 = await buildContentMonth(prisma, { name: "Pat Pro Shape TEST", package: "Pro", monthKey: "2026-10", project: false });
    const vP0 = await (async () => { const r = await portal.resolvePortalViewer({ token: P0.portalToken ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; })();
    const proSched = (await portal.portalScheduleMonths(vP0.enrollment)).find((m) => m.monthId === P0.monthId)!;
    c.ok("…the same scheduler shape a Pro month has (2 required, 2 gates, capacity 2)", proSched.sessionsRequired === sched.sessionsRequired && proSched.sessionGates.length === sched.sessionGates.length && proSched.capacity.allowed === sched.capacity.allowed);
    const { portalSessionIndex } = await import("@/lib/portalScheduling");
    c.ok("the portal's ?session=2 link is a real session of October (and 3 is not)", portalSessionIndex("2", await pm.sessionsRequiredForMonth(J.monthId)) === 2 && portalSessionIndex("3", await pm.sessionsRequiredForMonth(J.monthId)) === null);

    // =======================================================================
    c.head("§5 · booking: both sessions open on the unchanged 72-weekday-hour rule");
    // =======================================================================
    const gates = await portal.sessionGatesFor(J.enrollmentId, J.monthId, { now: now() });
    c.ok("two session gates, both open, both from the same moment as before the catch-up", gates.sessions.length === 2 && gates.sessions.every((g) => !g.locked && g.earliest.getTime() === gateBefore.sessions[0].earliest.getTime()), JSON.stringify(gates.sessions.map((g) => [g.sessionIndex, g.locked, g.earliest])));
    c.ok("…that moment is the Oct 6 call's end + 72 weekday hours (Fri Oct 9, 4:30 PM ET)", gateBefore.sessions[0].earliest.getTime() >= et(10, 9, 16, 30).getTime(), gateBefore.sessions[0].earliest.toISOString());
    const g3 = await portal.sessionGate(J.enrollmentId, J.monthId, { now: now(), sessionIndex: 3 });
    c.ok("session 3 is not one of October's sessions", g3.locked, g3.reason);
    const cap0 = await srq.sessionCapacity(J.enrollmentId, J.monthId, { now: now() });
    c.ok("booking capacity: 2 allowed, 2 remaining", cap0.allowed === 2 && cap0.remaining === 2 && cap0.sessionsPerMonth === 2, JSON.stringify(cap0));

    // =======================================================================
    c.head("§6 · a second strategy call on October (plans the September videos)");
    // =======================================================================
    const call2 = await prisma.programCallRecord.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, callType: "UNCLASSIFIED", status: "SCHEDULED", matchState: "CANDIDATE", scheduledStart: et(10, 9, 14), scheduledEnd: et(10, 9, 14, 30), transcriptState: "NONE", inviteeName: "John P. Collins", inviteeEmail: "john@calljohncollins.com" } });
    await signIn(admin);
    const assigned = await deskActions.assignStrategyCallAction(call2.id, J.clientId, "2026-10");
    const oct2 = await monthRow(J.monthId);
    c.ok("the desk files the second call on October", assigned.ok && (await prisma.programCallRecord.findUniqueOrThrow({ where: { id: call2.id } })).monthId === J.monthId, assigned.message);
    c.ok("…October still reads COMPLETED on the Oct 6 call; the month's call pointer is untouched", oct2.strategyCallStatus === "COMPLETED" && oct2.strategyCallAt?.getTime() === et(10, 6, 16).getTime() && oct2.callRecordId === call1.id, JSON.stringify({ s: oct2.strategyCallStatus, at: oct2.strategyCallAt, p: oct2.callRecordId }));
    const deskRows = (await desk.strategyCallDesk({ now: now() })).rows;
    const r2 = deskRows.find((r) => r.id === call2.id), r1 = deskRows.find((r) => r.id === call1.id);
    c.ok("the desk says the second call plans the September videos, and the first keeps the filming dates", /this second call plans the September videos/.test(r2?.catchUpNote ?? "") && /This call planned the month/.test(r1?.catchUpNote ?? ""), `${r2?.catchUpNote} | ${r1?.catchUpNote}`);
    const planning2 = (await portal.portalPlanning(v.enrollment, J.monthId))!;
    c.ok("the portal mentions the booked catch-up call", planning2.catchUp?.nextCallISO === et(10, 9, 14).toISOString(), planning2.catchUp?.nextCallISO ?? "none");
    // The second call is held (Thu Oct 9, 3 PM): the first call still anchors.
    offset = et(10, 9, 15).getTime() - RealDate.now();
    await pm.recalcProgramMonth(J.monthId, { now: now() });
    const oct3 = await monthRow(J.monthId);
    const gatesHeld = await portal.sessionGatesFor(J.enrollmentId, J.monthId, { now: now() });
    // (The portal's own 24-hour floor now sits past Oct 9 4:30 PM, so compare the RULE's reading: the anchor and its earliest.)
    c.ok("after the second call is held, strategyCallAt stays Oct 6 and both sessions keep the Oct 6 anchor", oct3.strategyCallAt?.getTime() === et(10, 6, 16).getTime() && gatesHeld.sessions.length === 2 && gatesHeld.sessions.every((g) => g.preparation?.anchor?.ref === gateBefore.sessions[0].preparation?.anchor?.ref && g.preparation?.earliest?.getTime() === gateBefore.sessions[0].earliest.getTime()), JSON.stringify({ at: oct3.strategyCallAt, g: gatesHeld.sessions.map((g) => [g.preparation?.anchor?.ref, g.preparation?.earliest]) }));
    // Without the catch-up flag the same records re-anchor on the newest call — the reason for the rule.
    const recs = await prisma.programCallRecord.findMany({ where: { monthId: J.monthId } });
    const pure = (catchUp: boolean) => pm.deriveMonthState({
      now: now(), month: { ...oct3, transcriptText: null },
      enrollment: { callMode: null, strategyCallRequired: true, noCallEligible: null },
      records: recs.map((r) => ({ id: r.id, callType: r.callType, status: r.status, matchState: r.matchState, scheduledStart: r.scheduledStart, scheduledEnd: r.scheduledEnd, transcriptState: r.transcriptState })),
      scripts: [], interviews: [], plan: { videosPerMonth: 8, sessionsPerMonth: 2, catchUp },
    });
    c.ok("(the rule: a catch-up month anchors on its FIRST held call; any other month keeps the newest, as before)", pure(true).strategyCallAt?.getTime() === et(10, 6, 16).getTime() && pure(false).strategyCallAt?.getTime() === et(10, 9, 14).getTime());

    // =======================================================================
    c.head("§7 · undo: exact while nothing extra is booked; refused once it is");
    // =======================================================================
    const octPre = await monthRow(J.monthId), sepPre = await monthRow(sep.id);
    await signIn(owner);
    const blockedByCall = await actions.undoCatchUpAction(J.monthId);
    c.ok("Undo first asks for the catch-up's second call to be unfiled (else the month would re-read its dates from it)", !blockedByCall.ok && blockedByCall.message === "October has a second strategy call filed for the catch-up (Oct 9). Unassign it on the Strategy calls page first, then undo." && (await monthRow(J.monthId)).videosOwed === 8, blockedByCall.message);
    const unassigned = await deskActions.unassignStrategyCallAction(call2.id);
    c.ok("…unassigned on the desk; October still reads the Oct 6 call", unassigned.ok && (await monthRow(J.monthId)).strategyCallAt?.getTime() === et(10, 6, 16).getTime(), unassigned.message);
    const undone = await actions.undoCatchUpAction(J.monthId);
    const octU = await monthRow(J.monthId), sepU = await monthRow(sep.id);
    c.ok("Undo (as Jordan) succeeds with a plain sentence", undone.ok && undone.message === "Undone. October is back to its own sessions and videos, and September is open again.", undone.message);
    c.ok("October is back to 4 videos and one session; the catch-up record is gone", octU.videosOwed === 4 && core.catchUpInto(await bagOf(), "2026-10") === null && (await pm.sessionsRequiredForMonth(J.monthId)) === 1 && (await bagOf()) === bagBefore, String(await bagOf()));
    c.ok("September is OPEN again with every column as it was before the catch-up", strip(sepU) === strip({ ...sepBefore }), `${strip(sepU)} vs ${strip(sepBefore)}`);
    const diff = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).filter((k) => k !== "updatedAt" && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    c.ok("October's other columns are exactly as they were before the undo (only the count moved back)", diff(octU, octPre).join(",") === "videosOwed" && sepPre.status === "SKIPPED", diff(octU, octPre).map((k) => `${k}: ${JSON.stringify((octPre as Record<string, unknown>)[k])} → ${JSON.stringify((octU as Record<string, unknown>)[k])}`).join("; "));
    c.ok("…and an undo ledger row joins the apply row", (await prisma.programEnrollmentChange.count({ where: { enrollmentId: J.enrollmentId } })) === 2);
    // Apply again, book only session 1: the undo still stands.
    await signIn(admin);
    const reapplied = await actions.catchUpMonthAction(J.monthId, sep.id);
    c.ok("applied again", reapplied.ok, reapplied.message);
    const ask = (idx: number, at: Date) => srq.createSessionRequest({ enrollmentId: J.enrollmentId, monthId: J.monthId, slot: { startISO: at.toISOString(), endISO: new Date(at.getTime() + 4 * 3_600_000).toISOString() }, actor: { kind: "STAFF", userId: admin.id }, sessionIndex: idx });
    const s1 = await ask(1, et(10, 14, 10));
    c.ok("session 1 is asked for", s1.ok, s1.ok ? "" : s1.reason);
    c.ok("with only the package's own session booked, Undo is still allowed", (await cu.undoRefusal(J.monthId, { now: now() })) === null);
    const s2 = await ask(2, et(10, 16, 10));
    c.ok("session 2 (the extra one) is asked for too — both sessions bookable", s2.ok, s2.ok ? "" : s2.reason);
    const s3 = await ask(3, et(10, 20, 10));
    c.ok("a third ask is refused: October is full at two", !s3.ok, s3.ok ? "accepted" : s3.reason);
    const octB = await monthRow(J.monthId), bagB = await bagOf();
    const refused = await actions.undoCatchUpAction(J.monthId);
    c.ok("Undo is now refused with the plain reason, and nothing changes", !refused.ok && /already has 2 filming sessions booked or asked for — more than the package's 1\. Cancel the extra session first, then undo\./.test(refused.message) && strip(await monthRow(J.monthId)) === strip(octB) && (await bagOf()) === bagB && (await monthRow(sep.id)).status === "SKIPPED", refused.message);
    const panelB = (await cu.catchUpPanel(J.monthId, { now: now() }))!;
    c.ok("the Overview control shows the same reason next to a disabled Undo", panelB.carrying?.undoRefusal === refused.message);
    // The cut quota for the extra session's own job: its four videos.
    const proj = await prisma.project.create({ data: { clientId: J.clientId, contentMonthId: J.monthId, title: "John session 2 TEST", packageName: "Video Accelerator", status: "SCHEDULED", shootDate: et(10, 16, 10), aryeoOrderId: "catchup-order-2" } });
    await prisma.appointment.create({ data: { projectId: proj.id, aryeoId: "catchup-appt-2", status: "SCHEDULED", startAt: et(10, 16, 10), endAt: et(10, 16, 14), durationMin: 240 } });
    if (s2.ok) await prisma.programSessionRequest.update({ where: { id: s2.id }, data: { status: "CONFIRMED", confirmedAt: now(), matchState: "STAFF", projectId: proj.id, aryeoAppointmentId: "catchup-appt-2", aryeoOrderId: "catchup-order-2" } });
    const q = await confirmedProgramSessionQuantities([proj.id]);
    c.ok("the extra session's job owes its own four videos (per-session cut quota)", q.get(proj.id) === 4, JSON.stringify([...q]));

    // =======================================================================
    c.head("§8 · a Pro month catching up becomes three sessions");
    // =======================================================================
    const P = await buildContentMonth(prisma, { name: "Pam Pro TEST", package: "Pro", monthKey: "2026-10", project: false });
    const pSep = await prisma.contentMonth.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, monthKey: "2026-09", videosOwed: 8, status: "OPEN", strategyCallStatus: "NOT_SCHEDULED" } });
    const pr = await actions.catchUpMonthAction(P.monthId, pSep.id);
    const pCap = await srq.sessionCapacity(P.enrollmentId, P.monthId, { now: now() });
    const pProg = (await mp.monthProgress(P.enrollmentId, P.monthId, { now: now() }))!;
    c.ok("Pro October: 3 sessions, 16 videos, capacity 3", pr.ok && (await monthRow(P.monthId)).videosOwed === 16 && pCap.allowed === 3 && pProg.sessions.required === 3 && (await pm.sessionsRequiredForMonth(P.monthId)) === 3, `${pr.message} ${JSON.stringify(pCap)}`);
    const pv = await (async () => { const r = await portal.resolvePortalViewer({ token: P.portalToken ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; })();
    const pPlan = (await portal.portalPlanning(pv.enrollment, P.monthId))!;
    c.ok("…and the portal line says three filming sessions and 16 videos", pPlan.catchUp?.line === "This month includes your September catch-up: 3 filming sessions to book and 16 videos in all.", pPlan.catchUp?.line ?? "none");

    // =======================================================================
    c.head("§9 · nothing sent, nothing booked with a provider");
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
