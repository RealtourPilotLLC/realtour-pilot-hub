// ---------------------------------------------------------------------------
// DRILL: forfeited months + per-client program style + the creative brief
// (Oct 8 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct8-program-style.ts
//
// Jordan, Oct 8: "a missed month is a forfeited month. Only with our approval
// and discretion do we allow a catch-up session" · "Mike Ciunci does not do
// strategy calls … upload a creative brief … we-show-up-and-shoot."
//
//   §1 forfeited: an ended OPEN month with nothing done on it is forfeited;
//      a linked shoot, a held call stamp, planned topics, a current month and
//      a skipped month are not — and the reading is derived (nothing written).
//   §2 no reminders, no chasing: every lane says "forfeited"; its escalation
//      and desk tasks close.
//   §3 office counts: "all open months" drops it; its own row says Forfeited
//      with "Approve a catch-up" (the next open month, the month picked), owes
//      0, raises no flag; month progress is muted; the roster says no "Behind".
//   §4 the catch-up flow picks a forfeited month (an exception, staff only);
//      undo puts it back to forfeited — the reading follows the facts.
//   §5 a shoot linked later makes it not forfeited; unlinked, forfeited again.
//   §6 strategy calls off/on (owner/admin only): months read NOT_REQUIRED, no
//      call step, no BOOK_CALL; on restores the mode it had before.
//   §7 client-planned: portal month = brief (optional) → filming; no topics,
//      answers, scripts or route; no generation runs; the filming gate is open
//      with no planning window (an off client is still gated); office words.
//   §8 the brief: the client of THIS enrollment only, type/size limits, staff
//      upload, notes, removal rules, the read door's scoping, the office bell,
//      nothing sent to the client.
//   §9 the brief on /shoot and /edit: the right job's month only.
//   §10 nothing sent, nothing left the machine.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness). Production is never opened;
// every non-loopback call is fenced; Dropbox is an in-memory map.
// THE CLOCK IS PINNED to Thu Oct 8 2026 10:00 ET.
// ---------------------------------------------------------------------------
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5651);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 8, 14, 0, 0); // Thu Oct 8 2026, 10:00 EDT
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
const et = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
const now = () => new RealDate(RealDate.now() + offset);

// ---- Dropbox, in memory ----------------------------------------------------
const box = new Map<string, Buffer>();
const uploads: string[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/dropbox" || /[\\/]integrations[\\/]dropbox(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "dropboxUpload") return async (path: string, bytes: Uint8Array) => { box.set(path, Buffer.from(bytes)); uploads.push(path); return { pathDisplay: path }; };
      if (k === "dropboxDownload") return async (path: string) => { const b = box.get(path); if (!b) throw new Error("not found"); return b; };
      return t[k];
    },
  }),
);

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
function textOf(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => textOf(x, out)); return out; }
  if (typeof n === "object" && "props" in n) for (const v of Object.values(n.props ?? {})) textOf(v, out);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct8-program-style" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { NextRequest } = await import("next/server");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/content/actions");
    const ws = await import("@/app/content/[id]/workspaceActions");
    const briefActions = await import("@/app/portal/briefActions");
    const forfeit = await import("@/lib/forfeit");
    const mf = await import("@/lib/monthForfeit");
    const cu = await import("@/lib/monthCatchUp");
    const pm = await import("@/lib/programMonths");
    const portal = await import("@/lib/portal");
    const mp = await import("@/lib/monthProgress");
    const reminders = await import("@/lib/programReminders");
    const { programOverview, ALL_OPEN } = await import("@/lib/programOverview");
    const { getProgramRoster } = await import("@/lib/contentProgram");
    const { journeySteps } = await import("@/lib/contentStatus");
    const { yourMonthSteps } = await import("@/lib/yourMonth");
    const { homeActions } = await import("@/lib/portalHome");
    const style = await import("@/lib/programStyle");
    const brief = await import("@/lib/monthBrief");
    const core = await import("@/lib/monthBriefCore");
    const { mediaToken } = await import("@/lib/portalMedia");
    const upRoute = await import("@/app/api/portal/brief/route");
    const readRoute = await import("@/app/api/portal/brief/[monthId]/[fileId]/route");
    const { BriefReadOnly } = await import("@/components/brief/BriefReadOnly");

    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@oct8.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@oct8.test", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { name: "Kim", email: "kim@oct8.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison", email: "harrison@oct8.test", role: "PHOTOGRAPHER", active: true } });
    const otherTm = await prisma.teamMember.create({ data: { name: "Other Shooter", email: "other@oct8.test", role: "PHOTOGRAPHER", active: true } });
    const managerTm = await prisma.teamMember.create({ data: { name: "James", email: "james@oct8.test", role: "PHOTOGRAPHER", active: true, creativeManager: true } });
    const harrison = await prisma.appUser.create({ data: { name: "Harrison", email: "harrison@oct8.test", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id } });
    const other = await prisma.appUser.create({ data: { name: "Other Shooter", email: "other@oct8.test", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: otherTm.id } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const counts = async () => ({ outbox: await prisma.outboxMessage.count(), attempts: await prisma.programBookingAttempt.count(), ai: await prisma.programAiRun.count() });
    const start = await counts();
    const viewerOf = async (token: string | null) => { const r = await portal.resolvePortalViewer({ token: token ?? "" }); if (!r.ok) throw new Error(r.reason); return r.viewer; };

    // =======================================================================
    c.head("§1 · forfeited: an ended month with nothing done on it");
    // =======================================================================
    // Ashley (Accelerator): October current; September untouched; August has a shoot linked.
    const A = await buildContentMonth(prisma, { name: "Ashley Forfeit TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    const aSep = await prisma.contentMonth.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthKey: "2026-09", videosOwed: 4, status: "OPEN", strategyCallStatus: "NOT_SCHEDULED" } });
    const aAug = await prisma.contentMonth.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthKey: "2026-08", videosOwed: 4, status: "OPEN", strategyCallStatus: "NOT_SCHEDULED" } });
    await prisma.project.create({ data: { clientId: A.clientId, contentMonthId: aAug.id, title: "Ashley Aug shoot TEST", status: "DELIVERED", shootDate: et(8, 20, 10) } });
    // Arielle: September's call stamp says COMPLETED, nothing else — we owe scripts; not forfeited.
    const R = await buildContentMonth(prisma, { name: "Arielle Held Call TEST", package: "Starter", monthKey: "2026-10", project: false });
    const rSep = await prisma.contentMonth.create({ data: { enrollmentId: R.enrollmentId, clientId: R.clientId, monthKey: "2026-09", videosOwed: 2, status: "OPEN", strategyCallStatus: "COMPLETED" } });
    // Bernadette: September has topics planned on it; not forfeited.
    const B = await buildContentMonth(prisma, { name: "Bernadette Planned TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    const bSep = await prisma.contentMonth.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, monthKey: "2026-09", videosOwed: 5, status: "OPEN", strategyCallStatus: "NOT_SCHEDULED" } });
    const bTopic = await prisma.contentTopic.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, monthId: bSep.id, title: "Sep topic", status: "SELECTED" } });
    await prisma.contentTopicSelection.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, monthId: bSep.id, topicId: bTopic.id, status: "SELECTED", source: "staff" } });
    // Marcee: September skipped by staff on purpose.
    const M = await buildContentMonth(prisma, { name: "Marcee Skipped TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    const mSep = await prisma.contentMonth.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthKey: "2026-09", videosOwed: 5, status: "SKIPPED", strategyCallStatus: "NOT_SCHEDULED" } });

    const rowsBefore = JSON.stringify(await prisma.contentMonth.findMany({ orderBy: { id: "asc" } }));
    const set = await mf.forfeitedMonths([aSep.id, aAug.id, A.monthId, rSep.id, bSep.id, mSep.id], { now: now() });
    c.ok("September with nothing on it is forfeited", set.has(aSep.id));
    c.ok("a month with a linked shoot is not (August)", !set.has(aAug.id));
    c.ok("the current month is not (October has not ended)", !set.has(A.monthId));
    c.ok("a month whose strategy call was held is not (we owe its scripts)", !set.has(rSep.id));
    c.ok("a month with topics planned is not", !set.has(bSep.id));
    c.ok("a month staff skipped is not (it is already 'skipped')", !set.has(mSep.id));
    c.ok("deriving it wrote nothing to any month row", JSON.stringify(await prisma.contentMonth.findMany({ orderBy: { id: "asc" } })) === rowsBefore);
    c.ok("the pure rule: an ended OPEN untouched month only", forfeit.isForfeited({ monthKey: "2026-09", status: "OPEN", historical: false }, forfeit.NO_EVIDENCE, now())
      && !forfeit.isForfeited({ monthKey: "2026-09", status: "OPEN", historical: true }, forfeit.NO_EVIDENCE, now())
      && !forfeit.isForfeited({ monthKey: "2026-09", status: "OPEN", historical: false }, { ...forfeit.NO_EVIDENCE, sessionRequests: 1 }, now())
      && !forfeit.isForfeited({ monthKey: "2026-09", status: "OPEN", historical: false }, { ...forfeit.NO_EVIDENCE, videos: 1 }, now())
      && !forfeit.isForfeited({ monthKey: "2026-09", status: "OPEN", historical: false, strategyCallStatus: "SCHEDULED" }, forfeit.NO_EVIDENCE, now()));
    c.ok("…and on Sep 30 at 11 PM ET September is not over yet", !forfeit.isForfeited({ monthKey: "2026-09", status: "OPEN", historical: false }, forfeit.NO_EVIDENCE, et(9, 30, 23)));

    // =======================================================================
    c.head("§2 · no reminders, no chasing");
    // =======================================================================
    const sepRem = await reminders.previewReminders(aSep.id, { now: now() });
    c.ok("every lane says the month is forfeited and asks nothing", sepRem.lanes.every((l) => l.candidate.action === null && l.candidate.reason === reminders.FORFEITED_REASON), JSON.stringify(sepRem.lanes.map((l) => [l.lane, l.candidate.action, l.candidate.reason])));
    const esc = await prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title: "Ashley: 2026-09 still needs a strategy call", clientId: A.clientId, dedupeKey: `program-reminder-escalation:${aSep.id}:BOOK_CALL` } });
    const mid = await prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title: "Ashley mid-month", clientId: A.clientId, dedupeKey: `program-reminder-midmonth:${aSep.id}` } });
    const octEsc = await prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title: "Ashley Oct", clientId: A.clientId, dedupeKey: `program-reminder-escalation:${A.monthId}:BOOK_CALL` } });
    const closed = await mf.closeForfeitedMonthTasks(aSep.id, now());
    c.ok("its escalation and mid-month tasks close; October's task is untouched", closed === 2 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: esc.id } })).status === "COMPLETED" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: mid.id } })).status === "COMPLETED" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: octEsc.id } })).status === "OPEN", String(closed));
    const augRem = await reminders.previewReminders(aAug.id, { now: now() });
    c.ok("a not-forfeited past month is not read as forfeited by the evaluator", augRem.lanes.every((l) => l.candidate.reason !== reminders.FORFEITED_REASON));

    // =======================================================================
    c.head("§3 · office counts");
    // =======================================================================
    const allOpen = await programOverview({ monthKey: ALL_OPEN, now: now(), enrollmentIds: [A.enrollmentId, R.enrollmentId, B.enrollmentId] });
    c.ok("'all open months' no longer lists Ashley's September", !allOpen.rows.some((r) => r.monthId === aSep.id) && allOpen.rows.some((r) => r.monthId === aAug.id) && allOpen.rows.some((r) => r.monthId === rSep.id), allOpen.rows.map((r) => `${r.clientName} ${r.monthKey}`).join(", "));
    const sepView = await programOverview({ monthKey: "2026-09", now: now(), enrollmentIds: [A.enrollmentId] });
    const sRow = sepView.rows.find((r) => r.monthId === aSep.id)!;
    c.ok("its own row says Forfeited — a quiet 'Open', never a catch-up CTA (Jordan, Oct 8: exception only) — closed, nobody blocked, nothing due", !!sRow && sRow.forfeited && /^Forfeited — September 2026 was missed, nothing is owed$/.test(sRow.nextAction.text) && sRow.nextAction.cta === "Open" && sRow.nextAction.closed === true && sRow.nextAction.blocked === "nobody" && sRow.nextAction.deadlineISO === null, sRow ? `${sRow.nextAction.text} | ${sRow.nextAction.cta}` : "no row");
    c.ok("…the row opens its own month (the catch-up is offered only by the month's quiet header link)", sRow.nextAction.href === `/content/${A.enrollmentId}?month=2026-09`, sRow.nextAction.href);
    c.ok("…it owes 0, misses no session and raises no flag (no 'overdue')", sRow.production.owed === 0 && sRow.session.missing === 0 && sRow.flags.length === 0 && sRow.priority >= 900, JSON.stringify({ owed: sRow.production.owed, miss: sRow.session.missing, flags: sRow.flags }));
    const pSep = (await mp.monthProgress(A.enrollmentId, aSep.id, { now: now() }))!;
    c.ok("month progress: forfeited, muted, owes 0, no next step", pSep.forfeited && pSep.muted && pSep.videosOwed === 0 && pSep.nextAction === null && pSep.sessions.missing === 0);
    c.ok("the tracker draws no warning on it", journeySteps(mp.journeyInputFrom(pSep)).every((s) => s.state !== "warn" && s.state !== "unknown"));
    const pAug = (await mp.monthProgress(A.enrollmentId, aAug.id, { now: now() }))!;
    c.ok("…while August (shoot linked) is not muted and still owes its 4", !pAug.forfeited && !pAug.muted && pAug.videosOwed === 4);
    const roster = await getProgramRoster({ now: now() });
    const aRow = roster.find((r) => r.enrollmentId === A.enrollmentId);
    c.ok("the roster carries no 'Behind — September' for a forfeited September", !!aRow && !aRow.attention.some((x) => /Behind — September/.test(x)), JSON.stringify(aRow?.attention));
    // The portal never shows a past month: Your Month is October's.
    const aViewer = await viewerOf(A.portalToken);
    const aPlan = (await portal.portalPlanning(aViewer.enrollment))!;
    const aSched = await portal.portalScheduleMonths(aViewer.enrollment);
    c.ok("the client's portal shows October only — September (and any catch-up offer) is nowhere", aPlan.monthKey === "2026-10" && aPlan.catchUp === null && aSched.every((m) => m.monthKey >= "2026-10"), `${aPlan.monthKey} ${aSched.map((m) => m.monthKey).join(",")}`);
    const portalActions = await import("@/app/portal/actions");
    c.ok("the portal has no catch-up action of any kind", ![...Object.keys(portalActions), ...Object.keys(briefActions)].some((k) => /catch|makeup|make_up/i.test(k)));

    // =======================================================================
    c.head("§4 · approving a catch-up from a forfeited month (staff, an exception)");
    // =======================================================================
    const panel = (await cu.catchUpPanel(A.monthId, { now: now() }))!;
    const sepOpt = panel.options.find((o) => o.monthId === aSep.id);
    c.ok("October's control lists September as forfeited and pickable", !!sepOpt && sepOpt.forfeited && sepOpt.refusal === null, JSON.stringify(sepOpt));
    c.ok("…August (shoot linked) is listed, refused, not forfeited", panel.options.some((o) => o.monthId === aAug.id && !!o.refusal && !o.forfeited));
    await clearSession();
    const anon = await actions.catchUpMonthAction(A.monthId, aSep.id);
    await signIn(editor);
    const asEditor = await actions.catchUpMonthAction(A.monthId, aSep.id);
    c.ok("signed out and an editor are refused", !anon.ok && !asEditor.ok);
    await signIn(admin);
    const applied = await actions.catchUpMonthAction(A.monthId, aSep.id);
    c.ok("Kyle approves it: October now carries September", applied.ok && (await prisma.contentMonth.findUniqueOrThrow({ where: { id: aSep.id } })).status === "SKIPPED", applied.message);
    c.ok("…and September is no longer 'forfeited' — it reads caught up", !(await mf.isMonthForfeited(aSep.id, { now: now() })) && ((await mp.monthProgress(A.enrollmentId, aSep.id, { now: now() }))!.catchUp.from?.targetMonthKey === "2026-10"));
    const undone = await actions.undoCatchUpAction(A.monthId);
    c.ok("undo puts September back to OPEN, and it reads forfeited again", undone.ok && (await prisma.contentMonth.findUniqueOrThrow({ where: { id: aSep.id } })).status === "OPEN" && (await mf.isMonthForfeited(aSep.id, { now: now() })), undone.message);

    // =======================================================================
    c.head("§5 · not forfeited once a shoot is linked");
    // =======================================================================
    const late = await prisma.project.create({ data: { clientId: A.clientId, contentMonthId: aSep.id, title: "Ashley late-linked shoot TEST", status: "EDITING", shootDate: et(9, 28, 10) } });
    c.ok("a shoot linked to September later: not forfeited, owes its 4 again", !(await mf.isMonthForfeited(aSep.id, { now: now() })) && (await mp.monthProgress(A.enrollmentId, aSep.id, { now: now() }))!.videosOwed === 4);
    await prisma.project.update({ where: { id: late.id }, data: { contentMonthId: null } });
    c.ok("moved off again: forfeited again (the reading follows the facts)", await mf.isMonthForfeited(aSep.id, { now: now() }));

    // =======================================================================
    c.head("§6 · strategy calls off / on");
    // =======================================================================
    const J = await buildContentMonth(prisma, { name: "Janice Calls TEST", package: "Accelerator", monthKey: "2026-10", project: false });
    await pm.recalcProgramMonth(J.monthId, { now: now() });
    c.ok("setup: calls on by default — October reads NOT_SCHEDULED", (await prisma.contentMonth.findUniqueOrThrow({ where: { id: J.monthId } })).strategyCallStatus === "NOT_SCHEDULED");
    await signIn(editor);
    const edOff = await ws.setProgramStyleAction(J.enrollmentId, { strategyCalls: false });
    await signIn(owner, admin.id);
    const previewOff = await ws.setProgramStyleAction(J.enrollmentId, { strategyCalls: false });
    c.ok("an editor and an owner's 'view as' are refused; nothing changed", !edOff.ok && !previewOff.ok && (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: J.enrollmentId } })).callMode === null);
    await signIn(admin);
    const off = await ws.setProgramStyleAction(J.enrollmentId, { strategyCalls: false });
    const jE = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: J.enrollmentId } });
    const jM = await prisma.contentMonth.findUniqueOrThrow({ where: { id: J.monthId } });
    c.ok("off: call mode NOT_INCLUDED, the legacy flag false, October reads NOT_REQUIRED", off.ok && jE.callMode === "NOT_INCLUDED" && jE.strategyCallRequired === false && jM.strategyCallStatus === "NOT_REQUIRED", `${off.message} ${jE.callMode} ${jM.strategyCallStatus}`);
    const jV = await viewerOf(J.portalToken);
    const jPlan = (await portal.portalPlanning(jV.enrollment))!;
    const stepsOf = (p: typeof jPlan, sched: { locked: boolean; reason: string } | null, cp: { briefFiles: number; briefNotes: boolean } | null = null) => yourMonthSteps({
      monthLabel: "October",
      planning: { callMode: p.callMode, planningMode: p.planningMode, callStatus: p.callStatus, callAtISO: p.callAtISO, noCallEligible: p.noCallEligible, chosenAtISO: p.chosenAtISO, deferredAtISO: p.deferredAtISO },
      month: p.planning!, schedule: sched ? { ...sched, earliestISO: null, sessionsRequired: 1, sessionsMissing: 1, pendingRequest: false, capacityRemaining: 1 } : null,
      can: { suggest: true, session: true }, readOnly: false, hrefs: { bank: "?pv=bank", month: "?pv=month", scripts: "?pv=scripts", bookingUrl: "https://calendly.invalid" },
      clientPlanned: cp, now: now(),
    });
    const offSteps = stepsOf(jPlan, { locked: true, reason: "x" });
    c.ok("the portal: the call reads NOT_REQUIRED and Your Month has no 'Book your strategy call' step", jPlan.callStatus === "NOT_REQUIRED" && !offSteps.some((s) => /strategy call/i.test(s.title)), offSteps.map((s) => s.title).join(" | "));
    const home = (cpl: null | { briefIn: boolean; monthLabel: string }, p: typeof jPlan) => homeActions({
      status: "ACTIVE", readOnly: false, perms: { session: true, suggest: true, request: true, approve: true, profile: true },
      review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: [], unread: 0,
      planning: { planningMode: p.planningMode, callStatus: p.callStatus, noCallEligible: p.noCallEligible },
      month: { monthKey: "2026-10", label: "October 2026", owed: p.planning?.videosOwed ?? 4, selected: 0 },
      toAnswer: [], session: { offerBooking: true, required: 1, missing: 1 }, addressNeeded: 0, setup: null, ready: { count: 0, withFile: false, single: null },
      clientPlanned: cpl,
    });
    c.ok("Home asks for no call", ![home(null, jPlan).primary, ...home(null, jPlan).more].some((a) => a?.kind === "BOOK_CALL" || a?.kind === "CHOOSE_ROUTE"));
    const jRem = await reminders.previewReminders(J.monthId, { now: now() });
    c.ok("reminders never ask for a call", jRem.lanes.every((l) => l.candidate.action !== "BOOK_CALL" && l.candidate.action !== "CHOOSE_PATH"), JSON.stringify(jRem.lanes.map((l) => l.candidate.action)));
    const on = await ws.setProgramStyleAction(J.enrollmentId, { strategyCalls: true });
    const jE2 = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: J.enrollmentId } });
    c.ok("on: back to the program default (no explicit mode, flag true) and October NOT_SCHEDULED", on.ok && jE2.callMode === null && jE2.strategyCallRequired === true && (await prisma.contentMonth.findUniqueOrThrow({ where: { id: J.monthId } })).strategyCallStatus === "NOT_SCHEDULED", `${on.message} ${jE2.callMode}`);
    const jLedger = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId: J.enrollmentId }, orderBy: { createdAt: "asc" } });
    c.ok("both switches are on the ledger, by Kyle", jLedger.some((l) => l.field === "callMode" && l.toValue === JSON.stringify("NOT_INCLUDED")) && jLedger.some((l) => l.field === "strategyCallRequired" && l.toValue === "true") && jLedger.every((l) => l.changedBy === "kyle@oct8.test"), jLedger.map((l) => `${l.field}:${l.toValue}`).join(", "));
    await prisma.contentEnrollment.update({ where: { id: J.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN", noCallEligible: true } });
    await ws.setProgramStyleAction(J.enrollmentId, { strategyCalls: false });
    await ws.setProgramStyleAction(J.enrollmentId, { strategyCalls: true });
    c.ok("a client set to 'optional' gets 'optional' back when calls are turned on again", (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: J.enrollmentId } })).callMode === "OPTIONAL_WRITTEN");

    // =======================================================================
    c.head("§7 · client plans their own content (we show up and shoot)");
    // =======================================================================
    // Mike: Starter 1×2v, strategyCallRequired=false and no explicit mode — as production holds him.
    const D = await buildContentMonth(prisma, { name: "Mike Show Up TEST", package: "Starter", monthKey: "2026-10", topics: [], appointments: [] });
    await prisma.contentEnrollment.update({ where: { id: D.enrollmentId }, data: { strategyCallRequired: false } });
    await pm.recalcProgramMonth(D.monthId, { now: now() });
    const gateBefore = await portal.sessionGate(D.enrollmentId, D.monthId, { now: now() });
    c.ok("before: calls already off (legacy flag) — and with nothing planned, filming is gated", gateBefore.locked, gateBefore.reason);
    const dStyleBefore = style.programStyleOf(await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: D.enrollmentId } }));
    const offAgain = await ws.setProgramStyleAction(D.enrollmentId, { strategyCalls: false });
    c.ok("Mike's calls already read off: the off switch writes nothing", !dStyleBefore.strategyCalls && offAgain.ok && /already off/.test(offAgain.message) && (await prisma.programEnrollmentChange.count({ where: { enrollmentId: D.enrollmentId } })) === 0, offAgain.message);
    const cpOn = await ws.setProgramStyleAction(D.enrollmentId, { clientPlanned: true });
    const dLedger = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId: D.enrollmentId } });
    c.ok("on: one ledger row (clientSuppliesTopics false → true)", cpOn.ok && dLedger.length === 1 && dLedger[0].field === "clientSuppliesTopics" && dLedger[0].toValue === "true", cpOn.message);
    const dMonth = await prisma.contentMonth.findUniqueOrThrow({ where: { id: D.monthId } });
    c.ok("the month is ready to film from the start (nothing of ours to prepare)", dMonth.preparationStatus === "READY_FOR_FILMING" && dMonth.strategyCallStatus === "NOT_REQUIRED", `${dMonth.preparationStatus} ${dMonth.strategyCallStatus}`);
    const gate = await portal.sessionGate(D.enrollmentId, D.monthId, { now: now() });
    c.ok("filming is NOT gated on planning: open, from the normal 24-hour floor (no 72-hour window)", !gate.locked && Math.abs(gate.earliest.getTime() - (now().getTime() + 24 * 3_600_000)) < 60_000 && gate.preparation?.anchor?.kind === "CLIENT_PLANNED" && /no planning step/.test(gate.preparation?.reason ?? ""), `${gate.locked} ${gate.earliest.toISOString()} ${gate.preparation?.reason}`);
    c.ok("…and the weekend / 24-hour slot rules still stand", !!portal.sessionSlotRefusal(et(10, 10, 10)));
    const dV = await viewerOf(D.portalToken);
    const dPlan = (await portal.portalPlanning(dV.enrollment))!;
    c.ok("the portal knows: client-planned, no route to choose, no answers owed", dPlan.clientPlanned && !dPlan.noCallEligible && dPlan.interviewsOpen === 0 && dPlan.planning?.headline.key === "CLIENT_PLANNED", JSON.stringify({ cp: dPlan.clientPlanned, nce: dPlan.noCallEligible, h: dPlan.planning?.headline }));
    const dSteps = stepsOf(dPlan, { locked: false, reason: "" }, { briefFiles: 0, briefNotes: false });
    c.ok("Your Month reads: brief (optional) → book filming; filming is the step", dSteps.map((s) => s.key).join(",") === "brief,filming" && dSteps[0].state === "todo" && /optional/.test(dSteps[0].title) && dSteps[1].state === "current", dSteps.map((s) => `${s.key}:${s.state}:${s.title}`).join(" | "));
    c.ok("…no route, topics, answers, scripts or call step", !dSteps.some((s) => ["route", "topics", "answers", "scripts", "call"].includes(s.key)));
    const dHome = home({ briefIn: false, monthLabel: "October 2026" }, dPlan);
    const dKinds = [dHome.primary, ...dHome.more].map((a) => a?.kind);
    c.ok("Home: Book filming first, the brief offered after it; no topics, answers, route or call", dHome.primary?.kind === "BOOK_SESSION" && dKinds.includes("ADD_BRIEF") && !dKinds.some((k) => k === "PICK_TOPICS" || k === "ANSWER_QUESTIONS" || k === "CHOOSE_ROUTE" || k === "BOOK_CALL"), dKinds.join(","));
    const { startTopicRefresh, queueTopicRefresh } = await import("@/lib/contentTopics");
    const gen = await import("@/lib/contentGeneration");
    const drafting = await import("@/lib/contentDrafting");
    const dTopic = await prisma.contentTopic.create({ data: { enrollmentId: D.enrollmentId, clientId: D.clientId, monthId: D.monthId, title: "Mike's own idea", status: "SELECTED" } });
    const refusals = await Promise.all([
      startTopicRefresh({ enrollmentId: D.enrollmentId, kind: "BANK", requestedBy: "drill" }).then(() => "ran", (e: Error) => e.message),
      queueTopicRefresh({ enrollmentId: D.enrollmentId, kind: "BANK", requestedBy: "drill", reason: "drill" }).then(() => "queued", (e: Error) => e.message),
      gen.generateScriptForTopic({ topicId: dTopic.id, monthId: D.monthId, requestedBy: "drill", unattended: false }).then(() => "drafted", (e: Error) => e.message),
      drafting.draftOwedScriptsForMonth(D.monthId, { requestedBy: "drill", unattended: false }).then(() => "drafted", (e: Error) => e.message),
    ]);
    c.ok("no topic bank, refill, script or month draft runs for them — each refuses in plain words", refusals.every((r) => r === style.CLIENT_PLANNED_REFUSAL), refusals.join(" | "));
    c.ok("…no AI run and no refresh run was written", (await prisma.programAiRun.count()) === start.ai && (await prisma.contentTopicRefreshRun.count({ where: { enrollmentId: D.enrollmentId } })) === 0);
    const dOv = (await programOverview({ monthKey: "2026-10", now: now(), enrollmentIds: [D.enrollmentId] })).rows[0];
    c.ok("the office row says Client-planned — not 'topics to pick' or 'scripts not started'", !!dOv && dOv.clientPlanned && dOv.nextAction.text === "Client-planned — no filming session on the calendar" && dOv.work.topicsNeeded === 0 && /client-planned/.test(dOv.planning.preparationWord) && dOv.flags.includes("ready_to_film"), dOv ? `${dOv.nextAction.text} · ${dOv.planning.preparationWord} · ${dOv.flags}` : "none");
    const dProg = (await mp.monthProgress(D.enrollmentId, D.monthId, { now: now() }))!;
    const dJourney = journeySteps(mp.journeyInputFrom(dProg));
    c.ok("the client file's tracker: topics and scripts read 'client-planned', next step is the filming session", dJourney.find((s) => s.key === "topics")?.detail === "client-planned" && dJourney.find((s) => s.key === "scripts")?.state === "done" && dProg.nextAction?.text === "Client-planned — no filming session on the calendar yet", `${dProg.nextAction?.text}`);
    const dRem = await reminders.previewReminders(D.monthId, { now: now() });
    c.ok("reminders ask only for filming — never answers, a route or a call", dRem.lanes.every((l) => !["COMPLETE_ANSWERS", "CHOOSE_PATH", "BOOK_CALL"].includes(l.candidate.action ?? "")) && dRem.lanes.some((l) => l.candidate.action === "BOOK_SESSION"), JSON.stringify(dRem.lanes.map((l) => [l.candidate.action, l.candidate.decision])));
    // Calls ON for a client-planned client: the call is offered, never a gate.
    await ws.setProgramStyleAction(D.enrollmentId, { strategyCalls: true });
    const gateCalls = await portal.sessionGate(D.enrollmentId, D.monthId, { now: now() });
    const dPlanCalls = (await portal.portalPlanning(dV.enrollment))!;
    const callSteps = stepsOf(dPlanCalls, { locked: false, reason: "" }, { briefFiles: 0, briefNotes: false });
    c.ok("with calls on too: a 'Book your strategy call' step appears, and filming stays open", !gateCalls.locked && callSteps.map((s) => s.key).join(",") === "brief,call,filming", callSteps.map((s) => `${s.key}:${s.state}`).join(" | "));
    await ws.setProgramStyleAction(D.enrollmentId, { strategyCalls: false });
    // Off again: the planning gate comes back.
    await ws.setProgramStyleAction(D.enrollmentId, { clientPlanned: false });
    c.ok("client-planned off: filming is gated on planning again", (await portal.sessionGate(D.enrollmentId, D.monthId, { now: now() })).locked);
    await ws.setProgramStyleAction(D.enrollmentId, { clientPlanned: true });

    // =======================================================================
    c.head("§8 · the creative brief");
    // =======================================================================
    // A real-looking name so the office bell is not skipped as a TEST client.
    await prisma.client.update({ where: { id: D.clientId }, data: { name: "Mike Ciunci (drill)" } });
    await clearSession();
    const form = (fields: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
    const post = (f: FormData, cookie?: string) => upRoute.POST(new NextRequest("http://127.0.0.1/api/portal/brief", { method: "POST", body: f, headers: cookie ? { cookie } : {} }));
    const pdf = (name: string, bytes = 2048) => new File([new Uint8Array(bytes).fill(37)], name, { type: "application/pdf" });
    const r1 = await post(form({ monthId: D.monthId, token: D.portalToken!, file: pdf("October plan.pdf") }));
    const j1 = await r1.json() as { ok: boolean; message: string; file?: { id: string; href: string } };
    c.ok("Mike (his link) adds a PDF to October", r1.status === 200 && j1.ok && !!j1.file && /\?m=/.test(j1.file.href), JSON.stringify(j1));
    const stored = uploads.at(-1) ?? "";
    c.ok("…stored in the app's private Dropbox prefix (never the public cut store)", stored.startsWith(`/RealTour Pilot/Hub/content-briefs/${D.enrollmentId}/2026-10/`), stored);
    const bell = await prisma.notification.findMany({ where: { kind: "content_brief" } });
    c.ok("…the office is belled: owner/admin and the creative manager", bell.length === 2 && bell.some((n) => n.userKey === null && /OWNER/.test(n.audience) && /ADMIN/.test(n.audience)) && bell.some((n) => n.userKey === `tm:${managerTm.id}`) && bell.every((n) => /Mike Ciunci/.test(n.title)), JSON.stringify(bell.map((n) => [n.userKey, n.audience, n.title])));
    const r2 = await post(form({ monthId: A.monthId, token: D.portalToken!, file: pdf("sneaky.pdf") }));
    c.ok("Mike's link cannot add to another client's month", r2.status === 403);
    const r3 = await post(form({ monthId: D.monthId, token: "x".repeat(32), file: pdf("x.pdf") }));
    c.ok("a dead link is refused", r3.status === 401);
    const r4 = await post(form({ monthId: D.monthId, token: D.portalToken!, file: new File([new Uint8Array(10)], "evil.svg", { type: "image/svg+xml" }) }));
    const r5 = await post(form({ monthId: D.monthId, token: D.portalToken!, file: new File([new Uint8Array(10)], "tool.exe") }));
    const r6 = await post(form({ monthId: D.monthId, token: D.portalToken!, file: pdf("huge.pdf", core.BRIEF_MAX_BYTES + 1) }));
    c.ok("SVG and .exe are refused; over the size cap is a 413 with the limit said", r4.status === 400 && r5.status === 400 && r6.status === 413 && /over 4 MB/.test(((await r6.json()) as { message: string }).message));
    const docx = new File([new Uint8Array(300)], "Shot list.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const r7 = await post(form({ monthId: D.monthId, token: D.portalToken!, file: docx }));
    c.ok("a Word document and a picture are accepted", r7.status === 200 && (await post(form({ monthId: D.monthId, token: D.portalToken!, file: new File([new Uint8Array(100)], "storyboard.jpg", { type: "image/jpeg" }) }))).status === 200);
    await prisma.contentEnrollment.update({ where: { id: A.enrollmentId }, data: { status: "PAUSED" } });
    const r8 = await post(form({ monthId: A.monthId, token: A.portalToken!, file: pdf("paused.pdf") }));
    await prisma.contentEnrollment.update({ where: { id: A.enrollmentId }, data: { status: "ACTIVE" } });
    c.ok("a paused program's link cannot add a brief", r8.status === 403);
    // Staff on the client's behalf.
    await signIn(editor);
    const r9 = await post(form({ monthId: D.monthId, as: "staff", file: pdf("from-kim.pdf") }));
    await signIn(admin);
    const bellsBefore = await prisma.notification.count({ where: { kind: "content_brief" } });
    const r10 = await post(form({ monthId: D.monthId, as: "staff", file: pdf("From Kyle.pdf") }));
    const j10 = await r10.json() as { ok: boolean; file?: { id: string; href: string } };
    c.ok("staff upload: an editor is refused; Kyle adds one (no ?m= — staff read with their login), no bell for our own upload", r9.status === 403 && r10.status === 200 && j10.ok && !/\?m=/.test(j10.file?.href ?? "") && (await prisma.notification.count({ where: { kind: "content_brief" } })) === bellsBefore);
    // Notes.
    await clearSession();
    const n1 = await briefActions.portalSaveBriefNotes({ token: D.portalToken }, D.monthId, "Topics: 1) market update 2) open house tour. I'll bring my own script.");
    const n2 = await briefActions.portalSaveBriefNotes({ token: D.portalToken }, A.monthId, "not mine");
    await signIn(admin);
    const n3 = await briefActions.staffSaveBriefNotes(D.monthId, "Topics: 1) market update 2) open house tour. I'll bring my own script. (Kyle: confirmed by phone)");
    await signIn(editor);
    const n4 = await briefActions.staffSaveBriefNotes(D.monthId, "editor edit");
    c.ok("notes: Mike saves his; his link can't write another client's; Kyle edits; an editor can't", n1.ok && !n2.ok && n3.ok && !n4.ok, [n1.message, n2.message, n3.message, n4.message].join(" | "));
    // Removal.
    await clearSession();
    const kyleFileId = j10.file!.id;
    const rm1 = await briefActions.portalRemoveBriefFile({ token: D.portalToken }, D.monthId, kyleFileId);
    const rm2 = await briefActions.portalRemoveBriefFile({ token: D.portalToken }, D.monthId, j1.file!.id);
    const after = (await brief.monthBrief(D.monthId))!;
    c.ok("Mike can't remove a file our team added, can remove his own", !rm1.ok && rm2.ok && !after.files.some((f) => f.id === j1.file!.id) && after.files.some((f) => f.id === kyleFileId), `${rm1.message} | ${rm2.message}`);
    c.ok("the brief now holds 3 files and Kyle's notes", after.files.length === 3 && /confirmed by phone/.test(after.notes?.text ?? ""), after.files.map((f) => f.name).join(", "));
    // The read door.
    const keep = after.files.find((f) => f.name === "Shot list.docx")!;
    const get = (q: string, cookie?: string) => readRoute.GET(new NextRequest(`http://127.0.0.1${core.briefFileHref(D.monthId, keep.id)}${q}`, { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ monthId: D.monthId, fileId: keep.id }) });
    const dScope = { kind: "enrollment" as const, id: D.enrollmentId };
    const g1 = await get(`?m=${encodeURIComponent(mediaToken(keep.id, dScope))}`);
    c.ok("Mike's link reads his file — bytes, private, not sniffable, downloaded (a Word file is never shown inline)", g1.status === 200 && (await g1.arrayBuffer()).byteLength === 300 && g1.headers.get("cache-control") === "private, no-store" && g1.headers.get("x-content-type-options") === "nosniff" && /^attachment/.test(g1.headers.get("content-disposition") ?? ""), `${g1.status} ${g1.headers.get("content-disposition")}`);
    const g2 = await get(`?m=${encodeURIComponent(mediaToken(keep.id, { kind: "enrollment", id: A.enrollmentId }))}`);
    const g3 = await get(`?m=${encodeURIComponent(mediaToken("aaaaaaaaaaaaaaaaaaaa", dScope))}`);
    c.ok("another client's token, or a token for a different file, is refused", g2.status === 403 && g3.status === 403);
    await clearSession();
    const g4 = await get("");
    await signIn(admin);
    const g5 = await get("");
    c.ok("signed out: refused; Kyle signed in: reads it", g4.status === 403 && g5.status === 200);
    // The photographer on Mike's October job reads it; one on another job does not.
    await prisma.project.update({ where: { id: D.projectId! }, data: { photographerId: harrisonTm.id } });
    const oProj = await prisma.project.create({ data: { clientId: A.clientId, contentMonthId: A.monthId, title: "Ashley Oct TEST", status: "SCHEDULED", photographerId: otherTm.id, shootDate: et(10, 20, 10) } });
    await signIn(harrison);
    const g6 = await get("");
    await signIn(other);
    const g7 = await get("");
    c.ok("Harrison (shooting Mike's October) reads it; a photographer on another client's job does not", g6.status === 200 && g7.status === 403, `${g6.status} ${g7.status}`);
    const gWrong = await readRoute.GET(new NextRequest(`http://127.0.0.1${core.briefFileHref(A.monthId, keep.id)}`), { params: Promise.resolve({ monthId: A.monthId, fileId: keep.id }) });
    c.ok("asking for Mike's file under another month finds nothing", gWrong.status === 404);

    // =======================================================================
    c.head("§9 · on /shoot and /edit: the right job's month only");
    // =======================================================================
    const onJob = await brief.briefForProject(D.projectId!);
    const offJob = await brief.briefForProject(oProj.id);
    c.ok("Mike's October job carries his brief, client-planned", !!onJob && onJob.clientPlanned && onJob.files.length === 3 && onJob.monthId === D.monthId);
    c.ok("another client's job carries none of it", !!offJob && !offJob.clientPlanned && offJob.files.length === 0 && !offJob.notes);
    const dNov = await prisma.contentMonth.create({ data: { enrollmentId: D.enrollmentId, clientId: D.clientId, monthKey: "2026-11", videosOwed: 2, status: "OPEN" } });
    const novJob = await prisma.project.create({ data: { clientId: D.clientId, contentMonthId: dNov.id, title: "Mike Nov TEST", status: "SCHEDULED", shootDate: et(11, 12, 10) } });
    const novBrief = await brief.briefForProject(novJob.id);
    c.ok("Mike's November job does not show October's brief", !!novBrief && novBrief.files.length === 0 && novBrief.monthId === dNov.id);
    const view = await brief.briefView(onJob, null);
    const words = textOf(BriefReadOnly({ brief: view, clientPlanned: true, monthName: "October" })).join(" ");
    c.ok("the crew's card: the client's brief for October, client-planned, the files and the notes", /The client.s brief for\s+October/.test(words) && /Client-planned/.test(words) && words.includes("Shot list.docx") && /open house tour/.test(words), words.slice(0, 200));
    c.ok("…its links carry no portal token (a hub login reads them)", view!.files.every((f) => f.href === core.briefFileHref(D.monthId, f.id)));
    c.ok("an empty brief on a normal job draws nothing", BriefReadOnly({ brief: await brief.briefView(offJob, null), clientPlanned: false, monthName: "October" }) === null);

    // =======================================================================
    c.head("§10 · nothing sent, nothing left the machine");
    // =======================================================================
    const end = await counts();
    c.ok("no outbox message (no client message) and no provider booking", end.outbox === start.outbox && end.attempts === start.attempts, JSON.stringify({ start, end }));
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
