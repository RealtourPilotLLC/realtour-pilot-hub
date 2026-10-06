// ---------------------------------------------------------------------------
// DRILL: undo the planning-route choice (Oct 6 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct6-plan-undo.ts
//
// Jordan: "I want the agent to be able to undo selecting choose 4 video
// topics vs scheduling a call."
//
//   §1 choose → Undo (the sealed token): the month is back EXACTLY as it was —
//      planningMode null, planningChosenAt/By null, the call status the
//      written route stamped taken back; the cards, the reminder and the
//      filming lock all read "choose how to plan" again. The token is opaque,
//      single-use (compare-and-set on the stamp), bound to its month and
//      enrollment, and times out.
//   §2 switch: UNDECIDED → CALL → WRITTEN, Undo puts back CALL with CALL's own
//      stamp; the OLD writer left a switch off the written route reading
//      "No strategy call this month" (stored SKIPPED) — shown, then fixed.
//   §3 "Undo my choice" (no token) → no choice; one owner bell per month.
//   §4 a booked call: Undo never cancels it; with no choice the month reads
//      as planned on that call; filming booked + call route unchanged = fine.
//   §5 refusals: call already held · scripts started · filming booked off the
//      written path (token or not) — plain sentences, nothing written.
//   §6 auth: dead link, paused program, someone else's month, a first
//      (call-only) month, a garbage id.
//   §7 Your Month hands RouteChoice the facts (chosen, callBooked, undoBlocked)
//      and keeps it in ONE place; the copy is plain.
//   §9 switching follows the same cutoffs: no written route after a held
//      call; no switch away from the route whose gate booked filming; the
//      blocked card can't be tapped.
//   §10 Your Month: answers owed on the call route have a step (and Home
//      links to it); "booked for today at 4:00 PM ET"; past tense once held;
//      owner bells dedupe per month per ET day.
//   §8 nothing lost, nothing sent.
//
// ISOLATION: PGlite on 127.0.0.1:5631 (the harness). Production is never
// opened; every non-loopback call is fenced; nothing is sent.
// THE CLOCK IS PINNED to Wed Oct 7 2026 10:00 ET (and moved once, for the
// time-out check).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import type { PortalViewer } from "@/lib/portal";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import type { MonthPlanning } from "@/lib/planningState";

const PORT = Number(process.env.DRILL_PORT ?? 5631);
const REPO = path.resolve(__dirname, "../..");

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
const et = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
const NOW = new RealDate(PINNED);

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
type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function walk(n: any, visit: (e: El) => void) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isEl(n)) return;
  visit(n);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit);
}
const find = (tree: any, name: string) => { const out: El[] = []; walk(tree, (e) => { if (typeName(e.type) === name) out.push(e); }); return out; };
/* eslint-enable @typescript-eslint/no-explicit-any */

const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const pm = await import("@/lib/programMonths");
  const portal = await import("@/lib/portal");
  const ym = await import("@/lib/yourMonth");
  const reminders = await import("@/lib/programReminders");
  const actions = await import("@/app/portal/actions");
  const { YourMonth } = await import("@/components/portal/YourMonth");
  const ps = await import("@/lib/planningState");
  const home = await import("@/lib/portalHome");

  const viewerOf = async (token: string | null): Promise<PortalViewer> => {
    const r = await portal.resolvePortalViewer({ token: token ?? "" });
    if (!r.ok) throw new Error(`viewer did not resolve: ${r.reason}`);
    return r.viewer;
  };
  /** A month after the program's first held call: OPTIONAL_WRITTEN, either route. */
  const eligible = async (name: string, topics = 2): Promise<ContentMonthFixture> => {
    const f = await buildContentMonth(prisma as never, { name, package: "Starter", project: false, topics: Array.from({ length: topics }, (_, i) => ({ title: `${name} topic ${i + 1}`, selection: "SELECTED" as const })) });
    const sep = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-09", videosOwed: 2, status: "OPEN" } });
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId: sep.id, status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(9, 3, 13), scheduledEnd: et(9, 3, 13, 30), transcriptState: "ANALYZED" } });
    return f;
  };
  const row = (monthId: string) => prisma.contentMonth.findUniqueOrThrow({ where: { id: monthId }, select: { planningMode: true, planningChosenAt: true, planningChosenBy: true, strategyCallStatus: true } });
  const plan = async (f: ContentMonthFixture) => (await portal.portalPlanning((await viewerOf(f.portalToken)).enrollment, f.monthId))!;
  const auth = (f: ContentMonthFixture) => ({ token: f.portalToken });
  const undoBells = (monthId: string) => prisma.notification.findMany({ where: { dedupeKey: { startsWith: `portal-planning-undo-${monthId}` } }, select: { title: true, body: true } });
  const primary = async (monthId: string) => (await reminders.previewReminders(monthId, { now: NOW })).lanes.find((l) => l.lane === "PRIMARY")?.candidate.action ?? null;
  const yourMonthTree = async (f: ContentMonthFixture) => {
    const v = await viewerOf(f.portalToken);
    const [topics, planning] = await Promise.all([portal.portalTopics(v.enrollment), portal.portalPlanning(v.enrollment, f.monthId)]);
    return YourMonth({ d: { topics, planning, planningFailed: false, schedule: null, scheduleFailed: false, slotDays: [], bookingUrl: "https://calendly.invalid", can: { suggest: true, session: true }, readOnly: false, hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts", schedule: "?tab=schedule" } } });
  };
  const counts = async () => ({ calls: await prisma.programCallRecord.count(), reqs: await prisma.programSessionRequest.count(), sels: await prisma.contentTopicSelection.count(), ivs: await prisma.contentInterview.count(), scripts: await prisma.contentScript.count(), runs: await prisma.programAiRun.count() });

  try {
    const start = await counts();

    // =======================================================================
    c.head("§1 · choose → Undo puts the month back exactly");
    // =======================================================================
    const A = await eligible("Ann Undo TEST");
    const p0 = await plan(A);
    const r0 = await row(A.monthId);
    c.ok("before: undecided, nothing chosen, nothing blocks an undo", p0.planningMode === "UNDECIDED" && p0.noCallEligible && p0.chosenAtISO === null && p0.undoBlocked === null && p0.filmingBooked === false && r0.planningMode === null, `${p0.planningMode} ${p0.chosenAtISO}`);
    c.ok("before: the reminder asks CHOOSE_PATH", (await primary(A.monthId)) === "CHOOSE_PATH");
    const ivA = await prisma.contentInterview.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, topicId: A.topicIds[0], status: "IN_PROGRESS" } });
    const chooseW = await actions.portalPlanWithoutCall(auth(A), A.monthId);
    const r1 = await row(A.monthId);
    c.ok("choosing 'Choose my topics here' saves and hands back an undo token", chooseW.ok && typeof chooseW.undo === "string" && r1.planningMode === "WRITTEN" && r1.planningChosenBy === "link" && !!r1.planningChosenAt, chooseW.message);
    c.ok("…the written route stamped the call SKIPPED (what an undo must take back)", r1.strategyCallStatus === "SKIPPED", r1.strategyCallStatus);
    c.ok("the token is opaque: no month id, enrollment id or who-chose inside it", !!chooseW.undo && !chooseW.undo.includes(A.monthId) && !chooseW.undo.includes(A.enrollmentId) && !/link|client:|WRITTEN|CALL/.test(chooseW.undo));
    const undo1 = await actions.portalPlanUndecided(auth(A), A.monthId, chooseW.undo);
    const r2 = await row(A.monthId);
    c.ok("Undo succeeds with a plain sentence", undo1.ok && /^Undone\./.test(undo1.message) && /Nothing you've done is lost/.test(undo1.message), undo1.message);
    c.ok("…planningMode, planningChosenAt and planningChosenBy are back to null (as before the tap)", r2.planningMode === null && r2.planningChosenAt === null && r2.planningChosenBy === null);
    c.ok("…and the call status is back to NOT_SCHEDULED (not left SKIPPED)", r2.strategyCallStatus === "NOT_SCHEDULED", r2.strategyCallStatus);
    const p2 = await plan(A);
    c.ok("portalPlanning reads UNDECIDED again, no choice on record", p2.planningMode === "UNDECIDED" && p2.chosenAtISO === null && p2.callStatus === "NOT_SCHEDULED", `${p2.planningMode} ${p2.callStatus}`);
    const gate2 = await portal.sessionGate(A.enrollmentId, A.monthId, { now: NOW });
    c.ok("the filming lock says 'Choose how to plan this month first' again", gate2.locked && /Choose how to plan this month first/.test(gate2.reason), gate2.reason);
    c.ok("the reminder is CHOOSE_PATH again (not the written answers lane)", (await primary(A.monthId)) === "CHOOSE_PATH");
    const stepsA = ym.yourMonthSteps({
      monthLabel: "October", planning: { callMode: p2.callMode, planningMode: p2.planningMode, callStatus: p2.callStatus, callAtISO: p2.callAtISO, noCallEligible: p2.noCallEligible, chosenAtISO: p2.chosenAtISO, deferredAtISO: p2.deferredAtISO },
      month: p2.planning!, schedule: null, can: { suggest: true, session: true }, readOnly: false, hrefs: { bank: "b", month: "m", scripts: "s", bookingUrl: "https://calendly.invalid" },
    });
    c.ok("Your Month: the route question is the one current step again", stepsA.filter((s) => s.state === "current").map((s) => s.key).join(",") === "route" && /How would you like to plan/.test(stepsA[0].title), stepsA.map((s) => `${s.key}:${s.state}`).join(" "));
    c.ok("the answers they had started are still there", (await prisma.contentInterview.findUnique({ where: { id: ivA.id } }))?.status === "IN_PROGRESS");
    const bellsA = await undoBells(A.monthId);
    c.ok("one owner bell: '… undid their choice for Oct'", bellsA.length === 1 && /Planning choice undone — Ann Undo TEST/.test(bellsA[0].title) && /undid their choice for Oct\. Not chosen yet\./.test(bellsA[0].body ?? ""), JSON.stringify(bellsA));
    const again = await actions.portalPlanUndecided(auth(A), A.monthId, chooseW.undo);
    c.ok("the same token twice is refused (single use) and writes nothing", !again.ok && /changed since then/.test(again.message) && (await row(A.monthId)).planningMode === null, again.message);
    const forged = await actions.portalPlanUndecided(auth(A), A.monthId, `${chooseW.undo!.slice(0, -4)}abcd`);
    c.ok("a tampered token is refused", !forged.ok && /didn't work/.test(forged.message), forged.message);
    // Expiry: choose, then move the clock 31 minutes on.
    const chooseW2 = await actions.portalPlanWithoutCall(auth(A), A.monthId);
    offset += 31 * 60_000;
    const late = await actions.portalPlanUndecided(auth(A), A.monthId, chooseW2.undo);
    offset -= 31 * 60_000;
    c.ok("a token older than 30 minutes is refused, pointing at 'Change how you plan this month'", !late.ok && /timed out/.test(late.message) && /Change how you plan this month/.test(late.message) && (await row(A.monthId)).planningMode === "WRITTEN", late.message);

    // =======================================================================
    c.head("§2 · switch, then Undo puts back the route you had");
    // =======================================================================
    const B = await eligible("Bo Switch TEST");
    const toCall = await actions.portalPlanWithCall(auth(B), B.monthId);
    const callRow = await row(B.monthId);
    const toWritten = await actions.portalPlanWithoutCall(auth(B), B.monthId);
    c.ok("UNDECIDED → CALL → WRITTEN, each with its own token", toCall.ok && toWritten.ok && !!toCall.undo && !!toWritten.undo && toCall.undo !== toWritten.undo && (await row(B.monthId)).planningMode === "WRITTEN");
    const backB = await actions.portalPlanUndecided(auth(B), B.monthId, toWritten.undo);
    const rB = await row(B.monthId);
    c.ok("Undo restores CALL with CALL's own stamp and chooser", backB.ok && rB.planningMode === "CALL" && rB.planningChosenAt?.getTime() === callRow.planningChosenAt?.getTime() && rB.planningChosenBy === callRow.planningChosenBy, backB.message);
    c.ok("…and the call status is NOT_SCHEDULED, so the call can be booked", rB.strategyCallStatus === "NOT_SCHEDULED" && (await plan(B)).callStatus === "NOT_SCHEDULED", rB.strategyCallStatus);
    c.ok("…the client is told they're back on the call path", /back to talking your topics through on a call/.test(backB.message), backB.message);
    // The month is now exactly as the CALL choice left it (same stamp), so
    // that choice's token steps back once more — an undo stack, never a jump.
    const stackB = await actions.portalPlanUndecided(auth(B), B.monthId, toCall.undo);
    c.ok("the CALL choice's own token now steps back once more, to no choice (the month is exactly as that choice left it)", stackB.ok && (await row(B.monthId)).planningMode === null, stackB.message);
    const reB = await actions.portalPlanWithCall(auth(B), B.monthId);
    c.ok("…and once a NEW choice is made, that old token is spent for good", reB.ok && !(await actions.portalPlanUndecided(auth(B), B.monthId, toCall.undo)).ok && (await row(B.monthId)).planningMode === "CALL");
    {
      // The defect the writer now closes: leaving the written route kept its
      // SKIPPED, because the derivation reads a stored SKIPPED first.
      const X = await eligible("Xi Skipped TEST");
      await pm.setPlanningMode(X.monthId, "WRITTEN", "drill");
      await prisma.contentMonth.update({ where: { id: X.monthId }, data: { planningMode: "CALL" } }); // the OLD writer: mode only
      const oldWay = await pm.recalcProgramMonth(X.monthId);
      const oldReminder = await primary(X.monthId);
      c.ok("OLD: a month switched off the written route still read SKIPPED ('No strategy call this month')", oldWay?.after.strategyCallStatus === "SKIPPED" && (await row(X.monthId)).strategyCallStatus === "SKIPPED");
      c.ok("OLD: …so its planning reminder went silent ('no call chosen')", oldReminder === null, String(oldReminder));
      await prisma.contentMonth.update({ where: { id: X.monthId }, data: { planningMode: "WRITTEN" } });
      const sw = await actions.portalPlanWithCall(auth(X), X.monthId);
      c.ok("NEW: the same switch through the portal reads NOT_SCHEDULED — book your call", sw.ok && (await row(X.monthId)).strategyCallStatus === "NOT_SCHEDULED" && (await plan(X)).callStatus === "NOT_SCHEDULED");
      c.ok("…and the planning reminder runs again (CHOOSE_PATH: book the call, or choose topics here)", (await primary(X.monthId)) === "CHOOSE_PATH", String(await primary(X.monthId)));
    }

    // =======================================================================
    c.head("§3 · 'Undo my choice' later (no token)");
    // =======================================================================
    const later = await actions.portalPlanUndecided(auth(B), B.monthId);
    const rB2 = await row(B.monthId);
    c.ok("from CALL: back to no choice, the two cards", later.ok && rB2.planningMode === null && rB2.planningChosenAt === null && (await plan(B)).planningMode === "UNDECIDED", later.message);
    const nothing = await actions.portalPlanUndecided(auth(B), B.monthId);
    c.ok("undoing again when nothing is chosen is a calm no-op", nothing.ok && /no choice to undo/.test(nothing.message), nothing.message);
    await actions.portalPlanWithoutCall(auth(B), B.monthId);
    const later2 = await actions.portalPlanUndecided(auth(B), B.monthId);
    c.ok("from WRITTEN: back to no choice, SKIPPED taken back", later2.ok && (await row(B.monthId)).planningMode === null && (await row(B.monthId)).strategyCallStatus === "NOT_SCHEDULED");
    const bellsB = await undoBells(B.monthId);
    c.ok("three undos on one month the same day = ONE owner bell (the dedupe key holds)", bellsB.length === 1, String(bellsB.length));
    await actions.portalPlanWithoutCall(auth(B), B.monthId);
    offset += 86_400_000;
    await actions.portalPlanUndecided(auth(B), B.monthId);
    offset -= 86_400_000;
    const bellsB2 = await undoBells(B.monthId);
    c.ok("…the next ET day an undo rings again, so the owner sees the latest state", bellsB2.length === 2, String(bellsB2.length));

    // =======================================================================
    c.head("§4 · a booked strategy call is never cancelled");
    // =======================================================================
    const C = await eligible("Cy Booked TEST");
    const callC = await prisma.programCallRecord.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, callType: "MONTHLY_STRATEGY", monthId: C.monthId, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 9, 13), scheduledEnd: et(10, 9, 13, 30) } });
    const pC0 = await plan(C);
    c.ok("before: the booked call puts the month on the call route with no choice on record", pC0.planningMode === "CALL" && pC0.callStatus === "SCHEDULED" && pC0.chosenAtISO === null);
    const wC = await actions.portalPlanWithoutCall(auth(C), C.monthId);
    c.ok("choosing topics here says the call stays booked", wC.ok && /booked call is still on the calendar/.test(wC.message));
    const uC = await actions.portalPlanUndecided(auth(C), C.monthId, wC.undo);
    const rC = await row(C.monthId);
    const callAfter = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: callC.id } });
    c.ok("Undo: back exactly (no choice), the call record untouched and still SCHEDULED", uC.ok && rC.planningMode === null && rC.planningChosenAt === null && callAfter.status === "SCHEDULED" && callAfter.scheduledStart?.getTime() === callC.scheduledStart?.getTime());
    c.ok("…and the client is told the call is still booked", /strategy call is still booked/.test(uC.message), uC.message);
    c.ok("…the month reads as planned on that call", (await plan(C)).planningMode === "CALL" && (await plan(C)).callStatus === "SCHEDULED");
    // Filming booked while on the call route: an undo that leaves the route
    // where it is (a booked call) changes nothing about the booking.
    await actions.portalPlanWithCall(auth(C), C.monthId);
    await prisma.programSessionRequest.create({ data: { enrollmentId: C.enrollmentId, clientId: C.clientId, monthId: C.monthId, slotStart: et(10, 16, 10), slotEnd: et(10, 16, 12), status: "REQUESTED" } });
    const pC1 = await plan(C);
    c.ok("call route + filming booked + call booked: nothing blocks the undo (the route would not move)", pC1.filmingBooked && pC1.undoBlocked === null, String(pC1.undoBlocked));
    const uC2 = await actions.portalPlanUndecided(auth(C), C.monthId);
    c.ok("…and it succeeds; the month is still on the call", uC2.ok && (await plan(C)).planningMode === "CALL", uC2.message);

    // =======================================================================
    c.head("§5 · when a choice can no longer be undone");
    // =======================================================================
    // (a) the call was held
    const D = await eligible("Di Held TEST");
    await prisma.programCallRecord.create({ data: { enrollmentId: D.enrollmentId, clientId: D.clientId, callType: "MONTHLY_STRATEGY", monthId: D.monthId, status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(10, 5, 13), scheduledEnd: et(10, 5, 13, 30), transcriptState: "ANALYZED" } });
    await pm.setPlanningMode(D.monthId, "CALL", "link");
    const pD = await plan(D);
    const uD = await actions.portalPlanUndecided(auth(D), D.monthId);
    c.ok("call held: refused in plain words, nothing written", !uD.ok && /already happened/.test(uD.message) && pD.undoBlocked === uD.message && (await row(D.monthId)).planningMode === "CALL", uD.message);
    // (b) a script exists for one of the month's topics
    const E = await eligible("Ed Scripts TEST");
    await actions.portalPlanWithoutCall(auth(E), E.monthId);
    await prisma.contentScript.create({ data: { enrollmentId: E.enrollmentId, clientId: E.clientId, monthId: E.monthId, topicId: E.topicIds[0], title: "Draft", body: "b", status: "DRAFT" } });
    const pE = await plan(E);
    const uE = await actions.portalPlanUndecided(auth(E), E.monthId);
    c.ok("scripts started: refused, nothing written", !uE.ok && /started writing your scripts/.test(uE.message) && pE.undoBlocked === uE.message && (await row(E.monthId)).planningMode === "WRITTEN", uE.message);
    // (c) filming booked off the written path — with and without a token
    const F = await eligible("Flo Filming TEST");
    const wF = await actions.portalPlanWithoutCall(auth(F), F.monthId);
    await prisma.programSessionRequest.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, slotStart: et(10, 20, 10), slotEnd: et(10, 20, 12), status: "CONFIRMED" } });
    const pF = await plan(F);
    const uF = await actions.portalPlanUndecided(auth(F), F.monthId);
    const uFt = await actions.portalPlanUndecided(auth(F), F.monthId, wF.undo);
    c.ok("filming booked on the written route: 'Undo my choice' refused, with Kyle's number", !uF.ok && /filming is already booked/.test(uF.message) && /Kyle/.test(uF.message) && pF.undoBlocked === uF.message, uF.message);
    c.ok("…and the Undo token is refused the same way (it would send the month back to no choice)", !uFt.ok && uFt.message === uF.message && (await row(F.monthId)).planningMode === "WRITTEN");
    c.ok("…the booking is untouched", (await prisma.programSessionRequest.count({ where: { monthId: F.monthId, status: "CONFIRMED" } })) === 1);
    c.ok("refusals ring no bell", (await undoBells(D.monthId)).length === 0 && (await undoBells(E.monthId)).length === 0 && (await undoBells(F.monthId)).length === 0);
    // A switch's Undo back to a ROUTE (not to no choice) is a switch, and
    // reads the switch rule: here the switch itself is already refused.
    const G = await eligible("Gil Back TEST");
    await actions.portalPlanWithoutCall(auth(G), G.monthId);
    await prisma.programSessionRequest.create({ data: { enrollmentId: G.enrollmentId, clientId: G.clientId, monthId: G.monthId, slotStart: et(10, 21, 10), slotEnd: et(10, 21, 12), status: "REQUESTED" } });
    const cG = await actions.portalPlanWithCall(auth(G), G.monthId);
    c.ok("filming booked on the written route: switching to the call is refused (Oct 6 follow-up), nothing written", !cG.ok && /filming is already booked/.test(cG.message) && /Kyle/.test(cG.message) && (await row(G.monthId)).planningMode === "WRITTEN", cG.message);

    // =======================================================================
    c.head("§6 · who may undo");
    // =======================================================================
    const H = await eligible("Hal Auth TEST");
    const wH = await actions.portalPlanWithoutCall(auth(H), H.monthId);
    const dead = await actions.portalPlanUndecided({ token: "not-a-real-link-token-000000" }, H.monthId, wH.undo);
    c.ok("a dead link is refused", !dead.ok && /no longer active/.test(dead.message), dead.message);
    const other = await actions.portalPlanUndecided(auth(A), H.monthId, wH.undo);
    c.ok("another client's link cannot undo this month", !other.ok && /open program months/.test(other.message), other.message);
    const crossed = await actions.portalPlanUndecided(auth(A), A.monthId, wH.undo);
    c.ok("a token from another client's month does not open on this one", !crossed.ok && /didn't work/.test(crossed.message), crossed.message);
    const garbage = await actions.portalPlanUndecided(auth(H), "../../etc", wH.undo);
    c.ok("a garbage month id is refused", !garbage.ok, garbage.message);
    c.ok("…H is still WRITTEN after all of that", (await row(H.monthId)).planningMode === "WRITTEN");
    const P = await buildContentMonth(prisma as never, { name: "Pat Paused TEST", package: "Starter", project: false, enrollmentStatus: "PAUSED", topics: [{ title: "Paused topic", selection: "SELECTED" }] });
    const paused = await actions.portalPlanUndecided(auth(P), P.monthId);
    c.ok("a paused program is refused (the same door as booking)", !paused.ok, paused.message);
    const Q = await buildContentMonth(prisma as never, { name: "Quin First TEST", package: "Starter", project: false, topics: [{ title: "First topic", selection: "SELECTED" }] });
    await pm.setPlanningMode(Q.monthId, "CALL", "staff:x");
    const first = await actions.portalPlanUndecided(auth(Q), Q.monthId);
    c.ok("a first (call-only) month has no choice to undo, and keeps its stamp", !first.ok && /plans each month on a strategy call/.test(first.message) && (await row(Q.monthId)).planningChosenBy === "staff:x", first.message);

    // =======================================================================
    c.head("§7 · Your Month and the copy");
    // =======================================================================
    const I = await eligible("Ivy Screen TEST");
    const tree0 = await yourMonthTree(I);
    const rc0 = find(tree0, "RouteChoice");
    c.ok("undecided: one RouteChoice, open, nothing to undo", rc0.length === 1 && rc0[0].props.current === "UNDECIDED" && rc0[0].props.chosen === false && find(tree0, "details").every((d) => !/Change how you plan/.test(JSON.stringify(d.props.children ?? ""))));
    await actions.portalPlanWithoutCall(auth(I), I.monthId);
    const rc1 = find(await yourMonthTree(I), "RouteChoice");
    c.ok("chosen: the SAME one RouteChoice (it stays mounted), told there is a choice and nothing blocks undoing it", rc1.length === 1 && rc1[0].props.current === "WRITTEN" && rc1[0].props.chosen === true && rc1[0].props.undoBlocked === null && rc1[0].props.callBooked === false);
    const rcE = find(await yourMonthTree(E), "RouteChoice");
    c.ok("scripts started: RouteChoice carries the reason instead of an Undo", rcE.length === 1 && rcE[0].props.undoBlocked === pE.undoBlocked);
    const rcC = find(await yourMonthTree(C), "RouteChoice");
    c.ok("booked call: RouteChoice knows (its copy says the call stays booked)", rcC.length === 1 && rcC[0].props.callBooked === true);
    const ui = code(read("src/components/portal/PlanningChoice.tsx"));
    c.ok("the client component offers 'Undo' after a tap and 'Undo my choice' in the fold", />\s*Undo<\/Button>/.test(ui) && /Undo my choice/.test(ui) && /Change how you plan this month/.test(ui) && /portalPlanUndecided/.test(ui));
    c.ok("…the undo is optimistic: the cards move before the server answers", /setShown\(prev\);\s*setMsg\(\{ ok: true, text: "Undone\." \}\)/.test(ui));
    c.ok("…and says a booked call stays booked", /Your booked call stays booked/.test(ui));
    const ymSrc = code(read("src/components/portal/YourMonth.tsx"));
    c.ok("Your Month renders RouteChoice in exactly one place", (ymSrc.match(/<RouteChoice\b/g) ?? []).length === 1);
    const msgs = [undo1.message, backB.message, uC.message, uD.message, uE.message, uF.message, late.message];
    c.ok("plain words: no internal terms in any client sentence", msgs.every((m) => !/planningMode|UNDECIDED|WRITTEN|SKIPPED|token|enrollment|route/i.test(m)), msgs.find((m) => /planningMode|UNDECIDED|WRITTEN|SKIPPED|token|enrollment|route/i.test(m)) ?? "");

    // =======================================================================
    c.head("§9 · switching follows the same cutoffs (strategy-call desk review)");
    // =======================================================================
    const pD2 = await plan(D);
    const wD = await actions.portalPlanWithoutCall(auth(D), D.monthId);
    c.ok("call held: 'Choose my topics here' is refused, nothing written", !wD.ok && /already happened/.test(wD.message) && (await row(D.monthId)).planningMode === "CALL", wD.message);
    c.ok("…the portal knows before the tap (switchBlocked.WRITTEN), the call route stays open", pD2.switchBlocked.WRITTEN === wD.message && pD2.switchBlocked.CALL === null);
    const rcD = find(await yourMonthTree(D), "RouteChoice");
    c.ok("…and RouteChoice is handed the reason, so the card can't be tapped", rcD.length === 1 && rcD[0].props.blocked?.WRITTEN === wD.message);
    const pF2 = await plan(F);
    const cF = await actions.portalPlanWithCall(auth(F), F.monthId);
    c.ok("filming booked on the written route: switching to the call is refused with Kyle's number", !cF.ok && /Kyle/.test(cF.message) && pF2.switchBlocked.CALL === cF.message && pF2.switchBlocked.WRITTEN === null && (await row(F.monthId)).planningMode === "WRITTEN", cF.message);
    const wC2 = await actions.portalPlanWithoutCall(auth(C), C.monthId);
    c.ok("filming booked on the call route (call booked): switching to the written route is refused", !wC2.ok && /filming is already booked/.test(wC2.message) && (await plan(C)).planningMode === "CALL", wC2.message);
    const U = await eligible("Uma Undecided TEST");
    await prisma.programSessionRequest.create({ data: { enrollmentId: U.enrollmentId, clientId: U.clientId, monthId: U.monthId, slotStart: et(10, 22, 10), slotEnd: et(10, 22, 12), status: "REQUESTED" } });
    const cU = await actions.portalPlanWithCall(auth(U), U.monthId);
    const wU = await actions.portalPlanWithoutCall(auth(U), U.monthId);
    c.ok("undecided with filming booked (opened on the answers): the call is refused, the written route is fine", !cU.ok && wU.ok && (await row(U.monthId)).planningMode === "WRITTEN", `${cU.message} | ${wU.message}`);
    const freeB = await plan(B);
    c.ok("nothing booked, no call held: both routes open", freeB.switchBlocked.CALL === null && freeB.switchBlocked.WRITTEN === null);
    const ui2 = code(read("src/components/portal/PlanningChoice.tsx"));
    c.ok("a blocked card is disabled (not tap-and-fail) and its reason is shown", /disabled=\{isChosen \|\| off\}/.test(ui2) && /route-blocked-/.test(ui2));

    // =======================================================================
    c.head("§10 · Your Month words: answers on the call route, call time, tense");
    // =======================================================================
    const mp = (over: Partial<MonthPlanning>): MonthPlanning => ({ route: "CALL", call: "BOOKED", videosOwed: 2, chosen: 2, extras: 0, counts: { ...ps.emptyCounts(), NEEDS_MORE: 1 }, answersOwed: 1, missingAnswers: 2, approved: 0, topics: [], headline: { key: "NEEDS_MORE", text: "We need a little more" }, progress: null, ...over });
    const stepsOf = (month: MonthPlanning, callAtISO: string | null, extra: { tz?: string } = {}) => ym.yourMonthSteps({
      monthLabel: "October", planning: { callMode: "OPTIONAL_WRITTEN", planningMode: "CALL", callStatus: month.call === "HELD" ? "COMPLETED" : "SCHEDULED", callAtISO, noCallEligible: true, chosenAtISO: NOW.toISOString(), deferredAtISO: null },
      month, schedule: null, can: { suggest: true, session: true }, readOnly: false, hrefs: { bank: "b", month: "m", scripts: "s", bookingUrl: "https://calendly.invalid" }, timezone: extra.tz, now: NOW,
    });
    const owedBooked = stepsOf(mp({}), et(10, 7, 16).toISOString());
    const callStep = owedBooked.find((s) => s.key === "call");
    c.ok("call route, call booked, answers owed: the call step asks for them and is the current step", callStep?.state === "current" && /We need a little more on 1 topic/.test(callStep.title) && !!callStep.cta && /booked for today at 4:00 PM ET/.test(callStep.detail ?? ""), `${callStep?.state} ${callStep?.title} / ${callStep?.detail}`);
    const plainBooked = stepsOf(mp({ answersOwed: 0, counts: ps.emptyCounts(), missingAnswers: 0 }), et(10, 8, 9, 30).toISOString()).find((s) => s.key === "call");
    c.ok("nothing owed: 'Your call is booked for tomorrow at 9:30 AM ET'", plainBooked?.title === "Your call is booked for tomorrow at 9:30 AM ET", plainBooked?.title);
    c.ok("a later day reads as the weekday and date", ym.callWhenWords(et(10, 9, 16).toISOString(), "America/New_York", NOW) === "Friday, October 9 at 4:00 PM ET", ym.callWhenWords(et(10, 9, 16).toISOString(), "America/New_York", NOW));
    c.ok("'today' is the client's day, in their zone (11:30 PM ET is still today in Chicago at 10:30 PM)", ym.callWhenWords(et(10, 7, 23, 30).toISOString(), "America/Chicago", NOW) === "today at 10:30 PM CDT", ym.callWhenWords(et(10, 7, 23, 30).toISOString(), "America/Chicago", NOW));
    const heldSteps = stepsOf(mp({ call: "HELD", answersOwed: 0, counts: ps.emptyCounts(), missingAnswers: 0 }), et(10, 5, 13).toISOString());
    c.ok("after the call is held the route reads in the past tense, with no 'switch any time'", heldSteps[0].title === "You planned this month on your strategy call" && heldSteps[0].detail === null, `${heldSteps[0].title} / ${heldSteps[0].detail}`);
    const notHeld = stepsOf(mp({ answersOwed: 0, counts: ps.emptyCounts(), missingAnswers: 0 }), et(10, 9, 16).toISOString());
    c.ok("…while before it, the present tense and the switch note stay", notHeld[0].title === "You're talking your topics through on a call" && /switch any time/.test(notHeld[0].detail ?? ""));
    const homeIn = (planningMode: string) => home.homeActions({
      status: "ACTIVE", readOnly: false, perms: { session: true, suggest: true, request: true, approve: true, profile: true },
      review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: [], unread: 0,
      planning: { planningMode, callStatus: "SCHEDULED", noCallEligible: true }, month: { monthKey: "2026-10", label: "October", owed: 2, selected: 2 },
      toAnswer: [{ title: "Pricing myths", missing: 2 }], session: { offerBooking: false, required: 1, missing: 1 }, addressNeeded: 0, setup: null, ready: { count: 0, withFile: false, single: null },
    });
    const ansCall = [homeIn("CALL").primary, ...homeIn("CALL").more].find((a) => a?.kind === "ANSWER_QUESTIONS");
    const ansWritten = [homeIn("WRITTEN").primary, ...homeIn("WRITTEN").more].find((a) => a?.kind === "ANSWER_QUESTIONS");
    c.ok("Home's 'answer the questions' lands on #step-call on the call route (#step-answers does not exist there)", !!ansCall && /#step-call$/.test(ansCall.href), ansCall ? ansCall.href : "none");
    c.ok("…and on #step-answers on the written route", !!ansWritten && /#step-answers$/.test(ansWritten.href), ansWritten?.href);

    // =======================================================================
    c.head("§8 · nothing lost, nothing sent");
    // =======================================================================
    const end = await counts();
    c.ok("no call record or session request was cancelled or removed (only the drill's own were added)", end.calls === start.calls + 13 && (await prisma.programCallRecord.count({ where: { status: { in: ["CANCELLED", "CANCELED"] } } })) === 0, JSON.stringify({ start, end }));
    c.ok("no session request was cancelled", (await prisma.programSessionRequest.count({ where: { status: { in: ["CANCELLED", "CANCEL_REQUESTED"] } } })) === 0);
    c.ok("no AI run was started by a choice or an undo", end.runs === start.runs);
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
